-- =====================================================================
-- Migration 004 — Customer & Contract Management
--
-- Implements: customer profiles (company + sites + contacts + billing),
-- and lease contracts that link a customer to one or more printers with
-- a duration, monthly lease fee, per-click rates, and an SLA tier.
--
-- Business rules enforced here / by the API:
--   BR-007  A contract cannot be ACTIVATED without a signed contract
--           document attached.
--   BR-008  A contract's end date must be at least 1 month after its
--           start date.
--   BR-009  Monthly lease fee must be > 0; per-click rates must be >= 0.
--   BR-010  A contract may not be deleted once it has been activated —
--           it must be TERMINATED instead (preserving history).
--   Status  DRAFT → ACTIVE → EXPIRED | TERMINATED.
-- =====================================================================

-- ---------------------------------------------------------------------
-- New permissions for this module.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('customers.read',    'View customers, sites and contacts'),
  ('customers.create',  'Create customer profiles'),
  ('customers.update',  'Edit customer profiles, sites and contacts'),
  ('contracts.read',    'View lease contracts'),
  ('contracts.create',  'Create draft lease contracts'),
  ('contracts.update',  'Edit draft contracts and attach documents'),
  ('contracts.activate','Activate a contract (BR-007)'),
  ('contracts.terminate','Terminate an active contract (BR-010)')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SALES_MANAGER: full customer + contract lifecycle.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_MANAGER'
  AND p.code IN (
    'customers.read', 'customers.create', 'customers.update',
    'contracts.read', 'contracts.create', 'contracts.update',
    'contracts.activate', 'contracts.terminate'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_REP: manage customers and draft contracts; cannot activate or terminate.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_REP'
  AND p.code IN (
    'customers.read', 'customers.create', 'customers.update',
    'contracts.read', 'contracts.create', 'contracts.update'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CEO: read-only visibility into customers and contracts.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CEO'
  AND p.code IN ('customers.read', 'contracts.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SYSTEM_ADMIN: full access for operational needs.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN (
    'customers.read', 'customers.create', 'customers.update',
    'contracts.read', 'contracts.create', 'contracts.update',
    'contracts.activate', 'contracts.terminate'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- customers — extend the bootstrap table (001) into a full company
-- profile. Existing columns: id, name, email, phone, created_at,
-- updated_at. Lead conversion (003) inserts name/email/phone; the new
-- columns are all nullable so that path keeps working unchanged.
--
-- ADD COLUMN IF NOT EXISTS is not available on older MySQL, so each
-- column is added defensively via a stored routine to keep the migration
-- idempotent.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_add_customer_columns;
DELIMITER //
CREATE PROCEDURE websol_add_customer_columns()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'customers'
                   AND column_name = 'registration_no') THEN
    ALTER TABLE customers
      ADD COLUMN registration_no VARCHAR(100) NULL AFTER name,
      ADD COLUMN vat_no          VARCHAR(100) NULL AFTER registration_no,
      ADD COLUMN industry        VARCHAR(100) NULL AFTER vat_no,
      ADD COLUMN website         VARCHAR(200) NULL AFTER industry,
      ADD COLUMN billing_address TEXT         NULL AFTER website,
      ADD COLUMN billing_email   VARCHAR(200) NULL AFTER billing_address,
      ADD COLUMN billing_phone   VARCHAR(50)  NULL AFTER billing_email,
      ADD COLUMN status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE' AFTER billing_phone,
      ADD COLUMN notes           TEXT            NULL AFTER status,
      -- created_by references users.id, which is BIGINT UNSIGNED.
      ADD COLUMN created_by      BIGINT UNSIGNED NULL AFTER notes;
  END IF;
END //
DELIMITER ;
CALL websol_add_customer_columns();
DROP PROCEDURE IF EXISTS websol_add_customer_columns;

-- ---------------------------------------------------------------------
-- customer_sites — physical sites / locations where printers are placed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_sites (
  id            INT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(200)   NOT NULL,
  address       TEXT           NULL,
  city          VARCHAR(120)   NULL,
  postal_code   VARCHAR(20)    NULL,
  contact_name  VARCHAR(150)   NULL,
  contact_phone VARCHAR(50)    NULL,
  is_primary    TINYINT(1)     NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_csite_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- customer_contacts — people at the customer (decision makers, billing).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_contacts (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(150)    NOT NULL,
  title       VARCHAR(120)    NULL,
  email       VARCHAR(200)    NULL,
  phone       VARCHAR(50)     NULL,
  is_primary  TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ccontact_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- contracts — lease contract linking a customer to printers.
--
-- Pricing columns deliberately use DECIMAL (never FLOAT) so money and
-- per-click rates are exact (BR-009 is enforced by the API and by CHECK
-- constraints below).
--
-- These three tables are dropped first (child → parent order) so the
-- migration is safely re-runnable even if a previous attempt failed
-- partway through creating them. They are new in this migration and hold
-- no data, so dropping is non-destructive. (customer_sites / customer_contacts
-- above are left intact via CREATE TABLE IF NOT EXISTS.)
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS contract_documents;
DROP TABLE IF EXISTS contract_printers;
DROP TABLE IF EXISTS contracts;

-- All user-referencing columns MUST match users.id exactly: BIGINT UNSIGNED.
CREATE TABLE IF NOT EXISTS contracts (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id        BIGINT UNSIGNED NOT NULL,
  contract_no        VARCHAR(40)     NOT NULL,
  start_date         DATE            NOT NULL,
  end_date           DATE            NOT NULL,
  monthly_lease_fee  DECIMAL(10,2)   NOT NULL,
  per_click_bw       DECIMAL(8,5)    NOT NULL,
  per_click_colour   DECIMAL(8,5)    NOT NULL,
  sla_tier           ENUM('PLATINUM','GOLD','SILVER','BRONZE') NOT NULL DEFAULT 'BRONZE',
  status             ENUM('DRAFT','ACTIVE','EXPIRED','TERMINATED') NOT NULL DEFAULT 'DRAFT',
  notes              TEXT            NULL,
  activated_at       DATETIME        NULL,
  activated_by       BIGINT UNSIGNED NULL,
  terminated_at      DATETIME        NULL,
  terminated_by      BIGINT UNSIGNED NULL,
  termination_reason VARCHAR(500)    NULL,
  created_by         BIGINT UNSIGNED NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contract_no (contract_no),
  -- BR-009 — pricing guards at the storage layer (defence in depth).
  CONSTRAINT chk_contract_fee    CHECK (monthly_lease_fee > 0),
  CONSTRAINT chk_contract_bw     CHECK (per_click_bw >= 0),
  CONSTRAINT chk_contract_colour CHECK (per_click_colour >= 0),
  -- BR-008 — end date strictly after start (the 1-month minimum is
  -- enforced by the API; CHECK keeps the basic ordering invariant).
  CONSTRAINT chk_contract_dates  CHECK (end_date > start_date),
  CONSTRAINT fk_contract_customer  FOREIGN KEY (customer_id)   REFERENCES customers (id),
  CONSTRAINT fk_contract_activator FOREIGN KEY (activated_by)  REFERENCES users (id),
  CONSTRAINT fk_contract_terminator FOREIGN KEY (terminated_by) REFERENCES users (id),
  CONSTRAINT fk_contract_creator   FOREIGN KEY (created_by)    REFERENCES users (id),
  KEY idx_contract_status_end (status, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- contract_printers — the one-or-more printers covered by a contract.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_printers (
  id            INT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id   BIGINT UNSIGNED NOT NULL,
  printer_model VARCHAR(200)   NOT NULL,
  serial_no     VARCHAR(120)   NULL,
  site_id       INT UNSIGNED   NULL,
  quantity      INT UNSIGNED   NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cprinter_contract FOREIGN KEY (contract_id)
    REFERENCES contracts (id) ON DELETE CASCADE,
  CONSTRAINT fk_cprinter_site FOREIGN KEY (site_id)
    REFERENCES customer_sites (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- contract_documents — signed contract documents attached to a contract.
-- BR-007: a contract needs at least one document here before it can be
-- activated. The latest upload is treated as the signed copy.
-- Content is stored base64-encoded so the system is self-contained; a
-- production deployment would swap `content` for a blob-store URL.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_documents (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT UNSIGNED NOT NULL,
  file_name   VARCHAR(255)    NOT NULL,
  mime_type   VARCHAR(150)    NOT NULL,
  file_size   INT UNSIGNED    NOT NULL DEFAULT 0,
  content     LONGTEXT        NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cdoc_contract FOREIGN KEY (contract_id)
    REFERENCES contracts (id) ON DELETE CASCADE,
  CONSTRAINT fk_cdoc_uploader FOREIGN KEY (uploaded_by) REFERENCES users (id),
  KEY idx_cdoc_contract (contract_id, uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('004_customers_contracts')
ON DUPLICATE KEY UPDATE version = version;

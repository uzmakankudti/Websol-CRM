-- =====================================================================
-- Migration 005 — Asset / Printer Management
--
-- Implements: physical printer lifecycle tracking for MPS contracts.
-- Each printer record captures spec, location, warranty, and which
-- contract/site it currently serves.
--
-- Business rules enforced here / by the API:
--   BR-A01  Serial number is globally unique across all printers.
--   BR-A02  A RETIRED printer is immutable — no edits or status changes.
--   BR-A03  A printer may only be linked to one active contract at a time
--           (enforced by the single current_contract_id column + API guard).
--
-- Lifecycle:
--   ORDERED → IN_TRANSIT → RECEIVED → QC_PASS | QC_FAIL
--   QC_PASS → IN_STOCK → ALLOCATED → DISPATCHED → INSTALLED
--   INSTALLED → UNDER_REPAIR | REPLACEMENT_OUT
--   UNDER_REPAIR / REPLACEMENT_OUT → RETURNED → REFURBISHED → IN_STOCK
--   Any non-RETIRED state → RETIRED  (terminal)
-- =====================================================================

-- ---------------------------------------------------------------------
-- New permissions for this module.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('printers.read',          'View printer records and status history'),
  ('printers.create',        'Register a new printer asset'),
  ('printers.update',        'Edit printer details (blocked for RETIRED)'),
  ('printers.manage_status', 'Transition printer lifecycle status')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SYSTEM_ADMIN: full asset management.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN (
    'printers.read', 'printers.create',
    'printers.update', 'printers.manage_status'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_MANAGER: read-only (needs stock visibility for quoting).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_MANAGER'
  AND p.code IN ('printers.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_REP: read-only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_REP'
  AND p.code IN ('printers.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CEO: read-only visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CEO'
  AND p.code IN ('printers.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- printers — master asset record for each physical printer unit.
--
-- All FK columns to users.id are BIGINT UNSIGNED (matching users.id).
-- current_contract_id / current_site_id are nullable; cleared when the
-- printer leaves an installed state.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS printers (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  serial_no           VARCHAR(120)    NOT NULL,
  asset_no            VARCHAR(80)     NULL,
  brand               VARCHAR(100)    NOT NULL,
  model               VARCHAR(200)    NOT NULL,
  print_technology    ENUM('LASER','INKJET','LED','THERMAL','DOT_MATRIX','OTHER')
                                      NOT NULL DEFAULT 'LASER',
  is_colour           TINYINT(1)      NOT NULL DEFAULT 0,
  ppm_bw              SMALLINT UNSIGNED NULL,
  ppm_colour          SMALLINT UNSIGNED NULL,
  lifetime_pages      INT UNSIGNED    NOT NULL DEFAULT 0,
  location            VARCHAR(300)    NULL,
  warranty_expiry     DATE            NULL,
  -- BR-A03: single nullable pointer — a printer belongs to at most one contract.
  current_contract_id BIGINT UNSIGNED NULL,
  current_site_id     INT UNSIGNED    NULL,
  status              ENUM(
                        'ORDERED','IN_TRANSIT','RECEIVED',
                        'QC_PASS','QC_FAIL',
                        'IN_STOCK','ALLOCATED','DISPATCHED','INSTALLED',
                        'UNDER_REPAIR','REPLACEMENT_OUT',
                        'RETURNED','REFURBISHED','RETIRED'
                      )               NOT NULL DEFAULT 'ORDERED',
  notes               TEXT            NULL,
  created_by          BIGINT UNSIGNED NOT NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- BR-A01: globally unique serial.
  UNIQUE KEY uq_printer_serial (serial_no),
  KEY idx_printer_status (status),
  KEY idx_printer_contract (current_contract_id),
  CONSTRAINT fk_printer_contract FOREIGN KEY (current_contract_id)
    REFERENCES contracts (id) ON DELETE SET NULL,
  CONSTRAINT fk_printer_site    FOREIGN KEY (current_site_id)
    REFERENCES customer_sites (id) ON DELETE SET NULL,
  CONSTRAINT fk_printer_creator FOREIGN KEY (created_by)
    REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- printer_status_history — immutable log of every lifecycle transition.
-- The API writes one row here on every status change (user, time, reason).
-- from_status is NULL for the initial "registered" entry.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS printer_status_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  printer_id  BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(30)     NULL,
  to_status   VARCHAR(30)     NOT NULL,
  reason      VARCHAR(500)    NULL,
  changed_by  BIGINT UNSIGNED NOT NULL,
  changed_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_psh_printer    FOREIGN KEY (printer_id) REFERENCES printers (id) ON DELETE CASCADE,
  CONSTRAINT fk_psh_changed_by FOREIGN KEY (changed_by) REFERENCES users (id),
  KEY idx_psh_printer_time (printer_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('005_assets')
ON DUPLICATE KEY UPDATE version = version;

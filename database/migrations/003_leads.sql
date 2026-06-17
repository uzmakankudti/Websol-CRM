-- =====================================================================
-- Migration 003 — Lead & Opportunity Management
--
-- Implements: leads pipeline, lease quotations, quotation approval,
-- and lead-to-customer conversion.
--
-- Business rules enforced here / by the API:
--   BR-024  A lead cannot be converted to a customer without at least
--           one APPROVED quotation on that lead.
--   Stages  NEW → CONTACTED → PROPOSAL_SENT → WON | LOST
--           WON and LOST are terminal (no further transitions).
--   Approval Quotations with discount_pct > 0 require Sales Manager
--           approval before they may be used for BR-024.
-- =====================================================================

-- ---------------------------------------------------------------------
-- New permissions for this module.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('leads.read',         'View leads and the sales pipeline'),
  ('leads.create',       'Create new leads'),
  ('leads.update',       'Edit lead details'),
  ('leads.change_stage', 'Move a lead through pipeline stages'),
  ('leads.convert',      'Convert a won lead into a customer (BR-024)'),
  ('quotations.create',  'Create lease quotations'),
  ('quotations.approve', 'Approve or reject quotations that include a discount')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SALES_MANAGER: full pipeline access including approval and conversion.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_MANAGER'
  AND p.code IN (
    'leads.read', 'leads.create', 'leads.update',
    'leads.change_stage', 'leads.convert',
    'quotations.create', 'quotations.approve'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_REP: create and progress leads, create quotations; cannot approve or convert.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_REP'
  AND p.code IN (
    'leads.read', 'leads.create', 'leads.update',
    'leads.change_stage', 'quotations.create'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CEO: read-only visibility into the pipeline.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CEO'
  AND p.code IN ('leads.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SYSTEM_ADMIN: full access for operational needs.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN (
    'leads.read', 'leads.create', 'leads.update',
    'leads.change_stage', 'leads.convert',
    'quotations.create', 'quotations.approve'
  )
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- leads — core lead / opportunity record.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_name          VARCHAR(200) NOT NULL,
  contact_name          VARCHAR(150) NOT NULL,
  contact_email         VARCHAR(200) NULL,
  contact_phone         VARCHAR(50)  NULL,
  source                ENUM('REFERRAL','WEBSITE','COLD_CALL','EXHIBITION','OTHER')
                          NOT NULL DEFAULT 'OTHER',
  expected_printers     INT UNSIGNED NOT NULL DEFAULT 1,
  stage                 ENUM('NEW','CONTACTED','PROPOSAL_SENT','WON','LOST')
                          NOT NULL DEFAULT 'NEW',
  stage_note            TEXT NULL,
  assigned_to           INT UNSIGNED NULL,
  lost_reason           VARCHAR(500) NULL,
  converted_customer_id BIGINT UNSIGNED NULL,
  converted_at          DATETIME NULL,
  converted_by          INT UNSIGNED NULL,
  created_by            INT UNSIGNED NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_leads_assigned   FOREIGN KEY (assigned_to)           REFERENCES users     (id),
  CONSTRAINT fk_leads_creator    FOREIGN KEY (created_by)            REFERENCES users     (id),
  CONSTRAINT fk_leads_converter  FOREIGN KEY (converted_by)          REFERENCES users     (id),
  CONSTRAINT fk_leads_customer   FOREIGN KEY (converted_customer_id) REFERENCES customers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- lead_quotations — lease quotation attached to a lead.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_quotations (
  id                INT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id           INT UNSIGNED   NOT NULL,
  monthly_lease_fee DECIMAL(10,2)  NOT NULL,
  per_page_bw       DECIMAL(8,5)   NOT NULL,
  per_page_colour   DECIMAL(8,5)   NOT NULL,
  discount_pct      DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
  notes             TEXT           NULL,
  -- DRAFT: being edited; PENDING_APPROVAL: discount > 0, awaiting manager;
  -- APPROVED: ready for use / conversion; REJECTED: manager declined.
  status            ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED')
                      NOT NULL DEFAULT 'DRAFT',
  approved_by       INT UNSIGNED NULL,
  approved_at       DATETIME     NULL,
  approval_note     TEXT         NULL,
  created_by        INT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_lq_lead     FOREIGN KEY (lead_id)    REFERENCES leads (id),
  CONSTRAINT fk_lq_approver FOREIGN KEY (approved_by) REFERENCES users (id),
  CONSTRAINT fk_lq_creator  FOREIGN KEY (created_by)  REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- lead_quotation_printers — individual printer lines within a quotation.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_quotation_printers (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quotation_id  INT UNSIGNED NOT NULL,
  printer_model VARCHAR(200) NOT NULL,
  quantity      INT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lqp_quotation FOREIGN KEY (quotation_id)
    REFERENCES lead_quotations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- lead_stage_history — immutable record of every stage transition.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id    INT UNSIGNED NOT NULL,
  from_stage VARCHAR(30)  NULL,         -- NULL for the initial NEW stage
  to_stage   VARCHAR(30)  NOT NULL,
  note       TEXT         NULL,
  changed_by INT UNSIGNED NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lsh_lead FOREIGN KEY (lead_id)    REFERENCES leads (id),
  CONSTRAINT fk_lsh_user FOREIGN KEY (changed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('003_leads')
ON DUPLICATE KEY UPDATE version = version;

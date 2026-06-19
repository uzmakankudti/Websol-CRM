-- =====================================================================
-- Migration 014 — Billing & Invoice Management
--
-- Business rules enforced:
--   BR-011  No edit once POSTED (invoice status >= ISSUED).
--   BR-012  Invoice can only be generated if ALL period meter readings
--           for the contract's printers are APPROVED (approval_status
--           IN ('APPROVED','NONE')).
--   BR-022  A credit note must reference an invoice and its total must
--           not exceed the invoice total.
--   BR-025  Overage pages (above monthly allowance) are charged at the
--           base per-click rate PLUS a 10% premium.
--
-- Money: all monetary columns are DECIMAL (never FLOAT) for exactness.
-- FK rule: every column referencing users.id is BIGINT UNSIGNED.
-- =====================================================================

-- --- Permissions -------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('billing.read',   'View invoices and credit notes'),
  ('billing.create', 'Generate draft invoices'),
  ('billing.issue',  'Issue (post) invoices to customers'),
  ('billing.pay',    'Mark invoices paid / void'),
  ('billing.credit', 'Create credit notes against invoices')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- CONTRACTS_MANAGER: full billing lifecycle
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTRACTS_MANAGER'
  AND p.code IN ('billing.read','billing.create','billing.issue','billing.pay','billing.credit');

-- BILLING_EXECUTIVE: full lifecycle
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'BILLING_EXECUTIVE'
  AND p.code IN ('billing.read','billing.create','billing.issue','billing.pay','billing.credit');

-- FINANCE_MANAGER: read + issue + pay, no generation
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'FINANCE_MANAGER'
  AND p.code IN ('billing.read','billing.issue','billing.pay');

-- SALES_MANAGER: read only
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('SALES_MANAGER','SALES_REP','CEO')
  AND p.code = 'billing.read';

-- SYSTEM_ADMIN: full access
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN ('billing.read','billing.create','billing.issue','billing.pay','billing.credit');

-- --- invoices ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_no          VARCHAR(40)     NOT NULL,
  contract_id         BIGINT UNSIGNED NOT NULL,
  customer_id         BIGINT UNSIGNED NOT NULL,

  -- Billing period (inclusive). period_days = calendar days in full month;
  -- actual_days covers partial months.
  period_start        DATE            NOT NULL,
  period_end          DATE            NOT NULL,
  period_days         SMALLINT UNSIGNED NOT NULL,   -- days in the full calendar month
  actual_days         SMALLINT UNSIGNED NOT NULL,   -- days contract was active

  -- Amounts — all DECIMAL for exactness (BR-money rule)
  lease_fee_full      DECIMAL(12,2)   NOT NULL,   -- monthly_lease_fee from contract
  lease_fee_prorated  DECIMAL(12,2)   NOT NULL,   -- pro-rated if partial month
  clicks_bw_amount    DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  clicks_colour_amount DECIMAL(12,4)  NOT NULL DEFAULT 0.0000,
  overage_bw_amount   DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  overage_colour_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  subtotal            DECIMAL(12,2)   NOT NULL,
  tax_rate            DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  tax_amount          DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  total               DECIMAL(12,2)   NOT NULL,
  amount_paid         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  amount_credited     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,

  status              ENUM('DRAFT','ISSUED','PAID','OVERDUE','VOID') NOT NULL DEFAULT 'DRAFT',
  due_date            DATE            NULL,
  issued_at           DATETIME        NULL,
  paid_at             DATETIME        NULL,
  voided_at           DATETIME        NULL,
  void_reason         VARCHAR(500)    NULL,
  oracle_ref          VARCHAR(100)    NULL,   -- external posting ref (BR-011 gate)
  notes               TEXT            NULL,

  generated_by        BIGINT UNSIGNED NOT NULL,
  issued_by           BIGINT UNSIGNED NULL,
  paid_by             BIGINT UNSIGNED NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_invoice_no (invoice_no),
  KEY idx_inv_contract   (contract_id),
  KEY idx_inv_customer   (customer_id),
  KEY idx_inv_status     (status),
  KEY idx_inv_period     (period_start, period_end),

  CONSTRAINT fk_inv_contract  FOREIGN KEY (contract_id)  REFERENCES contracts (id),
  CONSTRAINT fk_inv_customer  FOREIGN KEY (customer_id)  REFERENCES customers (id),
  CONSTRAINT fk_inv_gen       FOREIGN KEY (generated_by) REFERENCES users     (id),
  CONSTRAINT fk_inv_iss       FOREIGN KEY (issued_by)    REFERENCES users     (id),
  CONSTRAINT fk_inv_paid      FOREIGN KEY (paid_by)      REFERENCES users     (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- invoice_lines -----------------------------------------------------
-- One row per printer per invoice. Holds the per-printer click math so
-- the audit trail is permanent even if meter readings are later changed.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_id            BIGINT UNSIGNED NOT NULL,
  printer_id            BIGINT UNSIGNED NOT NULL,
  serial_no             VARCHAR(120)    NOT NULL,  -- snapshot
  model                 VARCHAR(200)    NOT NULL,  -- snapshot

  -- Meter snapshots captured at generation time
  opening_bw            INT UNSIGNED    NOT NULL DEFAULT 0,
  closing_bw            INT UNSIGNED    NOT NULL DEFAULT 0,
  delta_bw              INT UNSIGNED    NOT NULL DEFAULT 0,
  opening_colour        INT UNSIGNED    NULL,
  closing_colour        INT UNSIGNED    NULL,
  delta_colour          INT UNSIGNED    NULL,

  -- Allowances (from printer record at generation time)
  allowance_bw          INT UNSIGNED    NOT NULL DEFAULT 0,
  allowance_colour      INT UNSIGNED    NULL,

  -- Page breakdown
  base_pages_bw         INT UNSIGNED    NOT NULL DEFAULT 0,  -- min(delta, allowance)
  overage_pages_bw      INT UNSIGNED    NOT NULL DEFAULT 0,  -- max(delta - allowance, 0)
  base_pages_colour     INT UNSIGNED    NULL,
  overage_pages_colour  INT UNSIGNED    NULL,

  -- Rates snapshot (from contract at generation time)
  rate_bw               DECIMAL(8,5)    NOT NULL DEFAULT 0.00000,
  rate_colour           DECIMAL(8,5)    NOT NULL DEFAULT 0.00000,
  overage_rate_bw       DECIMAL(8,5)    NOT NULL DEFAULT 0.00000,  -- rate * 1.1
  overage_rate_colour   DECIMAL(8,5)    NOT NULL DEFAULT 0.00000,

  -- Line amounts
  amount_bw             DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  amount_colour         DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  amount_overage_bw     DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  amount_overage_colour DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,
  line_total            DECIMAL(12,4)   NOT NULL DEFAULT 0.0000,

  -- Which meter readings were used (comma-separated ids for traceability)
  meter_reading_ids     TEXT            NULL,

  CONSTRAINT fk_il_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_il_printer FOREIGN KEY (printer_id) REFERENCES printers (id),
  KEY idx_il_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- credit_notes ------------------------------------------------------
-- BR-022: must reference an invoice; total must not exceed invoice total.
CREATE TABLE IF NOT EXISTS credit_notes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  credit_no       VARCHAR(40)     NOT NULL,
  invoice_id      BIGINT UNSIGNED NOT NULL,
  customer_id     BIGINT UNSIGNED NOT NULL,
  amount          DECIMAL(12,2)   NOT NULL,
  reason          VARCHAR(500)    NOT NULL,
  status          ENUM('DRAFT','ISSUED','VOID') NOT NULL DEFAULT 'DRAFT',
  issued_at       DATETIME        NULL,
  voided_at       DATETIME        NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_credit_no (credit_no),
  KEY idx_cn_invoice  (invoice_id),
  KEY idx_cn_customer (customer_id),

  CONSTRAINT fk_cn_invoice  FOREIGN KEY (invoice_id)  REFERENCES invoices  (id),
  CONSTRAINT fk_cn_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_cn_creator  FOREIGN KEY (created_by)  REFERENCES users     (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('014_billing')
ON DUPLICATE KEY UPDATE version = version;

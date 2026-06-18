-- =====================================================================
-- Migration 009 — Service Ticket Management (Helpdesk)
--
-- Extends the shared service_tickets table (created in 008) with
-- helpdesk-specific capabilities:
--
--   • Tickets can originate from PHONE, PORTAL, or EMAIL.
--   • Issue categories (Paper Jam, Print Quality, …) classify tickets.
--   • SLA tier is inherited from the linked contract at creation time
--     so the response window is driven by the customer's contract tier,
--     not just by priority (BR-013).
--   • A ticket can be reopened within 48 hours of resolution (BR-015).
--     After that window a fresh ticket must be raised.
--   • SLA alerts track the T-1h warning, breach (→ CSR Supervisor),
--     and 2× breach (→ Operations Manager) escalation events.
--   • Technician auto-assignment by region: when autoAssign=true the
--     API finds the least-busy FIELD_TECHNICIAN whose region matches
--     the site's city.
--
-- Business rules:
--   BR-013  SLA due = created_at + SLA hours from contract.sla_tier
--           (PLATINUM 2h, GOLD 4h, SILVER 8h, BRONZE 24h). Falls back
--           to priority-based window when no contract is supplied.
--   BR-014  Closing a ticket requires a non-empty resolution note in
--           addition to the customer's signature or OTP.
--   BR-015  A RESOLVED ticket may be reopened (→ OPEN) only within
--           48 hours of resolution. After that a new ticket is required.
-- =====================================================================

-- ---------------------------------------------------------------------
-- New role: Operations Manager — receives 2× SLA breach escalations.
-- (idempotent)
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, description)
VALUES ('OPERATIONS_MANAGER', 'Operations Manager',
        'Oversees field operations and handles 2× SLA breach escalations')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------------
-- New permissions.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('service.resolve',  'Mark a service ticket as Resolved with resolution notes'),
  ('service.reopen',   'Reopen a Resolved ticket within the 48-hour window (BR-015)'),
  ('helpdesk.manage',  'Manage helpdesk issue categories and SLA settings')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SYSTEM_ADMIN: everything.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN ('service.resolve','service.reopen','helpdesk.manage')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CSR: can resolve tickets received by phone / portal / e-mail.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CSR'
  AND p.code IN ('service.resolve','service.reopen')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CSR_SUPERVISOR: same plus helpdesk configuration.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CSR_SUPERVISOR'
  AND p.code IN ('service.resolve','service.reopen','helpdesk.manage')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- FIELD_TECHNICIAN / SENIOR_TECHNICIAN: can resolve on-site.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('FIELD_TECHNICIAN','SENIOR_TECHNICIAN')
  AND p.code IN ('service.resolve')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- OPERATIONS_MANAGER: read + resolve.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'OPERATIONS_MANAGER'
  AND p.code IN ('service.read','service.resolve','helpdesk.manage')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- DISPATCH_COORDINATOR already has service.read / service.create / service.assign;
-- give them service.resolve so they can mark tickets resolved after dispatch.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'DISPATCH_COORDINATOR'
  AND p.code IN ('service.resolve')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- Idempotent column additions to service_tickets.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_009_ticket_cols;
DELIMITER //
CREATE PROCEDURE websol_009_ticket_cols()
BEGIN
  -- source: how the helpdesk received the request.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'service_tickets' AND column_name = 'source'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN source ENUM('PHONE','PORTAL','EMAIL') NOT NULL DEFAULT 'PHONE' AFTER description;
  END IF;

  -- sla_tier: snapshot of the contract's tier at the moment the ticket was raised.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'service_tickets' AND column_name = 'sla_tier'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN sla_tier ENUM('PLATINUM','GOLD','SILVER','BRONZE') NULL AFTER source;
  END IF;

  -- issue_category_id: FK to helpdesk_issue_categories (added below).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'service_tickets' AND column_name = 'issue_category_id'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN issue_category_id BIGINT UNSIGNED NULL AFTER sla_tier;
  END IF;

  -- reopen_count: how many times this ticket has been reopened (BR-015 audit).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'service_tickets' AND column_name = 'reopen_count'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN reopen_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER issue_category_id;
  END IF;

  -- last_resolved_at: updated every time the ticket is resolved; drives BR-015 window.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'service_tickets' AND column_name = 'last_resolved_at'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN last_resolved_at DATETIME NULL AFTER reopen_count;
  END IF;
END //
DELIMITER ;
CALL websol_009_ticket_cols();
DROP PROCEDURE IF EXISTS websol_009_ticket_cols;

-- Add region to users (for auto-assign by geography). Idempotent.
DROP PROCEDURE IF EXISTS websol_009_user_region;
DELIMITER //
CREATE PROCEDURE websol_009_user_region()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'region'
  ) THEN
    ALTER TABLE users ADD COLUMN region VARCHAR(100) NULL AFTER full_name;
  END IF;
END //
DELIMITER ;
CALL websol_009_user_region();
DROP PROCEDURE IF EXISTS websol_009_user_region;

-- ---------------------------------------------------------------------
-- helpdesk_issue_categories — classifies the nature of each ticket.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS helpdesk_issue_categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100)    NOT NULL,
  description VARCHAR(500)    NULL,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hic_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO helpdesk_issue_categories (name, description) VALUES
  ('Paper Jam',             'Paper jammed in the printer or feed mechanism'),
  ('Print Quality',         'Faded, streaked, blurred or missing output'),
  ('Network / Connectivity','Printer offline or unreachable on the network'),
  ('Toner / Ink',           'Low toner, toner leak or colour calibration issue'),
  ('Hardware Failure',      'Physical component broken or not functioning'),
  ('Software / Driver',     'Driver issues, firmware update or print-queue error'),
  ('Meter Reading',         'Routine meter capture or allowance query'),
  ('Other',                 'Any issue not covered by the categories above')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- service_sla_alerts — one row per alert type per ticket, idempotent.
--
-- alert_type:
--   T_MINUS_1H   — ticket is within 1 hour of its SLA deadline.
--   BREACH       — ticket has passed its SLA deadline; auto-escalated
--                  to the CSR Supervisor.
--   DOUBLE_BREACH — ticket has been open for 2× its contracted SLA
--                  window; escalated to the Operations Manager.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_sla_alerts (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id    BIGINT UNSIGNED NOT NULL,
  alert_type   ENUM('T_MINUS_1H','BREACH','DOUBLE_BREACH') NOT NULL,
  escalated_to BIGINT UNSIGNED NULL,
  status       ENUM('NEW','NOTIFIED','ESCALATED') NOT NULL DEFAULT 'NEW',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alert (ticket_id, alert_type),
  KEY idx_sla_alert_type (alert_type, created_at),
  CONSTRAINT fk_sla_alert_ticket  FOREIGN KEY (ticket_id)    REFERENCES service_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_sla_alert_escalee FOREIGN KEY (escalated_to) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- FK: service_tickets.issue_category_id → helpdesk_issue_categories.id
-- Added here (after the referenced table exists). Idempotent.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_009_cat_fk;
DELIMITER //
CREATE PROCEDURE websol_009_cat_fk()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND constraint_name = 'fk_st_category'
  ) THEN
    ALTER TABLE service_tickets
      ADD CONSTRAINT fk_st_category
          FOREIGN KEY (issue_category_id)
          REFERENCES helpdesk_issue_categories (id) ON DELETE SET NULL;
  END IF;
END //
DELIMITER ;
CALL websol_009_cat_fk();
DROP PROCEDURE IF EXISTS websol_009_cat_fk;

INSERT INTO schema_migrations (version)
VALUES ('009_helpdesk')
ON DUPLICATE KEY UPDATE version = version;

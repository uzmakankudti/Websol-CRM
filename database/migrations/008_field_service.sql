-- =====================================================================
-- Migration 008 — Field Service Management
--
-- Implements: on-site service work orders ("tickets") that a field
-- technician executes on a mobile device. A ticket carries a visit type,
-- priority and SLA, is assigned to a technician, and moves through a
-- lifecycle as the technician travels to site, checks in (GPS + arrival
-- time vs SLA), captures meter readings (with photo), records spare
-- parts used (auto-deducting inventory), and finally closes with a
-- customer digital signature or OTP. Tickets that cannot be resolved
-- within SLA are escalated to a senior technician.
--
-- Business rules enforced here / by the API:
--   BR-004  A meter reading must be >= the previous reading for the same
--           printer (meters only ever go up).
--   BR-005  If the delta over the previous reading exceeds 3x the
--           printer's monthly allowance, the reading is flagged for
--           approval (stored, but marked PENDING — not auto-rejected).
--   BR-006  For a colour printer, BOTH the B/W and colour meter values
--           are required.
--   BR-021  (reused) Recording a part used may never drive consumable
--           stock below zero.
--
-- Lifecycle:
--   OPEN → ASSIGNED → IN_TRANSIT → ON_SITE → IN_PROGRESS → RESOLVED → CLOSED
--   Most active states → ESCALATED (SLA breach) or CANCELLED.
-- =====================================================================

-- ---------------------------------------------------------------------
-- New permissions for this module.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('service.read',     'View service tickets, meter readings and parts used'),
  ('service.create',   'Log / raise a new service ticket'),
  ('service.assign',   'Assign or reassign a ticket to a technician'),
  ('service.update',   'Field work: transit, check-in, meter, parts, status'),
  ('service.close',    'Close a ticket with customer signature or OTP'),
  ('service.escalate', 'Escalate a ticket to a senior technician')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Senior Technician role — escalation target for field technicians.
-- (idempotent)
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, description)
VALUES ('SENIOR_TECHNICIAN', 'Senior Technician', 'Handles escalated field service tickets and mentors technicians')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SYSTEM_ADMIN: full service management.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN ('service.read','service.create','service.assign','service.update','service.close','service.escalate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- DISPATCH_COORDINATOR: raises and assigns field visits, can escalate.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'DISPATCH_COORDINATOR'
  AND p.code IN ('service.read','service.create','service.assign','service.escalate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- FIELD_TECHNICIAN: does the on-site work, closes and can escalate.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'FIELD_TECHNICIAN'
  AND p.code IN ('service.read','service.update','service.close','service.escalate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SENIOR_TECHNICIAN: everything a technician can do, plus (re)assign.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'SENIOR_TECHNICIAN'
  AND p.code IN ('service.read','service.assign','service.update','service.close','service.escalate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CSR / CSR_SUPERVISOR: log service requests from customers.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('CSR','CSR_SUPERVISOR')
  AND p.code IN ('service.read','service.create')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CEO: read-only visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CEO'
  AND p.code IN ('service.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- Idempotent cleanup — drop in child → parent order so a partial run
-- never leaves orphaned tables or mismatched FK types behind.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS service_sync_log;
DROP TABLE IF EXISTS service_notifications;
DROP TABLE IF EXISTS service_parts_used;
DROP TABLE IF EXISTS meter_readings;
DROP TABLE IF EXISTS service_ticket_status_history;
DROP TABLE IF EXISTS service_tickets;

-- ---------------------------------------------------------------------
-- Add geo coordinates to customer_sites (for geography-sorted routing
-- and check-in distance). Idempotent via stored procedure.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_add_site_geo;
DELIMITER //
CREATE PROCEDURE websol_add_site_geo()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = 'customer_sites'
                   AND column_name = 'geo_lat') THEN
    ALTER TABLE customer_sites
      ADD COLUMN geo_lat DECIMAL(10,7) NULL AFTER postal_code,
      ADD COLUMN geo_lng DECIMAL(10,7) NULL AFTER geo_lat;
  END IF;
END //
DELIMITER ;
CALL websol_add_site_geo();
DROP PROCEDURE IF EXISTS websol_add_site_geo;

-- ---------------------------------------------------------------------
-- Add monthly meter allowance to printers (drives BR-005). Idempotent.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_add_printer_allowance;
DELIMITER //
CREATE PROCEDURE websol_add_printer_allowance()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = 'printers'
                   AND column_name = 'monthly_allowance_bw') THEN
    ALTER TABLE printers
      ADD COLUMN monthly_allowance_bw     INT UNSIGNED NULL AFTER lifetime_pages,
      ADD COLUMN monthly_allowance_colour INT UNSIGNED NULL AFTER monthly_allowance_bw;
  END IF;
END //
DELIMITER ;
CALL websol_add_printer_allowance();
DROP PROCEDURE IF EXISTS websol_add_printer_allowance;

-- ---------------------------------------------------------------------
-- service_tickets — one on-site work order.
-- ticket_no is generated by the API: SVC-YYYY-NNNN.
--
-- FK type audit (must match referenced column exactly):
--   customer_id  BIGINT UNSIGNED  → customers.id       BIGINT UNSIGNED  ✓
--   site_id      INT UNSIGNED     → customer_sites.id  INT UNSIGNED     ✓
--   contract_id  BIGINT UNSIGNED  → contracts.id       BIGINT UNSIGNED  ✓
--   printer_id   BIGINT UNSIGNED  → printers.id        BIGINT UNSIGNED  ✓
--   assigned_to  BIGINT UNSIGNED  → users.id           BIGINT UNSIGNED  ✓
--   escalated_to BIGINT UNSIGNED  → users.id           BIGINT UNSIGNED  ✓
--   created_by   BIGINT UNSIGNED  → users.id           BIGINT UNSIGNED  ✓
-- ---------------------------------------------------------------------
CREATE TABLE service_tickets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_no       VARCHAR(40)     NOT NULL,
  visit_type      ENUM('INSTALLATION','PREVENTIVE_MAINTENANCE','CORRECTIVE',
                       'METER_READING','TONER_REPLACEMENT','COLLECTION') NOT NULL,
  priority        ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM',
  status          ENUM('OPEN','ASSIGNED','IN_TRANSIT','ON_SITE','IN_PROGRESS',
                       'RESOLVED','CLOSED','ESCALATED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  customer_id     BIGINT UNSIGNED NOT NULL,
  site_id         INT UNSIGNED    NULL,
  contract_id     BIGINT UNSIGNED NULL,
  printer_id      BIGINT UNSIGNED NULL,
  assigned_to     BIGINT UNSIGNED NULL,
  escalated_to    BIGINT UNSIGNED NULL,
  description     TEXT            NULL,
  scheduled_date  DATE            NULL,
  sla_due_at      DATETIME        NULL,
  in_transit_at   DATETIME        NULL,
  checked_in_at   DATETIME        NULL,
  checkin_lat     DECIMAL(10,7)   NULL,
  checkin_lng     DECIMAL(10,7)   NULL,
  sla_met         TINYINT(1)      NULL,
  resolved_at     DATETIME        NULL,
  resolution_notes TEXT           NULL,
  closed_at       DATETIME        NULL,
  close_method    ENUM('SIGNATURE','OTP') NULL,
  signature_name  VARCHAR(200)    NULL,
  signature_image MEDIUMTEXT      NULL,
  escalated_at    DATETIME        NULL,
  escalation_reason TEXT          NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticket_no (ticket_no),
  KEY idx_ticket_assigned_date (assigned_to, scheduled_date),
  KEY idx_ticket_status (status),
  CONSTRAINT fk_st_customer  FOREIGN KEY (customer_id)  REFERENCES customers      (id),
  CONSTRAINT fk_st_site      FOREIGN KEY (site_id)       REFERENCES customer_sites (id) ON DELETE SET NULL,
  CONSTRAINT fk_st_contract  FOREIGN KEY (contract_id)   REFERENCES contracts      (id) ON DELETE SET NULL,
  CONSTRAINT fk_st_printer   FOREIGN KEY (printer_id)    REFERENCES printers       (id) ON DELETE SET NULL,
  CONSTRAINT fk_st_assignee  FOREIGN KEY (assigned_to)   REFERENCES users          (id),
  CONSTRAINT fk_st_escalatee FOREIGN KEY (escalated_to)  REFERENCES users          (id),
  CONSTRAINT fk_st_creator   FOREIGN KEY (created_by)    REFERENCES users          (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- service_ticket_status_history — immutable log of every transition.
-- ---------------------------------------------------------------------
CREATE TABLE service_ticket_status_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id   BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(20)     NULL,
  to_status   VARCHAR(20)     NOT NULL,
  reason      VARCHAR(500)    NULL,
  changed_by  BIGINT UNSIGNED NOT NULL,
  changed_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stsh_ticket     FOREIGN KEY (ticket_id)  REFERENCES service_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_stsh_changed_by FOREIGN KEY (changed_by) REFERENCES users           (id),
  KEY idx_stsh_ticket_time (ticket_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- meter_readings — meter captures (with photo).
-- BR-004 / BR-005 / BR-006 enforced by the API on insert.
--
-- FK type audit:
--   ticket_id   BIGINT UNSIGNED → service_tickets.id BIGINT UNSIGNED ✓
--   printer_id  BIGINT UNSIGNED → printers.id        BIGINT UNSIGNED ✓
--   recorded_by BIGINT UNSIGNED → users.id           BIGINT UNSIGNED ✓
-- ---------------------------------------------------------------------
CREATE TABLE meter_readings (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id       BIGINT UNSIGNED NULL,
  printer_id      BIGINT UNSIGNED NOT NULL,
  reading_bw      INT UNSIGNED    NOT NULL,
  reading_colour  INT UNSIGNED    NULL,
  previous_bw     INT UNSIGNED    NULL,
  previous_colour INT UNSIGNED    NULL,
  delta_bw        INT             NULL,
  delta_colour    INT             NULL,
  photo_image     MEDIUMTEXT      NULL,
  needs_approval  TINYINT(1)      NOT NULL DEFAULT 0,
  approval_status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE',
  recorded_by     BIGINT UNSIGNED NOT NULL,
  recorded_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mr_ticket   FOREIGN KEY (ticket_id)   REFERENCES service_tickets (id) ON DELETE SET NULL,
  CONSTRAINT fk_mr_printer  FOREIGN KEY (printer_id)  REFERENCES printers        (id),
  CONSTRAINT fk_mr_recorder FOREIGN KEY (recorded_by) REFERENCES users           (id),
  KEY idx_mr_printer_time (printer_id, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- service_parts_used — spare parts / toner consumed on a ticket.
-- Inserting a row auto-deducts consumable_stock.qty_on_hand (BR-021).
--
-- FK type audit:
--   ticket_id     BIGINT UNSIGNED → service_tickets.id BIGINT UNSIGNED ✓
--   consumable_id BIGINT UNSIGNED → consumables.id     BIGINT UNSIGNED ✓
--   warehouse_id  INT UNSIGNED    → warehouses.id      INT UNSIGNED    ✓
--   recorded_by   BIGINT UNSIGNED → users.id           BIGINT UNSIGNED ✓
-- ---------------------------------------------------------------------
CREATE TABLE service_parts_used (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id     BIGINT UNSIGNED NOT NULL,
  consumable_id BIGINT UNSIGNED NOT NULL,
  warehouse_id  INT UNSIGNED    NOT NULL,
  quantity      INT UNSIGNED    NOT NULL,
  recorded_by   BIGINT UNSIGNED NOT NULL,
  recorded_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_spu_ticket     FOREIGN KEY (ticket_id)     REFERENCES service_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_spu_consumable FOREIGN KEY (consumable_id) REFERENCES consumables     (id),
  CONSTRAINT fk_spu_warehouse  FOREIGN KEY (warehouse_id)  REFERENCES warehouses      (id),
  CONSTRAINT fk_spu_recorder   FOREIGN KEY (recorded_by)   REFERENCES users           (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- service_notifications — customer notifications triggered by the ticket
-- (e.g. "technician is on the way" when status becomes IN_TRANSIT).
-- ---------------------------------------------------------------------
CREATE TABLE service_notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id   BIGINT UNSIGNED NOT NULL,
  channel     ENUM('SMS','EMAIL') NOT NULL DEFAULT 'SMS',
  recipient   VARCHAR(200)    NULL,
  message     VARCHAR(500)    NOT NULL,
  status      ENUM('QUEUED','SENT','FAILED') NOT NULL DEFAULT 'QUEUED',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sn_ticket FOREIGN KEY (ticket_id) REFERENCES service_tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- service_sync_log — idempotency ledger for the offline sync endpoint.
-- The mobile app generates a unique client_action_id per queued action;
-- replaying the same action (after a flaky connection) is a no-op.
-- ---------------------------------------------------------------------
CREATE TABLE service_sync_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_action_id VARCHAR(80)     NOT NULL,
  action_type      VARCHAR(40)     NOT NULL,
  ticket_id        BIGINT UNSIGNED NULL,
  result           VARCHAR(20)     NOT NULL DEFAULT 'APPLIED',
  synced_by        BIGINT UNSIGNED NOT NULL,
  synced_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_action (client_action_id),
  CONSTRAINT fk_ssl_user FOREIGN KEY (synced_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('008_field_service')
ON DUPLICATE KEY UPDATE version = version;

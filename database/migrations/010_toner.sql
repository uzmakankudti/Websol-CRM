-- ============================================================
-- Module 9 — Toner / Consumable Shipment Management
--
-- FK types (must match parent PKs):
--   printers.id   → BIGINT UNSIGNED
--   consumables.id → BIGINT UNSIGNED
--   users.id      → BIGINT UNSIGNED
--
-- Business rules implemented here:
--   BR-016  Only one active (PENDING or IN_TRANSIT) toner shipment per printer.
--   BR-017  Alert at ≤ 20% toner; alerts cannot be suppressed when ≤ 10%.
-- ============================================================

-- Permissions
INSERT IGNORE INTO permissions (code, description) VALUES
  ('toner.read',   'View toner levels, shipments, and alerts'),
  ('toner.update', 'Report toner level readings from the field'),
  ('toner.manage', 'Create/update toner shipments; suppress alerts');

-- Grant to roles (same role-mapping pattern as earlier modules)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('toner.read')
  WHERE r.code IN ('CSR', 'CSR_SUPERVISOR', 'FIELD_TECHNICIAN', 'OPERATIONS_MANAGER', 'SYSTEM_ADMIN');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'toner.update'
  WHERE r.code IN ('FIELD_TECHNICIAN', 'CSR_SUPERVISOR', 'SYSTEM_ADMIN');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'toner.manage'
  WHERE r.code IN ('CSR', 'CSR_SUPERVISOR', 'OPERATIONS_MANAGER', 'SYSTEM_ADMIN');

-- ---------------------------------------------------------------------------
-- printer_toner_levels — one row per printer, updated in place.
--
-- estimated_days_remaining is computed by the API from daily_page_rate and
-- current toner_pct (see toner.ts).  last_change_at is reset to NOW() when
-- a shipment is marked DELIVERED (delivery-reset-to-100% flow).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS printer_toner_levels (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  printer_id               BIGINT UNSIGNED NOT NULL,
  toner_pct                TINYINT UNSIGNED NOT NULL DEFAULT 100
                             COMMENT '0–100 percent remaining',
  daily_page_rate          DECIMAL(8,2)    NULL
                             COMMENT 'Pages per day; technician-reported for offline estimate',
  estimated_days_remaining DECIMAL(6,1)    NULL,
  last_change_at           DATETIME        NULL
                             COMMENT 'Timestamp of last toner cartridge replacement',
  updated_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  updated_by               BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ptl_printer (printer_id),
  CONSTRAINT fk_ptl_printer FOREIGN KEY (printer_id) REFERENCES printers   (id),
  CONSTRAINT fk_ptl_user    FOREIGN KEY (updated_by)  REFERENCES users      (id)
);

-- ---------------------------------------------------------------------------
-- toner_shipments — tracks a cartridge being sent to a printer.
-- BR-016 is enforced in the API layer by checking for PENDING/IN_TRANSIT rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS toner_shipments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  printer_id    BIGINT UNSIGNED NOT NULL,
  consumable_id BIGINT UNSIGNED NULL
                  COMMENT 'Specific toner SKU from the consumables catalogue',
  status        ENUM('PENDING','IN_TRANSIT','DELIVERED','CANCELLED')
                  NOT NULL DEFAULT 'PENDING',
  tracking_ref  VARCHAR(200)    NULL,
  notes         VARCHAR(500)    NULL,
  shipped_at    DATETIME        NULL,
  delivered_at  DATETIME        NULL,
  updated_by    BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ts_printer_status (printer_id, status),
  CONSTRAINT fk_ts_printer    FOREIGN KEY (printer_id)    REFERENCES printers    (id),
  CONSTRAINT fk_ts_consumable FOREIGN KEY (consumable_id) REFERENCES consumables (id),
  CONSTRAINT fk_ts_created_by FOREIGN KEY (created_by)    REFERENCES users       (id),
  CONSTRAINT fk_ts_updated_by FOREIGN KEY (updated_by)    REFERENCES users       (id)
);

-- ---------------------------------------------------------------------------
-- toner_alerts — one row per printer per alert_type; INSERT IGNORE prevents
-- duplicates.  The UNIQUE KEY is also the idempotency guard for the timer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS toner_alerts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  printer_id  BIGINT UNSIGNED NOT NULL,
  alert_type  ENUM('LOW_20','CRITICAL_10') NOT NULL,
  status      ENUM('NEW','NOTIFIED','SUPPRESSED') NOT NULL DEFAULT 'NEW',
  toner_pct   TINYINT UNSIGNED NULL
                COMMENT 'Level at the time the alert was raised',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_toner_alert (printer_id, alert_type),
  CONSTRAINT fk_ta_printer FOREIGN KEY (printer_id) REFERENCES printers (id)
);

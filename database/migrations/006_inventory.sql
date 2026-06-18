-- =====================================================================
-- Migration 006 — Inventory / Warehouse Management
--
-- Implements: multi-location printer stock tracking, goods receipt notes
-- (GRN) for receiving printer and consumable batches, spare-parts and
-- toner inventory with per-warehouse quantities and reorder alerts,
-- and printer allocation to contracts with double-allocation prevention.
--
-- Business rules enforced here / by the API:
--   BR-021  Consumable stock may never go below zero — block any
--           adjustment that would result in a negative qty_on_hand.
--   BR-003  (from Module 4) One active contract per printer —
--           enforced again in the allocate endpoint: a printer must
--           be IN_STOCK with current_contract_id = NULL to be allocated.
--   BR-022  A GRN may not have zero lines (no empty receipts).
--   BR-023  A printer on a GRN that is ORDERED or IN_TRANSIT is
--           automatically transitioned to RECEIVED and assigned to
--           the receiving warehouse.
-- =====================================================================

-- ---------------------------------------------------------------------
-- New permissions for this module.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('inventory.read',     'View warehouses, GRNs, consumable stock and stock levels'),
  ('inventory.grn',      'Create goods receipt notes (receive stock)'),
  ('inventory.adjust',   'Adjust consumable stock and manage warehouses / consumable catalogue'),
  ('inventory.allocate', 'Allocate and deallocate printers to/from contracts')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants.
-- ---------------------------------------------------------------------

-- SYSTEM_ADMIN: full inventory management.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SYSTEM_ADMIN'
  AND p.code IN ('inventory.read', 'inventory.grn', 'inventory.adjust', 'inventory.allocate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_MANAGER: read + allocate (needs to allocate printers to contracts).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_MANAGER'
  AND p.code IN ('inventory.read', 'inventory.allocate')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- SALES_REP: read-only visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'SALES_REP'
  AND p.code IN ('inventory.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- CEO: read-only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CEO'
  AND p.code IN ('inventory.read')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- ---------------------------------------------------------------------
-- warehouses — central warehouse and regional depots.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(20)     NOT NULL,
  name          VARCHAR(200)    NOT NULL,
  type          ENUM('CENTRAL','DEPOT') NOT NULL DEFAULT 'CENTRAL',
  address       TEXT            NULL,
  city          VARCHAR(120)    NULL,
  contact_name  VARCHAR(150)    NULL,
  contact_phone VARCHAR(50)     NULL,
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_warehouse_code (code),
  CONSTRAINT fk_wh_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- consumables — catalogue of spare parts and toner SKUs.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumables (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku           VARCHAR(80)     NOT NULL,
  name          VARCHAR(200)    NOT NULL,
  category      ENUM('TONER','SPARE_PART','PAPER','OTHER') NOT NULL DEFAULT 'TONER',
  unit          VARCHAR(30)     NOT NULL DEFAULT 'unit',
  reorder_level INT             NOT NULL DEFAULT 0,
  description   TEXT            NULL,
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_consumable_sku (sku),
  CONSTRAINT chk_reorder_non_neg CHECK (reorder_level >= 0),
  CONSTRAINT fk_consumable_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- consumable_stock — per-warehouse stock levels.
--
-- BR-021: CHECK (qty_on_hand >= 0) is the storage-layer guard; the API
-- validates first and returns a friendly 422 before reaching the DB.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumable_stock (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  warehouse_id  INT UNSIGNED    NOT NULL,
  consumable_id BIGINT UNSIGNED NOT NULL,
  qty_on_hand   INT             NOT NULL DEFAULT 0,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stock_location (warehouse_id, consumable_id),
  CONSTRAINT chk_stock_non_neg  CHECK (qty_on_hand >= 0),       -- BR-021
  CONSTRAINT fk_stock_warehouse  FOREIGN KEY (warehouse_id)  REFERENCES warehouses  (id),
  CONSTRAINT fk_stock_consumable FOREIGN KEY (consumable_id) REFERENCES consumables (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- goods_receipt_notes — header record for each stock receipt event.
-- GRN number is generated by the API: GRN-YYYY-NNNN.
-- BR-022: at least one line is enforced by the API.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goods_receipt_notes (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grn_no        VARCHAR(40)     NOT NULL,
  warehouse_id  INT UNSIGNED    NOT NULL,
  supplier_name VARCHAR(200)    NULL,
  supplier_ref  VARCHAR(100)    NULL,
  received_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes         TEXT            NULL,
  received_by   BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn_no (grn_no),
  CONSTRAINT fk_grn_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_grn_receiver  FOREIGN KEY (received_by)  REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- grn_printer_lines — individual printers received on a GRN.
-- BR-023: the API auto-transitions each printer from ORDERED/IN_TRANSIT
-- to RECEIVED and records the warehouse assignment.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grn_printer_lines (
  id         INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grn_id     BIGINT UNSIGNED NOT NULL,
  printer_id BIGINT UNSIGNED NOT NULL,
  unit_cost  DECIMAL(10,2)   NULL,
  CONSTRAINT fk_grnp_grn     FOREIGN KEY (grn_id)     REFERENCES goods_receipt_notes (id) ON DELETE CASCADE,
  CONSTRAINT fk_grnp_printer FOREIGN KEY (printer_id) REFERENCES printers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- grn_consumable_lines — consumable batches received on a GRN.
-- Creating a line automatically increases consumable_stock.qty_on_hand.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grn_consumable_lines (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grn_id        BIGINT UNSIGNED NOT NULL,
  consumable_id BIGINT UNSIGNED NOT NULL,
  quantity      INT UNSIGNED    NOT NULL,
  unit_cost     DECIMAL(10,2)   NULL,
  CONSTRAINT fk_grnc_grn        FOREIGN KEY (grn_id)        REFERENCES goods_receipt_notes (id) ON DELETE CASCADE,
  CONSTRAINT fk_grnc_consumable FOREIGN KEY (consumable_id) REFERENCES consumables (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Add warehouse_id to printers — tracks which warehouse holds the unit.
-- Uses a stored procedure to stay idempotent on re-runs.
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_add_printer_warehouse;
DELIMITER //
CREATE PROCEDURE websol_add_printer_warehouse()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name   = 'printers'
                   AND column_name  = 'warehouse_id') THEN
    ALTER TABLE printers
      ADD COLUMN warehouse_id INT UNSIGNED NULL AFTER current_site_id,
      ADD CONSTRAINT fk_printer_warehouse
        FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE SET NULL;
  END IF;
END //
DELIMITER ;
CALL websol_add_printer_warehouse();
DROP PROCEDURE IF EXISTS websol_add_printer_warehouse;

INSERT INTO schema_migrations (version)
VALUES ('006_inventory')
ON DUPLICATE KEY UPDATE version = version;

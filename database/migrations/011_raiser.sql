-- =====================================================================
-- Migration 011 — Raiser Classification on Service Tickets
--
-- Every service ticket now records WHO raised it, distinguishing an
-- internal employee from an external customer contact.
--
-- New columns on service_tickets:
--   raiser_type        EMPLOYEE | CUSTOMER
--   raiser_party       INTERNAL | EXTERNAL
--   raiser_user_id     FK → users.id (BIGINT UNSIGNED) — when EMPLOYEE
--   raiser_contact_id  FK → customer_contacts.id (INT UNSIGNED) — when CUSTOMER
--   raiser_name        name captured at creation time (snapshot)
--   raiser_email       email captured at creation time (snapshot)
--
-- Existing rows keep raiser_type='EMPLOYEE', raiser_party='INTERNAL'
-- (the historical assumption: tickets were always raised by staff).
--
-- This column is intentionally separate from `source` (which records
-- the *channel*: PHONE / PORTAL / EMAIL).
-- =====================================================================

DROP PROCEDURE IF EXISTS websol_011_raiser_cols;
DELIMITER //
CREATE PROCEDURE websol_011_raiser_cols()
BEGIN
  -- raiser_type: who raised the ticket
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_type'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_type ENUM('EMPLOYEE','CUSTOMER') NOT NULL DEFAULT 'EMPLOYEE'
      AFTER source;
  END IF;

  -- raiser_party: organisational perspective (INTERNAL staff vs EXTERNAL caller)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_party'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_party ENUM('INTERNAL','EXTERNAL') NOT NULL DEFAULT 'INTERNAL'
      AFTER raiser_type;
  END IF;

  -- raiser_user_id: FK to users (used when raiser_type = 'EMPLOYEE')
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_user_id'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_user_id BIGINT UNSIGNED NULL
      AFTER raiser_party;
  END IF;

  -- raiser_contact_id: FK to customer_contacts (used when raiser_type = 'CUSTOMER')
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_contact_id'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_contact_id INT UNSIGNED NULL
      AFTER raiser_user_id;
  END IF;

  -- raiser_name: snapshot of the raiser's name at creation
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_name'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_name VARCHAR(200) NULL
      AFTER raiser_contact_id;
  END IF;

  -- raiser_email: snapshot of the raiser's email at creation
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND column_name = 'raiser_email'
  ) THEN
    ALTER TABLE service_tickets
      ADD COLUMN raiser_email VARCHAR(200) NULL
      AFTER raiser_name;
  END IF;
END //
DELIMITER ;
CALL websol_011_raiser_cols();
DROP PROCEDURE IF EXISTS websol_011_raiser_cols;

-- ---------------------------------------------------------------------
-- Back-fill existing rows: raiser = the user who created the ticket.
-- This fills raiser_user_id from created_by and copies the user's email.
-- ---------------------------------------------------------------------
UPDATE service_tickets st
  JOIN users u ON u.id = st.created_by
SET st.raiser_user_id = st.created_by,
    st.raiser_name    = u.full_name,
    st.raiser_email   = u.email
WHERE st.raiser_user_id IS NULL
  AND st.raiser_type = 'EMPLOYEE';

-- ---------------------------------------------------------------------
-- Foreign-key constraints (idempotent)
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_011_raiser_fks;
DELIMITER //
CREATE PROCEDURE websol_011_raiser_fks()
BEGIN
  -- FK: raiser_user_id → users.id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_schema = DATABASE()
      AND table_name   = 'service_tickets'
      AND constraint_name = 'fk_st_raiser_user'
  ) THEN
    ALTER TABLE service_tickets
      ADD CONSTRAINT fk_st_raiser_user
          FOREIGN KEY (raiser_user_id) REFERENCES users (id) ON DELETE SET NULL;
  END IF;

  -- FK: raiser_contact_id → customer_contacts.id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_schema = DATABASE()
      AND table_name   = 'service_tickets'
      AND constraint_name = 'fk_st_raiser_contact'
  ) THEN
    ALTER TABLE service_tickets
      ADD CONSTRAINT fk_st_raiser_contact
          FOREIGN KEY (raiser_contact_id) REFERENCES customer_contacts (id) ON DELETE SET NULL;
  END IF;
END //
DELIMITER ;
CALL websol_011_raiser_fks();
DROP PROCEDURE IF EXISTS websol_011_raiser_fks;

-- Optional index for the new filter (idempotent)
DROP PROCEDURE IF EXISTS websol_011_raiser_idx;
DELIMITER //
CREATE PROCEDURE websol_011_raiser_idx()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'service_tickets'
      AND index_name  = 'idx_st_raiser_type'
  ) THEN
    ALTER TABLE service_tickets ADD INDEX idx_st_raiser_type (raiser_type);
  END IF;
END //
DELIMITER ;
CALL websol_011_raiser_idx();
DROP PROCEDURE IF EXISTS websol_011_raiser_idx;

INSERT INTO schema_migrations (version)
VALUES ('011_raiser')
ON DUPLICATE KEY UPDATE version = version;

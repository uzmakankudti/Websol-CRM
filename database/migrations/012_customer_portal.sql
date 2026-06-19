-- =====================================================================
-- Migration 012 — Customer Self-Service Portal (email-OTP login)
--
-- Lets a customer CONTACT (a person already stored in customer_contacts)
-- log in to a read-only portal that shows ONLY their own company's
-- contracts, printers and service tickets. Authentication is by one-time
-- code emailed to the contact's address — no customer passwords are ever
-- stored.
--
-- Security model:
--   * Only the HASH of each OTP is stored (HMAC-SHA256, peppered with
--     APP_SECRET), never the plaintext code.
--   * OTPs are single-use (consumed_at), short-lived (expires_at) and
--     attempt-limited (attempts).
--   * The portal session is a separate token with aud='customer' that
--     carries NO staff RBAC permissions; access is scoped server-side to
--     the customer_id baked into the token.
--
-- FK type rule: every column referencing users.id is BIGINT UNSIGNED;
-- customer_contacts.id is INT UNSIGNED and customers.id is BIGINT UNSIGNED
-- (see 001/004) — the columns below match those exactly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- customer_contacts: portal-auth fields.
--   portal_enabled       — a contact may be blocked from the portal
--                          without deleting them.
--   last_portal_login_at — observability / audit convenience.
-- Added idempotently (ADD COLUMN IF NOT EXISTS is not on older MySQL).
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS websol_012_contact_cols;
DELIMITER //
CREATE PROCEDURE websol_012_contact_cols()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'customer_contacts'
      AND column_name = 'portal_enabled'
  ) THEN
    ALTER TABLE customer_contacts
      ADD COLUMN portal_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_primary;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'customer_contacts'
      AND column_name = 'last_portal_login_at'
  ) THEN
    ALTER TABLE customer_contacts
      ADD COLUMN last_portal_login_at DATETIME NULL AFTER portal_enabled;
  END IF;
END //
DELIMITER ;
CALL websol_012_contact_cols();
DROP PROCEDURE IF EXISTS websol_012_contact_cols;

-- ---------------------------------------------------------------------
-- customer_otp — one row per issued login code.
--
-- A row is created ONLY for a known, portal-enabled contact, but the
-- request endpoint always responds identically so the table's existence
-- never leaks whether an email is registered.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_otp (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id   INT UNSIGNED    NOT NULL,
  customer_id  BIGINT UNSIGNED NOT NULL,
  email        VARCHAR(200)    NOT NULL,
  code_hash    CHAR(64)        NOT NULL,
  expires_at   DATETIME        NOT NULL,
  attempts     INT UNSIGNED    NOT NULL DEFAULT 0,
  consumed_at  DATETIME        NULL,
  created_ip   VARCHAR(64)     NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- For throttling we look up recent codes by email + time.
  KEY idx_cotp_email_created (email, created_at),
  KEY idx_cotp_lookup (email, consumed_at, expires_at),
  CONSTRAINT fk_cotp_contact  FOREIGN KEY (contact_id)
    REFERENCES customer_contacts (id) ON DELETE CASCADE,
  CONSTRAINT fk_cotp_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('012_customer_portal')
ON DUPLICATE KEY UPDATE version = version;

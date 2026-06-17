-- =====================================================================
-- Migration 001 — initial schema
-- Run order matters: files are applied in ascending numeric prefix order.
-- =====================================================================

-- Tracks which migrations have already been applied, so you never run one
-- twice. Your migration runner should INSERT a row here after each file.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(255) NOT NULL PRIMARY KEY,
  applied_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A first real table to prove the schema works: customers who lease printers.
CREATE TABLE IF NOT EXISTS customers (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  email       VARCHAR(255) NULL,
  phone       VARCHAR(50) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('001_init')
ON DUPLICATE KEY UPDATE version = version;

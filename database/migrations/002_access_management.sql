-- =====================================================================
-- Migration 002 — User & Access Management
--
-- Implements: roles, fine-grained permissions, users, password-reset
-- tokens, and an immutable audit log.
--
-- Business rules enforced here / by the API:
--   BR-018  Users are DEACTIVATED, never deleted. There is no DELETE path;
--           `users.is_active` is toggled and the row is retained forever so
--           audit history and foreign keys stay intact.
--   BR-019  Only a System Administrator may create or deactivate users
--           (enforced in the API via the `users.create` / `users.deactivate`
--           permissions, which only the System Administrator role holds).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Roles — the fixed set of business roles in Websol CRM.
-- `code` is the stable machine identifier used in code; `name` is display.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(64)  NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (code, name, description) VALUES
  ('CEO',                  'CEO',                  'Executive — full visibility, read access across the business'),
  ('SALES_MANAGER',        'Sales Manager',        'Manages the sales team and pipeline'),
  ('SALES_REP',            'Sales Rep',            'Sells leases and managed-print services'),
  ('CONTRACTS_MANAGER',    'Contracts Manager',    'Owns lease contracts and renewals'),
  ('WAREHOUSE_MANAGER',    'Warehouse Manager',    'Manages inventory and the warehouse team'),
  ('WAREHOUSE_STAFF',      'Warehouse Staff',      'Receives, stores and picks stock'),
  ('DISPATCH_COORDINATOR', 'Dispatch Coordinator', 'Schedules deliveries and field visits'),
  ('FIELD_TECHNICIAN',     'Field Technician',     'Installs and services printers on site'),
  ('CSR',                  'CSR',                  'Customer Service Representative'),
  ('CSR_SUPERVISOR',       'CSR Supervisor',       'Leads the customer-service team'),
  ('BILLING_EXECUTIVE',    'Billing Executive',    'Generates invoices and handles billing'),
  ('FINANCE_MANAGER',      'Finance Manager',      'Owns finance, payments and reporting'),
  ('SYSTEM_ADMIN',         'System Administrator', 'Manages users, roles and system configuration'),
  ('TONER_COORDINATOR',    'Toner Coordinator',    'Manages toner supply and replenishment')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

-- ---------------------------------------------------------------------
-- Permissions — fine-grained capability codes (module.action).
-- Roles are granted permissions via `role_permissions`. The frontend uses
-- the caller's permission list to decide which screens/nav to render, so
-- "each role sees only what it should" is driven entirely by this data.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(64)  NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (code, description) VALUES
  ('users.read',           'View users'),
  ('users.create',         'Create new users'),
  ('users.update',         'Edit user details and role'),
  ('users.deactivate',     'Activate / deactivate users'),
  ('users.reset_password', 'Reset another user''s password'),
  ('roles.read',           'View roles'),
  ('audit.read',           'View the audit log')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Role → permission grants (many-to-many).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role       FOREIGN KEY (role_id)       REFERENCES roles (id)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System Administrator: every permission in this module (BR-019).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN (
    'users.read', 'users.create', 'users.update',
    'users.deactivate', 'users.reset_password', 'roles.read', 'audit.read'
  )
WHERE r.code = 'SYSTEM_ADMIN'
ON DUPLICATE KEY UPDATE role_id = role_permissions.role_id;

-- CEO: read-only visibility into people and the audit trail.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('users.read', 'roles.read', 'audit.read')
WHERE r.code = 'CEO'
ON DUPLICATE KEY UPDATE role_id = role_permissions.role_id;

-- All other roles get no access-management permissions; they receive their
-- own module permissions in later migrations.

-- ---------------------------------------------------------------------
-- Users — never deleted (BR-018). Deactivation is a soft state change.
-- `password_hash` stores a self-describing scrypt string
-- (scrypt$N$saltHex$derivedHex); see backend/src/shared/auth.ts.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email                VARCHAR(255) NOT NULL UNIQUE,
  full_name            VARCHAR(255) NOT NULL,
  phone                VARCHAR(50)  NULL,
  password_hash        VARCHAR(255) NOT NULL,
  role_id              INT UNSIGNED NOT NULL,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  must_change_password TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at        TIMESTAMP    NULL,
  failed_login_count   INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until         TIMESTAMP    NULL,
  created_by           BIGINT UNSIGNED NULL,
  deactivated_at       TIMESTAMP    NULL,
  deactivated_by       BIGINT UNSIGNED NULL,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id),
  INDEX idx_users_role (role_id),
  INDEX idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bootstrap System Administrator so the system can be logged into.
-- Email:    admin@websol.local
-- Password: ChangeMe!123   (must_change_password = 1 forces a reset at first login)
INSERT INTO users (email, full_name, password_hash, role_id, is_active, must_change_password)
SELECT
  'admin@websol.local',
  'System Administrator',
  'scrypt$16384$f97ab3a882f190aaab1838d7e11ba506$2bc051baac2fe3ee5ee8a99497de1b9f1b0300ee35a71347d670f61e4db1b8117a21d8ebe9a64a4b69f2627db80003d29ecb8ff06afc4540b2d64920b18a0bdb',
  r.id, 1, 1
FROM roles r
WHERE r.code = 'SYSTEM_ADMIN'
ON DUPLICATE KEY UPDATE email = users.email;

-- ---------------------------------------------------------------------
-- Password reset tokens — only the SHA-256 hash of the token is stored.
-- The raw token is sent to the user and never persisted.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL UNIQUE,
  expires_at TIMESTAMP    NOT NULL,
  used_at    TIMESTAMP    NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users (id),
  INDEX idx_prt_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Audit log — an append-only record of every change. The API never
-- updates or deletes rows here. `changes` holds a JSON before/after diff.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,           -- who made the change (NULL = system/anonymous)
  actor_email   VARCHAR(255) NULL,              -- denormalised so history survives if a user is renamed
  entity_type   VARCHAR(64)  NOT NULL,          -- e.g. 'user', 'auth'
  entity_id     VARCHAR(64)  NULL,              -- id of the affected entity
  action        VARCHAR(64)  NOT NULL,          -- e.g. 'create', 'update', 'deactivate', 'login'
  reason        VARCHAR(500) NULL,              -- human-supplied reason for the change
  changes       JSON         NULL,              -- { before: {...}, after: {...} }
  ip_address    VARCHAR(64)  NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_actor (actor_user_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version)
VALUES ('002_access_management')
ON DUPLICATE KEY UPDATE version = version;

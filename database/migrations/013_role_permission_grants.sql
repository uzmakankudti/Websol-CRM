-- =====================================================================
-- Migration 013 — Fix missing role-to-permission grants
--
-- Six roles were never granted any permissions across migrations 001-012,
-- making those users land on a blank "My password" screen after login.
-- Two more roles had partial gaps.
--
-- All inserts use INSERT IGNORE so re-running is safe.
--
-- Roles fixed:
--   CONTRACTS_MANAGER  — zero perms; now gets full contract + customer lifecycle
--   WAREHOUSE_MANAGER  — zero perms; now gets full inventory + printer management
--   WAREHOUSE_STAFF    — zero perms; now gets inventory read + GRN
--   BILLING_EXECUTIVE  — zero perms; now gets customer/contract/printer read
--   FINANCE_MANAGER    — zero perms; now gets read across customers/contracts/
--                        printers/inventory + audit
--   TONER_COORDINATOR  — zero perms; now gets toner manage + printers/inventory read
--   CSR_SUPERVISOR     — partial; was missing service.assign
--   OPERATIONS_MANAGER — partial; was missing service.assign + service.escalate
-- =====================================================================

-- ── CONTRACTS_MANAGER ──────────────────────────────────────────────────────
-- Full contract lifecycle + customer visibility + printers (needed for
-- linking contracts to printer assets).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CONTRACTS_MANAGER'
  AND p.code IN (
    'customers.read',
    'contracts.read', 'contracts.create', 'contracts.update',
    'contracts.activate', 'contracts.terminate',
    'printers.read'
  );

-- ── WAREHOUSE_MANAGER ──────────────────────────────────────────────────────
-- Full inventory operations + printer status management (QC, stock moves).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'WAREHOUSE_MANAGER'
  AND p.code IN (
    'inventory.read', 'inventory.grn', 'inventory.adjust', 'inventory.allocate',
    'printers.read', 'printers.update', 'printers.manage_status'
  );

-- ── WAREHOUSE_STAFF ────────────────────────────────────────────────────────
-- Receive stock and view inventory; read-only printers.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'WAREHOUSE_STAFF'
  AND p.code IN (
    'inventory.read', 'inventory.grn',
    'printers.read'
  );

-- ── BILLING_EXECUTIVE ──────────────────────────────────────────────────────
-- Read-only access to customers, contracts and printers for billing purposes.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'BILLING_EXECUTIVE'
  AND p.code IN (
    'customers.read',
    'contracts.read',
    'printers.read'
  );

-- ── FINANCE_MANAGER ────────────────────────────────────────────────────────
-- Read access across all revenue-relevant data + audit trail.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'FINANCE_MANAGER'
  AND p.code IN (
    'customers.read',
    'contracts.read',
    'printers.read',
    'inventory.read',
    'audit.read'
  );

-- ── TONER_COORDINATOR ──────────────────────────────────────────────────────
-- Full toner management + printer and inventory read (to check stock levels).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'TONER_COORDINATOR'
  AND p.code IN (
    'toner.read', 'toner.update', 'toner.manage',
    'printers.read',
    'inventory.read'
  );

-- ── CSR_SUPERVISOR (gap fix) ───────────────────────────────────────────────
-- Was missing service.assign — supervisors must be able to reassign tickets.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'CSR_SUPERVISOR'
  AND p.code IN ('service.assign');

-- ── OPERATIONS_MANAGER (gap fix) ──────────────────────────────────────────
-- Was missing service.assign and service.escalate for operational oversight.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'OPERATIONS_MANAGER'
  AND p.code IN ('service.assign', 'service.escalate');

INSERT INTO schema_migrations (version)
VALUES ('013_role_permission_grants')
ON DUPLICATE KEY UPDATE version = version;

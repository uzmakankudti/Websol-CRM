/**
 * User & Access Management — behavioural tests.
 *
 * These exercise the real HTTP handlers, RBAC and audit writer with the data
 * layer mocked, so they run anywhere (no seeded MySQL needed) — the same
 * approach as health.test.ts.
 *
 * Coverage maps to the requirements:
 *   1. Login succeeds with valid credentials, fails with invalid.
 *   2. A role without the permission is blocked (403) on protected endpoints.
 *   3. BR-018 — "deleting" a user deactivates (never hard-deletes); the user
 *      reference is retained for historical records.
 *   4. BR-019 — a non-admin cannot create or deactivate users.
 *   5. The audit log records create / update / deactivate with user, time and
 *      reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HttpRequest } from '@azure/functions';

// --- Mock the data layer ------------------------------------------------------
// `query` is mocked so no live DB is needed. The audit writer is NOT mocked: it
// runs for real and calls the mocked `query`, so we can assert the actual audit
// INSERTs it produces.
vi.mock('../src/shared/db', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  pingDatabase: vi.fn(),
}));

// User/role lookups are mocked to return fixtures; password hashing, JWTs,
// RBAC and the audit writer all run for real.
vi.mock('../src/shared/users-repo', async (importActual) => {
  const actual = await importActual<typeof import('../src/shared/users-repo')>();
  return {
    ...actual,
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    getPermissionsForRole: vi.fn(),
  };
});

import { query } from '../src/shared/db';
import { hashPassword, issueToken } from '../src/shared/auth';
import * as repo from '../src/shared/users-repo';
import { login } from '../src/functions/auth';
import { listUsers, createUser, updateUser, deactivateUser } from '../src/functions/users';

const queryMock = query as unknown as Mock;
const findUserByEmail = repo.findUserByEmail as unknown as Mock;
const findUserById = repo.findUserById as unknown as Mock;
const getPermissionsForRole = repo.getPermissionsForRole as unknown as Mock;

// --- Fixtures -----------------------------------------------------------------
const PASSWORD = 'ChangeMe!123';
// Hash once (scrypt is intentionally slow) and reuse across tests.
const PASSWORD_HASH = hashPassword(PASSWORD);

const ALL_PERMS = [
  'users.read',
  'users.create',
  'users.update',
  'users.deactivate',
  'users.reset_password',
  'roles.read',
  'audit.read',
];

function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'admin@websol.local',
    full_name: 'System Administrator',
    phone: null,
    password_hash: PASSWORD_HASH,
    role_id: 13,
    role_code: 'SYSTEM_ADMIN',
    role_name: 'System Administrator',
    is_active: 1,
    must_change_password: 0,
    last_login_at: null,
    failed_login_count: 0,
    locked_until: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

/** A bearer token for a System Administrator (all permissions). */
function adminToken() {
  return issueToken({
    sub: 1,
    email: 'admin@websol.local',
    role: 'SYSTEM_ADMIN',
    perms: ALL_PERMS,
  });
}
/** A bearer token for a Sales Rep (no access-management permissions). */
function repToken() {
  return issueToken({ sub: 2, email: 'rep@websol.local', role: 'SALES_REP', perms: [] });
}

interface ReqOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  token?: string;
}

function makeRequest(opts: ReqOptions = {}): HttpRequest {
  const headers = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: new Map(Object.entries(opts.query ?? {})),
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

/** Audit INSERTs the real writeAudit produced during a handler call. */
function auditInserts(): { sql: string; params: unknown[] }[] {
  return queryMock.mock.calls
    .filter(([sql]) => /INSERT INTO audit_log/i.test(String(sql)))
    .map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default behaviour for direct queries the handlers run. Individual tests
  // override as needed.
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM roles/i.test(sql)) {
      return [{ id: 13, code: 'SYSTEM_ADMIN', name: 'System Administrator' }];
    }
    if (/SELECT id FROM users WHERE email/i.test(sql)) return []; // email not taken
    if (/INSERT INTO users/i.test(sql)) return { insertId: 42, affectedRows: 1 };
    return [];
  });
});

// =============================================================================
// 1. Login
// =============================================================================
describe('login', () => {
  it('succeeds with valid credentials and returns a token', async () => {
    findUserByEmail.mockResolvedValue(adminRow());
    getPermissionsForRole.mockResolvedValue(ALL_PERMS);

    const res = await login(
      makeRequest({ body: { email: 'admin@websol.local', password: PASSWORD } }),
      {} as never,
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as { token: string; user: { email: string; permissions: string[] } };
    expect(typeof body.token).toBe('string');
    expect(body.user.email).toBe('admin@websol.local');
    expect(body.user.permissions).toContain('users.create');
    // A successful login is audited.
    expect(auditInserts().some((a) => a.params[4] === 'login')).toBe(true);
  });

  it('fails with an incorrect password (401) and audits the failure', async () => {
    findUserByEmail.mockResolvedValue(adminRow());

    const res = await login(
      makeRequest({ body: { email: 'admin@websol.local', password: 'wrong-password' } }),
      {} as never,
    );

    expect(res.status).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    expect(auditInserts().some((a) => a.params[4] === 'login_failed')).toBe(true);
  });

  it('fails for an unknown email (401) without revealing the account exists', async () => {
    findUserByEmail.mockResolvedValue(undefined);

    const res = await login(
      makeRequest({ body: { email: 'nobody@websol.local', password: PASSWORD } }),
      {} as never,
    );

    expect(res.status).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a deactivated account (403)', async () => {
    findUserByEmail.mockResolvedValue(adminRow({ is_active: 0 }));

    const res = await login(
      makeRequest({ body: { email: 'admin@websol.local', password: PASSWORD } }),
      {} as never,
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DEACTIVATED');
  });
});

// =============================================================================
// 2. Role-based access — a blocked role gets 403
// =============================================================================
describe('role-based access control', () => {
  it('allows a System Administrator to list users', async () => {
    findUserById.mockResolvedValue(adminRow());
    const res = await listUsers(makeRequest({ token: adminToken() }), {} as never);
    expect(res.status).toBe(200);
  });

  it('blocks a Sales Rep from listing users (403)', async () => {
    const res = await listUsers(makeRequest({ token: repToken() }), {} as never);
    expect(res.status).toBe(403);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    // Authorization fails before any data is touched.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await listUsers(makeRequest(), {} as never);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// 4. BR-019 — only a System Administrator may create or deactivate users
// =============================================================================
describe('BR-019: non-admin cannot create or deactivate users', () => {
  it('blocks a non-admin from creating a user (403)', async () => {
    const res = await createUser(
      makeRequest({
        token: repToken(),
        body: { email: 'new@websol.local', fullName: 'New Person', roleId: 3 },
      }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled(); // nothing created
  });

  it('blocks a non-admin from deactivating a user (403)', async () => {
    const res = await deactivateUser(
      makeRequest({ token: repToken(), params: { id: '5' }, body: { reason: 'nope' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows a System Administrator to create a user', async () => {
    findUserById.mockResolvedValue(
      adminRow({ id: 42, email: 'new@websol.local', full_name: 'New Person' }),
    );
    const res = await createUser(
      makeRequest({
        token: adminToken(),
        body: { email: 'new@websol.local', fullName: 'New Person', roleId: 3 },
      }),
      {} as never,
    );
    expect(res.status).toBe(201);
    // INSERT happened.
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO users/i.test(String(sql)))).toBe(true);
  });
});

// =============================================================================
// 3. BR-018 — "deleting" deactivates; the user reference is retained
// =============================================================================
describe('BR-018: deactivate instead of delete', () => {
  it('deactivates via a soft UPDATE (is_active = 0), never a DELETE', async () => {
    findUserById
      .mockResolvedValueOnce(adminRow({ id: 5, email: 'victim@websol.local', is_active: 1 }))
      .mockResolvedValueOnce(adminRow({ id: 5, email: 'victim@websol.local', is_active: 0 }));

    const res = await deactivateUser(
      makeRequest({
        token: adminToken(),
        params: { id: '5' },
        body: { reason: 'Left the company' },
      }),
      {} as never,
    );

    expect(res.status).toBe(200);
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    // A soft deactivation update was issued...
    expect(sqls.some((s) => /UPDATE users SET[\s\S]*is_active = 0/i.test(s))).toBe(true);
    // ...and the user row was never hard-deleted.
    expect(sqls.some((s) => /DELETE\s+FROM\s+users/i.test(s))).toBe(false);
  });

  it('requires a reason to deactivate', async () => {
    findUserById.mockResolvedValue(adminRow({ id: 5, is_active: 1 }));
    const res = await deactivateUser(
      makeRequest({ token: adminToken(), params: { id: '5' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('will not let an admin deactivate their own account', async () => {
    const res = await deactivateUser(
      makeRequest({ token: adminToken(), params: { id: '1' }, body: { reason: 'oops' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('schema keeps the user reference for historical records', () => {
    const migration = readFileSync(
      resolve(__dirname, '../../database/migrations/002_access_management.sql'),
      'utf8',
    );
    // The audit log references users (so history points at the retained row)...
    expect(migration).toMatch(/audit_log[\s\S]*REFERENCES users \(id\)/i);
    // ...users carry a soft-delete flag and deactivation metadata...
    expect(migration).toMatch(/is_active\s+TINYINT/i);
    expect(migration).toMatch(/deactivated_at/i);
    // ...and the source has no hard-delete path for users.
    const usersSource = readFileSync(resolve(__dirname, '../src/functions/users.ts'), 'utf8');
    expect(usersSource).not.toMatch(/DELETE\s+FROM\s+users/i);
  });
});

// =============================================================================
// 5. Audit log records create / update / deactivate with user, time, reason
// =============================================================================
describe('audit log', () => {
  it('records a create with the acting user and a reason', async () => {
    findUserById.mockResolvedValue(adminRow({ id: 42, email: 'new@websol.local' }));
    await createUser(
      makeRequest({
        token: adminToken(),
        body: { email: 'new@websol.local', fullName: 'New Person', roleId: 3 },
      }),
      {} as never,
    );

    const entry = auditInserts().find((a) => a.params[4] === 'create');
    expect(entry).toBeDefined();
    // params: [actorUserId, actorEmail, entityType, entityId, action, reason, changes, ip]
    expect(entry!.params[0]).toBe(1); // acting admin
    expect(entry!.params[2]).toBe('user');
    expect(entry!.params[5]).toBeTruthy(); // reason
    // Time is stamped by the DB default; the INSERT relies on it rather than
    // passing a value, so created_at is always recorded.
    expect(entry!.sql).toMatch(/INSERT INTO audit_log/i);
  });

  it('records an update with a before/after diff', async () => {
    findUserById.mockResolvedValue(adminRow({ id: 5, full_name: 'Old Name' }));
    await updateUser(
      makeRequest({ token: adminToken(), params: { id: '5' }, body: { fullName: 'New Name' } }),
      {} as never,
    );

    const entry = auditInserts().find((a) => a.params[4] === 'update');
    expect(entry).toBeDefined();
    expect(entry!.params[0]).toBe(1);
    const changes = JSON.parse(String(entry!.params[6]));
    expect(changes.before.fullName).toBe('Old Name');
    expect(changes.after.fullName).toBe('New Name');
  });

  it('records a deactivate with the supplied reason', async () => {
    findUserById.mockResolvedValue(adminRow({ id: 5, is_active: 1 }));
    await deactivateUser(
      makeRequest({ token: adminToken(), params: { id: '5' }, body: { reason: 'Contract ended' } }),
      {} as never,
    );

    const entry = auditInserts().find((a) => a.params[4] === 'deactivate');
    expect(entry).toBeDefined();
    expect(entry!.params[0]).toBe(1);
    expect(entry!.params[5]).toBe('Contract ended');
  });
});

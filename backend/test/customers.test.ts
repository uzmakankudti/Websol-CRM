/**
 * Customer & Contract Management — customer profile tests.
 *
 *   1. Profile CRUD       — create requires a name; create/update persist the full
 *                           company + billing profile; updates only touch supplied fields.
 *   2. Sites & contacts   — adding a primary site/contact demotes any previous primary;
 *                           sub-resources are scoped to their customer (404 otherwise).
 *   3. Permissions        — reads need customers.read; writes need customers.create/update.
 *
 * `query` is mocked; RBAC/JWT/audit/HTTP helpers run for real.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HttpRequest } from '@azure/functions';

vi.mock('../src/shared/db', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { query } from '../src/shared/db';
import { issueToken } from '../src/shared/auth';
import {
  listCustomers,
  createCustomer,
  updateCustomer,
  createSite,
  createContact,
  updateSite,
} from '../src/functions/customers';

const queryMock = query as unknown as Mock;

// =============================================================================
// Tokens & request builder
// =============================================================================

const FULL_PERMS = ['customers.read', 'customers.create', 'customers.update'];

function fullToken() {
  return issueToken({
    sub: 10,
    email: 'mgr@websol.local',
    role: 'SALES_MANAGER',
    perms: FULL_PERMS,
  });
}
function readOnlyToken() {
  return issueToken({ sub: 12, email: 'ceo@websol.local', role: 'CEO', perms: ['customers.read'] });
}

function req(
  opts: { token?: string; params?: Record<string, string>; body?: unknown } = {},
): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: new Map<string, string>(),
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

function customerRow(extra: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: 'Acme Corp',
    registration_no: 'REG123',
    vat_no: 'VAT999',
    industry: 'Manufacturing',
    website: 'https://acme.example',
    email: 'info@acme.example',
    phone: '+27110000000',
    billing_address: '1 Main Rd',
    billing_email: 'billing@acme.example',
    billing_phone: '+27110000001',
    status: 'ACTIVE',
    notes: null,
    created_by: 10,
    created_by_name: 'Sales Manager',
    created_at: '2026-01-01 09:00:00',
    updated_at: '2026-01-01 09:00:00',
    ...extra,
  };
}

function calledSqls(): string[] {
  return queryMock.mock.calls.map(([sql]) => String(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM customers/i.test(sql)) return [customerRow()];
    if (/FROM customer_sites/i.test(sql)) return [];
    if (/FROM customer_contacts/i.test(sql)) return [];
    if (/INSERT INTO/i.test(sql)) return { insertId: 5, affectedRows: 1 };
    if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
    return [];
  });
});

// =============================================================================
// 1. Profile CRUD
// =============================================================================

describe('1. customer profile CRUD', () => {
  it('rejects creation without a name (400)', async () => {
    const res = await createCustomer(
      req({ token: fullToken(), body: { email: 'x@y.com' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(calledSqls().some((s) => /INSERT INTO customers/i.test(s))).toBe(false);
  });

  it('creates a customer and persists the full profile (201)', async () => {
    const body = {
      name: 'Orion Printing Ltd',
      registrationNo: 'REG-001',
      vatNo: 'VAT-001',
      industry: 'Legal',
      website: 'https://orion.example',
      email: 'hello@orion.example',
      phone: '+27210000000',
      billingAddress: '5 Long St',
      billingEmail: 'ap@orion.example',
      billingPhone: '+27210000001',
      notes: 'Key account',
    };
    const res = await createCustomer(req({ token: fullToken(), body }), {} as never);
    expect(res.status).toBe(201);

    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO customers/i.test(String(sql)));
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    expect(params[0]).toBe('Orion Printing Ltd'); // name
    expect(params[1]).toBe('REG-001'); // registration_no
    expect(params[7]).toBe('5 Long St'); // billing_address
    expect(params[12]).toBe(10); // created_by = actor
  });

  it('update only sets supplied fields and leaves the rest untouched', async () => {
    const res = await updateCustomer(
      req({ token: fullToken(), params: { id: '5' }, body: { billingEmail: 'new@acme.example' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const update = queryMock.mock.calls.find(([sql]) => /UPDATE customers SET/i.test(String(sql)));
    expect(update).toBeDefined();
    expect(String(update![0])).toMatch(/billing_email = \?/);
    expect(String(update![0])).not.toMatch(/name = \?/);
  });

  it('rejects an empty-string name on update (400)', async () => {
    const res = await updateCustomer(
      req({ token: fullToken(), params: { id: '5' }, body: { name: '   ' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an invalid status (400)', async () => {
    const res = await updateCustomer(
      req({ token: fullToken(), params: { id: '5' }, body: { status: 'ARCHIVED' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('404s when updating a customer that does not exist', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM customers/i.test(sql)) return [];
      return [];
    });
    const res = await updateCustomer(
      req({ token: fullToken(), params: { id: '999' }, body: { name: 'X' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 2. Sites & contacts
// =============================================================================

describe('2. sites & contacts', () => {
  it('adding a primary site demotes existing primaries first', async () => {
    const res = await createSite(
      req({ token: fullToken(), params: { id: '5' }, body: { name: 'HQ', isPrimary: true } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    // A demotion UPDATE must run before the INSERT.
    const demote = queryMock.mock.calls.find(([sql]) =>
      /UPDATE customer_sites SET is_primary = 0/i.test(String(sql)),
    );
    expect(demote).toBeDefined();
  });

  it('does not demote when the new site is not primary', async () => {
    await createSite(
      req({ token: fullToken(), params: { id: '5' }, body: { name: 'Branch' } }),
      {} as never,
    );
    const demote = queryMock.mock.calls.find(([sql]) =>
      /UPDATE customer_sites SET is_primary = 0/i.test(String(sql)),
    );
    expect(demote).toBeUndefined();
  });

  it('site name is required (400)', async () => {
    const res = await createSite(
      req({ token: fullToken(), params: { id: '5' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('updating a site scoped to another customer 404s', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM customer_sites WHERE id = \? AND customer_id = \?/i.test(sql)) return [];
      return [];
    });
    const res = await updateSite(
      req({ token: fullToken(), params: { id: '5', siteId: '77' }, body: { city: 'Cape Town' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('adding a primary contact demotes existing primary contacts first', async () => {
    const res = await createContact(
      req({ token: fullToken(), params: { id: '5' }, body: { name: 'Jane Doe', isPrimary: true } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const demote = queryMock.mock.calls.find(([sql]) =>
      /UPDATE customer_contacts SET is_primary = 0/i.test(String(sql)),
    );
    expect(demote).toBeDefined();
  });
});

// =============================================================================
// 3. Permissions
// =============================================================================

describe('3. permissions', () => {
  it('listing requires customers.read (read-only token is allowed)', async () => {
    const res = await listCustomers(req({ token: readOnlyToken() }), {} as never);
    expect(res.status).toBe(200);
  });

  it('a read-only user cannot create a customer (403)', async () => {
    const res = await createCustomer(
      req({ token: readOnlyToken(), body: { name: 'Nope Ltd' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a read-only user cannot add a site (403)', async () => {
    const res = await createSite(
      req({ token: readOnlyToken(), params: { id: '5' }, body: { name: 'HQ' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });

  it('an unauthenticated request is rejected (401)', async () => {
    const res = await listCustomers(req({}), {} as never);
    expect(res.status).toBe(401);
  });
});

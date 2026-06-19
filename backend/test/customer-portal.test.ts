/**
 * Customer portal (email-OTP login + own-data views) — security-focused tests.
 *
 * Covered:
 *   - request-otp never enumerates accounts (same response, known vs unknown).
 *   - request-otp throttling stops generating codes past the window limit.
 *   - verify-otp: valid code logs in; wrong / expired / reused code rejected;
 *     attempt cap locks the code (rate limiting).
 *   - a customer session token scopes every query to its own customer_id and
 *     cannot be aimed at another customer.
 *   - a customer token is rejected by staff endpoints, and a staff token is
 *     rejected by the portal — the two are never interchangeable.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HttpRequest } from '@azure/functions';

vi.mock('../src/shared/db', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { query } from '../src/shared/db';
import {
  hashOtp,
  issueToken,
  issueCustomerToken,
  verifyToken,
  verifyCustomerToken,
} from '../src/shared/auth';
import {
  requestOtp,
  verifyOtp,
  portalMe,
  portalContracts,
  portalPrinters,
  portalTickets,
} from '../src/functions/customer-portal';
import { listTickets } from '../src/functions/field-service';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(opts: { token?: string; body?: unknown; query?: Record<string, string> } = {}): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  const qmap = new Map<string, string>(Object.entries(opts.query ?? {}));
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => qmap.get(k) ?? null },
    params: {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

interface Res {
  status?: number;
  jsonBody?: { ok?: boolean; message?: string; token?: string; error?: { code?: string; message?: string }; [k: string]: unknown };
}

/** SQL strings passed to query(), for asserting which statements ran. */
function sqlCalls(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
}
function ranSql(re: RegExp): boolean {
  return sqlCalls().some((s) => re.test(s));
}

// A customer-portal token scoped to customer 7.
function customerToken(cid = 7, contactId = 70) {
  return issueCustomerToken({ sub: contactId, cid, email: 'buyer@acme.test' });
}
// A staff token (full perms) — must NOT be accepted by the portal.
function staffToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: ['service.read'] });
}

beforeEach(() => {
  queryMock.mockReset();
});

// ---------------------------------------------------------------------------
// request-otp — no account enumeration + throttling
// ---------------------------------------------------------------------------

describe('POST /portal/request-otp — no enumeration', () => {
  it('known portal-enabled email gets a generic response and a code is generated', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryMock
      .mockResolvedValueOnce([{ n: 0 }]) // throttle count
      .mockResolvedValueOnce([{ id: 70, customer_id: 7, email: 'buyer@acme.test', name: 'Buyer', portal_enabled: 1 }]) // contact
      .mockResolvedValueOnce({}) // INSERT customer_otp
      .mockResolvedValueOnce({}); // writeAudit

    const res = (await requestOtp(req({ body: { email: 'Buyer@Acme.test' } }), {} as never)) as Res;

    expect(res.status).toBe(200);
    expect(res.jsonBody?.message).toMatch(/if that email is registered/i);
    expect(ranSql(/INSERT INTO customer_otp/i)).toBe(true);
    logSpy.mockRestore();
  });

  it('unknown email returns the EXACT same response and generates no code', async () => {
    queryMock
      .mockResolvedValueOnce([{ n: 0 }]) // throttle count
      .mockResolvedValueOnce([]); // contact lookup: none

    const res = (await requestOtp(req({ body: { email: 'nobody@nowhere.test' } }), {} as never)) as Res;

    expect(res.status).toBe(200);
    expect(res.jsonBody?.message).toMatch(/if that email is registered/i);
    // Critical: no OTP row created for an unknown email.
    expect(ranSql(/INSERT INTO customer_otp/i)).toBe(false);
  });

  it('produces identical message bytes for known and unknown emails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryMock
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ id: 70, customer_id: 7, email: 'buyer@acme.test', name: 'B', portal_enabled: 1 }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const known = (await requestOtp(req({ body: { email: 'buyer@acme.test' } }), {} as never)) as Res;

    queryMock.mockReset();
    queryMock.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const unknown = (await requestOtp(req({ body: { email: 'x@y.test' } }), {} as never)) as Res;

    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.jsonBody)).toBe(JSON.stringify(unknown.jsonBody));
    logSpy.mockRestore();
  });

  it('throttles once the per-email window limit is reached (no new code)', async () => {
    queryMock
      .mockResolvedValueOnce([{ n: 5 }]) // at the limit
      .mockResolvedValueOnce({}); // writeAudit (otp_throttled)

    const res = (await requestOtp(req({ body: { email: 'buyer@acme.test' } }), {} as never)) as Res;

    expect(res.status).toBe(200);
    expect(ranSql(/INSERT INTO customer_otp/i)).toBe(false); // throttled: no code issued
  });
});

// ---------------------------------------------------------------------------
// verify-otp — login, rejection, single-use, rate limiting
// ---------------------------------------------------------------------------

describe('POST /portal/verify-otp', () => {
  it('valid code logs in and issues a customer-scoped token', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, contact_id: 70, customer_id: 7, code_hash: hashOtp('123456'), attempts: 0 }]) // OTP lookup
      .mockResolvedValueOnce({}) // UPDATE consumed_at
      .mockResolvedValueOnce({}) // UPDATE last_portal_login_at
      .mockResolvedValueOnce([{ id: 7, name: 'Acme Corp' }]) // customer
      .mockResolvedValueOnce({}); // writeAudit

    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test', code: '123456' } }), {} as never)) as Res;

    expect(res.status).toBe(200);
    const token = res.jsonBody?.token as string;
    expect(token).toBeTruthy();
    const payload = verifyCustomerToken(token);
    expect(payload?.cid).toBe(7); // scoped to the right customer
    expect(payload?.sub).toBe(70);
    expect(ranSql(/UPDATE customer_otp SET consumed_at = NOW\(\)/i)).toBe(true); // single-use burn
  });

  it('wrong code is rejected generically and increments the attempt counter', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, contact_id: 70, customer_id: 7, code_hash: hashOtp('123456'), attempts: 0 }])
      .mockResolvedValueOnce({}) // UPDATE attempts
      .mockResolvedValueOnce({}); // writeAudit

    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test', code: '000000' } }), {} as never)) as Res;

    expect(res.status).toBe(401);
    expect(res.jsonBody?.error?.code).toBe('INVALID_CODE');
    expect(res.jsonBody?.token).toBeUndefined();
    expect(ranSql(/UPDATE customer_otp SET attempts = \?/i)).toBe(true);
  });

  it('expired or non-existent code is rejected (same generic error)', async () => {
    queryMock.mockResolvedValueOnce([]); // lookup filters out expired/consumed -> none
    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test', code: '123456' } }), {} as never)) as Res;
    expect(res.status).toBe(401);
    expect(res.jsonBody?.error?.code).toBe('INVALID_CODE');
  });

  it('a reused (already-consumed) code is rejected — single use', async () => {
    // Once consumed, the WHERE consumed_at IS NULL filter returns no row.
    queryMock.mockResolvedValueOnce([]);
    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test', code: '123456' } }), {} as never)) as Res;
    expect(res.status).toBe(401);
    expect(res.jsonBody?.error?.code).toBe('INVALID_CODE');
  });

  it('locks the code after too many attempts (rate limiting)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, contact_id: 70, customer_id: 7, code_hash: hashOtp('123456'), attempts: 5 }]) // already at cap
      .mockResolvedValueOnce({}) // UPDATE consumed_at (lock)
      .mockResolvedValueOnce({}); // writeAudit

    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test', code: '123456' } }), {} as never)) as Res;

    expect(res.status).toBe(429);
    expect(res.jsonBody?.error?.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('rejects missing email or code with 400', async () => {
    const res = (await verifyOtp(req({ body: { email: 'buyer@acme.test' } }), {} as never)) as Res;
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Data scoping — a customer sees ONLY their own data
// ---------------------------------------------------------------------------

describe('customer data endpoints are scoped to the token customer_id', () => {
  it('contracts query filters by the token customer_id (7), not client input', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, contract_no: 'CTR-1', start_date: '2026-01-01', end_date: '2027-01-01', monthly_lease_fee: '100.00', sla_tier: 'GOLD', status: 'ACTIVE' }]);
    const res = (await portalContracts(req({ token: customerToken(7), query: { customerId: '9' } }), {} as never)) as Res;
    expect(res.status).toBe(200);
    expect(ranSql(/FROM contracts WHERE customer_id = \?/i)).toBe(true);
    // The scope param is 7 (from token) — never 9 (attacker-supplied query string).
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
  });

  it('printers query joins through the customer\'s own contracts', async () => {
    queryMock.mockResolvedValueOnce([]);
    await portalPrinters(req({ token: customerToken(7) }), {} as never);
    expect(ranSql(/JOIN contracts ct ON ct.id = p.current_contract_id WHERE ct.customer_id = \?/i)).toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
  });

  it('tickets query filters by the token customer_id', async () => {
    queryMock.mockResolvedValueOnce([]);
    await portalTickets(req({ token: customerToken(7) }), {} as never);
    expect(ranSql(/FROM service_tickets WHERE customer_id = \?/i)).toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
  });

  it('a token for customer 7 can never produce a query scoped to customer 9', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, name: 'Acme', email: null, phone: null }]);
    await portalMe(req({ token: customerToken(7) }), {} as never);
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
    expect(queryMock.mock.calls[0][1]).not.toContain(9);
  });
});

// ---------------------------------------------------------------------------
// Token separation — staff vs customer are not interchangeable
// ---------------------------------------------------------------------------

describe('staff and customer tokens are not interchangeable', () => {
  it('rejects a STAFF token on a portal endpoint (401, no query)', async () => {
    const res = (await portalContracts(req({ token: staffToken() }), {} as never)) as Res;
    expect(res.status).toBe(401);
    expect(res.jsonBody?.error?.code).toBe('UNAUTHENTICATED');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a CUSTOMER token on a staff endpoint (401, no query)', async () => {
    const res = (await listTickets(req({ token: customerToken(7) }), {} as never)) as Res;
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request to a portal endpoint', async () => {
    const res = (await portalTickets(req({}), {} as never)) as Res;
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('verifyToken rejects a customer token and verifyCustomerToken rejects a staff token', () => {
    expect(verifyToken(customerToken(7))).toBeNull();
    expect(verifyCustomerToken(staffToken())).toBeNull();
    // ...and each accepts its own kind.
    expect(verifyCustomerToken(customerToken(7))?.cid).toBe(7);
    expect(verifyToken(staffToken())?.role).toBe('SYSTEM_ADMIN');
  });

  it('a customer token carries no staff permissions', () => {
    const payload = verifyCustomerToken(customerToken(7)) as unknown as Record<string, unknown>;
    expect(payload.perms).toBeUndefined();
    expect(payload.role).toBeUndefined();
  });
});

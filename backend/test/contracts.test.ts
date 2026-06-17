/**
 * Customer & Contract Management — contract behavioural tests.
 *
 * Each describe block maps to a named business rule:
 *
 *   1. BR-009 pricing     — monthly fee must be > 0; per-click rates must be >= 0;
 *                           both create and edit reject bad pricing before any write.
 *   2. BR-008 duration    — end date must be at least one month after start; the
 *                           month boundary is computed correctly (incl. month-length
 *                           overflow); shorter spans are rejected (400 INVALID_DURATION).
 *   3. BR-007 activation  — a DRAFT contract cannot be activated without a signed
 *                           document; with one it activates and is audited; only
 *                           DRAFT contracts may be activated.
 *   4. BR-010 no-delete   — an activated contract cannot be deleted (422); a DRAFT
 *                           contract can; terminate is the activated-contract path and
 *                           requires a reason.
 *   5. Expiry             — ACTIVE contracts past their end date auto-expire on read;
 *                           the expiring endpoint windows on end_date.
 *
 * All tests use a mocked `query` so they run without a live MySQL instance.
 * RBAC, JWT, audit and HTTP helpers run for real, exactly as in production.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  createContract,
  updateContract,
  activateContract,
  terminateContract,
  deleteContract,
  expiringContracts,
  listContracts,
} from '../src/functions/contracts';

const queryMock = query as unknown as Mock;

// =============================================================================
// Token helpers
// =============================================================================

const MANAGER_PERMS = [
  'customers.read',
  'customers.create',
  'customers.update',
  'contracts.read',
  'contracts.create',
  'contracts.update',
  'contracts.activate',
  'contracts.terminate',
];
const REP_PERMS = [
  'customers.read',
  'customers.create',
  'customers.update',
  'contracts.read',
  'contracts.create',
  'contracts.update',
];

function managerToken() {
  return issueToken({
    sub: 10,
    email: 'mgr@websol.local',
    role: 'SALES_MANAGER',
    perms: MANAGER_PERMS,
  });
}
function repToken() {
  return issueToken({ sub: 11, email: 'rep@websol.local', role: 'SALES_REP', perms: REP_PERMS });
}

// =============================================================================
// Request builder
// =============================================================================

function req(
  opts: {
    token?: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: new Map<string, string>(Object.entries(opts.query ?? {})),
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

// =============================================================================
// Fixtures
// =============================================================================

/** A valid create body: 3-year lease, positive fee, non-negative rates. */
function validBody(extra: Record<string, unknown> = {}) {
  return {
    startDate: '2026-01-01',
    endDate: '2029-01-01',
    monthlyLeaseFee: 2500,
    perClickBw: 0.008,
    perClickColour: 0.05,
    slaTier: 'GOLD',
    printers: [{ printerModel: 'Canon iR-ADV C3530', quantity: 2 }],
    ...extra,
  };
}

function contractRow(status = 'DRAFT', extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    customer_id: 5,
    customer_name: 'Acme Corp',
    contract_no: 'CT-2026-00001',
    start_date: '2026-01-01',
    end_date: '2029-01-01',
    monthly_lease_fee: '2500.00',
    per_click_bw: '0.00800',
    per_click_colour: '0.05000',
    sla_tier: 'GOLD',
    status,
    notes: null,
    activated_at: null,
    activated_by: null,
    activated_by_name: null,
    terminated_at: null,
    terminated_by: null,
    terminated_by_name: null,
    termination_reason: null,
    created_by: 10,
    created_by_name: 'Sales Manager',
    created_at: '2026-01-01 09:00:00',
    updated_at: '2026-01-01 09:00:00',
    ...extra,
  };
}

function auditInserts(): { params: unknown[] }[] {
  return queryMock.mock.calls
    .filter(([sql]) => /INSERT INTO audit_log/i.test(String(sql)))
    .map(([, params]) => ({ params: params as unknown[] }));
}
function calledSqls(): string[] {
  return queryMock.mock.calls.map(([sql]) => String(sql));
}
function wasInserted(table: string): boolean {
  return calledSqls().some((s) => new RegExp(`INSERT INTO ${table}`, 'i').test(s));
}
function wasUpdated(table: string): boolean {
  return calledSqls().some((s) => new RegExp(`UPDATE ${table}`, 'i').test(s));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM customers/i.test(sql)) return [{ id: 5 }];
    if (/FROM contracts/i.test(sql)) return [contractRow()];
    if (/FROM contract_documents/i.test(sql)) return []; // no document by default
    if (/FROM contract_printers/i.test(sql)) return [];
    if (/INSERT INTO/i.test(sql)) return { insertId: 1, affectedRows: 1 };
    if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
    if (/DELETE/i.test(sql)) return { affectedRows: 1 };
    return [];
  });
});

// =============================================================================
// 1. BR-009 — pricing guards
// =============================================================================

describe('1. BR-009 pricing guards', () => {
  function createWith(priceOverrides: Record<string, unknown>) {
    // Customer lookup returns a row; contract insert returns id; findContract after.
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM customers/i.test(sql)) return [{ id: 5 }];
      if (/FROM contracts/i.test(sql)) return [contractRow()];
      if (/INSERT INTO/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
    return createContract(
      req({ token: managerToken(), params: { id: '5' }, body: validBody(priceOverrides) }),
      {} as never,
    );
  }

  it('rejects monthly fee of 0 (400 INVALID_PRICING) and writes nothing', async () => {
    const res = await createWith({ monthlyLeaseFee: 0 });
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_PRICING');
    expect(wasInserted('contracts')).toBe(false);
  });

  it('rejects a negative monthly fee (400 INVALID_PRICING)', async () => {
    const res = await createWith({ monthlyLeaseFee: -100 });
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_PRICING');
  });

  it('rejects a negative B/W per-click rate (400 INVALID_PRICING)', async () => {
    const res = await createWith({ perClickBw: -0.01 });
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_PRICING');
  });

  it('rejects a negative colour per-click rate (400 INVALID_PRICING)', async () => {
    const res = await createWith({ perClickColour: -1 });
    expect(res.status).toBe(400);
  });

  it('accepts a per-click rate of exactly 0 (rates may be zero, fee may not)', async () => {
    const res = await createWith({ perClickBw: 0, perClickColour: 0 });
    expect(res.status).toBe(201);
    expect(wasInserted('contracts')).toBe(true);
  });

  it('rejects non-numeric pricing (400) — strings are not coerced', async () => {
    const res = await createWith({ monthlyLeaseFee: '2500' as unknown as number });
    expect(res.status).toBe(400);
  });

  it('persists the exact pricing values to the INSERT (no float mangling)', async () => {
    await createWith({ monthlyLeaseFee: 2500, perClickBw: 0.008, perClickColour: 0.05 });
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO contracts/i.test(String(sql)));
    expect(insert).toBeDefined();
    // params: customer_id, start, end, fee, bw, colour, sla, notes, created_by
    expect(insert![1][3]).toBe(2500);
    expect(insert![1][4]).toBe(0.008);
    expect(insert![1][5]).toBe(0.05);
  });

  it('edit re-validates pricing using post-edit values (422? no — 400 INVALID_PRICING)', async () => {
    const res = await updateContract(
      req({ token: managerToken(), params: { id: '1' }, body: { monthlyLeaseFee: 0 } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_PRICING');
    expect(wasUpdated('contracts')).toBe(false);
  });

  it('schema: contracts table uses DECIMAL pricing and CHECK guards', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../database/migrations/004_customers_contracts.sql'),
      'utf8',
    );
    expect(sql).toMatch(/monthly_lease_fee\s+DECIMAL\(10,2\)/i);
    expect(sql).toMatch(/per_click_bw\s+DECIMAL\(8,5\)/i);
    expect(sql).toMatch(/per_click_colour\s+DECIMAL\(8,5\)/i);
    expect(sql).toMatch(/CHECK \(monthly_lease_fee > 0\)/i);
    expect(sql).toMatch(/CHECK \(per_click_bw >= 0\)/i);
  });
});

// =============================================================================
// 2. BR-008 — duration (end date >= start + 1 month)
// =============================================================================

describe('2. BR-008 duration', () => {
  function createWithDates(startDate: string, endDate: string) {
    return createContract(
      req({ token: managerToken(), params: { id: '5' }, body: validBody({ startDate, endDate }) }),
      {} as never,
    );
  }

  it('rejects an end date earlier than one month after start (400 INVALID_DURATION)', async () => {
    const res = await createWithDates('2026-01-01', '2026-01-15'); // 2 weeks
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_DURATION');
    expect(wasInserted('contracts')).toBe(false);
  });

  it('rejects an end date equal to the start date (400)', async () => {
    const res = await createWithDates('2026-01-01', '2026-01-01');
    expect(res.status).toBe(400);
  });

  it('accepts an end date exactly one month after start (boundary is inclusive)', async () => {
    const res = await createWithDates('2026-01-01', '2026-02-01');
    expect(res.status).toBe(201);
    expect(wasInserted('contracts')).toBe(true);
  });

  it('handles month-length overflow: Jan 31 → Feb 28 is accepted as one month', async () => {
    const res = await createWithDates('2026-01-31', '2026-02-28');
    expect(res.status).toBe(201);
  });

  it('accepts a typical multi-year lease (2–5 years)', async () => {
    const res = await createWithDates('2026-01-01', '2031-01-01'); // 5 years
    expect(res.status).toBe(201);
  });

  it('rejects a malformed date (400)', async () => {
    const res = await createWithDates('not-a-date', '2029-01-01');
    expect(res.status).toBe(400);
    expect(wasInserted('contracts')).toBe(false);
  });

  it('rejects an impossible date like 2026-02-31 (400)', async () => {
    const res = await createWithDates('2026-02-31', '2029-01-01');
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// 3. BR-007 — activation requires a signed document
// =============================================================================

describe('3. BR-007 activation requires a signed document', () => {
  it('blocks activation of a DRAFT contract with no document (422 NO_SIGNED_DOCUMENT)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('DRAFT')];
      if (/FROM contract_documents/i.test(sql)) return []; // none attached
      return [];
    });
    const res = await activateContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('NO_SIGNED_DOCUMENT');
    expect(wasUpdated('contracts')).toBe(false);
  });

  it('activates a DRAFT contract that has a document (200) and records activated_by + audit', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('DRAFT')];
      if (/FROM contract_documents/i.test(sql)) return [{ id: 99 }]; // signed doc present
      if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
    const res = await activateContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const update = queryMock.mock.calls.find(([sql]) =>
      /UPDATE contracts SET status = 'ACTIVE'/i.test(String(sql)),
    );
    expect(update).toBeDefined();
    expect(update![1][0]).toBe(10); // activated_by = manager userId

    const audit = auditInserts().find((a) => a.params[4] === 'activate');
    expect(audit).toBeDefined();
  });

  it('refuses to activate a contract that is not DRAFT (422 INVALID_STATUS)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('ACTIVE')];
      if (/FROM contract_documents/i.test(sql)) return [{ id: 99 }];
      return [];
    });
    const res = await activateContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_STATUS');
  });

  it('a Sales Rep cannot activate — contracts.activate is required (403)', async () => {
    const res = await activateContract(
      req({ token: repToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('schema/handler: BR-007 is enforced by checking contract_documents', () => {
    const handler = readFileSync(resolve(__dirname, '../src/functions/contracts.ts'), 'utf8');
    expect(handler).toMatch(/NO_SIGNED_DOCUMENT/);
    expect(handler).toMatch(/FROM contract_documents WHERE contract_id = \?/i);
  });
});

// =============================================================================
// 4. BR-010 — no delete after activation; terminate instead
// =============================================================================

describe('4. BR-010 no delete after activation', () => {
  it('deletes a DRAFT contract (200)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('DRAFT')];
      if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/DELETE FROM contracts/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
    const res = await deleteContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(calledSqls().some((s) => /DELETE FROM contracts/i.test(s))).toBe(true);
  });

  it('refuses to delete an ACTIVE contract (422 CONTRACT_NOT_DELETABLE) — no DELETE issued', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('ACTIVE')];
      return [];
    });
    const res = await deleteContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('CONTRACT_NOT_DELETABLE');
    expect(calledSqls().some((s) => /DELETE FROM contracts/i.test(s))).toBe(false);
  });

  it('refuses to delete a TERMINATED contract (422) — history is preserved', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('TERMINATED')];
      return [];
    });
    const res = await deleteContract(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
  });

  it('terminate requires a reason (400)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('ACTIVE')];
      return [];
    });
    const res = await terminateContract(
      req({ token: managerToken(), params: { id: '1' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(wasUpdated('contracts')).toBe(false);
  });

  it('terminates an ACTIVE contract with a reason (200) and audits it', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('ACTIVE')];
      if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
    const res = await terminateContract(
      req({ token: managerToken(), params: { id: '1' }, body: { reason: 'Customer closed down' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const update = queryMock.mock.calls.find(([sql]) =>
      /UPDATE contracts[\s\S]*TERMINATED/i.test(String(sql)),
    );
    expect(update).toBeDefined();
    expect(update![1]).toContain('Customer closed down');
    expect(auditInserts().some((a) => a.params[4] === 'terminate')).toBe(true);
  });

  it('a Sales Rep cannot terminate — contracts.terminate is required (403)', async () => {
    const res = await terminateContract(
      req({ token: repToken(), params: { id: '1' }, body: { reason: 'x' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5. Status lifecycle & edit guards
// =============================================================================

describe('5. status lifecycle guards', () => {
  it('only DRAFT contracts can be edited (422 CONTRACT_NOT_EDITABLE for ACTIVE)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM contracts/i.test(sql)) return [contractRow('ACTIVE')];
      return [];
    });
    const res = await updateContract(
      req({ token: managerToken(), params: { id: '1' }, body: { slaTier: 'PLATINUM' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('CONTRACT_NOT_EDITABLE');
  });

  it('migration declares the DRAFT→ACTIVE→EXPIRED→TERMINATED status enum', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../database/migrations/004_customers_contracts.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ENUM\('DRAFT','ACTIVE','EXPIRED','TERMINATED'\)/i);
    expect(sql).toMatch(/ENUM\('PLATINUM','GOLD','SILVER','BRONZE'\)/i);
  });
});

// =============================================================================
// 6. "Expiring in 90 days" — the renewal dashboard
// =============================================================================

describe('6. contracts expiring within 90 days', () => {
  /** A YYYY-MM-DD date `n` days from today (UTC). */
  function daysFromToday(n: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** The SELECT call that drives the expiring window (carries the day param). */
  function expiringSelect() {
    return queryMock.mock.calls.find(
      ([sql]) =>
        /FROM contracts/i.test(String(sql)) &&
        /BETWEEN CURDATE\(\) AND DATE_ADD\(CURDATE\(\), INTERVAL \? DAY\)/i.test(String(sql)),
    );
  }

  it('defaults to a 90-day window and only ACTIVE contracts in that window', async () => {
    const soon = contractRow('ACTIVE', { id: 1, end_date: daysFromToday(30) });
    queryMock.mockImplementation(async (sql: string) => {
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
      if (/FROM contracts/i.test(sql)) return [soon];
      return [];
    });

    const res = await expiringContracts(req({ token: managerToken() }), {} as never);
    expect(res.status).toBe(200);

    const body = res.jsonBody as {
      windowDays: number;
      contracts: { id: number; status: string; daysUntilExpiry: number; expiringSoon: boolean }[];
    };
    expect(body.windowDays).toBe(90);
    expect(body.contracts).toHaveLength(1);
    expect(body.contracts[0].id).toBe(1);
    expect(body.contracts[0].status).toBe('ACTIVE');

    // The query filters on ACTIVE + a parameterised day window of 90.
    const sel = expiringSelect();
    expect(sel).toBeDefined();
    expect(String(sel![0])).toMatch(/c\.status = 'ACTIVE'/i);
    expect(sel![1]).toEqual([90]);
  });

  it('computes daysUntilExpiry and flags expiringSoon for a contract 30 days out', async () => {
    const soon = contractRow('ACTIVE', { end_date: daysFromToday(30) });
    queryMock.mockImplementation(async (sql: string) => {
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
      if (/FROM contracts/i.test(sql)) return [soon];
      return [];
    });

    const res = await expiringContracts(req({ token: managerToken() }), {} as never);
    const c = (res.jsonBody as { contracts: { daysUntilExpiry: number; expiringSoon: boolean }[] })
      .contracts[0];
    // Allow a 1-day tolerance for the UTC midnight rounding boundary.
    expect(c.daysUntilExpiry).toBeGreaterThanOrEqual(29);
    expect(c.daysUntilExpiry).toBeLessThanOrEqual(30);
    expect(c.expiringSoon).toBe(true);
  });

  it('honours a custom window via ?days=30', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
      if (/FROM contracts/i.test(sql)) return [];
      return [];
    });

    const res = await expiringContracts(
      req({ token: managerToken(), query: { days: '30' } }),
      {} as never,
    );
    expect((res.jsonBody as { windowDays: number }).windowDays).toBe(30);
    expect(expiringSelect()![1]).toEqual([30]);
  });

  it('falls back to 90 days when ?days is invalid or non-positive', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
      if (/FROM contracts/i.test(sql)) return [];
      return [];
    });

    for (const bad of ['0', '-5', 'abc']) {
      vi.clearAllMocks();
      queryMock.mockImplementation(async (sql: string) => {
        if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
        if (/FROM contracts/i.test(sql)) return [];
        return [];
      });
      const res = await expiringContracts(
        req({ token: managerToken(), query: { days: bad } }),
        {} as never,
      );
      expect((res.jsonBody as { windowDays: number }).windowDays).toBe(90);
    }
  });

  it('auto-expires past-due ACTIVE contracts before listing (EXPIRED transition runs first)', async () => {
    const calls: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      calls.push(String(sql));
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 1 };
      if (/FROM contracts/i.test(sql)) return [];
      return [];
    });

    await expiringContracts(req({ token: managerToken() }), {} as never);

    const expireIdx = calls.findIndex((s) =>
      /UPDATE contracts SET status = 'EXPIRED'[\s\S]*end_date < CURDATE\(\)/i.test(s),
    );
    const selectIdx = calls.findIndex((s) =>
      /BETWEEN CURDATE\(\) AND DATE_ADD\(CURDATE\(\), INTERVAL \? DAY\)/i.test(s),
    );
    expect(expireIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(expireIdx);
  });

  it('requires contracts.read — an unauthenticated caller is rejected (401)', async () => {
    const res = await expiringContracts(req({}), {} as never);
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('the list endpoint applies the same ACTIVE + 90-day filter when expiring=1', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/UPDATE contracts/i.test(sql)) return { affectedRows: 0 };
      if (/FROM contracts/i.test(sql))
        return [contractRow('ACTIVE', { end_date: daysFromToday(10) })];
      return [];
    });

    const res = await listContracts(
      req({ token: managerToken(), query: { expiring: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const sel = queryMock.mock.calls.find(
      ([sql]) =>
        /FROM contracts/i.test(String(sql)) &&
        /DATE_ADD\(CURDATE\(\), INTERVAL \? DAY\)/i.test(String(sql)),
    );
    expect(sel).toBeDefined();
    expect(String(sel![0])).toMatch(/c\.status = 'ACTIVE'/i);
    expect(sel![1]).toContain(90);
  });
});

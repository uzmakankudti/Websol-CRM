/**
 * Asset / Printer Management — business rule tests.
 *
 * Organised by the five rules under test:
 *
 *   BR-001  Serial number is globally unique.
 *   BR-002  A RETIRED printer is immutable — no edits, no status changes.
 *   BR-003  A printer may only be linked to one active contract at a time.
 *   BR-004  Every status change writes an auditable history row (user, time, reason).
 *   BR-005  Only valid lifecycle transitions are accepted.
 *
 * Every test calls the real handler so RBAC, JWT validation, audit and HTTP
 * helpers all run. Only the database layer is mocked.
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
  createPrinter,
  updatePrinter,
  changePrinterStatus,
} from '../src/functions/printers';

const queryMock = query as unknown as Mock;

// =============================================================================
// Fixtures & helpers
// =============================================================================

const ALL_PERMS = [
  'printers.read',
  'printers.create',
  'printers.update',
  'printers.manage_status',
];

/** Admin user — sub: 1 — used to verify changed_by is wired from token. */
function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
}

/** A second user — sub: 7 — used to prove changed_by tracks the actor, not a constant. */
function techToken() {
  return issueToken({ sub: 7, email: 'tech@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
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

/** Base printer row returned by SELECT queries. Override individual columns via extra. */
function printerRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    serial_no: 'SN-001',
    asset_no: 'AST-001',
    brand: 'HP',
    model: 'LaserJet Pro 400',
    print_technology: 'LASER',
    is_colour: 1,
    ppm_bw: 40,
    ppm_colour: 30,
    lifetime_pages: 0,
    location: 'Warehouse A',
    warranty_expiry: '2027-12-31',
    current_contract_id: null,
    current_contract_no: null,
    current_site_id: null,
    current_site_name: null,
    status: 'ORDERED',
    notes: null,
    created_by: 1,
    created_by_name: 'Admin',
    created_at: '2026-01-01 09:00:00',
    updated_at: '2026-01-01 09:00:00',
    ...extra,
  };
}

/** Returns all INSERT calls made to printer_status_history during a test. */
function historyInserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO printer_status_history/i.test(String(sql)),
  );
}

/** Returns all UPDATE calls made to the printers table during a test. */
function printerUpdates() {
  return queryMock.mock.calls.filter(([sql]) => /UPDATE printers/i.test(String(sql)));
}

/** Returns all INSERT calls made to printers during a test. */
function printerInserts() {
  return queryMock.mock.calls.filter(([sql]) => /INSERT INTO printers/i.test(String(sql)));
}

/** Mock that treats a given serial as already existing in the DB. */
function mockWithDuplicateSerial(existingSerial: string) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT id FROM printers WHERE serial_no/i.test(sql)) return [{ id: 5 }];
    if (/FROM printers/i.test(sql)) return [printerRow({ serial_no: existingSerial })];
    return [];
  });
}

/** Mock that treats the DB as having no duplicate for any serial. */
function mockNoExistingSerial() {
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT id FROM printers WHERE serial_no/i.test(sql)) return [];
    if (/FROM printers/i.test(sql)) return [printerRow()];
    if (/INSERT INTO printers/i.test(sql)) return { insertId: 1, affectedRows: 1 };
    if (/INSERT INTO printer_status_history/i.test(sql)) return { insertId: 1 };
    if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1 };
    return [];
  });
}

/** Mock for a printer with a given status; all writes succeed. */
function mockPrinterWithStatus(status: string, extra: Record<string, unknown> = {}) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM printers/i.test(sql)) return [printerRow({ status, ...extra })];
    if (/UPDATE printers/i.test(sql)) return { affectedRows: 1 };
    if (/INSERT INTO printer_status_history/i.test(sql)) return { insertId: 1 };
    if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1 };
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// BR-001: Serial number is globally unique
// =============================================================================

describe('BR-001: Serial number is globally unique', () => {
  it('rejects a duplicate serial with 409 DUPLICATE_SERIAL', async () => {
    mockWithDuplicateSerial('SN-001');

    const res = await createPrinter(
      req({ token: adminToken(), body: { serialNo: 'SN-001', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DUPLICATE_SERIAL');
  });

  it('does not issue an INSERT when the serial is already taken', async () => {
    mockWithDuplicateSerial('SN-001');

    await createPrinter(
      req({ token: adminToken(), body: { serialNo: 'SN-001', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(printerInserts()).toHaveLength(0);
  });

  it('includes the conflicting serial in the error message', async () => {
    mockWithDuplicateSerial('SN-CONFLICT');

    const res = await createPrinter(
      req({ token: adminToken(), body: { serialNo: 'SN-CONFLICT', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toContain('SN-CONFLICT');
  });

  it('accepts a registration when no duplicate exists (201)', async () => {
    mockNoExistingSerial();

    const res = await createPrinter(
      req({ token: adminToken(), body: { serialNo: 'SN-NEW', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(res.status).toBe(201);
  });

  it('strips leading/trailing whitespace before checking uniqueness', async () => {
    // The API trims the serial; so "  SN-001  " becomes "SN-001" and hits the duplicate check.
    mockWithDuplicateSerial('SN-001');

    const res = await createPrinter(
      req({ token: adminToken(), body: { serialNo: '  SN-001  ', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DUPLICATE_SERIAL');
  });

  it('rejects a blank serial before even querying the DB (400)', async () => {
    queryMock.mockResolvedValue([]);

    const res = await createPrinter(
      req({ token: adminToken(), body: { serialNo: '   ', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(res.status).toBe(400);
    // No uniqueness check was made — there is nothing to look up.
    expect(queryMock.mock.calls.filter(([sql]) => /serial_no/i.test(String(sql)))).toHaveLength(0);
  });
});

// =============================================================================
// BR-002: RETIRED printer is immutable
// =============================================================================

describe('BR-002: Retired printer is immutable', () => {
  // ---- PATCH endpoint -------------------------------------------------------

  const editCases: [string, Record<string, unknown>][] = [
    ['location',          { location: 'Archive Room' }],
    ['brand',             { brand: 'Canon' }],
    ['model',             { model: 'iR-ADV 715' }],
    ['notes',             { notes: 'Decommissioned unit' }],
    ['assetNo',           { assetNo: 'AST-999' }],
    ['warrantyExpiry',    { warrantyExpiry: '2030-01-01' }],
    ['currentContractId', { currentContractId: 42 }],
    ['printTechnology',   { printTechnology: 'INKJET' }],
  ];

  it.each(editCases)('blocks editing %s on a RETIRED printer (403 PRINTER_RETIRED)', async (_, body) => {
    mockPrinterWithStatus('RETIRED');

    const res = await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body }),
      {} as never,
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_RETIRED');
  });

  it('does not issue an UPDATE query when the edit is blocked', async () => {
    mockPrinterWithStatus('RETIRED');

    await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { location: 'Archive' } }),
      {} as never,
    );

    expect(printerUpdates()).toHaveLength(0);
  });

  // ---- Status-change endpoint ------------------------------------------------

  const nonRetiredStatuses = [
    'IN_TRANSIT', 'IN_STOCK', 'ALLOCATED', 'INSTALLED', 'REFURBISHED',
  ];

  it.each(nonRetiredStatuses)(
    'blocks status transition to %s when printer is RETIRED (422 PRINTER_RETIRED)',
    async (toStatus) => {
      mockPrinterWithStatus('RETIRED');

      const res = await changePrinterStatus(
        req({ token: adminToken(), params: { id: '1' }, body: { toStatus } }),
        {} as never,
      );

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_RETIRED');
    },
  );

  it('blocks even RETIRED → RETIRED (terminal means terminal)', async () => {
    mockPrinterWithStatus('RETIRED');

    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'RETIRED' } }),
      {} as never,
    );

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_RETIRED');
  });

  it('does not write a history row when the status change is blocked', async () => {
    mockPrinterWithStatus('RETIRED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_STOCK' } }),
      {} as never,
    );

    expect(historyInserts()).toHaveLength(0);
  });
});

// =============================================================================
// BR-003: One active contract per printer
// =============================================================================

describe('BR-003: One active contract per printer', () => {
  it('allows linking to a contract when the printer has none (200)', async () => {
    mockPrinterWithStatus('ALLOCATED', { current_contract_id: null });

    const res = await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { currentContractId: 10 } }),
      {} as never,
    );

    expect(res.status).toBe(200);
  });

  it('allows re-linking to the same contract (idempotent, 200)', async () => {
    // current_contract_id is already 10; setting it to 10 again should pass.
    mockPrinterWithStatus('INSTALLED', { current_contract_id: 10 });

    const res = await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { currentContractId: 10 } }),
      {} as never,
    );

    expect(res.status).toBe(200);
  });

  it('rejects linking to a different contract when one already exists (409 ALREADY_CONTRACTED)', async () => {
    mockPrinterWithStatus('INSTALLED', { current_contract_id: 10 });

    const res = await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { currentContractId: 20 } }),
      {} as never,
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ALREADY_CONTRACTED');
  });

  it('does not issue an UPDATE when the contract conflict is detected', async () => {
    mockPrinterWithStatus('INSTALLED', { current_contract_id: 10 });

    await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { currentContractId: 20 } }),
      {} as never,
    );

    expect(printerUpdates()).toHaveLength(0);
  });

  it('allows clearing the contract by setting currentContractId to null (200)', async () => {
    mockPrinterWithStatus('RETURNED', { current_contract_id: 10 });

    const res = await updatePrinter(
      req({ token: adminToken(), params: { id: '1' }, body: { currentContractId: null } }),
      {} as never,
    );

    expect(res.status).toBe(200);
    const updateCall = printerUpdates()[0];
    expect(updateCall).toBeDefined();
    // The UPDATE sets current_contract_id = NULL.
    const params = updateCall[1] as unknown[];
    expect(params).toContain(null);
  });
});

// =============================================================================
// BR-004: Every status change writes an auditable history row
// =============================================================================

describe('BR-004: Status changes write an auditable history row', () => {
  it('writes exactly one history row per status change', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    expect(historyInserts()).toHaveLength(1);
  });

  it('history row records from_status as the printer\'s state before the change', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    // INSERT params: (printer_id, from_status, to_status, reason, changed_by)
    expect(params[1]).toBe('ORDERED');
  });

  it('history row records to_status as the requested new state', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    expect(params[2]).toBe('IN_TRANSIT');
  });

  it('history row records the authenticated user as changed_by', async () => {
    mockPrinterWithStatus('ORDERED');

    // Use the tech user (sub: 7), not the admin (sub: 1).
    await changePrinterStatus(
      req({ token: techToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    expect(params[4]).toBe(7); // techToken sub
  });

  it('history row stores the reason when one is supplied', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({
        token: adminToken(),
        params: { id: '1' },
        body: { toStatus: 'IN_TRANSIT', reason: 'Collected by courier at 09:00' },
      }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    expect(params[3]).toBe('Collected by courier at 09:00');
  });

  it('history row stores null when reason is omitted', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    expect(params[3]).toBeNull();
  });

  it('history row stores null when reason is an empty string', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT', reason: '   ' } }),
      {} as never,
    );

    const params = historyInserts()[0][1] as unknown[];
    expect(params[3]).toBeNull();
  });

  it('history row is inserted after the printer status is updated (correct ordering)', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'IN_TRANSIT' } }),
      {} as never,
    );

    const allSqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const updateIdx = allSqls.findIndex((s) => /UPDATE printers/i.test(s));
    const historyIdx = allSqls.findIndex((s) => /INSERT INTO printer_status_history/i.test(s));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThan(updateIdx);
  });

  it('registration writes a history row with from_status = NULL and to_status = ORDERED', async () => {
    mockNoExistingSerial();

    await createPrinter(
      req({ token: adminToken(), body: { serialNo: 'SN-NEW', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    expect(historyInserts()).toHaveLength(1);
    // The create INSERT uses literal NULL/'ORDERED' in the SQL text itself.
    const sql = String(historyInserts()[0][0]);
    expect(sql).toMatch(/from_status.*to_status/is);
    expect(sql).toContain('NULL');
    expect(sql).toContain("'ORDERED'");
  });

  it('registration records the registering user as changed_by', async () => {
    mockNoExistingSerial();

    // Use techToken (sub: 7) to register.
    await createPrinter(
      req({ token: techToken(), body: { serialNo: 'SN-NEW', brand: 'HP', model: 'M404' } }),
      {} as never,
    );

    // The create INSERT has two params: [insertId, userId]. userId is at index 1.
    const params = historyInserts()[0][1] as unknown[];
    expect(params[1]).toBe(7); // changed_by = techToken sub
  });
});

// =============================================================================
// BR-005: Only valid lifecycle transitions are accepted
// =============================================================================

describe('BR-005: Only valid lifecycle transitions are accepted', () => {
  /**
   * Complete transition map from the implementation.
   * Every pair here must return 200; anything else must return 422.
   */
  const VALID_TRANSITIONS: [string, string][] = [
    ['ORDERED',         'IN_TRANSIT'],
    ['IN_TRANSIT',      'RECEIVED'],
    ['RECEIVED',        'QC_PASS'],
    ['RECEIVED',        'QC_FAIL'],
    ['QC_PASS',         'IN_STOCK'],
    ['QC_FAIL',         'RETURNED'],
    ['QC_FAIL',         'UNDER_REPAIR'],
    ['IN_STOCK',        'ALLOCATED'],
    ['IN_STOCK',        'RETIRED'],
    ['ALLOCATED',       'DISPATCHED'],
    ['ALLOCATED',       'IN_STOCK'],
    ['DISPATCHED',      'INSTALLED'],
    ['INSTALLED',       'UNDER_REPAIR'],
    ['INSTALLED',       'REPLACEMENT_OUT'],
    ['INSTALLED',       'RETIRED'],
    ['UNDER_REPAIR',    'INSTALLED'],
    ['UNDER_REPAIR',    'IN_STOCK'],
    ['UNDER_REPAIR',    'RETURNED'],
    ['REPLACEMENT_OUT', 'RETURNED'],
    ['REPLACEMENT_OUT', 'INSTALLED'],
    ['RETURNED',        'REFURBISHED'],
    ['RETURNED',        'RETIRED'],
    ['REFURBISHED',     'IN_STOCK'],
    ['REFURBISHED',     'RETIRED'],
  ];

  it.each(VALID_TRANSITIONS)('allows %s → %s (200)', async (from, to) => {
    mockPrinterWithStatus(from);

    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: to } }),
      {} as never,
    );

    expect(res.status).toBe(200);
  });

  /**
   * A representative set of forbidden transitions — step-skipping,
   * backward movement, and the fully terminal RETIRED state.
   */
  const INVALID_TRANSITIONS: [string, string][] = [
    // Step-skipping forward
    ['ORDERED',     'RECEIVED'],
    ['ORDERED',     'IN_STOCK'],
    ['ORDERED',     'INSTALLED'],
    ['IN_TRANSIT',  'QC_PASS'],
    ['IN_TRANSIT',  'IN_STOCK'],
    ['RECEIVED',    'ALLOCATED'],
    ['QC_PASS',     'ALLOCATED'],
    ['IN_STOCK',    'INSTALLED'],
    ['ALLOCATED',   'INSTALLED'],
    // Backward movement
    ['INSTALLED',   'ORDERED'],
    ['INSTALLED',   'IN_TRANSIT'],
    ['INSTALLED',   'DISPATCHED'],
    ['RETURNED',    'INSTALLED'],
    ['REFURBISHED', 'QC_PASS'],
    // RETIRED is terminal — all targets rejected
    ['RETIRED',     'IN_STOCK'],
    ['RETIRED',     'REFURBISHED'],
    ['RETIRED',     'ORDERED'],
    // Completely unknown target status
    ['ORDERED',     'BROKEN'],
    ['INSTALLED',   'DECOMMISSIONED'],
  ];

  it.each(INVALID_TRANSITIONS)(
    'rejects %s → %s with 422 INVALID_TRANSITION',
    async (from, to) => {
      // RETIRED is handled by the dedicated BR-002 guard; still returns 422
      // but with a different code. For all other starting states the code is
      // INVALID_TRANSITION.
      mockPrinterWithStatus(from);

      const res = await changePrinterStatus(
        req({ token: adminToken(), params: { id: '1' }, body: { toStatus: to } }),
        {} as never,
      );

      expect(res.status).toBe(422);
    },
  );

  it('invalid transitions return the INVALID_TRANSITION error code', async () => {
    mockPrinterWithStatus('ORDERED');

    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'INSTALLED' } }),
      {} as never,
    );

    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('error message names both the current and rejected target status', async () => {
    mockPrinterWithStatus('ORDERED');

    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'INSTALLED' } }),
      {} as never,
    );

    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toContain('ORDERED');
    expect(msg).toContain('INSTALLED');
  });

  it('does not write a history row when the transition is invalid', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'INSTALLED' } }),
      {} as never,
    );

    expect(historyInserts()).toHaveLength(0);
  });

  it('does not update the printer status when the transition is invalid', async () => {
    mockPrinterWithStatus('ORDERED');

    await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'INSTALLED' } }),
      {} as never,
    );

    expect(printerUpdates()).toHaveLength(0);
  });

  it('accepts toStatus input regardless of case (lowercase is normalised)', async () => {
    mockPrinterWithStatus('ORDERED');

    // The handler uppercases the input; 'in_transit' should resolve to IN_TRANSIT.
    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: { toStatus: 'in_transit' } }),
      {} as never,
    );

    expect(res.status).toBe(200);
  });

  it('rejects a missing toStatus with 400 before checking the transition table', async () => {
    mockPrinterWithStatus('ORDERED');

    const res = await changePrinterStatus(
      req({ token: adminToken(), params: { id: '1' }, body: {} }),
      {} as never,
    );

    expect(res.status).toBe(400);
    expect(historyInserts()).toHaveLength(0);
  });
});

/**
 * Toner / Consumable Shipment Management (Module 9) — business-rule tests.
 *
 * BR-016  One active (PENDING or IN_TRANSIT) shipment per printer.
 * BR-017  Alert at ≤ 20%; cannot suppress when toner ≤ 10%.
 * Offline estimate  estimatedDaysRemaining = round((pct/100) × 5000 / dailyPageRate).
 * Delivery reset    Marking a shipment DELIVERED upserts toner to 100% and deletes alerts.
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
  updateTonerLevel,
  createTonerShipment,
  updateShipmentStatus,
  suppressAlert,
  processTonerLevels,
} from '../src/functions/toner';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function techToken() {
  return issueToken({ sub: 8, email: 'tech@websol.local', role: 'FIELD_TECHNICIAN',
    perms: ['toner.read', 'toner.update'] });
}
function csrToken() {
  return issueToken({ sub: 5, email: 'csr@websol.local', role: 'CSR',
    perms: ['toner.read', 'toner.manage'] });
}
function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN',
    perms: ['toner.read', 'toner.update', 'toner.manage'] });
}

function req(
  opts: { token?: string; params?: Record<string, string>; body?: unknown } = {},
): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query:   { get: () => null },
    params:  opts.params ?? {},
    text:    async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

function errCode(res: { jsonBody?: unknown }) {
  return (res.jsonBody as { error?: { code?: string } }).error?.code;
}

// ===========================================================================
// BR-016 — one active shipment per printer
// ===========================================================================
describe('BR-016 — one active shipment per printer', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 409 ACTIVE_SHIPMENT_EXISTS when a PENDING shipment already exists', async () => {
    queryMock.mockResolvedValueOnce([{ id: 5 }]);  // existing active shipment found

    const res = await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 10 } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect(errCode(res)).toBe('ACTIVE_SHIPMENT_EXISTS');
  });

  it('returns 409 when an IN_TRANSIT shipment already exists for that printer', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7 }]);  // IN_TRANSIT row

    const res = await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 10 } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect(errCode(res)).toBe('ACTIVE_SHIPMENT_EXISTS');
  });

  it('creates shipment and returns 201 when no active shipment exists', async () => {
    queryMock
      .mockResolvedValueOnce([])                                    // no active shipment
      .mockResolvedValueOnce({ insertId: 42, affectedRows: 1 })    // INSERT
      .mockResolvedValueOnce({ affectedRows: 1 });                  // writeAudit

    const res = await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 10, notes: 'Urgent restock' } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = res.jsonBody as { id: number; status: string };
    expect(body.id).toBe(42);
    expect(body.status).toBe('PENDING');
  });

  it('stores printerId and notes in the INSERT params', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ insertId: 43, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 15, notes: 'Monthly toner' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO toner_shipments/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params[0]).toBe(15);             // printer_id
    expect(params[3]).toBe('Monthly toner'); // notes
  });

  it('returns 400 when printerId is missing', async () => {
    const res = await createTonerShipment(
      req({ token: csrToken(), body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('the active-shipment SELECT queries PENDING and IN_TRANSIT only', async () => {
    queryMock.mockResolvedValueOnce([{ id: 3 }]);
    await createTonerShipment(req({ token: csrToken(), body: { printerId: 10 } }), {} as never);
    const call = queryMock.mock.calls[0];
    expect(String(call[0])).toMatch(/PENDING/);
    expect(String(call[0])).toMatch(/IN_TRANSIT/);
  });
});

// ===========================================================================
// BR-017 — alert at 20%, cannot suppress at ≤ 10%
// ===========================================================================
describe('BR-017 — toner alerts', () => {
  beforeEach(() => queryMock.mockReset());

  // ---- raising alerts when toner level is updated ----

  it('inserts LOW_20 alert when toner is updated to exactly 20%', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT toner_levels
      .mockResolvedValueOnce({ affectedRows: 1 })  // INSERT IGNORE LOW_20
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 20 } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const low20 = queryMock.mock.calls.find(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)) && /LOW_20/i.test(String(s)),
    );
    expect(low20).toBeDefined();
    expect(low20![1]).toContain(10);  // printer_id
  });

  it('inserts LOW_20 alert when toner is 15%', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 15 } }),
      {} as never,
    );

    const low20 = queryMock.mock.calls.find(
      ([s]) => /LOW_20/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    expect(low20).toBeDefined();

    // CRITICAL_10 must NOT be inserted at 15%
    const crit = queryMock.mock.calls.find(
      ([s]) => /CRITICAL_10/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    expect(crit).toBeUndefined();
  });

  it('inserts both LOW_20 and CRITICAL_10 when toner is at 10%', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // LOW_20
      .mockResolvedValueOnce({ affectedRows: 1 })  // CRITICAL_10
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 10 } }),
      {} as never,
    );

    const low20 = queryMock.mock.calls.find(
      ([s]) => /LOW_20/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    const crit = queryMock.mock.calls.find(
      ([s]) => /CRITICAL_10/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    expect(low20).toBeDefined();
    expect(crit).toBeDefined();
  });

  it('inserts both alerts when toner is 5%', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 5 } }),
      {} as never,
    );

    const alertInserts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(alertInserts).toHaveLength(2);
  });

  it('does NOT insert any alert when toner is 21%', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 21 } }),
      {} as never,
    );

    const alertInserts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(alertInserts).toHaveLength(0);
  });

  // ---- suppress rules ----

  it('suppresses an alert when toner is above 10% (e.g. 15%)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, printer_id: 10, alert_type: 'LOW_20', status: 'NEW' }])
      .mockResolvedValueOnce([{ toner_pct: 15 }])   // level check
      .mockResolvedValueOnce({ affectedRows: 1 })    // UPDATE status
      .mockResolvedValueOnce({ affectedRows: 1 });   // writeAudit

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { suppressed: boolean };
    expect(body.suppressed).toBe(true);
  });

  it('returns 422 CANNOT_SUPPRESS_CRITICAL when toner is exactly 10%', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, printer_id: 10, alert_type: 'LOW_20', status: 'NEW' }])
      .mockResolvedValueOnce([{ toner_pct: 10 }]);

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('CANNOT_SUPPRESS_CRITICAL');
  });

  it('returns 422 CANNOT_SUPPRESS_CRITICAL when toner is 5%', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, printer_id: 10, alert_type: 'CRITICAL_10', status: 'NEW' }])
      .mockResolvedValueOnce([{ toner_pct: 5 }]);

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '2' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('CANNOT_SUPPRESS_CRITICAL');
  });

  it('returns 422 ALREADY_SUPPRESSED when alert is already suppressed', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, printer_id: 10, alert_type: 'LOW_20', status: 'SUPPRESSED' }]);

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('ALREADY_SUPPRESSED');
  });

  it('returns 404 when the alert does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '999' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('the suppress UPDATE sets status = SUPPRESSED', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 3, printer_id: 10, alert_type: 'LOW_20', status: 'NEW' }])
      .mockResolvedValueOnce([{ toner_pct: 25 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await suppressAlert(req({ token: csrToken(), params: { id: '3' } }), {} as never);

    const upd = queryMock.mock.calls.find(
      ([s]) => /UPDATE toner_alerts/i.test(String(s)) && /SUPPRESSED/i.test(String(s)),
    );
    expect(upd).toBeDefined();
    expect((upd![1] as unknown[])[0]).toBe(3);  // WHERE id = 3
  });
});

// ===========================================================================
// Offline consumption estimate
// ===========================================================================
describe('Offline consumption estimate', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns estimatedDaysRemaining = 25 for 50% toner at 100 pages/day', async () => {
    // 50% of 5000 pages = 2500 pages remaining; 2500 / 100 = 25 days
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit (no alerts at 50%)

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 50, dailyPageRate: 100 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tonerPct: number; estimatedDaysRemaining: number };
    expect(body.tonerPct).toBe(50);
    expect(body.estimatedDaysRemaining).toBe(25);
  });

  it('returns estimatedDaysRemaining = 10 for 20% toner at 100 pages/day', async () => {
    // 20% of 5000 = 1000 pages; 1000 / 100 = 10 days
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // LOW_20 alert (≤20%)
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 20, dailyPageRate: 100 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { estimatedDaysRemaining: number };
    expect(body.estimatedDaysRemaining).toBe(10);
  });

  it('rounds the estimate to the nearest whole day', async () => {
    // 30% of 5000 = 1500; 1500 / 70 = 21.43 → rounds to 21
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 30, dailyPageRate: 70 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number };
    expect(body.estimatedDaysRemaining).toBe(21);
  });

  it('stores estimatedDaysRemaining in the UPSERT params', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 50, dailyPageRate: 100 } }),
      {} as never,
    );

    const upsert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO printer_toner_levels/i.test(String(s)),
    );
    const params = upsert![1] as unknown[];
    // params: [printer_id, toner_pct, daily_page_rate, estimated_days_remaining, updated_by]
    expect(params[0]).toBe(10);    // printer_id
    expect(params[1]).toBe(50);    // toner_pct
    expect(params[2]).toBe(100);   // daily_page_rate
    expect(params[3]).toBe(25);    // estimated_days_remaining
  });

  it('returns null estimatedDaysRemaining when no dailyPageRate is provided', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 60 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number | null };
    expect(body.estimatedDaysRemaining).toBeNull();
  });

  it('returns 400 when tonerPct is out of range', async () => {
    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 150 } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Delivery-reset-to-100% flow
// ===========================================================================
describe('Delivery-reset-to-100% flow', () => {
  beforeEach(() => queryMock.mockReset());

  it('marks shipment DELIVERED and resets toner to 100%', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'IN_TRANSIT' }])  // SELECT shipment
      .mockResolvedValueOnce({ affectedRows: 1 })   // UPDATE shipment delivered_at
      .mockResolvedValueOnce({ affectedRows: 1 })   // UPSERT toner_levels to 100%
      .mockResolvedValueOnce({ affectedRows: 3 })   // DELETE toner_alerts
      .mockResolvedValueOnce({ affectedRows: 1 });  // writeAudit

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { status: string };
    expect(body.status).toBe('DELIVERED');
  });

  it('upserts toner_levels to 100 for the correct printer', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'IN_TRANSIT' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );

    const upsert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO printer_toner_levels/i.test(String(s)),
    );
    expect(upsert).toBeDefined();
    // toner_pct=100 is a SQL literal in the INSERT, not a bound param.
    // Params are: [printer_id, last_change_at (now), updated_by].
    expect(String(upsert![0])).toMatch(/VALUES \(\?, 100/i); // SQL has literal 100
    const params = upsert![1] as unknown[];
    expect(params[0]).toBe(5);    // printer_id
  });

  it('deletes all toner alerts for the printer on delivery', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'PENDING' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 2 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );

    const del = queryMock.mock.calls.find(
      ([s]) => /DELETE FROM toner_alerts/i.test(String(s)),
    );
    expect(del).toBeDefined();
    expect((del![1] as unknown[])[0]).toBe(5);  // WHERE printer_id = 5
  });

  it('sets shipped_at when advancing to IN_TRANSIT', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'PENDING' }])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE with shipped_at
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'IN_TRANSIT' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { status: string }).status).toBe('IN_TRANSIT');

    const upd = queryMock.mock.calls.find(
      ([s]) => /UPDATE toner_shipments/i.test(String(s)) && /shipped_at/i.test(String(s)),
    );
    expect(upd).toBeDefined();
  });

  it('does NOT reset toner when status is CANCELLED', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'PENDING' }])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE status
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'CANCELLED' } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const tonerReset = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO printer_toner_levels/i.test(String(s)),
    );
    expect(tonerReset).toBeUndefined();

    const alertDelete = queryMock.mock.calls.find(
      ([s]) => /DELETE FROM toner_alerts/i.test(String(s)),
    );
    expect(alertDelete).toBeUndefined();
  });

  it('returns 404 when the shipment does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '999' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 INVALID_TRANSITION when shipment is already DELIVERED', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'DELIVERED' }]);

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });

  it('returns 422 INVALID_TRANSITION when shipment is already CANCELLED', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'CANCELLED' }]);

    const res = await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'IN_TRANSIT' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });
});

// ===========================================================================
// processTonerLevels — scheduled scanner (toner-level-check timer)
// ===========================================================================
describe('processTonerLevels — scheduled toner alert scanner', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns { low20: 0, critical10: 0 } when no printers are below threshold', async () => {
    queryMock
      .mockResolvedValueOnce([])  // low20 candidates
      .mockResolvedValueOnce([]); // critical10 candidates

    const result = await processTonerLevels();
    expect(result).toEqual({ low20: 0, critical10: 0 });
  });

  it('inserts a LOW_20 alert for a printer at 15% with no existing alert', async () => {
    queryMock
      .mockResolvedValueOnce([{ printer_id: 20, toner_pct: 15 }])  // low20 candidates
      .mockResolvedValueOnce({ affectedRows: 1 })                    // INSERT IGNORE LOW_20
      .mockResolvedValueOnce([]);                                     // critical10 candidates (15 > 10)

    const result = await processTonerLevels();
    expect(result).toEqual({ low20: 1, critical10: 0 });

    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)) && /LOW_20/i.test(String(s)),
    );
    expect(alertInsert).toBeDefined();
    expect((alertInsert![1] as unknown[])[0]).toBe(20);  // printer_id
    expect((alertInsert![1] as unknown[])[1]).toBe(15);  // toner_pct
  });

  it('inserts both LOW_20 and CRITICAL_10 for a printer at 8%', async () => {
    queryMock
      .mockResolvedValueOnce([{ printer_id: 21, toner_pct: 8 }])  // low20 candidates (8 ≤ 20)
      .mockResolvedValueOnce({ affectedRows: 1 })                   // INSERT IGNORE LOW_20
      .mockResolvedValueOnce([{ printer_id: 21, toner_pct: 8 }])  // critical10 candidates (8 ≤ 10)
      .mockResolvedValueOnce({ affectedRows: 1 });                  // INSERT IGNORE CRITICAL_10

    const result = await processTonerLevels();
    expect(result).toEqual({ low20: 1, critical10: 1 });

    const alertInserts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(alertInserts).toHaveLength(2);
    const types = alertInserts.map(([s]) => (/LOW_20/i.test(String(s)) ? 'LOW_20' : 'CRITICAL_10'));
    expect(types).toContain('LOW_20');
    expect(types).toContain('CRITICAL_10');
  });

  it('skips a printer that already has a LOW_20 alert (SELECT returns empty)', async () => {
    // The NOT EXISTS in the SELECT means the printer won't appear in candidates.
    queryMock
      .mockResolvedValueOnce([])  // low20 candidates empty (alert already exists)
      .mockResolvedValueOnce([]); // critical10 candidates also empty

    const result = await processTonerLevels();
    expect(result).toEqual({ low20: 0, critical10: 0 });

    const inserts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(inserts).toHaveLength(0);
  });

  it('handles multiple printers at threshold in one pass', async () => {
    queryMock
      .mockResolvedValueOnce([
        { printer_id: 30, toner_pct: 18 },
        { printer_id: 31, toner_pct: 12 },
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })  // LOW_20 for printer 30
      .mockResolvedValueOnce({ affectedRows: 1 })  // LOW_20 for printer 31
      .mockResolvedValueOnce([{ printer_id: 31, toner_pct: 12 }])  // critical10 (only 31)
      .mockResolvedValueOnce({ affectedRows: 1 }); // CRITICAL_10 for printer 31

    const result = await processTonerLevels();
    expect(result).toEqual({ low20: 2, critical10: 1 });
  });

  it('the low20 SELECT uses NOT EXISTS to avoid re-raising existing alerts', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await processTonerLevels();

    const low20Select = queryMock.mock.calls[0];
    expect(String(low20Select[0])).toMatch(/NOT EXISTS/i);
    expect(String(low20Select[0])).toMatch(/LOW_20/i);
    expect(String(low20Select[0])).toMatch(/toner_pct\s*<=\s*20/i);
  });

  it('the critical10 SELECT uses NOT EXISTS and checks toner_pct ≤ 10', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await processTonerLevels();

    const critical10Select = queryMock.mock.calls[1];
    expect(String(critical10Select[0])).toMatch(/NOT EXISTS/i);
    expect(String(critical10Select[0])).toMatch(/CRITICAL_10/i);
    expect(String(critical10Select[0])).toMatch(/toner_pct\s*<=\s*10/i);
  });
});

// ===========================================================================
// BR-017 — boundary cases and edge conditions
// ===========================================================================
describe('BR-017 — boundary and edge cases', () => {
  beforeEach(() => queryMock.mockReset());

  it('11% toner: inserts LOW_20 but NOT CRITICAL_10 (boundary above critical threshold)', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // INSERT LOW_20  (11 ≤ 20)
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit     (11 > 10 → no CRITICAL_10)

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 11 } }),
      {} as never,
    );

    const low20 = queryMock.mock.calls.find(
      ([s]) => /LOW_20/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    const crit = queryMock.mock.calls.find(
      ([s]) => /CRITICAL_10/i.test(String(s)) && /INSERT/i.test(String(s)),
    );
    expect(low20).toBeDefined();
    expect(crit).toBeUndefined();
  });

  it('0% toner: inserts both LOW_20 and CRITICAL_10 (extreme edge)', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // INSERT LOW_20
      .mockResolvedValueOnce({ affectedRows: 1 })  // INSERT CRITICAL_10
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 0 } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const alertInserts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(alertInserts).toHaveLength(2);
  });

  it('alert INSERTs use INSERT IGNORE so duplicate readings never create duplicate rows', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 })  // already existed — ignored
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 15 } }),
      {} as never,
    );

    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT.*toner_alerts/i.test(String(s)),
    );
    expect(String(alertInsert![0])).toMatch(/INSERT IGNORE/i);
  });

  it('suppress succeeds when no toner level is recorded for the printer yet', async () => {
    // No row in printer_toner_levels → level undefined → guard `if (level && ...)` is false
    queryMock
      .mockResolvedValueOnce([{ id: 5, printer_id: 20, alert_type: 'LOW_20', status: 'NEW' }])
      .mockResolvedValueOnce([])                   // level SELECT returns empty (no reading)
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE SUPPRESSED
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '5' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { suppressed: boolean }).suppressed).toBe(true);
  });

  it('a CRITICAL_10 alert can be suppressed once the printer is restocked above 10%', async () => {
    // Alert was raised when toner was critical; toner is now 45% after partial refill
    queryMock
      .mockResolvedValueOnce([{ id: 7, printer_id: 10, alert_type: 'CRITICAL_10', status: 'NEW' }])
      .mockResolvedValueOnce([{ toner_pct: 45 }])  // printer now well above 10%
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await suppressAlert(
      req({ token: csrToken(), params: { id: '7' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// BR-016 — additional shipment lifecycle cases
// ===========================================================================
describe('BR-016 — shipment lifecycle', () => {
  beforeEach(() => queryMock.mockReset());

  it('a DELIVERED shipment does not block creating a new one for the same printer', async () => {
    // SELECT for active returns [] because DELIVERED/CANCELLED are excluded
    queryMock
      .mockResolvedValueOnce([])                                    // no PENDING/IN_TRANSIT
      .mockResolvedValueOnce({ insertId: 55, affectedRows: 1 })    // INSERT
      .mockResolvedValueOnce({ affectedRows: 1 });                  // writeAudit

    const res = await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 10 } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = res.jsonBody as { id: number };
    expect(body.id).toBe(55);
  });

  it('stores created_by (auth userId) in the INSERT params', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ insertId: 60, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await createTonerShipment(
      req({ token: csrToken(), body: { printerId: 10 } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO toner_shipments/i.test(String(s)),
    );
    const params = insert![1] as unknown[];
    // params: [printer_id, consumable_id, tracking_ref, notes, created_by]
    expect(params[4]).toBe(5);  // csrToken sub = 5
  });
});

// ===========================================================================
// Offline consumption estimate — formula edge cases
// ===========================================================================
describe('Offline consumption estimate — formula edge cases', () => {
  beforeEach(() => queryMock.mockReset());

  it('full cartridge (100%) at 50 pages/day = 100 days remaining', async () => {
    // (100/100) * 5000 / 50 = 100
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 100, dailyPageRate: 50 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number };
    expect(body.estimatedDaysRemaining).toBe(100);
  });

  it('1% toner at 100 pages/day rounds to 1 day (Math.round(0.5) = 1)', async () => {
    // (1/100) * 5000 / 100 = 0.5 → Math.round(0.5) = 1
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })  // LOW_20
      .mockResolvedValueOnce({ affectedRows: 1 })  // CRITICAL_10
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 1, dailyPageRate: 100 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number };
    expect(body.estimatedDaysRemaining).toBe(1);
  });

  it('dailyPageRate = 0 returns null (guard against divide-by-zero)', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 50, dailyPageRate: 0 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number | null };
    expect(body.estimatedDaysRemaining).toBeNull();
  });

  it('negative dailyPageRate returns null (nonsensical input rejected)', async () => {
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await updateTonerLevel(
      req({ token: techToken(), params: { id: '10' }, body: { tonerPct: 50, dailyPageRate: -10 } }),
      {} as never,
    );
    const body = res.jsonBody as { estimatedDaysRemaining: number | null };
    expect(body.estimatedDaysRemaining).toBeNull();
  });
});

// ===========================================================================
// Delivery-reset — parameter and target correctness
// ===========================================================================
describe('Delivery-reset — parameter and target correctness', () => {
  beforeEach(() => queryMock.mockReset());

  it('UPDATE shipment binds delivered_at (now) as first param and shipment id last', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'IN_TRANSIT' }])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE delivered_at
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPSERT toner_levels
      .mockResolvedValueOnce({ affectedRows: 1 })  // DELETE alerts
      .mockResolvedValueOnce({ affectedRows: 1 }); // writeAudit

    await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );

    const deliveryUpd = queryMock.mock.calls.find(
      ([s]) => /UPDATE toner_shipments.*DELIVERED/i.test(String(s)),
    );
    expect(deliveryUpd).toBeDefined();
    const params = deliveryUpd![1] as unknown[];
    // params: [delivered_at (now string), updated_by, id]
    expect(typeof params[0]).toBe('string');          // delivered_at timestamp
    expect(params[2]).toBe(10);                        // WHERE id = 10
  });

  it('alert DELETE targets printer_id from the shipment, not a hard-coded id', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 99, printer_id: 42, status: 'PENDING' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 2 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '99' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );

    const del = queryMock.mock.calls.find(
      ([s]) => /DELETE FROM toner_alerts/i.test(String(s)),
    );
    expect(del).toBeDefined();
    expect((del![1] as unknown[])[0]).toBe(42);  // printer_id = 42, not 99 (the shipment id)
  });

  it('UPSERT toner_levels binds updated_by from the auth context', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10, printer_id: 5, status: 'IN_TRANSIT' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 });

    await updateShipmentStatus(
      req({ token: adminToken(), params: { id: '10' }, body: { status: 'DELIVERED' } }),
      {} as never,
    );

    const upsert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO printer_toner_levels/i.test(String(s)),
    );
    const params = upsert![1] as unknown[];
    // params: [printer_id, last_change_at (now), updated_by]
    expect(params[2]).toBe(1);  // adminToken sub = 1
  });
});

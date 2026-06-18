/**
 * Helpdesk (Module 8) — comprehensive business-rule tests.
 *
 * BR-013  SLA due = created + hours from contract.sla_tier (PLATINUM 2h, GOLD 4h,
 *         SILVER 8h, BRONZE 24h); falls back to priority when no contract.
 * BR-014  Closing a ticket requires a non-empty resolutionNotes regardless of method.
 * BR-015  A RESOLVED ticket may only be reopened within 48 h of last_resolved_at.
 * Auto-assign  autoAssign=true → least-busy FIELD_TECHNICIAN in site's region.
 *              Explicit assignedTo (CSR override) skips region lookup.
 *              Supervisor can reassign via assignTicket endpoint.
 * SLA breach   processSlaBreaches() inserts T_MINUS_1H / BREACH / DOUBLE_BREACH
 *              alerts and auto-escalates to CSR Supervisor / Ops Manager.
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
import { createTicket, closeTicket, assignTicket } from '../src/functions/field-service';
import { reopenTicket, processSlaBreaches } from '../src/functions/helpdesk';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_PERMS = [
  'service.read', 'service.create', 'service.assign', 'service.update',
  'service.close', 'service.escalate', 'service.resolve', 'service.reopen',
  'helpdesk.manage',
];

function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
}
function csrToken() {
  return issueToken({ sub: 5, email: 'csr@websol.local', role: 'CSR',
    perms: ['service.read', 'service.create', 'service.resolve', 'service.reopen'] });
}
function techToken() {
  return issueToken({ sub: 8, email: 'tech@websol.local', role: 'FIELD_TECHNICIAN',
    perms: ['service.read', 'service.update', 'service.close', 'service.escalate', 'service.resolve'] });
}
function supervisorToken() {
  return issueToken({ sub: 3, email: 'sup@websol.local', role: 'CSR_SUPERVISOR',
    perms: ['service.read', 'service.create', 'service.assign', 'service.resolve', 'service.reopen', 'helpdesk.manage'] });
}

function req(
  opts: { token?: string; params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  const qmap = new Map<string, string>(Object.entries(opts.query ?? {}));
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => qmap.get(k) ?? null },
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

function ticketRow(extra: Record<string, unknown> = {}) {
  return {
    id: 100, ticket_no: 'SVC-2026-0001', visit_type: 'CORRECTIVE', priority: 'HIGH',
    status: 'IN_PROGRESS', customer_id: 1, customer_name: 'Acme', customer_phone: null,
    customer_email: null, site_id: 3, site_name: 'HQ', site_address: null, site_city: 'Cape Town',
    site_lat: null, site_lng: null, contract_id: 2, contract_no: 'CTR-2026-0001',
    printer_id: 20, printer_serial: 'SN-020', printer_model: 'M4125idn', printer_is_colour: 0,
    assigned_to: 8, assigned_to_name: 'Tech One', escalated_to: null, escalated_to_name: null,
    description: null, source: 'PHONE', sla_tier: 'GOLD', issue_category_id: null,
    issue_category_name: null, reopen_count: 0, last_resolved_at: null,
    scheduled_date: null, sla_due_at: '2026-06-18 17:00:00',
    in_transit_at: null, checked_in_at: null, checkin_lat: null, checkin_lng: null,
    sla_met: null, resolved_at: null, resolution_notes: null, closed_at: null,
    close_method: null, signature_name: null, signature_image: null,
    escalated_at: null, escalation_reason: null,
    created_by: 1, created_by_name: 'Admin', created_at: '2026-06-18T08:00:00.000Z',
    updated_at: '2026-06-18T08:00:00.000Z',
    ...extra,
  };
}

function errCode(res: { jsonBody?: unknown }) {
  return (res.jsonBody as { error?: { code?: string } }).error?.code;
}

// ===========================================================================
// BR-013 — SLA due date from contract tier
// ===========================================================================
describe('BR-013 — SLA from contract tier', () => {
  beforeEach(() => queryMock.mockReset());

  it('uses PLATINUM tier (2 h) when the linked contract has tier=PLATINUM', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2, sla_tier: 'PLATINUM' }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 101, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ sla_tier: 'PLATINUM' })]);

    const before = Date.now();
    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, contractId: 2, priority: 'MEDIUM' } }),
      {} as never,
    );
    expect(res.status).toBe(201);

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffMs = slaDue.getTime() - before;
    // PLATINUM = 2h; MEDIUM priority default would be 24h.
    expect(diffMs).toBeGreaterThanOrEqual(2 * 3600_000 - 5000);
    expect(diffMs).toBeLessThan(2 * 3600_000 + 5000);
  });

  it('uses GOLD tier (4 h) and stores sla_tier = GOLD in the INSERT', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 4, sla_tier: 'GOLD' }])
      .mockResolvedValueOnce([{ cnt: 1 }])
      .mockResolvedValueOnce({ insertId: 104, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ sla_tier: 'GOLD' })]);

    const before = Date.now();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, contractId: 4, priority: 'LOW' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffH = (slaDue.getTime() - before) / 3600_000;
    // GOLD = 4h; LOW priority default would be 72h.
    expect(diffH).toBeGreaterThanOrEqual(3.99);
    expect(diffH).toBeLessThan(4.01);
    // sla_tier column is at params[13] in the INSERT.
    expect(params[13]).toBe('GOLD');
  });

  it('SILVER tier (8 h) overrides the LOW-priority default of 72 h', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 5, sla_tier: 'SILVER' }])
      .mockResolvedValueOnce([{ cnt: 2 }])
      .mockResolvedValueOnce({ insertId: 105, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ sla_tier: 'SILVER' })]);

    const before = Date.now();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, contractId: 5, priority: 'LOW' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffH = (slaDue.getTime() - before) / 3600_000;
    // Without SILVER tier, LOW priority → 72h. With tier it must be 8h.
    expect(diffH).toBeGreaterThanOrEqual(7.99);
    expect(diffH).toBeLessThan(8.01);
    expect(params[13]).toBe('SILVER');
  });

  it('uses BRONZE tier (24 h) when the contract tier is BRONZE', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 3, sla_tier: 'BRONZE' }])
      .mockResolvedValueOnce([{ cnt: 5 }])
      .mockResolvedValueOnce({ insertId: 102, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ sla_tier: 'BRONZE' })]);

    const before = Date.now();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, contractId: 3, priority: 'LOW' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffH = (slaDue.getTime() - before) / 3600_000;
    // BRONZE = 24h; LOW priority would also default to 72h.
    expect(diffH).toBeGreaterThanOrEqual(23.99);
    expect(diffH).toBeLessThan(24.01);
    expect(params[13]).toBe('BRONZE');
  });

  it('falls back to priority SLA (HIGH = 8 h) when no contractId is supplied', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 103, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow()]);

    const before = Date.now();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, priority: 'HIGH' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffH = (slaDue.getTime() - before) / 3600_000;
    expect(diffH).toBeGreaterThanOrEqual(7.99);
    expect(diffH).toBeLessThan(8.01);
    // No contract → sla_tier column must be null.
    expect(params[13]).toBeNull();
  });

  it('falls back to CRITICAL priority SLA (4 h) when no contractId is supplied', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 106, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ priority: 'CRITICAL' })]);

    const before = Date.now();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, priority: 'CRITICAL' } }),
      {} as never,
    );

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    const slaDue = new Date(String(params[11]).replace(' ', 'T') + 'Z');
    const diffH = (slaDue.getTime() - before) / 3600_000;
    expect(diffH).toBeGreaterThanOrEqual(3.99);
    expect(diffH).toBeLessThan(4.01);
  });

  it('returns 404 when the contractId does not belong to the customer', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);

    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, contractId: 999 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// BR-014 — close requires resolutionNotes
// ===========================================================================
describe('BR-014 — close requires resolution notes', () => {
  beforeEach(() => queryMock.mockReset());

  it('rejects OTP close when resolutionNotes is absent', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'OTP', otp: '123456' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('RESOLUTION_NOTES_REQUIRED');
  });

  it('rejects OTP close when resolutionNotes is whitespace only', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' },
        body: { method: 'OTP', otp: '123456', resolutionNotes: '   ' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('RESOLUTION_NOTES_REQUIRED');
  });

  it('rejects SIGNATURE close when resolutionNotes is absent', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' },
        body: { method: 'SIGNATURE', signatureName: 'Jane Doe', signatureImage: 'data:...' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('RESOLUTION_NOTES_REQUIRED');
  });

  it('accepts OTP close when resolutionNotes is provided', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', close_method: 'OTP' })]);

    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' },
        body: { method: 'OTP', otp: '123456', resolutionNotes: 'Paper jam cleared' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('accepts SIGNATURE close when resolutionNotes is provided', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', close_method: 'SIGNATURE' })]);

    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' },
        body: { method: 'SIGNATURE', signatureName: 'Jane Doe', signatureImage: 'data:...', resolutionNotes: 'Fixed toner unit' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('stores resolutionNotes in the UPDATE query (params[7] of the UPDATE call)', async () => {
    const notes = 'Replaced drum unit and cleaned feed rollers';
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', resolution_notes: notes })]);

    await closeTicket(
      req({ token: techToken(), params: { id: '100' },
        body: { method: 'OTP', otp: '654321', resolutionNotes: notes } }),
      {} as never,
    );

    // transition() emits: UPDATE service_tickets SET status = ?, closed_at = ?,
    //   resolved_at = COALESCE(resolved_at, ?), last_resolved_at = ?,
    //   close_method = ?, signature_name = ?, signature_image = ?, resolution_notes = ?
    //   WHERE id = ?
    // params: ['CLOSED', at, at, at, 'OTP', null, null, resolutionNotes, ticketId]
    const update = queryMock.mock.calls.find(
      ([s]) => /UPDATE service_tickets/i.test(String(s)) && /resolution_notes/i.test(String(s)),
    );
    expect(update).toBeDefined();
    expect((update![1] as unknown[])[7]).toBe(notes);
  });

  it('method check fires before notes check (INVALID_CLOSE_METHOD returned first)', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'MAGIC' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('INVALID_CLOSE_METHOD');
  });
});

// ===========================================================================
// BR-015 — reopen within 48 h
// ===========================================================================
describe('BR-015 — reopen window', () => {
  beforeEach(() => queryMock.mockReset());

  it('reopens a RESOLVED ticket resolved 24 h ago', async () => {
    const resolvedAt = new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    queryMock
      .mockResolvedValueOnce([{ id: 100, status: 'RESOLVED', last_resolved_at: resolvedAt, reopen_count: 0 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100, ticket_no: 'SVC-2026-0001', status: 'OPEN', reopen_count: 1 }]);

    const res = await reopenTicket(
      req({ token: csrToken(), params: { id: '100' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { ticket: { status: string; reopenCount: number } };
    expect(body.ticket.status).toBe('OPEN');
    expect(body.ticket.reopenCount).toBe(1);
  });

  it('allows reopen at exactly 47 h (just inside the 48-h window)', async () => {
    // Use ISO 8601 with 'Z' so new Date() parses as UTC regardless of server timezone.
    const resolvedAt = new Date(Date.now() - 47 * 3600_000).toISOString();
    queryMock
      .mockResolvedValueOnce([{ id: 100, status: 'RESOLVED', last_resolved_at: resolvedAt, reopen_count: 1 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100, ticket_no: 'SVC-2026-0001', status: 'OPEN', reopen_count: 2 }]);

    const res = await reopenTicket(
      req({ token: csrToken(), params: { id: '100' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('rejects reopen after 49 h with REOPEN_WINDOW_EXPIRED', async () => {
    const resolvedAt = new Date(Date.now() - 49 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    queryMock.mockResolvedValueOnce([
      { id: 100, status: 'RESOLVED', last_resolved_at: resolvedAt, reopen_count: 0 },
    ]);

    const res = await reopenTicket(
      req({ token: csrToken(), params: { id: '100' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('UPDATE uses reopen_count = reopen_count + 1 (atomic SQL, not a client-computed value)', async () => {
    const resolvedAt = new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    queryMock
      .mockResolvedValueOnce([{ id: 100, status: 'RESOLVED', last_resolved_at: resolvedAt, reopen_count: 2 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100, ticket_no: 'SVC-2026-0001', status: 'OPEN', reopen_count: 3 }]);

    await reopenTicket(req({ token: csrToken(), params: { id: '100' } }), {} as never);

    const update = queryMock.mock.calls.find(
      ([s]) => /UPDATE service_tickets/i.test(String(s)) && /reopen_count/i.test(String(s)),
    );
    expect(update).toBeDefined();
    expect(String(update![0])).toMatch(/reopen_count\s*=\s*reopen_count\s*\+\s*1/i);
    // Only the ticket id is a bound param; the increment is in the SQL itself.
    expect(update![1]).toEqual([100]);
  });

  it('writes a status-history row (RESOLVED → OPEN) on reopen', async () => {
    const resolvedAt = new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    queryMock
      .mockResolvedValueOnce([{ id: 100, status: 'RESOLVED', last_resolved_at: resolvedAt, reopen_count: 0 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100, ticket_no: 'SVC-2026-0001', status: 'OPEN', reopen_count: 1 }]);

    await reopenTicket(req({ token: csrToken(), params: { id: '100' } }), {} as never);

    // SQL has 'RESOLVED' and 'OPEN' as literals; bound params are [ticket_id, changed_by].
    const historyInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO service_ticket_status_history/i.test(String(s))
        && /RESOLVED/i.test(String(s))
        && /OPEN/i.test(String(s)),
    );
    expect(historyInsert).toBeDefined();
    const params = historyInsert![1] as unknown[];
    expect(params[0]).toBe(100);  // ticket_id
    expect(params[1]).toBe(5);    // changed_by = csrToken sub
  });

  it('rejects reopen of a non-RESOLVED ticket with INVALID_TRANSITION', async () => {
    queryMock.mockResolvedValueOnce([
      { id: 100, status: 'OPEN', last_resolved_at: null, reopen_count: 0 },
    ]);
    const res = await reopenTicket(
      req({ token: csrToken(), params: { id: '100' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });

  it('returns 404 when the ticket does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await reopenTicket(
      req({ token: csrToken(), params: { id: '999' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Auto-assign by region
// ===========================================================================
describe('Auto-assign by region', () => {
  beforeEach(() => queryMock.mockReset());

  it('auto-assigns the least-busy tech in the same region as the site', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])             // customer
      .mockResolvedValueOnce([{ city: 'Cape Town' }]) // site city
      .mockResolvedValueOnce([{ id: 7 }])             // tech in region
      .mockResolvedValueOnce([{ cnt: 0 }])            // COUNT for ticket_no
      .mockResolvedValueOnce({ insertId: 200, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ assigned_to: 7, status: 'ASSIGNED' })]);

    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, siteId: 3, autoAssign: true } }),
      {} as never,
    );
    expect(res.status).toBe(201);

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params[8]).toBe(7);          // assigned_to
    expect(params[3]).toBe('ASSIGNED'); // status
  });

  it('leaves ticket OPEN when no technician exists in the region', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ city: 'Durban' }])
      .mockResolvedValueOnce([])   // no tech in Durban
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 201, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ assigned_to: null, status: 'OPEN' })]);

    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, siteId: 5, autoAssign: true } }),
      {} as never,
    );
    expect(res.status).toBe(201);

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params[8]).toBeNull();   // assigned_to = null
    expect(params[3]).toBe('OPEN'); // status = OPEN
  });

  it('CSR explicit assignedTo skips region lookup and marks ticket ASSIGNED', async () => {
    // No autoAssign and no siteId: CSR directly nominates techId=9.
    // Expected queries: customer → COUNT → INSERT → history → audit → findTicket.
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                              // customer
      .mockResolvedValueOnce([{ cnt: 0 }])                             // COUNT
      .mockResolvedValueOnce({ insertId: 202, affectedRows: 1 })       // INSERT ticket
      .mockResolvedValueOnce({ affectedRows: 1 })                      // INSERT history
      .mockResolvedValueOnce({ affectedRows: 1 })                      // writeAudit
      .mockResolvedValueOnce([ticketRow({ assigned_to: 9, status: 'ASSIGNED' })]);

    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, assignedTo: 9 } }),
      {} as never,
    );
    expect(res.status).toBe(201);

    // The standalone region-lookup query (SELECT city FROM customer_sites WHERE ...) must NOT have run.
    // TICKET_SELECT also has customer_sites in a JOIN but uses 'LEFT JOIN customer_sites',
    // so filtering for 'SELECT city FROM customer_sites' uniquely identifies the region query.
    const regionLookup = queryMock.mock.calls.find(
      ([s]) => /SELECT\s+city\s+FROM\s+customer_sites/i.test(String(s)),
    );
    expect(regionLookup).toBeUndefined();

    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params[8]).toBe(9);           // assigned_to = explicit tech
    expect(params[3]).toBe('ASSIGNED');  // status
  });

  it('supervisor can reassign an ASSIGNED ticket to a different tech via assignTicket', async () => {
    // Ticket is ASSIGNED to tech 8; supervisor reassigns to tech 9.
    // The status stays ASSIGNED (only OPEN→ASSIGNED promotion happens on first assign).
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED', assigned_to: 8 })])   // findTicket
      .mockResolvedValueOnce([{ id: 9, is_active: 1 }])                              // tech lookup
      .mockResolvedValueOnce({ affectedRows: 1 })                                    // UPDATE assigned_to
      .mockResolvedValueOnce({ affectedRows: 1 })                                    // INSERT history
      .mockResolvedValueOnce({ affectedRows: 1 })                                    // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED', assigned_to: 9 })]);  // re-fetch

    const res = await assignTicket(
      req({ token: supervisorToken(), params: { id: '100' }, body: { technicianId: 9 } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const update = queryMock.mock.calls.find(
      ([s]) => /UPDATE service_tickets/i.test(String(s)) && /assigned_to/i.test(String(s)),
    );
    expect(update).toBeDefined();
    const uParams = update![1] as unknown[];
    expect(uParams[0]).toBe(9);           // new assigned_to = tech 9
    expect(uParams[1]).toBe('ASSIGNED');  // status unchanged (was already ASSIGNED)
    expect(uParams[2]).toBe(100);         // WHERE id
  });
});

// ===========================================================================
// SLA breach escalation — processSlaBreaches()
// ===========================================================================
describe('processSlaBreaches', () => {
  beforeEach(() => queryMock.mockReset());

  it('inserts a T_MINUS_1H alert for a ticket approaching its SLA deadline', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 10 }])        // approaching
      .mockResolvedValueOnce({ affectedRows: 1 }) // INSERT T_MINUS_1H alert
      .mockResolvedValueOnce([{ id: 99 }])        // CSR_SUPERVISOR
      .mockResolvedValueOnce([])                  // no BREACH tickets
      .mockResolvedValueOnce([{ id: 100 }])       // OPERATIONS_MANAGER
      .mockResolvedValueOnce([]);                 // no DOUBLE_BREACH

    const result = await processSlaBreaches(new Date());
    expect(result.t1h).toBe(1);
    expect(result.breach).toBe(0);

    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT.*service_sla_alerts/i.test(String(s)) && /T_MINUS_1H/i.test(String(s)),
    );
    expect(alertInsert).toBeDefined();
    expect(alertInsert![1]).toContain(10);  // ticket_id
  });

  it('auto-escalates a breached ticket: UPDATE sets status=ESCALATED with escalated_to=supervisor', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([{ id: 10, status: 'OPEN' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100 }])
      .mockResolvedValueOnce([]);

    const result = await processSlaBreaches(new Date());
    expect(result.breach).toBe(1);

    // Verify UPDATE has status=ESCALATED and escalated_to=supId.
    const update = queryMock.mock.calls.find(
      ([s]) => /UPDATE service_tickets/i.test(String(s))
        && /ESCALATED/i.test(String(s))
        && /escalated_to/i.test(String(s)),
    );
    expect(update).toBeDefined();
    const uParams = update![1] as unknown[];
    expect(uParams[0]).toBe(99);   // escalated_to = CSR Supervisor
    expect(uParams[2]).toBe(10);   // WHERE id = ticket.id

    // BREACH alert must also be inserted.
    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT.*service_sla_alerts/i.test(String(s))
        && /BREACH/i.test(String(s))
        && !/DOUBLE/i.test(String(s)),
    );
    expect(alertInsert).toBeDefined();
  });

  it('writes a status-history row with CSR Supervisor as changed_by on breach', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([{ id: 10, status: 'OPEN' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: 100 }])
      .mockResolvedValueOnce([]);

    await processSlaBreaches(new Date());

    // SQL: VALUES (?, ?, 'ESCALATED', 'SLA breach auto-escalation', ?)
    // params: [t.id, t.status, supId]
    const historyInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT INTO service_ticket_status_history/i.test(String(s))
        && /SLA breach/i.test(String(s)),
    );
    expect(historyInsert).toBeDefined();
    const params = historyInsert![1] as unknown[];
    expect(params[0]).toBe(10);     // ticket_id
    expect(params[1]).toBe('OPEN'); // from_status = ticket.status at breach time
    expect(params[2]).toBe(99);     // changed_by = supId
  });

  it('still inserts BREACH alert with null escalated_to when no CSR Supervisor is found', async () => {
    queryMock
      .mockResolvedValueOnce([])                              // no approaching
      .mockResolvedValueOnce([])                              // CSR_SUPERVISOR → not found (supId = null)
      .mockResolvedValueOnce([{ id: 10, status: 'OPEN' }])   // BREACH candidate
      .mockResolvedValueOnce({ affectedRows: 1 })             // UPDATE (escalated_to = null)
      .mockResolvedValueOnce({ affectedRows: 1 })             // INSERT history (changed_by = 1 fallback)
      .mockResolvedValueOnce({ affectedRows: 1 })             // INSERT BREACH alert
      .mockResolvedValueOnce([{ id: 100 }])                   // OPERATIONS_MANAGER
      .mockResolvedValueOnce([]);                             // no DOUBLE_BREACH

    const result = await processSlaBreaches(new Date());
    expect(result.breach).toBe(1);

    // escalated_to in UPDATE should be null.
    const update = queryMock.mock.calls.find(
      ([s]) => /UPDATE service_tickets/i.test(String(s)) && /escalated_to/i.test(String(s)),
    );
    expect((update![1] as unknown[])[0]).toBeNull();

    // Alert is still inserted, with escalated_to = null.
    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT.*service_sla_alerts/i.test(String(s))
        && /BREACH/i.test(String(s))
        && !/DOUBLE/i.test(String(s)),
    );
    expect(alertInsert).toBeDefined();
    expect((alertInsert![1] as unknown[])[1]).toBeNull(); // escalated_to = null
  });

  it('processes every breached ticket — two tickets each get their own BREACH alert', async () => {
    queryMock
      .mockResolvedValueOnce([])                                    // no approaching
      .mockResolvedValueOnce([{ id: 99 }])                          // CSR_SUPERVISOR
      .mockResolvedValueOnce([                                       // two BREACH candidates
        { id: 10, status: 'OPEN' },
        { id: 11, status: 'IN_PROGRESS' },
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })                   // UPDATE ticket 10
      .mockResolvedValueOnce({ affectedRows: 1 })                   // INSERT history 10
      .mockResolvedValueOnce({ affectedRows: 1 })                   // INSERT BREACH alert 10
      .mockResolvedValueOnce({ affectedRows: 1 })                   // UPDATE ticket 11
      .mockResolvedValueOnce({ affectedRows: 1 })                   // INSERT history 11
      .mockResolvedValueOnce({ affectedRows: 1 })                   // INSERT BREACH alert 11
      .mockResolvedValueOnce([{ id: 100 }])                         // OPERATIONS_MANAGER
      .mockResolvedValueOnce([]);                                   // no DOUBLE_BREACH

    const result = await processSlaBreaches(new Date());
    expect(result.breach).toBe(2);

    const breachAlerts = queryMock.mock.calls.filter(
      ([s]) => /INSERT.*service_sla_alerts/i.test(String(s))
        && /BREACH/i.test(String(s))
        && !/DOUBLE/i.test(String(s)),
    );
    expect(breachAlerts).toHaveLength(2);
    expect((breachAlerts[0][1] as unknown[])[0]).toBe(10);  // first alert → ticket 10
    expect((breachAlerts[1][1] as unknown[])[0]).toBe(11);  // second alert → ticket 11
  });

  it('escalates to Operations Manager on 2× SLA breach', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([])                  // no BREACH tickets
      .mockResolvedValueOnce([{ id: 100 }])       // OPERATIONS_MANAGER id=100
      .mockResolvedValueOnce([{ id: 10 }])        // double-breached ticket
      .mockResolvedValueOnce({ affectedRows: 1 }) // UPDATE escalated_to = opsId
      .mockResolvedValueOnce({ affectedRows: 1 }); // INSERT DOUBLE_BREACH alert

    const result = await processSlaBreaches(new Date());
    expect(result.double).toBe(1);

    // The DOUBLE_BREACH UPDATE is the 6th call overall (index 5).
    const update = queryMock.mock.calls.find(
      ([s], i) => /UPDATE service_tickets/i.test(String(s)) && i >= 4,
    );
    expect(update).toBeDefined();
    expect((update![1] as unknown[])[0]).toBe(100);  // escalated_to = Ops Manager

    const alertInsert = queryMock.mock.calls.find(
      ([s]) => /INSERT/i.test(String(s)) && /DOUBLE_BREACH/i.test(String(s)),
    );
    expect(alertInsert).toBeDefined();
    expect(alertInsert![1]).toContain(100);  // escalated_to = Ops Manager id
  });

  it('returns zero counts when there are no pending tickets', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 100 }])
      .mockResolvedValueOnce([]);

    const result = await processSlaBreaches(new Date());
    expect(result).toEqual({ t1h: 0, breach: 0, double: 0 });
  });
});

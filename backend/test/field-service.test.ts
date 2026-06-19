/**
 * Field Service Management — endpoint tests.
 *
 * All real handlers run; only the DB layer is mocked.
 *
 * Mock-call sequencing reminders:
 *   - findTicket() is one query.
 *   - writeAudit() always adds one extra query() (INSERT into audit_log).
 *   - Each action handler runs: findTicket → <action queries> → findTicket.
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
  listTickets,
  getTicket,
  createTicket,
  assignTicket,
  transitTicket,
  checkInTicket,
  startTicket,
  meterTicket,
  partsTicket,
  closeTicket,
  escalateTicket,
  cancelTicket,
  syncTickets,
} from '../src/functions/field-service';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERMS_ALL = ['service.read', 'service.create', 'service.assign', 'service.update', 'service.close', 'service.escalate'];

function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: PERMS_ALL });
}
function techToken() {
  return issueToken({ sub: 8, email: 'tech@websol.local', role: 'FIELD_TECHNICIAN', perms: ['service.read', 'service.update', 'service.close', 'service.escalate'] });
}
function readToken() {
  return issueToken({ sub: 5, email: 'csr@websol.local', role: 'CSR', perms: ['service.read'] });
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
    id: 100,
    ticket_no: 'SVC-2026-0001',
    visit_type: 'CORRECTIVE',
    priority: 'HIGH',
    status: 'IN_PROGRESS',
    customer_id: 1,
    customer_name: 'Acme Corp',
    customer_phone: '+27210000000',
    customer_email: 'ops@acme.test',
    site_id: 3,
    site_name: 'HQ',
    site_address: '1 Main Rd',
    site_city: 'Cape Town',
    site_lat: '-33.9249000',
    site_lng: '18.4241000',
    contract_id: 2,
    contract_no: 'CTR-2026-0001',
    printer_id: 20,
    printer_serial: 'SN-020',
    printer_model: 'M4125idn',
    printer_is_colour: 0,
    assigned_to: 8,
    assigned_to_name: 'Tech One',
    escalated_to: null,
    escalated_to_name: null,
    description: 'Paper jam',
    source: 'PHONE',
    sla_tier: null,
    issue_category_id: null,
    issue_category_name: null,
    reopen_count: 0,
    last_resolved_at: null,
    scheduled_date: '2026-06-18',
    sla_due_at: '2026-06-18 17:00:00',
    in_transit_at: null,
    checked_in_at: null,
    checkin_lat: null,
    checkin_lng: null,
    sla_met: null,
    resolved_at: null,
    resolution_notes: null,
    closed_at: null,
    close_method: null,
    signature_name: null,
    signature_image: null,
    escalated_at: null,
    escalation_reason: null,
    // Raiser classification (migration 011)
    raiser_type: 'EMPLOYEE',
    raiser_party: 'INTERNAL',
    raiser_user_id: 1,
    raiser_contact_id: null,
    raiser_name: 'Admin User',
    raiser_email: 'admin@websol.local',
    raiser_user_name: 'Admin User',
    created_by: 1,
    created_by_name: 'Admin User',
    created_at: '2026-06-18T08:00:00.000Z',
    updated_at: '2026-06-18T08:00:00.000Z',
    ...extra,
  };
}

function errCode(res: { jsonBody?: unknown }) {
  return (res.jsonBody as { error?: { code?: string } }).error?.code;
}

// ===========================================================================
// listTickets / getTicket / auth basics
// ===========================================================================
describe('listTickets', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with tickets', async () => {
    queryMock.mockResolvedValueOnce([ticketRow()]);
    const res = await listTickets(req({ token: adminToken() }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { tickets: unknown[] }).tickets).toHaveLength(1);
  });

  it('returns 401 without a token', async () => {
    const res = await listTickets(req(), {} as never);
    expect(res.status).toBe(401);
  });

  it('returns 403 without service.read', async () => {
    const token = issueToken({ sub: 2, email: 'x@y.com', role: 'X', perms: [] });
    const res = await listTickets(req({ token }), {} as never);
    expect(res.status).toBe(403);
  });

  it('applies a status filter', async () => {
    queryMock.mockResolvedValueOnce([]);
    await listTickets(req({ token: adminToken(), query: { status: 'open' } }), {} as never);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/t\.status = \?/);
  });
});

describe('getTicket', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with ticket, history, meters, parts, notifications', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])  // findTicket
      .mockResolvedValueOnce([])             // history
      .mockResolvedValueOnce([])             // meters
      .mockResolvedValueOnce([])             // parts
      .mockResolvedValueOnce([]);            // notifications
    const res = await getTicket(req({ token: adminToken(), params: { id: '100' } }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { ticket: { ticketNo: string } };
    expect(body.ticket.ticketNo).toBe('SVC-2026-0001');
  });

  it('returns 404 when not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await getTicket(req({ token: adminToken(), params: { id: '999' } }), {} as never);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// createTicket
// ===========================================================================
describe('createTicket', () => {
  beforeEach(() => queryMock.mockReset());

  function setupCreate() {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                       // customer exists
      .mockResolvedValueOnce([{ cnt: 0 }])                      // COUNT for ticket_no
      .mockResolvedValueOnce({ insertId: 100, affectedRows: 1 }) // INSERT ticket
      .mockResolvedValueOnce({ affectedRows: 1 })               // INSERT history
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([ticketRow()]);                    // findTicket
  }

  it('creates a ticket and returns 201', async () => {
    setupCreate();
    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, priority: 'HIGH' } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    expect((res.jsonBody as { ticket: { ticketNo: string } }).ticket.ticketNo).toBe('SVC-2026-0001');
  });

  it('generates ticket number SVC-YYYY-0001 from COUNT 0', async () => {
    setupCreate();
    await createTicket(req({ token: adminToken(), body: { visitType: 'METER_READING', customerId: 1 } }), {} as never);
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    expect((insert![1] as unknown[])[0]).toMatch(/^SVC-\d{4}-0001$/);
  });

  it('starts in ASSIGNED status when assignedTo is supplied', async () => {
    setupCreate();
    await createTicket(req({ token: adminToken(), body: { visitType: 'INSTALLATION', customerId: 1, assignedTo: 8 } }), {} as never);
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    // status column is the 4th param
    expect((insert![1] as unknown[])[3]).toBe('ASSIGNED');
  });

  it('starts in OPEN status when no technician assigned', async () => {
    setupCreate();
    await createTicket(req({ token: adminToken(), body: { visitType: 'COLLECTION', customerId: 1 } }), {} as never);
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    expect((insert![1] as unknown[])[3]).toBe('OPEN');
  });

  it('rejects an invalid visitType', async () => {
    const res = await createTicket(req({ token: adminToken(), body: { visitType: 'NONSENSE', customerId: 1 } }), {} as never);
    expect(res.status).toBe(400);
  });

  it('rejects a missing customerId', async () => {
    const res = await createTicket(req({ token: adminToken(), body: { visitType: 'CORRECTIVE' } }), {} as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the customer does not exist', async () => {
    queryMock.mockResolvedValueOnce([]); // customer lookup empty
    const res = await createTicket(req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 999 } }), {} as never);
    expect(res.status).toBe(404);
  });

  it('returns 403 without service.create', async () => {
    const res = await createTicket(req({ token: readToken(), body: { visitType: 'CORRECTIVE', customerId: 1 } }), {} as never);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Raiser classification (migration 011)
// ===========================================================================
describe('Raiser classification', () => {
  beforeEach(() => queryMock.mockReset());

  function setupCreate() {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                        // customer exists
      .mockResolvedValueOnce([{ cnt: 0 }])                       // COUNT for ticket_no
      .mockResolvedValueOnce({ insertId: 100, affectedRows: 1 }) // INSERT ticket
      .mockResolvedValueOnce({ affectedRows: 1 })                // INSERT history
      .mockResolvedValueOnce({ affectedRows: 1 })                // writeAudit
      .mockResolvedValueOnce([ticketRow()]);                     // findTicket
  }

  function insertParams(): unknown[] {
    const call = queryMock.mock.calls.find(([s]) => /INSERT INTO service_tickets/i.test(String(s)));
    return call ? (call[1] as unknown[]) : [];
  }

  it('defaults to EMPLOYEE / INTERNAL when raiserType is omitted', async () => {
    setupCreate();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1 } }),
      {} as never,
    );
    const p = insertParams();
    // raiser_type is the 16th param (index 15), raiser_party is index 16
    expect(p[15]).toBe('EMPLOYEE');
    expect(p[16]).toBe('INTERNAL');
  });

  it('records the caller\'s userId as raiser_user_id for EMPLOYEE raiser', async () => {
    setupCreate();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1 } }),
      {} as never,
    );
    const p = insertParams();
    // raiser_user_id is index 17; adminToken sub = 1
    expect(p[17]).toBe(1);
  });

  it('accepts an explicit raiser_user_id for EMPLOYEE raiser', async () => {
    setupCreate();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, raiserType: 'EMPLOYEE', raiserUserId: 42 } }),
      {} as never,
    );
    const p = insertParams();
    expect(p[15]).toBe('EMPLOYEE');
    expect(p[17]).toBe(42);
  });

  it('CUSTOMER raiser with name returns 201 and sets raiser_type=CUSTOMER', async () => {
    setupCreate();
    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, raiserType: 'CUSTOMER', raiserName: 'Jane Smith', raiserEmail: 'jane@client.com' } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const p = insertParams();
    expect(p[15]).toBe('CUSTOMER');
    expect(p[16]).toBe('EXTERNAL');
    expect(p[19]).toBe('Jane Smith');
    expect(p[20]).toBe('jane@client.com');
  });

  it('CUSTOMER raiser without raiserName returns 400 RAISER_NAME_REQUIRED', async () => {
    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, raiserType: 'CUSTOMER' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('RAISER_NAME_REQUIRED');
    // No DB queries should have been made before this validation fires
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows overriding raiserParty to EXTERNAL for an EMPLOYEE', async () => {
    setupCreate();
    await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, raiserType: 'EMPLOYEE', raiserParty: 'EXTERNAL' } }),
      {} as never,
    );
    const p = insertParams();
    expect(p[15]).toBe('EMPLOYEE');
    expect(p[16]).toBe('EXTERNAL');
  });

  it('listTickets applies raiserType=CUSTOMER filter', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await listTickets(
      req({ token: adminToken(), query: { raiserType: 'CUSTOMER' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('raiser_type');
    expect(params).toContain('CUSTOMER');
  });

  it('listTickets with raiserType=EMPLOYEE filters correctly', async () => {
    queryMock.mockResolvedValueOnce([ticketRow()]);
    const res = await listTickets(
      req({ token: adminToken(), query: { raiserType: 'EMPLOYEE' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const tickets = (res.jsonBody as { tickets: unknown[] }).tickets;
    expect(tickets).toHaveLength(1);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('EMPLOYEE');
  });

  it('returned ticket shape includes raiser block', async () => {
    setupCreate();
    const res = await createTicket(
      req({ token: adminToken(), body: { visitType: 'CORRECTIVE', customerId: 1, raiserName: 'System', raiserEmail: 'sys@websol.local' } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const ticket = (res.jsonBody as { ticket: Record<string, unknown> }).ticket;
    expect(ticket).toHaveProperty('raiser');
    const raiser = ticket.raiser as Record<string, unknown>;
    expect(raiser.type).toBe('EMPLOYEE');
    expect(raiser.party).toBe('INTERNAL');
  });
});

// ===========================================================================
// BR-004 / BR-005 / BR-006 — meter readings
// ===========================================================================
describe('Meter readings', () => {
  beforeEach(() => queryMock.mockReset());

  // Mono printer, previous reading present. Used for BR-004/BR-005.
  function setupMeter(opts: {
    isColour?: number;
    allowanceBw?: number | null;
    allowanceColour?: number | null;
    prev?: { reading_bw: number; reading_colour: number | null } | null;
    ticketExtra?: Record<string, unknown>;
  } = {}) {
    const { isColour = 0, allowanceBw = 1000, allowanceColour = null, prev = { reading_bw: 5000, reading_colour: null } } = opts;
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: isColour, ...opts.ticketExtra })]) // findTicket
      .mockResolvedValueOnce([{ id: 20, is_colour: isColour, monthly_allowance_bw: allowanceBw, monthly_allowance_colour: allowanceColour }]) // printer
      .mockResolvedValueOnce(prev ? [prev] : []) // previous reading
      .mockResolvedValueOnce({ insertId: 555, affectedRows: 1 }) // INSERT meter
      .mockResolvedValueOnce({ affectedRows: 1 }) // writeAudit
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: isColour })]); // re-findTicket
  }

  it('BR-004: rejects a B/W reading below the previous reading', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ id: 20, is_colour: 0, monthly_allowance_bw: 1000, monthly_allowance_colour: null }])
      .mockResolvedValueOnce([{ reading_bw: 5000, reading_colour: null }]);
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 4999 } }), {} as never);
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('READING_BELOW_PREVIOUS');
  });

  it('BR-004: accepts a reading equal to the previous (meter unchanged)', async () => {
    setupMeter({ prev: { reading_bw: 5000, reading_colour: null } });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5000 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { deltaBw: number }).deltaBw).toBe(0);
  });

  it('BR-004: rejects a colour reading below previous on a colour printer', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })])
      .mockResolvedValueOnce([{ id: 20, is_colour: 1, monthly_allowance_bw: 1000, monthly_allowance_colour: 500 }])
      .mockResolvedValueOnce([{ reading_bw: 5000, reading_colour: 2000 }]);
    const res = await meterTicket(
      req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5100, readingColour: 1999 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('READING_BELOW_PREVIOUS');
  });

  it('BR-005: flags for approval when delta exceeds 3x the monthly allowance', async () => {
    // allowance 1000 → 3x = 3000. prev 5000, new 9000 → delta 4000 > 3000.
    setupMeter({ allowanceBw: 1000, prev: { reading_bw: 5000, reading_colour: null } });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 9000 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { needsApproval: boolean }).needsApproval).toBe(true);
    // The insert should record PENDING approval.
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params).toContain('PENDING');
  });

  it('BR-005: does NOT flag when delta is within 3x the allowance', async () => {
    // allowance 1000 → 3x = 3000. prev 5000, new 7500 → delta 2500 <= 3000.
    setupMeter({ allowanceBw: 1000, prev: { reading_bw: 5000, reading_colour: null } });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 7500 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { needsApproval: boolean }).needsApproval).toBe(false);
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    expect((insert![1] as unknown[])).toContain('NONE');
  });

  it('BR-005: exact 3x boundary is allowed (not flagged)', async () => {
    // allowance 1000 → 3x = 3000. prev 5000, new 8000 → delta exactly 3000.
    setupMeter({ allowanceBw: 1000, prev: { reading_bw: 5000, reading_colour: null } });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 8000 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { needsApproval: boolean }).needsApproval).toBe(false);
  });

  it('BR-005: not flagged when there is no previous reading (first capture)', async () => {
    setupMeter({ allowanceBw: 1000, prev: null });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 999999 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { needsApproval: boolean }).needsApproval).toBe(false);
    expect((res.jsonBody as { deltaBw: number | null }).deltaBw).toBeNull();
  });

  it('BR-006: rejects a colour printer reading missing the colour value', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })])
      .mockResolvedValueOnce([{ id: 20, is_colour: 1, monthly_allowance_bw: 1000, monthly_allowance_colour: 500 }]);
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 6000 } }), {} as never);
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('COLOUR_READING_REQUIRED');
  });

  it('BR-006: accepts a colour printer reading with both values', async () => {
    setupMeter({ isColour: 1, allowanceBw: 1000, allowanceColour: 500, prev: { reading_bw: 5000, reading_colour: 2000 } });
    const res = await meterTicket(
      req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5500, readingColour: 2200 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { deltaColour: number }).deltaColour).toBe(200);
  });

  it('mono printer does not require a colour reading', async () => {
    setupMeter({ isColour: 0, prev: { reading_bw: 5000, reading_colour: null } });
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5200 } }), {} as never);
    expect(res.status).toBe(200);
  });

  it('rejects a missing readingBw', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ id: 20, is_colour: 0, monthly_allowance_bw: 1000, monthly_allowance_colour: null }]);
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(400);
  });

  it('returns 422 when the ticket has no printer', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ printer_id: null })]);
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 100 } }), {} as never);
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('NO_PRINTER');
  });

  it('stores the photo image when supplied', async () => {
    setupMeter({ prev: { reading_bw: 5000, reading_colour: null } });
    await meterTicket(
      req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5100, photoImage: 'data:image/png;base64,AAAA' } }),
      {} as never,
    );
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    expect((insert![1] as unknown[])).toContain('data:image/png;base64,AAAA');
  });
});

// ===========================================================================
// Parts used — auto-deduct inventory (BR-021)
// ===========================================================================
describe('Parts used (auto-deduct, BR-021)', () => {
  beforeEach(() => queryMock.mockReset());

  function setupParts(onHand: number) {
    queryMock
      .mockResolvedValueOnce([ticketRow()])                 // findTicket
      .mockResolvedValueOnce([{ qty_on_hand: onHand }])     // stock lookup
      .mockResolvedValueOnce({ affectedRows: 1 })           // UPDATE deduct
      .mockResolvedValueOnce({ insertId: 777, affectedRows: 1 }) // INSERT parts
      .mockResolvedValueOnce({ affectedRows: 1 })           // writeAudit
      .mockResolvedValueOnce([ticketRow()]);                // re-findTicket
  }

  it('records a part and deducts stock, returns 200', async () => {
    setupParts(10);
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 2 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { newOnHand: number }).newOnHand).toBe(8);
  });

  it('issues a deducting UPDATE against consumable_stock', async () => {
    setupParts(10);
    await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 2 } }),
      {} as never,
    );
    const update = queryMock.mock.calls.find(([s]) => /UPDATE consumable_stock SET qty_on_hand = qty_on_hand - \?/i.test(String(s)));
    expect(update).toBeDefined();
    expect((update![1] as unknown[])[0]).toBe(2); // quantity deducted
  });

  it('BR-021: rejects when stock is insufficient (would go negative)', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ qty_on_hand: 1 }]); // only 1 on hand
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INSUFFICIENT_STOCK');
  });

  it('BR-021: no deducting UPDATE is issued when stock is insufficient', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ qty_on_hand: 1 }]);
    await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 5 } }),
      {} as never,
    );
    const updates = queryMock.mock.calls.filter(([s]) => /UPDATE consumable_stock/i.test(String(s)));
    expect(updates).toHaveLength(0);
  });

  it('treats a missing stock row as zero on hand', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([]); // no stock row
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 1 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INSUFFICIENT_STOCK');
  });

  it('exact-zero boundary: deducting the whole stock is allowed', async () => {
    setupParts(5);
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { newOnHand: number }).newOnHand).toBe(0);
  });

  it('rejects a non-positive quantity', async () => {
    queryMock.mockResolvedValueOnce([ticketRow()]);
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 0 } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Status flow — transit, check-in, start, close, in valid order only
// ===========================================================================
describe('Status flow', () => {
  beforeEach(() => queryMock.mockReset());

  // transit (ASSIGNED → IN_TRANSIT)
  it('transit: ASSIGNED → IN_TRANSIT, returns 200', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED' })]) // findTicket
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // notification INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT' })]); // re-findTicket
    const res = await transitTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ticket: { status: string } }).ticket.status).toBe('IN_TRANSIT');
  });

  it('transit: rejected from IN_PROGRESS (invalid order)', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await transitTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });

  it.each(['OPEN', 'ON_SITE', 'IN_PROGRESS', 'CLOSED', 'CANCELLED'] as const)(
    'transit: rejected from %s', async (status) => {
      queryMock.mockResolvedValueOnce([ticketRow({ status })]);
      const res = await transitTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
      expect(res.status).toBe(422);
    },
  );

  // check-in (IN_TRANSIT → ON_SITE)
  it('checkin: IN_TRANSIT → ON_SITE with GPS, returns 200', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT' })])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]);
    const res = await checkInTicket(
      req({ token: techToken(), params: { id: '100' }, body: { lat: -33.92, lng: 18.42 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('checkin: requires GPS coordinates', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT' })]);
    const res = await checkInTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('GPS_REQUIRED');
  });

  it('checkin: SLA met when arrival is before the deadline', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT', sla_due_at: '2999-01-01 00:00:00' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]);
    const res = await checkInTicket(
      req({ token: techToken(), params: { id: '100' }, body: { lat: -33.92, lng: 18.42 } }),
      {} as never,
    );
    expect((res.jsonBody as { slaMet: boolean }).slaMet).toBe(true);
  });

  it('checkin: SLA breached when arrival is after the deadline', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT', sla_due_at: '2000-01-01 00:00:00' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]);
    const res = await checkInTicket(
      req({ token: techToken(), params: { id: '100' }, body: { lat: -33.92, lng: 18.42, occurredAt: '2026-06-18 10:00:00' } }),
      {} as never,
    );
    expect((res.jsonBody as { slaMet: boolean }).slaMet).toBe(false);
  });

  // start (ON_SITE → IN_PROGRESS)
  it('start: ON_SITE → IN_PROGRESS', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await startTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(200);
  });

  it('start: rejected from ASSIGNED (must be ON_SITE)', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED' })]);
    const res = await startTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(422);
  });
});

// ===========================================================================
// Notifications — "In Transit" triggers a customer notification
// ===========================================================================
describe('Customer notification on transit', () => {
  beforeEach(() => queryMock.mockReset());

  it('inserts a notification row when the ticket goes IN_TRANSIT', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED' })])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // notification INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT' })]);
    const res = await transitTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    const notif = queryMock.mock.calls.find(([s]) => /INSERT INTO service_notifications/i.test(String(s)));
    expect(notif).toBeDefined();
    // recipient defaults to customer phone
    expect((notif![1] as unknown[])).toContain('+27210000000');
    expect((res.jsonBody as { notified: string }).notified).toBe('+27210000000');
  });
});

// ===========================================================================
// Escalation
// ===========================================================================
describe('Escalation', () => {
  beforeEach(() => queryMock.mockReset());

  it('escalates an IN_PROGRESS ticket to a senior technician', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]) // findTicket
      .mockResolvedValueOnce([{ id: 9, is_active: 1 }])              // senior user lookup
      .mockResolvedValueOnce({ affectedRows: 1 })                    // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })                    // history
      .mockResolvedValueOnce({ affectedRows: 1 })                    // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'ESCALATED', escalated_to: 9 })]);
    const res = await escalateTicket(
      req({ token: techToken(), params: { id: '100' }, body: { seniorTechnicianId: 9, reason: 'SLA breach' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ticket: { status: string } }).ticket.status).toBe('ESCALATED');
    expect((res.jsonBody as { escalatedTo: number }).escalatedTo).toBe(9);
  });

  it('requires seniorTechnicianId', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await escalateTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the senior technician does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce([]); // user lookup empty
    const res = await escalateTicket(
      req({ token: techToken(), params: { id: '100' }, body: { seniorTechnicianId: 999 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('cannot escalate a CLOSED ticket', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'CLOSED' })]);
    const res = await escalateTicket(
      req({ token: techToken(), params: { id: '100' }, body: { seniorTechnicianId: 9 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });

  it('requires the service.escalate permission', async () => {
    const res = await escalateTicket(
      req({ token: readToken(), params: { id: '100' }, body: { seniorTechnicianId: 9 } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Close — digital signature or OTP
// ===========================================================================
describe('Close ticket', () => {
  beforeEach(() => queryMock.mockReset());

  function setupClose(status = 'IN_PROGRESS') {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status })])  // findTicket
      .mockResolvedValueOnce({ affectedRows: 1 })      // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })      // history
      .mockResolvedValueOnce({ affectedRows: 1 })      // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', close_method: 'SIGNATURE', signature_name: 'Jane' })]);
  }

  it('closes with a digital signature, returns 200', async () => {
    setupClose();
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE', signatureName: 'Jane', signatureImage: 'data:image/png;base64,AAA', resolutionNotes: 'Paper jam cleared' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ticket: { status: string } }).ticket.status).toBe('CLOSED');
  });

  it('closes with an OTP, returns 200', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', close_method: 'OTP' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'OTP', otp: '123456', resolutionNotes: 'Issue resolved on site' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('signature close requires signatureName', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('SIGNATURE_REQUIRED');
  });

  it('OTP close requires a valid OTP', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'OTP', otp: 'abc' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('OTP_REQUIRED');
  });

  it('rejects an invalid close method', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'MAGIC' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('INVALID_CLOSE_METHOD');
  });

  it('can close from ON_SITE', async () => {
    setupClose('ON_SITE');
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE', signatureName: 'Jane', resolutionNotes: 'Fixed on site' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('cannot close an OPEN ticket', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'OPEN' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE', signatureName: 'Jane' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('INVALID_TRANSITION');
  });

  it('requires the service.close permission', async () => {
    const res = await closeTicket(
      req({ token: readToken(), params: { id: '100' }, body: { method: 'SIGNATURE', signatureName: 'Jane' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// assign / cancel
// ===========================================================================
describe('assignTicket', () => {
  beforeEach(() => queryMock.mockReset());

  it('assigns a technician and moves OPEN → ASSIGNED', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'OPEN', assigned_to: null })]) // findTicket
      .mockResolvedValueOnce([{ id: 8, is_active: 1 }])                          // technician lookup
      .mockResolvedValueOnce({ affectedRows: 1 })                               // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })                               // history
      .mockResolvedValueOnce({ affectedRows: 1 })                               // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED', assigned_to: 8 })]);
    const res = await assignTicket(
      req({ token: adminToken(), params: { id: '100' }, body: { technicianId: 8 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ticket: { status: string } }).ticket.status).toBe('ASSIGNED');
  });

  it('requires service.assign', async () => {
    const res = await assignTicket(
      req({ token: techToken(), params: { id: '100' }, body: { technicianId: 8 } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });
});

describe('cancelTicket', () => {
  beforeEach(() => queryMock.mockReset());

  it('cancels an active ticket', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'CANCELLED' })]);
    const res = await cancelTicket(req({ token: techToken(), params: { id: '100' }, body: { reason: 'Duplicate' } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ticket: { status: string } }).ticket.status).toBe('CANCELLED');
  });

  it('cannot cancel a CLOSED ticket', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'CLOSED' })]);
    const res = await cancelTicket(req({ token: techToken(), params: { id: '100' }, body: {} }), {} as never);
    expect(res.status).toBe(422);
  });
});

// ===========================================================================
// Offline sync — batch apply, idempotency, mixed results
// ===========================================================================
describe('Offline sync', () => {
  beforeEach(() => queryMock.mockReset());

  it('applies a queued transit action and logs it', async () => {
    queryMock
      .mockResolvedValueOnce([])                                  // dup check → none
      .mockResolvedValueOnce([ticketRow({ status: 'ASSIGNED' })]) // findTicket
      .mockResolvedValueOnce({ affectedRows: 1 })   // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })   // history
      .mockResolvedValueOnce({ affectedRows: 1 })   // notification
      .mockResolvedValueOnce({ affectedRows: 1 })   // writeAudit
      .mockResolvedValueOnce({ affectedRows: 1 });  // sync_log INSERT
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ clientActionId: 'a1', type: 'transit', ticketId: 100, payload: {} }] } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const results = (res.jsonBody as { results: { status: string }[] }).results;
    expect(results[0].status).toBe('APPLIED');
    const logged = queryMock.mock.calls.find(([s]) => /INSERT INTO service_sync_log/i.test(String(s)));
    expect(logged).toBeDefined();
  });

  it('idempotency: a replayed clientActionId is skipped as DUPLICATE', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]); // dup check → already applied
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ clientActionId: 'a1', type: 'transit', ticketId: 100, payload: {} }] } }),
      {} as never,
    );
    const results = (res.jsonBody as { results: { status: string }[] }).results;
    expect(results[0].status).toBe('DUPLICATE');
    // No mutation queries beyond the dup check.
    const mutations = queryMock.mock.calls.filter(([s]) => /UPDATE|INSERT/i.test(String(s)));
    expect(mutations).toHaveLength(0);
  });

  it('reports an ERROR for an unknown action type without aborting the batch', async () => {
    queryMock
      .mockResolvedValueOnce([])  // dup check action 1 (unknown)
      .mockResolvedValueOnce([])  // dup check action 2 (start)
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]) // findTicket for start
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce({ affectedRows: 1 }); // sync_log INSERT
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [
        { clientActionId: 'bad', type: 'teleport', ticketId: 100, payload: {} },
        { clientActionId: 'ok', type: 'start', ticketId: 100, payload: {} },
      ] } }),
      {} as never,
    );
    const results = (res.jsonBody as { results: { status: string }[] }).results;
    expect(results[0].status).toBe('ERROR');
    expect(results[1].status).toBe('APPLIED');
  });

  it('captures a per-action ERROR when the action fails business rules', async () => {
    queryMock
      .mockResolvedValueOnce([])  // dup check
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]); // findTicket — transit invalid from IN_PROGRESS
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ clientActionId: 'x', type: 'transit', ticketId: 100, payload: {} }] } }),
      {} as never,
    );
    const results = (res.jsonBody as { results: { status: string; code?: string }[] }).results;
    expect(results[0].status).toBe('ERROR');
    expect(results[0].code).toBe('INVALID_TRANSITION');
  });

  it('rejects an action with no clientActionId', async () => {
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ type: 'transit', ticketId: 100 }] } }),
      {} as never,
    );
    const results = (res.jsonBody as { results: { status: string }[] }).results;
    expect(results[0].status).toBe('ERROR');
  });

  it('requires service.update permission', async () => {
    const res = await syncTickets(req({ token: readToken(), body: { actions: [] } }), {} as never);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Acceptance scenarios — one block mapping 1:1 to the six required behaviours.
// (These reinforce / close gaps in the focused suites above.)
// ===========================================================================
describe('Module 7 acceptance', () => {
  beforeEach(() => queryMock.mockReset());

  // ---- 1. BR-004: a reading lower than the previous one is rejected --------
  it('1) BR-004: a B/W reading below the previous reading is rejected', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ id: 20, is_colour: 0, monthly_allowance_bw: 1000, monthly_allowance_colour: null }])
      .mockResolvedValueOnce([{ reading_bw: 8000, reading_colour: null }]); // previous higher
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 7999 } }), {} as never);
    expect(res.status).toBe(422);
    expect(errCode(res)).toBe('READING_BELOW_PREVIOUS');
    // And nothing was written.
    const inserts = queryMock.mock.calls.filter(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    expect(inserts).toHaveLength(0);
  });

  // ---- 2. BR-005: delta over 3x the allowance is auto-flagged ---------------
  it('2) BR-005: a delta over 3x the monthly allowance is auto-flagged for approval', async () => {
    // allowance 500 → 3x = 1500. prev 1000, new 3000 → delta 2000 > 1500.
    queryMock
      .mockResolvedValueOnce([ticketRow()])
      .mockResolvedValueOnce([{ id: 20, is_colour: 0, monthly_allowance_bw: 500, monthly_allowance_colour: null }])
      .mockResolvedValueOnce([{ reading_bw: 1000, reading_colour: null }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })  // INSERT meter
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([ticketRow()]);                    // re-findTicket
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 3000 } }), {} as never);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { needsApproval: boolean }).needsApproval).toBe(true);
    // Stored with needs_approval = 1 and approval_status PENDING.
    const insert = queryMock.mock.calls.find(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    const params = insert![1] as unknown[];
    expect(params).toContain(1);          // needs_approval flag
    expect(params).toContain('PENDING');  // approval_status
  });

  // ---- 3. BR-006: colour printer missing B/W or colour is rejected ----------
  it('3) BR-006: a colour printer reading missing the colour value is rejected', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })])
      .mockResolvedValueOnce([{ id: 20, is_colour: 1, monthly_allowance_bw: 1000, monthly_allowance_colour: 500 }]);
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5000 } }), {} as never);
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('COLOUR_READING_REQUIRED');
  });

  it('3) BR-006: a colour printer reading missing the B/W value is rejected', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })])
      .mockResolvedValueOnce([{ id: 20, is_colour: 1, monthly_allowance_bw: 1000, monthly_allowance_colour: 500 }]);
    // readingBw omitted entirely, only colour supplied.
    const res = await meterTicket(req({ token: techToken(), params: { id: '100' }, body: { readingColour: 2000 } }), {} as never);
    expect(res.status).toBe(400);
    // No meter row written.
    const inserts = queryMock.mock.calls.filter(([s]) => /INSERT INTO meter_readings/i.test(String(s)));
    expect(inserts).toHaveLength(0);
  });

  it('3) BR-006: a colour printer reading with BOTH values is accepted', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })])
      .mockResolvedValueOnce([{ id: 20, is_colour: 1, monthly_allowance_bw: 1000, monthly_allowance_colour: 500 }])
      .mockResolvedValueOnce([])                                // no previous
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })  // INSERT meter
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([ticketRow({ printer_is_colour: 1 })]);
    const res = await meterTicket(
      req({ token: techToken(), params: { id: '100' }, body: { readingBw: 5000, readingColour: 2000 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  // ---- 4. GPS check-in records arrival time used for SLA --------------------
  it('4) GPS check-in records arrival time + coordinates on the ticket', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT', sla_due_at: '2999-01-01 00:00:00' })])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]);
    await checkInTicket(
      req({ token: techToken(), params: { id: '100' }, body: { lat: -33.9249, lng: 18.4241, occurredAt: '2026-06-18 09:30:00' } }),
      {} as never,
    );
    // The status UPDATE must persist the arrival timestamp, GPS coords and SLA flag.
    const update = queryMock.mock.calls.find(([s]) =>
      /UPDATE service_tickets/i.test(String(s)) && /checked_in_at/i.test(String(s)),
    );
    expect(update).toBeDefined();
    expect(String(update![0])).toMatch(/checkin_lat/i);
    expect(String(update![0])).toMatch(/checkin_lng/i);
    expect(String(update![0])).toMatch(/sla_met/i);
    const params = update![1] as unknown[];
    // transition() params: [toStatus, checked_in_at, lat, lng, sla_met, ticketId]
    expect(params[0]).toBe('ON_SITE');
    expect(params[1]).toBe('2026-06-18 09:30:00');   // arrival time
    expect(params[2]).toBe(-33.9249);                // lat
    expect(params[3]).toBe(18.4241);                 // lng
    expect(params[4]).toBe(1);                       // SLA met (arrival before deadline)
  });

  it('4) the recorded arrival time determines whether SLA was met', async () => {
    // Arrival after the deadline → sla_met = 0.
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_TRANSIT', sla_due_at: '2026-06-18 08:00:00' })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })]);
    const res = await checkInTicket(
      req({ token: techToken(), params: { id: '100' }, body: { lat: -33.9, lng: 18.4, occurredAt: '2026-06-18 09:30:00' } }),
      {} as never,
    );
    expect((res.jsonBody as { slaMet: boolean }).slaMet).toBe(false);
    const update = queryMock.mock.calls.find(([s]) =>
      /UPDATE service_tickets/i.test(String(s)) && /checked_in_at/i.test(String(s)),
    );
    expect((update![1] as unknown[])[4]).toBe(0); // SLA breached
  });

  // ---- 5. Closing requires signature/OTP; parts reduce inventory -----------
  it('5a) closing without signature or OTP is rejected', async () => {
    queryMock.mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })]);
    const res = await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE' } }), // no signatureName
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe('SIGNATURE_REQUIRED');
  });

  it('5a) closing persists the signature proof on the ticket', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow({ status: 'IN_PROGRESS' })])
      .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })  // history
      .mockResolvedValueOnce({ affectedRows: 1 })  // writeAudit
      .mockResolvedValueOnce([ticketRow({ status: 'CLOSED', close_method: 'SIGNATURE', signature_name: 'Jane Doe' })]);
    await closeTicket(
      req({ token: techToken(), params: { id: '100' }, body: { method: 'SIGNATURE', signatureName: 'Jane Doe', signatureImage: 'data:image/png;base64,AAA', resolutionNotes: 'Fixed the jam' } }),
      {} as never,
    );
    const update = queryMock.mock.calls.find(([s]) =>
      /UPDATE service_tickets/i.test(String(s)) && /signature_name/i.test(String(s)),
    );
    expect(update).toBeDefined();
    const params = update![1] as unknown[];
    expect(params).toContain('SIGNATURE');
    expect(params).toContain('Jane Doe');
  });

  it('5b) recording a part reduces inventory by exactly the quantity used', async () => {
    queryMock
      .mockResolvedValueOnce([ticketRow()])             // findTicket
      .mockResolvedValueOnce([{ qty_on_hand: 12 }])     // stock lookup
      .mockResolvedValueOnce({ affectedRows: 1 })       // UPDATE deduct
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // INSERT parts
      .mockResolvedValueOnce({ affectedRows: 1 })       // writeAudit
      .mockResolvedValueOnce([ticketRow()]);            // re-findTicket
    const res = await partsTicket(
      req({ token: techToken(), params: { id: '100' }, body: { consumableId: 3, warehouseId: 1, quantity: 4 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { newOnHand: number }).newOnHand).toBe(8); // 12 - 4
    const update = queryMock.mock.calls.find(([s]) => /UPDATE consumable_stock SET qty_on_hand = qty_on_hand - \?/i.test(String(s)));
    expect(update).toBeDefined();
    const params = update![1] as unknown[];
    expect(params[0]).toBe(4);  // quantity deducted
    expect(params[1]).toBe(1);  // warehouse
    expect(params[2]).toBe(3);  // consumable
  });

  // ---- 6. Offline sync replays queued work correctly (server side) ----------
  // (The mobile client's local-queue behaviour is covered by
  //  mobile/test/offline_sync_test.dart.)
  it('6) a queued offline action is applied exactly once and logged', async () => {
    queryMock
      .mockResolvedValueOnce([])                                  // dup check → not seen
      .mockResolvedValueOnce([ticketRow({ status: 'ON_SITE' })])  // findTicket
      .mockResolvedValueOnce({ affectedRows: 1 })   // UPDATE (start)
      .mockResolvedValueOnce({ affectedRows: 1 })   // history
      .mockResolvedValueOnce({ affectedRows: 1 })   // writeAudit
      .mockResolvedValueOnce({ affectedRows: 1 });  // sync_log INSERT
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ clientActionId: 'field-1', type: 'start', ticketId: 100, payload: {} }] } }),
      {} as never,
    );
    const results = (res.jsonBody as { results: { status: string }[] }).results;
    expect(results[0].status).toBe('APPLIED');
    // It was recorded in the idempotency ledger under its clientActionId.
    const logged = queryMock.mock.calls.find(([s]) => /INSERT INTO service_sync_log/i.test(String(s)));
    expect((logged![1] as unknown[])[0]).toBe('field-1');
  });

  it('6) replaying the same offline action does not apply it twice (idempotent)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]); // dup check → already applied
    const res = await syncTickets(
      req({ token: techToken(), body: { actions: [{ clientActionId: 'field-1', type: 'start', ticketId: 100, payload: {} }] } }),
      {} as never,
    );
    expect((res.jsonBody as { results: { status: string }[] }).results[0].status).toBe('DUPLICATE');
    // No UPDATE/INSERT mutations beyond the duplicate check.
    const mutations = queryMock.mock.calls.filter(([s]) => /UPDATE|INSERT/i.test(String(s)));
    expect(mutations).toHaveLength(0);
  });
});

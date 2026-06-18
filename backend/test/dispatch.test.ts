/**
 * Dispatch & Delivery Management — endpoint tests.
 *
 * All real handlers run; only the DB layer is mocked.
 *
 * Mock-call sequence per endpoint is documented inline.
 * writeAudit always adds one extra query() call (INSERT into audit_logs).
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
  listDispatchOrders,
  getDispatchOrder,
  createDispatchOrder,
  updateDispatchOrder,
  scheduleDispatch,
  departDispatch,
  deliverDispatch,
  cancelDispatch,
} from '../src/functions/dispatch';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERMS_ALL = ['dispatch.read', 'dispatch.create', 'dispatch.update', 'dispatch.deliver'];

function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: PERMS_ALL });
}
function readToken() {
  return issueToken({ sub: 5, email: 'sales@websol.local', role: 'SALES_REP', perms: ['dispatch.read'] });
}
function coordinatorToken() {
  return issueToken({ sub: 7, email: 'coord@websol.local', role: 'DISPATCH_COORDINATOR', perms: PERMS_ALL });
}

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
  const qmap = new Map<string, string>(Object.entries(opts.query ?? {}));
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => qmap.get(k) ?? null },
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

function orderRow(extra: Record<string, unknown> = {}) {
  return {
    id: 10,
    order_no: 'DSP-2026-0001',
    contract_id: 2,
    contract_no: 'CTR-2026-0001',
    customer_id: 1,
    customer_name: 'Acme Corp',
    site_id: null,
    site_name: null,
    site_address: null,
    site_city: null,
    status: 'PENDING',
    planned_date: null,
    courier: null,
    tracking_ref: null,
    departed_at: null,
    delivered_at: null,
    pod_recipient: null,
    pod_notes: null,
    notes: null,
    created_by: 1,
    created_by_name: 'Admin User',
    created_at: '2026-01-01T08:00:00.000Z',
    updated_at: '2026-01-01T08:00:00.000Z',
    ...extra,
  };
}

function itemRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    printer_id: 20,
    serial_no: 'SN-020',
    brand: 'Kyocera',
    model: 'M4125idn',
    asset_no: 'ASS-020',
    printer_status: 'ALLOCATED',
    notes: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// listDispatchOrders
// ---------------------------------------------------------------------------
describe('listDispatchOrders', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with order list', async () => {
    queryMock.mockResolvedValueOnce([orderRow()]);
    const res = await listDispatchOrders(req({ token: adminToken() }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { orders: { orderNo: string }[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].orderNo).toBe('DSP-2026-0001');
  });

  it('filters by status when ?status= is provided', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })]);
    const res = await listDispatchOrders(
      req({ token: adminToken(), query: { status: 'SCHEDULED' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/AND o\.status IN/);
  });

  it('ignores invalid status values in filter', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await listDispatchOrders(
      req({ token: adminToken(), query: { status: 'BOGUS' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    // no IN clause added when status was rejected
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toMatch(/AND o\.status IN/);
  });

  it('returns 401 without token', async () => {
    const res = await listDispatchOrders(req(), {} as never);
    expect(res.status).toBe(401);
  });

  it('returns 403 without dispatch.read permission', async () => {
    const token = issueToken({ sub: 3, email: 'x@y.com', role: 'CEO', perms: [] });
    const res = await listDispatchOrders(req({ token }), {} as never);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// getDispatchOrder
// ---------------------------------------------------------------------------
describe('getDispatchOrder', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with order and items', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow()])   // findOrder
      .mockResolvedValueOnce([itemRow()]);   // fetchItems

    const res = await getDispatchOrder(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { orderNo: string }; items: { serialNo: string }[] };
    expect(body.order.orderNo).toBe('DSP-2026-0001');
    expect(body.items[0].serialNo).toBe('SN-020');
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await getDispatchOrder(req({ token: adminToken(), params: { id: '999' } }), {} as never);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await getDispatchOrder(req({ token: adminToken(), params: { id: 'abc' } }), {} as never);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// createDispatchOrder
// ---------------------------------------------------------------------------
describe('createDispatchOrder', () => {
  beforeEach(() => queryMock.mockReset());

  // Sequence: contract check → printer 1 check → active dispatch check (printer 1) → COUNT → INSERT order → INSERT item → writeAudit → findOrder → fetchItems
  function setupCreate(printerIds = [20]) {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }]) // contract
    for (const pid of printerIds) {
      queryMock
        .mockResolvedValueOnce([{ id: pid, status: 'ALLOCATED', serial_no: `SN-0${pid}` }]) // printer
        .mockResolvedValueOnce([])                                                           // no active dispatch
    }
    queryMock
      .mockResolvedValueOnce([{ cnt: 0 }])                     // COUNT for order_no
      .mockResolvedValueOnce({ insertId: 10, affectedRows: 1 }) // INSERT order
    for (let i = 0; i < printerIds.length; i++) {
      queryMock.mockResolvedValueOnce({ insertId: i + 1, affectedRows: 1 }) // INSERT item
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })              // writeAudit
      .mockResolvedValueOnce([orderRow()])                     // findOrder
      .mockResolvedValueOnce(printerIds.map((pid, i) => itemRow({ id: i + 1, printer_id: pid }))); // fetchItems
  }

  it('creates an order and returns 201', async () => {
    setupCreate();
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = res.jsonBody as { order: { orderNo: string }; items: unknown[] };
    expect(body.order.orderNo).toBe('DSP-2026-0001');
    expect(body.items).toHaveLength(1);
  });

  it('generates correct order number from COUNT seq=0 → DSP-YYYY-0001', async () => {
    setupCreate();
    await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO dispatch_orders/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const orderNoArg = (insertCall![1] as unknown[])[0] as string;
    expect(orderNoArg).toMatch(/^DSP-\d{4}-0001$/);
  });

  it('generates seq=0006 when COUNT returns 5', async () => {
    // Replace the COUNT mock slot with cnt=5
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }]) // contract
      .mockResolvedValueOnce([{ id: 20, status: 'ALLOCATED', serial_no: 'SN-020' }])       // printer
      .mockResolvedValueOnce([])                                                             // no active dispatch
      .mockResolvedValueOnce([{ cnt: 5 }])                                                  // COUNT → seq 6
      .mockResolvedValueOnce({ insertId: 10, affectedRows: 1 })                             // INSERT order
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })                              // INSERT item
      .mockResolvedValueOnce({ affectedRows: 1 })                                           // writeAudit
      .mockResolvedValueOnce([orderRow()])                                                   // findOrder
      .mockResolvedValueOnce([itemRow()]);                                                   // fetchItems

    await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO dispatch_orders/i.test(String(sql)),
    );
    const orderNoArg = (insertCall![1] as unknown[])[0] as string;
    expect(orderNoArg).toMatch(/^DSP-\d{4}-0006$/);
  });

  it('creates multiple items for multiple printers', async () => {
    setupCreate([20, 21]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20, 21] } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const itemInserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO dispatch_order_items/i.test(String(sql)),
    );
    expect(itemInserts).toHaveLength(2);
  });

  it('returns 400 (NO_PRINTERS) when printerIds is empty', async () => {
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [] } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('NO_PRINTERS');
  });

  it('returns 400 when printerIds is missing', async () => {
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2 } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when contractId is missing', async () => {
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when contract does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 999, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 (CONTRACT_NOT_ACTIVE) when contract is DRAFT', async () => {
    queryMock.mockResolvedValueOnce([{ id: 2, status: 'DRAFT', contract_no: 'CTR-2026-0001' }]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('CONTRACT_NOT_ACTIVE');
  });

  it('returns 404 when printer does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }]) // contract
      .mockResolvedValueOnce([]);                                                            // printer not found
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [999] } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 (PRINTER_NOT_ALLOCATED) when printer status is IN_STOCK — BR-020', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }]) // contract
      .mockResolvedValueOnce([{ id: 20, status: 'IN_STOCK', serial_no: 'SN-020' }]);      // printer not ALLOCATED
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
  });

  it.each(['ORDERED', 'IN_TRANSIT', 'RECEIVED', 'QC_PASS', 'QC_FAIL',
    'IN_STOCK', 'DISPATCHED', 'INSTALLED', 'UNDER_REPAIR', 'RETIRED'] as const)(
    'BR-020 rejects printer in %s status',
    async (status) => {
      queryMock
        .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
        .mockResolvedValueOnce([{ id: 20, status, serial_no: 'SN-020' }]);
      const res = await createDispatchOrder(
        req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
    },
  );

  it('returns 409 (PRINTER_ALREADY_DISPATCHING) — BR-025', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }]) // contract
      .mockResolvedValueOnce([{ id: 20, status: 'ALLOCATED', serial_no: 'SN-020' }])      // printer OK
      .mockResolvedValueOnce([{ id: 5 }]);                                                  // already on active order
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_ALREADY_DISPATCHING');
  });

  it('returns 403 when caller lacks dispatch.create', async () => {
    const res = await createDispatchOrder(
      req({ token: readToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// updateDispatchOrder
// ---------------------------------------------------------------------------
describe('updateDispatchOrder', () => {
  beforeEach(() => queryMock.mockReset());

  function setupUpdate(status = 'PENDING') {
    queryMock
      .mockResolvedValueOnce([orderRow({ status })])            // findOrder
      .mockResolvedValueOnce({ affectedRows: 1 })               // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([orderRow({ status, courier: 'FedEx' })]) // re-findOrder
      .mockResolvedValueOnce([itemRow()]);                       // fetchItems
  }

  it('updates courier on a PENDING order, returns 200', async () => {
    setupUpdate('PENDING');
    const res = await updateDispatchOrder(
      req({ token: adminToken(), params: { id: '10' }, body: { courier: 'FedEx' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { courier: string } };
    expect(body.order.courier).toBe('FedEx');
  });

  it('updates notes on a SCHEDULED order, returns 200', async () => {
    setupUpdate('SCHEDULED');
    const res = await updateDispatchOrder(
      req({ token: adminToken(), params: { id: '10' }, body: { notes: 'Handle with care' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await updateDispatchOrder(
      req({ token: adminToken(), params: { id: '99' }, body: { notes: 'x' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 (ORDER_NOT_EDITABLE) when order is IN_TRANSIT', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT' })]);
    const res = await updateDispatchOrder(
      req({ token: adminToken(), params: { id: '10' }, body: { courier: 'DHL' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ORDER_NOT_EDITABLE');
  });

  it('returns 400 when no changes supplied', async () => {
    queryMock.mockResolvedValueOnce([orderRow()]);
    const res = await updateDispatchOrder(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// scheduleDispatch  PENDING → SCHEDULED
// ---------------------------------------------------------------------------
describe('scheduleDispatch', () => {
  beforeEach(() => queryMock.mockReset());

  function setupSchedule() {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'PENDING' })])      // findOrder
      .mockResolvedValueOnce({ affectedRows: 1 })                     // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })                     // writeAudit
      .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])    // re-findOrder
      .mockResolvedValueOnce([itemRow()]);                             // fetchItems
  }

  it('transitions PENDING → SCHEDULED and returns 200', async () => {
    setupSchedule();
    const res = await scheduleDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { plannedDate: '2026-07-01', courier: 'DHL' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { status: string } };
    expect(body.order.status).toBe('SCHEDULED');
  });

  it('UPDATE SQL sets status=SCHEDULED with planned date', async () => {
    setupSchedule();
    await scheduleDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { plannedDate: '2026-07-01' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) => /UPDATE dispatch_orders SET status = 'SCHEDULED'/i.test(String(sql)));
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as unknown[])[0]).toBe('2026-07-01');
  });

  it('returns 400 when plannedDate is missing', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'PENDING' })]);
    const res = await scheduleDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 422 (INVALID_TRANSITION) when order is already SCHEDULED', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })]);
    const res = await scheduleDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { plannedDate: '2026-07-01' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await scheduleDispatch(
      req({ token: adminToken(), params: { id: '999' }, body: { plannedDate: '2026-07-01' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// departDispatch  SCHEDULED → IN_TRANSIT
// ---------------------------------------------------------------------------
describe('departDispatch', () => {
  beforeEach(() => queryMock.mockReset());

  function setupDepart(printers = [itemRow()]) {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])  // findOrder
      .mockResolvedValueOnce(printers)                              // fetchItems
    for (const p of printers) {
      queryMock
        .mockResolvedValueOnce({ affectedRows: 1 })                // UPDATE printer → DISPATCHED
        .mockResolvedValueOnce({ affectedRows: 1 })                // INSERT history
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })                  // UPDATE order → IN_TRANSIT
      .mockResolvedValueOnce({ affectedRows: 1 })                  // writeAudit
      .mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT' })]) // re-findOrder
      .mockResolvedValueOnce([...printers.map((p) => ({ ...p, printer_status: 'DISPATCHED' }))]) // fetchItems
  }

  it('transitions SCHEDULED → IN_TRANSIT and returns 200', async () => {
    setupDepart();
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { status: string } };
    expect(body.order.status).toBe('IN_TRANSIT');
  });

  it('updates each printer to DISPATCHED', async () => {
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const printerUpdates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'DISPATCHED'/i.test(String(sql)),
    );
    expect(printerUpdates).toHaveLength(1);
    expect((printerUpdates[0][1] as unknown[])[0]).toBe(20); // printer_id
  });

  it('writes a history row ALLOCATED → DISPATCHED for each printer', async () => {
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const histRows = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /ALLOCATED.*DISPATCHED/i.test(String(sql)),
    );
    expect(histRows).toHaveLength(1);
  });

  it('processes two printers: two UPDATE and two history rows', async () => {
    const items = [itemRow(), itemRow({ id: 2, printer_id: 21, serial_no: 'SN-021' })];
    setupDepart(items);
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(200);
    const updates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'DISPATCHED'/i.test(String(sql)),
    );
    expect(updates).toHaveLength(2);
  });

  it('reason contains the order number', async () => {
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)),
    );
    // params: [printer_id, reason, changed_by]
    const reason = (histCall![1] as unknown[])[1] as string;
    expect(reason).toMatch(/DSP-2026-0001/);
  });

  it('returns 422 (INVALID_TRANSITION) when order is PENDING not SCHEDULED', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'PENDING' })])
      .mockResolvedValueOnce([itemRow()]);
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('returns 422 (PRINTER_NOT_ALLOCATED) when printer is no longer ALLOCATED', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])
      .mockResolvedValueOnce([itemRow({ printer_status: 'IN_STOCK' })]);
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await departDispatch(req({ token: adminToken(), params: { id: '999' } }), {} as never);
    expect(res.status).toBe(404);
  });

  it('requires dispatch.deliver permission', async () => {
    const res = await departDispatch(req({ token: readToken(), params: { id: '10' } }), {} as never);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// deliverDispatch  IN_TRANSIT → DELIVERED
// ---------------------------------------------------------------------------
describe('deliverDispatch', () => {
  beforeEach(() => queryMock.mockReset());

  function setupDeliver(printers = [itemRow({ printer_status: 'DISPATCHED' })]) {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT' })])  // findOrder
      .mockResolvedValueOnce(printers)                               // fetchItems
    for (const p of printers) {
      queryMock
        .mockResolvedValueOnce({ affectedRows: 1 })                 // UPDATE printer → INSTALLED
        .mockResolvedValueOnce({ affectedRows: 1 })                 // INSERT history
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })                   // UPDATE order → DELIVERED
      .mockResolvedValueOnce({ affectedRows: 1 })                   // writeAudit
      .mockResolvedValueOnce([orderRow({ status: 'DELIVERED', pod_recipient: 'Jane Doe' })]) // re-findOrder
      .mockResolvedValueOnce([...printers.map((p) => ({ ...p, printer_status: 'INSTALLED' }))]) // fetchItems
  }

  it('transitions IN_TRANSIT → DELIVERED and returns 200', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { status: string; podRecipient: string } };
    expect(body.order.status).toBe('DELIVERED');
    expect(body.order.podRecipient).toBe('Jane Doe');
  });

  it('updates each printer to INSTALLED', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const installed = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'INSTALLED'/i.test(String(sql)),
    );
    expect(installed).toHaveLength(1);
  });

  it('writes history row DISPATCHED → INSTALLED with POD recipient in reason', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /DISPATCHED.*INSTALLED/i.test(String(sql)),
    );
    expect(histCall).toBeDefined();
    // params: [printer_id, reason, changed_by]
    const reason = (histCall![1] as unknown[])[1] as string;
    expect(reason).toMatch(/Jane Doe/);
  });

  it('UPDATE order includes pod_recipient', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe', podNotes: 'Fragile' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params).toContain('Jane Doe');
    expect(params).toContain('Fragile');
  });

  it('returns 400 when podRecipient is missing', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT' })])
      .mockResolvedValueOnce([itemRow({ printer_status: 'DISPATCHED' })]);
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 422 (INVALID_TRANSITION) when order is already DELIVERED', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'DELIVERED' })]);
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Bob' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '999' }, body: { podRecipient: 'Bob' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// cancelDispatch  PENDING | SCHEDULED | IN_TRANSIT → CANCELLED
// ---------------------------------------------------------------------------
describe('cancelDispatch', () => {
  beforeEach(() => queryMock.mockReset());

  function setupCancel(status = 'PENDING', printers: ReturnType<typeof itemRow>[] = []) {
    queryMock.mockResolvedValueOnce([orderRow({ status })]);       // findOrder
    if (status === 'IN_TRANSIT') {
      queryMock.mockResolvedValueOnce(printers);                    // fetchItems
      for (const p of printers) {
        if (p.printer_status === 'DISPATCHED') {
          queryMock
            .mockResolvedValueOnce({ affectedRows: 1 })            // UPDATE printer → ALLOCATED
            .mockResolvedValueOnce({ affectedRows: 1 });           // INSERT history
        }
      }
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })                  // UPDATE order → CANCELLED
      .mockResolvedValueOnce({ affectedRows: 1 })                  // writeAudit
      .mockResolvedValueOnce([orderRow({ status: 'CANCELLED' })])  // re-findOrder
      .mockResolvedValueOnce([]);                                   // fetchItems
  }

  it('cancels a PENDING order and returns 200', async () => {
    setupCancel('PENDING');
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { order: { status: string } };
    expect(body.order.status).toBe('CANCELLED');
  });

  it('cancels a SCHEDULED order and returns 200', async () => {
    setupCancel('SCHEDULED');
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('cancels an IN_TRANSIT order and reverts DISPATCHED printer to ALLOCATED', async () => {
    const items = [itemRow({ printer_status: 'DISPATCHED' })];
    setupCancel('IN_TRANSIT', items);
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { reason: 'Customer cancelled' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const revertUpdates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'ALLOCATED'/i.test(String(sql)),
    );
    expect(revertUpdates).toHaveLength(1);
  });

  it('writes history DISPATCHED → ALLOCATED with reason on cancel', async () => {
    const items = [itemRow({ printer_status: 'DISPATCHED' })];
    setupCancel('IN_TRANSIT', items);
    await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { reason: 'Customer cancelled' } }),
      {} as never,
    );
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /DISPATCHED.*ALLOCATED/i.test(String(sql)),
    );
    expect(histCall).toBeDefined();
    // params: [printer_id, reason, changed_by]
    const reason = (histCall![1] as unknown[])[1] as string;
    expect(reason).toMatch(/Customer cancelled/);
  });

  it('does not revert printers that are not DISPATCHED', async () => {
    // Printer already installed (edge case — should not happen in normal flow, but guard it)
    const items = [itemRow({ printer_status: 'INSTALLED' })];
    setupCancel('IN_TRANSIT', items);
    await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    const revertUpdates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'ALLOCATED'/i.test(String(sql)),
    );
    expect(revertUpdates).toHaveLength(0);
  });

  it('returns 422 (INVALID_TRANSITION) when order is already DELIVERED', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'DELIVERED' })]);
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('returns 422 (INVALID_TRANSITION) when order is already CANCELLED', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'CANCELLED' })]);
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(422);
  });

  it('returns 404 when order not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await cancelDispatch(
      req({ token: adminToken(), params: { id: '999' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller lacks dispatch.update', async () => {
    const token = issueToken({ sub: 9, email: 'x@y.com', role: 'CEO', perms: ['dispatch.read'] });
    const res = await cancelDispatch(
      req({ token, params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });

  it('coordinator can cancel orders', async () => {
    setupCancel('PENDING');
    const res = await cancelDispatch(
      req({ token: coordinatorToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// BR-020 — exhaustive: only ALLOCATED printers may be dispatched
// ===========================================================================

describe('BR-020 (exhaustive)', () => {
  beforeEach(() => queryMock.mockReset());

  // 10 statuses are already covered by the it.each in createDispatchOrder.
  // These 3 are missing from that matrix.
  it.each(['REPLACEMENT_OUT', 'RETURNED', 'REFURBISHED'] as const)(
    'createDispatchOrder rejects printer in %s status',
    async (status) => {
      queryMock
        .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
        .mockResolvedValueOnce([{ id: 20, status, serial_no: 'SN-020' }]);
      const res = await createDispatchOrder(
        req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
    },
  );

  it('error message includes the printer serial number', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
      .mockResolvedValueOnce([{ id: 20, status: 'IN_STOCK', serial_no: 'SN-BADGUY' }]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toMatch(/SN-BADGUY/);
  });

  it('error message includes the rejected printer status', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
      .mockResolvedValueOnce([{ id: 20, status: 'RECEIVED', serial_no: 'SN-020' }]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toMatch(/RECEIVED/);
  });

  it('no INSERT into dispatch_orders fires when a printer is rejected', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
      .mockResolvedValueOnce([{ id: 20, status: 'DISPATCHED', serial_no: 'SN-020' }]);
    await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    const inserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO dispatch_orders/i.test(String(sql)),
    );
    expect(inserts).toHaveLength(0);
  });

  it('no INSERT into dispatch_order_items fires when a printer is rejected', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
      .mockResolvedValueOnce([{ id: 20, status: 'UNDER_REPAIR', serial_no: 'SN-020' }]);
    await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20] } }),
      {} as never,
    );
    const inserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO dispatch_order_items/i.test(String(sql)),
    );
    expect(inserts).toHaveLength(0);
  });

  it('rejects entire order when first printer passes but second fails — BR-020', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 2, status: 'ACTIVE', contract_no: 'CTR-2026-0001' }])
      // printer 20 → OK
      .mockResolvedValueOnce([{ id: 20, status: 'ALLOCATED', serial_no: 'SN-020' }])
      .mockResolvedValueOnce([])                                                         // no active dispatch
      // printer 21 → rejected
      .mockResolvedValueOnce([{ id: 21, status: 'INSTALLED', serial_no: 'SN-021' }]);
    const res = await createDispatchOrder(
      req({ token: adminToken(), body: { contractId: 2, printerIds: [20, 21] } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
    // No order should have been inserted.
    const orderInserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO dispatch_orders/i.test(String(sql)),
    );
    expect(orderInserts).toHaveLength(0);
  });

  // At depart time, a printer may have changed status since the order was created.
  // All non-ALLOCATED statuses must be rejected.
  it.each([
    'ORDERED', 'IN_TRANSIT', 'RECEIVED', 'QC_PASS', 'QC_FAIL',
    'IN_STOCK', 'DISPATCHED', 'INSTALLED', 'UNDER_REPAIR',
    'REPLACEMENT_OUT', 'RETURNED', 'REFURBISHED', 'RETIRED',
  ] as const)(
    'departDispatch blocks departure when printer status changed to %s after order creation',
    async (status) => {
      queryMock
        .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])
        .mockResolvedValueOnce([itemRow({ printer_status: status })]);
      const res = await departDispatch(
        req({ token: adminToken(), params: { id: '10' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
    },
  );

  it('depart-time error message lists the offending serial numbers', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])
      .mockResolvedValueOnce([
        itemRow({ printer_status: 'IN_STOCK', serial_no: 'SN-BAD1' }),
        itemRow({ id: 2, printer_id: 21, serial_no: 'SN-BAD2', printer_status: 'RECEIVED' }),
      ]);
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toMatch(/SN-BAD1/);
    expect(msg).toMatch(/SN-BAD2/);
  });

  it('no UPDATE printers fires when departure is blocked', async () => {
    queryMock
      .mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })])
      .mockResolvedValueOnce([itemRow({ printer_status: 'INSTALLED' })]);
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const updates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers/i.test(String(sql)),
    );
    expect(updates).toHaveLength(0);
  });
});

// ===========================================================================
// Dispatch confirmation — depart sets printers to DISPATCHED
// ===========================================================================

describe('Dispatch confirmation (departDispatch)', () => {
  beforeEach(() => queryMock.mockReset());

  function setupDepart(printers = [itemRow()]) {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'SCHEDULED' })]);
    queryMock.mockResolvedValueOnce(printers);
    for (const p of printers) {
      void p;
      queryMock
        .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE printer
        .mockResolvedValueOnce({ affectedRows: 1 }); // INSERT history
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })                   // UPDATE order
      .mockResolvedValueOnce({ affectedRows: 1 })                   // writeAudit
      .mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT', departed_at: '2026-06-18 10:00:00' })])
      .mockResolvedValueOnce(printers.map((p) => ({ ...p, printer_status: 'DISPATCHED' })));
  }

  it('UPDATE printers SQL targets the correct printer_id from the order item', async () => {
    setupDepart([itemRow({ printer_id: 42, serial_no: 'SN-042' })]);
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE printers SET status = 'DISPATCHED'/i.test(String(sql)),
    );
    expect(updateCall).toBeDefined();
    // params: [printer_id]
    expect((updateCall![1] as unknown[])[0]).toBe(42);
  });

  it('two printers: each UPDATE targets the correct distinct printer_id', async () => {
    const items = [
      itemRow({ id: 1, printer_id: 30, serial_no: 'SN-030' }),
      itemRow({ id: 2, printer_id: 31, serial_no: 'SN-031' }),
    ];
    setupDepart(items);
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const updates = queryMock.mock.calls
      .filter(([sql]) => /UPDATE printers SET status = 'DISPATCHED'/i.test(String(sql)))
      .map(([, params]) => (params as unknown[])[0]);
    expect(updates).toContain(30);
    expect(updates).toContain(31);
  });

  it('UPDATE dispatch_orders SQL contains departed_at = NOW()', async () => {
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const orderUpdate = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders SET status = 'IN_TRANSIT'/i.test(String(sql)),
    );
    expect(orderUpdate).toBeDefined();
    expect(String(orderUpdate![0])).toMatch(/departed_at\s*=\s*NOW\(\)/i);
  });

  it('UPDATE dispatch_orders targets the correct order id', async () => {
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const orderUpdate = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders SET status = 'IN_TRANSIT'/i.test(String(sql)),
    );
    // params: [id]
    expect((orderUpdate![1] as unknown[])[0]).toBe(10);
  });

  it('response items all carry printerStatus = DISPATCHED', async () => {
    setupDepart();
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const body = res.jsonBody as { items: { printerStatus: string }[] };
    expect(body.items.every((i) => i.printerStatus === 'DISPATCHED')).toBe(true);
  });

  it('history INSERT changed_by matches the JWT sub', async () => {
    // adminToken has sub:1
    setupDepart();
    await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)),
    );
    // params: [printer_id, reason, changed_by]
    expect((histCall![1] as unknown[])[2]).toBe(1);
  });

  it('coordinator token: changed_by is the coordinator user id (7)', async () => {
    setupDepart();
    await departDispatch(req({ token: coordinatorToken(), params: { id: '10' } }), {} as never);
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)),
    );
    expect((histCall![1] as unknown[])[2]).toBe(7);
  });

  it('response order has departedAt set', async () => {
    setupDepart();
    const res = await departDispatch(req({ token: adminToken(), params: { id: '10' } }), {} as never);
    const body = res.jsonBody as { order: { departedAt: string | null } };
    expect(body.order.departedAt).not.toBeNull();
  });
});

// ===========================================================================
// Status flow — transitions are only valid in the defined lifecycle order
// ===========================================================================

describe('Status flow', () => {
  beforeEach(() => queryMock.mockReset());

  // schedule: only PENDING is a valid source.
  it.each(['SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const)(
    'scheduleDispatch rejects an order already in %s status',
    async (status) => {
      queryMock.mockResolvedValueOnce([orderRow({ status })]);
      const res = await scheduleDispatch(
        req({ token: adminToken(), params: { id: '10' }, body: { plannedDate: '2026-08-01' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    },
  );

  // depart: only SCHEDULED is a valid source.
  it.each(['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const)(
    'departDispatch rejects an order in %s status',
    async (status) => {
      queryMock.mockResolvedValueOnce([orderRow({ status })]);
      const res = await departDispatch(
        req({ token: adminToken(), params: { id: '10' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    },
  );

  // deliver: only IN_TRANSIT is a valid source.
  it.each(['PENDING', 'SCHEDULED', 'DELIVERED', 'CANCELLED'] as const)(
    'deliverDispatch rejects an order in %s status',
    async (status) => {
      queryMock.mockResolvedValueOnce([orderRow({ status })]);
      const res = await deliverDispatch(
        req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Bob' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    },
  );

  // cancel: DELIVERED and CANCELLED are terminal — cannot be cancelled.
  it.each(['DELIVERED', 'CANCELLED'] as const)(
    'cancelDispatch rejects an order in terminal %s status',
    async (status) => {
      queryMock.mockResolvedValueOnce([orderRow({ status })]);
      const res = await cancelDispatch(
        req({ token: adminToken(), params: { id: '10' }, body: {} }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    },
  );

  // update (PATCH): only PENDING and SCHEDULED may be edited.
  it.each(['IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const)(
    'updateDispatchOrder rejects editing an order in %s status',
    async (status) => {
      queryMock.mockResolvedValueOnce([orderRow({ status })]);
      const res = await updateDispatchOrder(
        req({ token: adminToken(), params: { id: '10' }, body: { courier: 'DHL' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ORDER_NOT_EDITABLE');
    },
  );

  // Verify all error responses carry the INVALID_TRANSITION / ORDER_NOT_EDITABLE code,
  // not a generic 500.
  it('scheduleDispatch error response has INVALID_TRANSITION code not a server error', async () => {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'DELIVERED' })]);
    const res = await scheduleDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { plannedDate: '2026-08-01' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect(res.status).not.toBe(500);
  });
});

// ===========================================================================
// Proof of delivery — stored on DELIVERED, all fields captured
// ===========================================================================

describe('Proof of delivery', () => {
  beforeEach(() => queryMock.mockReset());

  function setupDeliver(
    printers = [itemRow({ printer_status: 'DISPATCHED' })],
    orderOverride: Record<string, unknown> = {},
  ) {
    queryMock.mockResolvedValueOnce([orderRow({ status: 'IN_TRANSIT', ...orderOverride })]);
    queryMock.mockResolvedValueOnce(printers);
    for (const p of printers) {
      void p;
      queryMock
        .mockResolvedValueOnce({ affectedRows: 1 })  // UPDATE printer → INSTALLED
        .mockResolvedValueOnce({ affectedRows: 1 }); // INSERT history
    }
    queryMock
      .mockResolvedValueOnce({ affectedRows: 1 })   // UPDATE order → DELIVERED
      .mockResolvedValueOnce({ affectedRows: 1 })   // writeAudit
      .mockResolvedValueOnce([orderRow({
        status: 'DELIVERED',
        pod_recipient: 'Jane Doe',
        pod_notes: 'Left at reception',
        delivered_at: '2026-06-18 14:30:00',
        ...orderOverride,
      })])
      .mockResolvedValueOnce(printers.map((p) => ({ ...p, printer_status: 'INSTALLED' })));
  }

  it('podNotes is optional — returns 200 when omitted', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  it('UPDATE SQL params contain podRecipient at position [1]', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    expect(updateCall).toBeDefined();
    // params: [deliveredAt, podRecipient, podNotes, id]
    expect((updateCall![1] as unknown[])[1]).toBe('Jane Doe');
  });

  it('UPDATE SQL params contain podNotes at position [2]', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe', podNotes: 'Left at reception' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    expect((updateCall![1] as unknown[])[2]).toBe('Left at reception');
  });

  it('podNotes is null in UPDATE SQL when not supplied', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    // podNotes not provided → str(undefined) returns null
    expect((updateCall![1] as unknown[])[2]).toBeNull();
  });

  it('custom deliveredAt from body is passed to the UPDATE SQL at position [0]', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe', deliveredAt: '2026-06-18 09:00:00' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    expect((updateCall![1] as unknown[])[0]).toBe('2026-06-18 09:00:00');
  });

  it('deliveredAt defaults to a timestamp string when not supplied in body', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    const deliveredAt = (updateCall![1] as unknown[])[0] as string;
    // Should be a non-empty string (defaulted to NOW())
    expect(typeof deliveredAt).toBe('string');
    expect(deliveredAt.length).toBeGreaterThan(0);
  });

  it('response order has deliveredAt set', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const body = res.jsonBody as { order: { deliveredAt: string | null } };
    expect(body.order.deliveredAt).not.toBeNull();
  });

  it('response order has podRecipient set', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const body = res.jsonBody as { order: { podRecipient: string | null } };
    expect(body.order.podRecipient).toBe('Jane Doe');
  });

  it('response order has podNotes set', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe', podNotes: 'Left at reception' } }),
      {} as never,
    );
    const body = res.jsonBody as { order: { podNotes: string | null } };
    expect(body.order.podNotes).toBe('Left at reception');
  });

  it('two printers: both updated to INSTALLED', async () => {
    const items = [
      itemRow({ id: 1, printer_id: 50, serial_no: 'SN-050', printer_status: 'DISPATCHED' }),
      itemRow({ id: 2, printer_id: 51, serial_no: 'SN-051', printer_status: 'DISPATCHED' }),
    ];
    setupDeliver(items);
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const installedUpdates = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE printers SET status = 'INSTALLED'/i.test(String(sql)),
    );
    expect(installedUpdates).toHaveLength(2);
    // params: [current_site_id (COALESCE arg), printer_id]
    const ids = installedUpdates.map(([, params]) => (params as unknown[])[1]);
    expect(ids).toContain(50);
    expect(ids).toContain(51);
  });

  it('two printers: two history rows written DISPATCHED → INSTALLED', async () => {
    const items = [
      itemRow({ id: 1, printer_id: 50, serial_no: 'SN-050', printer_status: 'DISPATCHED' }),
      itemRow({ id: 2, printer_id: 51, serial_no: 'SN-051', printer_status: 'DISPATCHED' }),
    ];
    setupDeliver(items);
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const histRows = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /DISPATCHED.*INSTALLED/i.test(String(sql)),
    );
    expect(histRows).toHaveLength(2);
  });

  it('history reason includes both the order number and the POD recipient name', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /DISPATCHED.*INSTALLED/i.test(String(sql)),
    );
    // params: [printer_id, reason, changed_by]
    const reason = (histCall![1] as unknown[])[1] as string;
    expect(reason).toMatch(/DSP-2026-0001/);
    expect(reason).toMatch(/Jane Doe/);
  });

  it('history INSERT changed_by is the JWT sub', async () => {
    // adminToken has sub:1
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const histCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO printer_status_history/i.test(String(sql)) &&
      /DISPATCHED.*INSTALLED/i.test(String(sql)),
    );
    // params: [printer_id, reason, changed_by]
    expect((histCall![1] as unknown[])[2]).toBe(1);
  });

  it('response items carry printerStatus = INSTALLED after delivery', async () => {
    setupDeliver();
    const res = await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const body = res.jsonBody as { items: { printerStatus: string }[] };
    expect(body.items.every((i) => i.printerStatus === 'INSTALLED')).toBe(true);
  });

  it('UPDATE dispatch_orders targets the correct order id at position [3]', async () => {
    setupDeliver();
    await deliverDispatch(
      req({ token: adminToken(), params: { id: '10' }, body: { podRecipient: 'Jane Doe' } }),
      {} as never,
    );
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE dispatch_orders/i.test(String(sql)) && /pod_recipient/i.test(String(sql)),
    );
    // params: [deliveredAt, podRecipient, podNotes, id]
    expect((updateCall![1] as unknown[])[3]).toBe(10);
  });
});

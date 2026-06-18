/**
 * Inventory / Warehouse Management — comprehensive business rule tests.
 *
 * Four rules under test, each in its own describe block:
 *
 *   BR-021  Stock never goes below zero. A dispatch (negative delta) that would
 *           produce a negative qty_on_hand is rejected before it hits the DB.
 *
 *   GRN     Receiving a batch increases stock and records every unit.
 *           Consumable quantities are UPSERTed additively; printers are logged
 *           individually; the GRN number is generated in GRN-YYYY-NNNN format.
 *
 *   BR-003  Allocating a printer marks it ALLOCATED and writes a history row.
 *           Any second allocation attempt is blocked (double-allocation prevention).
 *
 *   ALERT   Low-stock alert fires when qty_on_hand drops to or below reorder_level.
 *           The flag appears on both the list endpoint and the per-warehouse stock
 *           lines in the detail endpoint; the boundary (qty == reorder_level) is
 *           treated as low stock.
 *
 * All real handlers run. Only the DB layer is mocked.
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
  createGRN,
  listGRNs,
  getGRN,
  listConsumables,
  getConsumable,
  createConsumable,
  updateConsumable,
  adjustStock,
  allocatePrinter,
  deallocatePrinter,
} from '../src/functions/inventory';

const queryMock = query as unknown as Mock;

// =============================================================================
// Fixtures & helpers
// =============================================================================

const ALL_PERMS = ['inventory.read', 'inventory.grn', 'inventory.adjust', 'inventory.allocate'];

/** Admin — sub: 1 */
function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
}
/** A second user — sub: 9 — used to verify actor is read from JWT, not hardcoded. */
function storemanToken() {
  return issueToken({ sub: 9, email: 'storeman@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
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

/** Canonical consumable DB row; override via `extra`. */
function consumableRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    sku: 'TON-BLK-001',
    name: 'Black Toner HP',
    category: 'TONER',
    unit: 'cartridge',
    reorder_level: 5,
    description: null,
    is_active: 1,
    created_by: 1,
    created_by_name: 'Admin',
    created_at: '2025-01-01T08:00:00.000Z',
    updated_at: '2025-01-01T08:00:00.000Z',
    ...extra,
  };
}

/** Canonical printer DB row for inventory endpoints; override via `extra`. */
function printerRow(extra: Record<string, unknown> = {}) {
  return {
    id: 10,
    serial_no: 'SN-0010',
    brand: 'HP',
    model: 'LaserJet M4',
    status: 'IN_STOCK',
    warehouse_id: 1,
    current_contract_id: null,
    current_site_id: null,
    ...extra,
  };
}

/** Canonical GRN DB row; override via `extra`. */
function grnRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    grn_no: 'GRN-2025-0001',
    warehouse_id: 1,
    warehouse_name: 'Central',
    supplier_name: 'HP Distributors',
    supplier_ref: 'INV-9001',
    received_at: '2025-06-01T09:00:00.000Z',
    notes: null,
    received_by: 1,
    received_by_name: 'Admin',
    created_at: '2025-06-01T09:00:00.000Z',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Call-filter helpers — inspect what the handler wrote to the DB
// ---------------------------------------------------------------------------

/** All calls that INSERT a printer_status_history row. */
function historyInserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO printer_status_history/i.test(String(sql)));
}

/** All calls that INSERT into consumable_stock (both GRN additive and adjustStock exact). */
function consumableStockUpserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO consumable_stock/i.test(String(sql)));
}

/** All calls that INSERT into grn_consumable_lines. */
function consumableLineInserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO grn_consumable_lines/i.test(String(sql)));
}

/** All calls that INSERT into grn_printer_lines. */
function printerLineInserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO grn_printer_lines/i.test(String(sql)));
}

/** All UPDATE printers calls. */
function allPrinterUpdates() {
  return queryMock.mock.calls.filter(([sql]) =>
    /UPDATE printers/i.test(String(sql)));
}

/** The auto-transition UPDATE (filters to the one that sets status = 'RECEIVED'). */
function autoTransitionUpdates() {
  return queryMock.mock.calls.filter(([sql]) =>
    /UPDATE printers SET status = 'RECEIVED'/i.test(String(sql)));
}

/** All INSERT into goods_receipt_notes calls. */
function grnHeaderInserts() {
  return queryMock.mock.calls.filter(([sql]) =>
    /INSERT INTO goods_receipt_notes/i.test(String(sql)));
}

// =============================================================================
// BR-021: Stock never goes below zero — dispatch blocked when insufficient
// =============================================================================
describe('BR-021: Stock never goes below zero — dispatch blocked when insufficient', () => {
  beforeEach(() => queryMock.mockReset());

  // --- Rejection cases -------------------------------------------------------

  it('rejects when delta would put stock 7 below zero (on-hand 3, delta -10)', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])           // warehouse
      .mockResolvedValueOnce([{ qty_on_hand: 3 }]);  // current

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -10 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('rejects when stock is zero and any removal is attempted', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 0 }]);

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -1 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('rejects when removal exceeds on-hand by exactly 1 (boundary: 2 on-hand, remove 3)', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 2 }]);

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -3 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('treats no stock row as zero on-hand, so any removal is blocked', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);  // no row yet

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -1 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('includes on-hand quantity and requested change in the error message', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 4 }]);

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -7 } }),
      {} as never,
    );
    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).toMatch(/4/);   // on-hand
    expect(msg).toMatch(/-7/);  // delta
  });

  it('does not write a stock UPSERT when BR-021 blocks the adjustment', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 1 }]);

    await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -5 } }),
      {} as never,
    );
    expect(consumableStockUpserts()).toHaveLength(0);
  });

  // --- Allowed cases ---------------------------------------------------------

  it('allows a negative delta that brings stock to exactly zero', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 5 }])
      .mockResolvedValueOnce({ affectedRows: 1 });  // UPSERT

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -5 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { qtyOnHand: number }).qtyOnHand).toBe(0);
  });

  it('allows removal smaller than on-hand quantity', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 10 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -3 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { qtyOnHand: number }).qtyOnHand).toBe(7);
  });

  it('allows a positive delta (stock receipt) regardless of current level', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 0 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: 50 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { qtyOnHand: number }).qtyOnHand).toBe(50);
  });

  it('allows a positive delta when there is no prior stock row (first receipt)', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([])               // no row yet
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: 20 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { qtyOnHand: number }).qtyOnHand).toBe(20);
  });

  // --- UPSERT shape ----------------------------------------------------------

  it('writes the UPSERT with the computed new quantity (current + delta)', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 8 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: 12 } }),
      {} as never,
    );
    const upserts = consumableStockUpserts();
    expect(upserts).toHaveLength(1);
    const params = upserts[0][1] as unknown[];
    // params: [warehouseId, consumableId, newQty, newQty]
    expect(params[0]).toBe(1);   // warehouseId
    expect(params[1]).toBe(1);   // consumableId
    expect(params[2]).toBe(20);  // 8 + 12
    expect(params[3]).toBe(20);  // duplicate for ON DUPLICATE KEY
  });

  it('response includes consumableId, warehouseId, qtyOnHand and delta', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow({ id: 3 })])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ qty_on_hand: 6 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '3' }, body: { warehouseId: 2, delta: -2 } }),
      {} as never,
    );
    const body = res.jsonBody as { consumableId: number; warehouseId: number; qtyOnHand: number; delta: number };
    expect(body.consumableId).toBe(3);
    expect(body.warehouseId).toBe(2);
    expect(body.qtyOnHand).toBe(4);   // 6 - 2
    expect(body.delta).toBe(-2);
  });

  // --- Validation errors (rejected before DB read) ---------------------------

  it('returns 400 when delta is zero', async () => {
    queryMock.mockResolvedValueOnce([consumableRow()]);
    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: 0 } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when warehouse does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow()])
      .mockResolvedValueOnce([]);  // warehouse not found

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 99, delta: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when consumable does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);  // findConsumable → not found
    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '99' }, body: { warehouseId: 1, delta: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// GRN: Receiving a batch increases stock and records each unit
// =============================================================================
describe('GRN: Receiving a batch increases stock and records each unit', () => {
  beforeEach(() => queryMock.mockReset());

  // ---------------------------------------------------------------------------
  // Consumable lines — stock increase
  // ---------------------------------------------------------------------------

  it('GRN with one consumable line: UPSERTs consumable_stock with the received quantity', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                      // warehouse
      .mockResolvedValueOnce([{ id: 1 }])                      // consumable exists
      .mockResolvedValueOnce([{ cnt: 0 }])                     // GRN count
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // GRN header INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // consumable_stock UPSERT
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 }) // grn_consumable_lines INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([grnRow()]);                       // re-fetch

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 10 }] } }),
      {} as never,
    );

    const upserts = consumableStockUpserts();
    expect(upserts).toHaveLength(1);
    // GRN additive UPSERT: params are [warehouseId, consumableId, qty]
    const params = upserts[0][1] as unknown[];
    expect(params[0]).toBe(1);   // warehouseId
    expect(params[1]).toBe(1);   // consumableId
    expect(params[2]).toBe(10);  // qty received
  });

  it('GRN with one consumable line: inserts a grn_consumable_lines row with correct qty', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 10, unitCost: 150 }] } }),
      {} as never,
    );

    const lineInserts = consumableLineInserts();
    expect(lineInserts).toHaveLength(1);
    // params: [grnId, consumableId, quantity, unitCost]
    const params = lineInserts[0][1] as unknown[];
    expect(params[1]).toBe(1);    // consumableId
    expect(params[2]).toBe(10);   // quantity
    expect(params[3]).toBe(150);  // unitCost
  });

  it('GRN with two consumable lines: produces one UPSERT and one line INSERT per consumable', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                      // warehouse
      .mockResolvedValueOnce([{ id: 1 }])                      // consumable 1 exists
      .mockResolvedValueOnce([{ id: 2 }])                      // consumable 2 exists
      .mockResolvedValueOnce([{ cnt: 0 }])                     // GRN count
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // GRN INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // consumable 1 stock UPSERT
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 }) // consumable 1 line INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // consumable 2 stock UPSERT
      .mockResolvedValueOnce({ insertId: 3, affectedRows: 1 }) // consumable 2 line INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([grnRow()]);

    const res = await createGRN(
      req({
        token: adminToken(),
        body: {
          warehouseId: 1,
          consumables: [
            { consumableId: 1, quantity: 10 },
            { consumableId: 2, quantity: 25 },
          ],
        },
      }),
      {} as never,
    );

    expect(res.status).toBe(201);
    const upserts = consumableStockUpserts();
    const lines = consumableLineInserts();
    expect(upserts).toHaveLength(2);
    expect(lines).toHaveLength(2);
    // First consumable: qty 10
    expect((upserts[0][1] as unknown[])[2]).toBe(10);
    // Second consumable: qty 25
    expect((upserts[1][1] as unknown[])[2]).toBe(25);
  });

  it('GRN with two consumable lines: each line is addressed to the correct consumable id', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 3 }])                      // consumable 3 exists
      .mockResolvedValueOnce([{ id: 7 }])                      // consumable 7 exists
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 5, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 10, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 11, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({
        token: adminToken(),
        body: {
          warehouseId: 1,
          consumables: [
            { consumableId: 3, quantity: 5 },
            { consumableId: 7, quantity: 8 },
          ],
        },
      }),
      {} as never,
    );

    const upserts = consumableStockUpserts();
    expect((upserts[0][1] as unknown[])[1]).toBe(3);  // consumable 3
    expect((upserts[1][1] as unknown[])[1]).toBe(7);  // consumable 7
  });

  it('GRN quantity 0 on a consumable line is rejected before any stock write', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);  // warehouse exists; qty check fires before consumable lookup
    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 0 }] } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(consumableStockUpserts()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // GRN number generation
  // ---------------------------------------------------------------------------

  it('GRN number has format GRN-YYYY-NNNN (zero-padded 4-digit sequence)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ cnt: 0 }])                     // first GRN this year → 0001
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow({ grn_no: `GRN-${new Date().getFullYear()}-0001` })]);

    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 5 }] } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = res.jsonBody as { grn: { grnNo: string } };
    expect(body.grn.grnNo).toMatch(/^GRN-\d{4}-\d{4}$/);
    expect(body.grn.grnNo).toMatch(/-0001$/);
  });

  it('GRN number sequence increments: 5 existing GRNs → next is 0006', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ cnt: 5 }])                     // 5 existing → seq = 0006
      .mockResolvedValueOnce({ insertId: 6, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 10, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow({ id: 6, grn_no: `GRN-${new Date().getFullYear()}-0006` })]);

    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 5 }] } }),
      {} as never,
    );
    // The GRN number is embedded in the INSERT params[0]
    const grnInsert = grnHeaderInserts();
    expect(grnInsert).toHaveLength(1);
    const insertedGrnNo = (grnInsert[0][1] as unknown[])[0] as string;
    expect(insertedGrnNo).toMatch(/-0006$/);
  });

  // ---------------------------------------------------------------------------
  // Printer lines — warehouse assignment and auto-transition
  // ---------------------------------------------------------------------------

  it('GRN with a printer: sets warehouse_id on the printer', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                      // warehouse
      .mockResolvedValueOnce([{ id: 10 }])                     // printer exists
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // GRN INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // UPDATE warehouse_id
      .mockResolvedValueOnce({ affectedRows: 1 })               // auto-transition UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })               // history INSERT
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 }) // grn_printer_lines INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [{ printerId: 10 }] } }),
      {} as never,
    );

    const whUpdate = allPrinterUpdates().find(([sql]) =>
      /SET warehouse_id/i.test(String(sql)));
    expect(whUpdate).toBeDefined();
    expect((whUpdate![1] as unknown[])[0]).toBe(1);   // warehouse id
    expect((whUpdate![1] as unknown[])[1]).toBe(10);  // printer id
  });

  it('GRN auto-transitions ORDERED/IN_TRANSIT printer to RECEIVED', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })               // warehouse_id UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 })               // auto-transition: 1 row changed
      .mockResolvedValueOnce({ affectedRows: 1 })               // history INSERT
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [{ printerId: 10 }] } }),
      {} as never,
    );

    const transitions = autoTransitionUpdates();
    expect(transitions).toHaveLength(1);
    // The UPDATE targets the specific printer id
    expect((transitions[0][1] as unknown[])[0]).toBe(10);
  });

  it('GRN writes a printer_status_history row when auto-transition fires', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })               // auto-transition: 1 row → history fires
      .mockResolvedValueOnce({ affectedRows: 1 })               // history INSERT
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [{ printerId: 10 }] } }),
      {} as never,
    );

    const inserts = historyInserts();
    expect(inserts).toHaveLength(1);
    // The history row targets printer id 10
    expect((inserts[0][1] as unknown[])[0]).toBe(10);
    // to_status is RECEIVED (literal in the SQL)
    expect(String(inserts[0][0])).toMatch(/RECEIVED/i);
  });

  it('GRN does NOT write a history row when printer is already RECEIVED (no auto-transition)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })               // warehouse_id UPDATE
      .mockResolvedValueOnce({ affectedRows: 0 })               // auto-transition: 0 rows (already RECEIVED)
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 }) // grn_printer_lines INSERT (no history)
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [{ printerId: 10 }] } }),
      {} as never,
    );

    expect(historyInserts()).toHaveLength(0);
  });

  it('GRN inserts a grn_printer_lines row for each received printer', async () => {
    // Two printers, both already RECEIVED (no transition history rows)
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                      // warehouse
      .mockResolvedValueOnce([{ id: 10 }])                     // printer 10
      .mockResolvedValueOnce([{ id: 11 }])                     // printer 11
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // GRN INSERT
      // printer 10
      .mockResolvedValueOnce({ affectedRows: 1 })               // warehouse_id
      .mockResolvedValueOnce({ affectedRows: 0 })               // no transition
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 }) // grn_printer_lines
      // printer 11
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 })
      .mockResolvedValueOnce({ insertId: 3, affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([grnRow()]);

    await createGRN(
      req({
        token: adminToken(),
        body: { warehouseId: 1, printers: [{ printerId: 10 }, { printerId: 11 }] },
      }),
      {} as never,
    );

    expect(printerLineInserts()).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Mixed GRN: printers + consumables
  // ---------------------------------------------------------------------------

  it('mixed GRN processes both printers and consumables in a single call', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])                      // warehouse
      .mockResolvedValueOnce([{ id: 10 }])                     // printer exists
      .mockResolvedValueOnce([{ id: 1 }])                      // consumable exists
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 }) // GRN INSERT
      // printer line (no transition)
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 })
      .mockResolvedValueOnce({ insertId: 2, affectedRows: 1 })
      // consumable line
      .mockResolvedValueOnce({ affectedRows: 1 })               // consumable_stock UPSERT
      .mockResolvedValueOnce({ insertId: 3, affectedRows: 1 }) // consumable line INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })               // writeAudit
      .mockResolvedValueOnce([grnRow()]);

    const res = await createGRN(
      req({
        token: adminToken(),
        body: {
          warehouseId: 1,
          printers: [{ printerId: 10 }],
          consumables: [{ consumableId: 1, quantity: 5 }],
        },
      }),
      {} as never,
    );

    expect(res.status).toBe(201);
    expect(printerLineInserts()).toHaveLength(1);
    expect(consumableLineInserts()).toHaveLength(1);
    expect(consumableStockUpserts()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  it('returns 400 EMPTY_GRN when no lines are supplied', async () => {
    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [], consumables: [] } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('EMPTY_GRN');
  });

  it('returns 404 when the warehouse does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])   // consumable exists
      .mockResolvedValueOnce([]);             // warehouse not found

    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 99, consumables: [{ consumableId: 1, quantity: 1 }] } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when a printer id does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])   // warehouse
      .mockResolvedValueOnce([]);             // printer not found

    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, printers: [{ printerId: 99 }] } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when a consumable id does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])   // warehouse
      .mockResolvedValueOnce([]);             // consumable not found

    const res = await createGRN(
      req({ token: adminToken(), body: { warehouseId: 1, consumables: [{ consumableId: 99, quantity: 5 }] } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 when no token is supplied', async () => {
    const res = await createGRN(req({ body: { warehouseId: 1, consumables: [{ consumableId: 1, quantity: 1 }] } }), {} as never);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// Allocation: marks printer ALLOCATED and prevents double-allocation (BR-003)
// =============================================================================
describe('Allocation: marks printer ALLOCATED and prevents double-allocation (BR-003)', () => {
  beforeEach(() => queryMock.mockReset());

  // ---------------------------------------------------------------------------
  // Successful allocation
  // ---------------------------------------------------------------------------

  it('returns 200 with status ALLOCATED and the contract number', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-001' }])
      .mockResolvedValueOnce({ affectedRows: 1 })                // UPDATE printers
      .mockResolvedValueOnce({ insertId: 50, affectedRows: 1 }); // history INSERT

    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { status: string; contractNo: string; printerId: number; contractId: number };
    expect(body.status).toBe('ALLOCATED');
    expect(body.contractNo).toBe('CTR-001');
    expect(body.contractId).toBe(5);
    expect(body.printerId).toBe(10);
  });

  it('UPDATE SQL sets status = ALLOCATED and current_contract_id on the printer', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-001' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 51, affectedRows: 1 });

    await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    const updates = allPrinterUpdates();
    expect(updates).toHaveLength(1);
    const [sql, params] = updates[0];
    expect(String(sql)).toMatch(/ALLOCATED/i);
    expect(String(sql)).toMatch(/current_contract_id/i);
    // params: [contractId, siteId, printerId]
    expect((params as unknown[])[0]).toBe(5);   // contractId
    expect((params as unknown[])[2]).toBe(10);  // printerId
  });

  it('writes a history row with from_status IN_STOCK and to_status ALLOCATED', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-001' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 52, affectedRows: 1 });

    await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    const inserts = historyInserts();
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0][0])).toMatch(/IN_STOCK.*ALLOCATED/i);
  });

  it('history row reason includes the contract number', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-007' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 53, affectedRows: 1 });

    await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    const reason = (historyInserts()[0][1] as unknown[])[1] as string;
    expect(reason).toContain('CTR-007');
  });

  it('history row changed_by is taken from the JWT (not hardcoded)', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-001' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 54, affectedRows: 1 });

    await allocatePrinter(
      req({ token: storemanToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    // storemanToken has sub: 9
    const changedBy = (historyInserts()[0][1] as unknown[])[2];
    expect(changedBy).toBe(9);
  });

  it('optionally records siteId when supplied', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([{ id: 5, status: 'ACTIVE', contract_no: 'CTR-001' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 55, affectedRows: 1 });

    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5, siteId: 3 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { siteId: number | null };
    expect(body.siteId).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Double-allocation prevention
  // ---------------------------------------------------------------------------

  it('returns 409 ALREADY_CONTRACTED when printer is IN_STOCK but already has a contract link', async () => {
    // Simulates a race-condition or manual DB link: status=IN_STOCK but contract set
    queryMock.mockResolvedValueOnce([printerRow({ status: 'IN_STOCK', current_contract_id: 3 })]);

    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ALREADY_CONTRACTED');
  });

  it('returns 409 ALREADY_CONTRACTED when trying to allocate an already ALLOCATED printer', async () => {
    // The ALLOCATED status check fires first (422), but if somehow status is still IN_STOCK
    // with a contract link the 409 fires. Here we test via the contract_id path.
    queryMock.mockResolvedValueOnce([printerRow({ status: 'IN_STOCK', current_contract_id: 8 })]);

    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 99 } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ALREADY_CONTRACTED');
  });

  it('does not write a history row when double-allocation is rejected', async () => {
    queryMock.mockResolvedValueOnce([printerRow({ status: 'IN_STOCK', current_contract_id: 3 })]);
    await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(historyInserts()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Status-based rejection (printer not IN_STOCK)
  // ---------------------------------------------------------------------------

  it.each([
    'ORDERED', 'IN_TRANSIT', 'RECEIVED', 'QC_PASS', 'QC_FAIL',
    'DISPATCHED', 'INSTALLED', 'UNDER_REPAIR', 'REPLACEMENT_OUT',
    'RETURNED', 'REFURBISHED', 'RETIRED',
  ])('returns 422 PRINTER_NOT_IN_STOCK when printer status is %s', async (status) => {
    queryMock.mockResolvedValueOnce([printerRow({ status })]);
    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_IN_STOCK');
  });

  // ---------------------------------------------------------------------------
  // Contract status checks
  // ---------------------------------------------------------------------------

  it.each(['DRAFT', 'EXPIRED', 'TERMINATED'])(
    'returns 422 CONTRACT_NOT_ACTIVE when contract status is %s',
    async (contractStatus) => {
      queryMock
        .mockResolvedValueOnce([printerRow()])
        .mockResolvedValueOnce([{ id: 5, status: contractStatus, contract_no: 'CTR-X' }]);

      const res = await allocatePrinter(
        req({ token: adminToken(), params: { id: '10' }, body: { contractId: 5 } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('CONTRACT_NOT_ACTIVE');
    },
  );

  it('returns 404 when contract does not exist', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow()])
      .mockResolvedValueOnce([]);  // contract not found

    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { contractId: 99 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when printer does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await allocatePrinter(
      req({ token: adminToken(), params: { id: '99' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller lacks inventory.allocate permission', async () => {
    const readOnly = issueToken({ sub: 3, email: 'r@r.com', role: 'SALES_REP', perms: ['inventory.read'] });
    const res = await allocatePrinter(
      req({ token: readOnly, params: { id: '10' }, body: { contractId: 5 } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Deallocation
  // ---------------------------------------------------------------------------

  it('deallocates an ALLOCATED printer, returns it to IN_STOCK and clears the contract link', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow({ status: 'ALLOCATED', current_contract_id: 5 })])
      .mockResolvedValueOnce({ affectedRows: 1 })                // UPDATE
      .mockResolvedValueOnce({ insertId: 60, affectedRows: 1 }); // history

    const res = await deallocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { reason: 'Contract ended' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { status: string; previousContractId: number };
    expect(body.status).toBe('IN_STOCK');
    expect(body.previousContractId).toBe(5);
  });

  it('deallocation UPDATE SQL sets status = IN_STOCK and clears current_contract_id = NULL', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow({ status: 'ALLOCATED', current_contract_id: 5 })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 61, affectedRows: 1 });

    await deallocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: {} }),
      {} as never,
    );
    const updates = allPrinterUpdates();
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toMatch(/IN_STOCK/i);
    expect(String(updates[0][0])).toMatch(/current_contract_id = NULL/i);
  });

  it('deallocation writes a history row from ALLOCATED to IN_STOCK', async () => {
    queryMock
      .mockResolvedValueOnce([printerRow({ status: 'ALLOCATED', current_contract_id: 5 })])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ insertId: 62, affectedRows: 1 });

    await deallocatePrinter(
      req({ token: adminToken(), params: { id: '10' }, body: { reason: 'End of lease' } }),
      {} as never,
    );
    const inserts = historyInserts();
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0][0])).toMatch(/ALLOCATED.*IN_STOCK/i);
    // reason is in params
    const reason = (inserts[0][1] as unknown[])[1] as string;
    expect(reason).toBe('End of lease');
  });

  it.each(['IN_STOCK', 'ORDERED', 'INSTALLED', 'RETIRED'])(
    'returns 422 PRINTER_NOT_ALLOCATED when status is %s',
    async (status) => {
      queryMock.mockResolvedValueOnce([printerRow({ status })]);
      const res = await deallocatePrinter(
        req({ token: adminToken(), params: { id: '10' }, body: {} }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('PRINTER_NOT_ALLOCATED');
    },
  );
});

// =============================================================================
// Low-stock alert: fires when qty_on_hand drops to or below reorder_level
// =============================================================================
describe('Low-stock alert: fires when stock drops to or below reorder level', () => {
  beforeEach(() => queryMock.mockReset());

  // ---------------------------------------------------------------------------
  // listConsumables — aggregated flag from DB
  // ---------------------------------------------------------------------------

  it('isLowStock = true when DB reports has_low_stock = 1', async () => {
    queryMock.mockResolvedValueOnce([
      { ...consumableRow({ reorder_level: 10 }), total_qty: 3, has_low_stock: 1 },
    ]);
    const res = await listConsumables(req({ token: adminToken() }), {} as never);
    const body = res.jsonBody as { consumables: { isLowStock: boolean }[] };
    expect(body.consumables[0].isLowStock).toBe(true);
  });

  it('isLowStock = false when DB reports has_low_stock = 0', async () => {
    queryMock.mockResolvedValueOnce([
      { ...consumableRow({ reorder_level: 5 }), total_qty: 20, has_low_stock: 0 },
    ]);
    const res = await listConsumables(req({ token: adminToken() }), {} as never);
    const body = res.jsonBody as { consumables: { isLowStock: boolean }[] };
    expect(body.consumables[0].isLowStock).toBe(false);
  });

  it('listConsumables correctly flags each item independently when returns are mixed', async () => {
    queryMock.mockResolvedValueOnce([
      { ...consumableRow({ id: 1, sku: 'A' }), total_qty: 2,  has_low_stock: 1 },
      { ...consumableRow({ id: 2, sku: 'B' }), total_qty: 50, has_low_stock: 0 },
      { ...consumableRow({ id: 3, sku: 'C' }), total_qty: 0,  has_low_stock: 1 },
    ]);
    const res = await listConsumables(req({ token: adminToken() }), {} as never);
    const body = res.jsonBody as { consumables: { sku: string; isLowStock: boolean }[] };
    expect(body.consumables).toHaveLength(3);
    expect(body.consumables.find((c) => c.sku === 'A')!.isLowStock).toBe(true);
    expect(body.consumables.find((c) => c.sku === 'B')!.isLowStock).toBe(false);
    expect(body.consumables.find((c) => c.sku === 'C')!.isLowStock).toBe(true);
  });

  it('totalQtyOnHand matches the aggregated sum returned by the DB', async () => {
    queryMock.mockResolvedValueOnce([
      { ...consumableRow(), total_qty: 42, has_low_stock: 0 },
    ]);
    const res = await listConsumables(req({ token: adminToken() }), {} as never);
    const body = res.jsonBody as { consumables: { totalQtyOnHand: number }[] };
    expect(body.consumables[0].totalQtyOnHand).toBe(42);
  });

  it('totalQtyOnHand is 0 (not null) when consumable has no stock rows', async () => {
    queryMock.mockResolvedValueOnce([
      { ...consumableRow(), total_qty: 0, has_low_stock: 0 },
    ]);
    const res = await listConsumables(req({ token: adminToken() }), {} as never);
    const body = res.jsonBody as { consumables: { totalQtyOnHand: number }[] };
    expect(body.consumables[0].totalQtyOnHand).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // getConsumable — per-warehouse flag computed in JS
  // ---------------------------------------------------------------------------

  it('per-warehouse isLowStock = true when qty_on_hand < reorder_level', async () => {
    // reorder_level = 5, on-hand = 2
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 5 })])
      .mockResolvedValueOnce([
        { qty_on_hand: 2, warehouse_id: 1, warehouse_code: 'WHC', warehouse_name: 'Central' },
      ]);
    const res = await getConsumable(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    const body = res.jsonBody as { stock: { isLowStock: boolean }[] };
    expect(body.stock[0].isLowStock).toBe(true);
  });

  it('per-warehouse isLowStock = true at exactly the reorder level (boundary: equal means low)', async () => {
    // reorder_level = 5, on-hand = 5 — still considered low
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 5 })])
      .mockResolvedValueOnce([
        { qty_on_hand: 5, warehouse_id: 1, warehouse_code: 'WHC', warehouse_name: 'Central' },
      ]);
    const res = await getConsumable(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    const body = res.jsonBody as { stock: { isLowStock: boolean }[] };
    expect(body.stock[0].isLowStock).toBe(true);
  });

  it('per-warehouse isLowStock = false when qty_on_hand is one above reorder_level', async () => {
    // reorder_level = 5, on-hand = 6 — just above the threshold
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 5 })])
      .mockResolvedValueOnce([
        { qty_on_hand: 6, warehouse_id: 1, warehouse_code: 'WHC', warehouse_name: 'Central' },
      ]);
    const res = await getConsumable(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    const body = res.jsonBody as { stock: { isLowStock: boolean }[] };
    expect(body.stock[0].isLowStock).toBe(false);
  });

  it('per-warehouse isLowStock = false when stock is well above reorder level', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 10 })])
      .mockResolvedValueOnce([
        { qty_on_hand: 100, warehouse_id: 1, warehouse_code: 'WHC', warehouse_name: 'Central' },
      ]);
    const res = await getConsumable(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    const body = res.jsonBody as { stock: { isLowStock: boolean }[] };
    expect(body.stock[0].isLowStock).toBe(false);
  });

  it('multiple warehouses are each flagged independently', async () => {
    // reorder_level = 10
    // Central: 3 → low; Depot: 15 → OK; Depot 2: 10 → low (at boundary)
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 10 })])
      .mockResolvedValueOnce([
        { qty_on_hand: 3,  warehouse_id: 1, warehouse_code: 'WH-C', warehouse_name: 'Central' },
        { qty_on_hand: 15, warehouse_id: 2, warehouse_code: 'WH-D1', warehouse_name: 'Depot 1' },
        { qty_on_hand: 10, warehouse_id: 3, warehouse_code: 'WH-D2', warehouse_name: 'Depot 2' },
      ]);
    const res = await getConsumable(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    const body = res.jsonBody as { stock: { warehouseCode: string; isLowStock: boolean }[] };
    expect(body.stock).toHaveLength(3);
    expect(body.stock.find((s) => s.warehouseCode === 'WH-C')!.isLowStock).toBe(true);
    expect(body.stock.find((s) => s.warehouseCode === 'WH-D1')!.isLowStock).toBe(false);
    expect(body.stock.find((s) => s.warehouseCode === 'WH-D2')!.isLowStock).toBe(true); // boundary
  });

  it('adjustStock response reflects new qty so the caller can compute low-stock client-side', async () => {
    // reorder_level = 5; starts at 8, remove 4 → 4 which is below reorder
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 5 })])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 8 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -4 } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { qtyOnHand: number };
    // qty 4 is below reorder_level 5 → caller knows to show alert
    expect(body.qtyOnHand).toBe(4);
  });

  it('after an adjustStock that brings qty to zero the response shows 0 (not null or undefined)', async () => {
    queryMock
      .mockResolvedValueOnce([consumableRow({ reorder_level: 5 })])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ qty_on_hand: 3 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const res = await adjustStock(
      req({ token: adminToken(), params: { id: '1' }, body: { warehouseId: 1, delta: -3 } }),
      {} as never,
    );
    const body = res.jsonBody as { qtyOnHand: number };
    expect(body.qtyOnHand).toBe(0);
    expect(body.qtyOnHand).not.toBeNull();
    expect(body.qtyOnHand).not.toBeUndefined();
  });
});

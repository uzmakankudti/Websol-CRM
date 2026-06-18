/**
 * Warehouse Management — endpoint tests.
 *
 * Covers: list, get detail, create (duplicate code rejection), update.
 * All real handlers run; only the DB layer is mocked.
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
  listWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
} from '../src/functions/warehouses';

const queryMock = query as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_PERMS = ['inventory.read', 'inventory.grn', 'inventory.adjust', 'inventory.allocate'];

function adminToken() {
  return issueToken({ sub: 1, email: 'admin@websol.local', role: 'SYSTEM_ADMIN', perms: ALL_PERMS });
}
function readToken() {
  return issueToken({ sub: 5, email: 'sales@websol.local', role: 'SALES_REP', perms: ['inventory.read'] });
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

function warehouseRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: 'WH-CENTRAL',
    name: 'Central Warehouse',
    type: 'CENTRAL',
    address: '1 Depot Rd',
    city: 'Cape Town',
    contact_name: 'Alice',
    contact_phone: '+27211234567',
    is_active: 1,
    created_by: 1,
    created_by_name: 'Admin User',
    created_at: '2025-01-01T08:00:00.000Z',
    updated_at: '2025-01-01T08:00:00.000Z',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// listWarehouses
// ---------------------------------------------------------------------------
describe('listWarehouses', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with warehouse list', async () => {
    queryMock.mockResolvedValueOnce([warehouseRow({ printer_count: 3, consumable_line_count: 2 })]);
    const res = await listWarehouses(req({ token: adminToken() }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { warehouses: { code: string; printerCount: number }[] };
    expect(body.warehouses).toHaveLength(1);
    expect(body.warehouses[0].code).toBe('WH-CENTRAL');
    expect(body.warehouses[0].printerCount).toBe(3);
  });

  it('returns 401 when no token', async () => {
    const res = await listWarehouses(req(), {} as never);
    expect(res.status).toBe(401);
  });

  it('returns 403 when missing inventory.read permission', async () => {
    const token = issueToken({ sub: 2, email: 'x@y.com', role: 'CEO', perms: [] });
    const res = await listWarehouses(req({ token }), {} as never);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// getWarehouse
// ---------------------------------------------------------------------------
describe('getWarehouse', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns 200 with warehouse detail, printers and consumable stock', async () => {
    queryMock
      .mockResolvedValueOnce([warehouseRow()])     // findWarehouse
      .mockResolvedValueOnce([                       // printers at warehouse
        { id: 10, serial_no: 'SN-010', asset_no: null, brand: 'Kyocera', model: 'M2040', status: 'IN_STOCK', current_contract_id: null, current_contract_no: null },
      ])
      .mockResolvedValueOnce([                       // consumable stock
        { consumable_id: 3, sku: 'TON-001', name: 'Black Toner', category: 'TONER', unit: 'cartridge', qty_on_hand: 5, reorder_level: 10 },
      ]);

    const res = await getWarehouse(req({ token: adminToken(), params: { id: '1' } }), {} as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { warehouse: { code: string }; printers: unknown[]; consumableStock: { isLowStock: boolean }[] };
    expect(body.warehouse.code).toBe('WH-CENTRAL');
    expect(body.printers).toHaveLength(1);
    expect(body.consumableStock[0].isLowStock).toBe(true); // 5 <= 10
  });

  it('returns 404 when warehouse does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await getWarehouse(req({ token: adminToken(), params: { id: '999' } }), {} as never);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await getWarehouse(req({ token: adminToken(), params: { id: 'abc' } }), {} as never);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// createWarehouse
// ---------------------------------------------------------------------------
describe('createWarehouse', () => {
  beforeEach(() => queryMock.mockReset());

  it('creates a warehouse and returns 201', async () => {
    queryMock
      .mockResolvedValueOnce([])                              // duplicate check → none
      .mockResolvedValueOnce({ insertId: 5, affectedRows: 1 }) // INSERT
      .mockResolvedValueOnce({ affectedRows: 1 })              // writeAudit
      .mockResolvedValueOnce([warehouseRow({ id: 5, code: 'WH-DEPOT1' })]); // findWarehouse

    const res = await createWarehouse(
      req({ token: adminToken(), body: { code: 'WH-DEPOT1', name: 'Cape Depot', type: 'DEPOT' } }),
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = res.jsonBody as { warehouse: { code: string } };
    expect(body.warehouse.code).toBe('WH-DEPOT1');
  });

  it('returns 409 when warehouse code is already in use (duplicate code)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]); // duplicate check → found
    const res = await createWarehouse(
      req({ token: adminToken(), body: { code: 'WH-CENTRAL', name: 'Dupe', type: 'CENTRAL' } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DUPLICATE_CODE');
  });

  it('returns 400 when code is missing', async () => {
    const res = await createWarehouse(
      req({ token: adminToken(), body: { name: 'No Code Depot', type: 'DEPOT' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const res = await createWarehouse(
      req({ token: adminToken(), body: { code: 'WH-X', name: 'X', type: 'INVALID' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller lacks inventory.adjust permission', async () => {
    const res = await createWarehouse(
      req({ token: readToken(), body: { code: 'WH-Y', name: 'Y', type: 'DEPOT' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// updateWarehouse
// ---------------------------------------------------------------------------
describe('updateWarehouse', () => {
  beforeEach(() => queryMock.mockReset());

  it('updates name and city, returns 200', async () => {
    queryMock
      .mockResolvedValueOnce([warehouseRow()])    // findWarehouse
      .mockResolvedValueOnce({ affectedRows: 1 }) // UPDATE
      .mockResolvedValueOnce({ affectedRows: 1 }) // writeAudit
      .mockResolvedValueOnce([warehouseRow({ name: 'Updated Name', city: 'Joburg' })]); // re-fetch

    const res = await updateWarehouse(
      req({ token: adminToken(), params: { id: '1' }, body: { name: 'Updated Name', city: 'Joburg' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { warehouse: { name: string; city: string } };
    expect(body.warehouse.name).toBe('Updated Name');
    expect(body.warehouse.city).toBe('Joburg');
  });

  it('returns 404 when warehouse does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await updateWarehouse(
      req({ token: adminToken(), params: { id: '99' }, body: { name: 'X' } }),
      {} as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when no changes are supplied', async () => {
    queryMock.mockResolvedValueOnce([warehouseRow()]);
    const res = await updateWarehouse(
      req({ token: adminToken(), params: { id: '1' }, body: {} }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is set to empty string', async () => {
    queryMock.mockResolvedValueOnce([warehouseRow()]);
    const res = await updateWarehouse(
      req({ token: adminToken(), params: { id: '1' }, body: { name: '' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
  });
});

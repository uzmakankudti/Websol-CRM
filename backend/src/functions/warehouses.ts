/**
 * Inventory / Warehouse Management — warehouse endpoints.
 *
 *   GET    /api/warehouses         list all warehouses (printer + consumable counts)
 *   GET    /api/warehouses/{id}    warehouse detail + in-stock printers + consumable stock
 *   POST   /api/warehouses         create warehouse             (inventory.adjust)
 *   PATCH  /api/warehouses/{id}    edit warehouse               (inventory.adjust)
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WarehouseRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  type: string;
  address: string | null;
  city: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  is_active: number;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TYPE = ['CENTRAL', 'DEPOT'] as const;

function warehouseIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid warehouse id');
  return id;
}

function toWarehousePublic(row: WarehouseRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    address: row.address,
    city: row.city,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    isActive: !!row.is_active,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findWarehouse(id: number): Promise<WarehouseRow | null> {
  const rows = await query<WarehouseRow[]>(
    `SELECT w.*, u.full_name AS created_by_name
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.created_by
      WHERE w.id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/warehouses
// ---------------------------------------------------------------------------
export const listWarehouses = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const rows = await query<WarehouseRow[]>(
    `SELECT w.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM printers p WHERE p.warehouse_id = w.id) AS printer_count,
            (SELECT COUNT(DISTINCT cs.consumable_id) FROM consumable_stock cs WHERE cs.warehouse_id = w.id) AS consumable_line_count
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.created_by
      ORDER BY w.type ASC, w.name ASC`,
    [],
  );

  return json(200, {
    warehouses: rows.map((r) => ({
      ...toWarehousePublic(r),
      printerCount: Number((r as RowDataPacket).printer_count) || 0,
      consumableLineCount: Number((r as RowDataPacket).consumable_line_count) || 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/warehouses/{id}
// ---------------------------------------------------------------------------
export const getWarehouse = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const id = warehouseIdParam(request);
  const warehouse = await findWarehouse(id);
  if (!warehouse) return error(404, 'Warehouse not found');

  // Printers currently assigned to this warehouse (all active statuses).
  const printers = await query<RowDataPacket[]>(
    `SELECT p.id, p.serial_no, p.asset_no, p.brand, p.model, p.status,
            p.current_contract_id, c.contract_no AS current_contract_no
       FROM printers p
       LEFT JOIN contracts c ON c.id = p.current_contract_id
      WHERE p.warehouse_id = ?
      ORDER BY p.status ASC, p.brand ASC, p.model ASC`,
    [id],
  );

  // Consumable stock at this warehouse (with reorder info).
  const consumableStock = await query<RowDataPacket[]>(
    `SELECT cs.qty_on_hand, co.id AS consumable_id, co.sku, co.name,
            co.category, co.unit, co.reorder_level
       FROM consumable_stock cs
       JOIN consumables co ON co.id = cs.consumable_id
      WHERE cs.warehouse_id = ?
      ORDER BY co.category ASC, co.name ASC`,
    [id],
  );

  return json(200, {
    warehouse: toWarehousePublic(warehouse),
    printers: printers.map((p) => ({
      id: p.id,
      serialNo: p.serial_no,
      assetNo: p.asset_no,
      brand: p.brand,
      model: p.model,
      status: p.status,
      currentContractId: p.current_contract_id,
      currentContractNo: p.current_contract_no,
    })),
    consumableStock: consumableStock.map((s) => ({
      consumableId: s.consumable_id,
      sku: s.sku,
      name: s.name,
      category: s.category,
      unit: s.unit,
      qtyOnHand: s.qty_on_hand,
      reorderLevel: s.reorder_level,
      isLowStock: s.qty_on_hand <= s.reorder_level,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/warehouses
// ---------------------------------------------------------------------------
export const createWarehouse = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAdjust);

  const body = await readJson<Record<string, unknown>>(request);

  const code = String(body.code ?? '').trim().toUpperCase();
  if (!code) return error(400, 'Warehouse code is required');

  const name = String(body.name ?? '').trim();
  if (!name) return error(400, 'Warehouse name is required');

  const type = String(body.type ?? 'CENTRAL').toUpperCase();
  if (!VALID_TYPE.includes(type as (typeof VALID_TYPE)[number])) {
    return error(400, `type must be one of: ${VALID_TYPE.join(', ')}`);
  }

  // Unique code check.
  const dup = await query<RowDataPacket[]>(
    `SELECT id FROM warehouses WHERE code = ? LIMIT 1`,
    [code],
  );
  if (dup.length) return error(409, `Warehouse code '${code}' is already in use`, 'DUPLICATE_CODE');

  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  const result = await query<ResultSetHeader>(
    `INSERT INTO warehouses (code, name, type, address, city, contact_name, contact_phone, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, type, str(body.address), str(body.city), str(body.contactName), str(body.contactPhone), ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'warehouse', entityId: result.insertId,
    action: 'create', changes: { after: { code, name, type } },
    ipAddress: clientIp(request),
  });

  const created = await findWarehouse(result.insertId);
  return json(201, { warehouse: created ? toWarehousePublic(created) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/warehouses/{id}
// ---------------------------------------------------------------------------
export const updateWarehouse = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAdjust);

  const id = warehouseIdParam(request);
  const existing = await findWarehouse(id);
  if (!existing) return error(404, 'Warehouse not found');

  const body = await readJson<Record<string, unknown>>(request);
  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};
  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return error(400, 'Warehouse name cannot be empty');
    sets.push('name = ?'); params.push(name); after.name = name;
  }
  if (body.type !== undefined) {
    const type = String(body.type).toUpperCase();
    if (!VALID_TYPE.includes(type as (typeof VALID_TYPE)[number])) {
      return error(400, `type must be one of: ${VALID_TYPE.join(', ')}`);
    }
    sets.push('type = ?'); params.push(type); after.type = type;
  }
  for (const [key, column] of [['address','address'],['city','city'],['contactName','contact_name'],['contactPhone','contact_phone']] as [string,string][]) {
    if (body[key] !== undefined) {
      sets.push(`${column} = ?`); params.push(str(body[key])); after[key] = str(body[key]);
    }
  }
  if (body.isActive !== undefined) {
    sets.push('is_active = ?'); params.push(body.isActive ? 1 : 0); after.isActive = !!body.isActive;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE warehouses SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'warehouse', entityId: id,
    action: 'update', changes: { after },
    ipAddress: clientIp(request),
  });

  const updated = await findWarehouse(id);
  return json(200, { warehouse: updated ? toWarehousePublic(updated) : null });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('warehouses-list',   { methods: ['GET'],   authLevel: 'anonymous', route: 'warehouses',      handler: listWarehouses });
app.http('warehouses-create', { methods: ['POST'],  authLevel: 'anonymous', route: 'warehouses',      handler: createWarehouse });
app.http('warehouses-get',    { methods: ['GET'],   authLevel: 'anonymous', route: 'warehouses/{id}', handler: getWarehouse });
app.http('warehouses-update', { methods: ['PATCH'], authLevel: 'anonymous', route: 'warehouses/{id}', handler: updateWarehouse });

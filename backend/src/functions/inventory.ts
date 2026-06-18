/**
 * Inventory / Warehouse Management — GRN, consumable, stock and allocation endpoints.
 *
 *   GET    /api/grns                          list GRNs
 *   GET    /api/grns/{id}                     GRN detail (printer + consumable lines)
 *   POST   /api/grns                          create GRN — receives stock    (inventory.grn)
 *
 *   GET    /api/consumables                   list consumables with stock totals
 *   GET    /api/consumables/{id}              consumable + per-warehouse stock
 *   POST   /api/consumables                   create consumable               (inventory.adjust)
 *   PATCH  /api/consumables/{id}              edit consumable                 (inventory.adjust)
 *   POST   /api/consumables/{id}/adjust       adjust stock at a warehouse     (inventory.adjust)
 *
 *   POST   /api/printers/{id}/allocate        allocate printer to contract    (inventory.allocate)
 *   POST   /api/printers/{id}/deallocate      return printer to IN_STOCK      (inventory.allocate)
 *
 * Business rules enforced:
 *   BR-021  Consumable stock may never go below zero.
 *   BR-022  A GRN must have at least one line.
 *   BR-023  A printer on a GRN in ORDERED/IN_TRANSIT is auto-transitioned to RECEIVED.
 *   BR-003  A printer must be IN_STOCK with no active contract to be allocated.
 *           Double-allocation is prevented by checking both status and contract link.
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

interface GRNRow extends RowDataPacket {
  id: number;
  grn_no: string;
  warehouse_id: number;
  warehouse_name: string;
  supplier_name: string | null;
  supplier_ref: string | null;
  received_at: string;
  notes: string | null;
  received_by: number;
  received_by_name: string | null;
  created_at: string;
}

interface ConsumableRow extends RowDataPacket {
  id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  reorder_level: number;
  description: string | null;
  is_active: number;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface PrinterRow extends RowDataPacket {
  id: number;
  serial_no: string;
  brand: string;
  model: string;
  status: string;
  warehouse_id: number | null;
  current_contract_id: number | null;
  current_site_id: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CATEGORY = ['TONER', 'SPARE_PART', 'PAPER', 'OTHER'] as const;

function printerIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid printer id');
  return id;
}

function consumableIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid consumable id');
  return id;
}

function toConsumablePublic(row: ConsumableRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unit: row.unit,
    reorderLevel: row.reorder_level,
    description: row.description,
    isActive: !!row.is_active,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function toGRNPublic(row: GRNRow) {
  return {
    id: row.id,
    grnNo: row.grn_no,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    supplierName: row.supplier_name,
    supplierRef: row.supplier_ref,
    receivedAt: row.received_at,
    notes: row.notes,
    receivedBy: row.received_by ? { id: row.received_by, fullName: row.received_by_name } : null,
    createdAt: row.created_at,
  };
}

async function findConsumable(id: number): Promise<ConsumableRow | null> {
  const rows = await query<ConsumableRow[]>(
    `SELECT co.*, u.full_name AS created_by_name
       FROM consumables co LEFT JOIN users u ON u.id = co.created_by
      WHERE co.id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function findPrinterForInventory(id: number): Promise<PrinterRow | null> {
  const rows = await query<PrinterRow[]>(
    `SELECT id, serial_no, brand, model, status, warehouse_id, current_contract_id, current_site_id
       FROM printers WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GRN — list
// ---------------------------------------------------------------------------
export const listGRNs = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const rows = await query<GRNRow[]>(
    `SELECT g.*, w.name AS warehouse_name, u.full_name AS received_by_name,
            (SELECT COUNT(*) FROM grn_printer_lines gp WHERE gp.grn_id = g.id)   AS printer_count,
            (SELECT COUNT(*) FROM grn_consumable_lines gc WHERE gc.grn_id = g.id) AS consumable_line_count
       FROM goods_receipt_notes g
       JOIN warehouses w ON w.id = g.warehouse_id
       JOIN users u       ON u.id = g.received_by
      ORDER BY g.created_at DESC`,
    [],
  );

  return json(200, {
    grns: rows.map((r) => ({
      ...toGRNPublic(r),
      printerCount: Number((r as RowDataPacket).printer_count) || 0,
      consumableLineCount: Number((r as RowDataPacket).consumable_line_count) || 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// GRN — get detail
// ---------------------------------------------------------------------------
export const getGRN = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid GRN id');

  const rows = await query<GRNRow[]>(
    `SELECT g.*, w.name AS warehouse_name, u.full_name AS received_by_name
       FROM goods_receipt_notes g
       JOIN warehouses w ON w.id = g.warehouse_id
       JOIN users u       ON u.id = g.received_by
      WHERE g.id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return error(404, 'GRN not found');

  const printerLines = await query<RowDataPacket[]>(
    `SELECT gp.id, gp.printer_id, gp.unit_cost,
            p.serial_no, p.brand, p.model, p.asset_no
       FROM grn_printer_lines gp
       JOIN printers p ON p.id = gp.printer_id
      WHERE gp.grn_id = ?`,
    [id],
  );

  const consumableLines = await query<RowDataPacket[]>(
    `SELECT gc.id, gc.consumable_id, gc.quantity, gc.unit_cost,
            co.sku, co.name AS consumable_name, co.unit
       FROM grn_consumable_lines gc
       JOIN consumables co ON co.id = gc.consumable_id
      WHERE gc.grn_id = ?`,
    [id],
  );

  return json(200, {
    grn: toGRNPublic(rows[0]),
    printerLines: printerLines.map((p) => ({
      id: p.id, printerId: p.printer_id, serialNo: p.serial_no,
      brand: p.brand, model: p.model, assetNo: p.asset_no,
      unitCost: p.unit_cost != null ? parseFloat(p.unit_cost) : null,
    })),
    consumableLines: consumableLines.map((c) => ({
      id: c.id, consumableId: c.consumable_id, sku: c.sku,
      consumableName: c.consumable_name, unit: c.unit,
      quantity: c.quantity,
      unitCost: c.unit_cost != null ? parseFloat(c.unit_cost) : null,
    })),
  });
});

// ---------------------------------------------------------------------------
// GRN — create
// Receives printers (optionally auto-transitioning to RECEIVED) and
// consumable batches (increasing stock at the target warehouse).
// ---------------------------------------------------------------------------
export const createGRN = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryGrn);

  const body = await readJson<Record<string, unknown>>(request);

  const warehouseId = Number(body.warehouseId);
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) return error(400, 'warehouseId is required');

  const printers = Array.isArray(body.printers) ? (body.printers as Record<string, unknown>[]) : [];
  const consumables = Array.isArray(body.consumables) ? (body.consumables as Record<string, unknown>[]) : [];

  // BR-022: at least one line.
  if (!printers.length && !consumables.length) {
    return error(400, 'A GRN must have at least one printer or consumable line', 'EMPTY_GRN');
  }

  // Verify warehouse.
  const wh = await query<RowDataPacket[]>(`SELECT id FROM warehouses WHERE id = ? LIMIT 1`, [warehouseId]);
  if (!wh.length) return error(404, 'Warehouse not found');

  // Verify all printers upfront.
  for (const line of printers) {
    const pid = Number(line.printerId);
    if (!Number.isInteger(pid) || pid <= 0) return error(400, 'Each printer line must have a valid printerId');
    const pr = await query<RowDataPacket[]>(`SELECT id FROM printers WHERE id = ? LIMIT 1`, [pid]);
    if (!pr.length) return error(404, `Printer id ${pid} not found`);
  }

  // Verify all consumables upfront.
  for (const line of consumables) {
    const cid = Number(line.consumableId);
    const qty = Number(line.quantity);
    if (!Number.isInteger(cid) || cid <= 0) return error(400, 'Each consumable line must have a valid consumableId');
    if (!Number.isInteger(qty) || qty <= 0) return error(400, 'Each consumable line must have a quantity > 0');
    const co = await query<RowDataPacket[]>(`SELECT id FROM consumables WHERE id = ? LIMIT 1`, [cid]);
    if (!co.length) return error(404, `Consumable id ${cid} not found`);
  }

  // Generate GRN number.
  const year = new Date().getFullYear();
  const [countRow] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM goods_receipt_notes WHERE YEAR(created_at) = ?`, [year],
  );
  const seq = String(Number(countRow.cnt) + 1).padStart(4, '0');
  const grnNo = `GRN-${year}-${seq}`;

  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  const result = await query<ResultSetHeader>(
    `INSERT INTO goods_receipt_notes (grn_no, warehouse_id, supplier_name, supplier_ref, notes, received_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [grnNo, warehouseId, str(body.supplierName), str(body.supplierRef), str(body.notes), ctx.userId],
  );
  const grnId = result.insertId;

  // Process printer lines — BR-023: auto-transition ORDERED/IN_TRANSIT → RECEIVED.
  for (const line of printers) {
    const pid = Number(line.printerId);
    const unitCost = line.unitCost != null ? Number(line.unitCost) : null;

    // Assign printer to this warehouse.
    await query(`UPDATE printers SET warehouse_id = ? WHERE id = ?`, [warehouseId, pid]);

    // Auto-transition to RECEIVED if applicable.
    const updated = await query<ResultSetHeader>(
      `UPDATE printers SET status = 'RECEIVED'
        WHERE id = ? AND status IN ('ORDERED', 'IN_TRANSIT')`,
      [pid],
    );
    if (updated.affectedRows > 0) {
      // Fetch the previous status to record it accurately.
      await query(
        `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
         SELECT ?, h.to_status, 'RECEIVED', ?, ?
           FROM printer_status_history h WHERE h.printer_id = ? ORDER BY h.changed_at DESC LIMIT 1`,
        [pid, `GRN ${grnNo}`, ctx.userId, pid],
      );
    }

    await query(
      `INSERT INTO grn_printer_lines (grn_id, printer_id, unit_cost) VALUES (?, ?, ?)`,
      [grnId, pid, unitCost],
    );
  }

  // Process consumable lines — increase stock at this warehouse.
  for (const line of consumables) {
    const cid = Number(line.consumableId);
    const qty = Number(line.quantity);
    const unitCost = line.unitCost != null ? Number(line.unitCost) : null;

    await query(
      `INSERT INTO consumable_stock (warehouse_id, consumable_id, qty_on_hand)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
      [warehouseId, cid, qty],
    );

    await query(
      `INSERT INTO grn_consumable_lines (grn_id, consumable_id, quantity, unit_cost) VALUES (?, ?, ?, ?)`,
      [grnId, cid, qty, unitCost],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'grn', entityId: grnId,
    action: 'create',
    changes: { after: { grnNo, warehouseId, printerCount: printers.length, consumableLineCount: consumables.length } },
    ipAddress: clientIp(request),
  });

  // Return the created GRN with its lines.
  const [grnRow] = await query<GRNRow[]>(
    `SELECT g.*, w.name AS warehouse_name, u.full_name AS received_by_name
       FROM goods_receipt_notes g
       JOIN warehouses w ON w.id = g.warehouse_id
       JOIN users u       ON u.id = g.received_by
      WHERE g.id = ? LIMIT 1`,
    [grnId],
  );

  return json(201, { grn: toGRNPublic(grnRow) });
});

// ---------------------------------------------------------------------------
// Consumables — list
// ---------------------------------------------------------------------------
export const listConsumables = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const rows = await query<ConsumableRow[]>(
    `SELECT co.*, u.full_name AS created_by_name,
            COALESCE((SELECT SUM(cs.qty_on_hand) FROM consumable_stock cs WHERE cs.consumable_id = co.id), 0) AS total_qty,
            EXISTS (SELECT 1 FROM consumable_stock cs
                     WHERE cs.consumable_id = co.id AND cs.qty_on_hand <= co.reorder_level) AS has_low_stock
       FROM consumables co
       LEFT JOIN users u ON u.id = co.created_by
      ORDER BY co.category ASC, co.name ASC`,
    [],
  );

  return json(200, {
    consumables: rows.map((r) => ({
      ...toConsumablePublic(r, {
        totalQtyOnHand: Number((r as RowDataPacket).total_qty) || 0,
        isLowStock: !!Number((r as RowDataPacket).has_low_stock),
      }),
    })),
  });
});

// ---------------------------------------------------------------------------
// Consumables — get detail
// ---------------------------------------------------------------------------
export const getConsumable = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryRead);

  const id = consumableIdParam(request);
  const consumable = await findConsumable(id);
  if (!consumable) return error(404, 'Consumable not found');

  const stock = await query<RowDataPacket[]>(
    `SELECT cs.qty_on_hand, w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name
       FROM consumable_stock cs
       JOIN warehouses w ON w.id = cs.warehouse_id
      WHERE cs.consumable_id = ?
      ORDER BY w.type ASC, w.name ASC`,
    [id],
  );

  return json(200, {
    consumable: toConsumablePublic(consumable),
    stock: stock.map((s) => ({
      warehouseId: s.warehouse_id,
      warehouseCode: s.warehouse_code,
      warehouseName: s.warehouse_name,
      qtyOnHand: s.qty_on_hand,
      isLowStock: s.qty_on_hand <= consumable.reorder_level,
    })),
  });
});

// ---------------------------------------------------------------------------
// Consumables — create
// ---------------------------------------------------------------------------
export const createConsumable = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAdjust);

  const body = await readJson<Record<string, unknown>>(request);

  const sku = String(body.sku ?? '').trim().toUpperCase();
  if (!sku) return error(400, 'SKU is required');

  const name = String(body.name ?? '').trim();
  if (!name) return error(400, 'Name is required');

  const category = String(body.category ?? 'TONER').toUpperCase();
  if (!VALID_CATEGORY.includes(category as (typeof VALID_CATEGORY)[number])) {
    return error(400, `category must be one of: ${VALID_CATEGORY.join(', ')}`);
  }

  const dup = await query<RowDataPacket[]>(`SELECT id FROM consumables WHERE sku = ? LIMIT 1`, [sku]);
  if (dup.length) return error(409, `SKU '${sku}' is already registered`, 'DUPLICATE_SKU');

  const reorderLevel = Number(body.reorderLevel ?? 0);
  if (!Number.isInteger(reorderLevel) || reorderLevel < 0) return error(400, 'reorderLevel must be a non-negative integer');

  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  const result = await query<ResultSetHeader>(
    `INSERT INTO consumables (sku, name, category, unit, reorder_level, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sku, name, category, str(body.unit) ?? 'unit', reorderLevel, str(body.description), ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'consumable', entityId: result.insertId,
    action: 'create', changes: { after: { sku, name, category } },
    ipAddress: clientIp(request),
  });

  const created = await findConsumable(result.insertId);
  return json(201, { consumable: created ? toConsumablePublic(created) : null });
});

// ---------------------------------------------------------------------------
// Consumables — update
// ---------------------------------------------------------------------------
export const updateConsumable = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAdjust);

  const id = consumableIdParam(request);
  const existing = await findConsumable(id);
  if (!existing) return error(404, 'Consumable not found');

  const body = await readJson<Record<string, unknown>>(request);
  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};
  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return error(400, 'Name cannot be empty');
    sets.push('name = ?'); params.push(name); after.name = name;
  }
  if (body.category !== undefined) {
    const cat = String(body.category).toUpperCase();
    if (!VALID_CATEGORY.includes(cat as (typeof VALID_CATEGORY)[number])) {
      return error(400, `category must be one of: ${VALID_CATEGORY.join(', ')}`);
    }
    sets.push('category = ?'); params.push(cat); after.category = cat;
  }
  if (body.unit !== undefined) {
    sets.push('unit = ?'); params.push(str(body.unit) ?? 'unit'); after.unit = body.unit;
  }
  if (body.reorderLevel !== undefined) {
    const lvl = Number(body.reorderLevel);
    if (!Number.isInteger(lvl) || lvl < 0) return error(400, 'reorderLevel must be a non-negative integer');
    sets.push('reorder_level = ?'); params.push(lvl); after.reorderLevel = lvl;
  }
  if (body.description !== undefined) {
    sets.push('description = ?'); params.push(str(body.description)); after.description = str(body.description);
  }
  if (body.isActive !== undefined) {
    sets.push('is_active = ?'); params.push(body.isActive ? 1 : 0); after.isActive = !!body.isActive;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE consumables SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'consumable', entityId: id,
    action: 'update', changes: { after }, ipAddress: clientIp(request),
  });

  const updated = await findConsumable(id);
  return json(200, { consumable: updated ? toConsumablePublic(updated) : null });
});

// ---------------------------------------------------------------------------
// Consumables — adjust stock
// POST /api/consumables/{id}/adjust
// Body: { warehouseId, delta, reason? }
// BR-021: delta that would take qty_on_hand < 0 is rejected.
// ---------------------------------------------------------------------------
export const adjustStock = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAdjust);

  const id = consumableIdParam(request);
  const consumable = await findConsumable(id);
  if (!consumable) return error(404, 'Consumable not found');

  const body = await readJson<Record<string, unknown>>(request);

  const warehouseId = Number(body.warehouseId);
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) return error(400, 'warehouseId is required');

  const delta = Number(body.delta);
  if (!Number.isInteger(delta) || delta === 0) return error(400, 'delta must be a non-zero integer');

  const wh = await query<RowDataPacket[]>(`SELECT id FROM warehouses WHERE id = ? LIMIT 1`, [warehouseId]);
  if (!wh.length) return error(404, 'Warehouse not found');

  // Current stock at this warehouse (0 if no row yet).
  const [stockRow] = await query<RowDataPacket[]>(
    `SELECT qty_on_hand FROM consumable_stock WHERE warehouse_id = ? AND consumable_id = ?`,
    [warehouseId, id],
  );
  const current = stockRow ? Number(stockRow.qty_on_hand) : 0;
  const newQty = current + delta;

  // BR-021: block negative stock.
  if (newQty < 0) {
    return error(
      422,
      `Insufficient stock at this warehouse. On hand: ${current}, requested change: ${delta}.`,
      'INSUFFICIENT_STOCK',
    );
  }

  await query(
    `INSERT INTO consumable_stock (warehouse_id, consumable_id, qty_on_hand)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE qty_on_hand = ?`,
    [warehouseId, id, newQty, newQty],
  );

  const reason = String(body.reason ?? '').trim() || null;
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'consumable_stock', entityId: id,
    action: delta > 0 ? 'stock_in' : 'stock_out',
    reason,
    changes: { before: { warehouseId, qtyOnHand: current }, after: { warehouseId, qtyOnHand: newQty } },
    ipAddress: clientIp(request),
  });

  return json(200, { warehouseId, consumableId: id, qtyOnHand: newQty, delta });
});

// ---------------------------------------------------------------------------
// Printer allocation
// POST /api/printers/{id}/allocate
// Body: { contractId, siteId? }
// BR-003: printer must be IN_STOCK with no current contract (double-alloc prevention).
// ---------------------------------------------------------------------------
export const allocatePrinter = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAllocate);

  const id = printerIdParam(request);
  const printer = await findPrinterForInventory(id);
  if (!printer) return error(404, 'Printer not found');

  // Must be IN_STOCK to allocate.
  if (printer.status !== 'IN_STOCK') {
    return error(
      422,
      `Printer cannot be allocated — current status is ${printer.status}. Only IN_STOCK printers can be allocated.`,
      'PRINTER_NOT_IN_STOCK',
    );
  }

  // BR-003 + double-allocation prevention: no existing contract.
  if (printer.current_contract_id !== null) {
    return error(
      409,
      'Printer is already linked to a contract. Deallocate it first.',
      'ALREADY_CONTRACTED',
    );
  }

  const body = await readJson<Record<string, unknown>>(request);
  const contractId = Number(body.contractId);
  if (!Number.isInteger(contractId) || contractId <= 0) return error(400, 'contractId is required');

  const siteId = body.siteId != null ? Number(body.siteId) : null;

  // Verify contract is ACTIVE.
  const [contract] = await query<RowDataPacket[]>(
    `SELECT id, status, contract_no FROM contracts WHERE id = ? LIMIT 1`,
    [contractId],
  );
  if (!contract) return error(404, 'Contract not found');
  if (contract.status !== 'ACTIVE') {
    return error(422, `Contract ${contract.contract_no} is not ACTIVE (status: ${contract.status})`, 'CONTRACT_NOT_ACTIVE');
  }

  await query(
    `UPDATE printers SET status = 'ALLOCATED', current_contract_id = ?, current_site_id = ? WHERE id = ?`,
    [contractId, siteId, id],
  );

  await query(
    `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
     VALUES (?, 'IN_STOCK', 'ALLOCATED', ?, ?)`,
    [id, `Allocated to contract ${contract.contract_no}`, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'printer', entityId: id,
    action: 'allocate',
    changes: { before: { status: 'IN_STOCK', contractId: null }, after: { status: 'ALLOCATED', contractId } },
    ipAddress: clientIp(request),
  });

  return json(200, {
    printerId: id, status: 'ALLOCATED', contractId, siteId,
    contractNo: contract.contract_no,
  });
});

// ---------------------------------------------------------------------------
// Printer deallocation
// POST /api/printers/{id}/deallocate
// Body: { reason? }
// Returns the printer to IN_STOCK and clears the contract link.
// ---------------------------------------------------------------------------
export const deallocatePrinter = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.inventoryAllocate);

  const id = printerIdParam(request);
  const printer = await findPrinterForInventory(id);
  if (!printer) return error(404, 'Printer not found');

  if (printer.status !== 'ALLOCATED') {
    return error(
      422,
      `Printer cannot be deallocated — current status is ${printer.status}. Only ALLOCATED printers can be deallocated.`,
      'PRINTER_NOT_ALLOCATED',
    );
  }

  const body = await readJson<Record<string, unknown>>(request);
  const reason = String(body.reason ?? '').trim() || 'Deallocated from contract';

  const prevContractId = printer.current_contract_id;

  await query(
    `UPDATE printers SET status = 'IN_STOCK', current_contract_id = NULL, current_site_id = NULL WHERE id = ?`,
    [id],
  );

  await query(
    `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
     VALUES (?, 'ALLOCATED', 'IN_STOCK', ?, ?)`,
    [id, reason, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'printer', entityId: id,
    action: 'deallocate',
    changes: { before: { status: 'ALLOCATED', contractId: prevContractId }, after: { status: 'IN_STOCK', contractId: null } },
    ipAddress: clientIp(request),
  });

  return json(200, { printerId: id, status: 'IN_STOCK', previousContractId: prevContractId });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('grns-list',            { methods: ['GET'],   authLevel: 'anonymous', route: 'grns',                           handler: listGRNs });
app.http('grns-get',             { methods: ['GET'],   authLevel: 'anonymous', route: 'grns/{id}',                      handler: getGRN });
app.http('grns-create',          { methods: ['POST'],  authLevel: 'anonymous', route: 'grns',                           handler: createGRN });

app.http('consumables-list',     { methods: ['GET'],   authLevel: 'anonymous', route: 'consumables',                    handler: listConsumables });
app.http('consumables-get',      { methods: ['GET'],   authLevel: 'anonymous', route: 'consumables/{id}',               handler: getConsumable });
app.http('consumables-create',   { methods: ['POST'],  authLevel: 'anonymous', route: 'consumables',                    handler: createConsumable });
app.http('consumables-update',   { methods: ['PATCH'], authLevel: 'anonymous', route: 'consumables/{id}',               handler: updateConsumable });
app.http('consumables-adjust',   { methods: ['POST'],  authLevel: 'anonymous', route: 'consumables/{id}/adjust',        handler: adjustStock });

app.http('printers-allocate',    { methods: ['POST'],  authLevel: 'anonymous', route: 'printers/{id}/allocate',         handler: allocatePrinter });
app.http('printers-deallocate',  { methods: ['POST'],  authLevel: 'anonymous', route: 'printers/{id}/deallocate',       handler: deallocatePrinter });

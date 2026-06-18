/**
 * Dispatch & Delivery Management (Module 6) — dispatch order endpoints.
 *
 *   GET    /api/dispatch-orders              list orders (optional ?status filter)
 *   GET    /api/dispatch-orders/{id}         order detail + printer items
 *   POST   /api/dispatch-orders              create order                 (dispatch.create)
 *   PATCH  /api/dispatch-orders/{id}         edit notes / courier / date  (dispatch.update)
 *   POST   /api/dispatch-orders/{id}/schedule PENDING → SCHEDULED         (dispatch.update)
 *   POST   /api/dispatch-orders/{id}/depart   SCHEDULED → IN_TRANSIT      (dispatch.deliver)
 *   POST   /api/dispatch-orders/{id}/deliver  IN_TRANSIT → DELIVERED      (dispatch.deliver)
 *   POST   /api/dispatch-orders/{id}/cancel   any active → CANCELLED      (dispatch.update)
 *
 * Business rules enforced:
 *   BR-020  Every printer on a dispatch order must be ALLOCATED at creation time.
 *   BR-024  A dispatch order must have at least one printer.
 *   BR-025  A printer may only appear on one active order (PENDING/SCHEDULED/IN_TRANSIT).
 *
 * Printer lifecycle side-effects:
 *   depart  → each printer: ALLOCATED → DISPATCHED  (history row written)
 *   deliver → each printer: DISPATCHED → INSTALLED   (history row written)
 *   cancel from IN_TRANSIT → each DISPATCHED printer reverted to ALLOCATED
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface OrderRow extends RowDataPacket {
  id: number;
  order_no: string;
  contract_id: number;
  contract_no: string;
  customer_id: number;
  customer_name: string;
  site_id: number | null;
  site_name: string | null;
  site_address: string | null;
  site_city: string | null;
  status: string;
  planned_date: string | null;
  courier: string | null;
  tracking_ref: string | null;
  departed_at: string | null;
  delivered_at: string | null;
  pod_recipient: string | null;
  pod_notes: string | null;
  notes: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow extends RowDataPacket {
  id: number;
  printer_id: number;
  serial_no: string;
  brand: string;
  model: string;
  asset_no: string | null;
  printer_status: string;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ['PENDING', 'SCHEDULED', 'IN_TRANSIT'] as const;

const ORDER_SELECT = `
  SELECT o.*,
         c.contract_no, cu.id AS customer_id, cu.name AS customer_name,
         s.name AS site_name, s.address AS site_address, s.city AS site_city,
         u.full_name AS created_by_name
    FROM dispatch_orders o
    JOIN contracts c  ON c.id  = o.contract_id
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN customer_sites s ON s.id = o.site_id
    JOIN users u ON u.id = o.created_by
`;

async function findOrder(id: number): Promise<OrderRow | null> {
  const rows = await query<OrderRow[]>(`${ORDER_SELECT} WHERE o.id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

async function fetchItems(orderId: number): Promise<ItemRow[]> {
  return query<ItemRow[]>(
    `SELECT doi.id, doi.printer_id, doi.notes,
            p.serial_no, p.brand, p.model, p.asset_no, p.status AS printer_status
       FROM dispatch_order_items doi
       JOIN printers p ON p.id = doi.printer_id
      WHERE doi.dispatch_order_id = ?
      ORDER BY doi.id ASC`,
    [orderId],
  );
}

function toOrderPublic(row: OrderRow) {
  return {
    id: row.id,
    orderNo: row.order_no,
    contractId: row.contract_id,
    contractNo: row.contract_no,
    customerId: row.customer_id,
    customerName: row.customer_name,
    siteId: row.site_id,
    siteName: row.site_name,
    siteAddress: row.site_address,
    siteCity: row.site_city,
    status: row.status,
    plannedDate: row.planned_date,
    courier: row.courier,
    trackingRef: row.tracking_ref,
    departedAt: row.departed_at,
    deliveredAt: row.delivered_at,
    podRecipient: row.pod_recipient,
    podNotes: row.pod_notes,
    notes: row.notes,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItemPublic(row: ItemRow) {
  return {
    id: row.id,
    printerId: row.printer_id,
    serialNo: row.serial_no,
    brand: row.brand,
    model: row.model,
    assetNo: row.asset_no,
    printerStatus: row.printer_status,
    notes: row.notes,
  };
}

function orderId(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid dispatch order id');
  return id;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v).trim() || null;
}

// ---------------------------------------------------------------------------
// GET /api/dispatch-orders
// ---------------------------------------------------------------------------
export const listDispatchOrders = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchRead);

  const statusFilter = request.query.get('status');
  const validStatuses = ['PENDING', 'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];

  let sql = `${ORDER_SELECT} WHERE 1=1`;
  const params: unknown[] = [];

  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim().toUpperCase()).filter((s) => validStatuses.includes(s));
    if (statuses.length) {
      sql += ` AND o.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
  }

  sql += ' ORDER BY o.created_at DESC';

  const rows = await query<OrderRow[]>(sql, params);
  return json(200, { orders: rows.map(toOrderPublic) });
});

// ---------------------------------------------------------------------------
// GET /api/dispatch-orders/{id}
// ---------------------------------------------------------------------------
export const getDispatchOrder = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchRead);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');

  const items = await fetchItems(id);

  return json(200, { order: toOrderPublic(order), items: items.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// POST /api/dispatch-orders
// Body: { contractId, siteId?, printerIds: number[], notes?, courier?, plannedDate?, trackingRef? }
// ---------------------------------------------------------------------------
export const createDispatchOrder = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchCreate);

  const body = await readJson<Record<string, unknown>>(request);

  const contractId = Number(body.contractId);
  if (!Number.isInteger(contractId) || contractId <= 0) return error(400, 'contractId is required');

  const printerIds: number[] = Array.isArray(body.printerIds)
    ? (body.printerIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  // BR-024: at least one printer.
  if (!printerIds.length) return error(400, 'At least one printer is required', 'NO_PRINTERS');

  // Verify contract exists and is ACTIVE.
  const [contract] = await query<RowDataPacket[]>(
    `SELECT id, status, contract_no FROM contracts WHERE id = ? LIMIT 1`,
    [contractId],
  );
  if (!contract) return error(404, 'Contract not found');
  if (contract.status !== 'ACTIVE') {
    return error(422, `Contract ${contract.contract_no as string} is not ACTIVE`, 'CONTRACT_NOT_ACTIVE');
  }

  const siteId = body.siteId != null ? Number(body.siteId) : null;

  // BR-020: all printers must be ALLOCATED.
  // BR-025: no printer may appear on another active dispatch order.
  for (const pid of printerIds) {
    const [printer] = await query<RowDataPacket[]>(
      `SELECT id, status, serial_no FROM printers WHERE id = ? LIMIT 1`,
      [pid],
    );
    if (!printer) return error(404, `Printer id ${pid} not found`);
    if (printer.status !== 'ALLOCATED') {
      return error(
        422,
        `Printer ${printer.serial_no as string} (id ${pid}) must be ALLOCATED — current status: ${printer.status as string}`,
        'PRINTER_NOT_ALLOCATED',
      );
    }

    const [activeDispatch] = await query<RowDataPacket[]>(
      `SELECT doi.id FROM dispatch_order_items doi
         JOIN dispatch_orders o ON o.id = doi.dispatch_order_id
        WHERE doi.printer_id = ? AND o.status IN ('PENDING','SCHEDULED','IN_TRANSIT')
        LIMIT 1`,
      [pid],
    );
    if (activeDispatch) {
      return error(
        409,
        `Printer ${printer.serial_no as string} is already on an active dispatch order`,
        'PRINTER_ALREADY_DISPATCHING',
      );
    }
  }

  // Generate order number.
  const year = new Date().getFullYear();
  const [countRow] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM dispatch_orders WHERE YEAR(created_at) = ?`,
    [year],
  );
  const seq = String(Number(countRow.cnt) + 1).padStart(4, '0');
  const orderNo = `DSP-${year}-${seq}`;

  const result = await query<ResultSetHeader>(
    `INSERT INTO dispatch_orders
       (order_no, contract_id, site_id, notes, courier, planned_date, tracking_ref, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderNo, contractId, siteId,
      str(body.notes), str(body.courier),
      str(body.plannedDate), str(body.trackingRef),
      ctx.userId,
    ],
  );
  const newId = result.insertId;

  for (const pid of printerIds) {
    await query(
      `INSERT INTO dispatch_order_items (dispatch_order_id, printer_id) VALUES (?, ?)`,
      [newId, pid],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: newId,
    action: 'create',
    changes: { after: { orderNo, contractId, printerIds } },
    ipAddress: clientIp(request),
  });

  const order = await findOrder(newId);
  const items = await fetchItems(newId);
  return json(201, { order: order ? toOrderPublic(order) : null, items: items.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// PATCH /api/dispatch-orders/{id}
// Editable while PENDING or SCHEDULED: notes, courier, trackingRef, plannedDate, siteId.
// ---------------------------------------------------------------------------
export const updateDispatchOrder = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchUpdate);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');

  if (!['PENDING', 'SCHEDULED'].includes(order.status)) {
    return error(422, `Cannot edit a dispatch order in ${order.status} status`, 'ORDER_NOT_EDITABLE');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  if (body.notes !== undefined)       { sets.push('notes = ?');        params.push(str(body.notes));        after.notes = str(body.notes); }
  if (body.courier !== undefined)     { sets.push('courier = ?');      params.push(str(body.courier));      after.courier = str(body.courier); }
  if (body.trackingRef !== undefined) { sets.push('tracking_ref = ?'); params.push(str(body.trackingRef)); after.trackingRef = str(body.trackingRef); }
  if (body.plannedDate !== undefined) { sets.push('planned_date = ?'); params.push(str(body.plannedDate)); after.plannedDate = str(body.plannedDate); }
  if (body.siteId !== undefined) {
    const sid = body.siteId != null ? Number(body.siteId) : null;
    sets.push('site_id = ?'); params.push(sid); after.siteId = sid;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE dispatch_orders SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: id,
    action: 'update', changes: { after }, ipAddress: clientIp(request),
  });

  const updated = await findOrder(id);
  const items = await fetchItems(id);
  return json(200, { order: updated ? toOrderPublic(updated) : null, items: items.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// POST /api/dispatch-orders/{id}/schedule
// PENDING → SCHEDULED.  Body: { plannedDate, courier?, trackingRef? }
// ---------------------------------------------------------------------------
export const scheduleDispatch = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchUpdate);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');
  if (order.status !== 'PENDING') {
    return error(422, `Order must be PENDING to schedule — current status: ${order.status}`, 'INVALID_TRANSITION');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const plannedDate = str(body.plannedDate);
  if (!plannedDate) return error(400, 'plannedDate is required to schedule a dispatch');

  await query(
    `UPDATE dispatch_orders SET status = 'SCHEDULED', planned_date = ?, courier = ?, tracking_ref = ? WHERE id = ?`,
    [plannedDate, str(body.courier), str(body.trackingRef), id],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: id,
    action: 'schedule',
    changes: { before: { status: 'PENDING' }, after: { status: 'SCHEDULED', plannedDate } },
    ipAddress: clientIp(request),
  });

  const updated = await findOrder(id);
  const items = await fetchItems(id);
  return json(200, { order: updated ? toOrderPublic(updated) : null, items: items.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// POST /api/dispatch-orders/{id}/depart
// SCHEDULED → IN_TRANSIT.  Transitions each printer ALLOCATED → DISPATCHED.
// ---------------------------------------------------------------------------
export const departDispatch = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchDeliver);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');
  if (order.status !== 'SCHEDULED') {
    return error(422, `Order must be SCHEDULED to depart — current status: ${order.status}`, 'INVALID_TRANSITION');
  }

  const items = await fetchItems(id);
  if (!items.length) return error(422, 'Dispatch order has no printer items', 'NO_PRINTERS');

  // Safety check: all printers must still be ALLOCATED.
  const notAllocated = items.filter((i) => i.printer_status !== 'ALLOCATED');
  if (notAllocated.length) {
    return error(
      422,
      `Printer(s) are no longer ALLOCATED: ${notAllocated.map((i) => i.serial_no).join(', ')}`,
      'PRINTER_NOT_ALLOCATED',
    );
  }

  // Transition each printer: ALLOCATED → DISPATCHED.
  for (const item of items) {
    await query(
      `UPDATE printers SET status = 'DISPATCHED' WHERE id = ?`,
      [item.printer_id],
    );
    await query(
      `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
       VALUES (?, 'ALLOCATED', 'DISPATCHED', ?, ?)`,
      [item.printer_id, `Dispatched on order ${order.order_no}`, ctx.userId],
    );
  }

  await query(
    `UPDATE dispatch_orders SET status = 'IN_TRANSIT', departed_at = NOW() WHERE id = ?`,
    [id],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: id,
    action: 'depart',
    changes: { before: { status: 'SCHEDULED' }, after: { status: 'IN_TRANSIT', printerCount: items.length } },
    ipAddress: clientIp(request),
  });

  const updated = await findOrder(id);
  const updatedItems = await fetchItems(id);
  return json(200, { order: updated ? toOrderPublic(updated) : null, items: updatedItems.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// POST /api/dispatch-orders/{id}/deliver
// IN_TRANSIT → DELIVERED.  Captures proof of delivery; transitions each
// printer DISPATCHED → INSTALLED.
// Body: { podRecipient, podNotes?, deliveredAt? }
// ---------------------------------------------------------------------------
export const deliverDispatch = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchDeliver);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');
  if (order.status !== 'IN_TRANSIT') {
    return error(422, `Order must be IN_TRANSIT to deliver — current status: ${order.status}`, 'INVALID_TRANSITION');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const podRecipient = str(body.podRecipient);
  if (!podRecipient) return error(400, 'podRecipient is required to confirm delivery');

  const deliveredAt = str(body.deliveredAt) ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
  const podNotes = str(body.podNotes);

  const items = await fetchItems(id);

  // Transition each printer: DISPATCHED → INSTALLED.
  for (const item of items) {
    await query(
      `UPDATE printers SET status = 'INSTALLED', current_site_id = COALESCE(current_site_id, ?) WHERE id = ?`,
      [order.site_id, item.printer_id],
    );
    await query(
      `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
       VALUES (?, 'DISPATCHED', 'INSTALLED', ?, ?)`,
      [item.printer_id, `Delivered — order ${order.order_no}, signed by ${podRecipient}`, ctx.userId],
    );
  }

  await query(
    `UPDATE dispatch_orders
        SET status = 'DELIVERED', delivered_at = ?, pod_recipient = ?, pod_notes = ?
      WHERE id = ?`,
    [deliveredAt, podRecipient, podNotes, id],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: id,
    action: 'deliver',
    changes: {
      before: { status: 'IN_TRANSIT' },
      after: { status: 'DELIVERED', podRecipient, deliveredAt, printerCount: items.length },
    },
    ipAddress: clientIp(request),
  });

  const updated = await findOrder(id);
  const updatedItems = await fetchItems(id);
  return json(200, { order: updated ? toOrderPublic(updated) : null, items: updatedItems.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// POST /api/dispatch-orders/{id}/cancel
// PENDING | SCHEDULED | IN_TRANSIT → CANCELLED.
// If IN_TRANSIT: reverts each DISPATCHED printer to ALLOCATED.
// Body: { reason? }
// ---------------------------------------------------------------------------
export const cancelDispatch = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.dispatchUpdate);

  const id = orderId(request);
  const order = await findOrder(id);
  if (!order) return error(404, 'Dispatch order not found');

  if (!(ACTIVE_STATUSES as readonly string[]).includes(order.status)) {
    return error(422, `Cannot cancel a ${order.status} order`, 'INVALID_TRANSITION');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const reason = str(body.reason) ?? 'Dispatch order cancelled';

  // If already IN_TRANSIT, revert DISPATCHED printers back to ALLOCATED.
  if (order.status === 'IN_TRANSIT') {
    const items = await fetchItems(id);
    for (const item of items) {
      if (item.printer_status === 'DISPATCHED') {
        await query(`UPDATE printers SET status = 'ALLOCATED' WHERE id = ?`, [item.printer_id]);
        await query(
          `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
           VALUES (?, 'DISPATCHED', 'ALLOCATED', ?, ?)`,
          [item.printer_id, `Dispatch order ${order.order_no} cancelled: ${reason}`, ctx.userId],
        );
      }
    }
  }

  await query(
    `UPDATE dispatch_orders SET status = 'CANCELLED', notes = CONCAT(COALESCE(notes, ''), ?) WHERE id = ?`,
    [reason ? `\n[Cancelled] ${reason}` : '', id],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'dispatch_order', entityId: id,
    action: 'cancel',
    changes: { before: { status: order.status }, after: { status: 'CANCELLED', reason } },
    ipAddress: clientIp(request),
  });

  const updated = await findOrder(id);
  const items = await fetchItems(id);
  return json(200, { order: updated ? toOrderPublic(updated) : null, items: items.map(toItemPublic) });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('dispatch-list',     { methods: ['GET'],   authLevel: 'anonymous', route: 'dispatch-orders',                handler: listDispatchOrders });
app.http('dispatch-get',      { methods: ['GET'],   authLevel: 'anonymous', route: 'dispatch-orders/{id}',          handler: getDispatchOrder });
app.http('dispatch-create',   { methods: ['POST'],  authLevel: 'anonymous', route: 'dispatch-orders',               handler: createDispatchOrder });
app.http('dispatch-update',   { methods: ['PATCH'], authLevel: 'anonymous', route: 'dispatch-orders/{id}',          handler: updateDispatchOrder });
app.http('dispatch-schedule', { methods: ['POST'],  authLevel: 'anonymous', route: 'dispatch-orders/{id}/schedule', handler: scheduleDispatch });
app.http('dispatch-depart',   { methods: ['POST'],  authLevel: 'anonymous', route: 'dispatch-orders/{id}/depart',   handler: departDispatch });
app.http('dispatch-deliver',  { methods: ['POST'],  authLevel: 'anonymous', route: 'dispatch-orders/{id}/deliver',  handler: deliverDispatch });
app.http('dispatch-cancel',   { methods: ['POST'],  authLevel: 'anonymous', route: 'dispatch-orders/{id}/cancel',   handler: cancelDispatch });

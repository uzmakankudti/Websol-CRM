/**
 * Toner / Consumable Shipment Management — Module 9.
 *
 * Builds on printers (Module 4) and the consumables catalogue (Module 5).
 *
 *   GET   /api/printers/{id}/toner              current level + offline estimate   toner.read
 *   PATCH /api/printers/{id}/toner              report toner reading               toner.update
 *   GET   /api/toner/shipments                  list shipments                     toner.read
 *   POST  /api/toner/shipments                  create shipment (BR-016)           toner.manage
 *   PATCH /api/toner/shipments/{id}             advance status; DELIVERED → 100%   toner.manage
 *   GET   /api/toner/alerts                     list toner alerts                  toner.read
 *   POST  /api/toner/alerts/{id}/suppress       suppress alert (BR-017)            toner.manage
 *
 * Business rules:
 *   BR-016  A printer may have at most one active (PENDING or IN_TRANSIT) shipment.
 *   BR-017  Toner ≤ 20% auto-inserts a LOW_20 alert; ≤ 10% also inserts CRITICAL_10.
 *           Either alert type may not be suppressed while toner is at or below 10%.
 *
 * Offline consumption estimate:
 *   estimatedDaysRemaining = Math.round( (tonerPct / 100) * TONER_PAGE_YIELD / dailyPageRate )
 *   Technicians report dailyPageRate from their local observation when offline.
 *   TONER_PAGE_YIELD defaults to 5 000 pages per cartridge.
 *
 * Delivery-reset-to-100% flow:
 *   Advancing a shipment to DELIVERED:
 *     1. Sets delivered_at timestamp on the shipment.
 *     2. Upserts printer_toner_levels to toner_pct = 100, clears estimate, sets last_change_at.
 *     3. Deletes all toner_alerts for that printer (fresh start after cartridge swap).
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Assumed pages per toner cartridge for the offline days-remaining estimate. */
const TONER_PAGE_YIELD = 5_000;

const ACTIVE_STATUSES = ['PENDING', 'IN_TRANSIT'] as const;
const ALL_STATUSES    = ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMysqlDt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function str(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

function printerId(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid printer id');
  return id;
}

/** Offline estimate: days of toner remaining given a daily page consumption rate. */
function calcEstimate(tonerPct: number, dailyPageRate: number | null): number | null {
  if (!dailyPageRate || dailyPageRate <= 0) return null;
  return Math.round((tonerPct / 100) * TONER_PAGE_YIELD / dailyPageRate);
}

// ---------------------------------------------------------------------------
// GET /api/printers/{id}/toner
// ---------------------------------------------------------------------------
export const getTonerLevel = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerRead);

  const pid = printerId(request);
  const [row] = await query<RowDataPacket[]>(
    `SELECT toner_pct, daily_page_rate, estimated_days_remaining, last_change_at, updated_at, updated_by
       FROM printer_toner_levels WHERE printer_id = ? LIMIT 1`,
    [pid],
  );
  if (!row) return error(404, 'No toner level recorded for this printer');

  return json(200, {
    printerId: pid,
    tonerPct: row.toner_pct,
    dailyPageRate: row.daily_page_rate ?? null,
    estimatedDaysRemaining: row.estimated_days_remaining ?? null,
    lastChangeAt: row.last_change_at ?? null,
    updatedAt: row.updated_at,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/printers/{id}/toner  — field technician reports a reading
// ---------------------------------------------------------------------------
export const updateTonerLevel = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerUpdate);

  const pid  = printerId(request);
  const body = await readJson<Record<string, unknown>>(request);

  const tonerPct = Number(body.tonerPct);
  if (!Number.isInteger(tonerPct) || tonerPct < 0 || tonerPct > 100) {
    return error(400, 'tonerPct must be an integer 0–100');
  }

  const dailyPageRate = body.dailyPageRate != null ? Number(body.dailyPageRate) : null;
  const estimatedDays = calcEstimate(tonerPct, dailyPageRate);

  // Upsert — one row per printer, updated in place.
  await query<ResultSetHeader>(
    `INSERT INTO printer_toner_levels
       (printer_id, toner_pct, daily_page_rate, estimated_days_remaining, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       toner_pct                = VALUES(toner_pct),
       daily_page_rate          = COALESCE(VALUES(daily_page_rate), daily_page_rate),
       estimated_days_remaining = VALUES(estimated_days_remaining),
       updated_by               = VALUES(updated_by)`,
    [pid, tonerPct, dailyPageRate, estimatedDays, ctx.userId],
  );

  // BR-017: raise alerts for low toner.  INSERT IGNORE on the UNIQUE KEY
  // (printer_id, alert_type) prevents duplicate alerts across readings.
  if (tonerPct <= 20) {
    await query(
      `INSERT IGNORE INTO toner_alerts (printer_id, alert_type, toner_pct) VALUES (?, 'LOW_20', ?)`,
      [pid, tonerPct],
    );
  }
  if (tonerPct <= 10) {
    await query(
      `INSERT IGNORE INTO toner_alerts (printer_id, alert_type, toner_pct) VALUES (?, 'CRITICAL_10', ?)`,
      [pid, tonerPct],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'printer_toner', entityId: pid, action: 'update',
    changes: { after: { tonerPct, dailyPageRate, estimatedDaysRemaining: estimatedDays } },
    ipAddress: clientIp(request),
  });

  return json(200, { tonerPct, estimatedDaysRemaining: estimatedDays });
});

// ---------------------------------------------------------------------------
// GET /api/toner/shipments
// ---------------------------------------------------------------------------
export const listTonerShipments = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerRead);

  const printerFilter = request.query.get('printerId');
  const statusFilter  = request.query.get('status');

  const where: string[] = [];
  const params: unknown[] = [];
  if (printerFilter) { where.push('s.printer_id = ?');  params.push(Number(printerFilter)); }
  if (statusFilter)  { where.push('s.status = ?');       params.push(statusFilter.toUpperCase()); }

  const rows = await query<RowDataPacket[]>(
    `SELECT s.id, s.printer_id, p.serial_no AS printer_serial, p.model AS printer_model,
            s.consumable_id, c.name AS consumable_name,
            s.status, s.tracking_ref, s.notes,
            s.shipped_at, s.delivered_at, s.created_at,
            u.full_name AS created_by_name
       FROM toner_shipments s
       JOIN printers   p ON p.id = s.printer_id
       LEFT JOIN consumables c ON c.id = s.consumable_id
       LEFT JOIN users u ON u.id = s.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.created_at DESC LIMIT 200`,
    params,
  );

  return json(200, {
    shipments: rows.map((r) => ({
      id: r.id,
      printerId: r.printer_id,
      printerSerial: r.printer_serial,
      printerModel: r.printer_model,
      consumableId: r.consumable_id ?? null,
      consumableName: r.consumable_name ?? null,
      status: r.status,
      trackingRef: r.tracking_ref ?? null,
      notes: r.notes ?? null,
      shippedAt: r.shipped_at ?? null,
      deliveredAt: r.delivered_at ?? null,
      createdAt: r.created_at,
      createdBy: r.created_by_name ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/toner/shipments  — BR-016: one active shipment per printer
// ---------------------------------------------------------------------------
export const createTonerShipment = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx  = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerManage);

  const body      = await readJson<Record<string, unknown>>(request);
  const pid       = Number(body.printerId);
  if (!Number.isInteger(pid) || pid <= 0) return error(400, 'printerId is required');

  // BR-016
  const [active] = await query<RowDataPacket[]>(
    `SELECT id FROM toner_shipments
      WHERE printer_id = ? AND status IN ('PENDING','IN_TRANSIT') LIMIT 1`,
    [pid],
  );
  if (active) {
    return error(409,
      'This printer already has an active toner shipment (BR-016). ' +
      'Cancel or deliver the existing one first.',
      'ACTIVE_SHIPMENT_EXISTS',
    );
  }

  const result = await query<ResultSetHeader>(
    `INSERT INTO toner_shipments (printer_id, consumable_id, tracking_ref, notes, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [pid, body.consumableId ?? null, str(body.trackingRef), str(body.notes), ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'toner_shipment', entityId: result.insertId, action: 'create',
    changes: { after: { printerId: pid, status: 'PENDING' } },
    ipAddress: clientIp(request),
  });

  return json(201, { id: result.insertId, printerId: pid, status: 'PENDING' });
});

// ---------------------------------------------------------------------------
// PATCH /api/toner/shipments/{id}  — advance status; DELIVERED resets toner
// ---------------------------------------------------------------------------
export const updateShipmentStatus = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerManage);

  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return error(400, 'Invalid shipment id');

  const body      = await readJson<Record<string, unknown>>(request);
  const newStatus = String(body.status ?? '').trim().toUpperCase();
  if (!(ALL_STATUSES as readonly string[]).includes(newStatus)) {
    return error(400, `status must be one of: ${ALL_STATUSES.join(', ')}`, 'INVALID_STATUS');
  }

  const [shipment] = await query<RowDataPacket[]>(
    `SELECT id, printer_id, status FROM toner_shipments WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!shipment) return error(404, 'Toner shipment not found');
  if (!( ACTIVE_STATUSES as readonly string[]).includes(shipment.status as string)) {
    return error(422,
      `Cannot update a ${shipment.status as string} shipment`,
      'INVALID_TRANSITION',
    );
  }

  const now = toMysqlDt(new Date());

  if (newStatus === 'DELIVERED') {
    await query(
      `UPDATE toner_shipments SET status = 'DELIVERED', delivered_at = ?, updated_by = ? WHERE id = ?`,
      [now, ctx.userId, id],
    );

    // Delivery-reset-to-100% flow: upsert toner level, clear outstanding alerts.
    await query(
      `INSERT INTO printer_toner_levels
         (printer_id, toner_pct, daily_page_rate, estimated_days_remaining, last_change_at, updated_by)
       VALUES (?, 100, NULL, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         toner_pct                = 100,
         daily_page_rate          = NULL,
         estimated_days_remaining = NULL,
         last_change_at           = VALUES(last_change_at),
         updated_by               = VALUES(updated_by)`,
      [shipment.printer_id, now, ctx.userId],
    );
    await query(`DELETE FROM toner_alerts WHERE printer_id = ?`, [shipment.printer_id]);
  } else if (newStatus === 'IN_TRANSIT') {
    await query(
      `UPDATE toner_shipments SET status = 'IN_TRANSIT', shipped_at = ?, updated_by = ? WHERE id = ?`,
      [now, ctx.userId, id],
    );
  } else {
    await query(
      `UPDATE toner_shipments SET status = ?, updated_by = ? WHERE id = ?`,
      [newStatus, ctx.userId, id],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'toner_shipment', entityId: id, action: 'update',
    changes: { after: { status: newStatus } },
    ipAddress: clientIp(request),
  });

  return json(200, { id, status: newStatus });
});

// ---------------------------------------------------------------------------
// GET /api/toner/alerts
// ---------------------------------------------------------------------------
export const listTonerAlerts = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerRead);

  const rows = await query<RowDataPacket[]>(
    `SELECT a.id, a.printer_id, p.serial_no AS printer_serial, p.model AS printer_model,
            a.alert_type, a.status, a.toner_pct, a.created_at
       FROM toner_alerts a
       JOIN printers p ON p.id = a.printer_id
      ORDER BY a.created_at DESC LIMIT 200`,
  );

  return json(200, {
    alerts: rows.map((r) => ({
      id: r.id,
      printerId: r.printer_id,
      printerSerial: r.printer_serial,
      printerModel: r.printer_model,
      alertType: r.alert_type,
      status: r.status,
      tonerPct: r.toner_pct ?? null,
      createdAt: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/toner/alerts/{id}/suppress  — BR-017: blocked below 10%
// ---------------------------------------------------------------------------
export const suppressAlert = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerManage);

  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return error(400, 'Invalid alert id');

  const [alert] = await query<RowDataPacket[]>(
    `SELECT id, printer_id, alert_type, status FROM toner_alerts WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!alert) return error(404, 'Toner alert not found');
  if (alert.status === 'SUPPRESSED') {
    return error(422, 'Alert is already suppressed', 'ALREADY_SUPPRESSED');
  }

  // BR-017: cannot suppress when toner is at or below 10%.
  const [level] = await query<RowDataPacket[]>(
    `SELECT toner_pct FROM printer_toner_levels WHERE printer_id = ? LIMIT 1`,
    [alert.printer_id],
  );
  if (level && Number(level.toner_pct) <= 10) {
    throw new HttpError(
      422,
      'Cannot suppress a toner alert when toner is at or below 10% (BR-017). ' +
      'Replace the cartridge first.',
      'CANNOT_SUPPRESS_CRITICAL',
    );
  }

  await query(`UPDATE toner_alerts SET status = 'SUPPRESSED' WHERE id = ?`, [id]);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'toner_alert', entityId: id, action: 'suppress',
    changes: { after: { status: 'SUPPRESSED' } },
    ipAddress: clientIp(request),
  });

  return json(200, { id, suppressed: true });
});

// ---------------------------------------------------------------------------
// GET /api/toner/levels  — all printer toner levels sorted by % ascending
// ---------------------------------------------------------------------------
export const listTonerLevels = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.tonerRead);

  const rows = await query<RowDataPacket[]>(
    `SELECT ptl.printer_id, p.serial_no AS printer_serial, p.model AS printer_model,
            p.brand AS printer_brand,
            ptl.toner_pct, ptl.daily_page_rate, ptl.estimated_days_remaining,
            ptl.last_change_at, ptl.updated_at
       FROM printer_toner_levels ptl
       JOIN printers p ON p.id = ptl.printer_id
      ORDER BY ptl.toner_pct ASC`,
  );

  return json(200, {
    levels: rows.map((r) => ({
      printerId: r.printer_id,
      printerSerial: r.printer_serial,
      printerModel: r.printer_model,
      printerBrand: r.printer_brand ?? null,
      tonerPct: r.toner_pct,
      dailyPageRate: r.daily_page_rate ?? null,
      estimatedDaysRemaining: r.estimated_days_remaining ?? null,
      lastChangeAt: r.last_change_at ?? null,
      updatedAt: r.updated_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// Scheduled scanner — proactively raises toner alerts every 15 minutes.
//
// The HTTP endpoints (updateTonerLevel) raise alerts reactively when a
// technician posts a new reading.  This timer covers printers that haven't
// had a new reading posted but whose stored level is already below threshold.
// ---------------------------------------------------------------------------
export async function processTonerLevels(): Promise<{ low20: number; critical10: number }> {
  // Printers at ≤ 20% with no existing LOW_20 alert.
  const low20Rows = await query<RowDataPacket[]>(
    `SELECT ptl.printer_id, ptl.toner_pct
       FROM printer_toner_levels ptl
      WHERE ptl.toner_pct <= 20
        AND NOT EXISTS (
          SELECT 1 FROM toner_alerts ta
           WHERE ta.printer_id = ptl.printer_id AND ta.alert_type = 'LOW_20'
        )`,
  );
  for (const row of low20Rows) {
    await query(
      `INSERT IGNORE INTO toner_alerts (printer_id, alert_type, toner_pct) VALUES (?, 'LOW_20', ?)`,
      [row.printer_id, row.toner_pct],
    );
  }

  // Printers at ≤ 10% with no existing CRITICAL_10 alert.
  const critical10Rows = await query<RowDataPacket[]>(
    `SELECT ptl.printer_id, ptl.toner_pct
       FROM printer_toner_levels ptl
      WHERE ptl.toner_pct <= 10
        AND NOT EXISTS (
          SELECT 1 FROM toner_alerts ta
           WHERE ta.printer_id = ptl.printer_id AND ta.alert_type = 'CRITICAL_10'
        )`,
  );
  for (const row of critical10Rows) {
    await query(
      `INSERT IGNORE INTO toner_alerts (printer_id, alert_type, toner_pct) VALUES (?, 'CRITICAL_10', ?)`,
      [row.printer_id, row.toner_pct],
    );
  }

  return { low20: low20Rows.length, critical10: critical10Rows.length };
}

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.timer('toner-level-check', {
  schedule: '0 */15 * * * *',
  handler: async () => { await processTonerLevels(); },
});

app.http('toner-levels-list',      { methods: ['GET'],   authLevel: 'anonymous', route: 'toner/levels',                handler: listTonerLevels });
app.http('toner-level-get',        { methods: ['GET'],   authLevel: 'anonymous', route: 'printers/{id}/toner',         handler: getTonerLevel });
app.http('toner-level-update',     { methods: ['PATCH'], authLevel: 'anonymous', route: 'printers/{id}/toner',         handler: updateTonerLevel });
app.http('toner-shipments-list',   { methods: ['GET'],   authLevel: 'anonymous', route: 'toner/shipments',             handler: listTonerShipments });
app.http('toner-shipments-create', { methods: ['POST'],  authLevel: 'anonymous', route: 'toner/shipments',             handler: createTonerShipment });
app.http('toner-shipments-update', { methods: ['PATCH'], authLevel: 'anonymous', route: 'toner/shipments/{id}',        handler: updateShipmentStatus });
app.http('toner-alerts-list',      { methods: ['GET'],   authLevel: 'anonymous', route: 'toner/alerts',                handler: listTonerAlerts });
app.http('toner-alerts-suppress',  { methods: ['POST'],  authLevel: 'anonymous', route: 'toner/alerts/{id}/suppress',  handler: suppressAlert });

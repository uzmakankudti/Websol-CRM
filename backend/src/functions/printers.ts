/**
 * Asset / Printer Management (Module 4) — printer endpoints.
 *
 *   GET    /api/printers             list printers (optional status / q filter)
 *   GET    /api/printers/{id}        printer + status history + allowed next states
 *   POST   /api/printers             register a printer              (printers.create)
 *   PATCH  /api/printers/{id}        edit printer details            (printers.update)
 *   POST   /api/printers/{id}/status transition lifecycle status     (printers.manage_status)
 *
 * Business rules enforced:
 *   BR-A01  Serial number is globally unique — checked before insert.
 *   BR-A02  RETIRED printers are immutable (PATCH and status change both reject).
 *   BR-A03  A printer may only link to one active contract at a time.
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

interface PrinterRow extends RowDataPacket {
  id: number;
  serial_no: string;
  asset_no: string | null;
  brand: string;
  model: string;
  print_technology: string;
  is_colour: number;
  ppm_bw: number | null;
  ppm_colour: number | null;
  lifetime_pages: number;
  location: string | null;
  warranty_expiry: string | null;
  current_contract_id: number | null;
  current_contract_no: string | null;
  current_site_id: number | null;
  current_site_name: string | null;
  status: string;
  notes: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoryRow extends RowDataPacket {
  id: number;
  printer_id: number;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  changed_by: number;
  changed_by_name: string | null;
  changed_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TECHNOLOGY = ['LASER', 'INKJET', 'LED', 'THERMAL', 'DOT_MATRIX', 'OTHER'] as const;

/** Valid lifecycle transitions. RETIRED is terminal — empty array. */
const TRANSITIONS: Record<string, readonly string[]> = {
  ORDERED:         ['IN_TRANSIT'],
  IN_TRANSIT:      ['RECEIVED'],
  RECEIVED:        ['QC_PASS', 'QC_FAIL'],
  QC_PASS:         ['IN_STOCK'],
  QC_FAIL:         ['RETURNED', 'UNDER_REPAIR'],
  IN_STOCK:        ['ALLOCATED', 'RETIRED'],
  ALLOCATED:       ['DISPATCHED', 'IN_STOCK'],
  DISPATCHED:      ['INSTALLED'],
  INSTALLED:       ['UNDER_REPAIR', 'REPLACEMENT_OUT', 'RETIRED'],
  UNDER_REPAIR:    ['INSTALLED', 'IN_STOCK', 'RETURNED'],
  REPLACEMENT_OUT: ['RETURNED', 'INSTALLED'],
  RETURNED:        ['REFURBISHED', 'RETIRED'],
  REFURBISHED:     ['IN_STOCK', 'RETIRED'],
  RETIRED:         [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printerIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid printer id');
  return id;
}

function toPrinterPublic(row: PrinterRow) {
  return {
    id: row.id,
    serialNo: row.serial_no,
    assetNo: row.asset_no,
    brand: row.brand,
    model: row.model,
    printTechnology: row.print_technology,
    isColour: !!row.is_colour,
    ppmBw: row.ppm_bw,
    ppmColour: row.ppm_colour,
    lifetimePages: row.lifetime_pages,
    location: row.location,
    warrantyExpiry: row.warranty_expiry,
    currentContractId: row.current_contract_id,
    currentContractNo: row.current_contract_no,
    currentSiteId: row.current_site_id,
    currentSiteName: row.current_site_name,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHistoryPublic(row: HistoryRow) {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    changedBy: { id: row.changed_by, fullName: row.changed_by_name },
    changedAt: row.changed_at,
  };
}

const PRINTER_SELECT = `
  SELECT p.*,
         u.full_name            AS created_by_name,
         c.contract_no          AS current_contract_no,
         cs.name                AS current_site_name
    FROM printers p
    LEFT JOIN users u           ON u.id  = p.created_by
    LEFT JOIN contracts c       ON c.id  = p.current_contract_id
    LEFT JOIN customer_sites cs ON cs.id = p.current_site_id`;

async function findPrinter(id: number): Promise<PrinterRow | null> {
  const rows = await query<PrinterRow[]>(`${PRINTER_SELECT} WHERE p.id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/printers
// ---------------------------------------------------------------------------
export const listPrinters = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.printersRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const status = request.query.get('status');
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }

  const q = request.query.get('q');
  if (q) {
    where.push('(p.serial_no LIKE ? OR p.brand LIKE ? OR p.model LIKE ? OR p.asset_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = await query<PrinterRow[]>(
    `${PRINTER_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC`,
    params,
  );

  return json(200, { printers: rows.map(toPrinterPublic) });
});

// ---------------------------------------------------------------------------
// GET /api/printers/{id}
// ---------------------------------------------------------------------------
export const getPrinter = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.printersRead);

  const id = printerIdParam(request);
  const printer = await findPrinter(id);
  if (!printer) return error(404, 'Printer not found');

  const history = await query<HistoryRow[]>(
    `SELECT h.*, u.full_name AS changed_by_name
       FROM printer_status_history h
       JOIN users u ON u.id = h.changed_by
      WHERE h.printer_id = ?
      ORDER BY h.changed_at ASC`,
    [id],
  );

  return json(200, {
    printer: toPrinterPublic(printer),
    history: history.map(toHistoryPublic),
    allowedTransitions: TRANSITIONS[printer.status] ?? [],
  });
});

// ---------------------------------------------------------------------------
// POST /api/printers
// ---------------------------------------------------------------------------
export const createPrinter = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.printersCreate);

  const body = await readJson<Record<string, unknown>>(request);

  const serial = String(body.serialNo ?? '').trim();
  if (!serial) return error(400, 'Serial number is required');

  const brand = String(body.brand ?? '').trim();
  if (!brand) return error(400, 'Brand is required');

  const model = String(body.model ?? '').trim();
  if (!model) return error(400, 'Model is required');

  const technology = String(body.printTechnology ?? 'LASER').toUpperCase();
  if (!VALID_TECHNOLOGY.includes(technology as (typeof VALID_TECHNOLOGY)[number])) {
    return error(400, `printTechnology must be one of: ${VALID_TECHNOLOGY.join(', ')}`);
  }

  // BR-A01: serial must be globally unique.
  const dup = await query<RowDataPacket[]>(
    `SELECT id FROM printers WHERE serial_no = ? LIMIT 1`,
    [serial],
  );
  if (dup.length) {
    return error(409, `Serial number '${serial}' is already registered`, 'DUPLICATE_SERIAL');
  }

  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s || null;
  };
  const posInt = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const isColour = body.isColour ? 1 : 0;

  const result = await query<ResultSetHeader>(
    `INSERT INTO printers
       (serial_no, asset_no, brand, model, print_technology, is_colour,
        ppm_bw, ppm_colour, lifetime_pages, location, warranty_expiry, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      serial,
      str(body.assetNo),
      brand,
      model,
      technology,
      isColour,
      posInt(body.ppmBw),
      isColour ? posInt(body.ppmColour) : null,
      str(body.location),
      str(body.warrantyExpiry),
      str(body.notes),
      ctx.userId,
    ],
  );

  // Initial history entry: from_status = NULL means "registered at ORDERED".
  await query(
    `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
     VALUES (?, NULL, 'ORDERED', 'Printer registered', ?)`,
    [result.insertId, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'printer',
    entityId: result.insertId,
    action: 'create',
    changes: { after: { serialNo: serial, brand, model, technology } },
    ipAddress: clientIp(request),
  });

  const created = await findPrinter(result.insertId);
  return json(201, { printer: created ? toPrinterPublic(created) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/printers/{id}
// ---------------------------------------------------------------------------
export const updatePrinter = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.printersUpdate);

  const id = printerIdParam(request);
  const existing = await findPrinter(id);
  if (!existing) return error(404, 'Printer not found');

  // BR-A02: RETIRED printers are immutable.
  if (existing.status === 'RETIRED') {
    return error(403, 'Retired printers cannot be edited', 'PRINTER_RETIRED');
  }

  const body = await readJson<Record<string, unknown>>(request);

  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s || null;
  };

  const simpleFields: Record<string, string> = {
    assetNo: 'asset_no',
    brand: 'brand',
    model: 'model',
    location: 'location',
    warrantyExpiry: 'warranty_expiry',
    notes: 'notes',
  };

  for (const [key, column] of Object.entries(simpleFields)) {
    if (body[key] === undefined) continue;
    if (key === 'brand' || key === 'model') {
      const v = String(body[key] ?? '').trim();
      if (!v) return error(400, `${key} cannot be empty`);
      sets.push(`${column} = ?`);
      params.push(v);
      after[key] = v;
    } else {
      const v = str(body[key]);
      sets.push(`${column} = ?`);
      params.push(v);
      after[key] = v;
    }
  }

  if (body.printTechnology !== undefined) {
    const tech = String(body.printTechnology).toUpperCase();
    if (!VALID_TECHNOLOGY.includes(tech as (typeof VALID_TECHNOLOGY)[number])) {
      return error(400, `printTechnology must be one of: ${VALID_TECHNOLOGY.join(', ')}`);
    }
    sets.push('print_technology = ?');
    params.push(tech);
    after.printTechnology = tech;
  }

  if (body.isColour !== undefined) {
    sets.push('is_colour = ?');
    params.push(body.isColour ? 1 : 0);
    after.isColour = !!body.isColour;
  }

  if (body.ppmBw !== undefined) {
    const v = body.ppmBw == null ? null : Number(body.ppmBw);
    sets.push('ppm_bw = ?');
    params.push(v != null && Number.isInteger(v) && v >= 0 ? v : null);
    after.ppmBw = v;
  }

  if (body.ppmColour !== undefined) {
    const v = body.ppmColour == null ? null : Number(body.ppmColour);
    sets.push('ppm_colour = ?');
    params.push(v != null && Number.isInteger(v) && v >= 0 ? v : null);
    after.ppmColour = v;
  }

  if (body.lifetimePages !== undefined) {
    const v = Number(body.lifetimePages);
    sets.push('lifetime_pages = ?');
    params.push(Number.isInteger(v) && v >= 0 ? v : 0);
    after.lifetimePages = v;
  }

  // BR-A03: enforce one active contract per printer.
  if (body.currentContractId !== undefined) {
    const newId = body.currentContractId == null ? null : Number(body.currentContractId);
    if (
      newId !== null &&
      existing.current_contract_id !== null &&
      existing.current_contract_id !== newId
    ) {
      return error(
        409,
        'Printer is already linked to a different contract. Clear the current contract first.',
        'ALREADY_CONTRACTED',
      );
    }
    sets.push('current_contract_id = ?');
    params.push(newId);
    after.currentContractId = newId;
  }

  if (body.currentSiteId !== undefined) {
    const siteId = body.currentSiteId == null ? null : Number(body.currentSiteId);
    sets.push('current_site_id = ?');
    params.push(siteId);
    after.currentSiteId = siteId;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE printers SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'printer',
    entityId: id,
    action: 'update',
    changes: { after },
    ipAddress: clientIp(request),
  });

  const updated = await findPrinter(id);
  return json(200, { printer: updated ? toPrinterPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// POST /api/printers/{id}/status
// ---------------------------------------------------------------------------
export const changePrinterStatus = handle(
  async (request: HttpRequest): Promise<HttpResponseInit> => {
    const ctx = requireAuth(request);
    requirePermission(ctx, PERMISSIONS.printersManageStatus);

    const id = printerIdParam(request);
    const printer = await findPrinter(id);
    if (!printer) return error(404, 'Printer not found');

    // BR-A02: RETIRED is terminal.
    if (printer.status === 'RETIRED') {
      return error(422, 'Retired printers cannot change status', 'PRINTER_RETIRED');
    }

    const body = await readJson<Record<string, unknown>>(request);
    const toStatus = String(body.toStatus ?? '').trim().toUpperCase();
    if (!toStatus) return error(400, 'toStatus is required');

    const allowed = TRANSITIONS[printer.status] ?? [];
    if (!allowed.includes(toStatus)) {
      return error(
        422,
        `Cannot transition from ${printer.status} to ${toStatus}. Allowed: ${allowed.join(', ') || 'none'}`,
        'INVALID_TRANSITION',
      );
    }

    const reason = String(body.reason ?? '').trim() || null;

    await query(`UPDATE printers SET status = ? WHERE id = ?`, [toStatus, id]);

    await query(
      `INSERT INTO printer_status_history (printer_id, from_status, to_status, reason, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, printer.status, toStatus, reason, ctx.userId],
    );

    await writeAudit({
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      entityType: 'printer',
      entityId: id,
      action: 'status_change',
      reason,
      changes: { before: { status: printer.status }, after: { status: toStatus } },
      ipAddress: clientIp(request),
    });

    const updated = await findPrinter(id);
    return json(200, { printer: updated ? toPrinterPublic(updated) : null });
  },
);

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('printers-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'printers',
  handler: listPrinters,
});
app.http('printers-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'printers',
  handler: createPrinter,
});
app.http('printers-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'printers/{id}',
  handler: getPrinter,
});
app.http('printers-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'printers/{id}',
  handler: updatePrinter,
});
app.http('printers-status', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'printers/{id}/status',
  handler: changePrinterStatus,
});

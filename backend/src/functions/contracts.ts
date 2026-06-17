/**
 * Customer & Contract Management — contract endpoints.
 *
 *   GET    /api/contracts                          list contracts (filters: status, customerId, expiring)
 *   GET    /api/contracts/expiring                 contracts expiring within N days (default 90)
 *   GET    /api/contracts/{id}                     contract + printers + documents + customer
 *   POST   /api/customers/{id}/contracts           create a DRAFT contract       (contracts.create)
 *   PATCH  /api/contracts/{id}                      edit a DRAFT contract          (contracts.update)
 *   DELETE /api/contracts/{id}                      delete a DRAFT contract        (contracts.update, BR-010)
 *   POST   /api/contracts/{id}/documents           attach a signed document       (contracts.update)
 *   GET    /api/contracts/{id}/documents/{docId}   download a document            (contracts.read)
 *   POST   /api/contracts/{id}/activate            DRAFT → ACTIVE                  (contracts.activate, BR-007)
 *   POST   /api/contracts/{id}/terminate           ACTIVE → TERMINATED            (contracts.terminate, BR-010)
 *
 * Business rules:
 *   BR-007  Activation requires at least one attached signed document.
 *   BR-008  end_date must be at least one month after start_date.
 *   BR-009  monthly_lease_fee > 0; per-click rates (B/W, colour) >= 0.
 *   BR-010  A contract may not be deleted once activated — terminate instead.
 *   Status  DRAFT → ACTIVE → EXPIRED | TERMINATED.
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

interface ContractRow extends RowDataPacket {
  id: number;
  customer_id: number;
  customer_name: string | null;
  contract_no: string;
  start_date: string;
  end_date: string;
  monthly_lease_fee: string;
  per_click_bw: string;
  per_click_colour: string;
  sla_tier: string;
  status: string;
  notes: string | null;
  activated_at: string | null;
  activated_by: number | null;
  activated_by_name: string | null;
  terminated_at: string | null;
  terminated_by: number | null;
  terminated_by_name: string | null;
  termination_reason: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface ContractPrinterRow extends RowDataPacket {
  id: number;
  contract_id: number;
  printer_model: string;
  serial_no: string | null;
  site_id: number | null;
  quantity: number;
}

interface DocumentRow extends RowDataPacket {
  id: number;
  contract_id: number;
  file_name: string;
  mime_type: string;
  file_size: number;
  uploaded_by: number;
  uploaded_by_name: string | null;
  uploaded_at: string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const SLA_TIERS = ['PLATINUM', 'GOLD', 'SILVER', 'BRONZE'] as const;
const EXPIRING_DEFAULT_DAYS = 90;

function contractIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid contract id');
  return id;
}

/** Parse a YYYY-MM-DD date string into a UTC Date, or null if invalid. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Guard against rollovers like 2026-02-31.
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return d;
}

/** The earliest legal end date for BR-008: start_date + 1 month. */
function minEndDate(start: Date): Date {
  const d = new Date(start);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // Handle month-length overflow (e.g. Jan 31 + 1 month should be Feb 28/29).
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/** Days from today (UTC) until the given YYYY-MM-DD date; negative if past. */
function daysUntil(dateStr: string): number {
  const target = parseDate(typeof dateStr === 'string' ? dateStr.slice(0, 10) : '');
  if (!target) return 0;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - todayUtc) / 86_400_000);
}

/**
 * Validate the pricing fields (BR-009). Returns an error message or null.
 * Be strict: values must be finite numbers; the fee must be strictly
 * positive; per-click rates must be non-negative.
 */
function validatePricing(fee: unknown, bw: unknown, colour: unknown): string | null {
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee <= 0) {
    return 'Monthly lease fee must be a number greater than 0 (BR-009)';
  }
  if (typeof bw !== 'number' || !Number.isFinite(bw) || bw < 0) {
    return 'Per-click B/W rate must be a number of 0 or more (BR-009)';
  }
  if (typeof colour !== 'number' || !Number.isFinite(colour) || colour < 0) {
    return 'Per-click colour rate must be a number of 0 or more (BR-009)';
  }
  return null;
}

function toContractPublic(row: ContractRow) {
  const endDate = typeof row.end_date === 'string' ? row.end_date.slice(0, 10) : row.end_date;
  const startDate =
    typeof row.start_date === 'string' ? row.start_date.slice(0, 10) : row.start_date;
  const days = daysUntil(String(endDate));
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    contractNo: row.contract_no,
    startDate,
    endDate,
    monthlyLeaseFee: parseFloat(row.monthly_lease_fee),
    perClickBw: parseFloat(row.per_click_bw),
    perClickColour: parseFloat(row.per_click_colour),
    slaTier: row.sla_tier,
    status: row.status,
    notes: row.notes,
    daysUntilExpiry: days,
    expiringSoon: row.status === 'ACTIVE' && days >= 0 && days <= EXPIRING_DEFAULT_DAYS,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by
      ? { id: row.activated_by, fullName: row.activated_by_name }
      : null,
    terminatedAt: row.terminated_at,
    terminatedBy: row.terminated_by
      ? { id: row.terminated_by, fullName: row.terminated_by_name }
      : null,
    terminationReason: row.termination_reason,
    createdBy: { id: row.created_by, fullName: row.created_by_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_CONTRACT = `
  SELECT c.*,
         cu.name        AS customer_name,
         ab.full_name   AS activated_by_name,
         tb.full_name   AS terminated_by_name,
         cb.full_name   AS created_by_name
    FROM contracts c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN users ab     ON ab.id = c.activated_by
    LEFT JOIN users tb     ON tb.id = c.terminated_by
    LEFT JOIN users cb     ON cb.id = c.created_by`;

async function findContract(id: number): Promise<ContractRow | null> {
  const rows = await query<ContractRow[]>(`${SELECT_CONTRACT} WHERE c.id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

async function loadContractPrinters(contractId: number): Promise<ContractPrinterRow[]> {
  return query<ContractPrinterRow[]>(
    `SELECT id, contract_id, printer_model, serial_no, site_id, quantity
       FROM contract_printers WHERE contract_id = ? ORDER BY id ASC`,
    [contractId],
  );
}

/**
 * Flip ACTIVE contracts whose end date has passed to EXPIRED so the stored
 * status stays truthful. Called from the read endpoints; cheap and idempotent.
 */
async function autoExpire(): Promise<void> {
  await query(
    `UPDATE contracts SET status = 'EXPIRED'
      WHERE status = 'ACTIVE' AND end_date < CURDATE()`,
  );
}

// ---------------------------------------------------------------------------
// GET /api/contracts
// ---------------------------------------------------------------------------
export const listContracts = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsRead);

  await autoExpire();

  const where: string[] = [];
  const params: unknown[] = [];

  const status = request.query.get('status');
  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  const customerId = request.query.get('customerId');
  if (customerId) {
    where.push('c.customer_id = ?');
    params.push(Number(customerId));
  }
  // expiring=1 → ACTIVE contracts ending within the expiry window.
  if (request.query.get('expiring')) {
    where.push(
      "c.status = 'ACTIVE' AND c.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)",
    );
    params.push(EXPIRING_DEFAULT_DAYS);
  }
  const q = request.query.get('q');
  if (q) {
    where.push('(c.contract_no LIKE ? OR cu.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const rows = await query<ContractRow[]>(
    `${SELECT_CONTRACT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.end_date ASC`,
    params,
  );

  return json(200, { contracts: rows.map(toContractPublic) });
});

// ---------------------------------------------------------------------------
// GET /api/contracts/expiring — contracts expiring within `days` (default 90)
// ---------------------------------------------------------------------------
export const expiringContracts = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsRead);

  await autoExpire();

  const daysRaw = Number(request.query.get('days'));
  const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : EXPIRING_DEFAULT_DAYS;

  const rows = await query<ContractRow[]>(
    `${SELECT_CONTRACT}
      WHERE c.status = 'ACTIVE'
        AND c.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY c.end_date ASC`,
    [days],
  );

  return json(200, { windowDays: days, contracts: rows.map(toContractPublic) });
});

// ---------------------------------------------------------------------------
// GET /api/contracts/{id}
// ---------------------------------------------------------------------------
export const getContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsRead);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  const printers = await loadContractPrinters(id);
  const documents = await query<DocumentRow[]>(
    `SELECT d.id, d.contract_id, d.file_name, d.mime_type, d.file_size,
            d.uploaded_by, u.full_name AS uploaded_by_name, d.uploaded_at
       FROM contract_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.contract_id = ?
      ORDER BY d.uploaded_at DESC`,
    [id],
  );

  return json(200, {
    contract: toContractPublic(contract),
    printers: printers.map((p) => ({
      id: p.id,
      printerModel: p.printer_model,
      serialNo: p.serial_no,
      siteId: p.site_id,
      quantity: p.quantity,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      fileName: d.file_name,
      mimeType: d.mime_type,
      fileSize: d.file_size,
      uploadedBy: d.uploaded_by ? { id: d.uploaded_by, fullName: d.uploaded_by_name } : null,
      uploadedAt: d.uploaded_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/customers/{id}/contracts — create a DRAFT contract
// ---------------------------------------------------------------------------
export const createContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsCreate);

  const customerId = Number(request.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) return error(400, 'Invalid customer id');

  const customer = await query<RowDataPacket[]>(`SELECT id FROM customers WHERE id = ? LIMIT 1`, [
    customerId,
  ]);
  if (!customer.length) return error(404, 'Customer not found');

  const body = await readJson<{
    startDate?: string;
    endDate?: string;
    monthlyLeaseFee?: number;
    perClickBw?: number;
    perClickColour?: number;
    slaTier?: string;
    notes?: string | null;
    printers?: { printerModel?: string; serialNo?: string | null; quantity?: number }[];
  }>(request);

  // --- dates (BR-008) ---
  const start = parseDate(body.startDate);
  const end = parseDate(body.endDate);
  if (!start) return error(400, 'startDate is required (format YYYY-MM-DD)');
  if (!end) return error(400, 'endDate is required (format YYYY-MM-DD)');
  if (end.getTime() < minEndDate(start).getTime()) {
    return error(
      400,
      'End date must be at least one month after the start date (BR-008)',
      'INVALID_DURATION',
    );
  }

  // --- pricing (BR-009) ---
  const priceErr = validatePricing(body.monthlyLeaseFee, body.perClickBw, body.perClickColour);
  if (priceErr) return error(400, priceErr, 'INVALID_PRICING');

  // --- SLA tier ---
  const slaTier = (body.slaTier ?? 'BRONZE') as (typeof SLA_TIERS)[number];
  if (!SLA_TIERS.includes(slaTier)) {
    return error(400, `slaTier must be one of: ${SLA_TIERS.join(', ')}`);
  }

  // --- printers (at least one) ---
  if (!body.printers?.length) {
    return error(400, 'A contract must cover at least one printer');
  }
  for (const p of body.printers) {
    if (!p.printerModel?.trim()) return error(400, 'Each printer line needs a model');
    const qty = p.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1) {
      return error(400, 'Printer quantity must be a positive integer');
    }
  }

  const result = await query<ResultSetHeader>(
    `INSERT INTO contracts
       (customer_id, contract_no, start_date, end_date, monthly_lease_fee,
        per_click_bw, per_click_colour, sla_tier, status, notes, created_by)
     VALUES (?, CONCAT('TMP-', UUID()), ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    [
      customerId,
      body.startDate,
      body.endDate,
      body.monthlyLeaseFee,
      body.perClickBw,
      body.perClickColour,
      slaTier,
      body.notes?.trim() || null,
      ctx.userId,
    ],
  );

  const contractId = result.insertId;

  // Assign a human-readable contract number now that we have the id.
  await query(
    `UPDATE contracts
        SET contract_no = CONCAT('CT-', DATE_FORMAT(start_date, '%Y'), '-', LPAD(id, 5, '0'))
      WHERE id = ?`,
    [contractId],
  );

  for (const p of body.printers) {
    await query(
      `INSERT INTO contract_printers (contract_id, printer_model, serial_no, quantity)
       VALUES (?, ?, ?, ?)`,
      [contractId, p.printerModel!.trim(), p.serialNo?.trim() || null, p.quantity ?? 1],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract',
    entityId: contractId,
    action: 'create',
    changes: {
      after: {
        customerId,
        startDate: body.startDate,
        endDate: body.endDate,
        monthlyLeaseFee: body.monthlyLeaseFee,
        slaTier,
        status: 'DRAFT',
      },
    },
    ipAddress: clientIp(request),
  });

  const created = await findContract(contractId);
  return json(201, { contract: created ? toContractPublic(created) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/contracts/{id} — edit a DRAFT contract
// ---------------------------------------------------------------------------
export const updateContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsUpdate);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  // Only DRAFT contracts may have their terms edited; once active the terms
  // are fixed (changes would require a new contract).
  if (contract.status !== 'DRAFT') {
    return error(
      422,
      `Only DRAFT contracts can be edited; this contract is ${contract.status}`,
      'CONTRACT_NOT_EDITABLE',
    );
  }

  const body = await readJson<{
    startDate?: string;
    endDate?: string;
    monthlyLeaseFee?: number;
    perClickBw?: number;
    perClickColour?: number;
    slaTier?: string;
    notes?: string | null;
    printers?: { printerModel?: string; serialNo?: string | null; quantity?: number }[];
  }>(request);

  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  // Dates are validated together so BR-008 always holds after the edit.
  const startStr = body.startDate ?? contract.start_date.slice(0, 10);
  const endStr = body.endDate ?? String(contract.end_date).slice(0, 10);
  if (body.startDate !== undefined || body.endDate !== undefined) {
    const start = parseDate(startStr);
    const end = parseDate(endStr);
    if (!start) return error(400, 'startDate must be a valid date (YYYY-MM-DD)');
    if (!end) return error(400, 'endDate must be a valid date (YYYY-MM-DD)');
    if (end.getTime() < minEndDate(start).getTime()) {
      return error(
        400,
        'End date must be at least one month after the start date (BR-008)',
        'INVALID_DURATION',
      );
    }
    if (body.startDate !== undefined) {
      sets.push('start_date = ?');
      params.push(startStr);
      after.startDate = startStr;
    }
    if (body.endDate !== undefined) {
      sets.push('end_date = ?');
      params.push(endStr);
      after.endDate = endStr;
    }
  }

  // Pricing — validate using the post-edit values (BR-009).
  if (
    body.monthlyLeaseFee !== undefined ||
    body.perClickBw !== undefined ||
    body.perClickColour !== undefined
  ) {
    const fee = body.monthlyLeaseFee ?? parseFloat(contract.monthly_lease_fee);
    const bw = body.perClickBw ?? parseFloat(contract.per_click_bw);
    const colour = body.perClickColour ?? parseFloat(contract.per_click_colour);
    const priceErr = validatePricing(fee, bw, colour);
    if (priceErr) return error(400, priceErr, 'INVALID_PRICING');
    if (body.monthlyLeaseFee !== undefined) {
      sets.push('monthly_lease_fee = ?');
      params.push(fee);
      after.monthlyLeaseFee = fee;
    }
    if (body.perClickBw !== undefined) {
      sets.push('per_click_bw = ?');
      params.push(bw);
      after.perClickBw = bw;
    }
    if (body.perClickColour !== undefined) {
      sets.push('per_click_colour = ?');
      params.push(colour);
      after.perClickColour = colour;
    }
  }

  if (body.slaTier !== undefined) {
    if (!SLA_TIERS.includes(body.slaTier as (typeof SLA_TIERS)[number])) {
      return error(400, `slaTier must be one of: ${SLA_TIERS.join(', ')}`);
    }
    sets.push('sla_tier = ?');
    params.push(body.slaTier);
    after.slaTier = body.slaTier;
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    params.push(body.notes?.trim() || null);
    after.notes = body.notes?.trim() || null;
  }

  // Optional full replacement of printer lines.
  let replacePrinters = false;
  if (body.printers !== undefined) {
    if (!body.printers.length) return error(400, 'A contract must cover at least one printer');
    for (const p of body.printers) {
      if (!p.printerModel?.trim()) return error(400, 'Each printer line needs a model');
      const qty = p.quantity ?? 1;
      if (!Number.isInteger(qty) || qty < 1) {
        return error(400, 'Printer quantity must be a positive integer');
      }
    }
    replacePrinters = true;
  }

  if (!sets.length && !replacePrinters) return error(400, 'No changes supplied');

  if (sets.length) {
    params.push(id);
    await query(`UPDATE contracts SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  if (replacePrinters) {
    await query(`DELETE FROM contract_printers WHERE contract_id = ?`, [id]);
    for (const p of body.printers!) {
      await query(
        `INSERT INTO contract_printers (contract_id, printer_model, serial_no, quantity)
         VALUES (?, ?, ?, ?)`,
        [id, p.printerModel!.trim(), p.serialNo?.trim() || null, p.quantity ?? 1],
      );
    }
  }

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract',
    entityId: id,
    action: 'update',
    changes: { after },
    ipAddress: clientIp(request),
  });

  const updated = await findContract(id);
  return json(200, { contract: updated ? toContractPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// DELETE /api/contracts/{id} — BR-010: only DRAFT contracts may be deleted
// ---------------------------------------------------------------------------
export const deleteContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsUpdate);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  if (contract.status !== 'DRAFT') {
    return error(
      422,
      'This contract has been activated and cannot be deleted. Terminate it instead (BR-010).',
      'CONTRACT_NOT_DELETABLE',
    );
  }

  await query(`DELETE FROM contracts WHERE id = ?`, [id]);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract',
    entityId: id,
    action: 'delete',
    changes: { before: { contractNo: contract.contract_no, status: 'DRAFT' } },
    ipAddress: clientIp(request),
  });

  return json(200, { deleted: true });
});

// ---------------------------------------------------------------------------
// POST /api/contracts/{id}/documents — attach a signed document
// ---------------------------------------------------------------------------
export const uploadDocument = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsUpdate);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  if (contract.status === 'TERMINATED') {
    return error(422, 'Cannot attach documents to a terminated contract', 'CONTRACT_TERMINATED');
  }

  const body = await readJson<{
    fileName?: string;
    mimeType?: string;
    content?: string; // base64-encoded
  }>(request);

  const fileName = body.fileName?.trim();
  const content = body.content;
  if (!fileName) return error(400, 'fileName is required');
  if (!content || typeof content !== 'string') {
    return error(400, 'content (base64-encoded file) is required');
  }
  const mimeType = body.mimeType?.trim() || 'application/octet-stream';
  // Approximate decoded byte size from the base64 length.
  const fileSize = Math.floor((content.length * 3) / 4);

  const result = await query<ResultSetHeader>(
    `INSERT INTO contract_documents (contract_id, file_name, mime_type, file_size, content, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, fileName, mimeType, fileSize, content, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract_document',
    entityId: result.insertId,
    action: 'upload',
    changes: { after: { contractId: id, fileName, fileSize } },
    ipAddress: clientIp(request),
  });

  return json(201, {
    document: {
      id: result.insertId,
      fileName,
      mimeType,
      fileSize,
      uploadedBy: { id: ctx.userId, fullName: null },
      uploadedAt: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/contracts/{id}/documents/{docId} — download a document
// ---------------------------------------------------------------------------
export const downloadDocument = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsRead);

  const id = contractIdParam(request);
  const docId = Number(request.params.docId);
  if (!Number.isInteger(docId) || docId <= 0) return error(400, 'Invalid document id');

  const rows = await query<RowDataPacket[]>(
    `SELECT file_name, mime_type, file_size, content
       FROM contract_documents WHERE id = ? AND contract_id = ? LIMIT 1`,
    [docId, id],
  );
  if (!rows.length) return error(404, 'Document not found');

  const doc = rows[0];
  return json(200, {
    document: {
      id: docId,
      fileName: doc.file_name,
      mimeType: doc.mime_type,
      fileSize: doc.file_size,
      content: doc.content, // base64
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/contracts/{id}/activate — DRAFT → ACTIVE (BR-007)
// ---------------------------------------------------------------------------
export const activateContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsActivate);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  if (contract.status !== 'DRAFT') {
    return error(
      422,
      `Only DRAFT contracts can be activated; this contract is ${contract.status}`,
      'INVALID_STATUS',
    );
  }

  // BR-007 — a signed document must be attached before activation.
  const docs = await query<RowDataPacket[]>(
    `SELECT id FROM contract_documents WHERE contract_id = ? LIMIT 1`,
    [id],
  );
  if (!docs.length) {
    return error(
      422,
      'This contract cannot be activated without a signed contract document attached (BR-007).',
      'NO_SIGNED_DOCUMENT',
    );
  }

  // Defence in depth: re-check the invariants before going live.
  const priceErr = validatePricing(
    parseFloat(contract.monthly_lease_fee),
    parseFloat(contract.per_click_bw),
    parseFloat(contract.per_click_colour),
  );
  if (priceErr) return error(422, priceErr, 'INVALID_PRICING');

  await query(
    `UPDATE contracts SET status = 'ACTIVE', activated_at = NOW(), activated_by = ? WHERE id = ?`,
    [ctx.userId, id],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract',
    entityId: id,
    action: 'activate',
    changes: { before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } },
    ipAddress: clientIp(request),
  });

  const updated = await findContract(id);
  return json(200, { contract: updated ? toContractPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// POST /api/contracts/{id}/terminate — ACTIVE/EXPIRED → TERMINATED (BR-010)
// ---------------------------------------------------------------------------
export const terminateContract = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.contractsTerminate);

  const id = contractIdParam(request);
  const contract = await findContract(id);
  if (!contract) return error(404, 'Contract not found');

  if (contract.status !== 'ACTIVE' && contract.status !== 'EXPIRED') {
    return error(
      422,
      `Only ACTIVE or EXPIRED contracts can be terminated; this contract is ${contract.status}`,
      'INVALID_STATUS',
    );
  }

  const body = await readJson<{ reason?: string }>(request);
  const reason = body.reason?.trim();
  if (!reason) return error(400, 'A termination reason is required');

  await query(
    `UPDATE contracts
        SET status = 'TERMINATED', terminated_at = NOW(), terminated_by = ?, termination_reason = ?
      WHERE id = ?`,
    [ctx.userId, reason, id],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'contract',
    entityId: id,
    action: 'terminate',
    reason,
    changes: { before: { status: contract.status }, after: { status: 'TERMINATED' } },
    ipAddress: clientIp(request),
  });

  const updated = await findContract(id);
  return json(200, { contract: updated ? toContractPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('contracts-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'contracts',
  handler: listContracts,
});
app.http('contracts-expiring', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'contracts/expiring',
  handler: expiringContracts,
});
app.http('contracts-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'contracts/{id}',
  handler: getContract,
});
app.http('customers-contracts-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'customers/{id}/contracts',
  handler: createContract,
});
app.http('contracts-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'contracts/{id}',
  handler: updateContract,
});
app.http('contracts-delete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'contracts/{id}',
  handler: deleteContract,
});
app.http('contracts-documents-upload', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contracts/{id}/documents',
  handler: uploadDocument,
});
app.http('contracts-documents-download', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'contracts/{id}/documents/{docId}',
  handler: downloadDocument,
});
app.http('contracts-activate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contracts/{id}/activate',
  handler: activateContract,
});
app.http('contracts-terminate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contracts/{id}/terminate',
  handler: terminateContract,
});

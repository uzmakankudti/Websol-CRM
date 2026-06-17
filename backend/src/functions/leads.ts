/**
 * Lead & Opportunity Management endpoints.
 *
 *   GET    /api/leads                              list leads
 *   GET    /api/leads/{id}                         lead + quotations + stage history
 *   POST   /api/leads                              create lead            (leads.create)
 *   PATCH  /api/leads/{id}                         edit lead details      (leads.update)
 *   PATCH  /api/leads/{id}/stage                   advance / close stage  (leads.change_stage)
 *   POST   /api/leads/{id}/quotations              create quotation       (quotations.create)
 *   PATCH  /api/leads/{id}/quotations/{qid}/approve  approve / reject     (quotations.approve)
 *   POST   /api/leads/{id}/convert                 convert to customer    (leads.convert)
 *
 * Business rules:
 *   BR-024  Conversion requires at least one APPROVED quotation on the lead.
 *   Stages  NEW → CONTACTED → PROPOSAL_SENT → WON | LOST (terminal).
 *           Any active stage may also move directly to LOST.
 *   Approval  discount_pct > 0  → status = PENDING_APPROVAL (manager must act).
 *             discount_pct = 0  → status = APPROVED immediately.
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

interface LeadRow extends RowDataPacket {
  id: number;
  company_name: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  source: string;
  expected_printers: number;
  stage: string;
  stage_note: string | null;
  assigned_to: number | null;
  assigned_to_name: string | null;
  lost_reason: string | null;
  converted_customer_id: number | null;
  converted_at: string | null;
  converted_by: number | null;
  converted_by_name: string | null;
  created_by: number;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

interface QuotationRow extends RowDataPacket {
  id: number;
  lead_id: number;
  monthly_lease_fee: string;
  per_page_bw: string;
  per_page_colour: string;
  discount_pct: string;
  notes: string | null;
  status: string;
  approved_by: number | null;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_note: string | null;
  created_by: number;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

interface PrinterRow extends RowDataPacket {
  id: number;
  quotation_id: number;
  printer_model: string;
  quantity: number;
}

interface StageHistoryRow extends RowDataPacket {
  id: number;
  lead_id: number;
  from_stage: string | null;
  to_stage: string;
  note: string | null;
  changed_by: number;
  changed_by_name: string;
  changed_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_ORDER = ['NEW', 'CONTACTED', 'PROPOSAL_SENT', 'WON', 'LOST'] as const;
type Stage = (typeof STAGE_ORDER)[number];

const VALID_TRANSITIONS: Record<Stage, Stage[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['PROPOSAL_SENT', 'LOST'],
  PROPOSAL_SENT: ['WON', 'LOST'],
  WON: [],
  LOST: [],
};

const VALID_SOURCES = ['REFERRAL', 'WEBSITE', 'COLD_CALL', 'EXHIBITION', 'OTHER'] as const;

function leadIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid lead id');
  return id;
}

function quotationIdParam(request: HttpRequest): number {
  const id = Number(request.params.qid);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid quotation id');
  return id;
}

function toLeadPublic(row: LeadRow) {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    source: row.source,
    expectedPrinters: row.expected_printers,
    stage: row.stage,
    stageNote: row.stage_note,
    assignedTo: row.assigned_to
      ? { id: row.assigned_to, fullName: row.assigned_to_name }
      : null,
    lostReason: row.lost_reason,
    convertedCustomerId: row.converted_customer_id,
    convertedAt: row.converted_at,
    convertedBy: row.converted_by
      ? { id: row.converted_by, fullName: row.converted_by_name }
      : null,
    createdBy: { id: row.created_by, fullName: row.created_by_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toQuotationPublic(row: QuotationRow, printers: PrinterRow[]) {
  return {
    id: row.id,
    leadId: row.lead_id,
    monthlyLeaseFee: parseFloat(row.monthly_lease_fee),
    perPageBw: parseFloat(row.per_page_bw),
    perPageColour: parseFloat(row.per_page_colour),
    discountPct: parseFloat(row.discount_pct),
    notes: row.notes,
    status: row.status,
    printers: printers.map((p) => ({
      id: p.id,
      printerModel: p.printer_model,
      quantity: p.quantity,
    })),
    approvedBy: row.approved_by ? { id: row.approved_by, fullName: row.approved_by_name } : null,
    approvedAt: row.approved_at,
    approvalNote: row.approval_note,
    createdBy: { id: row.created_by, fullName: row.created_by_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findLead(id: number): Promise<LeadRow | null> {
  const rows = await query<LeadRow[]>(
    `SELECT l.*,
            a.full_name  AS assigned_to_name,
            cb.full_name AS created_by_name,
            cv.full_name AS converted_by_name
       FROM leads l
       LEFT JOIN users a  ON a.id = l.assigned_to
       LEFT JOIN users cb ON cb.id = l.created_by
       LEFT JOIN users cv ON cv.id = l.converted_by
      WHERE l.id = ?
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function findQuotation(id: number, leadId: number): Promise<QuotationRow | null> {
  const rows = await query<QuotationRow[]>(
    `SELECT q.*,
            cb.full_name AS created_by_name,
            ab.full_name AS approved_by_name
       FROM lead_quotations q
       LEFT JOIN users cb ON cb.id = q.created_by
       LEFT JOIN users ab ON ab.id = q.approved_by
      WHERE q.id = ? AND q.lead_id = ?
      LIMIT 1`,
    [id, leadId],
  );
  return rows[0] ?? null;
}

async function loadPrinters(quotationId: number): Promise<PrinterRow[]> {
  return query<PrinterRow[]>(
    `SELECT id, quotation_id, printer_model, quantity FROM lead_quotation_printers
      WHERE quotation_id = ? ORDER BY id ASC`,
    [quotationId],
  );
}

// ---------------------------------------------------------------------------
// GET /api/leads
// ---------------------------------------------------------------------------
export const listLeads = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const stage = request.query.get('stage');
  if (stage) {
    where.push('l.stage = ?');
    params.push(stage);
  }
  const source = request.query.get('source');
  if (source) {
    where.push('l.source = ?');
    params.push(source);
  }
  const assignedTo = request.query.get('assignedTo');
  if (assignedTo) {
    where.push('l.assigned_to = ?');
    params.push(Number(assignedTo));
  }
  const q = request.query.get('q');
  if (q) {
    where.push('(l.company_name LIKE ? OR l.contact_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const rows = await query<LeadRow[]>(
    `SELECT l.*,
            a.full_name  AS assigned_to_name,
            cb.full_name AS created_by_name,
            cv.full_name AS converted_by_name
       FROM leads l
       LEFT JOIN users a  ON a.id = l.assigned_to
       LEFT JOIN users cb ON cb.id = l.created_by
       LEFT JOIN users cv ON cv.id = l.converted_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.updated_at DESC`,
    params,
  );

  return json(200, { leads: rows.map(toLeadPublic) });
});

// ---------------------------------------------------------------------------
// GET /api/leads/{id}
// ---------------------------------------------------------------------------
export const getLead = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsRead);

  const id = leadIdParam(request);
  const lead = await findLead(id);
  if (!lead) return error(404, 'Lead not found');

  const quotationRows = await query<QuotationRow[]>(
    `SELECT q.*,
            cb.full_name AS created_by_name,
            ab.full_name AS approved_by_name
       FROM lead_quotations q
       LEFT JOIN users cb ON cb.id = q.created_by
       LEFT JOIN users ab ON ab.id = q.approved_by
      WHERE q.lead_id = ?
      ORDER BY q.created_at DESC`,
    [id],
  );

  const printerMap = new Map<number, PrinterRow[]>();
  if (quotationRows.length) {
    const qids = quotationRows.map((q) => q.id);
    const printers = await query<PrinterRow[]>(
      `SELECT id, quotation_id, printer_model, quantity
         FROM lead_quotation_printers
        WHERE quotation_id IN (${qids.map(() => '?').join(',')})
        ORDER BY id ASC`,
      qids,
    );
    for (const p of printers) {
      if (!printerMap.has(p.quotation_id)) printerMap.set(p.quotation_id, []);
      printerMap.get(p.quotation_id)!.push(p);
    }
  }

  const history = await query<StageHistoryRow[]>(
    `SELECT h.*, u.full_name AS changed_by_name
       FROM lead_stage_history h
       JOIN users u ON u.id = h.changed_by
      WHERE h.lead_id = ?
      ORDER BY h.changed_at ASC`,
    [id],
  );

  return json(200, {
    lead: toLeadPublic(lead),
    quotations: quotationRows.map((q) =>
      toQuotationPublic(q, printerMap.get(q.id) ?? []),
    ),
    stageHistory: history.map((h) => ({
      id: h.id,
      fromStage: h.from_stage,
      toStage: h.to_stage,
      note: h.note,
      changedBy: { id: h.changed_by, fullName: h.changed_by_name },
      changedAt: h.changed_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/leads
// ---------------------------------------------------------------------------
export const createLead = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsCreate);

  const body = await readJson<{
    companyName?: string;
    contactName?: string;
    contactEmail?: string | null;
    contactPhone?: string | null;
    source?: string;
    expectedPrinters?: number;
    assignedTo?: number | null;
  }>(request);

  if (!body.companyName?.trim()) return error(400, 'Company name is required');
  if (!body.contactName?.trim()) return error(400, 'Contact name is required');

  const source = body.source ?? 'OTHER';
  if (!VALID_SOURCES.includes(source as (typeof VALID_SOURCES)[number])) {
    return error(400, `Source must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  const expectedPrinters = body.expectedPrinters ?? 1;
  if (!Number.isInteger(expectedPrinters) || expectedPrinters < 1) {
    return error(400, 'Expected printers must be a positive integer');
  }

  // Validate assignedTo if provided.
  if (body.assignedTo != null) {
    const rows = await query<RowDataPacket[]>(
      `SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1`,
      [body.assignedTo],
    );
    if (!rows.length) return error(400, 'Assigned user not found or inactive');
  }

  const result = await query<ResultSetHeader>(
    `INSERT INTO leads
       (company_name, contact_name, contact_email, contact_phone,
        source, expected_printers, stage, assigned_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?, ?)`,
    [
      body.companyName.trim(),
      body.contactName.trim(),
      body.contactEmail?.trim() || null,
      body.contactPhone?.trim() || null,
      source,
      expectedPrinters,
      body.assignedTo ?? null,
      ctx.userId,
    ],
  );

  // Record initial stage in history.
  await query(
    `INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, note, changed_by)
     VALUES (?, NULL, 'NEW', 'Lead created', ?)`,
    [result.insertId, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead',
    entityId: result.insertId,
    action: 'create',
    changes: {
      after: {
        companyName: body.companyName.trim(),
        contactName: body.contactName.trim(),
        source,
        stage: 'NEW',
      },
    },
    ipAddress: clientIp(request),
  });

  const created = await findLead(result.insertId);
  return json(201, { lead: created ? toLeadPublic(created) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/{id}
// ---------------------------------------------------------------------------
export const updateLead = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsUpdate);

  const id = leadIdParam(request);
  const existing = await findLead(id);
  if (!existing) return error(404, 'Lead not found');

  const body = await readJson<{
    companyName?: string;
    contactName?: string;
    contactEmail?: string | null;
    contactPhone?: string | null;
    source?: string;
    expectedPrinters?: number;
    assignedTo?: number | null;
  }>(request);

  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  if (body.companyName !== undefined) {
    if (!body.companyName.trim()) return error(400, 'Company name cannot be empty');
    sets.push('company_name = ?');
    params.push(body.companyName.trim());
    after.companyName = body.companyName.trim();
  }
  if (body.contactName !== undefined) {
    if (!body.contactName.trim()) return error(400, 'Contact name cannot be empty');
    sets.push('contact_name = ?');
    params.push(body.contactName.trim());
    after.contactName = body.contactName.trim();
  }
  if (body.contactEmail !== undefined) {
    sets.push('contact_email = ?');
    params.push(body.contactEmail?.trim() || null);
    after.contactEmail = body.contactEmail?.trim() || null;
  }
  if (body.contactPhone !== undefined) {
    sets.push('contact_phone = ?');
    params.push(body.contactPhone?.trim() || null);
    after.contactPhone = body.contactPhone?.trim() || null;
  }
  if (body.source !== undefined) {
    if (!VALID_SOURCES.includes(body.source as (typeof VALID_SOURCES)[number])) {
      return error(400, `Source must be one of: ${VALID_SOURCES.join(', ')}`);
    }
    sets.push('source = ?');
    params.push(body.source);
    after.source = body.source;
  }
  if (body.expectedPrinters !== undefined) {
    if (!Number.isInteger(body.expectedPrinters) || body.expectedPrinters < 1) {
      return error(400, 'Expected printers must be a positive integer');
    }
    sets.push('expected_printers = ?');
    params.push(body.expectedPrinters);
    after.expectedPrinters = body.expectedPrinters;
  }
  if (body.assignedTo !== undefined) {
    if (body.assignedTo != null) {
      const rows = await query<RowDataPacket[]>(
        `SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1`,
        [body.assignedTo],
      );
      if (!rows.length) return error(400, 'Assigned user not found or inactive');
    }
    sets.push('assigned_to = ?');
    params.push(body.assignedTo ?? null);
    after.assignedTo = body.assignedTo ?? null;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead',
    entityId: id,
    action: 'update',
    changes: { after },
    ipAddress: clientIp(request),
  });

  const updated = await findLead(id);
  return json(200, { lead: updated ? toLeadPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/{id}/stage
// ---------------------------------------------------------------------------
export const changeStage = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsChangeStage);

  const id = leadIdParam(request);
  const lead = await findLead(id);
  if (!lead) return error(404, 'Lead not found');

  const body = await readJson<{ stage?: string; note?: string; lostReason?: string }>(request);
  const newStage = body.stage as Stage | undefined;
  if (!newStage || !STAGE_ORDER.includes(newStage)) {
    return error(400, `stage must be one of: ${STAGE_ORDER.join(', ')}`);
  }

  const currentStage = lead.stage as Stage;
  const allowed = VALID_TRANSITIONS[currentStage];
  if (!allowed.includes(newStage)) {
    return error(
      422,
      `Cannot move from ${currentStage} to ${newStage}. Allowed transitions: ${allowed.join(', ') || 'none (terminal stage)'}`,
      'INVALID_TRANSITION',
    );
  }

  if (newStage === 'WON' || newStage === 'LOST') {
    if (newStage === 'LOST' && !body.lostReason?.trim()) {
      return error(400, 'A lost reason is required when closing a lead as Lost');
    }
  }

  const sets: string[] = ['stage = ?'];
  const params: unknown[] = [newStage];

  if (newStage === 'LOST') {
    sets.push('lost_reason = ?');
    params.push(body.lostReason?.trim() ?? null);
  }
  if (body.note !== undefined) {
    sets.push('stage_note = ?');
    params.push(body.note.trim() || null);
  }

  params.push(id);
  await query(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, params);

  await query(
    `INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, note, changed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, currentStage, newStage, body.note?.trim() || null, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead',
    entityId: id,
    action: 'stage_change',
    changes: { before: { stage: currentStage }, after: { stage: newStage } },
    ipAddress: clientIp(request),
  });

  const updated = await findLead(id);
  return json(200, { lead: updated ? toLeadPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// POST /api/leads/{id}/quotations
// ---------------------------------------------------------------------------
export const createQuotation = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.quotationsCreate);

  const leadId = leadIdParam(request);
  const lead = await findLead(leadId);
  if (!lead) return error(404, 'Lead not found');

  if (lead.stage === 'WON' || lead.stage === 'LOST') {
    return error(422, `Cannot add a quotation to a ${lead.stage} lead`, 'LEAD_TERMINAL');
  }

  const body = await readJson<{
    monthlyLeaseFee?: number;
    perPageBw?: number;
    perPageColour?: number;
    discountPct?: number;
    notes?: string | null;
    printers?: { printerModel: string; quantity?: number }[];
  }>(request);

  if (body.monthlyLeaseFee == null || body.monthlyLeaseFee < 0) {
    return error(400, 'monthlyLeaseFee is required and must be non-negative');
  }
  if (body.perPageBw == null || body.perPageBw < 0) {
    return error(400, 'perPageBw is required and must be non-negative');
  }
  if (body.perPageColour == null || body.perPageColour < 0) {
    return error(400, 'perPageColour is required and must be non-negative');
  }

  const discountPct = body.discountPct ?? 0;
  if (discountPct < 0 || discountPct > 100) {
    return error(400, 'discountPct must be between 0 and 100');
  }

  if (!body.printers?.length) {
    return error(400, 'At least one printer line is required');
  }
  for (const p of body.printers) {
    if (!p.printerModel?.trim()) return error(400, 'Each printer must have a printer model');
    const qty = p.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1) return error(400, 'Printer quantity must be a positive integer');
  }

  // discount_pct > 0 requires manager approval; otherwise auto-approve.
  const status = discountPct > 0 ? 'PENDING_APPROVAL' : 'APPROVED';
  const approvedAt = status === 'APPROVED' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  const approvedBy = status === 'APPROVED' ? ctx.userId : null;

  const result = await query<ResultSetHeader>(
    `INSERT INTO lead_quotations
       (lead_id, monthly_lease_fee, per_page_bw, per_page_colour,
        discount_pct, notes, status, approved_by, approved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      leadId,
      body.monthlyLeaseFee,
      body.perPageBw,
      body.perPageColour,
      discountPct,
      body.notes?.trim() || null,
      status,
      approvedBy,
      approvedAt,
      ctx.userId,
    ],
  );

  const quotationId = result.insertId;

  // Insert printer lines.
  for (const p of body.printers) {
    await query(
      `INSERT INTO lead_quotation_printers (quotation_id, printer_model, quantity) VALUES (?, ?, ?)`,
      [quotationId, p.printerModel.trim(), p.quantity ?? 1],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead_quotation',
    entityId: quotationId,
    action: 'create',
    changes: {
      after: {
        leadId,
        monthlyLeaseFee: body.monthlyLeaseFee,
        discountPct,
        status,
      },
    },
    ipAddress: clientIp(request),
  });

  const created = await findQuotation(quotationId, leadId);
  const printers = await loadPrinters(quotationId);
  return json(201, { quotation: created ? toQuotationPublic(created, printers) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/{id}/quotations/{qid}/approve
// ---------------------------------------------------------------------------
export const approveQuotation = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.quotationsApprove);

  const leadId = leadIdParam(request);
  const qid = quotationIdParam(request);

  const lead = await findLead(leadId);
  if (!lead) return error(404, 'Lead not found');

  const quotation = await findQuotation(qid, leadId);
  if (!quotation) return error(404, 'Quotation not found');

  if (quotation.status !== 'PENDING_APPROVAL') {
    return error(
      422,
      `Quotation is in ${quotation.status} status; only PENDING_APPROVAL quotations can be actioned`,
      'INVALID_STATUS',
    );
  }

  const body = await readJson<{ action?: 'approve' | 'reject'; note?: string }>(request);
  if (body.action !== 'approve' && body.action !== 'reject') {
    return error(400, 'action must be "approve" or "reject"');
  }

  const newStatus = body.action === 'approve' ? 'APPROVED' : 'REJECTED';
  await query(
    `UPDATE lead_quotations
        SET status = ?, approved_by = ?, approved_at = NOW(), approval_note = ?
      WHERE id = ?`,
    [newStatus, ctx.userId, body.note?.trim() || null, qid],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead_quotation',
    entityId: qid,
    action: body.action === 'approve' ? 'approve' : 'reject',
    reason: body.note?.trim() || undefined,
    changes: {
      before: { status: 'PENDING_APPROVAL' },
      after: { status: newStatus },
    },
    ipAddress: clientIp(request),
  });

  const updated = await findQuotation(qid, leadId);
  const printers = await loadPrinters(qid);
  return json(200, { quotation: updated ? toQuotationPublic(updated, printers) : null });
});

// ---------------------------------------------------------------------------
// POST /api/leads/{id}/convert
// ---------------------------------------------------------------------------
export const convertLead = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.leadsConvert);

  const id = leadIdParam(request);
  const lead = await findLead(id);
  if (!lead) return error(404, 'Lead not found');

  if (lead.stage !== 'WON') {
    return error(422, 'Only WON leads can be converted to customers', 'LEAD_NOT_WON');
  }

  if (lead.converted_customer_id != null) {
    return error(409, 'Lead has already been converted to a customer', 'ALREADY_CONVERTED');
  }

  // BR-024: must have at least one APPROVED quotation.
  const approved = await query<RowDataPacket[]>(
    `SELECT id FROM lead_quotations WHERE lead_id = ? AND status = 'APPROVED' LIMIT 1`,
    [id],
  );
  if (!approved.length) {
    return error(
      422,
      'This lead cannot be converted: it has no approved quotation (BR-024). ' +
        'Create a quotation and have a Sales Manager approve it first.',
      'NO_APPROVED_QUOTATION',
    );
  }

  // Create the customer record (Module 3 will extend this table).
  const custResult = await query<ResultSetHeader>(
    `INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)`,
    [lead.company_name, lead.contact_email, lead.contact_phone],
  );

  const customerId = custResult.insertId;

  await query(
    `UPDATE leads
        SET converted_customer_id = ?, converted_at = NOW(), converted_by = ?
      WHERE id = ?`,
    [customerId, ctx.userId, id],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'lead',
    entityId: id,
    action: 'convert',
    reason: 'Lead converted to customer',
    changes: {
      after: { convertedCustomerId: customerId },
    },
    ipAddress: clientIp(request),
  });

  const updated = await findLead(id);
  return json(200, { lead: updated ? toLeadPublic(updated) : null, customerId });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('leads-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'leads',
  handler: listLeads,
});
app.http('leads-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'leads',
  handler: createLead,
});
app.http('leads-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'leads/{id}',
  handler: getLead,
});
app.http('leads-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'leads/{id}',
  handler: updateLead,
});
app.http('leads-stage', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'leads/{id}/stage',
  handler: changeStage,
});
app.http('leads-quotations-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'leads/{id}/quotations',
  handler: createQuotation,
});
app.http('leads-quotations-approve', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'leads/{id}/quotations/{qid}/approve',
  handler: approveQuotation,
});
app.http('leads-convert', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'leads/{id}/convert',
  handler: convertLead,
});

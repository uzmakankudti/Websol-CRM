/**
 * Billing & Invoice Management (Module 14).
 *
 * POST /api/billing/invoices/generate        generate a DRAFT invoice  billing.create
 * GET  /api/billing/invoices                 list invoices              billing.read
 * GET  /api/billing/invoices/{id}            invoice detail + lines     billing.read
 * POST /api/billing/invoices/{id}/issue      DRAFT → ISSUED             billing.issue
 * POST /api/billing/invoices/{id}/pay        ISSUED/OVERDUE → PAID      billing.pay
 * POST /api/billing/invoices/{id}/void       any non-PAID → VOID        billing.pay
 * POST /api/billing/credit-notes             create a credit note       billing.credit
 * GET  /api/billing/credit-notes             list credit notes          billing.read
 * GET  /api/billing/credit-notes/{id}        credit note detail         billing.read
 * POST /api/billing/credit-notes/{id}/issue  DRAFT → ISSUED             billing.credit
 *
 * Business rules:
 *   BR-011  No edit once posted (status >= ISSUED). Enforced on every mutating call.
 *   BR-012  Invoice can only be generated when ALL meter readings for the contract's
 *           printers in the billing period are approval_status IN ('APPROVED','NONE').
 *   BR-022  Credit note must reference an invoice; amount must not exceed invoice total
 *           minus already-credited amount.
 *   BR-025  Pages above monthly allowance charged at base rate × 1.1.
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp } from '../shared/http';
import { HttpError } from '../shared/http';
import {
  calcPrinterClicks,
  calcInvoiceTotals,
  computePeriodDays,
  daysInMonth,
} from '../shared/billing-calc';

// ---------------------------------------------------------------------------
// Extend PERMISSIONS with billing codes
// ---------------------------------------------------------------------------
declare module '../shared/rbac' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PERMISSIONS {}
}
const BILLING_PERMS = {
  billingRead:   'billing.read',
  billingCreate: 'billing.create',
  billingIssue:  'billing.issue',
  billingPay:    'billing.pay',
  billingCredit: 'billing.credit',
} as const;

// ---------------------------------------------------------------------------
// Invoice number sequence (INV-YYYY-NNNN)
// ---------------------------------------------------------------------------
async function nextInvoiceNo(): Promise<string> {
  const yr = new Date().getFullYear();
  const rows = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?`,
    [`INV-${yr}-%`],
  );
  const seq = Number(rows[0].n) + 1;
  return `INV-${yr}-${String(seq).padStart(4, '0')}`;
}

async function nextCreditNo(): Promise<string> {
  const yr = new Date().getFullYear();
  const rows = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM credit_notes WHERE credit_no LIKE ?`,
    [`CRN-${yr}-%`],
  );
  const seq = Number(rows[0].n) + 1;
  return `CRN-${yr}-${String(seq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// BR-011 guard: throw if the invoice is already posted
// ---------------------------------------------------------------------------
function assertDraft(status: string, label = 'invoice'): void {
  if (status !== 'DRAFT') {
    throw new HttpError(
      409,
      `This ${label} cannot be edited once it has been posted (BR-011). Current status: ${status}`,
      'ALREADY_POSTED',
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/billing/invoices/generate
// ---------------------------------------------------------------------------
export const generateInvoice = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingCreate);
  const ip = clientIp(request);

  const body = await readJson<{
    contractId?: number;
    periodStart?: string; // YYYY-MM-DD
    periodEnd?: string;
    taxRate?: number;
    notes?: string;
  }>(request);

  if (!body.contractId) throw new HttpError(400, 'contractId is required');
  if (!body.periodStart || !body.periodEnd) throw new HttpError(400, 'periodStart and periodEnd are required');

  const pStart = new Date(body.periodStart);
  const pEnd   = new Date(body.periodEnd);
  if (isNaN(pStart.getTime()) || isNaN(pEnd.getTime())) throw new HttpError(400, 'Invalid period dates');
  if (pEnd < pStart) throw new HttpError(400, 'periodEnd must be >= periodStart');

  const taxRate = body.taxRate != null ? Number(body.taxRate) : 0;
  if (taxRate < 0 || taxRate > 100) throw new HttpError(400, 'taxRate must be 0–100');

  // Load contract
  const contracts = await query<RowDataPacket[]>(
    `SELECT c.id, c.contract_no, c.customer_id, c.start_date, c.end_date,
            c.monthly_lease_fee, c.per_click_bw, c.per_click_colour, c.status
       FROM contracts c WHERE c.id = ? LIMIT 1`,
    [body.contractId],
  );
  const contract = contracts[0];
  if (!contract) throw new HttpError(404, 'Contract not found');
  if (contract.status === 'DRAFT') throw new HttpError(422, 'Cannot bill a DRAFT contract');

  const cStart = new Date(contract.start_date);
  const cEnd   = new Date(contract.end_date);

  // Printers on this contract
  const printers = await query<RowDataPacket[]>(
    `SELECT p.id, p.serial_no, p.model, p.is_colour,
            p.monthly_allowance_bw, p.monthly_allowance_colour
       FROM printers p
      WHERE p.current_contract_id = ?`,
    [body.contractId],
  );
  if (printers.length === 0) throw new HttpError(422, 'No printers linked to this contract');

  // BR-012: ALL meter readings for these printers in the period must be APPROVED or NONE
  const printerIds = printers.map((p) => p.id as number);
  const unapproved = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM meter_readings
      WHERE printer_id IN (${printerIds.map(() => '?').join(',')})
        AND recorded_at BETWEEN ? AND ?
        AND approval_status = 'PENDING'`,
    [...printerIds, body.periodStart + ' 00:00:00', body.periodEnd + ' 23:59:59'],
  );
  if (Number(unapproved[0]?.n ?? 0) > 0) {
    throw new HttpError(
      422,
      `Cannot generate invoice: ${unapproved[0].n} meter reading(s) are still PENDING approval (BR-012).`,
      'READINGS_PENDING',
    );
  }

  // Period days
  const calMonth = pStart.getUTCMonth() + 1;
  const calYear  = pStart.getUTCFullYear();
  const fullMonthDays = daysInMonth(calYear, calMonth);
  const { periodDays, actualDays } = computePeriodDays(pStart, pEnd, cStart, cEnd);

  if (actualDays === 0) throw new HttpError(422, 'Contract was not active during this period');

  // Build invoice lines for each printer
  const invoiceNo = await nextInvoiceNo();

  // Check for duplicate invoice for same contract + period
  const existing = await query<RowDataPacket[]>(
    `SELECT id FROM invoices WHERE contract_id = ? AND period_start = ? AND period_end = ? LIMIT 1`,
    [body.contractId, body.periodStart, body.periodEnd],
  );
  if (existing[0]) throw new HttpError(409, 'An invoice already exists for this contract and period', 'DUPLICATE_PERIOD');

  const lines: Array<{
    printerId: number; serialNo: string; model: string;
    openingBw: number; closingBw: number; deltaBw: number;
    openingColour: number | null; closingColour: number | null; deltaColour: number | null;
    allowanceBw: number; allowanceColour: number | null;
    meterReadingIds: string;
    calc: ReturnType<typeof calcPrinterClicks>;
  }> = [];

  for (const printer of printers) {
    // Get the first and last APPROVED (or NONE) readings in the period for this printer
    const readings = await query<RowDataPacket[]>(
      `SELECT id, reading_bw, reading_colour
         FROM meter_readings
        WHERE printer_id = ?
          AND approval_status IN ('APPROVED','NONE')
          AND recorded_at BETWEEN ? AND ?
        ORDER BY recorded_at ASC`,
      [printer.id, body.periodStart + ' 00:00:00', body.periodEnd + ' 23:59:59'],
    );

    // Opening reading: last approved reading BEFORE the period
    const prevReadings = await query<RowDataPacket[]>(
      `SELECT reading_bw, reading_colour
         FROM meter_readings
        WHERE printer_id = ?
          AND approval_status IN ('APPROVED','NONE')
          AND recorded_at < ?
        ORDER BY recorded_at DESC LIMIT 1`,
      [printer.id, body.periodStart + ' 00:00:00'],
    );

    const opening = prevReadings[0] ?? readings[0];
    const closing = readings[readings.length - 1];

    let deltaBw = 0, openBw = 0, closeBw = 0;
    let deltaColour: number | null = null, openColour: number | null = null, closeColour: number | null = null;

    if (opening && closing) {
      openBw    = Number(opening.reading_bw);
      closeBw   = Number(closing.reading_bw);
      deltaBw   = Math.max(closeBw - openBw, 0);
      if (printer.is_colour && closing.reading_colour != null) {
        openColour  = opening.reading_colour != null ? Number(opening.reading_colour) : 0;
        closeColour = Number(closing.reading_colour);
        deltaColour = Math.max(closeColour - (openColour ?? 0), 0);
      }
    } else if (readings[0]) {
      // Only one reading: use delta_bw stored on the reading record itself
      closeBw = Number(readings[0].reading_bw);
      // Try getting delta from the reading row
      const deltaRow = await query<RowDataPacket[]>(
        `SELECT delta_bw, delta_colour FROM meter_readings WHERE id = ? LIMIT 1`,
        [readings[0].id],
      );
      deltaBw = deltaRow[0]?.delta_bw != null ? Number(deltaRow[0].delta_bw) : 0;
      if (printer.is_colour && deltaRow[0]?.delta_colour != null) {
        deltaColour = Number(deltaRow[0].delta_colour);
      }
    }

    const calc = calcPrinterClicks({
      deltaBw,
      deltaColour,
      allowanceBw:     printer.monthly_allowance_bw   ? Number(printer.monthly_allowance_bw)   : 0,
      allowanceColour: printer.monthly_allowance_colour ? Number(printer.monthly_allowance_colour) : null,
      rateBw:    String(contract.per_click_bw),
      rateColour:String(contract.per_click_colour),
    });

    lines.push({
      printerId:   Number(printer.id),
      serialNo:    String(printer.serial_no),
      model:       String(printer.model),
      openingBw:   openBw,
      closingBw:   closeBw,
      deltaBw,
      openingColour: openColour,
      closingColour: closeColour,
      deltaColour,
      allowanceBw:     printer.monthly_allowance_bw   ? Number(printer.monthly_allowance_bw)   : 0,
      allowanceColour: printer.monthly_allowance_colour ? Number(printer.monthly_allowance_colour) : null,
      meterReadingIds: readings.map((r) => r.id).join(','),
      calc,
    });
  }

  // Invoice totals
  const totals = calcInvoiceTotals({
    leaseFeeMonthly: String(contract.monthly_lease_fee),
    periodDays: fullMonthDays,
    actualDays,
    printerLines: lines.map((l) => l.calc),
    taxRate,
  });

  // Due date: 30 days from period end
  const dueDate = new Date(pEnd);
  dueDate.setDate(dueDate.getDate() + 30);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  // Insert invoice
  const result = await query<ResultSetHeader>(
    `INSERT INTO invoices
       (invoice_no, contract_id, customer_id,
        period_start, period_end, period_days, actual_days,
        lease_fee_full, lease_fee_prorated,
        clicks_bw_amount, clicks_colour_amount,
        overage_bw_amount, overage_colour_amount,
        subtotal, tax_rate, tax_amount, total,
        status, due_date, notes, generated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      invoiceNo, body.contractId, contract.customer_id,
      body.periodStart, body.periodEnd, fullMonthDays, actualDays,
      totals.leaseFeeFull, totals.leaseFeeProrated,
      totals.clicksBwAmount, totals.clicksColourAmount,
      totals.overageBwAmount, totals.overageColourAmount,
      totals.subtotal, totals.taxRate, totals.taxAmount, totals.total,
      'DRAFT', dueDateStr, body.notes ?? null, ctx.userId,
    ],
  );
  const invoiceId = result.insertId;

  // Insert lines
  for (const l of lines) {
    await query(
      `INSERT INTO invoice_lines
         (invoice_id, printer_id, serial_no, model,
          opening_bw, closing_bw, delta_bw,
          opening_colour, closing_colour, delta_colour,
          allowance_bw, allowance_colour,
          base_pages_bw, overage_pages_bw,
          base_pages_colour, overage_pages_colour,
          rate_bw, rate_colour, overage_rate_bw, overage_rate_colour,
          amount_bw, amount_colour, amount_overage_bw, amount_overage_colour,
          line_total, meter_reading_ids)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        invoiceId, l.printerId, l.serialNo, l.model,
        l.openingBw, l.closingBw, l.deltaBw,
        l.openingColour, l.closingColour, l.deltaColour,
        l.allowanceBw, l.allowanceColour,
        l.calc.basePagesBy, l.calc.overagePagesBy,
        l.calc.basePagesColour, l.calc.overagePagesColour,
        l.calc.rateBw, l.calc.rateColour,
        l.calc.overageRateBw, l.calc.overageRateColour,
        l.calc.amountBw, l.calc.amountColour,
        l.calc.amountOverageBw, l.calc.amountOverageColour,
        l.calc.lineTotal, l.meterReadingIds,
      ],
    );
  }

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'invoice', entityId: invoiceId,
    action: 'generate',
    changes: { invoiceNo, contractId: body.contractId, periodStart: body.periodStart, periodEnd: body.periodEnd, total: totals.total },
    ipAddress: ip,
  });

  return json(201, { invoice: { id: invoiceId, invoiceNo, status: 'DRAFT', ...totals } });
});

// ---------------------------------------------------------------------------
// GET /api/billing/invoices
// ---------------------------------------------------------------------------
export const listInvoices = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingRead);

  const status    = request.query.get('status')?.toUpperCase() ?? '';
  const customerId = request.query.get('customerId');
  const contractId = request.query.get('contractId');

  const where: string[] = [];
  const params: unknown[] = [];

  if (status) { where.push('i.status = ?'); params.push(status); }
  if (customerId) { where.push('i.customer_id = ?'); params.push(Number(customerId)); }
  if (contractId) { where.push('i.contract_id = ?'); params.push(Number(contractId)); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query<RowDataPacket[]>(
    `SELECT i.id, i.invoice_no, i.contract_id, ct.contract_no,
            i.customer_id, cu.name AS customer_name,
            i.period_start, i.period_end, i.total, i.amount_paid,
            i.amount_credited, i.status, i.due_date, i.issued_at, i.paid_at
       FROM invoices i
       JOIN contracts ct ON ct.id = i.contract_id
       JOIN customers cu ON cu.id = i.customer_id
       ${whereClause}
       ORDER BY i.created_at DESC LIMIT 200`,
    params,
  );

  return json(200, {
    invoices: rows.map((r) => ({
      id: r.id, invoiceNo: r.invoice_no,
      contractId: r.contract_id, contractNo: r.contract_no,
      customerId: r.customer_id, customerName: r.customer_name,
      periodStart: r.period_start, periodEnd: r.period_end,
      total: r.total, amountPaid: r.amount_paid, amountCredited: r.amount_credited,
      balance: (parseFloat(r.total) - parseFloat(r.amount_paid) - parseFloat(r.amount_credited)).toFixed(2),
      status: r.status, dueDate: r.due_date,
      issuedAt: r.issued_at, paidAt: r.paid_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/billing/invoices/{id}
// ---------------------------------------------------------------------------
export const getInvoice = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingRead);
  const id = Number(request.params.id);

  const rows = await query<RowDataPacket[]>(
    `SELECT i.*, ct.contract_no, cu.name AS customer_name, cu.billing_email
       FROM invoices i
       JOIN contracts ct ON ct.id = i.contract_id
       JOIN customers cu ON cu.id = i.customer_id
      WHERE i.id = ? LIMIT 1`,
    [id],
  );
  const inv = rows[0];
  if (!inv) return error(404, 'Invoice not found');

  const lines = await query<RowDataPacket[]>(
    `SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id`,
    [id],
  );

  const credits = await query<RowDataPacket[]>(
    `SELECT id, credit_no, amount, reason, status, issued_at FROM credit_notes WHERE invoice_id = ?`,
    [id],
  );

  return json(200, {
    invoice: {
      id: inv.id, invoiceNo: inv.invoice_no,
      contractId: inv.contract_id, contractNo: inv.contract_no,
      customerId: inv.customer_id, customerName: inv.customer_name,
      billingEmail: inv.billing_email,
      periodStart: inv.period_start, periodEnd: inv.period_end,
      periodDays: inv.period_days, actualDays: inv.actual_days,
      leaseFeeFull: inv.lease_fee_full, leaseFeeProrated: inv.lease_fee_prorated,
      clicksBwAmount: inv.clicks_bw_amount, clicksColourAmount: inv.clicks_colour_amount,
      overageBwAmount: inv.overage_bw_amount, overageColourAmount: inv.overage_colour_amount,
      subtotal: inv.subtotal, taxRate: inv.tax_rate, taxAmount: inv.tax_amount,
      total: inv.total, amountPaid: inv.amount_paid, amountCredited: inv.amount_credited,
      balance: (parseFloat(inv.total) - parseFloat(inv.amount_paid) - parseFloat(inv.amount_credited)).toFixed(2),
      status: inv.status, dueDate: inv.due_date,
      issuedAt: inv.issued_at, paidAt: inv.paid_at,
      voidedAt: inv.voided_at, voidReason: inv.void_reason,
      oracleRef: inv.oracle_ref, notes: inv.notes,
      createdAt: inv.created_at,
    },
    lines: lines.map((l) => ({
      id: l.id, printerId: l.printer_id, serialNo: l.serial_no, model: l.model,
      openingBw: l.opening_bw, closingBw: l.closing_bw, deltaBw: l.delta_bw,
      openingColour: l.opening_colour, closingColour: l.closing_colour, deltaColour: l.delta_colour,
      allowanceBw: l.allowance_bw, allowanceColour: l.allowance_colour,
      basePagesBy: l.base_pages_bw, overagePagesBy: l.overage_pages_bw,
      basePagesColour: l.base_pages_colour, overagePagesColour: l.overage_pages_colour,
      rateBw: l.rate_bw, rateColour: l.rate_colour,
      overageRateBw: l.overage_rate_bw, overageRateColour: l.overage_rate_colour,
      amountBw: l.amount_bw, amountColour: l.amount_colour,
      amountOverageBw: l.amount_overage_bw, amountOverageColour: l.amount_overage_colour,
      lineTotal: l.line_total, meterReadingIds: l.meter_reading_ids,
    })),
    creditNotes: credits.map((c) => ({
      id: c.id, creditNo: c.credit_no, amount: c.amount,
      reason: c.reason, status: c.status, issuedAt: c.issued_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/invoices/{id}/issue
// ---------------------------------------------------------------------------
export const issueInvoice = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingIssue);
  const ip = clientIp(request);
  const id = Number(request.params.id);
  const body = await readJson<{ oracleRef?: string }>(request);

  const rows = await query<RowDataPacket[]>(`SELECT id, status FROM invoices WHERE id = ? LIMIT 1`, [id]);
  const inv = rows[0];
  if (!inv) return error(404, 'Invoice not found');
  assertDraft(inv.status);

  await query(
    `UPDATE invoices SET status='ISSUED', issued_at=NOW(), issued_by=?, oracle_ref=? WHERE id=?`,
    [ctx.userId, body.oracleRef ?? null, id],
  );
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'invoice', entityId: id, action: 'issue',
    changes: { oracleRef: body.oracleRef ?? null }, ipAddress: ip,
  });
  return json(200, { ok: true, status: 'ISSUED' });
});

// ---------------------------------------------------------------------------
// POST /api/billing/invoices/{id}/pay
// ---------------------------------------------------------------------------
export const payInvoice = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingPay);
  const ip = clientIp(request);
  const id = Number(request.params.id);
  const body = await readJson<{ amountPaid?: number; notes?: string }>(request);

  const rows = await query<RowDataPacket[]>(
    `SELECT id, status, total, amount_paid, amount_credited FROM invoices WHERE id = ? LIMIT 1`,
    [id],
  );
  const inv = rows[0];
  if (!inv) return error(404, 'Invoice not found');
  if (!['ISSUED', 'OVERDUE'].includes(inv.status)) {
    return error(409, `Invoice must be ISSUED or OVERDUE to mark as paid (current: ${inv.status})`);
  }

  const paid = body.amountPaid != null ? Number(body.amountPaid) : parseFloat(inv.total) - parseFloat(inv.amount_paid) - parseFloat(inv.amount_credited);

  await query(
    `UPDATE invoices SET status='PAID', paid_at=NOW(), paid_by=?, amount_paid=amount_paid+?, notes=COALESCE(?,notes) WHERE id=?`,
    [ctx.userId, paid.toFixed(2), body.notes ?? null, id],
  );
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'invoice', entityId: id, action: 'pay',
    changes: { amountPaid: paid.toFixed(2) }, ipAddress: ip,
  });
  return json(200, { ok: true, status: 'PAID' });
});

// ---------------------------------------------------------------------------
// POST /api/billing/invoices/{id}/void
// ---------------------------------------------------------------------------
export const voidInvoice = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingPay);
  const ip = clientIp(request);
  const id = Number(request.params.id);
  const body = await readJson<{ reason?: string }>(request);

  const rows = await query<RowDataPacket[]>(`SELECT id, status FROM invoices WHERE id = ? LIMIT 1`, [id]);
  const inv = rows[0];
  if (!inv) return error(404, 'Invoice not found');
  if (inv.status === 'PAID') return error(409, 'A paid invoice cannot be voided');

  await query(
    `UPDATE invoices SET status='VOID', voided_at=NOW(), void_reason=? WHERE id=?`,
    [body.reason ?? null, id],
  );
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'invoice', entityId: id, action: 'void',
    changes: { reason: body.reason ?? null }, ipAddress: ip,
  });
  return json(200, { ok: true, status: 'VOID' });
});

// ---------------------------------------------------------------------------
// POST /api/billing/credit-notes  (BR-022)
// ---------------------------------------------------------------------------
export const createCreditNote = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingCredit);
  const ip = clientIp(request);

  const body = await readJson<{
    invoiceId?: number;
    amount?: number;
    reason?: string;
  }>(request);

  if (!body.invoiceId)  throw new HttpError(400, 'invoiceId is required');
  if (!body.amount)     throw new HttpError(400, 'amount is required');
  if (!body.reason)     throw new HttpError(400, 'reason is required');

  const amount = parseFloat(String(body.amount));
  if (amount <= 0) throw new HttpError(400, 'amount must be positive');

  // BR-022: reference invoice must exist
  const invRows = await query<RowDataPacket[]>(
    `SELECT id, customer_id, total, amount_credited, status FROM invoices WHERE id = ? LIMIT 1`,
    [body.invoiceId],
  );
  const inv = invRows[0];
  if (!inv) throw new HttpError(404, 'Referenced invoice not found');
  if (inv.status === 'DRAFT') throw new HttpError(422, 'Cannot credit a DRAFT invoice');
  if (inv.status === 'VOID')  throw new HttpError(422, 'Cannot credit a VOID invoice');

  // BR-022: credit must not exceed invoice total minus already-credited
  const remaining = parseFloat(inv.total) - parseFloat(inv.amount_credited);
  if (amount > remaining + 0.005) { // 0.005 tolerance for rounding
    throw new HttpError(
      422,
      `Credit amount ${amount.toFixed(2)} exceeds remaining creditable balance ${remaining.toFixed(2)} (BR-022)`,
      'CREDIT_EXCEEDS_INVOICE',
    );
  }

  const creditNo = await nextCreditNo();

  const result = await query<ResultSetHeader>(
    `INSERT INTO credit_notes (credit_no, invoice_id, customer_id, amount, reason, created_by)
     VALUES (?,?,?,?,?,?)`,
    [creditNo, body.invoiceId, inv.customer_id, amount.toFixed(2), body.reason, ctx.userId],
  );
  const creditId = result.insertId;

  await query(
    `UPDATE invoices SET amount_credited = amount_credited + ? WHERE id = ?`,
    [amount.toFixed(2), body.invoiceId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'credit_note', entityId: creditId, action: 'create',
    changes: { creditNo, invoiceId: body.invoiceId, amount: amount.toFixed(2) }, ipAddress: ip,
  });

  return json(201, { creditNote: { id: creditId, creditNo, amount: amount.toFixed(2), status: 'DRAFT' } });
});

// ---------------------------------------------------------------------------
// GET /api/billing/credit-notes
// ---------------------------------------------------------------------------
export const listCreditNotes = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingRead);

  const invoiceId  = request.query.get('invoiceId');
  const customerId = request.query.get('customerId');
  const where: string[] = [];
  const params: unknown[] = [];
  if (invoiceId)  { where.push('cn.invoice_id = ?');  params.push(Number(invoiceId)); }
  if (customerId) { where.push('cn.customer_id = ?'); params.push(Number(customerId)); }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query<RowDataPacket[]>(
    `SELECT cn.id, cn.credit_no, cn.invoice_id, i.invoice_no,
            cn.customer_id, cu.name AS customer_name,
            cn.amount, cn.reason, cn.status, cn.issued_at, cn.created_at
       FROM credit_notes cn
       JOIN invoices i ON i.id = cn.invoice_id
       JOIN customers cu ON cu.id = cn.customer_id
       ${wc}
       ORDER BY cn.created_at DESC LIMIT 200`,
    params,
  );

  return json(200, {
    creditNotes: rows.map((r) => ({
      id: r.id, creditNo: r.credit_no,
      invoiceId: r.invoice_id, invoiceNo: r.invoice_no,
      customerId: r.customer_id, customerName: r.customer_name,
      amount: r.amount, reason: r.reason, status: r.status,
      issuedAt: r.issued_at, createdAt: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/billing/credit-notes/{id}
// ---------------------------------------------------------------------------
export const getCreditNote = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingRead);
  const id = Number(request.params.id);

  const rows = await query<RowDataPacket[]>(
    `SELECT cn.*, i.invoice_no, cu.name AS customer_name
       FROM credit_notes cn
       JOIN invoices i ON i.id = cn.invoice_id
       JOIN customers cu ON cu.id = cn.customer_id
      WHERE cn.id = ? LIMIT 1`,
    [id],
  );
  const cn = rows[0];
  if (!cn) return error(404, 'Credit note not found');

  return json(200, {
    creditNote: {
      id: cn.id, creditNo: cn.credit_no,
      invoiceId: cn.invoice_id, invoiceNo: cn.invoice_no,
      customerId: cn.customer_id, customerName: cn.customer_name,
      amount: cn.amount, reason: cn.reason, status: cn.status,
      issuedAt: cn.issued_at, voidedAt: cn.voided_at,
      createdAt: cn.created_at,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/credit-notes/{id}/issue
// ---------------------------------------------------------------------------
export const issueCreditNote = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, BILLING_PERMS.billingCredit);
  const ip = clientIp(request);
  const id = Number(request.params.id);

  const rows = await query<RowDataPacket[]>(`SELECT id, status FROM credit_notes WHERE id = ? LIMIT 1`, [id]);
  const cn = rows[0];
  if (!cn) return error(404, 'Credit note not found');
  if (cn.status !== 'DRAFT') return error(409, `Credit note cannot be issued from status: ${cn.status}`);

  await query(`UPDATE credit_notes SET status='ISSUED', issued_at=NOW() WHERE id=?`, [id]);
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'credit_note', entityId: id, action: 'issue', ipAddress: ip,
  });
  return json(200, { ok: true, status: 'ISSUED' });
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------
app.http('billing-invoices-generate', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/invoices/generate', handler: generateInvoice,
});
app.http('billing-invoices-list', {
  methods: ['GET'], authLevel: 'anonymous',
  route: 'billing/invoices', handler: listInvoices,
});
app.http('billing-invoices-get', {
  methods: ['GET'], authLevel: 'anonymous',
  route: 'billing/invoices/{id}', handler: getInvoice,
});
app.http('billing-invoices-issue', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/invoices/{id}/issue', handler: issueInvoice,
});
app.http('billing-invoices-pay', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/invoices/{id}/pay', handler: payInvoice,
});
app.http('billing-invoices-void', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/invoices/{id}/void', handler: voidInvoice,
});
app.http('billing-credit-notes-create', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/credit-notes', handler: createCreditNote,
});
app.http('billing-credit-notes-list', {
  methods: ['GET'], authLevel: 'anonymous',
  route: 'billing/credit-notes', handler: listCreditNotes,
});
app.http('billing-credit-notes-get', {
  methods: ['GET'], authLevel: 'anonymous',
  route: 'billing/credit-notes/{id}', handler: getCreditNote,
});
app.http('billing-credit-notes-issue', {
  methods: ['POST'], authLevel: 'anonymous',
  route: 'billing/credit-notes/{id}/issue', handler: issueCreditNote,
});

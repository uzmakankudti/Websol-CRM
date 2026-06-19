/**
 * Billing business-rule tests — Module 14.
 *
 * This file is purpose-built for the five business rules called out in the
 * spec.  Every test names the rule it exercises and every numeric assertion
 * is accompanied by a hand-derived calculation so a reviewer can verify it
 * without running the code.
 *
 *   BR-012  Invoice generation blocked when any meter reading is PENDING.
 *   BR-025  Overage pages billed at base rate × 1.1 (exact — no float drift).
 *   BR-011  An invoice that has been posted (status ≠ DRAFT) cannot be edited.
 *   BR-022  Credit note must reference an invoice; amount ≤ remaining balance.
 *   §partial Partial-month pro-ration and combined totals are correct to the cent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// A. Pure-function tests — billing-calc.ts
//    No mocks, no DB. Every assertion is deterministic.
// ============================================================================
import {
  decimalToBigInt,
  calcPrinterClicks,
  calcInvoiceTotals,
} from '../src/shared/billing-calc';

// ----------------------------------------------------------------------------
// BR-025: exact overage arithmetic — proving no floating-point drift
// ----------------------------------------------------------------------------
describe('BR-025 — overage rate is base × 11/10, not base × 1.1 (float)', () => {
  // The canonical float trap: 0.01200 × 1.1 in IEEE-754 = 0.013200000000000001
  // Our engine must produce "0.01320" exactly.
  it('BW overage rate has no float drift (0.01200 × 1.1)', () => {
    const r = calcPrinterClicks({
      deltaBw: 1200, deltaColour: null,
      allowanceBw: 1000, allowanceColour: null,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    // IEEE-754 would give "0.013200000000000001"; BigInt gives "0.01320".
    expect(r.overageRateBw).toBe('0.01320');
    expect(r.overageRateBw.length).toBeLessThanOrEqual(7); // no extra digits
  });

  it('colour overage rate has no float drift (0.05000 × 1.1)', () => {
    const r = calcPrinterClicks({
      deltaBw: 0, deltaColour: 300,
      allowanceBw: 1000, allowanceColour: 200,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    // 0.05000 × 1.1 in IEEE-754 = 0.05500000000000001 (hidden drift)
    expect(r.overageRateColour).toBe('0.05500');
  });

  // Hand calculation:
  //   baseBw  = min(1500, 1000) = 1000,  amount = 1000 × 0.01200 = 12.0000
  //   overage = max(1500 - 1000, 0) = 500, rate  = 0.01200 × 11/10 = 0.01320
  //   overageAmt = 500 × 0.01320 = 6.6000
  //   lineTotal  = 12.0000 + 6.6000 = 18.6000
  it('BW-only overage: exact page split and amounts (1500 pages, allowance 1000, rate 0.01200)', () => {
    const r = calcPrinterClicks({
      deltaBw: 1500, deltaColour: null,
      allowanceBw: 1000, allowanceColour: null,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    expect(r.basePagesBy).toBe(1000);
    expect(r.overagePagesBy).toBe(500);
    expect(r.amountBw).toBe('12.0000');          // 1000 × 0.01200
    expect(r.amountOverageBw).toBe('6.6000');    // 500  × 0.01320
    expect(r.lineTotal).toBe('18.6000');
  });

  // Hand calculation:
  //   baseCol   = min(300, 200) = 200, amount  = 200 × 0.05000 = 10.0000
  //   overageCol = 300 - 200 = 100,   rate    = 0.05000 × 11/10 = 0.05500
  //   overageAmt = 100 × 0.05500 = 5.5000
  //   lineTotal  = 10.0000 + 5.5000 = 15.5000
  it('colour-only overage: exact amounts (300 pages, allowance 200, rate 0.05000)', () => {
    const r = calcPrinterClicks({
      deltaBw: 0, deltaColour: 300,
      allowanceBw: 1000, allowanceColour: 200,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    expect(r.basePagesColour).toBe(200);
    expect(r.overagePagesColour).toBe(100);
    expect(r.amountColour).toBe('10.0000');
    expect(r.amountOverageColour).toBe('5.5000');
    expect(r.lineTotal).toBe('15.5000');
  });

  // Hand calculation (zero allowance — every page is "overage"):
  //   baseBw = min(500, 0) = 0,   amount     = 0
  //   overage = 500,               rate       = 0.01200 × 11/10 = 0.01320
  //   overageAmt = 500 × 0.01320 = 6.6000
  it('zero allowance: all pages treated as overage at 1.1× rate', () => {
    const r = calcPrinterClicks({
      deltaBw: 500, deltaColour: null,
      allowanceBw: 0, allowanceColour: null,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    expect(r.basePagesBy).toBe(0);
    expect(r.overagePagesBy).toBe(500);
    expect(r.amountBw).toBe('0.0000');
    expect(r.amountOverageBw).toBe('6.6000');
    expect(r.lineTotal).toBe('6.6000');
  });

  // Hand calculation (both channels over allowance):
  //   BW: 1200 pages, allow 1000, rate 0.01200
  //     base = 1000 → 12.0000, overage = 200 × 0.01320 = 2.6400
  //   Colour: 250 pages, allow 200, rate 0.05000
  //     base = 200 → 10.0000, overage = 50 × 0.05500 = 2.7500
  //   lineTotal = 12.0000 + 2.6400 + 10.0000 + 2.7500 = 27.3900
  it('combined BW + colour overage: lineTotal is exact sum to 4 dp', () => {
    const r = calcPrinterClicks({
      deltaBw: 1200, deltaColour: 250,
      allowanceBw: 1000, allowanceColour: 200,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    expect(r.amountBw).toBe('12.0000');
    expect(r.amountOverageBw).toBe('2.6400');
    expect(r.amountColour).toBe('10.0000');
    expect(r.amountOverageColour).toBe('2.7500');
    expect(r.lineTotal).toBe('27.3900');
  });

  it('exactly at allowance boundary: no overage pages, no overage charge', () => {
    const r = calcPrinterClicks({
      deltaBw: 1000, deltaColour: 200,
      allowanceBw: 1000, allowanceColour: 200,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    expect(r.overagePagesBy).toBe(0);
    expect(r.overagePagesColour).toBe(0);
    expect(r.amountOverageBw).toBe('0.0000');
    expect(r.amountOverageColour).toBe('0.0000');
    // 1000 × 0.01200 + 200 × 0.05000 = 12.0000 + 10.0000 = 22.0000
    expect(r.lineTotal).toBe('22.0000');
  });
});

// ----------------------------------------------------------------------------
// §partial: partial-month pro-ration to the cent
// ----------------------------------------------------------------------------
describe('§partial — lease pro-ration: irrational fractions rounded to the cent', () => {
  // 1000 × 17/31 = 548.38709677…
  // BigInt floor: 100_000_000 × 17 / 31 = 54_838_709 (rem 21)
  // roundToMoney(54_838_709): rem=709 ≥ 500 → round up → 54_839_000 → "548.39"
  it('17 of 31 days, lease 1000.00 → 548.39', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 31, actualDays: 17,
      printerLines: [], taxRate: 0,
    });
    expect(t.leaseFeeProrated).toBe('548.39');
    expect(t.total).toBe('548.39');
  });

  // 1000 × 1/31 = 32.25806452…
  // BigInt floor: 100_000_000 / 31 = 3_225_806 (rem 14)
  // rem=806 ≥ 500 → round up → 3_226_000 → "32.26"
  it('1 of 31 days, lease 1000.00 → 32.26  (first-day new contract)', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 31, actualDays: 1,
      printerLines: [], taxRate: 0,
    });
    expect(t.leaseFeeProrated).toBe('32.26');
  });

  // 500 × 10/30 = 166.6666…
  // BigInt floor: 50_000_000 × 10 / 30 = 16_666_666 (rem 20)
  // rem=666 ≥ 500 → round up → 16_667_000 → "166.67"
  it('10 of 30 days, lease 500.00 → 166.67', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '500.00',
      periodDays: 30, actualDays: 10,
      printerLines: [], taxRate: 0,
    });
    expect(t.leaseFeeProrated).toBe('166.67');
  });

  // 750 × 29/31 = 701.6129…
  // BigInt: 75_000_000 × 29 / 31 = 70_161_290 (floor; × 31 = 2_174_999_990, remainder 10)
  // rem=290 < 500 → round down → 70_161_000 → "701.61"
  it('29 of 31 days, lease 750.00 → 701.61  (rounds down)', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '750.00',
      periodDays: 31, actualDays: 29,
      printerLines: [], taxRate: 0,
    });
    expect(t.leaseFeeProrated).toBe('701.61');
  });

  // Full month must never be affected by pro-ration arithmetic
  it('full month (31/31): leaseFeeProrated equals leaseFeeFull', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1234.56',
      periodDays: 31, actualDays: 31,
      printerLines: [], taxRate: 0,
    });
    expect(t.leaseFeeFull).toBe('1234.56');
    expect(t.leaseFeeProrated).toBe('1234.56');
  });
});

// ----------------------------------------------------------------------------
// §combined: end-to-end totals — lease + overage clicks + tax, to the cent
// ----------------------------------------------------------------------------
describe('§combined — lease pro-ration + overage clicks + tax, to the cent', () => {
  // Scenario:
  //   Period 17/31 days, lease 1000.00
  //   Printer: 1500 BW pages, allowance 1000, rate 0.01200
  //     base    1000 × 0.01200 = 12.0000
  //     overage  500 × 0.01320 =  6.6000
  //   Tax 16%
  //
  //   leasePr  = 548.39  (derived above)
  //   clicksBw = 12.0000 → contributes 12.00 to subtotal
  //   ovBw     =  6.6000 → contributes  6.60 to subtotal
  //   subtotalRaw = 54_838_709 + 1_200_000 + 660_000 = 56_698_709
  //   roundToMoney(56_698_709): rem=709 ≥ 500 → 56_699_000 → "566.99"
  //   taxScaled = decimalToBigInt("566.99") × 1600 / 10000
  //             = 56_699_000 × 1600 / 10_000 = 9_071_840
  //   roundToMoney(9_071_840): rem=840 ≥ 500 → 9_072_000 → "90.72"
  //   total = 56_699_000 + 9_072_000 = 65_771_000 → "657.71"
  it('17/31 days, BW overage, 16% tax: subtotal=566.99, tax=90.72, total=657.71', () => {
    const clicks = calcPrinterClicks({
      deltaBw: 1500, deltaColour: null,
      allowanceBw: 1000, allowanceColour: null,
      rateBw: '0.01200', rateColour: '0.05000',
    });
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 31, actualDays: 17,
      printerLines: [clicks],
      taxRate: 16,
    });
    expect(t.leaseFeeProrated).toBe('548.39');
    expect(t.clicksBwAmount).toBe('12.0000');
    expect(t.overageBwAmount).toBe('6.6000');
    expect(t.subtotal).toBe('566.99');
    expect(t.taxRate).toBe('16.00');
    expect(t.taxAmount).toBe('90.72');
    expect(t.total).toBe('657.71');
  });

  // Fractional tax rate 16.5%:
  //   leaseFee = 1000.00 (full month), clicks = 0
  //   subtotal = 1000.00
  //   taxScaled = decimalToBigInt("1000.00") × round(16.5×100) / 10000
  //             = 100_000_000 × 1650 / 10_000 = 16_500_000
  //   roundToMoney(16_500_000): rem=0 → "165.00"
  //   total = 1000.00 + 165.00 = 1165.00
  it('fractional tax 16.5%: 1000.00 lease → tax 165.00, total 1165.00', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 30, actualDays: 30,
      printerLines: [], taxRate: 16.5,
    });
    expect(t.taxAmount).toBe('165.00');
    expect(t.total).toBe('1165.00');
  });

  // Zero-lease contract (pure click billing), no minimum charge enforced.
  // The current engine has minimum_charge = 0 for all contracts.
  // Minimum-charge enforcement per contract is a future feature.
  it('zero lease fee: total is click charges only (minimum charge = 0 baseline)', () => {
    const clicks = calcPrinterClicks({
      deltaBw: 500, deltaColour: null,
      allowanceBw: 0, allowanceColour: null,   // zero allowance → all overage
      rateBw: '0.01200', rateColour: '0.05000',
    });
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '0.00',
      periodDays: 30, actualDays: 30,
      printerLines: [clicks],
      taxRate: 0,
    });
    // 500 × 0.01320 = 6.6000 → subtotal 6.60 → total 6.60
    expect(t.leaseFeeFull).toBe('0.00');
    expect(t.leaseFeeProrated).toBe('0.00');
    expect(t.overageBwAmount).toBe('6.6000');
    expect(t.subtotal).toBe('6.60');
    expect(t.total).toBe('6.60');
  });
});

// ============================================================================
// B. Endpoint tests — billing.ts
//    DB and auth are mocked; we drive each endpoint through its HTTP handler.
// ============================================================================
import type { HttpRequest, InvocationContext } from '@azure/functions';

vi.mock('../src/shared/db', () => {
  const fn = vi.fn();
  return { query: fn, __esModule: true, default: fn, getDb: vi.fn() };
});
vi.mock('../src/shared/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/auth')>();
  return { ...real, verifyToken: vi.fn() };
});
vi.mock('../src/shared/audit', () => ({ writeAudit: vi.fn() }));

import { query } from '../src/shared/db';
import { verifyToken } from '../src/shared/auth';

const queryMock = query as ReturnType<typeof vi.fn>;
const verifyMock = verifyToken as ReturnType<typeof vi.fn>;

function staffPayload(perms: string[] = [
  'billing.read', 'billing.create', 'billing.issue', 'billing.pay', 'billing.credit',
]) {
  return { userId: 1, email: 'test@example.com', role: 'BILLING_EXECUTIVE', perms };
}

function makeReq(
  method: string,
  body?: unknown,
  params: Record<string, string> = {},
  qs: Record<string, string> = {},
): HttpRequest {
  const url = new URL('http://localhost/api/billing/test');
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  return {
    method,
    url: url.toString(),
    headers: new Headers({ authorization: 'Bearer tok' }),
    params,
    query: url.searchParams,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as HttpRequest;
}

const ctx = { log: vi.fn(), error: vi.fn() } as unknown as InvocationContext;

import {
  generateInvoice,
  issueInvoice,
  voidInvoice,
  createCreditNote,
} from '../src/functions/billing';

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockReturnValue(staffPayload());
});

// ----------------------------------------------------------------------------
// Reusable mock data rows
// ----------------------------------------------------------------------------
const CONTRACT_ROW = {
  id: 1, contract_no: 'CTR-001', customer_id: 5,
  start_date: '2023-01-01', end_date: '2025-12-31',
  monthly_lease_fee: '1000.00',
  per_click_bw: '0.01200', per_click_colour: '0.05000',
  status: 'ACTIVE',
};
const PRINTER_ROW = {
  id: 10, serial_no: 'SN001', model: 'HP-LaserJet', is_colour: 0,
  monthly_allowance_bw: 1000, monthly_allowance_colour: null,
};
const COLOUR_PRINTER_ROW = {
  id: 11, serial_no: 'SN002', model: 'HP-Colour', is_colour: 1,
  monthly_allowance_bw: 500, monthly_allowance_colour: 200,
};

// Helper: set up the mocks for a successful generateInvoice call (one BW printer).
// Returns the queryMock call sequence so callers can inspect it.
function mockSuccessfulGenerate() {
  // 1. contract lookup
  queryMock.mockResolvedValueOnce([CONTRACT_ROW]);
  // 2. printers on contract
  queryMock.mockResolvedValueOnce([PRINTER_ROW]);
  // 3. BR-012: pending readings count → 0
  queryMock.mockResolvedValueOnce([{ n: 0 }]);
  // 4. invoice sequence (no prior invoices this year)
  queryMock.mockResolvedValueOnce([{ n: 0 }]);
  // 5. duplicate-period check → none
  queryMock.mockResolvedValueOnce([]);
  // 6. readings in period for printer 10
  queryMock.mockResolvedValueOnce([{ id: 1, reading_bw: 11500, reading_colour: null }]);
  // 7. opening (prev) reading for printer 10
  queryMock.mockResolvedValueOnce([{ reading_bw: 10000, reading_colour: null }]);
  // 8. INSERT invoices
  queryMock.mockResolvedValueOnce({ insertId: 99 });
  // 9. INSERT invoice_lines
  queryMock.mockResolvedValueOnce({ affectedRows: 1 });
}

// ----------------------------------------------------------------------------
// BR-012: PENDING readings block invoice generation
// ----------------------------------------------------------------------------
describe('BR-012 — generateInvoice: PENDING readings must all be resolved first', () => {
  const period = { periodStart: '2024-01-01', periodEnd: '2024-01-31' };

  it('generates DRAFT invoice when ALL readings are APPROVED (n_pending = 0)', async () => {
    mockSuccessfulGenerate();

    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(201);
    const body = res.jsonBody as { invoice: { invoiceNo: string; status: string } };
    expect(body.invoice.status).toBe('DRAFT');
    expect(body.invoice.invoiceNo).toMatch(/^INV-\d{4}-\d{4}$/);
  });

  it('blocks generation when 1 or more readings are PENDING (BR-012)', async () => {
    queryMock.mockResolvedValueOnce([CONTRACT_ROW]);   // contract
    queryMock.mockResolvedValueOnce([PRINTER_ROW]);    // printers
    queryMock.mockResolvedValueOnce([{ n: 3 }]);       // 3 PENDING readings

    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(422);
    const body = res.jsonBody as { error: { message: string; code: string } };
    expect(body.error.code).toBe('READINGS_PENDING');
    expect(body.error.message).toMatch(/BR-012/);
    expect(body.error.message).toMatch(/3/);           // mentions the count
  });

  it('blocks even when only 1 of many readings is PENDING', async () => {
    queryMock.mockResolvedValueOnce([CONTRACT_ROW]);
    queryMock.mockResolvedValueOnce([PRINTER_ROW, COLOUR_PRINTER_ROW]);
    queryMock.mockResolvedValueOnce([{ n: 1 }]);       // 1 PENDING among many

    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('READINGS_PENDING');
  });

  it('returns 404 when contract does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);               // contract not found

    const req = makeReq('POST', { contractId: 999, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(404);
  });

  it('rejects a duplicate invoice for the same contract + period (409)', async () => {
    queryMock.mockResolvedValueOnce([CONTRACT_ROW]);
    queryMock.mockResolvedValueOnce([PRINTER_ROW]);
    queryMock.mockResolvedValueOnce([{ n: 0 }]);       // no pending
    queryMock.mockResolvedValueOnce([{ n: 2 }]);       // invoice seq
    queryMock.mockResolvedValueOnce([{ id: 5 }]);      // duplicate found

    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DUPLICATE_PERIOD');
  });

  it('returns 422 for a DRAFT contract (unbillable status)', async () => {
    queryMock.mockResolvedValueOnce([{ ...CONTRACT_ROW, status: 'DRAFT' }]);

    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);

    expect(res.status).toBe(422);
  });

  it('returns 400 when contractId is missing', async () => {
    const req = makeReq('POST', { periodStart: '2024-01-01', periodEnd: '2024-01-31' });
    const res = await generateInvoice(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller lacks billing.create permission', async () => {
    verifyMock.mockReturnValue(staffPayload(['billing.read']));
    const req = makeReq('POST', { contractId: 1, ...period });
    const res = await generateInvoice(req, ctx);
    expect(res.status).toBe(403);
  });
});

// ----------------------------------------------------------------------------
// BR-011: posted invoice cannot be edited (any non-DRAFT status)
// ----------------------------------------------------------------------------
describe('BR-011 — issueInvoice: cannot re-post once status ≠ DRAFT', () => {
  // The assertDraft guard throws 409 + code ALREADY_POSTED for all non-DRAFT
  // statuses. The message must reference BR-011 so operators understand why.
  const nonDraftStatuses = ['ISSUED', 'PAID', 'OVERDUE', 'VOID'] as const;

  for (const status of nonDraftStatuses) {
    it(`status ${status} → 409 ALREADY_POSTED with BR-011 in message`, async () => {
      queryMock.mockResolvedValueOnce([{ id: 10, status }]);

      const req = makeReq('POST', {}, { id: '10' });
      const res = await issueInvoice(req, ctx);

      expect(res.status).toBe(409);
      const body = res.jsonBody as { error: { message: string; code: string } };
      expect(body.error.code).toBe('ALREADY_POSTED');
      expect(body.error.message).toMatch(/BR-011/);
      expect(body.error.message).toMatch(new RegExp(status)); // shows current status
    });
  }

  it('DRAFT invoice without oracleRef: issues successfully', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, status: 'DRAFT' }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 }); // UPDATE

    const req = makeReq('POST', {}, { id: '10' });
    const res = await issueInvoice(req, ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { status: string }).status).toBe('ISSUED');
  });

  it('DRAFT invoice with oracleRef records the ref', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, status: 'DRAFT' }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { oracleRef: 'ORA-2024-001' }, { id: '10' });
    const res = await issueInvoice(req, ctx);

    expect(res.status).toBe(200);
    // Verify oracle_ref was passed to the UPDATE query
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[1]).toContain('ORA-2024-001');
  });
});

// ----------------------------------------------------------------------------
// voidInvoice: complementary BR-011 enforcement
// ----------------------------------------------------------------------------
describe('voidInvoice', () => {
  it('voids an ISSUED invoice', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, status: 'ISSUED' }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { reason: 'Test void' }, { id: '7' });
    const res = await voidInvoice(req, ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { status: string }).status).toBe('VOID');
  });

  it('voids a DRAFT invoice', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, status: 'DRAFT' }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { reason: 'Cancelled before issue' }, { id: '7' });
    const res = await voidInvoice(req, ctx);
    expect(res.status).toBe(200);
  });

  it('rejects voiding a PAID invoice (cannot undo payment without a credit note)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, status: 'PAID' }]);

    const req = makeReq('POST', { reason: 'Mistake' }, { id: '7' });
    const res = await voidInvoice(req, ctx);
    expect(res.status).toBe(409);
  });
});

// ----------------------------------------------------------------------------
// BR-022: credit note must reference a real invoice; amount ≤ remaining balance
// ----------------------------------------------------------------------------
describe('BR-022 — createCreditNote: referential integrity and amount cap', () => {
  it('succeeds when amount is exactly equal to the remaining balance', async () => {
    // invoice total 200.00, already credited 0.00 → remaining = 200.00
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '200.00', amount_credited: '0.00', status: 'ISSUED',
    }]);
    queryMock.mockResolvedValueOnce([{ n: 0 }]); // credit seq
    queryMock.mockResolvedValueOnce({ insertId: 77 });
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { invoiceId: 5, amount: 200.00, reason: 'Full refund' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(201);
  });

  it('succeeds for a partial credit that leaves remaining balance > 0', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '300.00', status: 'ISSUED',
    }]);
    queryMock.mockResolvedValueOnce([{ n: 1 }]); // credit seq
    queryMock.mockResolvedValueOnce({ insertId: 78 });
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { invoiceId: 5, amount: 699.99, reason: 'Partial overcharge' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(201);
    const body = res.jsonBody as { creditNote: { amount: string } };
    expect(body.creditNote.amount).toBe('699.99');
  });

  it('rejects when credit amount exceeds remaining balance by even 1 cent (BR-022)', async () => {
    // total 1000, credited 800 → remaining 200; trying to credit 200.01
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '800.00', status: 'ISSUED',
    }]);

    const req = makeReq('POST', { invoiceId: 5, amount: 200.01, reason: 'Over the limit' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
    const body = res.jsonBody as { error: { message: string; code: string } };
    expect(body.error.code).toBe('CREDIT_EXCEEDS_INVOICE');
    expect(body.error.message).toMatch(/BR-022/);
    expect(body.error.message).toMatch(/200\.00/); // shows remaining balance
  });

  it('rejects when cumulative credits would exceed total (second credit too large)', async () => {
    // After first 900.00 credit on a 1000 invoice, remaining = 100.
    // Attempting a second 150.00 credit must fail.
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '900.00', status: 'ISSUED',
    }]);

    const req = makeReq('POST', { invoiceId: 5, amount: 150, reason: 'Second credit too large' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('CREDIT_EXCEEDS_INVOICE');
  });

  it('rejects credit against a non-existent invoice (BR-022 referential integrity)', async () => {
    queryMock.mockResolvedValueOnce([]); // invoice not found

    const req = makeReq('POST', { invoiceId: 9999, amount: 50, reason: 'Phantom invoice' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(404);
  });

  it('rejects credit against a DRAFT invoice (not yet posted)', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '0.00', status: 'DRAFT',
    }]);

    const req = makeReq('POST', { invoiceId: 5, amount: 100, reason: 'Too early' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { message: string } }).error.message).toMatch(/DRAFT/);
  });

  it('rejects credit against a VOID invoice', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '0.00', status: 'VOID',
    }]);

    const req = makeReq('POST', { invoiceId: 5, amount: 100, reason: 'Void ref' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { message: string } }).error.message).toMatch(/VOID/);
  });

  it('returns 400 when invoiceId is missing', async () => {
    const req = makeReq('POST', { amount: 100, reason: 'no invoice ref' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is missing', async () => {
    const req = makeReq('POST', { invoiceId: 5, reason: 'no amount' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when reason is missing', async () => {
    const req = makeReq('POST', { invoiceId: 5, amount: 100 });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(400);
  });

  it('rejects when caller lacks billing.credit permission', async () => {
    verifyMock.mockReturnValue(staffPayload(['billing.read']));
    const req = makeReq('POST', { invoiceId: 5, amount: 100, reason: 'test' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(403);
  });
});

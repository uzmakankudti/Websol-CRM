/**
 * Billing module tests.
 *
 * Part A — pure unit tests for billing-calc.ts (no DB, no mocking).
 * Part B — endpoint tests for billing.ts using the standard vi.mock pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A. billing-calc.ts — pure unit tests
// ---------------------------------------------------------------------------
import {
  decimalToBigInt,
  bigIntToDecimal,
  roundToMoney,
  daysInMonth,
  computePeriodDays,
  calcPrinterClicks,
  calcInvoiceTotals,
} from '../src/shared/billing-calc';

describe('decimalToBigInt / bigIntToDecimal round-trip', () => {
  it('converts a 4-dp decimal string to BigInt and back', () => {
    const input = '0.0120';
    const bi = decimalToBigInt(input);
    // SCALE=1e5, so 0.0120 → 1200
    expect(bi).toBe(1200n);
    expect(bigIntToDecimal(bi, 4)).toBe('0.0120');
  });

  it('handles whole numbers', () => {
    expect(decimalToBigInt('5.00000')).toBe(500000n);
    expect(bigIntToDecimal(500000n, 2)).toBe('5.00');
  });

  it('handles a 5-dp rate string', () => {
    const bi = decimalToBigInt('0.01200');
    expect(bi).toBe(1200n);
  });
});

describe('roundToMoney', () => {
  it('rounds half-up correctly', () => {
    // 0.005 = 500 scaled; round to 2 dp → 0.01
    const fiveMills = decimalToBigInt('0.00500');
    expect(roundToMoney(fiveMills)).toBe('0.01');
  });

  it('rounds down when < 0.005', () => {
    const almostFiveMills = decimalToBigInt('0.00499');
    expect(roundToMoney(almostFiveMills)).toBe('0.00');
  });

  it('preserves whole-number values', () => {
    expect(roundToMoney(decimalToBigInt('100.00000'))).toBe('100.00');
  });
});

describe('daysInMonth', () => {
  it('January has 31 days', () => expect(daysInMonth(2024, 1)).toBe(31));
  it('February 2024 (leap) has 29 days', () => expect(daysInMonth(2024, 2)).toBe(29));
  it('February 2023 (non-leap) has 28 days', () => expect(daysInMonth(2023, 2)).toBe(28));
  it('April has 30 days', () => expect(daysInMonth(2024, 4)).toBe(30));
});

describe('computePeriodDays', () => {
  const pStart = new Date('2024-01-01');
  const pEnd   = new Date('2024-01-31');

  it('full month when contract spans entire period', () => {
    const { periodDays, actualDays } = computePeriodDays(
      pStart, pEnd,
      new Date('2023-12-01'), new Date('2025-01-01'),
    );
    expect(periodDays).toBe(31);
    expect(actualDays).toBe(31);
  });

  it('partial month at the start of a contract', () => {
    const { periodDays, actualDays } = computePeriodDays(
      pStart, pEnd,
      new Date('2024-01-15'), new Date('2025-01-01'),
    );
    expect(periodDays).toBe(31);
    // 15 Jan – 31 Jan inclusive = 17 days
    expect(actualDays).toBe(17);
  });

  it('partial month at contract expiry', () => {
    const { periodDays, actualDays } = computePeriodDays(
      pStart, pEnd,
      new Date('2023-06-01'), new Date('2024-01-10'),
    );
    expect(periodDays).toBe(31);
    // 1 Jan – 10 Jan inclusive = 10 days
    expect(actualDays).toBe(10);
  });

  it('zero when contract does not overlap the period', () => {
    const { actualDays } = computePeriodDays(
      pStart, pEnd,
      new Date('2024-03-01'), new Date('2024-12-31'),
    );
    expect(actualDays).toBe(0);
  });
});

describe('calcPrinterClicks — BR-025', () => {
  const base = {
    allowanceBw: 1000,
    allowanceColour: 200,
    rateBw: '0.01200',
    rateColour: '0.05000',
  };

  it('no overage: all pages within allowance', () => {
    const r = calcPrinterClicks({ ...base, deltaBw: 800, deltaColour: 150 });
    expect(r.basePagesBy).toBe(800);
    expect(r.overagePagesBy).toBe(0);
    expect(r.basePagesColour).toBe(150);
    expect(r.overagePagesColour).toBe(0);
    // 800 × 0.01200 = 9.6000
    expect(r.amountBw).toBe('9.6000');
    // 150 × 0.05000 = 7.5000
    expect(r.amountColour).toBe('7.5000');
    expect(r.amountOverageBw).toBe('0.0000');
    expect(r.amountOverageColour).toBe('0.0000');
  });

  it('B/W overage at 1.1× (BR-025)', () => {
    const r = calcPrinterClicks({ ...base, deltaBw: 1200, deltaColour: 0 });
    expect(r.basePagesBy).toBe(1000);
    expect(r.overagePagesBy).toBe(200);
    // overage rate = 0.01200 × 11 / 10 = 0.01320 exactly
    expect(r.overageRateBw).toBe('0.01320');
    // 200 × 0.01320 = 2.6400
    expect(r.amountOverageBw).toBe('2.6400');
    // no float drift: 0.01200 × 1.1 could give 0.013200000000000001 in JS
    expect(parseFloat(r.overageRateBw)).toBeCloseTo(0.0132, 10);
  });

  it('colour overage at 1.1×', () => {
    const r = calcPrinterClicks({ ...base, deltaBw: 0, deltaColour: 300 });
    expect(r.overagePagesColour).toBe(100);
    // 0.05000 × 11/10 = 0.05500
    expect(r.overageRateColour).toBe('0.05500');
    // 100 × 0.05500 = 5.5000
    expect(r.amountOverageColour).toBe('5.5000');
  });

  it('null colour pages produce null page counts', () => {
    const r = calcPrinterClicks({ ...base, deltaBw: 100, deltaColour: null });
    expect(r.basePagesColour).toBeNull();
    expect(r.overagePagesColour).toBeNull();
    expect(r.amountColour).toBe('0.0000');
    expect(r.amountOverageColour).toBe('0.0000');
  });

  it('lineTotal is sum of all amounts', () => {
    const r = calcPrinterClicks({ ...base, deltaBw: 1100, deltaColour: 250 });
    const expected =
      parseFloat(r.amountBw) + parseFloat(r.amountColour) +
      parseFloat(r.amountOverageBw) + parseFloat(r.amountOverageColour);
    expect(parseFloat(r.lineTotal)).toBeCloseTo(expected, 10);
  });
});

describe('calcInvoiceTotals', () => {
  const line = {
    lineTotal: '12.0000',
    amountBw: '9.6000',
    amountColour: '7.5000',
    amountOverageBw: '2.6400',
    amountOverageColour: '5.5000',
  };

  it('full month (no pro-ration) with zero tax', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 31,
      actualDays: 31,
      printerLines: [line],
      taxRate: 0,
    });
    expect(t.leaseFeeFull).toBe('1000.00');
    expect(t.leaseFeeProrated).toBe('1000.00');
    expect(t.taxAmount).toBe('0.00');
    // subtotal = 1000.00 + 9.60 + 7.50 + 2.64 + 5.50 = 1025.24
    expect(t.subtotal).toBe('1025.24');
    expect(t.total).toBe('1025.24');
  });

  it('partial month pro-rates correctly', () => {
    // 15 of 30 days → half the lease
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 30,
      actualDays: 15,
      printerLines: [],
      taxRate: 0,
    });
    expect(t.leaseFeeProrated).toBe('500.00');
    expect(t.subtotal).toBe('500.00');
  });

  it('applies tax correctly (16%)', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '1000.00',
      periodDays: 30,
      actualDays: 30,
      printerLines: [],
      taxRate: 16,
    });
    // subtotal = 1000, tax = 160, total = 1160
    expect(t.subtotal).toBe('1000.00');
    expect(t.taxAmount).toBe('160.00');
    expect(t.total).toBe('1160.00');
  });

  it('aggregates multiple printer lines', () => {
    const t = calcInvoiceTotals({
      leaseFeeMonthly: '0.00',
      periodDays: 31,
      actualDays: 31,
      printerLines: [line, line], // 2× same line
      taxRate: 0,
    });
    // Each line: 9.60 + 7.50 + 2.64 + 5.50 = 25.24; ×2 = 50.48
    expect(parseFloat(t.subtotal)).toBeCloseTo(50.48, 2);
  });
});

// ---------------------------------------------------------------------------
// B. billing.ts endpoint tests
// ---------------------------------------------------------------------------
import type { HttpRequest, InvocationContext } from '@azure/functions';

vi.mock('../src/shared/db', () => {
  const fn = vi.fn();
  return { query: fn, __esModule: true, default: fn, getDb: vi.fn() };
});
vi.mock('../src/shared/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/auth')>();
  return {
    ...real,
    verifyToken: vi.fn(),
  };
});
vi.mock('../src/shared/audit', () => ({ writeAudit: vi.fn() }));

import { query } from '../src/shared/db';
import { verifyToken } from '../src/shared/auth';
import { writeAudit } from '../src/shared/audit';

const queryMock = query as ReturnType<typeof vi.fn>;
const verifyMock = verifyToken as ReturnType<typeof vi.fn>;

// Build a minimal staff JWT payload
function staffPayload(perms: string[] = ['billing.read', 'billing.create', 'billing.issue', 'billing.pay', 'billing.credit']) {
  return { userId: 1, email: 'test@example.com', role: 'BILLING_EXECUTIVE', perms };
}

function makeReq(method: string, body?: unknown, params: Record<string, string> = {}): HttpRequest {
  return {
    method,
    url: 'http://localhost/api/billing/invoices',
    headers: new Headers({ authorization: 'Bearer tok' }),
    params,
    query: new URLSearchParams(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as HttpRequest;
}

const ctx = { log: vi.fn(), error: vi.fn() } as unknown as InvocationContext;

import {
  listInvoices,
  issueInvoice,
  payInvoice,
  createCreditNote,
} from '../src/functions/billing';

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockReturnValue(staffPayload());
});

describe('listInvoices endpoint', () => {
  it('returns invoices list when authenticated', async () => {
    queryMock.mockResolvedValueOnce([
      { id: 1, invoice_no: 'INV-2024-001', contract_id: 1, contract_no: 'CTR-001',
        customer_id: 5, customer_name: 'ACME Ltd', period_start: '2024-01-01',
        period_end: '2024-01-31', total: '1160.00', amount_paid: '0.00',
        amount_credited: '0.00', status: 'DRAFT', due_date: '2024-02-29',
        issued_at: null, paid_at: null },
    ]);

    const req = makeReq('GET');
    const res = await listInvoices(req, ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { invoices: Array<{ invoiceNo: string; balance: string }> };
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices[0].invoiceNo).toBe('INV-2024-001');
    expect(body.invoices[0].balance).toBe('1160.00');
  });

  it('rejects unauthenticated requests with 401', async () => {
    verifyMock.mockReturnValue(null);
    const req = makeReq('GET');
    const res = await listInvoices(req, ctx);
    expect(res.status).toBe(401);
  });
});

describe('issueInvoice endpoint', () => {
  it('issues a DRAFT invoice (DRAFT → ISSUED)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, status: 'DRAFT', oracle_ref: null }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', {}, { id: '10' });
    const res = await issueInvoice(req, ctx);
    expect(res.status).toBe(200);
  });

  it('rejects issuing a non-DRAFT invoice (BR-011)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 10, status: 'ISSUED', oracle_ref: 'INV123' }]);
    const req = makeReq('POST', {}, { id: '10' });
    const res = await issueInvoice(req, ctx);
    expect(res.status).toBe(409);
  });

  it('rejects when missing billing.issue permission', async () => {
    verifyMock.mockReturnValue(staffPayload(['billing.read']));
    const req = makeReq('POST', {}, { id: '10' });
    const res = await issueInvoice(req, ctx);
    expect(res.status).toBe(403);
  });
});

describe('createCreditNote endpoint (BR-022)', () => {
  it('creates credit note within remaining balance', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '0.00', status: 'ISSUED',
    }]);
    queryMock.mockResolvedValueOnce([{ n: 0 }]);
    queryMock.mockResolvedValueOnce({ insertId: 42 });
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });

    const req = makeReq('POST', { invoiceId: 5, amount: 200, reason: 'Pricing error' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(201);
    const body = res.jsonBody as { creditNote: { id: number } };
    expect(body.creditNote.id).toBe(42);
  });

  it('rejects amount exceeding remaining balance (BR-022)', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '800.00', status: 'ISSUED',
    }]);
    const req = makeReq('POST', { invoiceId: 5, amount: 250, reason: 'Over-credit' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
    const body = res.jsonBody as { error: { message: string } };
    expect(body.error.message).toMatch(/BR-022/);
  });

  it('rejects credit note on a VOID invoice', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 5, customer_id: 3, total: '1000.00', amount_credited: '0.00', status: 'VOID',
    }]);
    const req = makeReq('POST', { invoiceId: 5, amount: 50, reason: 'test' });
    const res = await createCreditNote(req, ctx);
    expect(res.status).toBe(422);
  });
});

describe('payInvoice endpoint', () => {
  it('marks an ISSUED invoice as PAID', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, status: 'ISSUED', total: '500.00', amount_paid: '0.00', amount_credited: '0.00' }]);
    queryMock.mockResolvedValueOnce({ affectedRows: 1 });
    const req = makeReq('POST', {}, { id: '7' });
    const res = await payInvoice(req, ctx);
    expect(res.status).toBe(200);
  });

  it('rejects paying an already PAID invoice', async () => {
    queryMock.mockResolvedValueOnce([{ id: 7, status: 'PAID', total: '500.00', amount_paid: '500.00', amount_credited: '0.00' }]);
    const req = makeReq('POST', {}, { id: '7' });
    const res = await payInvoice(req, ctx);
    expect(res.status).toBe(409);
  });
});

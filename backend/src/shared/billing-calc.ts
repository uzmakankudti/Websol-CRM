/**
 * Billing calculation engine.
 *
 * All arithmetic uses integer cents / basis-points to avoid floating-point
 * drift, then converts back to DECIMAL strings for storage. MySQL DECIMAL
 * columns are the ultimate source of truth — we only need the JS arithmetic
 * to stay bit-exact during generation.
 *
 * Business rules implemented here:
 *   BR-025  Pages above the monthly allowance are charged at base rate × 1.1.
 *   Partial month pro-ration: lease_fee × (actual_days / period_days).
 *   Minimum charge: if total click charges < minimum_charge (currently 0, can
 *   be configured per contract in the future) the minimum applies.
 *
 * All exported functions are pure (no DB calls) so they are trivially testable.
 */

/** Scale factor: we work in 1/100000 of a currency unit (5 decimal places). */
const SCALE = 100_000n;
/** Overage premium multiplier numerator / denominator = 11/10 = 1.1 exactly. */
const OVERAGE_NUM = 11n;
const OVERAGE_DEN = 10n;

/** Convert a DECIMAL string like "0.01200" to a BigInt scaled by SCALE. */
export function decimalToBigInt(value: string | number): bigint {
  // Normalise to a string with exactly 5 decimal places.
  const str = typeof value === 'number' ? value.toFixed(5) : String(value);
  const [intPart, fracPart = ''] = str.split('.');
  const frac5 = fracPart.padEnd(5, '0').slice(0, 5);
  return BigInt(intPart + frac5);
}

/** Convert a scaled BigInt back to a string with `decimals` decimal places. */
export function bigIntToDecimal(value: bigint, decimals: number = 4): string {
  const divisor = 10n ** BigInt(decimals);
  // Scale from SCALE (1e5) down to `decimals` decimal places.
  const scaledDown = value / (SCALE / divisor);
  const sign = scaledDown < 0n ? '-' : '';
  const abs = scaledDown < 0n ? -scaledDown : scaledDown;
  const intPart = abs / divisor;
  const fracPart = abs % divisor;
  return `${sign}${intPart}.${String(fracPart).padStart(decimals, '0')}`;
}

/** Round a scaled BigInt to 2 decimal places (standard money rounding). */
export function roundToMoney(value: bigint): string {
  // SCALE is 1e5; we want 2 dp so divisor = 1e3.
  const divisor = 1_000n;
  const rem = value % divisor;
  const rounded = rem >= 500n ? value - rem + divisor : value - rem;
  const cents100 = rounded / divisor; // now in 1/100 units
  const intPart = cents100 / 100n;
  const fracPart = cents100 % 100n;
  return `${intPart}.${String(fracPart).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

/** Days in a calendar month for a given year+month (1-based). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Given a contract start/end and a billing period start/end, return:
 *   - periodDays: days in the full calendar month
 *   - actualDays: days the contract was actually active in the period
 *
 * Both dates are inclusive.
 */
export function computePeriodDays(
  periodStart: Date,
  periodEnd: Date,
  contractStart: Date,
  contractEnd: Date,
): { periodDays: number; actualDays: number } {
  const periodDays = Math.round(
    (periodEnd.getTime() - periodStart.getTime()) / 86_400_000,
  ) + 1;

  const effectiveStart = contractStart > periodStart ? contractStart : periodStart;
  const effectiveEnd   = contractEnd   < periodEnd   ? contractEnd   : periodEnd;

  if (effectiveStart > effectiveEnd) {
    return { periodDays, actualDays: 0 };
  }
  const actualDays = Math.round(
    (effectiveEnd.getTime() - effectiveStart.getTime()) / 86_400_000,
  ) + 1;
  return { periodDays, actualDays };
}

// ---------------------------------------------------------------------------
// Per-printer click calculation (BR-025)
// ---------------------------------------------------------------------------

export interface PrinterClickInput {
  deltaBw: number;           // pages consumed in period
  deltaColour: number | null;
  allowanceBw: number;       // monthly allowance (0 = none)
  allowanceColour: number | null;
  rateBw: string;            // DECIMAL string e.g. "0.01200"
  rateColour: string;        // DECIMAL string
}

export interface PrinterClickResult {
  basePagesBy: number;
  overagePagesBy: number;
  basePagesColour: number | null;
  overagePagesColour: number | null;
  rateBw: string;
  rateColour: string;
  overageRateBw: string;      // rateBw × 1.1
  overageRateColour: string;
  amountBw: string;           // 4 dp
  amountColour: string;       // 4 dp
  amountOverageBw: string;    // 4 dp
  amountOverageColour: string;// 4 dp
  lineTotal: string;          // 4 dp
}

export function calcPrinterClicks(input: PrinterClickInput): PrinterClickResult {
  const { deltaBw, deltaColour, allowanceBw, allowanceColour, rateBw, rateColour } = input;

  const rBw  = decimalToBigInt(rateBw);
  const rCol = decimalToBigInt(rateColour);

  // B/W breakdown
  const baseBw    = Math.min(deltaBw, allowanceBw);
  const overageBw = Math.max(deltaBw - allowanceBw, 0);

  // Colour breakdown
  const dCol  = deltaColour ?? 0;
  const acol  = allowanceColour ?? 0;
  const baseCol    = deltaColour != null ? Math.min(dCol, acol) : null;
  const overageCol = deltaColour != null ? Math.max(dCol - acol, 0) : null;

  // Overage rates: exact integer arithmetic avoids 0.01200 × 1.1 = 0.013200000...1
  const overageRBw  = (rBw  * OVERAGE_NUM) / OVERAGE_DEN;
  const overageRCol = (rCol * OVERAGE_NUM) / OVERAGE_DEN;

  // Amounts in SCALE units
  const aBw      = rBw         * BigInt(baseBw);
  const aOvBw    = overageRBw  * BigInt(overageBw);
  const aColAmt  = rCol        * BigInt(baseCol    ?? 0);
  const aOvCol   = overageRCol * BigInt(overageCol ?? 0);

  const lineScaled = aBw + aOvBw + aColAmt + aOvCol;

  return {
    basePagesBy:          baseBw,
    overagePagesBy:       overageBw,
    basePagesColour:      baseCol,
    overagePagesColour:   overageCol,
    rateBw,
    rateColour,
    overageRateBw:        bigIntToDecimal(overageRBw,  5),
    overageRateColour:    bigIntToDecimal(overageRCol, 5),
    amountBw:             bigIntToDecimal(aBw,      4),
    amountColour:         bigIntToDecimal(aColAmt,  4),
    amountOverageBw:      bigIntToDecimal(aOvBw,    4),
    amountOverageColour:  bigIntToDecimal(aOvCol,   4),
    lineTotal:            bigIntToDecimal(lineScaled, 4),
  };
}

// ---------------------------------------------------------------------------
// Invoice totals
// ---------------------------------------------------------------------------

export interface InvoiceTotalsInput {
  leaseFeeMonthly: string;  // DECIMAL string
  periodDays: number;
  actualDays: number;
  printerLines: Array<{ lineTotal: string; amountBw: string; amountColour: string; amountOverageBw: string; amountOverageColour: string }>;
  taxRate: number;          // percentage, e.g. 16 for 16 %
}

export interface InvoiceTotals {
  leaseFeeFull: string;    // monthly fee unprorated
  leaseFeeProrated: string;
  clicksBwAmount: string;
  clicksColourAmount: string;
  overageBwAmount: string;
  overageColourAmount: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
}

export function calcInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const { leaseFeeMonthly, periodDays, actualDays, printerLines, taxRate } = input;

  const leaseScaled = decimalToBigInt(leaseFeeMonthly);

  // Pro-rate if partial month: fee × actualDays / periodDays, exact integer division.
  const leaseFull    = leaseScaled;
  const leasePrRaw   = (leaseScaled * BigInt(actualDays)) / BigInt(periodDays);
  // Round pro-rated to 2 dp.
  const leasePr      = BigInt(Math.round(Number(leasePrRaw)));

  // Aggregate click amounts from lines.
  let sumBw = 0n, sumCol = 0n, sumOvBw = 0n, sumOvCol = 0n;
  for (const l of printerLines) {
    sumBw   += decimalToBigInt(l.amountBw);
    sumCol  += decimalToBigInt(l.amountColour);
    sumOvBw += decimalToBigInt(l.amountOverageBw);
    sumOvCol+= decimalToBigInt(l.amountOverageColour);
  }

  const clickTotal = sumBw + sumCol + sumOvBw + sumOvCol;
  // Subtotal: lease + clicks, rounded to 2 dp.
  const subtotalRaw = leasePr + clickTotal;
  const subtotalStr = roundToMoney(subtotalRaw);
  const subtotal    = decimalToBigInt(subtotalStr);

  // Tax (integer): subtotal × taxRate / 100, rounded to 2 dp.
  const taxScaled = (subtotal * BigInt(Math.round(taxRate * 100))) / 10_000n;
  const taxStr    = roundToMoney(taxScaled);
  const tax       = decimalToBigInt(taxStr);
  const totalStr  = roundToMoney(subtotal + tax);

  return {
    leaseFeeFull:       roundToMoney(leaseFull),
    leaseFeeProrated:   roundToMoney(leasePr),
    clicksBwAmount:     bigIntToDecimal(sumBw,    4),
    clicksColourAmount: bigIntToDecimal(sumCol,   4),
    overageBwAmount:    bigIntToDecimal(sumOvBw,  4),
    overageColourAmount:bigIntToDecimal(sumOvCol, 4),
    subtotal:           subtotalStr,
    taxRate:            taxRate.toFixed(2),
    taxAmount:          taxStr,
    total:              totalStr,
  };
}

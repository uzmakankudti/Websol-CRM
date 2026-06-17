/** Formatting + badge helpers shared by the contract/customer screens. */
import type { ContractStatus, SlaTier } from '../types';

export const SLA_TIERS: SlaTier[] = ['PLATINUM', 'GOLD', 'SILVER', 'BRONZE'];

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  // Date-only strings render without a spurious time/zone shift.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString();
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

export function fmtRate(n: number): string {
  return `R ${n.toFixed(5)}`;
}

export function contractStatusBadge(status: ContractStatus): string {
  if (status === 'ACTIVE') return 'badge badge-active';
  if (status === 'TERMINATED') return 'badge badge-inactive';
  if (status === 'EXPIRED') return 'badge badge-warning';
  return 'badge badge-pending';
}

export function slaBadge(tier: SlaTier): string {
  return `badge sla-${tier.toLowerCase()}`;
}

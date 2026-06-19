/**
 * Billing & Invoice Management — Module 14.
 *
 * Tabs: Invoices | Credit Notes
 * Invoice list → detail view with printer lines + credit notes.
 * Generate-invoice modal, issue/pay/void actions, create credit note.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import {
  PERM,
  type Invoice, type InvoiceSummary, type InvoiceLine,
  type CreditNote, type InvoiceStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------
const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#7f8c8d', ISSUED: '#2980b9', PAID: '#27ae60',
  OVERDUE: '#c0392b', VOID: '#95a5a6',
};
function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: '0.75rem', fontWeight: 600, color: '#fff',
      background: STATUS_COLOR[status] ?? '#555',
    }}>{status}</span>
  );
}

function fmt(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const n = parseFloat(String(v));
  return isNaN(n) ? String(v) : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function money(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const n = parseFloat(String(v));
  return isNaN(n) ? '—' : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
type MainTab = 'invoices' | 'credits';

export default function BillingPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<MainTab>('invoices');
  const [selectedInvoice, setSelectedInvoice] = useState<number | null>(null);

  if (selectedInvoice) {
    return (
      <InvoiceDetail
        invoiceId={selectedInvoice}
        onBack={() => setSelectedInvoice(null)}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Billing & Invoicing</h2>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #ddd', marginBottom: 16 }}>
        {(['invoices', 'credits'] as MainTab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 16px', fontWeight: tab === t ? 700 : 400,
            borderBottom: tab === t ? '2px solid #2980b9' : '2px solid transparent',
            marginBottom: -2,
          }}>
            {t === 'invoices' ? 'Invoices' : 'Credit Notes'}
          </button>
        ))}
      </div>

      {tab === 'invoices' && (
        <InvoiceList
          canCreate={can(PERM.billingCreate)}
          onSelect={setSelectedInvoice}
        />
      )}
      {tab === 'credits' && <CreditNoteList />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice list
// ---------------------------------------------------------------------------
function InvoiceList({ canCreate, onSelect }: { canCreate: boolean; onSelect: (id: number) => void }) {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showGenerate, setShowGenerate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      const data = await api.get<{ invoices: InvoiceSummary[] }>(`/billing/invoices${params}`);
      setInvoices(data.invoices);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '4px 8px' }}>
          <option value=''>All statuses</option>
          {(['DRAFT','ISSUED','PAID','OVERDUE','VOID'] as InvoiceStatus[]).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {canCreate && (
          <button className='btn-primary' onClick={() => setShowGenerate(true)}>+ Generate Invoice</button>
        )}
      </div>

      {notice && (
        <div style={{ background: '#eafaf1', border: '1px solid #27ae60', borderRadius: 6, padding: '8px 16px', marginBottom: 12 }}>
          {notice}
          <button style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setNotice('')}>✕</button>
        </div>
      )}

      {err && <p style={{ color: 'red' }}>{err}</p>}
      {loading ? <p className='muted'>Loading…</p> : invoices.length === 0 ? (
        <p className='muted'>No invoices found.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              {['Invoice', 'Customer', 'Contract', 'Period', 'Total', 'Balance', 'Due', 'Status'].map((h) => (
                <th key={h} style={{ padding: '6px 8px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                onClick={() => onSelect(inv.id)}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{inv.invoiceNo}</td>
                <td style={{ padding: '6px 8px' }}>{inv.customerName}</td>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{inv.contractNo}</td>
                <td style={{ padding: '6px 8px', fontSize: '0.8rem' }}>{inv.periodStart} – {inv.periodEnd}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{money(inv.total)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: parseFloat(inv.balance) > 0 ? '#c0392b' : '#27ae60' }}>
                  {money(inv.balance)}
                </td>
                <td style={{ padding: '6px 8px' }}>{inv.dueDate ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}><StatusBadge status={inv.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showGenerate && (
        <GenerateInvoiceModal
          onClose={() => setShowGenerate(false)}
          onCreated={(msg) => { setShowGenerate(false); setNotice(msg); void load(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice detail
// ---------------------------------------------------------------------------
function InvoiceDetail({ invoiceId, onBack }: { invoiceId: number; onBack: () => void }) {
  const { can } = useAuth();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [credits, setCredits] = useState<{ id: number; creditNo: string; amount: string; status: string; issuedAt: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showCredit, setShowCredit] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const data = await api.get<{ invoice: Invoice; lines: InvoiceLine[]; creditNotes: typeof credits }>(
        `/billing/invoices/${invoiceId}`,
      );
      setInv(data.invoice); setLines(data.lines); setCredits(data.creditNotes);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [invoiceId]);

  useEffect(() => { void load(); }, [load]);

  async function doAction(path: string, body: unknown, msg: string) {
    setBusy(true); setErr('');
    try {
      await api.post(path, body);
      setNotice(msg);
      await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Action failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <p className='muted'>Loading…</p>;
  if (!inv) return <p style={{ color: 'red' }}>{err || 'Not found'}</p>;

  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2980b9', marginBottom: 12 }}>← Back</button>

      {notice && (
        <div style={{ background: '#eafaf1', border: '1px solid #27ae60', borderRadius: 4, padding: '8px 12px', marginBottom: 12 }}>
          {notice} <button style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setNotice('')}>✕</button>
        </div>
      )}
      {err && <p style={{ color: 'red' }}>{err}</p>}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'monospace' }}>{inv.invoiceNo}</h2>
          <div style={{ color: '#666', marginTop: 4 }}>{inv.customerName} · {inv.contractNo}</div>
        </div>
        <StatusBadge status={inv.status} />
      </div>

      {/* Summary grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          ['Period', `${inv.periodStart} – ${inv.periodEnd}`],
          ['Days (actual/month)', `${inv.actualDays} / ${inv.periodDays}`],
          ['Due date', inv.dueDate ?? '—'],
          ['Lease fee (full)', money(inv.leaseFeeFull)],
          ['Lease fee (pro-rated)', money(inv.leaseFeeProrated)],
          ['B/W clicks', money(inv.clicksBwAmount)],
          ['Colour clicks', money(inv.clicksColourAmount)],
          ['B/W overage', money(inv.overageBwAmount)],
          ['Colour overage', money(inv.overageColourAmount)],
          ['Subtotal', money(inv.subtotal)],
          [`Tax (${inv.taxRate}%)`, money(inv.taxAmount)],
          ['Total', money(inv.total)],
          ['Paid', money(inv.amountPaid)],
          ['Credited', money(inv.amountCredited)],
          ['Balance', money(inv.balance)],
        ].map(([label, value]) => (
          <div key={label} style={{ background: '#f8f9fa', borderRadius: 4, padding: '8px 10px' }}>
            <div style={{ fontSize: '0.75rem', color: '#888' }}>{label}</div>
            <div style={{ fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {can(PERM.billingIssue) && inv.status === 'DRAFT' && (
          <button className='btn-primary' disabled={busy}
            onClick={() => void doAction(`/billing/invoices/${inv.id}/issue`, {}, 'Invoice issued')}>
            Issue Invoice
          </button>
        )}
        {can(PERM.billingPay) && ['ISSUED','OVERDUE'].includes(inv.status) && (
          <button className='btn-primary' disabled={busy}
            onClick={() => void doAction(`/billing/invoices/${inv.id}/pay`, {}, 'Invoice marked paid')}>
            Mark Paid
          </button>
        )}
        {can(PERM.billingPay) && !['PAID','VOID'].includes(inv.status) && (
          <button disabled={busy}
            onClick={() => {
              const reason = window.prompt('Void reason?');
              if (reason) void doAction(`/billing/invoices/${inv.id}/void`, { reason }, 'Invoice voided');
            }}>
            Void
          </button>
        )}
        {can(PERM.billingCredit) && !['DRAFT','VOID'].includes(inv.status) && (
          <button onClick={() => setShowCredit(true)}>+ Credit Note</button>
        )}
      </div>

      {/* Printer lines */}
      <h3>Printer Lines</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', marginBottom: 20 }}>
        <thead>
          <tr style={{ textAlign: 'left', background: '#eef1f4' }}>
            {['Printer', 'Opening BW', 'Closing BW', 'Delta BW', 'Allowance', 'Base pages', 'Overage', 'BW Amount', 'Col Amount', 'Overage Amt', 'Line Total'].map((h) => (
              <th key={h} style={{ padding: '5px 6px' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: '5px 6px' }}><code>{l.serialNo}</code><br/><span style={{ color: '#888', fontSize: '0.75rem' }}>{l.model}</span></td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.openingBw.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.closingBw.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.deltaBw.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.allowanceBw.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{l.basePagesBy.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', color: l.overagePagesBy > 0 ? '#e74c3c' : undefined }}>{l.overagePagesBy.toLocaleString()}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{fmt(l.amountBw)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{fmt(l.amountColour)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', color: (parseFloat(l.amountOverageBw) + parseFloat(l.amountOverageColour)) > 0 ? '#e74c3c' : undefined }}>
                {fmt((parseFloat(l.amountOverageBw) + parseFloat(l.amountOverageColour)).toFixed(4))}
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 600 }}>{fmt(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Credit notes on this invoice */}
      {credits.length > 0 && (
        <>
          <h3>Credit Notes</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', background: '#eef1f4' }}>
                <th style={{ padding: '5px 8px' }}>Credit No</th>
                <th style={{ padding: '5px 8px' }}>Amount</th>
                <th style={{ padding: '5px 8px' }}>Status</th>
                <th style={{ padding: '5px 8px' }}>Issued</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>{c.creditNo}</td>
                  <td style={{ padding: '5px 8px', textAlign: 'right' }}>{money(c.amount)}</td>
                  <td style={{ padding: '5px 8px' }}><StatusBadge status={c.status} /></td>
                  <td style={{ padding: '5px 8px' }}>{c.issuedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {showCredit && (
        <CreditNoteModal
          invoice={inv}
          onClose={() => setShowCredit(false)}
          onCreated={(msg) => { setShowCredit(false); setNotice(msg); void load(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate invoice modal
// ---------------------------------------------------------------------------
function GenerateInvoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (msg: string) => void }) {
  const [contractId, setContractId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Default period = last full calendar month
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(); // m=0 is Jan
    const lastMonth = m === 0 ? 12 : m;
    const lastYear  = m === 0 ? y - 1 : y;
    const days = new Date(lastYear, lastMonth, 0).getDate();
    setPeriodStart(`${lastYear}-${String(lastMonth).padStart(2,'0')}-01`);
    setPeriodEnd(`${lastYear}-${String(lastMonth).padStart(2,'0')}-${days}`);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      const data = await api.post<{ invoice: { invoiceNo: string; total: string } }>(
        '/billing/invoices/generate',
        { contractId: Number(contractId), periodStart, periodEnd, taxRate: Number(taxRate), notes: notes || undefined },
      );
      onCreated(`Invoice ${data.invoice.invoiceNo} generated — total ${money(data.invoice.total)}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to generate'); }
    finally { setSaving(false); }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 420 }}>
        <h3 style={{ marginTop: 0 }}>Generate Invoice</h3>

        <label>Contract ID *<br />
          <input value={contractId} onChange={(e) => setContractId(e.target.value)} required style={{ width: '100%' }} placeholder='e.g. 2' />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <label>Period start *<br />
            <input type='date' value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required style={{ width: '100%' }} />
          </label>
          <label>Period end *<br />
            <input type='date' value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required style={{ width: '100%' }} />
          </label>
        </div>

        <label style={{ display: 'block', marginTop: 12 }}>Tax rate (%)<br />
          <input type='number' value={taxRate} onChange={(e) => setTaxRate(e.target.value)} min='0' max='100' step='0.01' style={{ width: '100%' }} />
        </label>

        <label style={{ display: 'block', marginTop: 12 }}>Notes<br />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: '100%' }} />
        </label>

        {err && <p style={{ color: 'red', margin: '8px 0 0' }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type='button' onClick={onClose}>Cancel</button>
          <button type='submit' className='btn-primary' disabled={saving}>{saving ? 'Generating…' : 'Generate'}</button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Credit note modal (BR-022)
// ---------------------------------------------------------------------------
function CreditNoteModal({ invoice, onClose, onCreated }: {
  invoice: Invoice;
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const remaining = (parseFloat(invoice.total) - parseFloat(invoice.amountCredited)).toFixed(2);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      const data = await api.post<{ creditNote: { creditNo: string } }>(
        '/billing/credit-notes',
        { invoiceId: invoice.id, amount: Number(amount), reason },
      );
      onCreated(`Credit note ${data.creditNote.creditNo} created`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setSaving(false); }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 380 }}>
        <h3 style={{ marginTop: 0 }}>Credit Note — {invoice.invoiceNo}</h3>
        <p style={{ color: '#666', fontSize: '0.875rem', margin: '0 0 12px' }}>
          Invoice total: <strong>{money(invoice.total)}</strong> · Max creditable: <strong>{money(remaining)}</strong>
        </p>

        <label>Amount (KES) *<br />
          <input type='number' value={amount} onChange={(e) => setAmount(e.target.value)}
            required min='0.01' max={remaining} step='0.01' style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>Reason *<br />
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={2} style={{ width: '100%' }} />
        </label>

        {err && <p style={{ color: 'red', margin: '8px 0 0' }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type='button' onClick={onClose}>Cancel</button>
          <button type='submit' className='btn-primary' disabled={saving}>{saving ? 'Creating…' : 'Create credit note'}</button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Credit notes list
// ---------------------------------------------------------------------------
function CreditNoteList() {
  const { can } = useAuth();
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const data = await api.get<{ creditNotes: CreditNote[] }>('/billing/credit-notes');
      setCredits(data.creditNotes);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function issue(id: number) {
    setBusy(true);
    try { await api.post(`/billing/credit-notes/${id}/issue`, {}); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {loading ? <p className='muted'>Loading…</p> : credits.length === 0 ? (
        <p className='muted'>No credit notes found.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              {['Credit No', 'Invoice', 'Customer', 'Amount', 'Status', 'Created', ''].map((h) => (
                <th key={h} style={{ padding: '6px 8px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {credits.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{c.creditNo}</td>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{c.invoiceNo}</td>
                <td style={{ padding: '6px 8px' }}>{c.customerName}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{money(c.amount)}</td>
                <td style={{ padding: '6px 8px' }}><StatusBadge status={c.status} /></td>
                <td style={{ padding: '6px 8px' }}>{c.createdAt?.slice(0, 10)}</td>
                <td style={{ padding: '6px 8px' }}>
                  {can(PERM.billingCredit) && c.status === 'DRAFT' && (
                    <button disabled={busy} onClick={() => void issue(c.id)} style={{ fontSize: '0.8rem' }}>Issue</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backdrop helper
// ---------------------------------------------------------------------------
function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}

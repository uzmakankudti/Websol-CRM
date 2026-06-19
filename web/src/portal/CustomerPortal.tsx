/**
 * Customer self-service portal — a stand-alone surface reached at `/portal`.
 *
 * Flow: enter email → enter the emailed 6-digit code → land on a read-only
 * dashboard showing ONLY this customer's contracts, printers and tickets.
 * There is no navigation to any staff screen, and the backend scopes every
 * response to the customer baked into the session token.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  portalApi,
  PortalApiError,
  getPortalToken,
  setPortalToken,
  clearPortalToken,
  type PortalCustomer,
  type PortalContract,
  type PortalPrinter,
  type PortalTicket,
} from './portalClient';

export default function CustomerPortal() {
  const [authed, setAuthed] = useState<boolean>(() => !!getPortalToken());

  if (!authed) {
    return <PortalLogin onLoggedIn={() => setAuthed(true)} />;
  }
  return <PortalDashboard onSignOut={() => { clearPortalToken(); setAuthed(false); }} />;
}

// ---------------------------------------------------------------------------
// Login: request code → verify code
// ---------------------------------------------------------------------------

function PortalLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await portalApi.post<{ message: string }>('/portal/request-otp', { email });
      setNotice(res.message);
      setStep('code');
    } catch (e) {
      setErr(e instanceof PortalApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await portalApi.post<{ token: string }>('/portal/verify-otp', { email, code });
      setPortalToken(res.token);
      onLoggedIn();
    } catch (e) {
      setErr(e instanceof PortalApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={wrapStyle}>
      <div style={cardStyle}>
        <h1 style={{ margin: '0 0 4px' }}>Customer Portal</h1>
        <p className="muted" style={{ marginTop: 0 }}>Websol Managed Print Services</p>

        {step === 'email' && (
          <form onSubmit={(e) => void requestCode(e)}>
            <label>Email address<br />
              <input
                type="email" value={email} required autoFocus
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle} placeholder="you@company.com"
              />
            </label>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              We'll email you a one-time login code. No password needed.
            </p>
            {err && <p style={errStyle}>{err}</p>}
            <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send login code'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={(e) => void verifyCode(e)}>
            {notice && <p style={noticeStyle}>{notice}</p>}
            <label>6-digit code<br />
              <input
                value={code} required autoFocus inputMode="numeric"
                pattern="[0-9]*" maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                style={{ ...inputStyle, letterSpacing: '0.4em', fontSize: '1.3rem', textAlign: 'center' }}
                placeholder="••••••"
              />
            </label>
            {err && <p style={errStyle}>{err}</p>}
            <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setErr(''); setNotice(''); }}
              style={{ width: '100%', marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#2980b9' }}
            >
              ← Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

type Tab = 'contracts' | 'printers' | 'tickets';

function PortalDashboard({ onSignOut }: { onSignOut: () => void }) {
  const [customer, setCustomer] = useState<PortalCustomer | null>(null);
  const [tab, setTab] = useState<Tab>('contracts');
  const [contracts, setContracts] = useState<PortalContract[]>([]);
  const [printers, setPrinters] = useState<PortalPrinter[]>([]);
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [me, c, p, t] = await Promise.all([
        portalApi.get<{ customer: PortalCustomer }>('/portal/me'),
        portalApi.get<{ contracts: PortalContract[] }>('/portal/contracts'),
        portalApi.get<{ printers: PortalPrinter[] }>('/portal/printers'),
        portalApi.get<{ tickets: PortalTicket[] }>('/portal/tickets'),
      ]);
      setCustomer(me.customer);
      setContracts(c.contracts);
      setPrinters(p.printers);
      setTickets(t.tickets);
    } catch (e) {
      if (e instanceof PortalApiError && e.status === 401) {
        onSignOut();
        return;
      }
      setErr(e instanceof PortalApiError ? e.message : 'Failed to load your data');
    } finally {
      setLoading(false);
    }
  }, [onSignOut]);

  useEffect(() => { void load(); }, [load]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'contracts', label: 'Contracts', count: contracts.length },
    { key: 'printers', label: 'Printers', count: printers.length },
    { key: 'tickets', label: 'Service Tickets', count: tickets.length },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f8' }}>
      <header style={{ background: '#1f2d3d', color: '#fff', padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>Websol Customer Portal</strong>
          {customer && <span style={{ marginLeft: 12, opacity: 0.8 }}>{customer.name}</span>}
        </div>
        <button onClick={onSignOut} style={{ background: 'none', border: '1px solid #ffffff55', color: '#fff', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}>
          Sign out
        </button>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid #ddd' }}>
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px',
                borderBottom: tab === tb.key ? '2px solid #2980b9' : '2px solid transparent',
                fontWeight: tab === tb.key ? 600 : 400,
              }}
            >
              {tb.label} ({tb.count})
            </button>
          ))}
        </div>

        {err && <p style={errStyle}>{err}</p>}
        {loading ? <p className="muted">Loading…</p> : (
          <>
            {tab === 'contracts' && <ContractsTable rows={contracts} />}
            {tab === 'printers' && <PrintersTable rows={printers} />}
            {tab === 'tickets' && <TicketsTable rows={tickets} />}
          </>
        )}
      </main>
    </div>
  );
}

function ContractsTable({ rows }: { rows: PortalContract[] }) {
  if (rows.length === 0) return <p className="muted">No contracts on file.</p>;
  return (
    <Table head={['Contract', 'Start', 'End', 'Monthly fee', 'SLA tier', 'Status']}>
      {rows.map((r) => (
        <tr key={r.id} style={trStyle}>
          <td style={tdStyle}><code>{r.contractNo}</code></td>
          <td style={tdStyle}>{r.startDate}</td>
          <td style={tdStyle}>{r.endDate}</td>
          <td style={tdStyle}>{r.monthlyLeaseFee}</td>
          <td style={tdStyle}>{r.slaTier}</td>
          <td style={tdStyle}>{r.status}</td>
        </tr>
      ))}
    </Table>
  );
}

function PrintersTable({ rows }: { rows: PortalPrinter[] }) {
  if (rows.length === 0) return <p className="muted">No printers assigned.</p>;
  return (
    <Table head={['Serial', 'Brand', 'Model', 'Location', 'Contract', 'Status']}>
      {rows.map((r) => (
        <tr key={r.id} style={trStyle}>
          <td style={tdStyle}><code>{r.serialNo}</code></td>
          <td style={tdStyle}>{r.brand}</td>
          <td style={tdStyle}>{r.model}</td>
          <td style={tdStyle}>{r.location ?? '—'}</td>
          <td style={tdStyle}><code>{r.contractNo}</code></td>
          <td style={tdStyle}>{r.status.replace(/_/g, ' ')}</td>
        </tr>
      ))}
    </Table>
  );
}

function TicketsTable({ rows }: { rows: PortalTicket[] }) {
  if (rows.length === 0) return <p className="muted">No service tickets.</p>;
  return (
    <Table head={['Ticket', 'Type', 'Priority', 'Status', 'Logged', 'SLA due']}>
      {rows.map((r) => (
        <tr key={r.id} style={trStyle}>
          <td style={tdStyle}><code>{r.ticketNo}</code></td>
          <td style={tdStyle}>{r.visitType.replace(/_/g, ' ')}</td>
          <td style={tdStyle}>{r.priority}</td>
          <td style={tdStyle}>{r.status.replace(/_/g, ' ')}</td>
          <td style={tdStyle}>{r.createdAt?.slice(0, 10) ?? '—'}</td>
          <td style={tdStyle}>{r.slaDueAt ?? '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', background: '#fff', borderRadius: 6, overflow: 'hidden' }}>
      <thead>
        <tr style={{ textAlign: 'left', background: '#eef1f4' }}>
          {head.map((h) => <th key={h} style={{ padding: '8px 10px' }}>{h}</th>)}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (the portal is intentionally self-contained)
// ---------------------------------------------------------------------------

const wrapStyle: React.CSSProperties = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f8',
};
const cardStyle: React.CSSProperties = {
  background: '#fff', padding: 32, borderRadius: 8, width: 360, boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
};
const inputStyle: React.CSSProperties = { width: '100%', padding: '8px', margin: '4px 0 12px', boxSizing: 'border-box' };
const errStyle: React.CSSProperties = { color: '#c0392b', margin: '8px 0' };
const noticeStyle: React.CSSProperties = { background: '#eafaf1', border: '1px solid #27ae60', borderRadius: 4, padding: '8px', fontSize: '0.85rem' };
const trStyle: React.CSSProperties = { borderTop: '1px solid #eee' };
const tdStyle: React.CSSProperties = { padding: '8px 10px' };

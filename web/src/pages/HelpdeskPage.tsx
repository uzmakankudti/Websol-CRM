/**
 * Helpdesk — Service Ticket Management (Module 8).
 *
 * Displays the ticket queue with live SLA countdown timers, a create-ticket
 * form (source, category, auto-assign), SLA alert banner, and per-ticket
 * resolve / reopen / close actions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, type IssueCategory, type ServiceTicket, type SlaAlert, type TicketPriority, type TicketSource } from '../types';

// ---------------------------------------------------------------------------
// SLA countdown helper
// ---------------------------------------------------------------------------

function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

function slaInfo(ticket: ServiceTicket): { label: string; color: string } {
  if (!ticket.slaDueAt || ['CLOSED', 'RESOLVED', 'CANCELLED'].includes(ticket.status)) {
    return { label: '—', color: 'var(--color-muted, #888)' };
  }
  const msLeft = new Date(ticket.slaDueAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
  if (msLeft < 0) {
    const hOver = Math.ceil(-msLeft / 3_600_000);
    return { label: `Breached ${hOver}h ago`, color: '#c0392b' };
  }
  if (msLeft < 3_600_000) {
    const mLeft = Math.floor(msLeft / 60_000);
    return { label: `${mLeft}m left`, color: '#e67e22' };
  }
  const hLeft = Math.floor(msLeft / 3_600_000);
  return { label: `${hLeft}h left`, color: '#27ae60' };
}

// ---------------------------------------------------------------------------
// Source and priority badge colours
// ---------------------------------------------------------------------------

const SOURCE_COLORS: Record<string, string> = {
  PHONE: '#2980b9', PORTAL: '#8e44ad', EMAIL: '#16a085',
};
const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: '#c0392b', HIGH: '#e74c3c', MEDIUM: '#e67e22', LOW: '#27ae60',
};

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: '0.75rem', fontWeight: 600, color: '#fff', background: color,
    }}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HelpdeskPage() {
  useTick();
  const { can } = useAuth();
  const [tickets, setTickets] = useState<ServiceTicket[]>([]);
  const [alerts, setAlerts] = useState<SlaAlert[]>([]);
  const [categories, setCategories] = useState<IssueCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ServiceTicket | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      const [ticketData, alertData, catData] = await Promise.all([
        api.get<{ tickets: ServiceTicket[] }>(`/service-tickets?${params.toString()}`),
        can(PERM.serviceRead) ? api.get<{ alerts: SlaAlert[] }>('/helpdesk/sla-alerts?alertType=BREACH') : Promise.resolve({ alerts: [] }),
        api.get<{ categories: IssueCategory[] }>('/helpdesk/categories'),
      ]);
      setTickets(ticketData.tickets);
      setAlerts(alertData.alerts);
      setCategories(catData.categories);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load helpdesk data');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, sourceFilter, can]);

  useEffect(() => { void load(); }, [load]);

  function afterAction(msg: string) {
    setSelected(null);
    setNotice(msg);
    void load();
  }

  if (selected) {
    return (
      <TicketDetailPane
        ticket={selected}
        onBack={() => setSelected(null)}
        onAction={afterAction}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Helpdesk</h2>
        {can(PERM.serviceCreate) && (
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New Ticket</button>
        )}
      </div>

      {/* SLA breach banner */}
      {alerts.length > 0 && (
        <div style={{ background: '#fdf2f2', border: '1px solid #e74c3c', borderRadius: 6, padding: '10px 16px', marginBottom: 16 }}>
          <strong style={{ color: '#c0392b' }}>⚠ {alerts.length} SLA breach{alerts.length > 1 ? 'es' : ''} —</strong>
          {' '}{alerts.map((a) => a.ticketNo).join(', ')}
        </div>
      )}

      {notice && (
        <div style={{ background: '#eafaf1', border: '1px solid #27ae60', borderRadius: 6, padding: '8px 16px', marginBottom: 12 }}>
          {notice}
          <button style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setNotice('')}>✕</button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '4px 8px' }}>
          <option value=''>All statuses</option>
          {['OPEN','ASSIGNED','IN_TRANSIT','ON_SITE','IN_PROGRESS','RESOLVED','CLOSED','ESCALATED','CANCELLED'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={{ padding: '4px 8px' }}>
          <option value=''>All sources</option>
          <option value='PHONE'>Phone</option>
          <option value='PORTAL'>Portal</option>
          <option value='EMAIL'>Email</option>
        </select>
      </div>

      {err && <p style={{ color: 'red' }}>{err}</p>}
      {loading ? <p className="muted">Loading…</p> : (
        tickets.length === 0 ? <p className="muted">No tickets found.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '6px 8px' }}>Ticket</th>
                <th style={{ padding: '6px 8px' }}>Customer</th>
                <th style={{ padding: '6px 8px' }}>Category</th>
                <th style={{ padding: '6px 8px' }}>Priority</th>
                <th style={{ padding: '6px 8px' }}>Source</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>SLA</th>
                <th style={{ padding: '6px 8px' }}>Tier</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const sla = slaInfo(t);
                return (
                  <tr
                    key={t.id}
                    style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    onClick={() => setSelected(t)}
                  >
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{t.ticketNo}</td>
                    <td style={{ padding: '6px 8px' }}>{t.customer.name}</td>
                    <td style={{ padding: '6px 8px' }}>{t.issueCategory?.name ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <Badge text={t.priority} color={PRIORITY_COLORS[t.priority] ?? '#555'} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <Badge text={t.source} color={SOURCE_COLORS[t.source] ?? '#555'} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>{t.status.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600, color: sla.color }}>{sla.label}</td>
                    <td style={{ padding: '6px 8px' }}>{t.slaTier ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}

      {creating && (
        <NewTicketModal
          categories={categories}
          onClose={() => setCreating(false)}
          onCreated={(msg) => { setCreating(false); setNotice(msg); void load(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New ticket form modal
// ---------------------------------------------------------------------------

function NewTicketModal({
  categories, onClose, onCreated,
}: {
  categories: IssueCategory[];
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [contractId, setContractId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [visitType, setVisitType] = useState('CORRECTIVE');
  const [priority, setPriority] = useState<TicketPriority>('HIGH');
  const [source, setSource] = useState<TicketSource>('PHONE');
  const [categoryId, setCategoryId] = useState('');
  const [autoAssign, setAutoAssign] = useState(false);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const body: Record<string, unknown> = {
        visitType, priority, source, customerId: Number(customerId),
        description: description || undefined,
        autoAssign,
      };
      if (contractId) body.contractId = Number(contractId);
      if (siteId) body.siteId = Number(siteId);
      if (categoryId) body.issueCategoryId = Number(categoryId);
      const data = await api.post<{ ticket: ServiceTicket }>('/service-tickets', body);
      onCreated(`Ticket ${data.ticket.ticketNo} created`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create ticket');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 420, maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>New Service Ticket</h3>

        <label>Customer ID *<br />
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} required style={{ width: '100%' }} />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <label>Contract ID<br />
            <input value={contractId} onChange={(e) => setContractId(e.target.value)} style={{ width: '100%' }} placeholder='optional' />
          </label>
          <label>Site ID<br />
            <input value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: '100%' }} placeholder='optional' />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <label>Visit type<br />
            <select value={visitType} onChange={(e) => setVisitType(e.target.value)} style={{ width: '100%' }}>
              {['CORRECTIVE','PREVENTIVE_MAINTENANCE','INSTALLATION','METER_READING','TONER_REPLACEMENT','COLLECTION'].map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <label>Priority<br />
            <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} style={{ width: '100%' }}>
              {(['CRITICAL','HIGH','MEDIUM','LOW'] as TicketPriority[]).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <label>Source<br />
            <select value={source} onChange={(e) => setSource(e.target.value as TicketSource)} style={{ width: '100%' }}>
              <option value='PHONE'>Phone</option>
              <option value='PORTAL'>Portal</option>
              <option value='EMAIL'>Email</option>
            </select>
          </label>
          <label>Issue category<br />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ width: '100%' }}>
              <option value=''>— none —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input type='checkbox' checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
          Auto-assign technician by region
        </label>

        <label style={{ display: 'block', marginTop: 12 }}>Description<br />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
        </label>

        {err && <p style={{ color: 'red', margin: '8px 0 0' }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type='button' onClick={onClose}>Cancel</button>
          <button type='submit' className='btn-primary' disabled={saving}>{saving ? 'Creating…' : 'Create ticket'}</button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Ticket detail pane — resolve / reopen / close actions
// ---------------------------------------------------------------------------

function TicketDetailPane({
  ticket: initial, onBack, onAction,
}: {
  ticket: ServiceTicket;
  onBack: () => void;
  onAction: (msg: string) => void;
}) {
  const { can } = useAuth();
  const [ticket] = useState(initial);
  const [err, setErr] = useState('');
  const [resolveNotes, setResolveNotes] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [showReopen, setShowReopen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doAction(url: string, body: unknown, successMsg: string) {
    setBusy(true);
    setErr('');
    try {
      await api.post(url, body);
      onAction(successMsg);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const sla = slaInfo(ticket);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: '#2980b9' }}>← Back to list</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h2 style={{ margin: 0 }}>{ticket.ticketNo}</h2>
        <span style={{ fontWeight: 600, color: sla.color, fontSize: '1rem' }}>{sla.label}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', margin: '16px 0', fontSize: '0.9rem' }}>
        <Row label='Status'>{ticket.status.replace(/_/g, ' ')}</Row>
        <Row label='Priority'><Badge text={ticket.priority} color={PRIORITY_COLORS[ticket.priority] ?? '#555'} /></Row>
        <Row label='Source'><Badge text={ticket.source} color={SOURCE_COLORS[ticket.source] ?? '#555'} /></Row>
        <Row label='SLA tier'>{ticket.slaTier ?? '—'}</Row>
        <Row label='Customer'>{ticket.customer.name}</Row>
        <Row label='Category'>{ticket.issueCategory?.name ?? '—'}</Row>
        <Row label='Assigned to'>{ticket.assignedTo?.fullName ?? '—'}</Row>
        <Row label='SLA due'>{ticket.slaDueAt ?? '—'}</Row>
        {ticket.resolutionNotes && <Row label='Resolution'>{ticket.resolutionNotes}</Row>}
        {ticket.escalationReason && <Row label='Escalation'>{ticket.escalationReason}</Row>}
      </div>

      {err && <p style={{ color: 'red' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {can(PERM.serviceResolve) && ['IN_PROGRESS','ON_SITE','ESCALATED'].includes(ticket.status) && (
          <button className='btn-primary' onClick={() => setShowResolve(true)}>Resolve</button>
        )}
        {can(PERM.serviceReopen) && ticket.status === 'RESOLVED' && (
          <button onClick={() => setShowReopen(true)}>Reopen (BR-015)</button>
        )}
        {can(PERM.serviceClose) && ['IN_PROGRESS','ON_SITE','RESOLVED'].includes(ticket.status) && (
          <button onClick={() => setShowClose(true)}>Close</button>
        )}
      </div>

      {showResolve && (
        <Backdrop onClose={() => setShowResolve(false)}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 380 }}>
            <h3 style={{ marginTop: 0 }}>Resolve ticket</h3>
            <label>Resolution notes *<br />
              <textarea value={resolveNotes} onChange={(e) => setResolveNotes(e.target.value)} rows={4} style={{ width: '100%' }} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setShowResolve(false)}>Cancel</button>
              <button className='btn-primary' disabled={busy || !resolveNotes.trim()} onClick={() => void doAction(
                `/service-tickets/${ticket.id}/resolve`,
                { resolutionNotes: resolveNotes },
                `Ticket ${ticket.ticketNo} resolved`,
              )}>
                {busy ? 'Saving…' : 'Mark resolved'}
              </button>
            </div>
          </div>
        </Backdrop>
      )}

      {showReopen && (
        <Backdrop onClose={() => setShowReopen(false)}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 340 }}>
            <h3 style={{ marginTop: 0 }}>Reopen ticket?</h3>
            <p>This is only allowed within <strong>48 hours</strong> of resolution (BR-015). After that, a new ticket must be raised.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowReopen(false)}>Cancel</button>
              <button className='btn-primary' disabled={busy} onClick={() => void doAction(
                `/service-tickets/${ticket.id}/reopen`, {}, `Ticket ${ticket.ticketNo} reopened`,
              )}>
                {busy ? 'Saving…' : 'Reopen'}
              </button>
            </div>
          </div>
        </Backdrop>
      )}

      {showClose && (
        <CloseModal
          ticketId={ticket.id}
          ticketNo={ticket.ticketNo}
          onClose={() => setShowClose(false)}
          onClosed={(msg) => onAction(msg)}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span style={{ color: '#888', fontSize: '0.8rem' }}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Close modal (BR-014: requires resolutionNotes + SIGNATURE or OTP)
// ---------------------------------------------------------------------------

function CloseModal({
  ticketId, ticketNo, onClose, onClosed,
}: {
  ticketId: number; ticketNo: string; onClose: () => void; onClosed: (msg: string) => void;
}) {
  const [method, setMethod] = useState<'OTP' | 'SIGNATURE'>('OTP');
  const [otp, setOtp] = useState('');
  const [sigName, setSigName] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const body: Record<string, unknown> = { method, resolutionNotes: notes };
      if (method === 'OTP') body.otp = otp;
      else body.signatureName = sigName;
      await api.post(`/service-tickets/${ticketId}/close`, body);
      onClosed(`Ticket ${ticketNo} closed`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Close failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 380 }}>
        <h3 style={{ marginTop: 0 }}>Close ticket — {ticketNo}</h3>

        <label style={{ display: 'block', marginBottom: 8 }}>Resolution notes * (BR-014)<br />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} required style={{ width: '100%' }} />
        </label>

        <fieldset style={{ border: '1px solid #ddd', borderRadius: 4, padding: '8px 12px' }}>
          <legend>Customer confirmation</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <input type='radio' checked={method === 'OTP'} onChange={() => setMethod('OTP')} />OTP
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type='radio' checked={method === 'SIGNATURE'} onChange={() => setMethod('SIGNATURE')} />Digital signature
          </label>
          {method === 'OTP' && (
            <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder='4-8 digit OTP'
              style={{ marginTop: 8, width: '100%' }} required />
          )}
          {method === 'SIGNATURE' && (
            <input value={sigName} onChange={(e) => setSigName(e.target.value)} placeholder='Customer full name'
              style={{ marginTop: 8, width: '100%' }} required />
          )}
        </fieldset>

        {err && <p style={{ color: 'red', margin: '8px 0 0' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type='button' onClick={onClose}>Cancel</button>
          <button type='submit' className='btn-primary' disabled={saving}>{saving ? 'Closing…' : 'Close ticket'}</button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Backdrop helper
// ---------------------------------------------------------------------------

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {children}
    </div>
  );
}

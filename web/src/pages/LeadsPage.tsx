/**
 * Lead & Opportunity Management screen.
 *
 * Top-level view: paginated lead list with pipeline stage counts and filters.
 * Drill-down view (selectedLeadId): full lead detail — stage pipeline, info,
 * quotations, stage history — with all write actions.
 *
 * Every write action is gated by `can(PERM.*)` on the frontend and re-enforced
 * by the backend. BR-024 (no conversion without an approved quotation) is
 * enforced by the API; the frontend also checks and surfaces a helpful message.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import {
  PERM,
  type Lead,
  type LeadDetail,
  type LeadSource,
  type LeadStage,
  type Quotation,
  type QuotationPrinter,
  type User,
} from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGES: LeadStage[] = ['NEW', 'CONTACTED', 'PROPOSAL_SENT', 'WON', 'LOST'];

const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  PROPOSAL_SENT: 'Proposal Sent',
  WON: 'Won',
  LOST: 'Lost',
};

const SOURCE_LABEL: Record<LeadSource, string> = {
  REFERRAL: 'Referral',
  WEBSITE: 'Website',
  COLD_CALL: 'Cold Call',
  EXHIBITION: 'Exhibition',
  OTHER: 'Other',
};

const VALID_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['PROPOSAL_SENT', 'LOST'],
  PROPOSAL_SENT: ['WON', 'LOST'],
  WON: [],
  LOST: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

function fmtRate(n: number): string {
  return `R ${n.toFixed(5)}`;
}

function stageBadgeClass(stage: LeadStage): string {
  if (stage === 'WON') return 'badge badge-active';
  if (stage === 'LOST') return 'badge badge-inactive';
  return 'badge badge-pending';
}

function quotationStatusBadgeClass(status: string): string {
  if (status === 'APPROVED') return 'badge badge-active';
  if (status === 'REJECTED') return 'badge badge-inactive';
  if (status === 'PENDING_APPROVAL') return 'badge badge-warning';
  return 'badge';
}

// ---------------------------------------------------------------------------
// Modal union type
// ---------------------------------------------------------------------------

type Modal =
  | { kind: 'create-lead' }
  | { kind: 'edit-lead'; lead: Lead }
  | { kind: 'change-stage'; lead: Lead }
  | { kind: 'create-quotation'; lead: Lead; users: User[] }
  | { kind: 'approve-quotation'; lead: Lead; quotation: Quotation }
  | { kind: 'convert'; lead: Lead }
  | null;

// ---------------------------------------------------------------------------
// LeadsPage — top-level list
// ---------------------------------------------------------------------------

export default function LeadsPage() {
  const { can } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [users, setUsers] = useState<User[]>([]);

  // Filters
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (stageFilter) params.set('stage', stageFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      const data = await api.get<{ leads: Lead[] }>(`/leads?${params.toString()}`);
      setLeads(data.leads);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, [q, stageFilter, sourceFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load users for assignment dropdown (best-effort).
  useEffect(() => {
    if (can(PERM.usersRead)) {
      api
        .get<{ users: User[] }>('/users?active=true')
        .then((d) => setUsers(d.users))
        .catch(() => undefined);
    }
  }, [can]);

  function afterChange(message?: string) {
    setModal(null);
    if (message) setNotice(message);
    void load();
  }

  // Stage counts for pipeline header.
  const stageCounts = STAGES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = leads.filter((l) => l.stage === s).length;
    return acc;
  }, {});

  if (selectedLeadId != null) {
    return (
      <LeadDetailView
        leadId={selectedLeadId}
        users={users}
        onBack={() => {
          setSelectedLeadId(null);
          void load();
        }}
      />
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Leads &amp; Pipeline</h2>
        {can(PERM.leadsCreate) && (
          <button className="btn" onClick={() => setModal({ kind: 'create-lead' })}>
            + New lead
          </button>
        )}
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}
      {err && <div className="alert alert-error">{err}</div>}

      {/* Pipeline stage counters */}
      <div className="pipeline-bar">
        {STAGES.map((s) => (
          <button
            key={s}
            className={`pipeline-stage ${stageFilter === s ? 'active' : ''}`}
            onClick={() => setStageFilter(stageFilter === s ? '' : s)}
          >
            <span className="pipeline-stage-label">{STAGE_LABEL[s]}</span>
            <span className="pipeline-stage-count">{stageCounts[s]}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          placeholder="Search company or contact…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          <option value="">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          {(Object.keys(SOURCE_LABEL) as LeadSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Contact</th>
              <th>Source</th>
              <th>Printers</th>
              <th>Stage</th>
              <th>Assigned to</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No leads match the current filters.
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <button
                    className="link-btn"
                    onClick={() => setSelectedLeadId(lead.id)}
                    title="View lead detail"
                  >
                    {lead.companyName}
                  </button>
                  {lead.convertedCustomerId && (
                    <div className="muted" style={{ fontSize: '0.75rem' }}>
                      converted
                    </div>
                  )}
                </td>
                <td>
                  {lead.contactName}
                  {lead.contactEmail && <div className="muted">{lead.contactEmail}</div>}
                </td>
                <td>{SOURCE_LABEL[lead.source]}</td>
                <td>{lead.expectedPrinters}</td>
                <td>
                  <span className={stageBadgeClass(lead.stage)}>{STAGE_LABEL[lead.stage]}</span>
                </td>
                <td className="muted">{lead.assignedTo?.fullName ?? '—'}</td>
                <td className="muted">{fmt(lead.updatedAt)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setSelectedLeadId(lead.id)}
                    >
                      View
                    </button>
                    {can(PERM.leadsUpdate) && lead.stage !== 'WON' && lead.stage !== 'LOST' && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setModal({ kind: 'edit-lead', lead })}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal?.kind === 'create-lead' && (
        <LeadFormModal
          users={users}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Lead created.')}
        />
      )}
      {modal?.kind === 'edit-lead' && (
        <LeadFormModal
          existing={modal.lead}
          users={users}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Lead updated.')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead detail view
// ---------------------------------------------------------------------------

function LeadDetailView({
  leadId,
  users,
  onBack,
}: {
  leadId: number;
  users: User[];
  onBack: () => void;
}) {
  const { can } = useAuth();
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.get<LeadDetail>(`/leads/${leadId}`);
      setDetail(data);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load lead');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange(message?: string) {
    setModal(null);
    if (message) setNotice(message);
    void load();
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (err) return <div className="alert alert-error">{err}</div>;
  if (!detail) return null;

  const { lead, quotations, stageHistory } = detail;
  const hasApprovedQuotation = quotations.some((q) => q.status === 'APPROVED');
  const isTerminal = lead.stage === 'WON' || lead.stage === 'LOST';

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            ← Back
          </button>
          <h2 style={{ margin: 0 }}>{lead.companyName}</h2>
          <span className={stageBadgeClass(lead.stage)}>{STAGE_LABEL[lead.stage]}</span>
        </div>
        <div className="row-actions">
          {can(PERM.leadsUpdate) && !isTerminal && (
            <button
              className="btn btn-secondary"
              onClick={() => setModal({ kind: 'edit-lead', lead })}
            >
              Edit
            </button>
          )}
          {can(PERM.leadsChangeStage) && !isTerminal && (
            <button
              className="btn btn-secondary"
              onClick={() => setModal({ kind: 'change-stage', lead })}
            >
              Change stage
            </button>
          )}
          {can(PERM.quotationsCreate) && !isTerminal && (
            <button
              className="btn"
              onClick={() => setModal({ kind: 'create-quotation', lead, users })}
            >
              + Quotation
            </button>
          )}
          {can(PERM.leadsConvert) &&
            lead.stage === 'WON' &&
            lead.convertedCustomerId == null && (
              <button
                className={`btn ${hasApprovedQuotation ? '' : 'btn-secondary'}`}
                title={
                  hasApprovedQuotation
                    ? 'Convert to customer'
                    : 'Requires an approved quotation (BR-024)'
                }
                onClick={() => setModal({ kind: 'convert', lead })}
              >
                Convert to customer
              </button>
            )}
        </div>
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}

      {lead.convertedCustomerId != null && (
        <div className="alert alert-info">
          Converted to Customer #{lead.convertedCustomerId} on {fmt(lead.convertedAt)}.
        </div>
      )}

      {/* Stage pipeline breadcrumb */}
      <div className="stage-pipeline">
        {STAGES.filter((s) => s !== 'LOST').map((s) => {
          const current = lead.stage === s;
          const won = lead.stage === 'WON';
          const leadStageIndex = STAGES.indexOf(lead.stage === 'LOST' ? 'LOST' : lead.stage);
          const completed = STAGES.indexOf(s) < leadStageIndex;
          return (
            <div
              key={s}
              className={`stage-step ${current ? 'current' : ''} ${completed ? 'done' : ''} ${won && s === 'WON' ? 'won' : ''}`}
            >
              {STAGE_LABEL[s]}
            </div>
          );
        })}
        {lead.stage === 'LOST' && (
          <div className="stage-step current lost">Lost</div>
        )}
      </div>

      <div className="detail-grid">
        {/* Lead info */}
        <section className="detail-card">
          <h3>Lead info</h3>
          <dl className="detail-list">
            <dt>Company</dt>
            <dd>{lead.companyName}</dd>
            <dt>Contact</dt>
            <dd>{lead.contactName}</dd>
            <dt>Email</dt>
            <dd>{lead.contactEmail ?? '—'}</dd>
            <dt>Phone</dt>
            <dd>{lead.contactPhone ?? '—'}</dd>
            <dt>Source</dt>
            <dd>{SOURCE_LABEL[lead.source]}</dd>
            <dt>Expected printers</dt>
            <dd>{lead.expectedPrinters}</dd>
            <dt>Assigned to</dt>
            <dd>{lead.assignedTo?.fullName ?? '—'}</dd>
            {lead.lostReason && (
              <>
                <dt>Lost reason</dt>
                <dd>{lead.lostReason}</dd>
              </>
            )}
            <dt>Created by</dt>
            <dd>{lead.createdBy.fullName}</dd>
            <dt>Created</dt>
            <dd>{fmt(lead.createdAt)}</dd>
          </dl>
        </section>

        {/* Quotations */}
        <section className="detail-card">
          <h3>Quotations</h3>
          {quotations.length === 0 ? (
            <p className="muted">No quotations yet.</p>
          ) : (
            quotations.map((q) => (
              <div key={q.id} className="quotation-card">
                <div className="quotation-header">
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    #{q.id} · {fmt(q.createdAt)} · by {q.createdBy.fullName}
                  </span>
                  <span className={quotationStatusBadgeClass(q.status)}>{q.status.replace('_', ' ')}</span>
                </div>

                {q.status === 'PENDING_APPROVAL' && can(PERM.quotationsApprove) && (
                  <div style={{ marginBottom: '0.5rem' }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => setModal({ kind: 'approve-quotation', lead, quotation: q })}
                    >
                      Review
                    </button>
                  </div>
                )}

                <dl className="detail-list compact">
                  <dt>Monthly lease</dt>
                  <dd>{fmtMoney(q.monthlyLeaseFee)}</dd>
                  <dt>B/W per page</dt>
                  <dd>{fmtRate(q.perPageBw)}</dd>
                  <dt>Colour per page</dt>
                  <dd>{fmtRate(q.perPageColour)}</dd>
                  <dt>Discount</dt>
                  <dd>{q.discountPct}%</dd>
                </dl>

                {q.printers.length > 0 && (
                  <table style={{ marginTop: '0.5rem', width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Printer model</th>
                        <th>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.printers.map((p) => (
                        <tr key={p.id}>
                          <td>{p.printerModel}</td>
                          <td>{p.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {q.approvedBy && (
                  <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                    {q.status === 'APPROVED' ? 'Approved' : 'Reviewed'} by {q.approvedBy.fullName}{' '}
                    on {fmt(q.approvedAt)}
                    {q.approvalNote ? ` — "${q.approvalNote}"` : ''}
                  </p>
                )}

                {q.notes && (
                  <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
                    {q.notes}
                  </p>
                )}
              </div>
            ))
          )}
        </section>

        {/* Stage history */}
        <section className="detail-card">
          <h3>Stage history</h3>
          {stageHistory.length === 0 ? (
            <p className="muted">No history yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Note</th>
                  <th>By</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {stageHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="muted">{h.fromStage ? STAGE_LABEL[h.fromStage] : '—'}</td>
                    <td>{STAGE_LABEL[h.toStage]}</td>
                    <td className="muted">{h.note ?? '—'}</td>
                    <td className="muted">{h.changedBy.fullName}</td>
                    <td className="muted">{fmt(h.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {modal?.kind === 'edit-lead' && (
        <LeadFormModal
          existing={modal.lead}
          users={users}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Lead updated.')}
        />
      )}
      {modal?.kind === 'change-stage' && (
        <ChangeStageModal
          lead={modal.lead}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Stage updated.')}
        />
      )}
      {modal?.kind === 'create-quotation' && (
        <QuotationFormModal
          lead={modal.lead}
          onClose={() => setModal(null)}
          onSaved={(msg) => afterChange(msg)}
        />
      )}
      {modal?.kind === 'approve-quotation' && (
        <ApproveQuotationModal
          lead={modal.lead}
          quotation={modal.quotation}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Quotation updated.')}
        />
      )}
      {modal?.kind === 'convert' && (
        <ConvertModal
          lead={modal.lead}
          hasApprovedQuotation={hasApprovedQuotation}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Lead converted to customer.')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit lead modal
// ---------------------------------------------------------------------------

function LeadFormModal({
  existing,
  users,
  onClose,
  onSaved,
}: {
  existing?: Lead;
  users: User[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [companyName, setCompanyName] = useState(existing?.companyName ?? '');
  const [contactName, setContactName] = useState(existing?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(existing?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(existing?.contactPhone ?? '');
  const [source, setSource] = useState<LeadSource>(existing?.source ?? 'OTHER');
  const [expectedPrinters, setExpectedPrinters] = useState(
    String(existing?.expectedPrinters ?? 1),
  );
  const [assignedTo, setAssignedTo] = useState<string>(
    existing?.assignedTo ? String(existing.assignedTo.id) : '',
  );
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    const printers = parseInt(expectedPrinters, 10);
    if (!printers || printers < 1) {
      setFormErr('Expected printers must be a positive number');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        companyName: companyName.trim(),
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        source,
        expectedPrinters: printers,
        assignedTo: assignedTo ? Number(assignedTo) : null,
      };
      if (existing) {
        await api.patch(`/leads/${existing.id}`, payload);
      } else {
        await api.post('/leads', payload);
      }
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>{existing ? 'Edit lead' : 'New lead'}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="cn">Company name</label>
        <input
          id="cn"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          required
        />
        <label htmlFor="ct">Contact name</label>
        <input
          id="ct"
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          required
        />
        <label htmlFor="ce">Contact email</label>
        <input
          id="ce"
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />
        <label htmlFor="cp">Contact phone</label>
        <input id="cp" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        <label htmlFor="src">Source</label>
        <select
          id="src"
          value={source}
          onChange={(e) => setSource(e.target.value as LeadSource)}
        >
          {(Object.keys(SOURCE_LABEL) as LeadSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <label htmlFor="ep">Expected printers</label>
        <input
          id="ep"
          type="number"
          min={1}
          value={expectedPrinters}
          onChange={(e) => setExpectedPrinters(e.target.value)}
          required
        />
        {users.length > 0 && (
          <>
            <label htmlFor="at">Assigned to</label>
            <select id="at" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.role.name})
                </option>
              ))}
            </select>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create lead'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Change stage modal
// ---------------------------------------------------------------------------

function ChangeStageModal({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead;
  onClose: () => void;
  onSaved: () => void;
}) {
  const allowed = VALID_TRANSITIONS[lead.stage];
  const [stage, setStage] = useState<LeadStage>(allowed[0] ?? lead.stage);
  const [note, setNote] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (stage === 'LOST' && !lostReason.trim()) {
      setFormErr('A lost reason is required');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/leads/${lead.id}/stage`, {
        stage,
        note: note.trim() || undefined,
        lostReason: stage === 'LOST' ? lostReason.trim() : undefined,
      });
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Failed to change stage');
    } finally {
      setBusy(false);
    }
  }

  if (allowed.length === 0) {
    return (
      <Backdrop onClose={onClose}>
        <h3>Change stage</h3>
        <p className="muted">This lead is in a terminal stage ({STAGE_LABEL[lead.stage]}) and cannot be moved.</p>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Change stage — {lead.companyName}</h3>
      <p className="muted">
        Current stage: <strong>{STAGE_LABEL[lead.stage]}</strong>
      </p>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="ns">New stage</label>
        <select
          id="ns"
          value={stage}
          onChange={(e) => setStage(e.target.value as LeadStage)}
        >
          {allowed.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        {stage === 'LOST' && (
          <>
            <label htmlFor="lr">Lost reason</label>
            <input
              id="lr"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              required
              placeholder="Why was this lead lost?"
            />
          </>
        )}
        <label htmlFor="sn">Note (optional)</label>
        <input id="sn" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : `Move to ${STAGE_LABEL[stage]}`}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Create quotation modal
// ---------------------------------------------------------------------------

interface PrinterLine {
  printerModel: string;
  quantity: string;
}

function QuotationFormModal({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [monthlyLeaseFee, setMonthlyLeaseFee] = useState('');
  const [perPageBw, setPerPageBw] = useState('');
  const [perPageColour, setPerPageColour] = useState('');
  const [discountPct, setDiscountPct] = useState('0');
  const [notes, setNotes] = useState('');
  const [printers, setPrinters] = useState<PrinterLine[]>([{ printerModel: '', quantity: '1' }]);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function addPrinter() {
    setPrinters((prev) => [...prev, { printerModel: '', quantity: '1' }]);
  }

  function updatePrinter(idx: number, field: keyof PrinterLine, value: string) {
    setPrinters((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  }

  function removePrinter(idx: number) {
    setPrinters((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');

    const fee = parseFloat(monthlyLeaseFee);
    const bw = parseFloat(perPageBw);
    const colour = parseFloat(perPageColour);
    const disc = parseFloat(discountPct);

    if (isNaN(fee) || fee < 0) { setFormErr('Monthly lease fee is required'); return; }
    if (isNaN(bw) || bw < 0) { setFormErr('B/W per-page rate is required'); return; }
    if (isNaN(colour) || colour < 0) { setFormErr('Colour per-page rate is required'); return; }
    if (isNaN(disc) || disc < 0 || disc > 100) { setFormErr('Discount must be 0–100'); return; }

    for (const p of printers) {
      if (!p.printerModel.trim()) { setFormErr('All printer lines need a model name'); return; }
      if (!parseInt(p.quantity) || parseInt(p.quantity) < 1) {
        setFormErr('All printer quantities must be ≥ 1');
        return;
      }
    }

    setBusy(true);
    try {
      await api.post(`/leads/${lead.id}/quotations`, {
        monthlyLeaseFee: fee,
        perPageBw: bw,
        perPageColour: colour,
        discountPct: disc,
        notes: notes.trim() || null,
        printers: printers.map((p) => ({
          printerModel: p.printerModel.trim(),
          quantity: parseInt(p.quantity),
        })),
      });
      const msg =
        disc > 0
          ? 'Quotation created — sent to Sales Manager for approval.'
          : 'Quotation created and auto-approved (no discount).';
      onSaved(msg);
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Failed to create quotation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>New quotation — {lead.companyName}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="mlf">Monthly lease fee (ZAR)</label>
        <input
          id="mlf"
          type="number"
          step="0.01"
          min="0"
          value={monthlyLeaseFee}
          onChange={(e) => setMonthlyLeaseFee(e.target.value)}
          required
          placeholder="e.g. 1500.00"
        />
        <label htmlFor="ppbw">Per-page rate B/W (ZAR)</label>
        <input
          id="ppbw"
          type="number"
          step="0.00001"
          min="0"
          value={perPageBw}
          onChange={(e) => setPerPageBw(e.target.value)}
          required
          placeholder="e.g. 0.00800"
        />
        <label htmlFor="ppcol">Per-page rate Colour (ZAR)</label>
        <input
          id="ppcol"
          type="number"
          step="0.00001"
          min="0"
          value={perPageColour}
          onChange={(e) => setPerPageColour(e.target.value)}
          required
          placeholder="e.g. 0.05000"
        />
        <label htmlFor="disc">Discount (%)</label>
        <input
          id="disc"
          type="number"
          step="0.01"
          min="0"
          max="100"
          value={discountPct}
          onChange={(e) => setDiscountPct(e.target.value)}
        />
        {parseFloat(discountPct) > 0 && (
          <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
            A discount requires Sales Manager approval before this quotation can be used.
          </p>
        )}

        <div style={{ marginTop: '1rem' }}>
          <label>Printers</label>
          {printers.map((p, idx) => (
            <div key={idx} className="printer-row">
              <input
                placeholder="Model name"
                value={p.printerModel}
                onChange={(e) => updatePrinter(idx, 'printerModel', e.target.value)}
                style={{ flex: 2 }}
              />
              <input
                type="number"
                min={1}
                placeholder="Qty"
                value={p.quantity}
                onChange={(e) => updatePrinter(idx, 'quantity', e.target.value)}
                style={{ flex: '0 0 70px' }}
              />
              {printers.length > 1 && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => removePrinter(idx)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm" onClick={addPrinter}>
            + Add printer
          </button>
        </div>

        <label htmlFor="qnotes" style={{ marginTop: '1rem', display: 'block' }}>
          Notes (optional)
        </label>
        <textarea
          id="qnotes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
        />

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Create quotation'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Approve / reject quotation modal
// ---------------------------------------------------------------------------

function ApproveQuotationModal({
  lead,
  quotation,
  onClose,
  onSaved,
}: {
  lead: Lead;
  quotation: Quotation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action: 'approve' | 'reject') {
    setFormErr('');
    setBusy(true);
    try {
      await api.patch(`/leads/${lead.id}/quotations/${quotation.id}/approve`, {
        action,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Review quotation #{quotation.id}</h3>
      <dl className="detail-list compact">
        <dt>Lead</dt>
        <dd>{lead.companyName}</dd>
        <dt>Monthly lease</dt>
        <dd>{fmtMoney(quotation.monthlyLeaseFee)}</dd>
        <dt>B/W per page</dt>
        <dd>{fmtRate(quotation.perPageBw)}</dd>
        <dt>Colour per page</dt>
        <dd>{fmtRate(quotation.perPageColour)}</dd>
        <dt>Discount</dt>
        <dd>{quotation.discountPct}%</dd>
      </dl>
      {quotation.printers.length > 0 && (
        <table style={{ marginBottom: '1rem', width: '100%' }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {quotation.printers.map((p: QuotationPrinter) => (
              <tr key={p.id}>
                <td>{p.printerModel}</td>
                <td>{p.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <label htmlFor="an">Note (optional)</label>
      <input id="an" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={() => void act('reject')} disabled={busy}>
          {busy ? 'Working…' : 'Reject'}
        </button>
        <button className="btn" onClick={() => void act('approve')} disabled={busy}>
          {busy ? 'Working…' : 'Approve'}
        </button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Convert to customer modal
// ---------------------------------------------------------------------------

function ConvertModal({
  lead,
  hasApprovedQuotation,
  onClose,
  onSaved,
}: {
  lead: Lead;
  hasApprovedQuotation: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setFormErr('');
    setBusy(true);
    try {
      await api.post(`/leads/${lead.id}/convert`);
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Conversion failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Convert to customer — {lead.companyName}</h3>
      {!hasApprovedQuotation && (
        <div className="alert alert-error">
          BR-024: This lead has no approved quotation. A quotation must be created and approved by a
          Sales Manager before conversion.
        </div>
      )}
      {hasApprovedQuotation && (
        <p className="muted">
          A customer record will be created for <strong>{lead.companyName}</strong>. This action
          cannot be undone.
        </p>
      )}
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        {hasApprovedQuotation && (
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'Converting…' : 'Convert to customer'}
          </button>
        )}
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Shared backdrop / modal shell
// ---------------------------------------------------------------------------

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/**
 * Asset / Printer Management (Module 4).
 * List → Detail (with status timeline) → Create / Edit / Status-transition modals.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, type Printer, type PrinterDetail, type PrinterStatus, type PrintTechnology } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_STATUSES: PrinterStatus[] = [
  'ORDERED', 'IN_TRANSIT', 'RECEIVED', 'QC_PASS', 'QC_FAIL',
  'IN_STOCK', 'ALLOCATED', 'DISPATCHED', 'INSTALLED',
  'UNDER_REPAIR', 'REPLACEMENT_OUT', 'RETURNED', 'REFURBISHED', 'RETIRED',
];

const TECHNOLOGIES: PrintTechnology[] = ['LASER', 'INKJET', 'LED', 'THERMAL', 'DOT_MATRIX', 'OTHER'];

function statusBadge(status: PrinterStatus) {
  const cls = status.toLowerCase().replace(/_/g, '-');
  const label = status.replace(/_/g, ' ');
  return <span className={`badge badge-${cls}`}>{label}</span>;
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(s: string) {
  return new Date(s).toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Main page (list)
// ---------------------------------------------------------------------------

export default function PrintersPage() {
  const { can } = useAuth();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (searchQ) params.set('q', searchQ);
      const qs = params.toString();
      const data = await api.get<{ printers: Printer[] }>(`/printers${qs ? `?${qs}` : ''}`);
      setPrinters(data.printers);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load printers');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchQ]);

  useEffect(() => {
    void load();
  }, [load]);

  if (selectedId != null) {
    return (
      <PrinterDetailView
        printerId={selectedId}
        onBack={() => {
          setSelectedId(null);
          void load();
        }}
      />
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Printers</h2>
        {can(PERM.printersCreate) && (
          <button className="btn" onClick={() => setCreating(true)}>
            + Register Printer
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search serial, brand, model…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          style={{ flex: 1, minWidth: '180px' }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Serial No</th>
              <th>Brand / Model</th>
              <th>Technology</th>
              <th>Colour</th>
              <th>Status</th>
              <th>Location</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {printers.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">No printers found.</td>
              </tr>
            ) : (
              printers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button className="link-btn" onClick={() => setSelectedId(p.id)}>
                      {p.serialNo}
                    </button>
                  </td>
                  <td>{p.brand} {p.model}</td>
                  <td>{p.printTechnology}</td>
                  <td>{p.isColour ? 'Yes' : 'No'}</td>
                  <td>{statusBadge(p.status)}</td>
                  <td>{p.location ?? <span className="muted">—</span>}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => setSelectedId(p.id)}>
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {creating && (
        <PrinterFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

type DetailModal =
  | { kind: 'edit' }
  | { kind: 'status' }
  | null;

function PrinterDetailView({ printerId, onBack }: { printerId: number; onBack: () => void }) {
  const { can } = useAuth();
  const [detail, setDetail] = useState<PrinterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<DetailModal>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.get<PrinterDetail>(`/printers/${printerId}`);
      setDetail(data);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load printer');
    } finally {
      setLoading(false);
    }
  }, [printerId]);

  useEffect(() => { void load(); }, [load]);

  function afterChange() {
    setModal(null);
    void load();
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (err && !detail) return <div className="alert alert-error">{err}</div>;
  if (!detail) return null;

  const { printer, history, allowedTransitions } = detail;
  const isRetired = printer.status === 'RETIRED';

  return (
    <div>
      <div className="page-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        <h2 style={{ margin: 0 }}>{printer.brand} {printer.model}</h2>
        <span className="muted" style={{ fontSize: '0.85rem' }}>{printer.serialNo}</span>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {/* Status card */}
        <div className="detail-card" style={{ minWidth: '180px' }}>
          <h3>Status</h3>
          <div style={{ marginBottom: '0.75rem' }}>{statusBadge(printer.status)}</div>
          <div className="row-actions">
            {can(PERM.printersManageStatus) && !isRetired && allowedTransitions.length > 0 && (
              <button className="btn btn-sm" onClick={() => setModal({ kind: 'status' })}>
                Change Status
              </button>
            )}
            {can(PERM.printersUpdate) && !isRetired && (
              <button className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: 'edit' })}>
                Edit
              </button>
            )}
          </div>
          {printer.currentContractNo && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
              Contract: <strong>{printer.currentContractNo}</strong>
            </p>
          )}
          {printer.currentSiteName && (
            <p style={{ fontSize: '0.82rem' }}>
              Site: <strong>{printer.currentSiteName}</strong>
            </p>
          )}
        </div>

        {/* Spec card */}
        <div className="detail-card" style={{ flex: 1 }}>
          <h3>Specification</h3>
          <dl className="detail-list compact">
            <dt>Asset No</dt><dd>{printer.assetNo ?? '—'}</dd>
            <dt>Brand</dt><dd>{printer.brand}</dd>
            <dt>Model</dt><dd>{printer.model}</dd>
            <dt>Technology</dt><dd>{printer.printTechnology}</dd>
            <dt>Colour</dt><dd>{printer.isColour ? 'Yes' : 'No'}</dd>
            <dt>PPM B&W</dt><dd>{printer.ppmBw ?? '—'}</dd>
            <dt>PPM Colour</dt><dd>{printer.isColour ? (printer.ppmColour ?? '—') : 'N/A'}</dd>
            <dt>Lifetime Pages</dt><dd>{printer.lifetimePages.toLocaleString()}</dd>
            <dt>Location</dt><dd>{printer.location ?? '—'}</dd>
            <dt>Warranty Expiry</dt><dd>{fmtDate(printer.warrantyExpiry)}</dd>
            {printer.notes && <><dt>Notes</dt><dd>{printer.notes}</dd></>}
          </dl>
        </div>
      </div>

      {/* Status history timeline */}
      <div className="detail-card">
        <h3>Status History</h3>
        {history.length === 0 ? (
          <p className="muted">No history recorded.</p>
        ) : (
          <ul className="timeline">
            {history.map((entry) => (
              <li key={entry.id} className="timeline-item">
                <div>
                  <div className="timeline-status">
                    {entry.fromStatus
                      ? `${entry.fromStatus.replace(/_/g, ' ')} → ${entry.toStatus.replace(/_/g, ' ')}`
                      : `Registered as ${entry.toStatus.replace(/_/g, ' ')}`}
                  </div>
                  <div className="timeline-meta">
                    {entry.changedBy.fullName} · {fmtDateTime(entry.changedAt)}
                    {entry.reason && <> · <em>{entry.reason}</em></>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {modal?.kind === 'edit' && (
        <PrinterFormModal
          existing={printer}
          onClose={() => setModal(null)}
          onSaved={afterChange}
        />
      )}
      {modal?.kind === 'status' && (
        <StatusTransitionModal
          printer={printer}
          allowedTransitions={allowedTransitions}
          onClose={() => setModal(null)}
          onSaved={afterChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit modal
// ---------------------------------------------------------------------------

type FormState = {
  assetNo: string;
  brand: string;
  model: string;
  serialNo: string;
  printTechnology: PrintTechnology;
  isColour: boolean;
  ppmBw: string;
  ppmColour: string;
  location: string;
  warrantyExpiry: string;
  notes: string;
};

function PrinterFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Printer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>({
    assetNo: existing?.assetNo ?? '',
    brand: existing?.brand ?? '',
    model: existing?.model ?? '',
    serialNo: existing?.serialNo ?? '',
    printTechnology: existing?.printTechnology ?? 'LASER',
    isColour: existing?.isColour ?? false,
    ppmBw: existing?.ppmBw != null ? String(existing.ppmBw) : '',
    ppmColour: existing?.ppmColour != null ? String(existing.ppmColour) : '',
    location: existing?.location ?? '',
    warrantyExpiry: existing?.warrantyExpiry ?? '',
    notes: existing?.notes ?? '',
  });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');

    if (!f.brand.trim()) { setFormErr('Brand is required'); return; }
    if (!f.model.trim()) { setFormErr('Model is required'); return; }
    if (!existing && !f.serialNo.trim()) { setFormErr('Serial number is required'); return; }

    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        brand: f.brand.trim(),
        model: f.model.trim(),
        assetNo: f.assetNo.trim() || null,
        printTechnology: f.printTechnology,
        isColour: f.isColour,
        ppmBw: f.ppmBw ? Number(f.ppmBw) : null,
        ppmColour: f.isColour && f.ppmColour ? Number(f.ppmColour) : null,
        location: f.location.trim() || null,
        warrantyExpiry: f.warrantyExpiry || null,
        notes: f.notes.trim() || null,
      };

      if (existing) {
        await api.patch(`/printers/${existing.id}`, payload);
      } else {
        payload.serialNo = f.serialNo.trim();
        await api.post('/printers', payload);
      }
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: '560px' }}>
        <h3>{existing ? 'Edit Printer' : 'Register Printer'}</h3>
        {formErr && <div className="alert alert-error">{formErr}</div>}
        <form onSubmit={onSubmit}>
          {!existing && (
            <>
              <label>Serial Number *</label>
              <input
                value={f.serialNo}
                onChange={(e) => set('serialNo', e.target.value)}
                placeholder="e.g. SN-0001234"
                required
              />
            </>
          )}

          <div className="form-row">
            <div>
              <label>Brand *</label>
              <input value={f.brand} onChange={(e) => set('brand', e.target.value)} required />
            </div>
            <div>
              <label>Model *</label>
              <input value={f.model} onChange={(e) => set('model', e.target.value)} required />
            </div>
          </div>

          <div className="form-row">
            <div>
              <label>Asset No</label>
              <input value={f.assetNo} onChange={(e) => set('assetNo', e.target.value)} />
            </div>
            <div>
              <label>Technology</label>
              <select
                value={f.printTechnology}
                onChange={(e) => set('printTechnology', e.target.value as PrintTechnology)}
              >
                {TECHNOLOGIES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={f.isColour}
                  onChange={(e) => set('isColour', e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Colour capable
              </label>
            </div>
          </div>

          <div className="form-row">
            <div>
              <label>PPM B&W</label>
              <input
                type="number"
                min={0}
                value={f.ppmBw}
                onChange={(e) => set('ppmBw', e.target.value)}
              />
            </div>
            {f.isColour && (
              <div>
                <label>PPM Colour</label>
                <input
                  type="number"
                  min={0}
                  value={f.ppmColour}
                  onChange={(e) => set('ppmColour', e.target.value)}
                />
              </div>
            )}
          </div>

          <label>Location</label>
          <input value={f.location} onChange={(e) => set('location', e.target.value)} />

          <label>Warranty Expiry</label>
          <input
            type="date"
            value={f.warrantyExpiry}
            onChange={(e) => set('warrantyExpiry', e.target.value)}
          />

          <label>Notes</label>
          <textarea
            value={f.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
          />

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : existing ? 'Save Changes' : 'Register'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status transition modal
// ---------------------------------------------------------------------------

function StatusTransitionModal({
  printer,
  allowedTransitions,
  onClose,
  onSaved,
}: {
  printer: Printer;
  allowedTransitions: PrinterStatus[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [toStatus, setToStatus] = useState<PrinterStatus>(allowedTransitions[0]);
  const [reason, setReason] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    setBusy(true);
    try {
      await api.post(`/printers/${printer.id}/status`, {
        toStatus,
        reason: reason.trim() || undefined,
      });
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Status change failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Change Status</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Current: <strong>{printer.status.replace(/_/g, ' ')}</strong>
        </p>
        {formErr && <div className="alert alert-error">{formErr}</div>}
        <form onSubmit={onSubmit}>
          <label>New Status</label>
          <select value={toStatus} onChange={(e) => setToStatus(e.target.value as PrinterStatus)}>
            {allowedTransitions.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>

          <label>Reason <span className="muted">(optional)</span></label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Collected by courier, passed all QC checks…"
          />

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

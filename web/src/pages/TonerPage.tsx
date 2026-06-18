/**
 * Toner Management — Module 9.
 *
 * Three tabs:
 *   Toner Levels  — all printers sorted by toner %, colour-coded bars, report-reading modal.
 *   Shipments     — active and historical shipments, status-advance buttons, new-shipment modal.
 *   Alerts        — NEW/NOTIFIED alerts, suppress button (blocked at ≤ 10% per BR-017).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, type TonerAlert, type TonerLevel, type TonerShipment } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tonerColor(pct: number): string {
  if (pct <= 10) return '#c0392b';
  if (pct <= 20) return '#e67e22';
  return '#27ae60';
}

function TonerBar({ pct }: { pct: number }) {
  const color = tonerColor(pct);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, background: '#e0e0e0', borderRadius: 4, height: 10 }}>
        <div
          style={{
            width: `${pct}%`,
            background: color,
            height: '100%',
            borderRadius: 4,
            transition: 'width 0.3s',
          }}
        />
      </div>
      <span style={{ color, fontWeight: 700, minWidth: 38, textAlign: 'right', fontSize: 13 }}>
        {pct}%
      </span>
    </div>
  );
}

function fmt(dt: string | null) {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = 'levels' | 'shipments' | 'alerts';

interface ReadingForm { tonerPct: string; dailyPageRate: string; }
interface ShipmentForm { printerId: string; consumableId: string; trackingRef: string; notes: string; }

export default function TonerPage() {
  const { can } = useAuth();

  const [tab, setTab] = useState<Tab>('levels');
  const [levels, setLevels]     = useState<TonerLevel[]>([]);
  const [shipments, setShipments] = useState<TonerShipment[]>([]);
  const [alerts, setAlerts]     = useState<TonerAlert[]>([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState('');
  const [notice, setNotice]     = useState('');

  // reading modal
  const [readingFor, setReadingFor]   = useState<TonerLevel | null>(null);
  const [readingForm, setReadingForm] = useState<ReadingForm>({ tonerPct: '', dailyPageRate: '' });
  const [readingSaving, setReadingSaving] = useState(false);

  // shipment create modal
  const [showCreateShipment, setShowCreateShipment] = useState(false);
  const [shipmentForm, setShipmentForm] = useState<ShipmentForm>({ printerId: '', consumableId: '', trackingRef: '', notes: '' });
  const [shipmentSaving, setShipmentSaving] = useState(false);

  // active-only filter for shipments tab
  const [activeOnly, setActiveOnly] = useState(true);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [lvl, shp, alr] = await Promise.all([
        api.get<{ levels: TonerLevel[] }>('/toner/levels'),
        api.get<{ shipments: TonerShipment[] }>('/toner/shipments'),
        api.get<{ alerts: TonerAlert[] }>('/toner/alerts'),
      ]);
      setLevels(lvl.levels);
      setShipments(shp.shipments);
      setAlerts(alr.alerts);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load toner data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ---- report reading ----
  const openReading = (lvl: TonerLevel) => {
    setReadingFor(lvl);
    setReadingForm({ tonerPct: String(lvl.tonerPct), dailyPageRate: lvl.dailyPageRate != null ? String(lvl.dailyPageRate) : '' });
    setErr('');
  };
  const saveReading = async () => {
    if (!readingFor) return;
    const pct = Number(readingForm.tonerPct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) { setErr('Toner % must be 0–100'); return; }
    setReadingSaving(true);
    try {
      await api.patch(`/printers/${readingFor.printerId}/toner`, {
        tonerPct: pct,
        dailyPageRate: readingForm.dailyPageRate ? Number(readingForm.dailyPageRate) : null,
      });
      setReadingFor(null);
      flash('Reading saved');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setReadingSaving(false);
    }
  };

  // ---- create shipment ----
  const saveShipment = async () => {
    const pid = Number(shipmentForm.printerId);
    if (!Number.isInteger(pid) || pid <= 0) { setErr('Printer ID is required'); return; }
    setShipmentSaving(true);
    try {
      await api.post('/toner/shipments', {
        printerId: pid,
        consumableId: shipmentForm.consumableId ? Number(shipmentForm.consumableId) : null,
        trackingRef: shipmentForm.trackingRef || null,
        notes: shipmentForm.notes || null,
      });
      setShowCreateShipment(false);
      setShipmentForm({ printerId: '', consumableId: '', trackingRef: '', notes: '' });
      flash('Shipment created');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Create failed');
    } finally {
      setShipmentSaving(false);
    }
  };

  // ---- advance shipment status ----
  const advanceShipment = async (id: number, newStatus: string) => {
    try {
      await api.patch(`/toner/shipments/${id}`, { status: newStatus });
      flash(`Shipment marked ${newStatus}`);
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Update failed');
    }
  };

  // ---- suppress alert ----
  const suppress = async (alertId: number) => {
    try {
      await api.post(`/toner/alerts/${alertId}/suppress`);
      flash('Alert suppressed');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Cannot suppress alert');
    }
  };

  const visibleShipments = activeOnly
    ? shipments.filter((s) => s.status === 'PENDING' || s.status === 'IN_TRANSIT')
    : shipments;

  const activeAlerts = alerts.filter((a) => a.status !== 'SUPPRESSED');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Toner Management</h2>
        {can(PERM.tonerManage) && (
          <button className="btn-primary" onClick={() => { setShowCreateShipment(true); setErr(''); }}>
            + New Shipment
          </button>
        )}
      </div>

      {notice && <div className="notice success">{notice}</div>}
      {err && !readingFor && !showCreateShipment && <div className="notice error">{err}</div>}

      {/* Tab bar */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {(['levels', 'shipments', 'alerts'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'levels' ? 'Toner Levels' : t === 'shipments' ? 'Shipments' : `Alerts${activeAlerts.length ? ` (${activeAlerts.length})` : ''}`}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {/* ---- TONER LEVELS TAB ---- */}
          {tab === 'levels' && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Printer</th>
                  <th>Model</th>
                  <th style={{ minWidth: 200 }}>Toner Level</th>
                  <th>Est. Days Left</th>
                  <th>Last Reading</th>
                  {can(PERM.tonerUpdate) && <th></th>}
                </tr>
              </thead>
              <tbody>
                {levels.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>No toner readings recorded</td></tr>
                )}
                {levels.map((lvl) => (
                  <tr key={lvl.printerId} style={{ background: lvl.tonerPct <= 10 ? '#fff5f5' : lvl.tonerPct <= 20 ? '#fffbf0' : undefined }}>
                    <td><code>{lvl.printerSerial}</code></td>
                    <td>{lvl.printerModel}</td>
                    <td><TonerBar pct={lvl.tonerPct} /></td>
                    <td>{lvl.estimatedDaysRemaining != null ? `${lvl.estimatedDaysRemaining}d` : '—'}</td>
                    <td>{fmt(lvl.lastChangeAt)}</td>
                    {can(PERM.tonerUpdate) && (
                      <td>
                        <button className="btn-sm" onClick={() => openReading(lvl)}>Report</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* ---- SHIPMENTS TAB ---- */}
          {tab === 'shipments' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
                Show active only (PENDING / IN_TRANSIT)
              </label>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Printer</th>
                    <th>Status</th>
                    <th>Tracking</th>
                    <th>Created</th>
                    {can(PERM.tonerManage) && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleShipments.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>No shipments</td></tr>
                  )}
                  {visibleShipments.map((s) => (
                    <tr key={s.id}>
                      <td>{s.id}</td>
                      <td>
                        <div><code>{s.printerSerial}</code></div>
                        <div className="muted" style={{ fontSize: 12 }}>{s.printerModel}</div>
                      </td>
                      <td>
                        <span className={`badge badge-${s.status.toLowerCase()}`}>{s.status}</span>
                      </td>
                      <td>{s.trackingRef ?? '—'}</td>
                      <td>{fmt(s.createdAt)}</td>
                      {can(PERM.tonerManage) && (
                        <td style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {s.status === 'PENDING' && (
                            <>
                              <button className="btn-sm" onClick={() => void advanceShipment(s.id, 'IN_TRANSIT')}>In Transit</button>
                              <button className="btn-sm btn-danger" onClick={() => void advanceShipment(s.id, 'CANCELLED')}>Cancel</button>
                            </>
                          )}
                          {s.status === 'IN_TRANSIT' && (
                            <>
                              <button className="btn-sm btn-success" onClick={() => void advanceShipment(s.id, 'DELIVERED')}>Delivered</button>
                              <button className="btn-sm btn-danger" onClick={() => void advanceShipment(s.id, 'CANCELLED')}>Cancel</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* ---- ALERTS TAB ---- */}
          {tab === 'alerts' && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Printer</th>
                  <th>Alert</th>
                  <th>Toner %</th>
                  <th>Status</th>
                  <th>Raised</th>
                  {can(PERM.tonerManage) && <th></th>}
                </tr>
              </thead>
              <tbody>
                {alerts.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>No alerts</td></tr>
                )}
                {alerts.map((a) => (
                  <tr
                    key={a.id}
                    style={{
                      background: a.alertType === 'CRITICAL_10' && a.status !== 'SUPPRESSED' ? '#fff5f5' : undefined,
                      opacity: a.status === 'SUPPRESSED' ? 0.55 : 1,
                    }}
                  >
                    <td>
                      <div><code>{a.printerSerial}</code></div>
                      <div className="muted" style={{ fontSize: 12 }}>{a.printerModel}</div>
                    </td>
                    <td>
                      <span style={{ color: a.alertType === 'CRITICAL_10' ? '#c0392b' : '#e67e22', fontWeight: 600 }}>
                        {a.alertType === 'CRITICAL_10' ? 'Critical (≤10%)' : 'Low (≤20%)'}
                      </span>
                    </td>
                    <td>
                      {a.tonerPct != null ? <TonerBar pct={a.tonerPct} /> : '—'}
                    </td>
                    <td>{a.status}</td>
                    <td>{fmt(a.createdAt)}</td>
                    {can(PERM.tonerManage) && (
                      <td>
                        {a.status !== 'SUPPRESSED' && (
                          <button
                            className="btn-sm"
                            title={a.tonerPct != null && a.tonerPct <= 10 ? 'Cannot suppress: toner ≤ 10% (BR-017)' : 'Suppress alert'}
                            onClick={() => void suppress(a.id)}
                          >
                            Suppress
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {/* ---- REPORT READING MODAL ---- */}
      {readingFor && (
        <div className="backdrop" onClick={() => setReadingFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Report Toner Reading — {readingFor.printerSerial}</h3>
            {err && <div className="notice error">{err}</div>}
            <div className="form-group">
              <label>Toner % (0–100) *</label>
              <input
                type="number"
                min={0}
                max={100}
                value={readingForm.tonerPct}
                onChange={(e) => setReadingForm((f) => ({ ...f, tonerPct: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Daily page rate (pages/day)</label>
              <input
                type="number"
                min={0}
                placeholder="optional — used for days-remaining estimate"
                value={readingForm.dailyPageRate}
                onChange={(e) => setReadingForm((f) => ({ ...f, dailyPageRate: e.target.value }))}
              />
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setReadingFor(null)}>Cancel</button>
              <button className="btn-primary" disabled={readingSaving} onClick={() => void saveReading()}>
                {readingSaving ? 'Saving…' : 'Save Reading'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- CREATE SHIPMENT MODAL ---- */}
      {showCreateShipment && (
        <div className="backdrop" onClick={() => setShowCreateShipment(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Toner Shipment</h3>
            {err && <div className="notice error">{err}</div>}
            <div className="form-group">
              <label>Printer ID *</label>
              <input
                type="number"
                placeholder="printer ID"
                value={shipmentForm.printerId}
                onChange={(e) => setShipmentForm((f) => ({ ...f, printerId: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Consumable ID</label>
              <input
                type="number"
                placeholder="optional"
                value={shipmentForm.consumableId}
                onChange={(e) => setShipmentForm((f) => ({ ...f, consumableId: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Tracking reference</label>
              <input
                type="text"
                placeholder="optional"
                value={shipmentForm.trackingRef}
                onChange={(e) => setShipmentForm((f) => ({ ...f, trackingRef: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea
                rows={2}
                value={shipmentForm.notes}
                onChange={(e) => setShipmentForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowCreateShipment(false)}>Cancel</button>
              <button className="btn-primary" disabled={shipmentSaving} onClick={() => void saveShipment()}>
                {shipmentSaving ? 'Creating…' : 'Create Shipment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

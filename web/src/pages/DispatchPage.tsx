/**
 * Dispatch & Delivery Management (Module 6).
 *
 * Renders a list of dispatch orders with action buttons appropriate for the
 * current status.  Users with dispatch.create can open a create modal;
 * dispatch.update can schedule, edit, and cancel; dispatch.deliver can
 * mark orders departed and delivered.
 */
import { useState, useEffect, useCallback } from 'react';
import { getToken } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, DispatchOrder, DispatchOrderItem, DispatchOrderDetail, DispatchStatus } from '../types';

const API = '/api';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token: string,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });
  const data = (await res.json()) as { error?: { message: string } } & T;
  if (!res.ok) throw new Error((data as { error?: { message: string } }).error?.message ?? 'Request failed');
  return data;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DispatchStatus }) {
  const cls = `badge badge-${status.toLowerCase().replace(/_/g, '-')}`;
  const label: Record<DispatchStatus, string> = {
    PENDING: 'Pending',
    SCHEDULED: 'Scheduled',
    IN_TRANSIT: 'In Transit',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
  };
  return <span className={cls}>{label[status]}</span>;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

interface CreateModalProps {
  token: string;
  onCreated: () => void;
  onClose: () => void;
}

function CreateModal({ token, onCreated, onClose }: CreateModalProps) {
  const [contractId, setContractId] = useState('');
  const [printerIds, setPrinterIds] = useState('');
  const [siteId, setSiteId] = useState('');
  const [courier, setCourier] = useState('');
  const [plannedDate, setPlannedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const ids = printerIds.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    if (!ids.length) { setError('Enter at least one printer ID'); return; }
    setSaving(true);
    try {
      await apiFetch(
        '/dispatch-orders',
        {
          method: 'POST',
          body: JSON.stringify({
            contractId: Number(contractId),
            printerIds: ids,
            siteId: siteId ? Number(siteId) : undefined,
            courier: courier || undefined,
            plannedDate: plannedDate || undefined,
            notes: notes || undefined,
          }),
        },
        token,
      );
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>New Dispatch Order</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>Contract ID *<input type="number" value={contractId} onChange={(e) => setContractId(e.target.value)} required /></label>
          <label>Printer IDs (comma-separated) *<input value={printerIds} onChange={(e) => setPrinterIds(e.target.value)} placeholder="20, 21, 22" required /></label>
          <label>Site ID (optional)<input type="number" value={siteId} onChange={(e) => setSiteId(e.target.value)} /></label>
          <label>Courier<input value={courier} onChange={(e) => setCourier(e.target.value)} /></label>
          <label>Planned Date<input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} /></label>
          <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ScheduleModalProps {
  orderId: number;
  token: string;
  onDone: () => void;
  onClose: () => void;
}

function ScheduleModal({ orderId, token, onDone, onClose }: ScheduleModalProps) {
  const [plannedDate, setPlannedDate] = useState('');
  const [courier, setCourier] = useState('');
  const [trackingRef, setTrackingRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await apiFetch(
        `/dispatch-orders/${orderId}/schedule`,
        { method: 'POST', body: JSON.stringify({ plannedDate, courier, trackingRef }) },
        token,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Schedule Dispatch</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>Planned Date *<input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} required /></label>
          <label>Courier<input value={courier} onChange={(e) => setCourier(e.target.value)} /></label>
          <label>Tracking Ref<input value={trackingRef} onChange={(e) => setTrackingRef(e.target.value)} /></label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Schedule'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DepartModalProps {
  orderId: number;
  token: string;
  onDone: () => void;
  onClose: () => void;
}

function DepartModal({ orderId, token, onDone, onClose }: DepartModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    setError(null);
    setSaving(true);
    try {
      await apiFetch(`/dispatch-orders/${orderId}/depart`, { method: 'POST', body: '{}' }, token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Mark as Departed</h3>
        <p>Printers will be moved to <strong>DISPATCHED</strong> and the order status set to <strong>IN_TRANSIT</strong>.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={() => void handleConfirm()}>
            {saving ? 'Marking…' : 'Confirm Departure'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DeliverModalProps {
  orderId: number;
  token: string;
  onDone: () => void;
  onClose: () => void;
}

function DeliverModal({ orderId, token, onDone, onClose }: DeliverModalProps) {
  const [podRecipient, setPodRecipient] = useState('');
  const [podNotes, setPodNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await apiFetch(
        `/dispatch-orders/${orderId}/deliver`,
        { method: 'POST', body: JSON.stringify({ podRecipient, podNotes }) },
        token,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Confirm Delivery</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>Recipient name *<input value={podRecipient} onChange={(e) => setPodRecipient(e.target.value)} required /></label>
          <label>Notes<textarea value={podNotes} onChange={(e) => setPodNotes(e.target.value)} rows={3} /></label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Mark Delivered'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CancelModalProps {
  orderId: number;
  token: string;
  onDone: () => void;
  onClose: () => void;
}

function CancelModal({ orderId, token, onDone, onClose }: CancelModalProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await apiFetch(
        `/dispatch-orders/${orderId}/cancel`,
        { method: 'POST', body: JSON.stringify({ reason }) },
        token,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Cancel Order</h3>
        <p className="muted">If the order is IN_TRANSIT, dispatched printers will be reverted to ALLOCATED.</p>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} /></label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Keep Order</button>
            <button type="submit" className="btn-danger" disabled={saving}>{saving ? 'Cancelling…' : 'Cancel Order'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order detail panel
// ---------------------------------------------------------------------------

interface OrderDetailProps {
  orderId: number;
  token: string;
  canUpdate: boolean;
  canDeliver: boolean;
  onStatusChange: () => void;
  onBack: () => void;
}

type ActiveModal = 'schedule' | 'depart' | 'deliver' | 'cancel' | null;

function OrderDetailPanel({ orderId, token, canUpdate, canDeliver, onStatusChange, onBack }: OrderDetailProps) {
  const [detail, setDetail] = useState<DispatchOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ActiveModal>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<DispatchOrderDetail>(`/dispatch-orders/${orderId}`, {}, token);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order');
    } finally {
      setLoading(false);
    }
  }, [orderId, token]);

  useEffect(() => { void load(); }, [load]);

  function handleModalDone() {
    setModal(null);
    void load();
    onStatusChange();
  }

  if (loading) return <p className="muted">Loading order…</p>;
  if (error) return <p className="error-banner">{error}</p>;
  if (!detail) return null;

  const { order, items } = detail;

  return (
    <div>
      <button className="back-btn" onClick={onBack}>← Back to list</button>

      <div className="detail-header">
        <div>
          <h2>{order.orderNo}</h2>
          <p className="muted">{order.customerName} — Contract {order.contractNo}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="detail-section">
        <div className="detail-grid">
          {order.plannedDate && <><span className="label">Planned date</span><span>{order.plannedDate}</span></>}
          {order.courier && <><span className="label">Courier</span><span>{order.courier}</span></>}
          {order.trackingRef && <><span className="label">Tracking ref</span><span>{order.trackingRef}</span></>}
          {order.siteName && <><span className="label">Delivery site</span><span>{order.siteName}{order.siteCity ? `, ${order.siteCity}` : ''}</span></>}
          {order.departedAt && <><span className="label">Departed</span><span>{order.departedAt}</span></>}
          {order.deliveredAt && <><span className="label">Delivered</span><span>{order.deliveredAt}</span></>}
          {order.podRecipient && <><span className="label">Signed by</span><span>{order.podRecipient}</span></>}
          {order.podNotes && <><span className="label">POD notes</span><span>{order.podNotes}</span></>}
          {order.notes && <><span className="label">Notes</span><span>{order.notes}</span></>}
        </div>
      </div>

      <h3>Printers ({items.length})</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Serial No</th>
            <th>Brand / Model</th>
            <th>Asset No</th>
            <th>Printer Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item: DispatchOrderItem) => (
            <tr key={item.id}>
              <td>{item.serialNo}</td>
              <td>{item.brand} {item.model}</td>
              <td>{item.assetNo ?? '—'}</td>
              <td><span className={`badge badge-${item.printerStatus.toLowerCase().replace(/_/g, '-')}`}>{item.printerStatus}</span></td>
              <td>{item.notes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="action-bar">
        {canUpdate && order.status === 'PENDING' && (
          <button className="btn-primary" onClick={() => setModal('schedule')}>Schedule</button>
        )}
        {canDeliver && order.status === 'SCHEDULED' && (
          <button className="btn-primary" onClick={() => setModal('depart')}>Mark Departed</button>
        )}
        {canDeliver && order.status === 'IN_TRANSIT' && (
          <button className="btn-primary" onClick={() => setModal('deliver')}>Confirm Delivery</button>
        )}
        {canUpdate && ['PENDING', 'SCHEDULED', 'IN_TRANSIT'].includes(order.status) && (
          <button className="btn-danger" onClick={() => setModal('cancel')}>Cancel Order</button>
        )}
      </div>

      {modal === 'schedule' && (
        <ScheduleModal orderId={order.id} token={token} onDone={handleModalDone} onClose={() => setModal(null)} />
      )}
      {modal === 'depart' && (
        <DepartModal orderId={order.id} token={token} onDone={handleModalDone} onClose={() => setModal(null)} />
      )}
      {modal === 'deliver' && (
        <DeliverModal orderId={order.id} token={token} onDone={handleModalDone} onClose={() => setModal(null)} />
      )}
      {modal === 'cancel' && (
        <CancelModal orderId={order.id} token={token} onDone={handleModalDone} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DispatchPage() {
  const { can } = useAuth();
  const token = getToken() ?? '';
  const [orders, setOrders] = useState<DispatchOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const canCreate = can(PERM.dispatchCreate);
  const canUpdate = can(PERM.dispatchUpdate);
  const canDeliver = can(PERM.dispatchDeliver);

  const loadOrders = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const data = await apiFetch<{ orders: DispatchOrder[] }>(`/dispatch-orders${qs}`, {}, token);
      setOrders(data.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispatch orders');
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  if (selectedId !== null) {
    return (
      <div className="page">
        <OrderDetailPanel
          orderId={selectedId}
          token={token!}
          canUpdate={canUpdate}
          canDeliver={canDeliver}
          onStatusChange={() => void loadOrders()}
          onBack={() => setSelectedId(null)}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Dispatch Orders</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="filter-select">
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="IN_TRANSIT">In Transit</option>
            <option value="DELIVERED">Delivered</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          {canCreate && (
            <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Order</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && !error && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Order No</th>
              <th>Customer</th>
              <th>Contract</th>
              <th>Status</th>
              <th>Planned Date</th>
              <th>Courier</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>No dispatch orders found.</td></tr>
            )}
            {orders.map((o) => (
              <tr key={o.id} className="clickable-row" onClick={() => setSelectedId(o.id)}>
                <td><strong>{o.orderNo}</strong></td>
                <td>{o.customerName}</td>
                <td>{o.contractNo}</td>
                <td><StatusBadge status={o.status} /></td>
                <td>{o.plannedDate ?? '—'}</td>
                <td>{o.courier ?? '—'}</td>
                <td>{new Date(o.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreateModal
          token={token!}
          onCreated={() => { setShowCreate(false); void loadOrders(); }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

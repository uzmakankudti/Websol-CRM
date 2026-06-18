/**
 * Inventory / Warehouse Management page.
 *
 * Three tabs: Warehouses | GRNs | Consumables.
 * Each tab has a list view and a drill-down detail view.
 * Create/edit modals are gated by the caller's permissions.
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/context';
import {
  PERM,
  Warehouse, WarehouseDetail,
  GRN, GRNDetail,
  Consumable, ConsumableStockLine,
} from '../types';

type Tab = 'warehouses' | 'grns' | 'consumables';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function authFetch(url: string, token: string, options?: RequestInit) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function InventoryPage() {
  const [tab, setTab] = useState<Tab>('warehouses');

  return (
    <div>
      <div className="page-header">
        <h2>Inventory &amp; Warehouses</h2>
      </div>
      <div className="tab-bar">
        <button className={`tab-btn ${tab === 'warehouses' ? 'active' : ''}`} onClick={() => setTab('warehouses')}>Warehouses</button>
        <button className={`tab-btn ${tab === 'grns' ? 'active' : ''}`} onClick={() => setTab('grns')}>GRNs</button>
        <button className={`tab-btn ${tab === 'consumables' ? 'active' : ''}`} onClick={() => setTab('consumables')}>Consumables</button>
      </div>
      {tab === 'warehouses' && <WarehousesTab />}
      {tab === 'grns' && <GRNsTab />}
      {tab === 'consumables' && <ConsumablesTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warehouses tab
// ---------------------------------------------------------------------------

function WarehousesTab() {
  const { token, can } = useAuth();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WarehouseDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<Warehouse | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/warehouses', token);
      const data = await res.json() as { warehouses: Warehouse[] };
      setWarehouses(data.warehouses ?? []);
    } catch {
      setError('Failed to load warehouses.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: number) => {
    if (!token) return;
    try {
      const res = await authFetch(`/api/warehouses/${id}`, token);
      const data = await res.json() as WarehouseDetail;
      setSelected(data);
    } catch {
      setError('Failed to load warehouse detail.');
    }
  }, [token]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="alert alert-error">{error}</div>;

  if (selected) {
    return (
      <WarehouseDetail
        detail={selected}
        onBack={() => setSelected(null)}
        onEdit={can(PERM.inventoryAdjust) ? (w) => setShowEdit(w) : undefined}
      />
    );
  }

  return (
    <>
      <div className="toolbar">
        {can(PERM.inventoryAdjust) && (
          <button className="btn" onClick={() => setShowCreate(true)}>+ New Warehouse</button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Type</th>
            <th>City</th>
            <th>Printers</th>
            <th>Consumables</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {warehouses.length === 0 && (
            <tr><td colSpan={7} className="muted">No warehouses configured.</td></tr>
          )}
          {warehouses.map((w) => (
            <tr key={w.id}>
              <td>
                <button className="link-btn" onClick={() => void openDetail(w.id)}>{w.code}</button>
              </td>
              <td>{w.name}</td>
              <td><span className={`badge badge-${w.type.toLowerCase()}`}>{w.type}</span></td>
              <td>{w.city ?? <span className="muted">—</span>}</td>
              <td>{w.printerCount ?? 0}</td>
              <td>{w.consumableLineCount ?? 0}</td>
              <td>
                <span className={`badge badge-${w.isActive ? 'active' : 'inactive'}`}>
                  {w.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showCreate && (
        <WarehouseFormModal
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); void load(); }}
        />
      )}
      {showEdit && (
        <WarehouseFormModal
          existing={showEdit}
          onClose={() => setShowEdit(null)}
          onSaved={() => { setShowEdit(null); void load(); }}
        />
      )}
    </>
  );
}

function WarehouseDetail({
  detail, onBack, onEdit,
}: {
  detail: WarehouseDetail;
  onBack: () => void;
  onEdit?: (w: Warehouse) => void;
}) {
  const { warehouse, printers, consumableStock } = detail;
  return (
    <div>
      <div className="page-header">
        <h3>{warehouse.name} <span className="muted">({warehouse.code})</span></h3>
        <div className="row-actions">
          {onEdit && <button className="btn btn-secondary btn-sm" onClick={() => onEdit(warehouse)}>Edit</button>}
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        </div>
      </div>
      <div className="detail-grid">
        <div className="detail-card">
          <h3>Details</h3>
          <dl className="detail-list">
            <dt>Type</dt><dd><span className={`badge badge-${warehouse.type.toLowerCase()}`}>{warehouse.type}</span></dd>
            <dt>City</dt><dd>{warehouse.city ?? '—'}</dd>
            <dt>Address</dt><dd>{warehouse.address ?? '—'}</dd>
            <dt>Contact</dt><dd>{warehouse.contactName ?? '—'} {warehouse.contactPhone ? `· ${warehouse.contactPhone}` : ''}</dd>
            <dt>Status</dt><dd><span className={`badge badge-${warehouse.isActive ? 'active' : 'inactive'}`}>{warehouse.isActive ? 'Active' : 'Inactive'}</span></dd>
          </dl>
        </div>
        <div className="detail-card">
          <h3>Printers ({printers.length})</h3>
          {printers.length === 0 ? (
            <p className="muted">No printers assigned.</p>
          ) : (
            <table>
              <thead><tr><th>Serial</th><th>Model</th><th>Status</th><th>Contract</th></tr></thead>
              <tbody>
                {printers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.serialNo}</td>
                    <td>{p.brand} {p.model}</td>
                    <td><span className={`badge badge-${p.status.toLowerCase().replace(/_/g, '-')}`}>{p.status}</span></td>
                    <td>{p.currentContractNo ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="detail-card">
          <h3>Consumable Stock</h3>
          {consumableStock.length === 0 ? (
            <p className="muted">No stock on hand.</p>
          ) : (
            <table>
              <thead><tr><th>SKU</th><th>Name</th><th>Qty</th><th>Reorder</th></tr></thead>
              <tbody>
                {consumableStock.map((s) => (
                  <tr key={s.consumableId}>
                    <td>{s.sku}</td>
                    <td>{s.name}</td>
                    <td>
                      {s.qtyOnHand}
                      {' '}
                      <span className={`badge badge-${s.isLowStock ? 'low-stock' : 'ok-stock'}`}>
                        {s.isLowStock ? 'Low' : 'OK'}
                      </span>
                    </td>
                    <td>{s.reorderLevel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function WarehouseFormModal({
  existing, onClose, onSaved,
}: {
  existing?: Warehouse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { token } = useAuth();
  const [form, setForm] = useState({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    type: existing?.type ?? 'CENTRAL',
    city: existing?.city ?? '',
    address: existing?.address ?? '',
    contactName: existing?.contactName ?? '',
    contactPhone: existing?.contactPhone ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setErr(null);
    try {
      const method = existing ? 'PATCH' : 'POST';
      const url = existing ? `/api/warehouses/${existing.id}` : '/api/warehouses';
      const res = await authFetch(url, token, { method, body: JSON.stringify(form) });
      if (!res.ok) {
        const d = await res.json() as { error: { message: string } };
        setErr(d.error?.message ?? 'Save failed');
        return;
      }
      onSaved();
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{existing ? 'Edit Warehouse' : 'New Warehouse'}</h3>
        {err && <div className="alert alert-error">{err}</div>}
        {!existing && (
          <>
            <label>Code *</label>
            <input value={form.code} onChange={set('code')} placeholder="e.g. WH-CENTRAL" />
          </>
        )}
        <label>Name *</label>
        <input value={form.name} onChange={set('name')} placeholder="Warehouse name" />
        <label>Type</label>
        <select value={form.type} onChange={set('type')}>
          <option value="CENTRAL">Central</option>
          <option value="DEPOT">Depot</option>
        </select>
        <label>City</label>
        <input value={form.city} onChange={set('city')} />
        <label>Address</label>
        <input value={form.address} onChange={set('address')} />
        <label>Contact Name</label>
        <input value={form.contactName} onChange={set('contactName')} />
        <label>Contact Phone</label>
        <input value={form.contactPhone} onChange={set('contactPhone')} />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GRNs tab
// ---------------------------------------------------------------------------

function GRNsTab() {
  const { token, can } = useAuth();
  const [grns, setGrns] = useState<GRN[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GRNDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/grns', token);
      const data = await res.json() as { grns: GRN[] };
      setGrns(data.grns ?? []);
    } catch {
      setError('Failed to load GRNs.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: number) => {
    if (!token) return;
    try {
      const res = await authFetch(`/api/grns/${id}`, token);
      const data = await res.json() as GRNDetail;
      setSelected(data);
    } catch {
      setError('Failed to load GRN detail.');
    }
  }, [token]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="alert alert-error">{error}</div>;

  if (selected) {
    return <GRNDetailView detail={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <>
      <div className="toolbar">
        {can(PERM.inventoryGrn) && (
          <button className="btn" onClick={() => setShowCreate(true)}>+ New GRN</button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>GRN No.</th>
            <th>Warehouse</th>
            <th>Supplier</th>
            <th>Received At</th>
            <th>Printers</th>
            <th>Consumable Lines</th>
          </tr>
        </thead>
        <tbody>
          {grns.length === 0 && (
            <tr><td colSpan={6} className="muted">No GRNs recorded.</td></tr>
          )}
          {grns.map((g) => (
            <tr key={g.id}>
              <td>
                <button className="link-btn" onClick={() => void openDetail(g.id)}>{g.grnNo}</button>
              </td>
              <td>{g.warehouseName}</td>
              <td>{g.supplierName ?? <span className="muted">—</span>}</td>
              <td>{new Date(g.receivedAt).toLocaleDateString()}</td>
              <td>{g.printerCount ?? 0}</td>
              <td>{g.consumableLineCount ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {showCreate && (
        <GRNCreateModal
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); void load(); }}
        />
      )}
    </>
  );
}

function GRNDetailView({ detail, onBack }: { detail: GRNDetail; onBack: () => void }) {
  const { grn, printerLines, consumableLines } = detail;
  return (
    <div>
      <div className="page-header">
        <h3>{grn.grnNo}</h3>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
      </div>
      <div className="detail-grid">
        <div className="detail-card">
          <h3>Details</h3>
          <dl className="detail-list">
            <dt>Warehouse</dt><dd>{grn.warehouseName}</dd>
            <dt>Supplier</dt><dd>{grn.supplierName ?? '—'}</dd>
            <dt>Supplier Ref</dt><dd>{grn.supplierRef ?? '—'}</dd>
            <dt>Received At</dt><dd>{new Date(grn.receivedAt).toLocaleString()}</dd>
            <dt>Received By</dt><dd>{grn.receivedBy?.fullName ?? '—'}</dd>
            {grn.notes && <><dt>Notes</dt><dd>{grn.notes}</dd></>}
          </dl>
        </div>
        {printerLines.length > 0 && (
          <div className="detail-card">
            <h3>Printers Received ({printerLines.length})</h3>
            <table>
              <thead><tr><th>Serial</th><th>Brand</th><th>Model</th><th>Unit Cost</th></tr></thead>
              <tbody>
                {printerLines.map((p) => (
                  <tr key={p.id}>
                    <td>{p.serialNo}</td>
                    <td>{p.brand}</td>
                    <td>{p.model}</td>
                    <td>{p.unitCost != null ? `R ${p.unitCost.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {consumableLines.length > 0 && (
          <div className="detail-card">
            <h3>Consumables Received ({consumableLines.length})</h3>
            <table>
              <thead><tr><th>SKU</th><th>Name</th><th>Qty</th><th>Unit Cost</th></tr></thead>
              <tbody>
                {consumableLines.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sku}</td>
                    <td>{c.consumableName}</td>
                    <td>{c.quantity} {c.unit}</td>
                    <td>{c.unitCost != null ? `R ${c.unitCost.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function GRNCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { token } = useAuth();
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [notes, setNotes] = useState('');
  const [printerIds, setPrinterIds] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setErr(null);
    try {
      const printers = printerIds.trim()
        ? printerIds.split(',').map((s) => ({ printerId: Number(s.trim()) })).filter((p) => p.printerId > 0)
        : [];
      const body = {
        warehouseId: Number(warehouseId),
        supplierName: supplierName || null,
        supplierRef: supplierRef || null,
        notes: notes || null,
        printers,
        consumables: [],
      };
      const res = await authFetch('/api/grns', token, { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json() as { error: { message: string } };
        setErr(d.error?.message ?? 'Save failed');
        return;
      }
      onSaved();
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>New Goods Receipt Note</h3>
        {err && <div className="alert alert-error">{err}</div>}
        <label>Warehouse ID *</label>
        <input type="number" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Warehouse ID" />
        <label>Supplier Name</label>
        <input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
        <label>Supplier Reference</label>
        <input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
        <label>Printer IDs (comma-separated)</label>
        <input value={printerIds} onChange={(e) => setPrinterIds(e.target.value)} placeholder="e.g. 1, 2, 3" />
        <label>Notes</label>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Create GRN'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consumables tab
// ---------------------------------------------------------------------------

function ConsumablesTab() {
  const { token, can } = useAuth();
  const [consumables, setConsumables] = useState<Consumable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ consumable: Consumable; stock: ConsumableStockLine[] } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<Consumable | null>(null);
  const [showAdjust, setShowAdjust] = useState<Consumable | null>(null);
  const [filterLow, setFilterLow] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/consumables', token);
      const data = await res.json() as { consumables: Consumable[] };
      setConsumables(data.consumables ?? []);
    } catch {
      setError('Failed to load consumables.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: number) => {
    if (!token) return;
    try {
      const res = await authFetch(`/api/consumables/${id}`, token);
      const data = await res.json() as { consumable: Consumable; stock: ConsumableStockLine[] };
      setSelected(data);
    } catch {
      setError('Failed to load consumable detail.');
    }
  }, [token]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="alert alert-error">{error}</div>;

  if (selected) {
    return (
      <ConsumableDetailView
        consumable={selected.consumable}
        stock={selected.stock}
        onBack={() => setSelected(null)}
        onEdit={can(PERM.inventoryAdjust) ? (c) => setShowEdit(c) : undefined}
        onAdjust={can(PERM.inventoryAdjust) ? (c) => setShowAdjust(c) : undefined}
      />
    );
  }

  const displayed = filterLow ? consumables.filter((c) => c.isLowStock) : consumables;

  return (
    <>
      <div className="toolbar">
        {can(PERM.inventoryAdjust) && (
          <button className="btn" onClick={() => setShowCreate(true)}>+ New Consumable</button>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={filterLow} onChange={(e) => setFilterLow(e.target.checked)} style={{ width: 'auto' }} />
          Low stock only
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Category</th>
            <th>Unit</th>
            <th>Total Qty</th>
            <th>Reorder Level</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          {displayed.length === 0 && (
            <tr><td colSpan={7} className="muted">No consumables found.</td></tr>
          )}
          {displayed.map((c) => (
            <tr key={c.id}>
              <td>
                <button className="link-btn" onClick={() => void openDetail(c.id)}>{c.sku}</button>
              </td>
              <td>{c.name}</td>
              <td>{c.category}</td>
              <td>{c.unit}</td>
              <td>{c.totalQtyOnHand ?? 0}</td>
              <td>{c.reorderLevel}</td>
              <td>
                <span className={`badge badge-${c.isLowStock ? 'low-stock' : 'ok-stock'}`}>
                  {c.isLowStock ? 'Low' : 'OK'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showCreate && (
        <ConsumableFormModal
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); void load(); }}
        />
      )}
      {showEdit && (
        <ConsumableFormModal
          existing={showEdit}
          onClose={() => setShowEdit(null)}
          onSaved={() => { setShowEdit(null); void load(); }}
        />
      )}
      {showAdjust && (
        <StockAdjustModal
          consumable={showAdjust}
          onClose={() => setShowAdjust(null)}
          onSaved={() => { setShowAdjust(null); void load(); }}
        />
      )}
    </>
  );
}

function ConsumableDetailView({
  consumable, stock, onBack, onEdit, onAdjust,
}: {
  consumable: Consumable;
  stock: ConsumableStockLine[];
  onBack: () => void;
  onEdit?: (c: Consumable) => void;
  onAdjust?: (c: Consumable) => void;
}) {
  return (
    <div>
      <div className="page-header">
        <h3>{consumable.name} <span className="muted">({consumable.sku})</span></h3>
        <div className="row-actions">
          {onAdjust && <button className="btn btn-secondary btn-sm" onClick={() => onAdjust(consumable)}>Adjust Stock</button>}
          {onEdit && <button className="btn btn-secondary btn-sm" onClick={() => onEdit(consumable)}>Edit</button>}
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        </div>
      </div>
      <div className="detail-grid">
        <div className="detail-card">
          <h3>Details</h3>
          <dl className="detail-list">
            <dt>Category</dt><dd>{consumable.category}</dd>
            <dt>Unit</dt><dd>{consumable.unit}</dd>
            <dt>Reorder Level</dt><dd>{consumable.reorderLevel}</dd>
            <dt>Description</dt><dd>{consumable.description ?? '—'}</dd>
            <dt>Status</dt><dd><span className={`badge badge-${consumable.isActive ? 'active' : 'inactive'}`}>{consumable.isActive ? 'Active' : 'Inactive'}</span></dd>
          </dl>
        </div>
        <div className="detail-card">
          <h3>Stock by Warehouse</h3>
          {stock.length === 0 ? (
            <p className="muted">No stock on hand.</p>
          ) : (
            <table>
              <thead><tr><th>Warehouse</th><th>Qty on Hand</th><th>Stock</th></tr></thead>
              <tbody>
                {stock.map((s) => (
                  <tr key={s.warehouseId}>
                    <td>{s.warehouseName} <span className="muted">({s.warehouseCode})</span></td>
                    <td>{s.qtyOnHand}</td>
                    <td>
                      <span className={`badge badge-${s.isLowStock ? 'low-stock' : 'ok-stock'}`}>
                        {s.isLowStock ? 'Low' : 'OK'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsumableFormModal({
  existing, onClose, onSaved,
}: {
  existing?: Consumable;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { token } = useAuth();
  const [form, setForm] = useState({
    sku: existing?.sku ?? '',
    name: existing?.name ?? '',
    category: existing?.category ?? 'TONER',
    unit: existing?.unit ?? 'cartridge',
    reorderLevel: String(existing?.reorderLevel ?? 0),
    description: existing?.description ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setErr(null);
    try {
      const method = existing ? 'PATCH' : 'POST';
      const url = existing ? `/api/consumables/${existing.id}` : '/api/consumables';
      const body = { ...form, reorderLevel: Number(form.reorderLevel) };
      const res = await authFetch(url, token, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json() as { error: { message: string } };
        setErr(d.error?.message ?? 'Save failed');
        return;
      }
      onSaved();
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{existing ? 'Edit Consumable' : 'New Consumable'}</h3>
        {err && <div className="alert alert-error">{err}</div>}
        {!existing && (
          <>
            <label>SKU *</label>
            <input value={form.sku} onChange={set('sku')} placeholder="e.g. TON-BLK-001" />
          </>
        )}
        <label>Name *</label>
        <input value={form.name} onChange={set('name')} />
        <label>Category</label>
        <select value={form.category} onChange={set('category')}>
          <option value="TONER">Toner</option>
          <option value="SPARE_PART">Spare Part</option>
          <option value="PAPER">Paper</option>
          <option value="OTHER">Other</option>
        </select>
        <label>Unit</label>
        <input value={form.unit} onChange={set('unit')} placeholder="e.g. cartridge, roll, ream" />
        <label>Reorder Level</label>
        <input type="number" min={0} value={form.reorderLevel} onChange={set('reorderLevel')} />
        <label>Description</label>
        <textarea rows={2} value={form.description} onChange={set('description')} />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StockAdjustModal({
  consumable, onClose, onSaved,
}: {
  consumable: Consumable;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { token } = useAuth();
  const [warehouseId, setWarehouseId] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/consumables/${consumable.id}/adjust`, token, {
        method: 'POST',
        body: JSON.stringify({ warehouseId: Number(warehouseId), delta: Number(delta), reason }),
      });
      if (!res.ok) {
        const d = await res.json() as { error: { message: string } };
        setErr(d.error?.message ?? 'Adjustment failed');
        return;
      }
      onSaved();
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Adjust Stock — {consumable.name}</h3>
        {err && <div className="alert alert-error">{err}</div>}
        <label>Warehouse ID *</label>
        <input type="number" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Warehouse ID" />
        <label>Delta (+ to add, − to remove) *</label>
        <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. 10 or -3" />
        <label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Used in field service" />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Adjust'}
          </button>
        </div>
      </div>
    </div>
  );
}

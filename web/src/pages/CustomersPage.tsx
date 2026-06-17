/**
 * Customer & Contract Management — Customers screen.
 *
 * Top-level: customer list with search/status filters and a banner for
 * contracts expiring within 90 days.
 * Drill-down: customer profile + sites + contacts + contracts. Selecting a
 * contract opens the shared ContractDetailView; creating one opens the
 * contract form.
 *
 * Every write action is gated by `can(PERM.*)` and re-enforced by the backend.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import {
  PERM,
  type Customer,
  type CustomerContact,
  type CustomerDetail,
  type CustomerSite,
  type CustomerStatus,
  type ContractSummary,
} from '../types';
import ContractDetailView, { Backdrop, ContractFormModal } from './ContractDetailView';
import { contractStatusBadge, fmtDate, fmtMoney, slaBadge } from './contract-format';

// ---------------------------------------------------------------------------
// CustomersPage — top-level list
// ---------------------------------------------------------------------------

export default function CustomersPage() {
  const { can } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (statusFilter) params.set('status', statusFilter);
      const data = await api.get<{ customers: Customer[] }>(`/customers?${params.toString()}`);
      setCustomers(data.customers);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [q, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange(message?: string) {
    setCreating(false);
    if (message) setNotice(message);
    void load();
  }

  if (selectedId != null) {
    return (
      <CustomerDetailView
        customerId={selectedId}
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
        <h2>Customers</h2>
        {can(PERM.customersCreate) && (
          <button className="btn" onClick={() => setCreating(true)}>
            + New customer
          </button>
        )}
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}
      {err && <div className="alert alert-error">{err}</div>}

      <div className="toolbar">
        <input
          placeholder="Search name, email or reg. no…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Reg. no</th>
              <th>Email</th>
              <th>Status</th>
              <th>Contracts</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No customers match the current filters.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.id}>
                <td>
                  <button className="link-btn" onClick={() => setSelectedId(c.id)}>
                    {c.name}
                  </button>
                </td>
                <td className="muted">{c.registrationNo ?? '—'}</td>
                <td className="muted">{c.email ?? '—'}</td>
                <td>
                  <span
                    className={
                      c.status === 'ACTIVE' ? 'badge badge-active' : 'badge badge-inactive'
                    }
                  >
                    {c.status}
                  </span>
                </td>
                <td className="muted">
                  {c.contractCount ?? 0}
                  {c.activeContractCount ? ` (${c.activeContractCount} active)` : ''}
                </td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSelectedId(c.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <CustomerFormModal
          onClose={() => setCreating(false)}
          onSaved={() => afterChange('Customer created.')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer detail
// ---------------------------------------------------------------------------

type DetailModal =
  | { kind: 'edit-customer' }
  | { kind: 'add-site' }
  | { kind: 'edit-site'; site: CustomerSite }
  | { kind: 'add-contact' }
  | { kind: 'edit-contact'; contact: CustomerContact }
  | { kind: 'create-contract' }
  | null;

function CustomerDetailView({ customerId, onBack }: { customerId: number; onBack: () => void }) {
  const { can } = useAuth();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<DetailModal>(null);
  const [openContractId, setOpenContractId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.get<CustomerDetail>(`/customers/${customerId}`);
      setDetail(data);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange(message?: string) {
    setModal(null);
    if (message) setNotice(message);
    void load();
  }

  async function deleteSite(site: CustomerSite) {
    if (!confirm(`Remove site "${site.name}"?`)) return;
    try {
      await api.delete(`/customers/${customerId}/sites/${site.id}`);
      afterChange('Site removed.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to remove site');
    }
  }

  async function deleteContact(contact: CustomerContact) {
    if (!confirm(`Remove contact "${contact.name}"?`)) return;
    try {
      await api.delete(`/customers/${customerId}/contacts/${contact.id}`);
      afterChange('Contact removed.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to remove contact');
    }
  }

  if (openContractId != null) {
    return (
      <ContractDetailView
        contractId={openContractId}
        onBack={() => {
          setOpenContractId(null);
          void load();
        }}
        onDeleted={() => {
          setOpenContractId(null);
          void load();
        }}
      />
    );
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (err && !detail) return <div className="alert alert-error">{err}</div>;
  if (!detail) return null;

  const { customer, sites, contacts, contracts } = detail;
  const canEdit = can(PERM.customersUpdate);

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            ← Back
          </button>
          <h2 style={{ margin: 0 }}>{customer.name}</h2>
          <span
            className={customer.status === 'ACTIVE' ? 'badge badge-active' : 'badge badge-inactive'}
          >
            {customer.status}
          </span>
        </div>
        <div className="row-actions">
          {canEdit && (
            <button
              className="btn btn-secondary"
              onClick={() => setModal({ kind: 'edit-customer' })}
            >
              Edit profile
            </button>
          )}
          {can(PERM.contractsCreate) && (
            <button className="btn" onClick={() => setModal({ kind: 'create-contract' })}>
              + Contract
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}
      {err && <div className="alert alert-error">{err}</div>}

      <div className="detail-grid">
        {/* Profile + billing */}
        <section className="detail-card">
          <h3>Company profile</h3>
          <dl className="detail-list">
            <dt>Registration no</dt>
            <dd>{customer.registrationNo ?? '—'}</dd>
            <dt>VAT no</dt>
            <dd>{customer.vatNo ?? '—'}</dd>
            <dt>Industry</dt>
            <dd>{customer.industry ?? '—'}</dd>
            <dt>Website</dt>
            <dd>{customer.website ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{customer.email ?? '—'}</dd>
            <dt>Phone</dt>
            <dd>{customer.phone ?? '—'}</dd>
          </dl>
          <h3 style={{ marginTop: '1rem' }}>Billing</h3>
          <dl className="detail-list">
            <dt>Billing address</dt>
            <dd>{customer.billingAddress ?? '—'}</dd>
            <dt>Billing email</dt>
            <dd>{customer.billingEmail ?? '—'}</dd>
            <dt>Billing phone</dt>
            <dd>{customer.billingPhone ?? '—'}</dd>
            {customer.notes && (
              <>
                <dt>Notes</dt>
                <dd>{customer.notes}</dd>
              </>
            )}
          </dl>
        </section>

        {/* Sites */}
        <section className="detail-card">
          <div className="card-head">
            <h3>Sites / locations</h3>
            {canEdit && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setModal({ kind: 'add-site' })}
              >
                + Add site
              </button>
            )}
          </div>
          {sites.length === 0 ? (
            <p className="muted">No sites recorded.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>City</th>
                  <th>Contact</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.name}
                      {s.isPrimary && (
                        <span className="badge badge-pending" style={{ marginLeft: 6 }}>
                          primary
                        </span>
                      )}
                    </td>
                    <td className="muted">{s.city ?? '—'}</td>
                    <td className="muted">
                      {s.contactName ?? '—'}
                      {s.contactPhone ? ` · ${s.contactPhone}` : ''}
                    </td>
                    {canEdit && (
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setModal({ kind: 'edit-site', site: s })}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void deleteSite(s)}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Contacts */}
        <section className="detail-card">
          <div className="card-head">
            <h3>Contacts</h3>
            {canEdit && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setModal({ kind: 'add-contact' })}
              >
                + Add contact
              </button>
            )}
          </div>
          {contacts.length === 0 ? (
            <p className="muted">No contacts recorded.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Email / phone</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name}
                      {c.isPrimary && (
                        <span className="badge badge-pending" style={{ marginLeft: 6 }}>
                          primary
                        </span>
                      )}
                    </td>
                    <td className="muted">{c.title ?? '—'}</td>
                    <td className="muted">
                      {c.email ?? '—'}
                      {c.phone ? ` · ${c.phone}` : ''}
                    </td>
                    {canEdit && (
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setModal({ kind: 'edit-contact', contact: c })}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void deleteContact(c)}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Contracts */}
        <section className="detail-card full">
          <h3>Contracts</h3>
          {contracts.length === 0 ? (
            <p className="muted">No contracts for this customer yet.</p>
          ) : (
            <ContractTable contracts={contracts} onOpen={setOpenContractId} />
          )}
        </section>
      </div>

      {modal?.kind === 'edit-customer' && (
        <CustomerFormModal
          existing={customer}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Customer updated.')}
        />
      )}
      {modal?.kind === 'add-site' && (
        <SiteFormModal
          customerId={customerId}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Site added.')}
        />
      )}
      {modal?.kind === 'edit-site' && (
        <SiteFormModal
          customerId={customerId}
          existing={modal.site}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Site updated.')}
        />
      )}
      {modal?.kind === 'add-contact' && (
        <ContactFormModal
          customerId={customerId}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Contact added.')}
        />
      )}
      {modal?.kind === 'edit-contact' && (
        <ContactFormModal
          customerId={customerId}
          existing={modal.contact}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Contact updated.')}
        />
      )}
      {modal?.kind === 'create-contract' && (
        <ContractFormModal
          customerId={customerId}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Draft contract created.')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable contract table (also used by ContractsPage)
// ---------------------------------------------------------------------------

export function ContractTable({
  contracts,
  onOpen,
  showCustomer = false,
}: {
  contracts: (ContractSummary & {
    customerName?: string | null;
    daysUntilExpiry?: number;
    expiringSoon?: boolean;
  })[];
  onOpen: (id: number) => void;
  showCustomer?: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Contract</th>
          {showCustomer && <th>Customer</th>}
          <th>Period</th>
          <th>Monthly</th>
          <th>SLA</th>
          <th>Status</th>
          <th>Doc</th>
        </tr>
      </thead>
      <tbody>
        {contracts.map((c) => (
          <tr key={c.id}>
            <td>
              <button className="link-btn" onClick={() => onOpen(c.id)}>
                {c.contractNo}
              </button>
            </td>
            {showCustomer && <td className="muted">{c.customerName ?? '—'}</td>}
            <td className="muted">
              {fmtDate(c.startDate)} → {fmtDate(c.endDate)}
              {c.expiringSoon && (
                <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                  {c.daysUntilExpiry}d left
                </span>
              )}
            </td>
            <td>{fmtMoney(c.monthlyLeaseFee)}</td>
            <td>
              <span className={slaBadge(c.slaTier)}>{c.slaTier}</span>
            </td>
            <td>
              <span className={contractStatusBadge(c.status)}>{c.status}</span>
            </td>
            <td>{c.hasDocument ? '📎' : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Customer form modal
// ---------------------------------------------------------------------------

function CustomerFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Customer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: existing?.name ?? '',
    registrationNo: existing?.registrationNo ?? '',
    vatNo: existing?.vatNo ?? '',
    industry: existing?.industry ?? '',
    website: existing?.website ?? '',
    email: existing?.email ?? '',
    phone: existing?.phone ?? '',
    billingAddress: existing?.billingAddress ?? '',
    billingEmail: existing?.billingEmail ?? '',
    billingPhone: existing?.billingPhone ?? '',
    notes: existing?.notes ?? '',
    status: (existing?.status ?? 'ACTIVE') as CustomerStatus,
  });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof f>(key: K, value: (typeof f)[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (!f.name.trim()) {
      setFormErr('Customer name is required');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: f.name.trim(),
        registrationNo: f.registrationNo.trim() || null,
        vatNo: f.vatNo.trim() || null,
        industry: f.industry.trim() || null,
        website: f.website.trim() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        billingAddress: f.billingAddress.trim() || null,
        billingEmail: f.billingEmail.trim() || null,
        billingPhone: f.billingPhone.trim() || null,
        notes: f.notes.trim() || null,
        status: f.status,
      };
      if (existing) {
        await api.patch(`/customers/${existing.id}`, payload);
      } else {
        await api.post('/customers', payload);
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
      <h3>{existing ? 'Edit customer' : 'New customer'}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="name">Company name</label>
        <input id="name" value={f.name} onChange={(e) => set('name', e.target.value)} required />
        <div className="form-row">
          <div>
            <label htmlFor="reg">Registration no</label>
            <input
              id="reg"
              value={f.registrationNo}
              onChange={(e) => set('registrationNo', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="vat">VAT no</label>
            <input id="vat" value={f.vatNo} onChange={(e) => set('vatNo', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div>
            <label htmlFor="ind">Industry</label>
            <input id="ind" value={f.industry} onChange={(e) => set('industry', e.target.value)} />
          </div>
          <div>
            <label htmlFor="web">Website</label>
            <input id="web" value={f.website} onChange={(e) => set('website', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div>
            <label htmlFor="em">Email</label>
            <input
              id="em"
              type="email"
              value={f.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ph">Phone</label>
            <input id="ph" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
        </div>

        <h4 style={{ marginBottom: '0.25rem' }}>Billing</h4>
        <label htmlFor="ba">Billing address</label>
        <textarea
          id="ba"
          rows={2}
          value={f.billingAddress}
          onChange={(e) => set('billingAddress', e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />
        <div className="form-row">
          <div>
            <label htmlFor="be">Billing email</label>
            <input
              id="be"
              type="email"
              value={f.billingEmail}
              onChange={(e) => set('billingEmail', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="bp">Billing phone</label>
            <input
              id="bp"
              value={f.billingPhone}
              onChange={(e) => set('billingPhone', e.target.value)}
            />
          </div>
        </div>

        {existing && (
          <>
            <label htmlFor="st">Status</label>
            <select
              id="st"
              value={f.status}
              onChange={(e) => set('status', e.target.value as CustomerStatus)}
            >
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </>
        )}

        <label htmlFor="nt">Notes</label>
        <textarea
          id="nt"
          rows={2}
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create customer'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Site form modal
// ---------------------------------------------------------------------------

function SiteFormModal({
  customerId,
  existing,
  onClose,
  onSaved,
}: {
  customerId: number;
  existing?: CustomerSite;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: existing?.name ?? '',
    address: existing?.address ?? '',
    city: existing?.city ?? '',
    postalCode: existing?.postalCode ?? '',
    contactName: existing?.contactName ?? '',
    contactPhone: existing?.contactPhone ?? '',
    isPrimary: existing?.isPrimary ?? false,
  });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof f>(key: K, value: (typeof f)[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (!f.name.trim()) {
      setFormErr('Site name is required');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: f.name.trim(),
        address: f.address.trim() || null,
        city: f.city.trim() || null,
        postalCode: f.postalCode.trim() || null,
        contactName: f.contactName.trim() || null,
        contactPhone: f.contactPhone.trim() || null,
        isPrimary: f.isPrimary,
      };
      if (existing) {
        await api.patch(`/customers/${customerId}/sites/${existing.id}`, payload);
      } else {
        await api.post(`/customers/${customerId}/sites`, payload);
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
      <h3>{existing ? 'Edit site' : 'Add site'}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="sn">Site name</label>
        <input id="sn" value={f.name} onChange={(e) => set('name', e.target.value)} required />
        <label htmlFor="sa">Address</label>
        <textarea
          id="sa"
          rows={2}
          value={f.address}
          onChange={(e) => set('address', e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />
        <div className="form-row">
          <div>
            <label htmlFor="sc">City</label>
            <input id="sc" value={f.city} onChange={(e) => set('city', e.target.value)} />
          </div>
          <div>
            <label htmlFor="spc">Postal code</label>
            <input
              id="spc"
              value={f.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div>
            <label htmlFor="scn">Contact name</label>
            <input
              id="scn"
              value={f.contactName}
              onChange={(e) => set('contactName', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="scp">Contact phone</label>
            <input
              id="scp"
              value={f.contactPhone}
              onChange={(e) => set('contactPhone', e.target.value)}
            />
          </div>
        </div>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.5rem' }}
        >
          <input
            type="checkbox"
            checked={f.isPrimary}
            onChange={(e) => set('isPrimary', e.target.checked)}
            style={{ width: 'auto' }}
          />
          Primary site
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Contact form modal
// ---------------------------------------------------------------------------

function ContactFormModal({
  customerId,
  existing,
  onClose,
  onSaved,
}: {
  customerId: number;
  existing?: CustomerContact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: existing?.name ?? '',
    title: existing?.title ?? '',
    email: existing?.email ?? '',
    phone: existing?.phone ?? '',
    isPrimary: existing?.isPrimary ?? false,
  });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof f>(key: K, value: (typeof f)[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (!f.name.trim()) {
      setFormErr('Contact name is required');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: f.name.trim(),
        title: f.title.trim() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        isPrimary: f.isPrimary,
      };
      if (existing) {
        await api.patch(`/customers/${customerId}/contacts/${existing.id}`, payload);
      } else {
        await api.post(`/customers/${customerId}/contacts`, payload);
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
      <h3>{existing ? 'Edit contact' : 'Add contact'}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="cn">Name</label>
        <input id="cn" value={f.name} onChange={(e) => set('name', e.target.value)} required />
        <label htmlFor="ctitle">Title</label>
        <input id="ctitle" value={f.title} onChange={(e) => set('title', e.target.value)} />
        <div className="form-row">
          <div>
            <label htmlFor="cem">Email</label>
            <input
              id="cem"
              type="email"
              value={f.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="cph">Phone</label>
            <input id="cph" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
        </div>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.5rem' }}
        >
          <input
            type="checkbox"
            checked={f.isPrimary}
            onChange={(e) => set('isPrimary', e.target.checked)}
            style={{ width: 'auto' }}
          />
          Primary contact
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

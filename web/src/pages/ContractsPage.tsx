/**
 * Contracts screen — a portfolio view across all customers.
 *
 * Headline feature: contracts expiring within 90 days are surfaced in a
 * banner and a one-click filter so renewals are never missed. Selecting a
 * contract opens the shared ContractDetailView.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, type Contract, type ContractStatus } from '../types';
import ContractDetailView from './ContractDetailView';
import { ContractTable } from './CustomersPage';

const STATUSES: ContractStatus[] = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'];

export default function ContractsPage() {
  const { can } = useAuth();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [expiringCount, setExpiringCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (expiringOnly) params.set('expiring', '1');
      if (q) params.set('q', q);
      const data = await api.get<{ contracts: Contract[] }>(`/contracts?${params.toString()}`);
      setContracts(data.contracts);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load contracts');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, expiringOnly, q]);

  useEffect(() => {
    void load();
  }, [load]);

  // Separate, always-on count of contracts expiring in the next 90 days.
  const loadExpiring = useCallback(async () => {
    try {
      const data = await api.get<{ contracts: Contract[] }>('/contracts/expiring');
      setExpiringCount(data.contracts.length);
    } catch {
      // Non-fatal; the banner just won't show.
    }
  }, []);

  useEffect(() => {
    void loadExpiring();
  }, [loadExpiring]);

  if (openId != null) {
    return (
      <ContractDetailView
        contractId={openId}
        onBack={() => {
          setOpenId(null);
          void load();
          void loadExpiring();
        }}
        onDeleted={() => {
          setOpenId(null);
          void load();
        }}
      />
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Contracts</h2>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      {expiringCount > 0 && (
        <div
          className="alert alert-info"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>
            <strong>{expiringCount}</strong> active contract{expiringCount === 1 ? '' : 's'}{' '}
            expiring within the next 90 days.
          </span>
          {!expiringOnly && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setExpiringOnly(true);
                setStatusFilter('');
              }}
            >
              Show expiring
            </button>
          )}
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Search contract no or customer…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setExpiringOnly(false);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <input
            type="checkbox"
            checked={expiringOnly}
            onChange={(e) => setExpiringOnly(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Expiring ≤ 90 days
        </label>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : contracts.length === 0 ? (
        <p className="muted">No contracts match the current filters.</p>
      ) : (
        <ContractTable
          contracts={contracts.map((c) => ({
            id: c.id,
            contractNo: c.contractNo,
            startDate: c.startDate,
            endDate: c.endDate,
            monthlyLeaseFee: c.monthlyLeaseFee,
            perClickBw: c.perClickBw,
            perClickColour: c.perClickColour,
            slaTier: c.slaTier,
            status: c.status,
            hasDocument: false,
            customerName: c.customerName,
            daysUntilExpiry: c.daysUntilExpiry,
            expiringSoon: c.expiringSoon,
          }))}
          onOpen={setOpenId}
          showCustomer
        />
      )}

      {!can(PERM.contractsRead) && (
        <p className="muted">You do not have permission to view contracts.</p>
      )}
    </div>
  );
}

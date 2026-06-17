/**
 * Audit log screen. Read-only, paginated view of every recorded change with
 * optional filters by entity type and action. Requires the `audit.read`
 * permission (System Administrator and CEO).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { AuditEntry } from '../types';

const PAGE_SIZE = 50;

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (entityType) params.set('entityType', entityType);
      if (action) params.set('action', action);
      const data = await api.get<{ entries: AuditEntry[]; total: number }>(
        `/audit?${params.toString()}`,
      );
      setEntries(data.entries);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [offset, entityType, action]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset to first page whenever a filter changes.
  useEffect(() => {
    setOffset(0);
  }, [entityType, action]);

  return (
    <div>
      <div className="page-header">
        <h2>Audit log</h2>
      </div>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="toolbar">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          <option value="">All entities</option>
          <option value="user">User</option>
          <option value="auth">Auth</option>
        </select>
        <input
          placeholder="Action (e.g. login, update)…"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Entity</th>
                <th>Action</th>
                <th>Reason</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No audit entries.
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.actorEmail ?? '—'}</td>
                  <td>
                    {e.entityType}
                    {e.entityId ? ` #${e.entityId}` : ''}
                  </td>
                  <td>{e.action}</td>
                  <td>{e.reason ?? '—'}</td>
                  <td>
                    {e.changes ? (
                      <pre className="changes">{JSON.stringify(e.changes, null, 1)}</pre>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
            <span className="muted">
              Showing {entries.length ? offset + 1 : 0}–{offset + entries.length} of {total}
            </span>
            <div className="row-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

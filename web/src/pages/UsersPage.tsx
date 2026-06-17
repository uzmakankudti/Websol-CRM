/**
 * User management screen (System Administrator).
 *
 * Lists users with search / role / status filters and offers create, edit,
 * deactivate, reactivate and password-reset actions. Each action is gated by
 * the caller's permissions via `can(...)`, and write actions are only rendered
 * for users who hold them — the backend enforces the same rules.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM } from '../types';
import type { Role, User } from '../types';

type Modal =
  | { kind: 'create' }
  | { kind: 'edit'; user: User }
  | { kind: 'deactivate'; user: User }
  | { kind: 'reactivate'; user: User }
  | { kind: 'reset'; user: User }
  | null;

export default function UsersPage() {
  const { can, user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState('');

  // Filters
  const [q, setQ] = useState('');
  const [roleId, setRoleId] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (roleId) params.set('roleId', roleId);
      if (status) params.set('active', status);
      const data = await api.get<{ users: User[] }>(`/users?${params.toString()}`);
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [q, roleId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (can(PERM.rolesRead)) {
      api
        .get<{ roles: Role[] }>('/roles')
        .then((d) => setRoles(d.roles))
        .catch(() => undefined);
    }
  }, [can]);

  function afterChange(message?: string) {
    setModal(null);
    if (message) setNotice(message);
    void load();
  }

  return (
    <div>
      <div className="page-header">
        <h2>Users</h2>
        {can(PERM.usersCreate) && (
          <button className="btn" onClick={() => setModal({ kind: 'create' })}>
            + New user
          </button>
        )}
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="toolbar">
        <input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No users match the current filters.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.fullName}
                  {u.mustChangePassword && <div className="muted">must change password</div>}
                </td>
                <td>{u.email}</td>
                <td>{u.role.name}</td>
                <td>
                  <span className={`badge ${u.isActive ? 'badge-active' : 'badge-inactive'}`}>
                    {u.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="muted">{formatDate(u.lastLoginAt)}</td>
                <td>
                  <div className="row-actions">
                    {can(PERM.usersUpdate) && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setModal({ kind: 'edit', user: u })}
                      >
                        Edit
                      </button>
                    )}
                    {can(PERM.usersResetPassword) && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setModal({ kind: 'reset', user: u })}
                      >
                        Reset password
                      </button>
                    )}
                    {can(PERM.usersDeactivate) &&
                      (u.isActive ? (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={u.id === me?.id}
                          title={u.id === me?.id ? 'You cannot deactivate yourself' : undefined}
                          onClick={() => setModal({ kind: 'deactivate', user: u })}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => setModal({ kind: 'reactivate', user: u })}
                        >
                          Reactivate
                        </button>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal?.kind === 'create' && (
        <UserFormModal roles={roles} onClose={() => setModal(null)} onSaved={afterChange} />
      )}
      {modal?.kind === 'edit' && (
        <UserFormModal
          roles={roles}
          existing={modal.user}
          onClose={() => setModal(null)}
          onSaved={afterChange}
        />
      )}
      {modal?.kind === 'deactivate' && (
        <ReasonModal
          title={`Deactivate ${modal.user.fullName}`}
          description="The account is retained for audit history (BR-018) and can be reactivated later. A reason is required."
          confirmLabel="Deactivate"
          danger
          requireReason
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await api.post(`/users/${modal.user.id}/deactivate`, { reason });
            afterChange('User deactivated.');
          }}
        />
      )}
      {modal?.kind === 'reactivate' && (
        <ReasonModal
          title={`Reactivate ${modal.user.fullName}`}
          description="Re-enable sign-in for this account."
          confirmLabel="Reactivate"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await api.post(`/users/${modal.user.id}/reactivate`, { reason });
            afterChange('User reactivated.');
          }}
        />
      )}
      {modal?.kind === 'reset' && (
        <ResetPasswordModal user={modal.user} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

// --- Create / edit modal ------------------------------------------------------
function UserFormModal({
  roles,
  existing,
  onClose,
  onSaved,
}: {
  roles: Role[];
  existing?: User;
  onClose: () => void;
  onSaved: (message?: string) => void;
}) {
  const [fullName, setFullName] = useState(existing?.fullName ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [roleId, setRoleId] = useState<string>(existing ? String(existing.role.id) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!roleId) {
      setError('Please choose a role');
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        await api.patch(`/users/${existing.id}`, {
          fullName,
          phone: phone || null,
          roleId: Number(roleId),
        });
        onSaved('User updated.');
      } else {
        const res = await api.post<{ temporaryPassword?: string }>('/users', {
          email,
          fullName,
          phone: phone || null,
          roleId: Number(roleId),
        });
        if (res.temporaryPassword) {
          // Show the temporary password once before closing.
          setTempPassword(res.temporaryPassword);
        } else {
          onSaved('User created.');
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  if (tempPassword) {
    return (
      <Backdrop onClose={() => onSaved('User created.')}>
        <h3>User created</h3>
        <p>Share this temporary password securely. The user must change it at first login.</p>
        <code className="token">{tempPassword}</code>
        <div className="modal-actions">
          <button className="btn" onClick={() => onSaved('User created.')}>
            Done
          </button>
        </div>
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>{existing ? 'Edit user' : 'New user'}</h3>
      {error && <div className="alert alert-error">{error}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="fn">Full name</label>
        <input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        <label htmlFor="em">Email</label>
        <input
          id="em"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={!!existing}
        />
        <label htmlFor="ph">Phone</label>
        <input id="ph" value={phone ?? ''} onChange={(e) => setPhone(e.target.value)} />
        <label htmlFor="rl">Role</label>
        <select id="rl" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
          <option value="">Select a role…</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {!existing && (
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            A temporary password is generated automatically and shown once after creation.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create user'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// --- Reason modal (deactivate / reactivate) -----------------------------------
function ReasonModal({
  title,
  description,
  confirmLabel,
  danger,
  requireReason,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (requireReason && !reason.trim()) {
      setError('A reason is required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      {error && <div className="alert alert-error">{error}</div>}
      <label htmlFor="reason">Reason{requireReason ? '' : ' (optional)'}</label>
      <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={confirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Backdrop>
  );
}

// --- Admin reset-password modal -----------------------------------------------
function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [temp, setTemp] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ temporaryPassword: string }>(`/users/${user.id}/reset-password`);
      setTemp(res.temporaryPassword);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Reset password — {user.fullName}</h3>
      {error && <div className="alert alert-error">{error}</div>}
      {temp ? (
        <>
          <p>Share this temporary password securely. The user must change it at next login.</p>
          <code className="token">{temp}</code>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            This generates a new temporary password and forces a change at next login.
          </p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" onClick={run} disabled={busy}>
              {busy ? 'Resetting…' : 'Generate new password'}
            </button>
          </div>
        </>
      )}
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/**
 * Change-password screen. Shown full-screen when the user must change their
 * password (first login / after an admin reset), and also reachable from the
 * nav for a voluntary change.
 */
import { useState } from 'react';
import { useAuth } from './context';
import { api, ApiError } from '../api/client';

export default function ChangePassword({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) {
      setError('New password and confirmation do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setDone(true);
      await refresh(); // clears mustChangePassword on the user object
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to change password');
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={onSubmit}>
      <h2>{forced ? 'Set a new password' : 'Change password'}</h2>
      {forced && (
        <div className="alert alert-info">You must set a new password before continuing.</div>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {done && <div className="alert alert-success">Password updated.</div>}

      <label htmlFor="cur">Current password</label>
      <input
        id="cur"
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <label htmlFor="new">New password</label>
      <input
        id="new"
        type="password"
        value={newPassword}
        onChange={(e) => setNew(e.target.value)}
        required
      />
      <label htmlFor="conf">Confirm new password</label>
      <input
        id="conf"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      <p className="muted">At least 8 characters, including a letter and a number.</p>
      <button className="btn full" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Update password'}
      </button>
      {forced && (
        <p style={{ marginTop: '1rem' }}>
          <button type="button" className="link-btn" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
      )}
    </form>
  );

  // Forced changes take over the screen; voluntary changes render inline.
  return forced ? (
    <div className="center-screen">
      <div className="card">{form}</div>
    </div>
  ) : (
    <div className="card" style={{ margin: '0' }}>
      {form}
    </div>
  );
}

/**
 * Login screen, plus the "forgot password" and "reset password" flows reachable
 * from it. Kept in one file because they share the same centred card layout and
 * are only used when signed out.
 */
import { useState } from 'react';
import { useAuth } from './context';
import { api, ApiError } from '../api/client';

type Mode = 'login' | 'forgot' | 'reset';

export default function Login() {
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>('login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  function reset(next: Mode) {
    setError('');
    setInfo('');
    setMode(next);
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      // On success the app re-renders; nothing else to do here.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  async function onForgot(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const res = await api.post<{ message: string; resetToken?: string }>(
        '/auth/forgot-password',
        { email },
      );
      // In dev the backend returns the token so the flow is testable.
      if (res.resetToken) {
        setToken(res.resetToken);
        setInfo('Reset token issued (dev mode). Continue below to set a new password.');
        setMode('reset');
      } else {
        setInfo(res.message);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  async function onReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword });
      setInfo('Password updated. You can now sign in.');
      setPassword('');
      setMode('login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="card">
        <h2>Websol CRM</h2>
        <p className="muted">User &amp; Access Management</p>

        {error && <div className="alert alert-error">{error}</div>}
        {info && <div className="alert alert-info">{info}</div>}

        {mode === 'login' && (
          <form onSubmit={onLogin}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className="btn full" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p style={{ marginTop: '1rem' }}>
              <button type="button" className="link-btn" onClick={() => reset('forgot')}>
                Forgot your password?
              </button>
            </p>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={onForgot}>
            <label htmlFor="femail">Email</label>
            <input
              id="femail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button className="btn full" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <p style={{ marginTop: '1rem' }}>
              <button type="button" className="link-btn" onClick={() => reset('login')}>
                Back to sign in
              </button>
            </p>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={onReset}>
            <label htmlFor="token">Reset token</label>
            <input id="token" value={token} onChange={(e) => setToken(e.target.value)} required />
            <label htmlFor="np">New password</label>
            <input
              id="np"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <p className="muted">At least 8 characters, including a letter and a number.</p>
            <button className="btn full" type="submit" disabled={busy}>
              {busy ? 'Updating…' : 'Set new password'}
            </button>
            <p style={{ marginTop: '1rem' }}>
              <button type="button" className="link-btn" onClick={() => reset('login')}>
                Back to sign in
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

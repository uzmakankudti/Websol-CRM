/**
 * Authentication state for the whole app.
 *
 * Holds the current user (with their permission list), exposes login/logout,
 * and a `can(permission)` helper that screens/nav use so each role only sees
 * what it should. On mount it restores the session from a stored token by
 * calling /auth/me.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearToken, setToken, getToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../types';
import { AuthCtx } from './context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<{ user: User }>('/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    clearToken();
    setUser(null);
  }, []);

  // Wire the client's 401 handler to clear local auth state.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setUser(null);
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    setToken(data.token);
    setUser(data.user);
  }, []);

  const can = useCallback(
    (permission: string) => !!user?.permissions?.includes(permission),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh, can }),
    [user, loading, login, logout, refresh, can],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

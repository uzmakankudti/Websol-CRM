/**
 * Auth context object and the `useAuth` hook, kept in a non-component module so
 * the provider file can fast-refresh cleanly (it then only exports a component).
 */
import { createContext, useContext } from 'react';
import type { User } from '../types';

export interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

export const AuthCtx = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

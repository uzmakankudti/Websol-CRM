/**
 * Role-based access control.
 *
 * `requireAuth` validates the bearer token and returns the caller's context;
 * `requirePermission` asserts a specific capability. Authorisation is by
 * permission code (see migration 002), never by hardcoded role checks — that
 * keeps "each role sees only what it should" data-driven.
 */
import { HttpRequest } from '@azure/functions';
import { verifyToken, TokenPayload } from './auth';
import { HttpError } from './http';

export interface AuthContext {
  userId: number;
  email: string;
  role: string;
  perms: string[];
}

/** Permission codes used across this module (kept in sync with migrations 002–003). */
export const PERMISSIONS = {
  usersRead: 'users.read',
  usersCreate: 'users.create',
  usersUpdate: 'users.update',
  usersDeactivate: 'users.deactivate',
  usersResetPassword: 'users.reset_password',
  rolesRead: 'roles.read',
  auditRead: 'audit.read',
  leadsRead: 'leads.read',
  leadsCreate: 'leads.create',
  leadsUpdate: 'leads.update',
  leadsChangeStage: 'leads.change_stage',
  leadsConvert: 'leads.convert',
  quotationsCreate: 'quotations.create',
  quotationsApprove: 'quotations.approve',
} as const;

/** Extract and verify the bearer token; throws 401 if missing/invalid. */
export function requireAuth(request: HttpRequest): AuthContext {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
  }
  const payload: TokenPayload | null = verifyToken(match[1]);
  if (!payload) {
    throw new HttpError(401, 'Session expired or invalid; please sign in again', 'UNAUTHENTICATED');
  }
  return { userId: payload.sub, email: payload.email, role: payload.role, perms: payload.perms };
}

/** Assert the caller holds a permission; throws 403 otherwise. */
export function requirePermission(ctx: AuthContext, permission: string): void {
  if (!ctx.perms.includes(permission)) {
    throw new HttpError(403, 'You do not have permission to perform this action', 'FORBIDDEN');
  }
}

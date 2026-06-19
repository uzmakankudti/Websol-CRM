/**
 * Role-based access control.
 *
 * `requireAuth` validates the bearer token and returns the caller's context;
 * `requirePermission` asserts a specific capability. Authorisation is by
 * permission code (see migration 002), never by hardcoded role checks — that
 * keeps "each role sees only what it should" data-driven.
 */
import { HttpRequest } from '@azure/functions';
import { verifyToken, verifyCustomerToken, TokenPayload } from './auth';
import { HttpError } from './http';

export interface AuthContext {
  userId: number;
  email: string;
  role: string;
  perms: string[];
}

/**
 * A logged-in customer-portal session. Deliberately has NO `perms` — a
 * customer can never satisfy `requirePermission`, so staff endpoints are
 * closed to them. `customerId` is the only company whose data they may read,
 * and it comes from the signed token, never from the request.
 */
export interface CustomerContext {
  contactId: number;
  customerId: number;
  email: string;
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
  customersRead: 'customers.read',
  customersCreate: 'customers.create',
  customersUpdate: 'customers.update',
  contractsRead: 'contracts.read',
  contractsCreate: 'contracts.create',
  contractsUpdate: 'contracts.update',
  contractsActivate: 'contracts.activate',
  contractsTerminate: 'contracts.terminate',
  printersRead: 'printers.read',
  printersCreate: 'printers.create',
  printersUpdate: 'printers.update',
  printersManageStatus: 'printers.manage_status',
  inventoryRead: 'inventory.read',
  inventoryGrn: 'inventory.grn',
  inventoryAdjust: 'inventory.adjust',
  inventoryAllocate: 'inventory.allocate',
  dispatchRead: 'dispatch.read',
  dispatchCreate: 'dispatch.create',
  dispatchUpdate: 'dispatch.update',
  dispatchDeliver: 'dispatch.deliver',
  serviceRead: 'service.read',
  serviceCreate: 'service.create',
  serviceAssign: 'service.assign',
  serviceUpdate: 'service.update',
  serviceClose: 'service.close',
  serviceEscalate: 'service.escalate',
  serviceResolve: 'service.resolve',
  serviceReopen: 'service.reopen',
  helpdeskManage: 'helpdesk.manage',
  tonerRead:   'toner.read',
  tonerUpdate: 'toner.update',
  tonerManage: 'toner.manage',
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

/**
 * Validate a customer-portal bearer token and return the customer session.
 * Throws 401 if missing/invalid, or if a *staff* token is presented here —
 * staff tokens are not `aud:'customer'` and are rejected by design.
 */
export function requireCustomer(request: HttpRequest): CustomerContext {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw new HttpError(401, 'Customer sign-in required', 'UNAUTHENTICATED');
  }
  const payload = verifyCustomerToken(match[1]);
  if (!payload) {
    throw new HttpError(401, 'Session expired or invalid; please sign in again', 'UNAUTHENTICATED');
  }
  return { contactId: payload.sub, customerId: payload.cid, email: payload.email };
}

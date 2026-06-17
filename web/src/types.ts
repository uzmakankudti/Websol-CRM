/** Shared frontend types mirroring the backend's public shapes. */

export interface Role {
  id: number;
  code: string;
  name: string;
  description?: string | null;
}

export interface User {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only present on the logged-in user (from /auth/me & /auth/login). */
  permissions?: string[];
}

export interface AuditEntry {
  id: number;
  actorUserId: number | null;
  actorEmail: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  reason: string | null;
  changes: unknown;
  ipAddress: string | null;
  createdAt: string;
}

/** Permission codes used by the UI to gate navigation and actions. */
export const PERM = {
  usersRead: 'users.read',
  usersCreate: 'users.create',
  usersUpdate: 'users.update',
  usersDeactivate: 'users.deactivate',
  usersResetPassword: 'users.reset_password',
  rolesRead: 'roles.read',
  auditRead: 'audit.read',
} as const;

/**
 * Data access for users, roles and permissions. Shared by the auth and
 * user-management functions so the SQL lives in one place.
 */
import { RowDataPacket } from 'mysql2';
import { query } from './db';

export interface UserRow extends RowDataPacket {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  password_hash: string;
  role_id: number;
  role_code: string;
  role_name: string;
  is_active: 0 | 1;
  must_change_password: 0 | 1;
  last_login_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

const USER_SELECT = `
  SELECT u.*, r.code AS role_code, r.name AS role_name
  FROM users u
  JOIN roles r ON r.id = u.role_id`;

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await query<UserRow[]>(`${USER_SELECT} WHERE u.email = ? LIMIT 1`, [email]);
  return rows[0];
}

export async function findUserById(id: number): Promise<UserRow | undefined> {
  const rows = await query<UserRow[]>(`${USER_SELECT} WHERE u.id = ? LIMIT 1`, [id]);
  return rows[0];
}

/** Permission codes granted to a role. */
export async function getPermissionsForRole(roleId: number): Promise<string[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT p.code
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?`,
    [roleId],
  );
  return rows.map((r) => r.code as string);
}

/** Public-safe view of a user row (no password hash). */
export function toPublicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    phone: u.phone,
    role: { id: u.role_id, code: u.role_code, name: u.role_name },
    isActive: !!u.is_active,
    mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

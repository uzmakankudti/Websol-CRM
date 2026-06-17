/**
 * User management endpoints. All require a System Administrator (the only role
 * holding the relevant permissions — BR-019). Users are never deleted; they are
 * deactivated (BR-018), so there is deliberately no DELETE route.
 *
 *   GET   /api/users                     list users (filter: active, roleId, q)
 *   GET   /api/users/{id}                single user
 *   POST  /api/users                     create user           (users.create)
 *   PATCH /api/users/{id}                update name/phone/role (users.update)
 *   POST  /api/users/{id}/deactivate     deactivate (reason)   (users.deactivate)
 *   POST  /api/users/{id}/reactivate     reactivate            (users.deactivate)
 *   POST  /api/users/{id}/reset-password admin password reset  (users.reset_password)
 *   GET   /api/roles                     list roles            (roles.read)
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import crypto from 'crypto';
import { query } from '../shared/db';
import { hashPassword } from '../shared/auth';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';
import { findUserById, toPublicUser, UserRow } from '../shared/users-repo';

const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateTempPassword(): string {
  // 12 url-safe chars, guaranteed to satisfy the strength rule (letters+digits).
  return 'Ab1' + crypto.randomBytes(9).toString('base64url').slice(0, 9);
}

/** Resolve a {id} route param to a positive integer or throw 400. */
function userIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid user id');
  return id;
}

// --- GET /api/users -----------------------------------------------------------
export const listUsers = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const active = request.query.get('active');
  if (active === 'true' || active === 'false') {
    where.push('u.is_active = ?');
    params.push(active === 'true' ? 1 : 0);
  }
  const roleId = request.query.get('roleId');
  if (roleId) {
    where.push('u.role_id = ?');
    params.push(Number(roleId));
  }
  const q = request.query.get('q');
  if (q) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const rows = await query<UserRow[]>(
    `SELECT u.*, r.code AS role_code, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.full_name ASC`,
    params,
  );
  return json(200, { users: rows.map(toPublicUser) });
});

// --- GET /api/users/{id} ------------------------------------------------------
export const getUser = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersRead);
  const user = await findUserById(userIdParam(request));
  if (!user) return error(404, 'User not found');
  return json(200, { user: toPublicUser(user) });
});

// --- POST /api/users ----------------------------------------------------------
export const createUser = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersCreate); // BR-019

  const body = await readJson<{
    email?: string;
    fullName?: string;
    phone?: string;
    roleId?: number;
    roleCode?: string;
    password?: string;
  }>(request);

  const email = body.email?.trim().toLowerCase();
  if (!email || !EMAIL_RULE.test(email)) return error(400, 'A valid email is required');
  if (!body.fullName?.trim()) return error(400, 'Full name is required');

  // Resolve role by id or code.
  const roleRows = await query<RowDataPacket[]>(
    `SELECT id, code, name FROM roles WHERE id = ? OR code = ? LIMIT 1`,
    [body.roleId ?? null, body.roleCode ?? null],
  );
  const role = roleRows[0];
  if (!role) return error(400, 'A valid role is required');

  const existing = await query<RowDataPacket[]>(`SELECT id FROM users WHERE email = ? LIMIT 1`, [
    email,
  ]);
  if (existing.length) return error(409, 'A user with that email already exists', 'EMAIL_TAKEN');

  // Admin may supply an initial password; otherwise we generate a temporary one.
  const tempPassword = body.password?.trim() || generateTempPassword();

  const result = await query<ResultSetHeader>(
    `INSERT INTO users (email, full_name, phone, password_hash, role_id, is_active, must_change_password, created_by)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
    [
      email,
      body.fullName.trim(),
      body.phone?.trim() || null,
      hashPassword(tempPassword),
      role.id,
      ctx.userId,
    ],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'user',
    entityId: result.insertId,
    action: 'create',
    reason: 'New user provisioned',
    changes: { after: { email, fullName: body.fullName.trim(), role: role.code } },
    ipAddress: clientIp(request),
  });

  const created = await findUserById(result.insertId);
  return json(201, {
    user: created ? toPublicUser(created) : null,
    // Returned once so the admin can pass the temporary password to the user.
    temporaryPassword: body.password ? undefined : tempPassword,
  });
});

// --- PATCH /api/users/{id} ----------------------------------------------------
export const updateUser = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersUpdate);
  const id = userIdParam(request);

  const existing = await findUserById(id);
  if (!existing) return error(404, 'User not found');

  const body = await readJson<{
    fullName?: string;
    phone?: string | null;
    roleId?: number;
    roleCode?: string;
  }>(request);

  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  if (body.fullName !== undefined) {
    if (!body.fullName.trim()) return error(400, 'Full name cannot be empty');
    sets.push('full_name = ?');
    params.push(body.fullName.trim());
    after.fullName = body.fullName.trim();
  }
  if (body.phone !== undefined) {
    sets.push('phone = ?');
    params.push(body.phone?.trim() || null);
    after.phone = body.phone?.trim() || null;
  }
  if (body.roleId !== undefined || body.roleCode !== undefined) {
    const roleRows = await query<RowDataPacket[]>(
      `SELECT id, code FROM roles WHERE id = ? OR code = ? LIMIT 1`,
      [body.roleId ?? null, body.roleCode ?? null],
    );
    if (!roleRows[0]) return error(400, 'A valid role is required');
    sets.push('role_id = ?');
    params.push(roleRows[0].id);
    after.role = roleRows[0].code;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'user',
    entityId: id,
    action: 'update',
    changes: {
      before: { fullName: existing.full_name, phone: existing.phone, role: existing.role_code },
      after,
    },
    ipAddress: clientIp(request),
  });

  const updated = await findUserById(id);
  return json(200, { user: updated ? toPublicUser(updated) : null });
});

// --- POST /api/users/{id}/deactivate -----------------------------------------
export const deactivateUser = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersDeactivate); // BR-019
  const id = userIdParam(request);

  if (id === ctx.userId) return error(400, 'You cannot deactivate your own account');

  const user = await findUserById(id);
  if (!user) return error(404, 'User not found');

  const { reason } = await readJson<{ reason?: string }>(request);
  if (!reason?.trim()) return error(400, 'A reason is required to deactivate a user');

  if (!user.is_active) return json(200, { user: toPublicUser(user) }); // already inactive

  // BR-018: soft state change only; the row is retained.
  await query(
    `UPDATE users SET is_active = 0, deactivated_at = NOW(), deactivated_by = ? WHERE id = ?`,
    [ctx.userId, id],
  );
  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'user',
    entityId: id,
    action: 'deactivate',
    reason: reason.trim(),
    changes: { before: { isActive: true }, after: { isActive: false } },
    ipAddress: clientIp(request),
  });

  const updated = await findUserById(id);
  return json(200, { user: updated ? toPublicUser(updated) : null });
});

// --- POST /api/users/{id}/reactivate -----------------------------------------
export const reactivateUser = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.usersDeactivate);
  const id = userIdParam(request);

  const user = await findUserById(id);
  if (!user) return error(404, 'User not found');

  const { reason } = await readJson<{ reason?: string }>(request);
  if (user.is_active) return json(200, { user: toPublicUser(user) });

  await query(
    `UPDATE users SET is_active = 1, deactivated_at = NULL, deactivated_by = NULL, failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    [id],
  );
  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'user',
    entityId: id,
    action: 'reactivate',
    reason: reason?.trim() || 'Account reactivated',
    changes: { before: { isActive: false }, after: { isActive: true } },
    ipAddress: clientIp(request),
  });

  const updated = await findUserById(id);
  return json(200, { user: updated ? toPublicUser(updated) : null });
});

// --- POST /api/users/{id}/reset-password -------------------------------------
// Admin-initiated reset: sets a new temporary password and forces a change at
// next login. The temporary password is returned once for the admin to relay.
export const adminResetPassword = handle(
  async (request: HttpRequest): Promise<HttpResponseInit> => {
    const ctx = requireAuth(request);
    requirePermission(ctx, PERMISSIONS.usersResetPassword);
    const id = userIdParam(request);

    const user = await findUserById(id);
    if (!user) return error(404, 'User not found');

    const tempPassword = generateTempPassword();
    await query(
      `UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?`,
      [hashPassword(tempPassword), id],
    );
    await writeAudit({
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      entityType: 'user',
      entityId: id,
      action: 'admin_reset_password',
      reason: 'Administrator reset password',
      ipAddress: clientIp(request),
    });
    return json(200, { ok: true, temporaryPassword: tempPassword });
  },
);

// --- GET /api/roles -----------------------------------------------------------
export const listRoles = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.rolesRead);
  const rows = await query<RowDataPacket[]>(
    `SELECT id, code, name, description FROM roles ORDER BY name ASC`,
  );
  return json(200, { roles: rows });
});

app.http('users-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'users',
  handler: listUsers,
});
app.http('users-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'users',
  handler: createUser,
});
app.http('users-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'users/{id}',
  handler: getUser,
});
app.http('users-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'users/{id}',
  handler: updateUser,
});
app.http('users-deactivate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'users/{id}/deactivate',
  handler: deactivateUser,
});
app.http('users-reactivate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'users/{id}/reactivate',
  handler: reactivateUser,
});
app.http('users-reset-password', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'users/{id}/reset-password',
  handler: adminResetPassword,
});
app.http('roles-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'roles',
  handler: listRoles,
});

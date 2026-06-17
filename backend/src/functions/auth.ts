/**
 * Authentication endpoints.
 *
 *   POST /api/auth/login            email + password  -> { token, user }
 *   POST /api/auth/logout           (stateless JWT; client discards token)
 *   GET  /api/auth/me               current user from bearer token
 *   POST /api/auth/change-password  change own password (current + new)
 *   POST /api/auth/forgot-password  request a reset token (always 200)
 *   POST /api/auth/reset-password   consume a reset token + set new password
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  generateResetToken,
  hashToken,
} from '../shared/auth';
import { requireAuth } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp } from '../shared/http';
import {
  findUserByEmail,
  findUserById,
  getPermissionsForRole,
  toPublicUser,
} from '../shared/users-repo';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 30;
// Minimum password strength: at least 8 chars, one letter and one number.
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

function passwordIsStrong(pw: unknown): pw is string {
  return typeof pw === 'string' && PASSWORD_RULE.test(pw);
}

// --- POST /api/auth/login -----------------------------------------------------
export const login = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const { email, password } = await readJson<{ email?: string; password?: string }>(request);
  const ip = clientIp(request);

  if (!email || !password) {
    return error(400, 'Email and password are required');
  }

  const user = await findUserByEmail(email.trim().toLowerCase());

  // Generic message either way so we don't reveal whether an email exists.
  const invalid = () => error(401, 'Invalid email or password', 'INVALID_CREDENTIALS');

  if (!user) return invalid();

  // Account locked?
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return error(
      423,
      'Account temporarily locked due to failed logins. Try again later.',
      'LOCKED',
    );
  }

  if (!user.is_active) {
    return error(
      403,
      'This account has been deactivated. Contact your administrator.',
      'DEACTIVATED',
    );
  }

  if (!verifyPassword(password, user.password_hash)) {
    const failed = user.failed_login_count + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await query(
      `UPDATE users
          SET failed_login_count = ?,
              locked_until = ${lock ? `DATE_ADD(NOW(), INTERVAL ${LOCK_MINUTES} MINUTE)` : 'NULL'}
        WHERE id = ?`,
      [failed, user.id],
    );
    await writeAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      entityType: 'auth',
      entityId: user.id,
      action: lock ? 'login_locked' : 'login_failed',
      ipAddress: ip,
    });
    return invalid();
  }

  // Success: reset counters, record login.
  await query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?`,
    [user.id],
  );
  const perms = await getPermissionsForRole(user.role_id);
  const token = issueToken({ sub: user.id, email: user.email, role: user.role_code, perms });

  await writeAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'auth',
    entityId: user.id,
    action: 'login',
    ipAddress: ip,
  });

  return json(200, { token, user: { ...toPublicUser(user), permissions: perms } });
});

// --- POST /api/auth/logout ----------------------------------------------------
// JWTs are stateless; logout is a client-side token discard. We record it for
// the audit trail when a valid token is presented.
export const logout = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  try {
    const ctx = requireAuth(request);
    await writeAudit({
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      entityType: 'auth',
      entityId: ctx.userId,
      action: 'logout',
      ipAddress: clientIp(request),
    });
  } catch {
    // No/expired token — nothing to record.
  }
  return json(200, { ok: true });
});

// --- GET /api/auth/me ---------------------------------------------------------
export const me = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  const user = await findUserById(ctx.userId);
  if (!user || !user.is_active) {
    return error(401, 'Session is no longer valid', 'UNAUTHENTICATED');
  }
  const perms = await getPermissionsForRole(user.role_id);
  return json(200, { user: { ...toPublicUser(user), permissions: perms } });
});

// --- POST /api/auth/change-password ------------------------------------------
export const changePassword = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  const { currentPassword, newPassword } = await readJson<{
    currentPassword?: string;
    newPassword?: string;
  }>(request);

  const user = await findUserById(ctx.userId);
  if (!user || !user.is_active) return error(401, 'Session is no longer valid', 'UNAUTHENTICATED');

  if (!currentPassword || !verifyPassword(currentPassword, user.password_hash)) {
    return error(400, 'Current password is incorrect');
  }
  if (!passwordIsStrong(newPassword)) {
    return error(
      400,
      'New password must be at least 8 characters and include a letter and a number',
    );
  }

  await query(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`, [
    hashPassword(newPassword),
    user.id,
  ]);
  await writeAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    action: 'change_password',
    reason: 'Self-service password change',
    ipAddress: clientIp(request),
  });
  return json(200, { ok: true });
});

// --- POST /api/auth/forgot-password ------------------------------------------
// Always returns 200 so attackers can't enumerate accounts. In production the
// token would be emailed; for local/dev we return it in the response.
export const forgotPassword = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const { email } = await readJson<{ email?: string }>(request);
  const generic = { ok: true, message: 'If that email exists, a reset link has been sent.' };
  if (!email) return json(200, generic);

  const user = await findUserByEmail(email.trim().toLowerCase());
  if (!user || !user.is_active) return json(200, generic);

  const { token, tokenHash } = generateResetToken();
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [user.id, tokenHash, RESET_TOKEN_TTL_MINUTES],
  );
  await writeAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    action: 'forgot_password_requested',
    ipAddress: clientIp(request),
  });

  // Surface the token in non-production so the flow is testable end to end.
  const devToken = process.env.NODE_ENV !== 'production' ? { resetToken: token } : {};
  return json(200, { ...generic, ...devToken });
});

// --- POST /api/auth/reset-password -------------------------------------------
export const resetPassword = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const { token, newPassword } = await readJson<{ token?: string; newPassword?: string }>(request);
  if (!token) return error(400, 'Reset token is required');
  if (!passwordIsStrong(newPassword)) {
    return error(
      400,
      'New password must be at least 8 characters and include a letter and a number',
    );
  }

  const rows = await query<RowDataPacket[]>(
    `SELECT id, user_id FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [hashToken(token)],
  );
  const record = rows[0];
  if (!record) return error(400, 'This reset link is invalid or has expired', 'INVALID_TOKEN');

  await query(
    `UPDATE users SET password_hash = ?, must_change_password = 0, failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    [hashPassword(newPassword), record.user_id],
  );
  await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?`, [record.id]);

  const user = await findUserById(record.user_id);
  await writeAudit({
    actorUserId: record.user_id,
    actorEmail: user?.email ?? null,
    entityType: 'user',
    entityId: record.user_id,
    action: 'reset_password',
    reason: 'Password reset via token',
    ipAddress: clientIp(request),
  });
  return json(200, { ok: true });
});

app.http('auth-login', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/login',
  handler: login,
});
app.http('auth-logout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/logout',
  handler: logout,
});
app.http('auth-me', { methods: ['GET'], authLevel: 'anonymous', route: 'auth/me', handler: me });
app.http('auth-change-password', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/change-password',
  handler: changePassword,
});
app.http('auth-forgot-password', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/forgot-password',
  handler: forgotPassword,
});
app.http('auth-reset-password', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/reset-password',
  handler: resetPassword,
});

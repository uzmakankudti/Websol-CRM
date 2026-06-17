/**
 * Audit log read endpoint.
 *
 *   GET /api/audit   list audit entries (filter: entityType, entityId, actorUserId, action)
 *                    paginated via ?limit & ?offset. Requires audit.read.
 *
 * The audit log is append-only — there is intentionally no write/delete route
 * here; entries are created by the operations being audited via writeAudit().
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { handle, json } from '../shared/http';

export const listAudit = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.auditRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const entityType = request.query.get('entityType');
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  const entityId = request.query.get('entityId');
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  const actorUserId = request.query.get('actorUserId');
  if (actorUserId) {
    where.push('actor_user_id = ?');
    params.push(Number(actorUserId));
  }
  const action = request.query.get('action');
  if (action) {
    where.push('action = ?');
    params.push(action);
  }

  const limit = Math.min(Math.max(Number(request.query.get('limit')) || 100, 1), 500);
  const offset = Math.max(Number(request.query.get('offset')) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, countRows] = await Promise.all([
    query<RowDataPacket[]>(
      `SELECT id, actor_user_id, actor_email, entity_type, entity_id, action, reason, changes, ip_address, created_at
         FROM audit_log
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`, params),
  ]);

  const entries = rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    entityType: r.entity_type,
    entityId: r.entity_id,
    action: r.action,
    reason: r.reason,
    changes: r.changes, // mysql2 returns JSON columns already parsed
    ipAddress: r.ip_address,
    createdAt: r.created_at,
  }));

  return json(200, { entries, total: countRows[0]?.total ?? 0, limit, offset });
});

app.http('audit-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'audit',
  handler: listAudit,
});

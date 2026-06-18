/**
 * Helpdesk — Service Ticket Management (Module 8).
 *
 * Builds on the shared service_tickets table from Module 7 (field-service.ts).
 * This file owns the helpdesk-specific endpoints and the SLA breach processor.
 *
 *   GET  /api/helpdesk/categories          list issue categories      helpdesk.manage | service.read
 *   POST /api/helpdesk/categories          create category            helpdesk.manage
 *   GET  /api/helpdesk/sla-alerts          SLA alert log              service.read
 *   POST /api/service-tickets/{id}/reopen  reopen resolved ticket     service.reopen  (BR-015)
 *
 *   Timer (every 5 min) — processSlaBreaches():
 *     T-1h  insert T_MINUS_1H alert
 *     BREACH    escalate → CSR Supervisor, insert BREACH alert
 *     2× BREACH escalate → Operations Manager, insert DOUBLE_BREACH alert
 *
 * Business rules:
 *   BR-015  A RESOLVED ticket may only be reopened within 48 hours of
 *           last_resolved_at. After that a new ticket must be raised.
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

function toMysqlDt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// GET /api/helpdesk/categories
// ---------------------------------------------------------------------------
export const listCategories = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceRead);

  const rows = await query<RowDataPacket[]>(
    `SELECT id, name, description, is_active FROM helpdesk_issue_categories
      WHERE is_active = 1 ORDER BY name ASC`,
  );
  return json(200, {
    categories: rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, isActive: !!r.is_active,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/helpdesk/categories
// ---------------------------------------------------------------------------
export const createCategory = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.helpdeskManage);

  const body = await readJson<Record<string, unknown>>(request);
  const name = str(body.name);
  if (!name) return error(400, 'name is required');

  const [existing] = await query<RowDataPacket[]>(
    `SELECT id FROM helpdesk_issue_categories WHERE name = ? LIMIT 1`, [name],
  );
  if (existing) return error(409, 'An issue category with that name already exists', 'DUPLICATE_CATEGORY');

  const { insertId } = await query<{ insertId: number }>(
    `INSERT INTO helpdesk_issue_categories (name, description) VALUES (?, ?)`,
    [name, str(body.description)],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'helpdesk_issue_category', entityId: insertId, action: 'create',
    changes: { after: { name } }, ipAddress: clientIp(request),
  });

  const [row] = await query<RowDataPacket[]>(
    `SELECT id, name, description, is_active FROM helpdesk_issue_categories WHERE id = ? LIMIT 1`, [insertId],
  );
  return json(201, { category: { id: row.id, name: row.name, description: row.description, isActive: !!row.is_active } });
});

// ---------------------------------------------------------------------------
// GET /api/helpdesk/sla-alerts
// ---------------------------------------------------------------------------
export const listSlaAlerts = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceRead);

  const alertType = request.query.get('alertType');
  const where: string[] = [];
  const params: unknown[] = [];
  if (alertType) { where.push('a.alert_type = ?'); params.push(alertType.toUpperCase()); }

  const rows = await query<RowDataPacket[]>(
    `SELECT a.id, a.ticket_id, a.alert_type, a.status, a.created_at,
            t.ticket_no, t.sla_due_at, t.status AS ticket_status,
            u.full_name AS escalated_to_name
       FROM service_sla_alerts a
       JOIN service_tickets t ON t.id = a.ticket_id
       LEFT JOIN users u ON u.id = a.escalated_to
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at DESC
       LIMIT 200`,
    params,
  );
  return json(200, {
    alerts: rows.map((r) => ({
      id: r.id,
      ticketId: r.ticket_id,
      ticketNo: r.ticket_no,
      ticketStatus: r.ticket_status,
      alertType: r.alert_type,
      status: r.status,
      slaDueAt: r.sla_due_at,
      escalatedTo: r.escalated_to_name ?? null,
      createdAt: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/service-tickets/{id}/reopen  (BR-015)
// ---------------------------------------------------------------------------
export const reopenTicket = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceReopen);

  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return error(400, 'Invalid service ticket id');

  const [ticket] = await query<RowDataPacket[]>(
    `SELECT id, status, last_resolved_at, reopen_count FROM service_tickets WHERE id = ? LIMIT 1`, [id],
  );
  if (!ticket) return error(404, 'Service ticket not found');
  if (ticket.status !== 'RESOLVED') {
    return error(422, `Only RESOLVED tickets can be reopened (current status: ${ticket.status as string})`, 'INVALID_TRANSITION');
  }

  // BR-015: reopen window is 48 hours from last resolution.
  if (!ticket.last_resolved_at) {
    return error(422, 'This ticket has no recorded resolution time and cannot be reopened', 'REOPEN_WINDOW_UNKNOWN');
  }
  const resolvedMs = new Date(ticket.last_resolved_at as string).getTime();
  const windowMs = 48 * 3600_000;
  if (Date.now() - resolvedMs > windowMs) {
    throw new HttpError(
      422,
      'The 48-hour reopen window has expired (BR-015). Please raise a new ticket.',
      'REOPEN_WINDOW_EXPIRED',
    );
  }

  const nowStr = toMysqlDt(new Date());
  await query(
    `UPDATE service_tickets SET status = 'OPEN', reopen_count = reopen_count + 1 WHERE id = ?`, [id],
  );
  await query(
    `INSERT INTO service_ticket_status_history (ticket_id, from_status, to_status, reason, changed_by)
     VALUES (?, 'RESOLVED', 'OPEN', 'Ticket reopened within 48h window', ?)`,
    [id, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: id, action: 'reopen',
    changes: { after: { status: 'OPEN', reopenCount: (Number(ticket.reopen_count) + 1) } },
    ipAddress: clientIp(request),
  });

  const [updated] = await query<RowDataPacket[]>(
    `SELECT id, ticket_no, status, reopen_count FROM service_tickets WHERE id = ? LIMIT 1`, [id],
  );

  return json(200, {
    ticket: { id: updated.id, ticketNo: updated.ticket_no, status: updated.status, reopenCount: updated.reopen_count },
    reopenedAt: nowStr,
  });
});

// ---------------------------------------------------------------------------
// SLA breach processor — called every 5 minutes by the timer function.
// Exported so tests can invoke it directly with a controlled clock.
//
// Returns counts of each alert type inserted in this run.
// ---------------------------------------------------------------------------
export async function processSlaBreaches(now: Date = new Date()): Promise<{ t1h: number; breach: number; double: number }> {
  const nowStr = toMysqlDt(now);
  const oneHourLater = toMysqlDt(new Date(now.getTime() + 3600_000));

  // --- T-1h: approaching SLA deadline ---
  const approaching = await query<RowDataPacket[]>(
    `SELECT id FROM service_tickets
      WHERE status NOT IN ('CLOSED','CANCELLED','RESOLVED')
        AND sla_due_at IS NOT NULL
        AND sla_due_at > ? AND sla_due_at <= ?
        AND NOT EXISTS (SELECT 1 FROM service_sla_alerts
                         WHERE ticket_id = service_tickets.id AND alert_type = 'T_MINUS_1H')`,
    [nowStr, oneHourLater],
  );
  for (const t of approaching) {
    await query(
      `INSERT IGNORE INTO service_sla_alerts (ticket_id, alert_type, status) VALUES (?, 'T_MINUS_1H', 'NEW')`,
      [t.id],
    );
  }

  // --- BREACH: past SLA deadline → auto-escalate to CSR Supervisor ---
  const [supervisor] = await query<RowDataPacket[]>(
    `SELECT u.id FROM users u
      JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'CSR_SUPERVISOR' AND u.is_active = 1 LIMIT 1`,
  );
  const supId: number | null = supervisor ? Number(supervisor.id) : null;

  const breached = await query<RowDataPacket[]>(
    `SELECT id, status FROM service_tickets
      WHERE status NOT IN ('CLOSED','CANCELLED','RESOLVED')
        AND sla_due_at IS NOT NULL AND sla_due_at < ?
        AND NOT EXISTS (SELECT 1 FROM service_sla_alerts
                         WHERE ticket_id = service_tickets.id AND alert_type = 'BREACH')`,
    [nowStr],
  );
  for (const t of breached) {
    await query(
      `UPDATE service_tickets
          SET status = 'ESCALATED', escalated_to = ?, escalated_at = ?,
              escalation_reason = 'SLA breach — auto-escalated to CSR Supervisor'
        WHERE id = ? AND status NOT IN ('CLOSED','CANCELLED')`,
      [supId, nowStr, t.id],
    );
    await query(
      `INSERT INTO service_ticket_status_history
         (ticket_id, from_status, to_status, reason, changed_by)
       VALUES (?, ?, 'ESCALATED', 'SLA breach auto-escalation', ?)`,
      [t.id, t.status as string, supId ?? 1],
    );
    await query(
      `INSERT IGNORE INTO service_sla_alerts (ticket_id, alert_type, escalated_to, status)
       VALUES (?, 'BREACH', ?, 'ESCALATED')`,
      [t.id, supId],
    );
  }

  // --- DOUBLE BREACH: 2× SLA window elapsed → escalate to Operations Manager ---
  const [opsManager] = await query<RowDataPacket[]>(
    `SELECT u.id FROM users u
      JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'OPERATIONS_MANAGER' AND u.is_active = 1 LIMIT 1`,
  );
  const opsId: number | null = opsManager ? Number(opsManager.id) : null;

  const doubleBreached = await query<RowDataPacket[]>(
    `SELECT id FROM service_tickets
      WHERE status NOT IN ('CLOSED','CANCELLED','RESOLVED')
        AND sla_due_at IS NOT NULL
        AND TIMESTAMPADD(SECOND,
              TIMESTAMPDIFF(SECOND, created_at, sla_due_at),
              sla_due_at) < ?
        AND NOT EXISTS (SELECT 1 FROM service_sla_alerts
                         WHERE ticket_id = service_tickets.id AND alert_type = 'DOUBLE_BREACH')`,
    [nowStr],
  );
  for (const t of doubleBreached) {
    await query(
      `UPDATE service_tickets
          SET escalated_to = ?,
              escalation_reason = '2× SLA breach — escalated to Operations Manager'
        WHERE id = ? AND status NOT IN ('CLOSED','CANCELLED')`,
      [opsId, t.id],
    );
    await query(
      `INSERT IGNORE INTO service_sla_alerts (ticket_id, alert_type, escalated_to, status)
       VALUES (?, 'DOUBLE_BREACH', ?, 'ESCALATED')`,
      [t.id, opsId],
    );
  }

  return { t1h: approaching.length, breach: breached.length, double: doubleBreached.length };
}

// ---------------------------------------------------------------------------
// Azure Timer Function — runs every 5 minutes.
// ---------------------------------------------------------------------------
app.timer('sla-breach-processor', {
  schedule: '0 */5 * * * *',
  handler: async () => {
    await processSlaBreaches(new Date());
  },
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('helpdesk-categories-list',   { methods: ['GET'],  authLevel: 'anonymous', route: 'helpdesk/categories',      handler: listCategories });
app.http('helpdesk-categories-create', { methods: ['POST'], authLevel: 'anonymous', route: 'helpdesk/categories',      handler: createCategory });
app.http('helpdesk-sla-alerts',        { methods: ['GET'],  authLevel: 'anonymous', route: 'helpdesk/sla-alerts',      handler: listSlaAlerts });
app.http('service-tickets-reopen',     { methods: ['POST'], authLevel: 'anonymous', route: 'service-tickets/{id}/reopen', handler: reopenTicket });

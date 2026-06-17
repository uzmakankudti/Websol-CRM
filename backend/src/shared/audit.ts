/**
 * Audit log writer.
 *
 * Every state-changing operation calls `writeAudit` so the system keeps an
 * append-only record of *who* changed *what*, *when*, and *why*. Writes here
 * must never throw in a way that breaks the caller's main operation — auditing
 * failures are logged but swallowed.
 */
import { query } from './db';

export interface AuditEntry {
  actorUserId: number | null;
  actorEmail: string | null;
  entityType: string;
  entityId?: string | number | null;
  action: string;
  reason?: string | null;
  /** before/after diff or any structured context. */
  changes?: unknown;
  ipAddress?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (actor_user_id, actor_email, entity_type, entity_id, action, reason, changes, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorUserId,
        entry.actorEmail,
        entry.entityType,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.action,
        entry.reason ?? null,
        entry.changes != null ? JSON.stringify(entry.changes) : null,
        entry.ipAddress ?? null,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to write audit log entry:', err, entry);
  }
}

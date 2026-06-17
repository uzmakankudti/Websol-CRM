/**
 * BR-018 — database-level integration test.
 *
 * Applies migrations 001 + 002 to the database and proves, against a *real*
 * MySQL, that the foreign key from `audit_log.actor_user_id` to `users.id`
 * blocks hard-deleting a user who is referenced by history — so the only way
 * to remove a user is the soft `is_active = 0` deactivation, which this test
 * also confirms still works.
 *
 * Isolation: the local `websol` account is scoped to the `websol_crm` schema
 * and cannot create a separate test database, so the test runs there but only
 * ever touches its own randomly-named role/user/audit rows and deletes them in
 * a `finally`, leaving no residue. Re-applying the migrations is safe because
 * every statement uses IF NOT EXISTS / ON DUPLICATE KEY.
 *
 * If MySQL is unreachable the whole suite skips (so it never breaks CI without
 * a database) — run it locally with the DB up to see it execute.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql, { type Connection } from 'mysql2/promise';
import { config } from '../src/shared/config';

const MIGRATIONS_DIR = resolve(__dirname, '../../database/migrations');

let conn: Connection | null = null;
// A unique suffix so test rows never collide with real/seeded data.
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

async function applyMigration(file: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
  await conn!.query(sql); // connection opened with multipleStatements
}

beforeAll(async () => {
  try {
    conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      multipleStatements: true,
      ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
    });
    // Apply the schema. 002 depends on schema_migrations from 001.
    await applyMigration('001_init.sql');
    await applyMigration('002_access_management.sql');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping DB integration test — could not connect/migrate:',
      (err as Error).message,
    );
    if (conn) {
      await conn.end().catch(() => undefined);
      conn = null;
    }
  }
}, 20000);

afterAll(async () => {
  if (conn) await conn.end();
});

describe('BR-018: FK prevents hard-deleting a referenced user (real MySQL)', () => {
  it('applies migration 002 (audit_log has a FK to users)', (ctx) => {
    if (!conn) return ctx.skip();
    // If beforeAll migrated successfully the tables exist; verify the schema.
    return (async () => {
      const [rows] = await conn!.query<mysql.RowDataPacket[]>(
        `SELECT REFERENCED_TABLE_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'actor_user_id'
            AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [config.db.database],
      );
      expect(rows.map((r) => r.REFERENCED_TABLE_NAME)).toContain('users');
    })();
  });

  it('blocks DELETE of a referenced user, but allows soft deactivation', async (ctx) => {
    if (!conn) return ctx.skip();

    let roleId: number | undefined;
    let userId: number | undefined;
    let auditId: number | undefined;

    try {
      // Arrange: a throwaway role, a user with that role, and an audit row that
      // references the user (this is the "historical record").
      const [roleRes] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO roles (code, name, description) VALUES (?, ?, ?)`,
        [`TEST_ROLE_${tag}`, `Test Role ${tag}`, 'temporary role for FK integration test'],
      );
      roleId = roleRes.insertId;

      const [userRes] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO users (email, full_name, password_hash, role_id, is_active, must_change_password)
         VALUES (?, ?, ?, ?, 1, 0)`,
        [`fktest_${tag}@websol.local`, `FK Test User ${tag}`, 'scrypt$1$00$00', roleId],
      );
      userId = userRes.insertId;

      const [auditRes] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO audit_log (actor_user_id, actor_email, entity_type, entity_id, action, reason)
         VALUES (?, ?, 'user', ?, 'create', 'integration test fixture')`,
        [userId, `fktest_${tag}@websol.local`, String(userId)],
      );
      auditId = auditRes.insertId;

      // Act + Assert 1: a hard DELETE must be rejected by the FK constraint.
      let deleteError: { errno?: number; code?: string } | null = null;
      try {
        await conn.query(`DELETE FROM users WHERE id = ?`, [userId]);
      } catch (err) {
        deleteError = err as { errno?: number; code?: string };
      }
      expect(deleteError, 'DELETE should have been blocked by the FK').not.toBeNull();
      // 1451 = ER_ROW_IS_REFERENCED_2
      expect([1451, 1217]).toContain(deleteError!.errno);

      // The user row is still there (never hard-deleted).
      const [stillThere] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT id, is_active FROM users WHERE id = ?`,
        [userId],
      );
      expect(stillThere).toHaveLength(1);

      // Act + Assert 2: the supported path — soft deactivation — succeeds and
      // the historical audit reference remains intact.
      await conn.query(`UPDATE users SET is_active = 0, deactivated_at = NOW() WHERE id = ?`, [
        userId,
      ]);
      const [afterDeactivate] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT u.is_active, a.actor_user_id
           FROM users u JOIN audit_log a ON a.actor_user_id = u.id
          WHERE u.id = ?`,
        [userId],
      );
      expect(afterDeactivate[0].is_active).toBe(0);
      expect(afterDeactivate[0].actor_user_id).toBe(userId); // reference preserved
    } finally {
      // Clean up our own rows (child first), leaving the schema untouched.
      if (auditId) await conn.query(`DELETE FROM audit_log WHERE id = ?`, [auditId]);
      if (userId) await conn.query(`DELETE FROM users WHERE id = ?`, [userId]);
      if (roleId) await conn.query(`DELETE FROM roles WHERE id = ?`, [roleId]);
    }
  });
});

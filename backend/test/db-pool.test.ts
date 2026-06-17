import { describe, it, expect, afterAll } from 'vitest';
import { getPool, pingDatabase } from '../src/shared/db';
import { config } from '../src/shared/config';

/**
 * Integration test — requires a running MySQL with the credentials in
 * local.settings.json (the same ones the app uses).
 */
describe('MySQL connection pool', () => {
  afterAll(async () => {
    // Close the pool so the test process can exit cleanly.
    await getPool().end();
  });

  it('connects to the database', async () => {
    expect(await pingDatabase()).toBe(true);
  });

  it('returns the same pool instance on repeated calls (one shared pool)', () => {
    expect(getPool()).toBe(getPool());
  });

  it('acquires and releases more connections than the pool limit', async () => {
    const pool = getPool();
    // Borrowing/releasing MORE times than connectionLimit, one at a time, can
    // only succeed if each connection is returned to the pool. If release()
    // were broken, the loop would block once the limit is hit and time out.
    const rounds = config.db.connectionLimit * 2;

    for (let i = 0; i < rounds; i++) {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query('SELECT 1 AS ok');
        expect((rows as { ok: number }[])[0].ok).toBe(1);
      } finally {
        connection.release();
      }
    }
  });
});

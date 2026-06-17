/**
 * MySQL connection pool.
 *
 * WHY A POOL (and why a SINGLE shared one) on serverless:
 * Each Azure Function instance is a long-lived Node.js process that handles
 * many invocations. If we opened a new connection per request we would quickly
 * exhaust MySQL's `max_connections` under load. Instead we create ONE pool and
 * keep it at module scope. Because Node caches modules, every warm invocation
 * on the same instance reuses this exact pool — connections are borrowed for a
 * query and returned, never re-created per request.
 *
 * The pool is created lazily on first use so that simply importing this module
 * (e.g. during build/test) does not open sockets.
 */
import mysql, { Pool } from 'mysql2/promise';
import { config } from './config';

let pool: Pool | undefined;

/** Get the shared connection pool, creating it once on first call. */
export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      queueLimit: 0,
      enableKeepAlive: true,
      ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

/**
 * Run a query against the pool. Thin convenience wrapper so callers don't have
 * to reach into the pool object directly.
 */
export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T> {
  const [rows] = await getPool().query(sql, params);
  return rows as T;
}

/** Lightweight liveness check used by the health endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

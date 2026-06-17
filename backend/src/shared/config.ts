/**
 * Centralised configuration.
 *
 * Reads every environment variable in ONE place so the rest of the codebase
 * never touches `process.env` directly. Locally these come from
 * `local.settings.json`; in Azure they come from the Function App's
 * Application Settings (ideally backed by Key Vault).
 */

/** Read a required string env var, or throw a clear error if it is missing. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Read an optional env var with a fallback default. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  appSecret: optional('APP_SECRET', 'dev-insecure-secret'),

  db: {
    host: required('DB_HOST'),
    port: Number(optional('DB_PORT', '3306')),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    // Keep this SMALL on serverless: total DB connections =
    // (number of warm function instances) x connectionLimit.
    connectionLimit: Number(optional('DB_CONNECTION_LIMIT', '5')),
    ssl: optional('DB_SSL', 'false').toLowerCase() === 'true',
  },
} as const;

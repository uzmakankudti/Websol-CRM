import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load Azure Functions `local.settings.json` values into process.env so the
 * shared config (which reads process.env) works during tests — exactly like
 * the Functions host does at runtime. Existing env vars win, and we fall back
 * to safe defaults so module-load validation never throws in CI where the file
 * may be absent.
 */
function loadLocalSettings(): void {
  try {
    const raw = readFileSync(resolve(__dirname, '../local.settings.json'), 'utf8');
    const values: Record<string, unknown> = JSON.parse(raw).Values ?? {};
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = String(value);
      }
    }
  } catch {
    // No local.settings.json (e.g. CI) — defaults below keep config valid.
  }

  process.env.DB_HOST ??= 'localhost';
  process.env.DB_PORT ??= '3306';
  process.env.DB_USER ??= 'websol';
  process.env.DB_PASSWORD ??= '';
  process.env.DB_NAME ??= 'websol_crm';
}

loadLocalSettings();

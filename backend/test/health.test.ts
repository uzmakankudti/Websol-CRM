import { describe, it, expect, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

// Mock the DB layer so this endpoint test does NOT need a live MySQL — it
// verifies the HTTP contract (200 + status "OK") in isolation.
vi.mock('../src/shared/db', () => ({
  pingDatabase: vi.fn(async () => true),
  getPool: vi.fn(),
  query: vi.fn(),
}));

import { health } from '../src/functions/health';

/** Minimal fake HttpRequest whose `query` behaves like the real URLSearchParams. */
function makeRequest(query: Record<string, string> = {}): HttpRequest {
  return { query: new Map(Object.entries(query)) } as unknown as HttpRequest;
}

const context = { log: () => {} } as unknown as InvocationContext;

describe('health endpoint', () => {
  it('returns 200 and status "OK"', async () => {
    const response = await health(makeRequest(), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'OK', database: 'up' });
  });

  it('still returns 200 and "OK" when the DB check is skipped (?db=false)', async () => {
    const response = await health(makeRequest({ db: 'false' }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'OK', database: 'skipped' });
  });
});

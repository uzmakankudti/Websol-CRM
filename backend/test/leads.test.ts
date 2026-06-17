/**
 * Lead & Opportunity Management — behavioural tests.
 *
 * Each describe block maps to a named requirement:
 *
 *   1. Stage transitions  — the pipeline enforces NEW→CONTACTED→PROPOSAL_SENT→WON|LOST;
 *                           any jump or backward move is rejected (422 INVALID_TRANSITION);
 *                           WON and LOST are terminal; every transition is persisted and audited.
 *   2. Quotation approval — discount_pct = 0 auto-approves; discount_pct > 0 requires a Sales
 *                           Manager; double-acting on a non-PENDING quotation is rejected (422).
 *   3. BR-024 enforcement — conversion is blocked unless a LEAD is WON and has at least one
 *                           APPROVED quotation; three distinct guard conditions each yield a
 *                           distinct error code.
 *   4. Conversion fidelity — the customer record is populated directly from the lead fields
 *                            (company_name → name, contact_email → email, contact_phone → phone);
 *                            the lead is linked back; the caller receives the new customer id.
 *
 * All tests use a mocked `query` so they run anywhere without a live MySQL instance.
 * The real audit writer, RBAC, JWT and HTTP helpers are NOT mocked — they exercise the
 * same code paths production uses, exactly as the access-management tests do.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HttpRequest } from '@azure/functions';

vi.mock('../src/shared/db', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { query } from '../src/shared/db';
import { issueToken } from '../src/shared/auth';
import {
  changeStage,
  createQuotation,
  approveQuotation,
  convertLead,
} from '../src/functions/leads';

const queryMock = query as unknown as Mock;

// =============================================================================
// Token helpers
// =============================================================================

const MANAGER_PERMS = [
  'leads.read',
  'leads.create',
  'leads.update',
  'leads.change_stage',
  'leads.convert',
  'quotations.create',
  'quotations.approve',
];

const REP_PERMS = [
  'leads.read',
  'leads.create',
  'leads.update',
  'leads.change_stage',
  'quotations.create',
];

function managerToken() {
  return issueToken({
    sub: 10,
    email: 'mgr@websol.local',
    role: 'SALES_MANAGER',
    perms: MANAGER_PERMS,
  });
}

function repToken() {
  return issueToken({ sub: 11, email: 'rep@websol.local', role: 'SALES_REP', perms: REP_PERMS });
}

// =============================================================================
// Request builder
// =============================================================================

function req(opts: {
  token?: string;
  params?: Record<string, string>;
  body?: unknown;
} = {}): HttpRequest {
  const h = new Map<string, string>();
  if (opts.token) h.set('authorization', `Bearer ${opts.token}`);
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    query: new Map<string, string>(),
    params: opts.params ?? {},
    text: async () => (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as unknown as HttpRequest;
}

// =============================================================================
// Row fixtures
// =============================================================================

function leadRow(stage = 'NEW', extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    company_name: 'Acme Corp',
    contact_name: 'Jane Doe',
    contact_email: 'jane@acme.com',
    contact_phone: '+27110000000',
    source: 'WEBSITE',
    expected_printers: 3,
    stage,
    stage_note: null,
    assigned_to: null,
    assigned_to_name: null,
    lost_reason: null,
    converted_customer_id: null,
    converted_at: null,
    converted_by: null,
    converted_by_name: null,
    created_by: 10,
    created_by_name: 'Sales Manager',
    created_at: '2026-01-01 09:00:00',
    updated_at: '2026-01-01 09:00:00',
    ...extra,
  };
}

function quotationRow(status = 'APPROVED', discountPct = '0.00') {
  return {
    id: 1,
    lead_id: 1,
    monthly_lease_fee: '1500.00',
    per_page_bw: '0.00800',
    per_page_colour: '0.05000',
    discount_pct: discountPct,
    notes: null,
    status,
    approved_by: status === 'PENDING_APPROVAL' ? null : 10,
    approved_by_name: status === 'PENDING_APPROVAL' ? null : 'Sales Manager',
    approved_at: status === 'PENDING_APPROVAL' ? null : '2026-01-02 10:00:00',
    approval_note: null,
    created_by: 11,
    created_by_name: 'Sales Rep',
    created_at: '2026-01-02 09:00:00',
    updated_at: '2026-01-02 10:00:00',
  };
}

// =============================================================================
// Audit assertion helper
// =============================================================================

function auditInserts(): { sql: string; params: unknown[] }[] {
  return queryMock.mock.calls
    .filter(([sql]) => /INSERT INTO audit_log/i.test(String(sql)))
    .map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }));
}

// =============================================================================
// Shared SQL-call assertions
// =============================================================================

function calledSqls(): string[] {
  return queryMock.mock.calls.map(([sql]) => String(sql));
}

function wasUpdated(table: string): boolean {
  return calledSqls().some((s) => new RegExp(`UPDATE ${table}`, 'i').test(s));
}

function wasInserted(table: string): boolean {
  return calledSqls().some((s) => new RegExp(`INSERT INTO ${table}`, 'i').test(s));
}

// =============================================================================
// Default mock — overridden per describe/it as needed.
// NOTE: the check for `status = 'APPROVED'` (the BR-024 literal) MUST come
// before the generic `FROM lead_quotations` check, because the BR-024 SQL also
// contains that substring.
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM leads/i.test(sql)) return [leadRow()];
    if (/status\s*=\s*'APPROVED'/i.test(sql)) return []; // BR-024 check: no approved by default
    if (/FROM lead_quotations/i.test(sql)) return [quotationRow()];
    if (/FROM lead_quotation_printers/i.test(sql)) return [];
    if (/INSERT INTO/i.test(sql)) return { insertId: 1, affectedRows: 1 };
    if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
    return [];
  });
});

// =============================================================================
// 1. Stage transitions
// =============================================================================

describe('1. stage transitions', () => {
  /** Wire the mock to serve a lead in the given stage for findLead calls. */
  function withLeadStage(stage: string) {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql)) return [leadRow(stage)];
      if (/INSERT INTO/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
  }

  function stageReq(newStage: string, extra: Record<string, unknown> = {}) {
    return req({ token: managerToken(), params: { id: '1' }, body: { stage: newStage, ...extra } });
  }

  // --- valid forward moves ---------------------------------------------------

  it('NEW → CONTACTED succeeds (200) and writes history + audit', async () => {
    withLeadStage('NEW');
    const res = await changeStage(stageReq('CONTACTED'), {} as never);
    expect(res.status).toBe(200);
    expect(wasUpdated('leads')).toBe(true);
    expect(wasInserted('lead_stage_history')).toBe(true);
    const audit = auditInserts().find((a) => a.params[4] === 'stage_change');
    expect(audit).toBeDefined();
    const diff = JSON.parse(String(audit!.params[6]));
    expect(diff.before.stage).toBe('NEW');
    expect(diff.after.stage).toBe('CONTACTED');
  });

  it('CONTACTED → PROPOSAL_SENT succeeds (200)', async () => {
    withLeadStage('CONTACTED');
    const res = await changeStage(stageReq('PROPOSAL_SENT'), {} as never);
    expect(res.status).toBe(200);
  });

  it('PROPOSAL_SENT → WON succeeds (200)', async () => {
    withLeadStage('PROPOSAL_SENT');
    const res = await changeStage(stageReq('WON'), {} as never);
    expect(res.status).toBe(200);
  });

  it('any active stage → LOST succeeds when lostReason is supplied', async () => {
    withLeadStage('CONTACTED');
    const res = await changeStage(
      stageReq('LOST', { lostReason: 'Budget cut' }),
      {} as never,
    );
    expect(res.status).toBe(200);
  });

  // --- invalid / skipped moves -----------------------------------------------

  it('NEW → PROPOSAL_SENT rejected (422 INVALID_TRANSITION) — skips CONTACTED', async () => {
    withLeadStage('NEW');
    const res = await changeStage(stageReq('PROPOSAL_SENT'), {} as never);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    // Validation fails before any write.
    expect(wasUpdated('leads')).toBe(false);
    expect(wasInserted('lead_stage_history')).toBe(false);
  });

  it('NEW → WON rejected (422 INVALID_TRANSITION) — skips two steps', async () => {
    withLeadStage('NEW');
    const res = await changeStage(stageReq('WON'), {} as never);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    expect(wasUpdated('leads')).toBe(false);
  });

  it('CONTACTED → NEW rejected (422 INVALID_TRANSITION) — cannot go backward', async () => {
    withLeadStage('CONTACTED');
    const res = await changeStage(stageReq('NEW'), {} as never);
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  // --- terminal stages -------------------------------------------------------

  it('WON is terminal — every target is rejected (422 INVALID_TRANSITION)', async () => {
    for (const target of ['NEW', 'CONTACTED', 'PROPOSAL_SENT', 'LOST'] as const) {
      vi.clearAllMocks();
      withLeadStage('WON');
      const res = await changeStage(stageReq(target), {} as never);
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('LOST is terminal — every target is rejected (422 INVALID_TRANSITION)', async () => {
    for (const target of ['NEW', 'CONTACTED', 'PROPOSAL_SENT', 'WON'] as const) {
      vi.clearAllMocks();
      withLeadStage('LOST');
      const res = await changeStage(stageReq(target), {} as never);
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    }
  });

  // --- LOST-specific guard ---------------------------------------------------

  it('moving to LOST without a lostReason is rejected (400) — reason is mandatory', async () => {
    withLeadStage('NEW');
    const res = await changeStage(stageReq('LOST'), {} as never); // no lostReason
    expect(res.status).toBe(400);
    // No write should have happened.
    expect(wasUpdated('leads')).toBe(false);
  });

  it('moving to LOST writes the lostReason to the UPDATE', async () => {
    withLeadStage('PROPOSAL_SENT');
    await changeStage(stageReq('LOST', { lostReason: 'Competition won' }), {} as never);
    // The UPDATE params must carry the lost_reason value.
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      /UPDATE leads/i.test(String(sql)),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('Competition won');
  });

  // --- audit content ---------------------------------------------------------

  it('stage history INSERT captures from/to stages and the acting user', async () => {
    withLeadStage('CONTACTED');
    await changeStage(stageReq('PROPOSAL_SENT', { note: 'Deck sent' }), {} as never);

    const historyInsert = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO lead_stage_history/i.test(String(sql)),
    );
    expect(historyInsert).toBeDefined();
    const [, params] = historyInsert!;
    expect(params[1]).toBe('CONTACTED');   // from_stage
    expect(params[2]).toBe('PROPOSAL_SENT'); // to_stage
    expect(params[3]).toBe('Deck sent');   // note
    expect(params[4]).toBe(10);            // changed_by = Sales Manager
  });

  // --- schema check ----------------------------------------------------------

  it('migration defines the ENUM stages and the history table', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../database/migrations/003_leads.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ENUM\('NEW','CONTACTED','PROPOSAL_SENT','WON','LOST'\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS lead_stage_history/i);
    // History rows reference leads and users via FKs (so context is never lost).
    expect(sql).toMatch(/fk_lsh_lead/i);
    expect(sql).toMatch(/fk_lsh_user/i);
  });
});

// =============================================================================
// 2. Discounted quotation approval workflow
// =============================================================================

describe('2. discounted quotation approval workflow', () => {
  // A minimal valid quotation body used across several tests.
  const BASE_BODY = {
    monthlyLeaseFee: 1500,
    perPageBw: 0.008,
    perPageColour: 0.05,
    printers: [{ printerModel: 'Canon iR-ADV C3530', quantity: 2 }],
  };

  // --- creation rules --------------------------------------------------------

  describe('quotation creation', () => {
    beforeEach(() => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('NEW')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow()];
        if (/FROM lead_quotation_printers/i.test(sql)) return [];
        if (/INSERT INTO/i.test(sql)) return { insertId: 1, affectedRows: 1 };
        if (/UPDATE/i.test(sql)) return { affectedRows: 1 };
        return [];
      });
    });

    it('discount = 0 → status is APPROVED immediately (no manager needed)', async () => {
      const res = await createQuotation(
        req({ token: repToken(), params: { id: '1' }, body: { ...BASE_BODY, discountPct: 0 } }),
        {} as never,
      );
      expect(res.status).toBe(201);

      const insertCall = queryMock.mock.calls.find(([sql]) =>
        /INSERT INTO lead_quotations/i.test(String(sql)),
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[6]).toBe('APPROVED');   // status column
      expect(params[7]).not.toBeNull();     // approved_by = creator (auto)
      expect(params[8]).not.toBeNull();     // approved_at set immediately
    });

    it('discount > 0 → status is PENDING_APPROVAL and approved_by is null', async () => {
      const res = await createQuotation(
        req({
          token: repToken(),
          params: { id: '1' },
          body: { ...BASE_BODY, discountPct: 12.5 },
        }),
        {} as never,
      );
      expect(res.status).toBe(201);

      const insertCall = queryMock.mock.calls.find(([sql]) =>
        /INSERT INTO lead_quotations/i.test(String(sql)),
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[6]).toBe('PENDING_APPROVAL'); // status column
      expect(params[7]).toBeNull();               // approved_by — not yet approved
      expect(params[8]).toBeNull();               // approved_at — not yet approved
    });

    it('saves every printer line with the correct model and quantity', async () => {
      await createQuotation(
        req({
          token: repToken(),
          params: { id: '1' },
          body: {
            ...BASE_BODY,
            printers: [
              { printerModel: 'Canon iR-ADV C3530', quantity: 2 },
              { printerModel: 'Ricoh MP C3004ex', quantity: 1 },
            ],
          },
        }),
        {} as never,
      );

      const printerInserts = queryMock.mock.calls.filter(([sql]) =>
        /INSERT INTO lead_quotation_printers/i.test(String(sql)),
      );
      expect(printerInserts).toHaveLength(2);
      expect(printerInserts[0][1]).toContain('Canon iR-ADV C3530');
      expect(printerInserts[1][1]).toContain('Ricoh MP C3004ex');
    });

    it('rejects a quotation with no printer lines (400)', async () => {
      const res = await createQuotation(
        req({ token: repToken(), params: { id: '1' }, body: { ...BASE_BODY, printers: [] } }),
        {} as never,
      );
      expect(res.status).toBe(400);
      expect(wasInserted('lead_quotations')).toBe(false);
    });

    it('rejects a quotation on a WON lead (422 LEAD_TERMINAL)', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('WON')];
        return [];
      });
      const res = await createQuotation(
        req({ token: repToken(), params: { id: '1' }, body: BASE_BODY }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('LEAD_TERMINAL');
    });
  });

  // --- approval rules --------------------------------------------------------

  describe('quotation review (approve / reject)', () => {
    it('a Sales Rep is blocked from approving (403) — no quotations.approve permission', async () => {
      const res = await approveQuotation(
        req({ token: repToken(), params: { id: '1', qid: '1' }, body: { action: 'approve' } }),
        {} as never,
      );
      expect(res.status).toBe(403);
      // Auth check fires before any DB access.
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('a Sales Manager can approve a PENDING_APPROVAL quotation', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('PROPOSAL_SENT')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow('PENDING_APPROVAL', '10.00')];
        if (/FROM lead_quotation_printers/i.test(sql)) return [];
        if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
        if (/UPDATE lead_quotations/i.test(sql)) return { affectedRows: 1 };
        return [];
      });

      const res = await approveQuotation(
        req({
          token: managerToken(),
          params: { id: '1', qid: '1' },
          body: { action: 'approve', note: 'Approved after negotiation' },
        }),
        {} as never,
      );
      expect(res.status).toBe(200);

      // UPDATE set the new status to APPROVED.
      const updateCall = queryMock.mock.calls.find(([sql]) =>
        /UPDATE lead_quotations/i.test(String(sql)),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1][0]).toBe('APPROVED');
      expect(updateCall![1][1]).toBe(10); // approved_by = manager userId

      expect(auditInserts().some((a) => a.params[4] === 'approve')).toBe(true);
    });

    it('a Sales Manager can reject a PENDING_APPROVAL quotation', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('PROPOSAL_SENT')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow('PENDING_APPROVAL', '25.00')];
        if (/FROM lead_quotation_printers/i.test(sql)) return [];
        if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
        if (/UPDATE lead_quotations/i.test(sql)) return { affectedRows: 1 };
        return [];
      });

      const res = await approveQuotation(
        req({
          token: managerToken(),
          params: { id: '1', qid: '1' },
          body: { action: 'reject', note: 'Discount too steep' },
        }),
        {} as never,
      );
      expect(res.status).toBe(200);

      const updateCall = queryMock.mock.calls.find(([sql]) =>
        /UPDATE lead_quotations/i.test(String(sql)),
      );
      expect(updateCall![1][0]).toBe('REJECTED');
      expect(auditInserts().some((a) => a.params[4] === 'reject')).toBe(true);
    });

    it('cannot action an already-APPROVED quotation (422 INVALID_STATUS)', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('PROPOSAL_SENT')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow('APPROVED')];
        return [];
      });

      const res = await approveQuotation(
        req({ token: managerToken(), params: { id: '1', qid: '1' }, body: { action: 'approve' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_STATUS');
      // No UPDATE should have been issued.
      expect(wasUpdated('lead_quotations')).toBe(false);
    });

    it('cannot action an already-REJECTED quotation (422 INVALID_STATUS)', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('PROPOSAL_SENT')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow('REJECTED')];
        return [];
      });

      const res = await approveQuotation(
        req({ token: managerToken(), params: { id: '1', qid: '1' }, body: { action: 'reject' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_STATUS');
    });

    it('body action must be "approve" or "reject" — anything else is 400', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow('PROPOSAL_SENT')];
        if (/FROM lead_quotations/i.test(sql)) return [quotationRow('PENDING_APPROVAL')];
        return [];
      });

      const res = await approveQuotation(
        req({
          token: managerToken(),
          params: { id: '1', qid: '1' },
          body: { action: 'delete' },
        }),
        {} as never,
      );
      expect(res.status).toBe(400);
    });
  });
});

// =============================================================================
// 3. BR-024: conversion is blocked without an approved quotation
// =============================================================================

describe('3. BR-024 — conversion blocked without an approved quotation', () => {
  it('blocks conversion of a lead that is not yet WON (422 LEAD_NOT_WON)', async () => {
    for (const stage of ['NEW', 'CONTACTED', 'PROPOSAL_SENT', 'LOST'] as const) {
      vi.clearAllMocks();
      queryMock.mockImplementation(async (sql: string) => {
        if (/FROM leads/i.test(sql)) return [leadRow(stage)];
        return [];
      });

      const res = await convertLead(
        req({ token: managerToken(), params: { id: '1' } }),
        {} as never,
      );
      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: { code: string } }).error.code).toBe('LEAD_NOT_WON');
      expect(wasInserted('customers')).toBe(false);
    }
  });

  it('blocks a WON lead with no quotation at all (422 NO_APPROVED_QUOTATION)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql)) return [leadRow('WON')];
      if (/status\s*=\s*'APPROVED'/i.test(sql)) return []; // no approved quotation
      return [];
    });

    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('NO_APPROVED_QUOTATION');
    expect(wasInserted('customers')).toBe(false);
  });

  it('blocks a WON lead whose only quotation is still PENDING_APPROVAL (422 NO_APPROVED_QUOTATION)', async () => {
    // The BR-024 query filters on status = 'APPROVED'; a PENDING row returns nothing.
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql)) return [leadRow('WON')];
      if (/status\s*=\s*'APPROVED'/i.test(sql)) return []; // pending does not satisfy BR-024
      return [];
    });

    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('NO_APPROVED_QUOTATION');
    expect(wasInserted('customers')).toBe(false);
  });

  it('blocks a WON lead whose only quotation was REJECTED (422 NO_APPROVED_QUOTATION)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql)) return [leadRow('WON')];
      if (/status\s*=\s*'APPROVED'/i.test(sql)) return []; // rejected also not approved
      return [];
    });

    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('NO_APPROVED_QUOTATION');
  });

  it('blocks an already-converted lead from being converted again (409 ALREADY_CONVERTED)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql))
        return [leadRow('WON', { converted_customer_id: 5 })]; // already converted
      return [];
    });

    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('ALREADY_CONVERTED');
    // Guard fires before checking quotations.
    expect(wasInserted('customers')).toBe(false);
  });

  it('a Sales Rep cannot convert — leads.convert permission is required (403)', async () => {
    const res = await convertLead(
      req({ token: repToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(403);
    // Auth check fires before any DB access.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('succeeds when the lead is WON and has at least one APPROVED quotation (200)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql)) return [leadRow('WON')];
      if (/status\s*=\s*'APPROVED'/i.test(sql)) return [{ id: 7 }]; // approved quotation exists
      if (/INSERT INTO customers/i.test(sql)) return { insertId: 88, affectedRows: 1 };
      if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE leads/i.test(sql)) return { affectedRows: 1 };
      return [];
    });

    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(wasInserted('customers')).toBe(true);
  });

  it('schema: leads table carries a FK to customers and a source check in the handler', () => {
    const migration = readFileSync(
      resolve(__dirname, '../../database/migrations/003_leads.sql'),
      'utf8',
    );
    expect(migration).toMatch(/converted_customer_id/i);
    expect(migration).toMatch(/REFERENCES customers \(id\)/i);

    const handlerSource = readFileSync(
      resolve(__dirname, '../src/functions/leads.ts'),
      'utf8',
    );
    // The BR-024 guard is always present in the convert path.
    expect(handlerSource).toMatch(/NO_APPROVED_QUOTATION/);
    // The guard queries the DB for status = 'APPROVED' — never trusts the caller.
    expect(handlerSource).toMatch(/status\s*=\s*'APPROVED'/);
  });
});

// =============================================================================
// 4. Conversion fidelity — customer created from lead data; no re-typed input
// =============================================================================

describe('4. won-lead conversion: customer populated directly from lead data', () => {
  const COMPANY = 'Orion Printing Ltd';
  const EMAIL = 'orion@example.com';
  const PHONE = '+27210000001';

  beforeEach(() => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql))
        return [
          leadRow('WON', {
            company_name: COMPANY,
            contact_email: EMAIL,
            contact_phone: PHONE,
            converted_customer_id: null,
          }),
        ];
      if (/status\s*=\s*'APPROVED'/i.test(sql)) return [{ id: 7 }]; // approved quotation
      if (/INSERT INTO customers/i.test(sql)) return { insertId: 42, affectedRows: 1 };
      if (/INSERT INTO audit_log/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      if (/UPDATE leads/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
  });

  it('INSERT INTO customers uses lead fields — the API body is empty (no re-typed data)', async () => {
    const res = await convertLead(
      // Caller sends NO body — conversion reads from the lead row itself.
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);

    const insertCustomer = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO customers/i.test(String(sql)),
    );
    expect(insertCustomer).toBeDefined();
    const [, params] = insertCustomer!;
    expect(params[0]).toBe(COMPANY); // company_name → name
    expect(params[1]).toBe(EMAIL);   // contact_email → email
    expect(params[2]).toBe(PHONE);   // contact_phone → phone
  });

  it('UPDATE leads links the lead row to the newly created customer', async () => {
    await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );

    const updateLead = queryMock.mock.calls.find(([sql]) =>
      /UPDATE leads[\s\S]*converted_customer_id/i.test(String(sql)),
    );
    expect(updateLead).toBeDefined();
    // First param of the UPDATE is the new customer id returned by the INSERT.
    expect(updateLead![1][0]).toBe(42);
    // Second is the acting user.
    expect(updateLead![1][1]).toBe(10);
  });

  it('response includes the new customerId so the caller can navigate to Module 3', async () => {
    const res = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { customerId: number; lead: { id: number } };
    expect(body.customerId).toBe(42);
    expect(body.lead.id).toBe(1);
  });

  it('audit entry records the convert action and the new customer id', async () => {
    await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );

    const audit = auditInserts().find((a) => a.params[4] === 'convert');
    expect(audit).toBeDefined();
    expect(audit!.params[0]).toBe(10);      // actorUserId = manager
    expect(audit!.params[2]).toBe('lead');  // entityType
    const changes = JSON.parse(String(audit!.params[6]));
    expect(changes.after.convertedCustomerId).toBe(42);
  });

  it('does not duplicate the customer if conversion is retried on an already-converted lead', async () => {
    // First call succeeds.
    await convertLead(req({ token: managerToken(), params: { id: '1' } }), {} as never);

    // Simulate the lead now showing as already converted.
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql))
        return [leadRow('WON', { company_name: COMPANY, converted_customer_id: 42 })];
      return [];
    });

    vi.clearAllMocks();
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM leads/i.test(sql))
        return [leadRow('WON', { company_name: COMPANY, converted_customer_id: 42 })];
      return [];
    });

    const retryRes = await convertLead(
      req({ token: managerToken(), params: { id: '1' } }),
      {} as never,
    );
    expect(retryRes.status).toBe(409);
    expect((retryRes.jsonBody as { error: { code: string } }).error.code).toBe('ALREADY_CONVERTED');
    // Second customer INSERT must not have been issued.
    expect(wasInserted('customers')).toBe(false);
  });
});

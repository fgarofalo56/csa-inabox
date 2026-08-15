/**
 * Backend contract tests for POST /api/data-products/[id]/certify (DP-5).
 *
 * Guards the no-vaporware certification gates: (1) a reviewer who IS the creator
 * is refused (403), (2) certifying with a failing automated check is refused
 * (422 with the precise blockers), (3) a distinct reviewer with all checks
 * green records the sign-off.
 *
 * The DQ gate is the mutation control for #3493: the route used to score
 * `enabled ÷ total` over the rule document without running a rule, so a product
 * whose every rule was failing scored 100 and certified. Here the rule store and
 * Kusto are mocked at the LEAF only — the real scorer executes — so the verdict
 * moves when the measured rules move. session, item-crud, and the search index
 * are mocked so this stays a backend contract spec.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const executeQuery = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const { NextResponse } = await import('next/server');
  return {
    loadOwnedItem: vi.fn(),
    updateOwnedItem: vi.fn(),
    jerr: (error: string, status = 500, code?: string) =>
      NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status }),
  };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: vi.fn(),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  itemsContainer: vi.fn(),
  // The DQ rules come from the tenant that OWNS the workspace, resolved here —
  // never from `session.claims.oid`, which is only the caller (#3499).
  workspacesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ tenantId: 'owner-tenant' }] }) }) },
  })),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: any[]) => executeQuery(...a),
  getTableCslSchema: vi.fn(),
  kustoConfigGate: () => (process.env.LOOM_KUSTO_CLUSTER_URI ? null : { missing: 'LOOM_KUSTO_CLUSTER_URI' }),
  defaultDatabase: () => 'loomdb-default',
  qName: (n: string) => `["${n}"]`,
  KustoError: class KustoError extends Error {},
}));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(async () => {}),
  docForDataProduct: vi.fn(() => ({})),
}));

import { POST } from '../[id]/certify/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }

/** A fully-certifiable item (all automated checks pass) created by 'creator'. */
function fullItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', createdBy: 'creator',
    displayName: 'Sales 360', description: 'x'.repeat(60),
    state: {
      owners: [{ id: 'o1' }], useCase: 'y'.repeat(40), glossaryLinks: [{ name: 'g' }],
      datasets: [{ name: 'sales' }], contract: { schema: [{ name: 'c' }], slo: { freshness: '1d' } },
      accessPolicy: { tier: 'a' }, sampleData: { rows: 5 },
      ...overrides,
    },
  } as any;
}
/** Single-row KQL result in the shape the scorer reads. */
function oneRow(map: Record<string, unknown>) {
  const columns = Object.keys(map);
  return {
    columns, columnTypes: columns.map(() => 'real'),
    rows: [columns.map((c) => map[c])], rowCount: 1, executionMs: 1, truncated: false,
  };
}

/** Two ENABLED DQ rules in the tenant store, scoped to the product's table. */
const TWO_RULES = [
  { id: 'r1', name: 'amount not null', scope: 'column:sales.amount', check: 'not-null', threshold: 95, enabled: true },
  { id: 'r2', name: 'id unique', scope: 'column:sales.id', check: 'unique', threshold: 99, enabled: true },
];

function stubDqRules(items: unknown[]) {
  (tenantSettingsContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { items } }) }),
  });
}

/** Two enabled rules, both MEASURED above their thresholds → DQ 100. */
function stubDqPass() {
  stubDqRules(TWO_RULES);
  executeQuery.mockResolvedValueOnce(oneRow({ pct: 99 })).mockResolvedValueOnce(oneRow({ pct: 100 }));
}

/** Two enabled rules, both MEASURED below their thresholds → DQ 0.
 *  Identical rule DOCUMENT to stubDqPass — only the measurement differs, which
 *  is exactly what the old enabled-counting score could not see. */
function stubDqFailing() {
  stubDqRules(TWO_RULES);
  executeQuery.mockResolvedValueOnce(oneRow({ pct: 10 })).mockResolvedValueOnce(oneRow({ pct: 20 }));
}

beforeEach(() => {
  vi.resetAllMocks();
  executeQuery.mockReset();
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});

describe('POST /api/data-products/[id]/certify', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(401);
  });

  it('400 on an unknown action', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'r' } });
    const res = await POST(req({ action: 'bogus' }), ctx('dp-1'));
    expect(res.status).toBe(400);
  });

  it('403 when the reviewer IS the creator', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'creator' } });
    (loadOwnedItem as any).mockResolvedValue(fullItem());
    stubDqPass();
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('reviewer_is_creator');
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 with precise blockers when an automated check fails', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    // No datasets → the assets check fails.
    (loadOwnedItem as any).mockResolvedValue(fullItem({ datasets: [] }));
    stubDqPass();
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe('checks_failed');
    expect(j.blockers.some((b: any) => b.id === 'assets')).toBe(true);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('200 records the sign-off when a distinct reviewer certifies an all-green product', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer', upn: 'rev@contoso.com' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    stubDqPass();
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.certification.state).toBe('certified');
    expect(j.certification.certifiedBy.oid).toBe('reviewer');
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state;
    expect(persisted.certificationState).toBe('certified');
    expect(persisted.certification.certifiedAt).toBeTruthy();
  });

  it('promote sets the lightweight endorsed signal (any owner, no reviewer gate)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'creator' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await POST(req({ action: 'promote' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).endorsed).toBe(true);
    expect((updateOwnedItem as any).mock.calls[0][3].state.endorsed).toBe(true);
  });
});

/**
 * MUTATION CONTROL for #3493. Every product below is otherwise fully certifiable
 * and carries the SAME enabled DQ-rule document as the green case — only the
 * measured rule outcome differs. Under the old `enabled ÷ total` score all of
 * these certified (200, state 'certified'); the gate could not fail.
 *
 * The Cosmos write is stubbed to SUCCEED in each case, so a refusal here is the
 * certification gate refusing — never a write that happened to fail.
 */
describe('certification refuses a product whose DQ rules do not PASS', () => {
  /** Let the sign-off write succeed, so only the gate can produce a non-200. */
  function allowSignOffWrite(item: any) {
    (updateOwnedItem as any).mockImplementation(
      async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }),
    );
  }

  it('422 when every enabled rule is measured as failing (old code: 200 certified)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer', upn: 'rev@contoso.com' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    allowSignOffWrite(item);
    stubDqFailing();

    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));

    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe('checks_failed');
    // The DQ check is the blocker, and it names the measured score.
    const dq = j.blockers.find((b: any) => b.id === 'dq');
    expect(dq).toBeTruthy();
    expect(dq.detail).toMatch(/DQ score 0 is below the 70 bar/);
    // No sign-off was recorded — the write was available and still never happened.
    expect(updateOwnedItem).not.toHaveBeenCalled();
    // The rules were actually EXECUTED — the old score never issued a query.
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it('422 when the rules average above the bar but NONE meets its own threshold', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    allowSignOffWrite(item);
    stubDqRules(TWO_RULES);
    // Mean 80 clears the 70 bar; thresholds are 95 and 99, so zero rules pass.
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 80 })).mockResolvedValueOnce(oneRow({ pct: 80 }));

    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));

    expect(res.status).toBe(422);
    expect((await res.json()).blockers.some((b: any) => b.id === 'dq')).toBe(true);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 with NO DQ rules at all — a product with nothing measured never certifies', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    allowSignOffWrite(item);
    stubDqRules([]);

    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));

    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.blockers.some((b: any) => b.id === 'dq')).toBe(true);
    // The response names the exact reason rather than a bare failed check.
    expect(j.dqGate).toMatch(/No data-quality rules apply/);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 when ADX is not provisioned — unmeasurable is not a pass', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    allowSignOffWrite(item);
    stubDqRules(TWO_RULES);

    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));

    expect(res.status).toBe(422);
    expect((await res.json()).dqGate).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  /**
   * The enforcement path must MEASURE, never read the stored measurement back.
   * Nothing pinned that before: no certify fixture carried `state.dqMeasurement`,
   * so "trust the record" would have failed closed by accident and a later
   * "prefer a fresh-enough persisted reading" optimisation could re-open #3493
   * through a side door with the whole suite green.
   */
  it('422 even when a PASSING measurement is already on the item — the sign-off re-measures', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    const item = fullItem({
      dqMeasurement: {
        score: 100, meanPercentage: 100, gate: null, gateId: null, missing: [],
        ruleCount: 2, passingRules: 2, breakdown: [],
        measuredAt: new Date().toISOString(),
      },
    });
    (loadOwnedItem as any).mockResolvedValue(item);
    allowSignOffWrite(item);
    // The rules are FAILING right now — only a live run can know that.
    stubDqFailing();

    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));

    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.blockers.some((b: any) => b.id === 'dq')).toBe(true);
    expect(j.blockers.find((b: any) => b.id === 'dq').detail).toMatch(/DQ score 0 is below the 70 bar/);
    // The stored 100 was not consulted; the rules were actually executed.
    expect(executeQuery).toHaveBeenCalledTimes(2);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });
});

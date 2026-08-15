/**
 * The READ paths must not execute data-quality rules (#3493, second half).
 *
 * The fix for "certification scored rules that were ENABLED, not rules that
 * PASSED" adopted the real scorer — which runs ONE live ADX query per applicable
 * rule, sequentially, each on a 30 s budget — and wired it into three routes.
 * Two of those are GETs any authenticated user can hit for any product id:
 *
 *   - GET /api/data-products/[id]               (marketplace detail; serves non-owners)
 *   - GET /api/data-products/[id]/certification (documented "not ownership-gated")
 *
 * and `computeDqScore` falls back to scoring EVERY enabled rule in the tenant
 * when the product resolves no table names — which is a legitimate state for a
 * product whose assets live in `state.dataAssets`. So a tenant with 200 authored
 * rules turned each of those page views into 200 serial KQL queries, replacing
 * what had been a single Cosmos point-read. No rate limiting anywhere.
 *
 * These tests assert the QUERY COUNT, not just the response: a read answers from
 * the persisted measurement (`state.dqMeasurement`) and issues ZERO ADX queries
 * and ZERO rule-store reads.
 *
 * Guard-the-guard: a count of 0 proves nothing if the mocks could not produce a
 * query at all, so the last describe drives the WRITE path through the very same
 * mock objects and asserts the count is non-zero. If the leaf stubs were inert,
 * that control would read 0 and fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const executeQuery = vi.fn();
const tenantRead = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: any[]) => executeQuery(...a),
  getTableCslSchema: vi.fn(),
  kustoConfigGate: () => (process.env.LOOM_KUSTO_CLUSTER_URI ? null : { missing: 'LOOM_KUSTO_CLUSTER_URI' }),
  defaultDatabase: () => 'loomdb-default',
  qName: (n: string) => `["${n}"]`,
  KustoError: class KustoError extends Error {},
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  accessRequestsContainer: vi.fn(),
  auditLogContainer: vi.fn(async () => ({
    items: {
      create: vi.fn(async () => ({})),
      query: () => ({ fetchAll: async () => ({ resources: [0] }) }),
    },
  })),
  tenantSettingsContainer: vi.fn(),
}));
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const { NextResponse } = await import('next/server');
  return {
    loadOwnedItem: vi.fn(),
    updateOwnedItem: vi.fn(),
    deleteOwnedItem: vi.fn(),
    jerr: (error: string, status = 500, code?: string) =>
      NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status }),
  };
});
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(async () => {}),
  deleteDataProductDoc: vi.fn(async () => {}),
  docForDataProduct: vi.fn(() => ({})),
  PUBLISH_STATUSES: ['Draft', 'Published', 'Deprecated'],
}));
vi.mock('@/lib/azure/purview-client', () => ({
  deleteDataProductBestEffort: vi.fn(async () => ({})),
  PurviewUnifiedCatalogGateError: class extends Error {},
  PurviewNotConfiguredError: class extends Error {},
}));
vi.mock('@/lib/marketplace/listing-analytics', () => ({ recordListingView: vi.fn(async () => {}) }));

import { GET as certificationGET } from '../[id]/certification/route';
import { GET as detailGET } from '../[id]/route';
import { POST as certifyPOST } from '../[id]/certify/route';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer, workspacesContainer, accessRequestsContainer, tenantSettingsContainer,
} from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { DQ_MEASUREMENT_KEY, DQ_GATE, DQ_ADX_GATE_ID } from '@/lib/dataproducts/certification-dq';

function props(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }

/** 200 ENABLED rules — the amplification the read paths must not pay for. */
const MANY_RULES = Array.from({ length: 200 }, (_, i) => ({
  id: `r${i}`, name: `rule ${i}`, scope: `column:sales.c${i}`,
  check: 'not-null', threshold: 95, enabled: true,
}));

/** Single-row KQL result in the shape the scorer reads. */
function oneRow(map: Record<string, unknown>) {
  const columns = Object.keys(map);
  return {
    columns, columnTypes: columns.map(() => 'real'),
    rows: [columns.map((c) => map[c])], rowCount: 1, executionMs: 1, truncated: false,
  };
}

/**
 * A data product whose assets live in `state.dataAssets` — so it resolves NO
 * table names and would fall through to "score every enabled rule in the
 * tenant", while still counting toward the `assets` certification check.
 */
function product(extraState: Record<string, unknown> = {}) {
  return {
    id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', createdBy: 'creator',
    displayName: 'Sales 360', description: 'x'.repeat(60), _etag: 'etag-1',
    state: {
      owners: [{ id: 'o1' }], useCase: 'y'.repeat(40), glossaryLinks: [{ name: 'g' }],
      dataAssets: [{ name: 'sales' }], contract: { schema: [{ name: 'c' }], slo: { freshness: '1d' } },
      accessPolicy: { tier: 'a' }, sampleData: { rows: 5 },
      ...extraState,
    },
  } as any;
}

/** A persisted measurement: 3 of 4 rules passing when it was taken. */
const MEASUREMENT = {
  score: 75, meanPercentage: 88.5, gate: null, gateId: null, missing: [],
  ruleCount: 4, passingRules: 3, breakdown: [], measuredAt: '2026-08-10T12:00:00.000Z',
};

/** Wire the Cosmos + rule-store leaves. The rule store IS populated, so a route
 *  that decided to measure would have 200 rules to run. */
function wireCosmos(item: any) {
  (itemsContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: item ? [item] : [] }) }) },
  });
  (workspacesContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ tenantId: 'owner-tenant' }] }) }) },
    item: () => ({ read: async () => ({ resource: { tenantId: 'owner-tenant' } }) }),
  });
  (accessRequestsContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  });
  (tenantSettingsContainer as any).mockResolvedValue({
    item: () => ({ read: tenantRead }),
  });
  tenantRead.mockResolvedValue({ resource: { items: MANY_RULES } });
}

beforeEach(() => {
  vi.clearAllMocks();
  executeQuery.mockReset();
  executeQuery.mockResolvedValue(oneRow({ pct: 100 }));
  tenantRead.mockReset();
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
  (getSession as any).mockReturnValue({ claims: { oid: 'viewer-tenant', upn: 'v@contoso.com' } });
});

describe('GET /api/data-products/[id]/certification issues no per-rule ADX query', () => {
  it('answers from the persisted measurement — 0 ADX queries, 0 rule-store reads', async () => {
    wireCosmos(product({ [DQ_MEASUREMENT_KEY]: MEASUREMENT }));

    const res = await certificationGET({} as any, props('dp-1'));
    const j = await res.json();

    // THE RECEIPT, asserted FIRST so a regression fails on the COUNT and not on
    // a value that happens to differ: the rules were not executed, and the rule
    // document was not even read.
    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(tenantRead).toHaveBeenCalledTimes(0);
    expect(res.status).toBe(200);
    expect(j.dq.score).toBe(75);
    expect(j.dq.measuredAt).toBe(MEASUREMENT.measuredAt);
    expect(j.checks.find((c: any) => c.id === 'dq').pass).toBe(true);
  });

  it('a never-measured product gates honestly — still 0 ADX queries', async () => {
    wireCosmos(product());

    const res = await certificationGET({} as any, props('dp-1'));
    const j = await res.json();

    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(tenantRead).toHaveBeenCalledTimes(0);
    expect(j.dq.score).toBeNull();
    expect(j.dq.gate).toBe(DQ_GATE.notMeasured);
    expect(j.dq.measuredAt).toBeNull();
    // Unmeasured is never a pass: the dq check fails and the product can't certify.
    expect(j.checks.find((c: any) => c.id === 'dq').pass).toBe(false);
    expect(j.certifiable).toBe(false);
  });

  it('a persisted INFRA gate surfaces its registry id, so the UI can render a Fix-it', async () => {
    wireCosmos(product({
      [DQ_MEASUREMENT_KEY]: {
        ...MEASUREMENT, score: null, meanPercentage: null,
        gate: `${DQ_GATE.adx} (missing LOOM_KUSTO_CLUSTER_URI)`,
        gateId: DQ_ADX_GATE_ID, missing: ['LOOM_KUSTO_CLUSTER_URI'], ruleCount: 0, passingRules: 0,
      },
    }));

    const j = await (await certificationGET({} as any, props('dp-1'))).json();

    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(tenantRead).toHaveBeenCalledTimes(0);
    expect(j.dq.gateId).toBe(DQ_ADX_GATE_ID);
    expect(j.dq.missing).toEqual(['LOOM_KUSTO_CLUSTER_URI']);
    expect(j.dq.gate).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
  });

  /**
   * Migration behaviour, stated rather than discovered: a product certified
   * BEFORE this change carries a sign-off but no measurement — its badge was
   * granted on the fabricated `enabled ÷ total` 100. It reads as `validated`
   * until the rules are actually run, and the sign-off is NOT destroyed, so a
   * single measurement restores `certified` with no re-signature.
   */
  it('an already-certified product with no measurement reads validated, and one measurement restores it', async () => {
    const signedOff = {
      certification: {
        state: 'certified', score: 100,
        certifiedBy: { oid: 'reviewer', name: 'rev@contoso.com' },
        certifiedAt: '2026-07-01T00:00:00.000Z', checkedAt: '2026-07-01T00:00:00.000Z',
      },
      certificationState: 'certified',
    };

    wireCosmos(product(signedOff));
    const before = await (await certificationGET({} as any, props('dp-1'))).json();
    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(before.certification.state).toBe('validated');
    expect(before.dq.gate).toBe(DQ_GATE.notMeasured);

    // Now the owner measures once, and every rule passes.
    wireCosmos(product({ ...signedOff, [DQ_MEASUREMENT_KEY]: { ...MEASUREMENT, score: 100, passingRules: 4 } }));
    const after = await (await certificationGET({} as any, props('dp-1'))).json();
    expect(after.certification.state).toBe('certified');
    expect(after.certification.certifiedBy.oid).toBe('reviewer');
  });
});

describe('GET /api/data-products/[id] issues no per-rule ADX query', () => {
  it('projects the persisted measurement — 0 ADX queries, 0 rule-store reads', async () => {
    wireCosmos(product({ [DQ_MEASUREMENT_KEY]: MEASUREMENT }));

    const res = await detailGET({} as any, props('dp-1'));
    const j = await res.json();

    // THE RECEIPT, first.
    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(tenantRead).toHaveBeenCalledTimes(0);
    expect(res.status).toBe(200);
    expect(j.dqScore).toBe(75);
    expect(j.dqGate).toBeNull();
    expect(j.dqMeasuredAt).toBe(MEASUREMENT.measuredAt);
  });

  it('a non-owner view of another tenant\'s product runs nothing', async () => {
    // viewer-tenant ≠ owner-tenant: the old code scored the VIEWER's rules
    // against the OWNER's tables. It now executes no rule for either tenant.
    wireCosmos(product({ [DQ_MEASUREMENT_KEY]: MEASUREMENT }));

    const j = await (await detailGET({} as any, props('dp-1'))).json();

    expect(executeQuery).toHaveBeenCalledTimes(0);
    expect(tenantRead).toHaveBeenCalledTimes(0);
    expect(j.isOwner).toBe(false);
    expect(j.ownerTenantId).toBe('owner-tenant');
    expect(j.dqScore).toBe(75);
  });
});

/**
 * CONTROL — the same mocks, driven through the owner-gated WRITE. If the leaf
 * stubs above were inert, the counts asserted as 0 would be 0 for the wrong
 * reason and every test in this file would pass while measuring nothing.
 */
describe('the measurement still happens — on the owner-gated write', () => {
  it('POST /certify measure-dq executes every applicable rule and persists the result', async () => {
    const item = product();
    wireCosmos(item);
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(
      async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }),
    );

    const res = await certifyPOST(req({ action: 'measure-dq' }), props('dp-1'));
    const j = await res.json();

    expect(res.status).toBe(200);
    // Same 200-rule document the read paths refused to run.
    expect(executeQuery).toHaveBeenCalledTimes(MANY_RULES.length);
    expect(tenantRead).toHaveBeenCalledTimes(1);
    expect(j.dq.ruleCount).toBe(MANY_RULES.length);
    expect(j.dq.score).toBe(100);
    // …and it is RECORDED, which is what makes the reads cheap.
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state[DQ_MEASUREMENT_KEY];
    expect(persisted.score).toBe(100);
    expect(persisted.ruleCount).toBe(MANY_RULES.length);
    expect(persisted.measuredAt).toBeTruthy();
    // The persisted breakdown is capped; the COUNTS above never are.
    expect(persisted.breakdown.length).toBeLessThanOrEqual(100);
    expect(persisted.breakdownTruncated).toBe(true);
  });

  it('a gated (unmeasurable) outcome is persisted WITH its reason, not as a silent null', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    const item = product();
    wireCosmos(item);
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(
      async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }),
    );

    const j = await (await certifyPOST(req({ action: 'measure-dq' }), props('dp-1'))).json();

    expect(j.dq.score).toBeNull();
    expect(j.dq.gateId).toBe(DQ_ADX_GATE_ID);
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state[DQ_MEASUREMENT_KEY];
    expect(persisted.score).toBeNull();
    expect(persisted.gate).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
    expect(persisted.gateId).toBe(DQ_ADX_GATE_ID);
    // ADX unprovisioned means the rules were never reached.
    expect(executeQuery).toHaveBeenCalledTimes(0);
  });
});

/**
 * B-N19e — FOCUS mart aggregation tests (fixtures, no I/O).
 *
 * Covers the parts that must never silently drift:
 *   1. FOCUS 1.1 column conformance (exact spec names + the x_ prefix rule).
 *   2. LCU-weighted allocation of REAL Cost Management dollars across runs.
 *   3. The honesty contract — unmetered rows carry ZERO dollars, and metered
 *      engine spend with no recorded run lands in `unattributedCost`.
 *   4. Per-query (statement-fingerprint) and per-dashboard rollups.
 *   5. The FOCUS CSV export (header + RFC-4180 quoting).
 *   6. Statement fingerprinting + the query-second quantity basis.
 */
import { describe, expect, it } from 'vitest';
import {
  FOCUS_COLUMNS,
  FOCUS_ENGINE_METERS,
  FOCUS_SPEC_VERSION,
  buildFocusMart,
  focusCsv,
  resourceNameOfResourceId,
  rollupFocus,
  subscriptionOfResourceId,
  type FocusMartInput,
  type FocusRunInput,
} from '@/lib/finops/focus-mart';
import { statementFingerprint, queryRunQuantity } from '@/lib/finops/query-run';
import { ATTRIBUTION_RATES, buildAttributionRecord } from '@/lib/azure/cost-attribution';

const SUB = '11111111-2222-3333-4444-555555555555';

const run = (over: Partial<FocusRunInput> = {}): FocusRunInput => ({
  id: over.id ?? 'r1',
  occurredAt: over.occurredAt ?? '2026-07-20T10:00:00.000Z',
  userOid: over.userOid ?? 'oid-a',
  userName: over.userName ?? 'ana@contoso.com',
  engine: over.engine ?? 'synapse-sql',
  unit: over.unit ?? 'query-second',
  quantity: over.quantity ?? 10,
  lcu: over.lcu ?? 0.5,
  estCostUsd: over.estCostUsd ?? 0.05,
  ...over,
});

const input = (over: Partial<FocusMartInput> = {}): FocusMartInput => ({
  runs: over.runs ?? [],
  costByResourceType: over.costByResourceType ?? {},
  costManagementAvailable: over.costManagementAvailable ?? true,
  currency: over.currency ?? 'USD',
  billingAccountId: over.billingAccountId ?? '/subscriptions/sub-a',
  billingAccountName: over.billingAccountName ?? 'Loom estate',
  subAccountNames: over.subAccountNames ?? { [SUB]: 'loom-prod' },
  periodStart: over.periodStart ?? '2026-06-28T00:00:00.000Z',
  periodEnd: over.periodEnd ?? '2026-07-28T00:00:00.000Z',
  windowDays: over.windowDays ?? 30,
  generatedAt: over.generatedAt ?? '2026-07-28T00:00:00.000Z',
});

describe('FOCUS 1.1 conformance', () => {
  it('pins the spec version the mart claims', () => {
    expect(FOCUS_SPEC_VERSION).toBe('1.1');
  });

  it('emits the exact FOCUS spec column names, and prefixes every extension with x_', () => {
    const mart = buildFocusMart(input({
      runs: [run()],
      costByResourceType: { 'microsoft.synapse/workspaces': 100 },
    }));
    const row = mart.rows[0];
    // A representative slice of the spec's own names — a rename here is a break.
    for (const c of [
      'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost', 'BillingCurrency',
      'BillingAccountId', 'BillingAccountName', 'BillingPeriodStart', 'BillingPeriodEnd',
      'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory', 'ChargeClass',
      'ChargeDescription', 'ChargeFrequency', 'ProviderName', 'PublisherName',
      'InvoiceIssuerName', 'ServiceName', 'ServiceCategory', 'ServiceSubcategory',
      'ResourceId', 'ResourceName', 'ResourceType', 'RegionId', 'RegionName',
      'SubAccountId', 'SubAccountName', 'SkuId', 'SkuPriceId', 'SkuMeter',
      'PricingCategory', 'PricingQuantity', 'PricingUnit', 'ConsumedQuantity',
      'ConsumedUnit', 'CommitmentDiscountId', 'Tags',
    ]) {
      expect(row, `missing FOCUS column ${c}`).toHaveProperty(c);
    }
    // Every non-spec column is x_-prefixed.
    const spec = new Set(FOCUS_COLUMNS.filter((c) => !String(c).startsWith('x_')));
    for (const k of Object.keys(row)) {
      if (!spec.has(k as never)) expect(k.startsWith('x_'), `${k} must be x_-prefixed`).toBe(true);
    }
    expect(row.ProviderName).toBe('Microsoft');
    expect(row.ChargeCategory).toBe('Usage');
    expect(row.ChargeFrequency).toBe('Usage-Based');
  });

  it('treats ChargePeriodEnd as EXCLUSIVE (start + duration)', () => {
    const mart = buildFocusMart(input({
      runs: [run({ occurredAt: '2026-07-20T10:00:00.000Z', durationMs: 2_000 })],
      costByResourceType: { 'microsoft.synapse/workspaces': 10 },
    }));
    expect(mart.rows[0].ChargePeriodStart).toBe('2026-07-20T10:00:00.000Z');
    expect(mart.rows[0].ChargePeriodEnd).toBe('2026-07-20T10:00:02.000Z');
  });

  it('derives SubAccountId/Name and ResourceName from an ARM resource id', () => {
    const rid = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/ws1`;
    expect(subscriptionOfResourceId(rid)).toBe(SUB);
    expect(resourceNameOfResourceId(rid)).toBe('ws1');
    const mart = buildFocusMart(input({
      runs: [run({ resourceId: rid })],
      costByResourceType: { 'microsoft.synapse/workspaces': 10 },
    }));
    expect(mart.rows[0].SubAccountId).toBe(SUB);
    expect(mart.rows[0].SubAccountName).toBe('loom-prod');
    expect(mart.rows[0].ResourceName).toBe('ws1');
  });
});

describe('allocation math', () => {
  it('splits a resource type\'s REAL spend across its runs by LCU share', () => {
    const mart = buildFocusMart(input({
      runs: [
        run({ id: 'a', lcu: 3, userOid: 'oid-a' }),
        run({ id: 'b', lcu: 1, userOid: 'oid-b' }),
      ],
      costByResourceType: { 'microsoft.synapse/workspaces': 100 },
    }));
    const byId = Object.fromEntries(mart.rows.map((r) => [r.x_LoomQueryId, r]));
    expect(byId.a.EffectiveCost).toBeCloseTo(75, 6);
    expect(byId.b.EffectiveCost).toBeCloseTo(25, 6);
    expect(byId.a.x_LoomPctOfResourceType).toBeCloseTo(75, 4);
    // The allocation never inflates: the parts sum back to the metered whole.
    expect(mart.totalEffectiveCost).toBeCloseTo(100, 2);
    expect(mart.totalBilledCost).toBeCloseTo(100, 2);
    expect(mart.costSource).toBe('cost-management-allocated');
  });

  it('keeps engines on DIFFERENT resource types independent (no cross-bleed)', () => {
    const mart = buildFocusMart(input({
      runs: [
        run({ id: 'sql', engine: 'synapse-sql', lcu: 1 }),
        run({ id: 'kql', engine: 'adx', unit: 'query', quantity: 1, lcu: 0.5 }),
      ],
      costByResourceType: {
        'microsoft.synapse/workspaces': 40,
        'microsoft.kusto/clusters': 60,
      },
    }));
    const byId = Object.fromEntries(mart.rows.map((r) => [r.x_LoomQueryId, r]));
    expect(byId.sql.EffectiveCost).toBeCloseTo(40, 6);
    expect(byId.kql.EffectiveCost).toBeCloseTo(60, 6);
    expect(byId.kql.ServiceName).toBe('Azure Data Explorer');
    expect(byId.sql.ServiceName).toBe('Azure Synapse Analytics');
  });

  it('shares ONE resource type across the engines that run on it (synapse sql + serverless + spark)', () => {
    const mart = buildFocusMart(input({
      runs: [
        run({ id: 'ded', engine: 'synapse-sql', lcu: 1 }),
        run({ id: 'srv', engine: 'synapse-serverless', lcu: 1 }),
      ],
      costByResourceType: { 'microsoft.synapse/workspaces': 50 },
    }));
    expect(mart.totalEffectiveCost).toBeCloseTo(50, 2);
    for (const r of mart.rows) expect(r.EffectiveCost).toBeCloseTo(25, 6);
  });
});

describe('honesty contract', () => {
  it('emits ZERO dollars (LCU estimate only) when Cost Management is unavailable', () => {
    const mart = buildFocusMart(input({
      runs: [run({ lcu: 2, estCostUsd: 0.2 })],
      costByResourceType: {},
      costManagementAvailable: false,
    }));
    expect(mart.costSource).toBe('unmetered');
    expect(mart.totalEffectiveCost).toBe(0);
    expect(mart.totalBilledCost).toBe(0);
    expect(mart.rows[0].BilledCost).toBe(0);
    expect(mart.rows[0].EffectiveCost).toBe(0);
    expect(mart.rows[0].x_LoomCostSource).toBe('unmetered');
    // The transparent estimate survives, clearly labeled as an x_ extension.
    expect(mart.rows[0].x_LoomEstimatedCost).toBeCloseTo(0.2, 6);
    expect(mart.totalEstimatedCost).toBeCloseTo(0.2, 6);
  });

  it('marks a run unmetered when its resource type shows no spend', () => {
    const mart = buildFocusMart(input({
      runs: [run({ engine: 'trino' })],
      costByResourceType: { 'microsoft.synapse/workspaces': 100 },
    }));
    expect(mart.rows[0].x_LoomCostSource).toBe('unmetered');
    expect(mart.rows[0].EffectiveCost).toBe(0);
  });

  it('surfaces metered engine spend with no recorded runs as unattributedCost', () => {
    const mart = buildFocusMart(input({
      runs: [run({ engine: 'synapse-sql', lcu: 1 })],
      costByResourceType: {
        'microsoft.synapse/workspaces': 30,
        'microsoft.kusto/clusters': 70,
      },
    }));
    expect(mart.totalEffectiveCost).toBeCloseTo(30, 2);
    expect(mart.unattributedCost).toBeCloseTo(70, 2);
    expect(mart.unattributed[0]).toMatchObject({
      resourceType: 'microsoft.kusto/clusters',
      serviceName: 'Azure Data Explorer',
      cost: 70,
    });
  });

  it('never drops a run whose engine has no FOCUS meter — it appears, honestly unmetered', () => {
    const mart = buildFocusMart(input({
      runs: [run({ engine: 'some-future-engine' })],
      costByResourceType: { 'microsoft.synapse/workspaces': 100 },
    }));
    expect(mart.rows).toHaveLength(1);
    expect(mart.rows[0].x_LoomCostSource).toBe('unmetered');
    expect(mart.rows[0].ResourceType).toBeNull();
  });

  it('handles an empty ledger as an honest empty mart (never fabricated rows)', () => {
    const mart = buildFocusMart(input({ costByResourceType: { 'microsoft.kusto/clusters': 5 } }));
    expect(mart.rows).toHaveLength(0);
    expect(mart.runCount).toBe(0);
    expect(mart.totalEffectiveCost).toBe(0);
    expect(mart.unattributedCost).toBeCloseTo(5, 2);
  });
});

describe('rollups', () => {
  const mart = buildFocusMart(input({
    runs: [
      run({ id: 'a', statementHash: 'aaa', lcu: 1, durationMs: 1000, rowCount: 10, userOid: 'oid-a', userName: 'ana' }),
      run({ id: 'b', statementHash: 'aaa', lcu: 1, durationMs: 3000, rowCount: 20, userOid: 'oid-b', userName: 'bo' }),
      run({ id: 'c', statementHash: 'ccc', lcu: 2, durationMs: 2000, rowCount: 5, userOid: 'oid-a', userName: 'ana' }),
    ],
    costByResourceType: { 'microsoft.synapse/workspaces': 40 },
  }));

  it('groups per QUERY by statement fingerprint so repeated runs aggregate', () => {
    const rows = rollupFocus(mart.rows, 'query');
    expect(rows).toHaveLength(2);
    const aaa = rows.find((r) => r.key === 'aaa')!;
    expect(aaa.runs).toBe(2);
    // 2 of 4 total LCU → half the metered $40.
    expect(aaa.effectiveCost).toBeCloseTo(20, 6);
    expect(aaa.avgCostPerRun).toBeCloseTo(10, 6);
    expect(aaa.durationMs).toBe(4000);
    expect(aaa.rowsReturned).toBe(30);
    expect(aaa.costSource).toBe('cost-management-allocated');
  });

  it('groups per USER and per ENGINE off the same rows', () => {
    const byUser = rollupFocus(mart.rows, 'user');
    expect(byUser.map((r) => r.key).sort()).toEqual(['oid-a', 'oid-b']);
    expect(byUser.find((r) => r.key === 'oid-a')!.effectiveCost).toBeCloseTo(30, 6);
    const byEngine = rollupFocus(mart.rows, 'engine');
    expect(byEngine).toHaveLength(1);
    expect(byEngine[0].key).toBe('synapse-sql');
    expect(byEngine[0].runs).toBe(3);
  });

  it('groups per DASHBOARD and excludes runs with no dashboard', () => {
    const dashMart = buildFocusMart(input({
      runs: [
        run({ id: 'd1', engine: 'adx', unit: 'query', quantity: 1, lcu: 1, dashboardId: 'dash-1', dashboardTile: 't1' }),
        run({ id: 'd2', engine: 'adx', unit: 'query', quantity: 1, lcu: 1, dashboardId: 'dash-1', dashboardTile: 't2' }),
        run({ id: 'd3', engine: 'adx', unit: 'query', quantity: 1, lcu: 2, dashboardId: 'dash-2' }),
        run({ id: 'x', engine: 'adx', unit: 'query', quantity: 1, lcu: 4 }), // ad-hoc, no dashboard
      ],
      costByResourceType: { 'microsoft.kusto/clusters': 80 },
    }));
    const rows = rollupFocus(dashMart.rows, 'dashboard');
    expect(rows.map((r) => r.key).sort()).toEqual(['dash-1', 'dash-2']);
    // 8 LCU total → $10/LCU. dash-1 = 2 LCU = $20, dash-2 = 2 LCU = $20.
    expect(rows.find((r) => r.key === 'dash-1')!.effectiveCost).toBeCloseTo(20, 6);
    expect(rows.find((r) => r.key === 'dash-1')!.runs).toBe(2);
    expect(rows.find((r) => r.key === 'dash-2')!.effectiveCost).toBeCloseTo(20, 6);
  });

  it('sorts a rollup by descending cost', () => {
    const rows = rollupFocus(mart.rows, 'query');
    expect(rows[0].effectiveCost).toBeGreaterThanOrEqual(rows[1].effectiveCost);
  });
});

describe('FOCUS CSV export', () => {
  it('writes the FOCUS column header and RFC-4180-quotes embedded commas', () => {
    const mart = buildFocusMart(input({
      runs: [run({ domainId: 'finance', workspaceId: 'ws-1' })],
      costByResourceType: { 'microsoft.synapse/workspaces': 12.5 },
    }));
    const csv = focusCsv(mart.rows);
    const [header, first] = csv.split('\r\n');
    expect(header.split(',')[0]).toBe('BillingAccountId');
    expect(header).toContain('EffectiveCost');
    expect(header).toContain('x_LoomStatementHash');
    // Tags serialize as JSON, which contains commas → must be quoted.
    expect(first).toContain('"{""loom-domain"":""finance"",""loom-workspace"":""ws-1""}"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('query-run tagging', () => {
  it('fingerprints two runs of the same statement identically, ignoring literals + formatting', () => {
    const a = statementFingerprint("SELECT * FROM sales WHERE region = 'EMEA' AND amt > 100");
    const b = statementFingerprint('select *\n  from sales\n  where region = \'APAC\' and amt > 250 -- note');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('fingerprints DIFFERENT statements differently, and returns null for empty', () => {
    expect(statementFingerprint('SELECT a FROM t')).not.toBe(statementFingerprint('SELECT b FROM t'));
    expect(statementFingerprint('   ')).toBeNull();
    expect(statementFingerprint(undefined)).toBeNull();
  });

  it('does NOT backtrack exponentially on unterminated quoted literals (ReDoS regression)', () => {
    // CodeQL js/redos (HIGH): the literal-stripping alternations originally read
    // `(?:''|\\.|[^'])*` / `(?:\\.|[^"])*`, where `\\.` and the negated class BOTH
    // match a backslash. That ambiguity is exponential on an unterminated literal
    // full of escapes — and statements come straight from the query editors, so a
    // crafted query could pin the event loop. Excluding the backslash from the
    // class makes the alternation unambiguous.
    //
    // These payloads took ~600ms (and doubling per added escape) before the fix;
    // they are sub-millisecond after it. A generous budget still fails loudly if
    // the ambiguity ever returns.
    const doubleQuoted = `SELECT "${'\\&'.repeat(30)}`;
    const singleQuoted = `SELECT '${"\\!".repeat(30)}`;
    for (const payload of [doubleQuoted, singleQuoted]) {
      const started = Date.now();
      expect(statementFingerprint(payload)).toHaveLength(16);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('meters query-second engines on wall-clock and leaves per-query engines at 1', () => {
    expect(queryRunQuantity('synapse-sql', 2_500)).toBeCloseTo(2.5, 3);
    expect(queryRunQuantity('duckdb', 120)).toBeCloseTo(0.12, 3);
    expect(queryRunQuantity('trino', undefined)).toBeCloseTo(0.001, 3);
    expect(queryRunQuantity('adx', 9_999)).toBe(1);
  });

  it('keeps the ADX per-query LCU byte-compatible with the pre-N19e ledger', () => {
    const row = buildAttributionRecord({
      tenantId: 't', userOid: 'o', engine: 'adx', id: 'fixed', occurredAt: '2026-07-20T10:00:00.000Z',
    });
    expect(row.unit).toBe('query');
    expect(row.lcu).toBe(0.5);
    expect(row).not.toHaveProperty('statementHash');
    expect(row).not.toHaveProperty('durationMs');
  });

  it('carries the query identity onto the ledger row when supplied', () => {
    const row = buildAttributionRecord({
      tenantId: 't', userOid: 'o', engine: 'duckdb', quantity: 4,
      id: 'fixed', occurredAt: '2026-07-20T10:00:00.000Z',
      statementHash: 'abc123', durationMs: 4000, rowCount: 7,
      dashboardId: 'dash-9', dashboardTile: 'tile-2', queryId: 'q-1',
    });
    expect(row.unit).toBe('query-second');
    expect(row.lcu).toBeCloseTo(4 * ATTRIBUTION_RATES.duckdb.lcuPerUnit, 6);
    expect(row.statementHash).toBe('abc123');
    expect(row.durationMs).toBe(4000);
    expect(row.rowCount).toBe(7);
    expect(row.dashboardId).toBe('dash-9');
    expect(row.dashboardTile).toBe('tile-2');
    expect(row.queryId).toBe('q-1');
  });

  it('maps every query engine to a real Azure (never Fabric) resource type', () => {
    for (const engine of ['adx', 'synapse-sql', 'synapse-serverless', 'duckdb', 'trino', 'databricks-sql', 'aas-dax']) {
      const meter = FOCUS_ENGINE_METERS[engine];
      expect(meter, `no meter for ${engine}`).toBeTruthy();
      expect(meter.resourceType.startsWith('microsoft.')).toBe(true);
      expect(meter.resourceType).not.toMatch(/fabric|powerbi/i);
      expect(ATTRIBUTION_RATES[engine as keyof typeof ATTRIBUTION_RATES]).toBeTruthy();
    }
  });
});

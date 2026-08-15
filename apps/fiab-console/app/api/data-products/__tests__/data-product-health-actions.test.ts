/**
 * POST /api/data-products/[id]/health-actions — `rerun-dq-check` (#3499 review).
 *
 * This route had NO test in the repo. It was rewritten from measure-and-discard
 * into one of the four producers the read-through DQ design depends on: it now
 * measures, PERSISTS the reading, reconciles the discovery badge, and reports
 * honestly when the write fails. A regression to the old discard behaviour would
 * have been invisible to CI — the gauge would keep showing a number while every
 * other surface showed the previous one.
 *
 * Leaf-only mocks: Kusto, the Cosmos rule store, the workspace lookup and the
 * item CRUD. The scorer and the certification engine run for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const executeQuery = vi.fn();
const tenantRead = vi.fn();
const tenantDocIds: string[] = [];
const OWNER_TENANT = 'owner-tenant';

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
  tenantSettingsContainer: vi.fn(async () => ({
    item: (docId: string) => { tenantDocIds.push(docId); return { read: tenantRead }; },
  })),
  workspacesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ tenantId: OWNER_TENANT }] }) }) },
  })),
}));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
}));
vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  triggerScanRun: vi.fn(),
  isPurviewConfigured: () => false,
  PurviewNotConfiguredError: class extends Error {},
  PurviewError: class extends Error {},
}));
vi.mock('@/lib/azure/shir-autoscale', () => ({ prewarmPurviewShirForScan: vi.fn(async () => null) }));
vi.mock('@/lib/azure/loom-data-products-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/azure/loom-data-products-search')>();
  return { ...actual, upsertDataProductDoc: vi.fn(async () => {}) };
});

import { POST } from '../[id]/health-actions/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { upsertDataProductDoc } from '@/lib/azure/loom-data-products-search';
import { DQ_MEASUREMENT_KEY } from '@/lib/dataproducts/certification-dq';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }

function oneRow(map: Record<string, unknown>) {
  const columns = Object.keys(map);
  return {
    columns, columnTypes: columns.map(() => 'real'),
    rows: [columns.map((c) => map[c])], rowCount: 1, executionMs: 1, truncated: false,
  };
}

const TWO_RULES = [
  { id: 'r1', name: 'amount not null', scope: 'column:sales.amount', check: 'not-null', threshold: 95, enabled: true },
  { id: 'r2', name: 'id unique', scope: 'column:sales.id', check: 'unique', threshold: 99, enabled: true },
];

function product() {
  return {
    id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', createdBy: 'creator',
    displayName: 'Sales 360', description: 'x'.repeat(60),
    state: {
      owners: [{ id: 'o1' }], useCase: 'y'.repeat(40), glossaryLinks: [{ name: 'g' }],
      datasets: [{ name: 'sales' }], databaseName: 'salesdb',
      contract: { schema: [{ name: 'c' }], slo: { freshness: '1d' } },
      accessPolicy: { tier: 'a' }, sampleData: { rows: 5 },
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  executeQuery.mockReset();
  tenantRead.mockReset();
  tenantRead.mockResolvedValue({ resource: { items: TWO_RULES } });
  tenantDocIds.length = 0;
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
  (getSession as any).mockReturnValue({ claims: { oid: 'collaborator-oid', upn: 'c@contoso.com' } });
  (loadOwnedItem as any).mockResolvedValue(product());
});

describe('POST /health-actions rerun-dq-check', () => {
  it('401 unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'));
    expect(res.status).toBe(401);
  });

  it('400 on an unknown action', async () => {
    const res = await POST(req({ action: 'bogus' }), ctx('dp-1'));
    expect(res.status).toBe(400);
  });

  it('503 with the exact env var when ADX is not provisioned — and writes nothing', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    const res = await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'));
    expect(res.status).toBe(503);
    expect((await res.json()).gate.missing).toBe('LOOM_KUSTO_CLUSTER_URI');
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('measures the rules and PERSISTS the reading (not just reports it)', async () => {
    const item = product();
    (updateOwnedItem as any).mockImplementation(
      async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }),
    );
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 99 })).mockResolvedValueOnce(oneRow({ pct: 100 }));

    const j = await (await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'))).json();

    expect(executeQuery).toHaveBeenCalledTimes(2);
    expect(j.result.outcome).toMatch(/DQ score recomputed: 100 \(2\/2 rules passing\)/);
    expect(j.result.persisted).toBe(true);
    // The record every READ surface renders — the point of the rewrite.
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state[DQ_MEASUREMENT_KEY];
    expect(persisted.score).toBe(100);
    expect(persisted.passingRules).toBe(2);
    expect(upsertDataProductDoc).toHaveBeenCalledTimes(1);
  });

  it('scores the OWNER\'s rules, not the caller\'s (a collaborator reaches this route)', async () => {
    (updateOwnedItem as any).mockResolvedValue(product());
    executeQuery.mockResolvedValue(oneRow({ pct: 100 }));

    await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'));

    expect(tenantDocIds).toEqual([`dq-rules:${OWNER_TENANT}`]);
    expect(tenantDocIds).not.toContain('dq-rules:collaborator-oid');
  });

  it('a FAILED persist is stated in the outcome the card renders, never reported as recomputed', async () => {
    // The card shows `result.outcome` and nothing else. Reporting a clean
    // "recomputed" for a reading that reached no read surface would be a success
    // claim on an unverified outcome (deploy-integrity R6).
    (updateOwnedItem as any).mockResolvedValue(null);
    executeQuery.mockResolvedValue(oneRow({ pct: 100 }));

    const j = await (await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'))).json();

    expect(j.result.persisted).toBe(false);
    expect(j.result.outcome).toMatch(/could NOT be written/i);
    expect(upsertDataProductDoc).not.toHaveBeenCalled();
  });

  it('an unmeasurable run reports the REASON as the outcome, not a fake score', async () => {
    tenantRead.mockResolvedValue({ resource: { items: [] } });
    (updateOwnedItem as any).mockImplementation(
      async (_i: string, _t: string, _o: string, patch: any) => ({ ...product(), state: patch.state }),
    );

    const j = await (await POST(req({ action: 'rerun-dq-check' }), ctx('dp-1'))).json();

    expect(j.result.outcome).toMatch(/No data-quality rules apply/);
    expect(j.result.certificationDqScore).toBeNull();
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

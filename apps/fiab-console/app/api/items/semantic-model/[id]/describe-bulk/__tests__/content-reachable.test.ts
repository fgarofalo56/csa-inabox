/**
 * #3549 / #3551 — the model's BULK AI-description surface must see a
 * bundle-installed model's tables.
 *
 * THE SECOND INSTANCE. `loadBulkContext` carried the identical shape to
 * `lib/semantic-model/model-context.ts`: it served `state.content` only when the
 * id carried the synthetic `loom:` list-route prefix, and fell through to a live
 * Power BI read otherwise. The editor opens a model by its BARE Cosmos id, so a
 * bundle-installed model reported ZERO tables here — "Generate descriptions for
 * all tables" had nothing to describe — while the install receipt reported its
 * tables created.
 *
 * This one was NOT found by reading the code. It was found by the sweep guard
 * `scripts/ci/check-installed-content-reachable.mjs` written for the first
 * instance, which is the whole argument for fixing the class rather than the
 * instance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const BARE_ID = 'c799fb18-1f0e-4f2b-9a30-1d4b2f0c77aa';
const TENANT = 'tenant-oid-1';
const WORKSPACE = 'uat-apps-1786813692048';

const CONTENT = {
  kind: 'semantic-model',
  tables: [
    {
      name: 'customer_daily_metrics',
      columns: [
        { name: 'user_id', dataType: 'string' },
        { name: 'metric_date', dataType: 'dateTime' },
        { name: 'total_revenue', dataType: 'decimal' },
      ],
    },
    { name: 'dim_product', columns: [{ name: 'product_id', dataType: 'string' }] },
  ],
  measures: [{ table: 'customer_daily_metrics', name: 'Total Revenue', expression: 'SUM(x)' }],
};

const item = {
  id: BARE_ID,
  workspaceId: WORKSPACE,
  itemType: 'semantic-model',
  displayName: 'Real-Time Analytics Semantic Model',
  state: { sourceApp: 'app-azure-realtime-analytics', content: CONTENT },
};

const itemQuery = vi.fn(async () => ({ resources: [item] }));
const workspaceRead = vi.fn(async () => ({ resource: { id: WORKSPACE, tenantId: TENANT } }));

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: TENANT } }) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ items: { query: () => ({ fetchAll: itemQuery }) } })),
  workspacesContainer: vi.fn(async () => ({ item: () => ({ read: workspaceRead }) })),
}));

const listDatasetTables = vi.fn(async () => { throw new Error('PowerBI 404'); });
vi.mock('@/lib/azure/powerbi-client', () => ({
  getDataset: vi.fn(async () => { throw new Error('PowerBI 404'); }),
  listDatasetTables: (...a: unknown[]) => listDatasetTables(...(a as [])),
}));
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChat: vi.fn(async () => '{}') }));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async () => null) }));
vi.mock('@/lib/azure/aas-client', () => ({
  aasXmlaConfig: vi.fn(() => ({ configured: false })),
  command: vi.fn(async () => ({})),
  AasError: class extends Error {},
}));
vi.mock('../../../../_lib/semantic-model-store', () => ({
  readSmModelState: vi.fn(async () => ({ tableDescriptions: [] })),
  writeSmModelState: vi.fn(async () => ({})),
  upsertTableDescriptions: vi.fn((s: unknown) => s),
}));
vi.mock('../../../../_lib/model-store', () => ({
  readModelState: vi.fn(async () => ({ state: { measures: [] }, itemFound: false })),
  writeModelState: vi.fn(async () => ({})),
}));

import { GET } from '../route';

function req(qs = '') {
  return { nextUrl: new URL(`http://localhost/api/items/semantic-model/${BARE_ID}/describe-bulk${qs}`) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  itemQuery.mockResolvedValue({ resources: [item] } as never);
  workspaceRead.mockResolvedValue({ resource: { id: WORKSPACE, tenantId: TENANT } } as never);
});

describe('#3549/#3551 describe-bulk GET — bundle content reachable by the BARE item id', () => {
  it('counts the installed tables and columns for a bare Cosmos id', async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: BARE_ID }) });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.counts.tables).toBe(2);
    expect(body.counts.columns).toBe(4);
    expect(body.modelName).toBe('Real-Time Analytics Semantic Model');
  });

  it('serves the model WITHOUT reaching Power BI (no-fabric-dependency)', async () => {
    await GET(req(), { params: Promise.resolve({ id: BARE_ID }) });
    expect(listDatasetTables).not.toHaveBeenCalled();
  });

  it('the synthetic loom: id keeps working', async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: `loom:${BARE_ID}` }) });
    const body = await res.json();
    expect(body.counts.tables).toBe(2);
  });

  it('a live Power BI dataset id still takes the live path', async () => {
    itemQuery.mockResolvedValue({ resources: [] } as never);
    listDatasetTables.mockResolvedValue([{ name: 'pbi_table', columns: [{ name: 'c1' }] }] as never);

    const res = await GET(req('?workspaceId=pbi-group-1'), {
      params: Promise.resolve({ id: '11111111-2222-3333-4444-555555555555' }),
    });
    const body = await res.json();

    expect(listDatasetTables).toHaveBeenCalled();
    expect(body.counts.tables).toBe(1);
  });
});

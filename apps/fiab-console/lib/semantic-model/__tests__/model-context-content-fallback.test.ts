/**
 * #3549 / #3551 — a bundle-installed semantic model opened by its OWN Cosmos
 * item id must render its bundle tables/measures.
 *
 * THE DEFECT THIS PINS. `POST /api/apps/[id]/install` stamps the bundle's
 * `SemanticModelContent` onto the Cosmos item at `state.content`
 * (route.ts: `...(bundle?.content ? { content: bundle.content } : {})`), and
 * the semantic-model provisioner reports `created` with the table/measure
 * counts read off that content. But `loadModelContext` — the ONLY source of
 * `tables` for `GET /api/items/semantic-model/[id]/model`, which is what
 * `LoomNativeModelView` renders — consulted `state.content` ONLY when the id
 * carried the synthetic `loom:` list-route prefix. The editor opens an item by
 * its BARE Cosmos id, so every bundle-installed model fell through to the live
 * Power BI branch, which has no dataset for that id and returns zero tables.
 *
 * Live symptom (#3551, Commercial, 2026-08-18): "Real-Time Analytics Semantic
 * Model" shows the banner "2 tables · 4 measures" over a body reading "This
 * Loom-native tabular model has no tables yet", with every storage action
 * disabled. The content was never missing — it was never READ.
 *
 * The fixture mirrors `app-azure-realtime-analytics` exactly (2 tables,
 * 4 measures, 1 relationship) so the numbers here are the numbers on the
 * banner the operator measured.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const BARE_ITEM_ID = 'c799fb18-1f0e-4f2b-9a30-1d4b2f0c77aa';
const TENANT = 'tenant-oid-1';
const WORKSPACE = 'uat-apps-1786813692048';

/** Byte-for-byte the shape `app-azure-realtime-analytics` installs. */
const RTA_CONTENT = {
  kind: 'semantic-model',
  tables: [
    {
      name: 'customer_daily_metrics',
      columns: [
        { name: 'user_id', dataType: 'string' },
        { name: 'metric_date', dataType: 'dateTime' },
        { name: 'event_count', dataType: 'int64' },
        { name: 'total_revenue', dataType: 'decimal' },
        { name: 'unique_products', dataType: 'int64' },
      ],
    },
    {
      name: 'dim_product',
      columns: [
        { name: 'product_id', dataType: 'string' },
        { name: 'product_name', dataType: 'string' },
        { name: 'category', dataType: 'string' },
        { name: 'list_price', dataType: 'decimal' },
      ],
    },
  ],
  measures: [
    { table: 'customer_daily_metrics', name: 'Total Revenue', expression: 'SUM(customer_daily_metrics[total_revenue])' },
    { table: 'customer_daily_metrics', name: 'Active Users', expression: 'DISTINCTCOUNT(customer_daily_metrics[user_id])' },
    { table: 'customer_daily_metrics', name: 'Events', expression: 'SUM(customer_daily_metrics[event_count])' },
    { table: 'dim_product', name: 'Product Count', expression: 'DISTINCTCOUNT(dim_product[product_id])' },
  ],
  relationships: [
    { from: 'customer_daily_metrics.product_id', to: 'dim_product.product_id', cardinality: '1:many' },
  ],
};

const installedItem = {
  id: BARE_ITEM_ID,
  workspaceId: WORKSPACE,
  itemType: 'semantic-model',
  displayName: 'Real-Time Analytics Semantic Model',
  state: { sourceApp: 'app-azure-realtime-analytics', content: RTA_CONTENT },
};

const itemQuery = vi.fn(async () => ({ resources: [installedItem] }));
const workspaceRead = vi.fn(async () => ({ resource: { id: WORKSPACE, tenantId: TENANT } }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ items: { query: () => ({ fetchAll: itemQuery }) } })),
  workspacesContainer: vi.fn(async () => ({ item: () => ({ read: workspaceRead }) })),
}));

// The live Power BI branch must never be what serves a Loom-native item. These
// mocks stand in for a tenant with NO Power BI: every call rejects, exactly as
// it does on the default estate (no-fabric-dependency.md).
const getDataset = vi.fn(async () => { throw new Error('PowerBI 404: dataset not found'); });
const listDatasetTables = vi.fn(async () => { throw new Error('PowerBI 404: dataset not found'); });
const listDatasetRelationships = vi.fn(async () => { throw new Error('PowerBI 404: dataset not found'); });
vi.mock('@/lib/azure/powerbi-client', () => ({
  getDataset: (...a: unknown[]) => getDataset(...(a as [])),
  listDatasetTables: (...a: unknown[]) => listDatasetTables(...(a as [])),
  listDatasetRelationships: (...a: unknown[]) => listDatasetRelationships(...(a as [])),
  PowerBiError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
}));

vi.mock('@/lib/azure/aas-client', () => ({
  buildModelBimTmsl: vi.fn(() => ({})),
  buildCreateOrReplaceRelationshipTmsl: vi.fn(() => ({})),
  buildDeleteRelationshipTmsl: vi.fn(() => ({})),
  buildAlterTableHierarchyTmsl: vi.fn(() => ({})),
  executeAasXmla: vi.fn(async () => ({})),
  updateFabricSemanticModelTmsl: vi.fn(async () => ({})),
  aasConfig: vi.fn(() => ({ configured: false })),
  fabricWriteEnabled: vi.fn(() => false),
}));

import { loadModelContext } from '../model-context';

beforeEach(() => {
  vi.clearAllMocks();
  itemQuery.mockResolvedValue({ resources: [installedItem] } as never);
  workspaceRead.mockResolvedValue({ resource: { id: WORKSPACE, tenantId: TENANT } } as never);
});

describe('#3549/#3551 loadModelContext — bundle content is reachable by the BARE item id', () => {
  it('a bare Cosmos item id resolves the installed tables, columns and measures', async () => {
    // No `workspaceId`: LoomNativeModelView calls
    // `/api/items/semantic-model/${id}/model` with NO query string at all.
    const mctx = await loadModelContext(BARE_ITEM_ID, null, TENANT);

    // The exact counts the install banner claims.
    expect(mctx.tables).toHaveLength(2);
    expect(mctx.measures).toHaveLength(4);

    expect(mctx.tables.map((t) => t.name)).toEqual(['customer_daily_metrics', 'dim_product']);
    expect(mctx.tables[0].columns).toHaveLength(5);
    expect(mctx.tables[0].columns[3]).toEqual({ name: 'total_revenue', type: 'decimal' });
    expect(mctx.measures?.map((m) => m.name)).toContain('Total Revenue');
    expect(mctx.modelName).toBe('Real-Time Analytics Semantic Model');
  });

  it('the relationship declared in the bundle survives as a base relationship', async () => {
    const mctx = await loadModelContext(BARE_ITEM_ID, null, TENANT);
    expect(mctx.baseRels).toHaveLength(1);
    expect(mctx.baseRels[0].fromTable).toBe('customer_daily_metrics');
    expect(mctx.baseRels[0].toTable).toBe('dim_product');
  });

  it('a content-backed item is served WITHOUT touching Power BI', async () => {
    // no-fabric-dependency.md: the default path must not reach api.powerbi.com.
    await loadModelContext(BARE_ITEM_ID, null, TENANT);
    expect(getDataset).not.toHaveBeenCalled();
    expect(listDatasetTables).not.toHaveBeenCalled();
  });

  it('the synthetic loom: id keeps working (list-route entries are unchanged)', async () => {
    const mctx = await loadModelContext(`loom:${BARE_ITEM_ID}`, null, TENANT);
    expect(mctx.tables).toHaveLength(2);
    expect(mctx.measures).toHaveLength(4);
  });

  it('an id that is NOT a Loom semantic-model item still falls through to Power BI', async () => {
    // A genuine Power BI dataset GUID resolves no Cosmos item; the live branch
    // must still run so the opt-in Power BI path is untouched.
    itemQuery.mockResolvedValue({ resources: [] } as never);
    const mctx = await loadModelContext('11111111-2222-3333-4444-555555555555', 'pbi-group-1', TENANT);
    expect(mctx.liveDataset).toBe(true);
    expect(listDatasetTables).toHaveBeenCalled();
  });

  it('an item whose ownership check fails is NOT served from content', async () => {
    // Cross-tenant guard: a foreign workspace must not leak its model shape.
    workspaceRead.mockResolvedValue({ resource: { id: WORKSPACE, tenantId: 'someone-else' } } as never);
    const mctx = await loadModelContext(BARE_ITEM_ID, null, TENANT);
    expect(mctx.tables).toHaveLength(0);
  });
});

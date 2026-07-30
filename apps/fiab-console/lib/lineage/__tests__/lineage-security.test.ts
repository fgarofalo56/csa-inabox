/**
 * LU-8 — SECURITY SPECS. Every case here is an ATTACK, not a happy path.
 *
 * These exist because the first pass of LU-8 shipped five real holes that the
 * feature specs could not see: a SAS token written into the persisted lineage
 * store, an unvalidated `runId` driving a write, a pool-scoped Livy batch id
 * harvested from another team's job, a cross-workspace forgery probe that one
 * of the two producers simply did not run, and an ownership-claim widening that
 * could turn a would-be 403 into an allow.
 *
 * Each spec asserts the DENIAL — that the attacker's data does NOT reach the
 * store, the graph, or the canvas label. A spec proving a legitimate write
 * succeeds proves nothing about any of these.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {}
  class UnityCatalogError extends Error { status = 500; }
  class PurviewNotConfiguredError extends Error {}
  class PurviewError extends Error { status = 500; }
  return { UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError, PurviewError };
});

const edgesWritten: any[] = [];
const auditRows: any[] = [];
const siemEvents: any[] = [];

const mocks = vi.hoisted(() => ({
  getPipeline: vi.fn(),
  getDataset: vi.fn(),
  getLinkedService: vi.fn(),
  listActivityRuns: vi.fn(async () => []),
  queryItems: vi.fn(),
  /** ws1 is owned by `owner-1` unless a spec says otherwise. */
  workspaceRows: vi.fn(() => [{ tenantId: 'owner-1' }]),
}));

vi.mock('@/lib/azure/adf-client', () => ({
  getPipeline: mocks.getPipeline,
  getDataset: mocks.getDataset,
  getLinkedService: mocks.getLinkedService,
  listActivityRuns: mocks.listActivityRuns,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  // The resolver runs TWO different queries against `items`: the
  // workspace-scoped candidate load (`WHERE c.workspaceId = @w`) and the
  // cross-workspace forgery probe (`WHERE c.workspaceId != @w`). Dispatch on
  // the query text, not on call order, so a spec cannot pass by accident.
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => mocks.queryItems(String(spec?.query || '')),
      }),
    },
  }),
  auditLogContainer: async () => ({
    items: { create: async (d: any) => { auditRows.push(d); return { resource: d }; } },
  }),
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: mocks.workspaceRows() }) }) },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (e: any) => { siemEvents.push(e); },
}));

vi.mock('@/lib/thread/thread-edges', () => ({
  // Mirror the real sink's partitioning: tenantId comes from the WRITE session.
  recordThreadEdge: vi.fn(async (s: any, e: any) => {
    edgesWritten.push({
      ...e,
      id: `e${edgesWritten.length}`,
      tenantId: s?.claims?.oid,
      createdBy: s?.claims?.upn,
      createdAt: '2026-07-28T00:00:00Z',
    });
  }),
  listThreadEdges: vi.fn(async () => edgesWritten),
}));

vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => false),
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  getColumnLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null),
  listWorkspaceHostnames: vi.fn(() => { throw new H.UnityCatalogNotConfiguredError('uc off'); }),
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));
vi.mock('@/lib/azure/asset-identity', () => ({
  resolveAssetIdentities: vi.fn(async (i: any) => i),
  storagePathIdentity: vi.fn(() => undefined),
}));

import {
  harvestPipelineRunLineage,
  harvestSparkBatchLineage,
  __resetHarvestDedupe,
} from '@/lib/lineage/synapse-lineage-harvest';
import {
  canonicalStorageUri,
  canonicalDatasetIdentity,
  parseStorageUri,
  parseStorageAccountUrl,
  stripUriCredentials,
} from '@/lib/lineage/dataset-naming';
import { statePaths, resolveOwner, findForeignOwner } from '@/lib/lineage/dataset-item-resolver';
import { normalizeIdentity } from '@/lib/azure/unified-lineage';
import { batchBelongsToItem } from '@/app/api/items/spark-job-definition/[id]/runs/[runId]/route';
import { LINEAGE_DENIED_KIND } from '@/lib/lineage/lineage-audit';

const session = { claims: { oid: 'owner-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any;

/** The caller's own workspace (ws1) and a DIFFERENT team's workspace (ws2). */
const OWN_ITEMS = [
  { id: 'lh-bronze', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Bronze',
    state: { adlsRoot: 'abfss://data@stloom.dfs.core.windows.net/bronze' } },
];
const FOREIGN_ITEMS = [
  { id: 'lh-other-team', workspaceId: 'ws2', itemType: 'lakehouse', displayName: 'OtherTeamGold',
    state: { adlsRoot: 'abfss://secret@stother.dfs.core.windows.net/finance' } },
];

/** Wire the two item queries by INTENT, not by call order. */
function wireItems(own: any[] = OWN_ITEMS, foreign: any[] = FOREIGN_ITEMS) {
  mocks.queryItems.mockImplementation(async (query: string) =>
    ({ resources: query.includes('!= @w') ? foreign : own }));
}

beforeEach(() => {
  edgesWritten.length = 0;
  auditRows.length = 0;
  siemEvents.length = 0;
  __resetHarvestDedupe();
  vi.clearAllMocks();
  wireItems();
  mocks.workspaceRows.mockReturnValue([{ tenantId: 'owner-1' }]);
});

// ===========================================================================
// 1. SAS TOKEN / CREDENTIAL LEAK
// ===========================================================================

describe('ATTACK: a SAS token must never reach the persisted lineage store', () => {
  const SAS = 'https://stloom.blob.core.windows.net/data/silver/sales?sv=2021-08-06&st=2026-01-01&sig=SUPERSECRETSIGNATURE%3D';
  const SAS_ABFSS = 'abfss://data@stloom.dfs.core.windows.net/silver/sales?sv=2021-08-06&sig=SUPERSECRETSIGNATURE';

  it('strips the query string from the canonical identity (https and abfss spellings)', () => {
    expect(canonicalStorageUri(SAS)).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(canonicalStorageUri(SAS_ABFSS)).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(parseStorageUri(SAS)!.path).toBe('silver/sales');
    for (const v of [canonicalStorageUri(SAS), canonicalStorageUri(SAS_ABFSS), normalizeIdentity(SAS)]) {
      expect(v).not.toMatch(/sig=/i);
      expect(v).not.toMatch(/supersecret/i);
    }
  });

  it('strips the query string on the NON-Azure fallback path too (nothing passes through raw)', () => {
    // s3 is not parseable as Azure storage — the fallback used to return the
    // raw string, query and all.
    const s3 = 's3://bucket/key?X-Amz-Signature=DEADBEEF';
    expect(canonicalStorageUri(s3)).toBe('s3://bucket/key');
    expect(normalizeIdentity(s3)).not.toMatch(/signature/i);
  });

  it('strips URI userinfo — a password must not be smuggled into the account slot', () => {
    const withCreds = 'https://user:hunter2@stloom.dfs.core.windows.net/data/silver';
    expect(stripUriCredentials(withCreds)).toBe('https://stloom.dfs.core.windows.net/data/silver');
    expect(canonicalStorageUri(withCreds)).toBe('abfss://data@stloom.dfs.core.windows.net/silver');
    expect(canonicalStorageUri(withCreds)).not.toMatch(/hunter2/);
    // …and the abfss `container@account` form, which is NOT userinfo, survives.
    expect(canonicalStorageUri('abfss://data@stloom.dfs.core.windows.net/silver'))
      .toBe('abfss://data@stloom.dfs.core.windows.net/silver');
  });

  it('refuses to treat a credential pair as an account name', () => {
    // `[^./]+` would happily capture `user:p%40ss@stloom` as the account.
    expect(parseStorageUri('abfss://data@user:p%40ss@stloom.dfs.core.windows.net/silver')).toBeNull();
    expect(parseStorageAccountUrl('https://stloom.dfs.core.windows.net?sv=1&sig=X'))
      .toEqual({ account: 'stloom', suffix: 'core.windows.net' });
  });

  it('END TO END: a SAS-bearing Spark argv writes NO secret into any edge field', async () => {
    const r = await harvestSparkBatchLineage(session, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 7, jobName: 'leaky', state: 'success', attributed: true,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output', SAS_ABFSS,
      ],
    });
    expect(r.written).toBe(1);
    const serialized = JSON.stringify(edgesWritten);
    expect(serialized).not.toMatch(/sig=/i);
    expect(serialized).not.toMatch(/supersecret/i);
    expect(serialized).not.toMatch(/sv=2021/);
    // The endpoint id AND the rendered node label are both clean.
    const edge = edgesWritten[0];
    expect(edge.toItemId).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(edge.toName).toBe('silver/sales');
  });

  it('END TO END: a SAS on an ADF linked-service url does not ride into the edge', async () => {
    mocks.getLinkedService.mockResolvedValue({
      name: 'ls', properties: { type: 'AzureBlobFS', typeProperties: { url: 'https://stloom.dfs.core.windows.net?sv=2021-08-06&sig=LEAKME' } },
    });
    mocks.getDataset.mockImplementation(async (n: string) => ({
      name: n,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: 'ls' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: n === 'src' ? 'bronze/sales' : 'gold/sales' } },
      },
    }));
    mocks.listActivityRuns.mockResolvedValue([
      { activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded' },
    ]);
    mocks.getPipeline.mockResolvedValue({
      name: 'p', properties: { activities: [{ name: 'Copy1', type: 'Copy', inputs: [{ referenceName: 'src' }], outputs: [{ referenceName: 'snk' }] }] },
    });
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'r1', runStatus: 'Succeeded',
    });
    expect(r.written).toBe(1);
    expect(JSON.stringify(edgesWritten)).not.toMatch(/LEAKME|sig=/i);
  });
});

// ===========================================================================
// 2. CROSS-WORKSPACE WRITE — the probe both producers must run
// ===========================================================================

describe('ATTACK: a dataset owned by ANOTHER workspace must not be written or disclosed', () => {
  it('refuses the edge, audits the denial, and leaks no path into the caller graph', async () => {
    const r = await harvestSparkBatchLineage(session, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 11, jobName: 'crosser', state: 'success', attributed: true,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        // ws2's storage — a different account AND container.
        '--output', 'abfss://secret@stother.dfs.core.windows.net/finance/payroll',
      ],
    });
    // NEGATIVE: nothing written, and the foreign path is nowhere in the store.
    expect(r.written).toBe(0);
    expect(r.denied).toBe(1);
    expect(edgesWritten).toHaveLength(0);
    expect(JSON.stringify(edgesWritten)).not.toMatch(/stother|payroll|finance/i);

    // The denial is auditable — the failure mode the ingest route already
    // guarded and the harvest did not.
    const denial = auditRows.find((a) => a.kind === LINEAGE_DENIED_KIND);
    expect(denial).toBeTruthy();
    expect(denial.detail.targetWorkspaceId).toBe('ws2');
    expect(denial.detail.producer).toBe('synapse-spark-harvest');
    expect(siemEvents.some((e) => e.outcome === 'denied' && e.action === LINEAGE_DENIED_KIND)).toBe(true);
  });

  it('the pipeline producer enforces the SAME rule (no asymmetry between producers)', async () => {
    mocks.getLinkedService.mockResolvedValue({
      name: 'ls', properties: { type: 'AzureBlobFS', typeProperties: { url: 'https://stother.dfs.core.windows.net' } },
    });
    mocks.getDataset.mockImplementation(async (n: string) => ({
      name: n,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: 'ls' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'secret', folderPath: n === 'src' ? 'finance/in' : 'finance/out' } },
      },
    }));
    mocks.listActivityRuns.mockResolvedValue([
      { activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded' },
    ]);
    mocks.getPipeline.mockResolvedValue({
      name: 'p', properties: { activities: [{ name: 'Copy1', type: 'Copy', inputs: [{ referenceName: 'src' }], outputs: [{ referenceName: 'snk' }] }] },
    });
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'rx', runStatus: 'Succeeded',
    });
    expect(r.written).toBe(0);
    expect(r.denied).toBe(1);
    expect(edgesWritten).toHaveLength(0);
    expect(auditRows.some((a) => a.kind === LINEAGE_DENIED_KIND && a.detail.producer === 'adf-pipeline-harvest')).toBe(true);
  });

  it('an UNOWNED path (owned by nobody) is still recorded as an external node', async () => {
    wireItems(OWN_ITEMS, []); // no foreign owner
    const r = await harvestSparkBatchLineage(session, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 12, jobName: 'ok', state: 'success', attributed: true,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output', 'abfss://data@stloom.dfs.core.windows.net/scratch/tmp',
      ],
    });
    expect(r.written).toBe(1);
    expect(r.denied).toBe(0);
    expect(edgesWritten[0].toExternal).toBe(true);
  });
});

// ===========================================================================
// 3. OWNERSHIP-CLAIM WIDENING — folding a claim must not create an owner
// ===========================================================================

describe('ATTACK: a folded ownership claim must not swallow sibling datasets', () => {
  it('an item rooted at a part-file folder does NOT claim the parent folder', () => {
    // foldToTableFolder('warehouses/part-a') === 'warehouses'. If that fold were
    // applied to the CLAIM, this item would own every dataset under
    // /warehouses — including other teams' — and, because a resolved local
    // owner short-circuits the foreign probe, a would-be 403 would become an
    // allow.
    const claim = statePaths({ adlsRoot: 'abfss://data@stloom.dfs.core.windows.net/warehouses/part-a' });
    expect(claim).toEqual(['abfss://data@stloom.dfs.core.windows.net/warehouses/part-a']);

    const item = { id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse', paths: claim };
    // A sibling under the PARENT folder must not resolve to it.
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/other-team', [item])).toBeNull();
    // Its own subtree still does.
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/part-a/f.parquet', [item])?.id).toBe('i1');
  });

  it('the foreign probe still matches across spellings after canonicalization', async () => {
    // The extraction folded BOTH sides through canonicalStorageUri. Prove the
    // probe still fires when the foreign item stored the https spelling and the
    // incoming URI is abfss (the case that previously silently missed).
    mocks.queryItems.mockResolvedValue({
      resources: [{ id: 'foreign', workspaceId: 'ws2', itemType: 'lakehouse',
        state: { adlsRoot: 'https://stother.dfs.core.windows.net/secret/finance' } }],
    });
    const hit = await findForeignOwner('abfss://secret@stother.dfs.core.windows.net/finance/payroll/_delta_log', 'ws1');
    expect(hit?.workspaceId).toBe('ws2');
    // …and does NOT fire on a prefix look-alike (no false 403 / no false owner).
    const miss = await findForeignOwner('abfss://secret@stother.dfs.core.windows.net/finance-archive/x', 'ws1');
    expect(miss).toBeNull();
  });
});

// ===========================================================================
// 4. POOL-SCOPED LIVY BATCH IDS
// ===========================================================================

describe('ATTACK: a Livy batch this item did not submit must not be harvested', () => {
  it('an unattributed batch writes nothing and says why', async () => {
    const r = await harvestSparkBatchLineage(session, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 4242, jobName: 'other-teams-job', state: 'success',
      attributed: false,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output', 'abfss://data@stloom.dfs.core.windows.net/silver/sales',
      ],
    });
    expect(r.written).toBe(0);
    expect(edgesWritten).toHaveLength(0);
    expect(r.reason).toMatch(/not submitted by this Loom item/);
  });

  it('attribution matches only batches this item submitted', () => {
    const item = { displayName: 'Bronze To Silver' };
    expect(batchBelongsToItem(item, { name: 'loom-Bronze_To_Silver-1753740000000' })).toBe(true);
    // Another Loom item on the same pool.
    expect(batchBelongsToItem(item, { name: 'loom-Some_Other_Job-1753740000000' })).toBe(false);
    // A batch submitted straight from Synapse Studio.
    expect(batchBelongsToItem(item, { name: 'adhoc-notebook-run' })).toBe(false);
    // A name-prefix confusable ("Bronze To Silver" vs "Bronze To Silver Extra").
    expect(batchBelongsToItem({ displayName: 'Bronze To Silver Extra' }, { name: 'loom-Bronze_To_Silver-1' })).toBe(false);
    expect(batchBelongsToItem(item, {})).toBe(false);
  });

  it('two batches sharing an id across a pool RECREATE are not conflated', async () => {
    const common = {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 1, jobName: 'j', state: 'success', attributed: true,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output', 'abfss://data@stloom.dfs.core.windows.net/silver/sales',
      ],
    };
    const a = await harvestSparkBatchLineage(session, { ...common, eventTime: '2026-01-01T00:00:00Z' });
    const b = await harvestSparkBatchLineage(session, { ...common, eventTime: '2026-06-01T00:00:00Z' });
    // The second is a genuinely different run and must NOT be dropped as a dupe.
    expect(a.written).toBe(1);
    expect(b.written).toBe(1);
  });
});

// ===========================================================================
// 5. RUN-STATUS GATE + DEDUPE CORRECTNESS
// ===========================================================================

describe('harvest gating and dedupe', () => {
  beforeEach(() => {
    mocks.getLinkedService.mockResolvedValue({
      name: 'ls', properties: { type: 'AzureBlobFS', typeProperties: { url: 'https://stloom.dfs.core.windows.net' } },
    });
    mocks.getDataset.mockImplementation(async (n: string) => ({
      name: n,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: 'ls' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: n === 'src' ? 'bronze/sales' : 'silver/sales' } },
      },
    }));
    mocks.listActivityRuns.mockResolvedValue([
      { activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded' },
    ]);
    mocks.getPipeline.mockResolvedValue({
      name: 'p', properties: { activities: [{ name: 'Copy1', type: 'Copy', inputs: [{ referenceName: 'src' }], outputs: [{ referenceName: 'snk' }] }] },
    });
  });

  it('an ABSENT runStatus does NOT bypass the succeeded-only gate', async () => {
    // The Output route used to call the harvest with no runStatus at all, so
    // opening the Output pane on a FAILED run performed the whole ARM harvest
    // and wrote edges. Unknown must be treated as not-succeeded.
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'no-status',
    });
    expect(r.written).toBe(0);
    expect(mocks.getPipeline).not.toHaveBeenCalled();
    expect(r.reason).toMatch(/only stamped for a succeeded run/);
  });

  it('a transient ADF failure does NOT permanently destroy that run\'s lineage', async () => {
    // The dedupe used to be marked BEFORE the work, so one ARM 429 meant the
    // run was "already harvested" forever on that replica — 0 edges, no retry.
    mocks.getPipeline.mockRejectedValueOnce(new Error('ARM 429 throttled'));
    const input = { workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'flaky', runStatus: 'Succeeded' };
    const first = await harvestPipelineRunLineage(session, input);
    expect(first).toMatchObject({ ok: false });
    expect(first.error).toMatch(/429/);

    const second = await harvestPipelineRunLineage(session, input);
    expect(second.ok).toBe(true);
    expect(second.written).toBe(1); // the retry actually harvested
  });

  it('a SUCCEEDED run is still harvested exactly once per replica', async () => {
    const input = { workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'once', runStatus: 'Succeeded' };
    const first = await harvestPipelineRunLineage(session, input);
    const second = await harvestPipelineRunLineage(session, input);
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.reason).toMatch(/already harvested/);
    expect(mocks.getPipeline).toHaveBeenCalledTimes(1);
  });

  it('writes are audited, not just denials', async () => {
    await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'audited', runStatus: 'Succeeded',
    });
    const row = auditRows.find((a) => a.kind === 'lineage.harvested');
    expect(row).toBeTruthy();
    expect(row.detail).toMatchObject({ producer: 'adf-pipeline-harvest', written: 1 });
  });
});

// ===========================================================================
// 6. THE SQL JOIN — the property the PR sells, asserted end to end
// ===========================================================================

describe('a SQL sink collapses onto the uc: node, not a sqlserver:// island', () => {
  it('canonicalDatasetIdentity reduces a SQL relation URI to the bare 3-part name', () => {
    expect(canonicalDatasetIdentity('sqlserver://syn.sql.azuresynapse.net:1433/loomdw.sales.orders'))
      .toBe('loomdw.sales.orders');
    // …which is the ONLY spelling normalizeIdentity turns into a uc: key.
    expect(normalizeIdentity(canonicalDatasetIdentity('sqlserver://syn.sql.azuresynapse.net:1433/loomdw.sales.orders')))
      .toBe('uc:loomdw.sales.orders');
    // The full URI does NOT (this was the actual defect).
    expect(normalizeIdentity('sqlserver://syn.sql.azuresynapse.net:1433/loomdw.sales.orders'))
      .not.toMatch(/^uc:/);
  });

  it('END TO END: a pipeline Copy into a SQL table persists the uc:-joinable id', async () => {
    mocks.getLinkedService.mockImplementation(async (n: string) =>
      n === 'ls_sql'
        ? { name: n, properties: { type: 'AzureSqlDW', typeProperties: { connectionString: 'Server=tcp:syn.sql.azuresynapse.net;Initial Catalog=loomdw;' } } }
        : { name: n, properties: { type: 'AzureBlobFS', typeProperties: { url: 'https://stloom.dfs.core.windows.net' } } });
    mocks.getDataset.mockImplementation(async (n: string) =>
      n === 'snk'
        ? { name: n, properties: { type: 'AzureSqlDWTable', linkedServiceName: { referenceName: 'ls_sql' }, typeProperties: { schema: 'sales', table: 'orders' } } }
        : { name: n, properties: { type: 'Parquet', linkedServiceName: { referenceName: 'ls_adls' }, typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: 'bronze/sales' } } } });
    mocks.listActivityRuns.mockResolvedValue([
      { activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded' },
    ]);
    mocks.getPipeline.mockResolvedValue({
      name: 'p', properties: { activities: [{ name: 'Copy1', type: 'Copy', inputs: [{ referenceName: 'src' }], outputs: [{ referenceName: 'snk' }] }] },
    });
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'p', factoryName: 'adf', runId: 'sql-1', runStatus: 'Succeeded',
    });
    expect(r.written).toBe(1);
    // The PERSISTED endpoint — not a function's return value in isolation.
    expect(edgesWritten[0].toItemId).toBe('loomdw.sales.orders');
    expect(normalizeIdentity(edgesWritten[0].toItemId)).toBe('uc:loomdw.sales.orders');
  });
});

// ===========================================================================
// 7. WRITE PARTITION — shared workspaces must not get split, private lineage
// ===========================================================================

describe('harvested edges land in the workspace OWNER partition', () => {
  it('an ACL member harvest writes to the OWNER partition, attributed to the member', async () => {
    // loadOwnedItem admits any canWrite ACL member, so `session` here is a
    // MEMBER, not the owner. Writing with the member's oid would bury the edges
    // in the member's private thread-edge partition: the owner's lineage canvas
    // would never render them and every member would accumulate a duplicate.
    mocks.workspaceRows.mockReturnValue([{ tenantId: 'the-owner-oid' }]);
    const member = { claims: { oid: 'member-9', upn: 'member@b.com' }, exp: Date.now() / 1000 + 3600 } as any;
    const r = await harvestSparkBatchLineage(member, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 77, jobName: 'shared', state: 'success', attributed: true,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output', 'abfss://data@stloom.dfs.core.windows.net/silver/sales',
      ],
    });
    expect(r.written).toBe(1);
    expect(edgesWritten[0].tenantId).toBe('the-owner-oid');
    // Attribution is NOT lost — the real actor is on the row and on the audit.
    expect(edgesWritten[0].createdBy).toBe('member@b.com');
    expect(auditRows.find((a) => a.kind === 'lineage.harvested').actorOid).toBe('member-9');
  });
});

// ===========================================================================
// 8. ONELAKE identities must not be silently re-keyed
// ===========================================================================

describe('OneLake keeps its own spelling', () => {
  it('is not folded into a fabricated container@account identity', () => {
    const ol = 'https://onelake.dfs.fabric.microsoft.com/wsid/lhid/Tables/sales';
    expect(parseStorageUri(ol)).toBeNull();
    // The pre-existing OneLake join key is preserved (the workspace GUID is NOT
    // fabricated into a container slot).
    expect(normalizeIdentity(ol)).toBe(`path:${ol.toLowerCase()}`);
  });
});

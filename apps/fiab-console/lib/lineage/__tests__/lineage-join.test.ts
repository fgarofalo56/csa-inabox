/**
 * LU-8 — THE JOIN PROOF.
 *
 * Dataset naming is where lineage graphs silently fail to join: an ADLS folder
 * emitted one way by Spark and another way by a pipeline produces two
 * disconnected nodes that each look perfectly fine on the canvas. This spec
 * emits from BOTH sides against the SAME physical folders — spelled the way
 * each producer really spells them — and asserts the merged graph is ONE
 * connected chain.
 *
 * Nothing is asserted against the function that produced it: the Spark side is
 * driven by argv (`abfss://…/_delta_log`), the pipeline side by an ADF dataset
 * descriptor (`fileSystem` + `folderPath` on an `https://…dfs…` linked
 * service), and the assertions are made on the output of the REAL merge engine
 * (`getUnifiedLineage`) fed with the REAL edges the harvesters wrote.
 *
 * Deleting any part of the canonicalization fails this spec:
 *   - drop the https→abfss mapping  → the pipeline's sink never resolves to the
 *     gold lakehouse item, and the Purview node stops merging;
 *   - drop the `_delta_log` fold    → Spark's output ≠ the pipeline's source,
 *     the chain breaks and gold is unreachable from bronze;
 *   - drop `weaveEndpointIdentities`→ the physical silver node no longer
 *     collapses with the Purview node for the same path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — every Azure client is stubbed; the naming, emitters, mapper, resolver
// and merge engine all run for real.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {}
  class UnityCatalogError extends Error { status = 500; }
  class PurviewNotConfiguredError extends Error {}
  class PurviewError extends Error { status = 500; }
  return { UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError, PurviewError };
});

/** Loom items that own a physical path. Gold deliberately stores the https
 *  spelling — the spelling that used to make it un-resolvable. */
const ITEMS = [
  {
    id: 'lh-bronze', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Bronze',
    state: { adlsRoot: 'abfss://data@stloom.dfs.core.windows.net/bronze' },
  },
  {
    id: 'lh-gold', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Gold',
    state: { adlsRoot: 'https://stloom.dfs.core.windows.net/data/gold' },
  },
];

const edgesWritten: any[] = [];

const mocks = vi.hoisted(() => ({
  getPipeline: vi.fn(),
  getDataset: vi.fn(),
  getLinkedService: vi.fn(),
  listActivityRuns: vi.fn(async () => []),
  queryItems: vi.fn(),
}));

vi.mock('@/lib/azure/adf-client', () => ({
  getPipeline: mocks.getPipeline,
  getDataset: mocks.getDataset,
  getLinkedService: mocks.getLinkedService,
  listActivityRuns: mocks.listActivityRuns,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: mocks.queryItems }) } }),
}));

vi.mock('@/lib/thread/thread-edges', () => ({
  recordThreadEdge: vi.fn(async (_s: unknown, e: any) => {
    edgesWritten.push({ ...e, id: `e${edgesWritten.length}`, tenantId: 't', createdAt: '2026-07-28T00:00:00Z' });
  }),
  listThreadEdges: vi.fn(async () => edgesWritten),
}));

vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => true),
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
import { getUnifiedLineage, normalizeIdentity } from '@/lib/azure/unified-lineage';

const session = { claims: { oid: 'owner-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any;

/** The shared middle dataset, in canonical form. */
const SILVER = 'abfss://data@stloom.dfs.core.windows.net/silver/sales';

// --- ADF fixtures: the pipeline reads silver and writes gold ----------------
const ADLS_LS = { name: 'ls_adls', properties: { type: 'AzureBlobFS', typeProperties: { url: 'https://stloom.dfs.core.windows.net' } } };
const DATASETS: Record<string, any> = {
  ds_silver: {
    name: 'ds_silver',
    properties: {
      type: 'Parquet',
      linkedServiceName: { referenceName: 'ls_adls', type: 'LinkedServiceReference' },
      // NOTE the spelling: container + folder, no scheme. Nothing here says "abfss".
      typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: 'silver/sales' } },
      schema: [{ name: 'id' }, { name: 'total' }],
    },
  },
  ds_gold: {
    name: 'ds_gold',
    properties: {
      type: 'Parquet',
      linkedServiceName: { referenceName: 'ls_adls', type: 'LinkedServiceReference' },
      typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: 'gold/sales' } },
      schema: [{ name: 'id' }, { name: 'revenue' }],
    },
  },
};

beforeEach(() => {
  edgesWritten.length = 0;
  __resetHarvestDedupe();
  vi.clearAllMocks();
  mocks.queryItems.mockResolvedValue({ resources: ITEMS });
  mocks.getLinkedService.mockImplementation(async () => ADLS_LS);
  mocks.getDataset.mockImplementation(async (n: string) => DATASETS[n]);
  mocks.listActivityRuns.mockResolvedValue([
    { activityRunId: 'a1', activityName: 'CopySilverToGold', activityType: 'Copy', status: 'Succeeded' },
  ]);
  mocks.getPipeline.mockResolvedValue({
    name: 'silver-to-gold',
    properties: {
      activities: [{
        name: 'CopySilverToGold',
        type: 'Copy',
        inputs: [{ referenceName: 'ds_silver', type: 'DatasetReference' }],
        outputs: [{ referenceName: 'ds_gold', type: 'DatasetReference' }],
        typeProperties: {
          translator: { type: 'TabularTranslator', mappings: [{ source: { name: 'total' }, sink: { name: 'revenue' } }] },
        },
      }],
    },
  });
});

/** Run both producers over the shared folders. */
async function emitBothSides() {
  // Spark writes silver — and names it the way a Spark job really does, by its
  // Delta transaction log.
  const spark = await harvestSparkBatchLineage(session, {
    workspaceId: 'ws1',
    synapseWorkspaceName: 'syn-loom',
    poolName: 'loompool',
    batchId: 42,
    jobName: 'bronze-to-silver',
    state: 'success',
    args: [
      '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
      '--output', 'abfss://data@stloom.dfs.core.windows.net/silver/sales/_delta_log',
    ],
  });
  // The pipeline reads silver — named by container + folder on an https linked
  // service — and writes gold.
  const pipeline = await harvestPipelineRunLineage(session, {
    workspaceId: 'ws1',
    adfPipelineName: 'silver-to-gold',
    factoryName: 'adf-loom',
    runId: 'run-1',
    runStatus: 'Succeeded',
    runEnd: '2026-07-28T02:00:00.000Z',
  });
  return { spark, pipeline };
}

describe('LU-8 join: Spark + pipeline emit onto ONE node', () => {
  it('both harvests write real edges over the SAME canonical silver dataset', async () => {
    const { spark, pipeline } = await emitBothSides();
    expect(spark).toMatchObject({ ok: true, events: 1, written: 1 });
    expect(pipeline).toMatchObject({ ok: true, events: 1, written: 1 });

    const sparkEdge = edgesWritten.find((e) => e.action === 'openlineage-spark');
    const pipeEdge = edgesWritten.find((e) => e.action === 'openlineage-pipeline');

    // Spark's output id and the pipeline's input id are the SAME string, even
    // though one came from `…/_delta_log` and the other from fileSystem+folder.
    expect(sparkEdge.toItemId).toBe(SILVER);
    expect(pipeEdge.fromItemId).toBe(SILVER);

    // Loom-item endpoints resolve to items on both sides — including the gold
    // lakehouse whose state stores the https spelling.
    expect(sparkEdge.fromItemId).toBe('lh-bronze');
    expect(pipeEdge.toItemId).toBe('lh-gold');

    // The Copy translator's declared column mapping rides the edge.
    expect(pipeEdge.columnMappings).toEqual([
      { fromColumn: 'total', toColumn: 'revenue', confidence: 'declared' },
    ]);
  });

  it('renders as ONE connected chain: bronze → silver → gold', async () => {
    await emitBothSides();
    const g = await getUnifiedLineage({ session, itemId: 'lh-bronze', itemType: 'lakehouse' });

    // Exactly one node for the shared physical dataset.
    const silverNodes = g.nodes.filter((n) => n.id === SILVER || n.identity === `path:${SILVER}`);
    expect(silverNodes).toHaveLength(1);

    // Gold is REACHABLE from bronze — it only is if the middle node joined.
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('lh-bronze')).toBe(true);
    expect(ids.has('lh-gold')).toBe(true);

    const reach = new Set(['lh-bronze']);
    for (let i = 0; i < g.edges.length; i++) {
      for (const e of g.edges) if (reach.has(e.from)) reach.add(e.to);
    }
    expect(reach.has('lh-gold')).toBe(true);
  });

  it('collapses the emitted physical node with the Purview node for the same path', async () => {
    await emitBothSides();
    // Purview's view of the same estate: the bronze lakehouse (the focus asset,
    // known to Purview by guid) feeding the silver folder. Purview names ADLS
    // assets by their https dfs qualifiedName; `displayText` is only the leaf.
    const g = await getUnifiedLineage({
      session,
      itemId: 'lh-bronze',
      itemType: 'lakehouse',
      purviewGuid: 'G-bronze',
      atlasFetcher: async () => ({
        baseEntityGuid: 'G-bronze',
        guidEntityMap: {
          'G-bronze': {
            guid: 'G-bronze', typeName: 'azure_datalake_gen2_path', displayText: 'bronze',
            qualifiedName: 'https://stloom.dfs.core.windows.net/data/bronze',
          },
          'G-silver': {
            guid: 'G-silver', typeName: 'azure_datalake_gen2_path', displayText: 'sales',
            qualifiedName: 'https://stloom.dfs.core.windows.net/data/silver/sales',
          },
        },
        relations: [{ fromEntityId: 'G-bronze', toEntityId: 'G-silver' }],
      }),
    });

    // The Purview asset and the emitter's physical dataset are ONE node,
    // credited to BOTH sources.
    const merged = g.nodes.filter((n) => n.identity === `path:${SILVER}`);
    expect(merged).toHaveLength(1);
    expect(merged[0].multiSource).toEqual(['purview', 'weave']);
    // Nothing is left over: no second node still carrying the raw abfss id.
    expect(g.nodes.filter((n) => n.id === SILVER && n.id !== merged[0].id)).toHaveLength(0);
    // …and the edges were rewritten onto the survivor, so bronze still reaches
    // gold THROUGH the merged node.
    const reach = new Set(['lh-bronze']);
    for (let i = 0; i < g.edges.length; i++) {
      for (const e of g.edges) if (reach.has(e.from)) reach.add(e.to);
    }
    expect(reach.has(merged[0].id)).toBe(true);
    expect(reach.has('lh-gold')).toBe(true);
  });

  it('normalizes every spelling of the silver folder to the same identity', () => {
    const spellings = [
      SILVER,
      `${SILVER}/_delta_log`,
      'https://stloom.dfs.core.windows.net/data/silver/sales',
      'wasbs://data@stloom.blob.core.windows.net/silver/sales/',
    ];
    expect(new Set(spellings.map(normalizeIdentity))).toEqual(new Set([`path:${SILVER}`]));
  });
});

describe('LU-8 harvest guards', () => {
  it('does not stamp lineage for a run that did not succeed', async () => {
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'silver-to-gold', factoryName: 'adf-loom',
      runId: 'run-2', runStatus: 'Failed',
    });
    expect(r.written).toBe(0);
    expect(r.reason).toContain('Failed');
    expect(edgesWritten).toHaveLength(0);
    expect(mocks.getPipeline).not.toHaveBeenCalled();
  });

  it('drops an activity that did not run in THIS pipeline run', async () => {
    mocks.listActivityRuns.mockResolvedValue([
      { activityRunId: 'a9', activityName: 'SomeOtherActivity', activityType: 'Copy', status: 'Succeeded' },
    ]);
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'silver-to-gold', factoryName: 'adf-loom',
      runId: 'run-3', runStatus: 'Succeeded',
    });
    expect(r.written).toBe(0);
    expect(r.reason).toContain('no Copy activity');
  });

  it('harvests a run once per replica', async () => {
    const input = {
      workspaceId: 'ws1', adfPipelineName: 'silver-to-gold', factoryName: 'adf-loom',
      runId: 'run-4', runStatus: 'Succeeded',
    };
    const first = await harvestPipelineRunLineage(session, input);
    const second = await harvestPipelineRunLineage(session, input);
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.reason).toContain('already harvested');
    expect(mocks.getPipeline).toHaveBeenCalledTimes(1);
  });

  it('never throws when the ADF read fails — the run poll still succeeds', async () => {
    mocks.getPipeline.mockRejectedValue(new Error('ARM 403 Forbidden'));
    const r = await harvestPipelineRunLineage(session, {
      workspaceId: 'ws1', adfPipelineName: 'silver-to-gold', factoryName: 'adf-loom',
      runId: 'run-5', runStatus: 'Succeeded',
    });
    expect(r).toMatchObject({ ok: false, written: 0 });
    expect(r.error).toContain('403');
  });

  it('reports an honest reason (naming the listener) when a Spark batch declares no datasets', async () => {
    const r = await harvestSparkBatchLineage(session, {
      workspaceId: 'ws1', synapseWorkspaceName: 'syn-loom', poolName: 'loompool',
      batchId: 99, jobName: 'opaque', state: 'success', args: ['--mode', 'overwrite'],
    });
    expect(r.written).toBe(0);
    expect(r.reason).toContain('openlineage-spark listener');
    expect(edgesWritten).toHaveLength(0);
  });
});

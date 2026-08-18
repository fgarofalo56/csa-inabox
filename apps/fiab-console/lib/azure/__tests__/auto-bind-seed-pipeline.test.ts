/**
 * #3549 — the REAL pipeline providers, seeding a REAL pipeline document.
 *
 * The sibling `auto-bind-seed.test.ts` proves the ENGINE calls the hook. This
 * file proves the hook the ADF/Synapse providers actually register produces the
 * right BYTES, because getting the wire shape wrong would swap one silent
 * failure for another: a pipeline whose PUT is rejected, or accepted with
 * activities the service cannot execute.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE TRAP THIS PINS
 * ---------------------------------------------------------------------------
 * Two translators exist for the same bundle content and they DISAGREE:
 *
 *   buildDevPipelineProperties (install)  lifts description/policy/
 *       linkedServiceName/inputs/outputs to the activity ROOT and puts
 *       everything else under `typeProperties` — the ADF/Synapse WIRE format.
 *
 *   pipelineDefinitionFromContent (editor) spreads `config` straight onto the
 *       activity root — a CANVAS-RENDER shape, which as a PUT body would put
 *       `notebookPath` at the activity root where ADF does not look for it.
 *
 * The install path uses the first, and the four pipelines that actually worked
 * in the live factory came from it. So the seed must use the first too. The
 * `typeProperties` assertions below are what stop a future refactor quietly
 * switching to the render-shaped one.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `auto-bind-seed.seedPipelineFromContent`, swap
 *      `upsertAndRunDevPipeline` for `pipelineDefinitionFromContent` → RED:
 *        "puts activity type-properties under typeProperties, not the root"
 *   b) Drop `{ skipRun: true }` → RED:
 *        "authors the pipeline WITHOUT triggering a billed run"
 *   c) Return `{seeded:true}` unconditionally instead of checking
 *      `seed.upserted` → RED:
 *        "reports seeded:false with the reason when the PUT is refused"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake ADF / Synapse control planes. Both record the document they were asked
// to PUT, which is the artefact under test.
// ---------------------------------------------------------------------------
const adfPlane = {
  puts: [] as Array<{ name: string; body: any }>,
  linkedServices: [] as string[],
  datasets: [] as string[],
  runs: [] as string[],
  putThrows: null as unknown,
};
const synapsePlane = {
  puts: [] as Array<{ name: string; body: any }>,
  runs: [] as string[],
};

/**
 * A fresh factory/workspace: nothing exists under any of the names the pipeline
 * references, so every GET 404s and the stubber is free to create.
 *
 * These reads are load-bearing, not scenery (#3549 review, BLOCKER 1): the
 * reference stubber is create-if-absent, and answering "already there" would
 * make it adopt instead of author. A `.status = 404` throw is exactly what
 * `adf-client` / `synapse-dev-client` raise for a missing artifact.
 */
function notFound(label: string) {
  return Object.assign(new Error(`${label} failed 404: {"error":{"code":"NotFound"}}`), { status: 404 });
}

vi.mock('@/lib/azure/adf-client', () => ({
  upsertPipeline: vi.fn(async (name: string, body: any) => {
    if (adfPlane.putThrows) { const e = adfPlane.putThrows; adfPlane.putThrows = null; throw e; }
    adfPlane.puts.push({ name, body });
  }),
  runPipeline: vi.fn(async (name: string) => { adfPlane.runs.push(name); return { runId: 'run-1' }; }),
  listPipelineRuns: vi.fn(async () => []),
  upsertLinkedService: vi.fn(async (name: string) => { adfPlane.linkedServices.push(name); }),
  upsertDataset: vi.fn(async (name: string) => { adfPlane.datasets.push(name); }),
  getLinkedService: vi.fn(async (name: string) => { throw notFound(`getLinkedService(${name})`); }),
  getDataset: vi.fn(async (name: string) => { throw notFound(`getDataset(${name})`); }),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  upsertPipeline: vi.fn(async (name: string, body: any) => { synapsePlane.puts.push({ name, body }); }),
  runPipeline: vi.fn(async (name: string) => { synapsePlane.runs.push(name); return { runId: 'run-1' }; }),
  getPipelineRun: vi.fn(async () => ({ status: 'Succeeded' })),
  upsertLinkedService: vi.fn(async () => {}),
  upsertDataset: vi.fn(async () => {}),
  getLinkedService: vi.fn(async (name: string) => { throw notFound(`getLinkedService(${name})`); }),
  getDataset: vi.fn(async (name: string) => { throw notFound(`getDataset(${name})`); }),
  synapseConfigGate: vi.fn(() => null),
}));

// The real one is AsyncLocalStorage-based; for the seed we only need it to run
// the callback, and asserting the coords reach it is a separate concern.
vi.mock('@/lib/azure/adf-factory-context', () => ({
  withFactoryOverride: vi.fn(async (_o: unknown, fn: () => any) => fn()),
  currentFactoryOverride: vi.fn(() => undefined),
}));

import { adfPipelineAutoBind, synapsePipelineAutoBind } from '@/lib/azure/auto-bind-providers';
import type { AutoBindContext } from '@/lib/azure/auto-bind';

/**
 * The "Daily Batch Processing Pipeline" content from
 * `lib/apps/content-bundles/app-azure-realtime-analytics.ts` — the exact item
 * named in #3549, including the DatabricksNotebook activities whose
 * `linkedServiceName` the bundle omits (ADF 400s without it, so the seeder has
 * to inject one).
 *
 * `processing_date` is the bundle's REAL value — an ADF parameter-reference
 * expression, not a fixed date (see that file, `baseParameters`). A literal
 * '2026-08-15' would still be "content the seeder copies", but it would not
 * exercise the parameter-reference path at all, so a translation bug that
 * mangled `@{…}` expressions would pass. Fixtures that quietly simplify the
 * thing they claim to reproduce are how a seeder ships green and fails live.
 */
const PROCESSING_DATE_EXPR = "@{formatDateTime(pipeline().parameters.ProcessingDate, 'yyyy-MM-dd')}";

const RTA_CONTENT = {
  kind: 'adf-pipeline',
  parameters: { ProcessingDate: { type: 'string', defaultValue: '@utcnow()' } },
  activities: [
    {
      name: 'BronzeToSilverDQ',
      type: 'DatabricksNotebook',
      config: {
        notebookPath: '/Shared/RealTimeAnalytics/02_structured_streaming',
        baseParameters: { processing_date: PROCESSING_DATE_EXPR },
        description: 'Drains the streaming checkpoint + runs the DQ gate (Step 2).',
      },
    },
    {
      name: 'GoldAggregation',
      type: 'DatabricksNotebook',
      dependsOn: ['BronzeToSilverDQ'],
      config: { notebookPath: '/Shared/RealTimeAnalytics/03_batch_gold_aggregation' },
    },
    {
      name: 'OptimizeGold',
      type: 'DatabricksNotebook',
      dependsOn: ['GoldAggregation'],
      config: { notebookPath: '/Shared/RealTimeAnalytics/04_optimize_gold' },
    },
  ],
};

/** The state a GATED bundle install leaves: content stamped, no binding. */
function gatedCtx(content: unknown = RTA_CONTENT): AutoBindContext {
  return {
    itemId: 'cosmos-guid-1',
    itemType: 'adf-pipeline',
    displayName: 'Daily Batch Processing Pipeline',
    workspaceId: 'uat-apps-1786813692048',
    state: { sourceApp: 'app-azure-realtime-analytics', content },
  };
}

const COORDS = { factoryName: 'adf-loom-default-centralus', subscriptionId: 'sub-1', resourceGroup: 'rg-1' };

/**
 * Env this file mutates, snapshotted so it cannot leak into a sibling suite.
 * `pipeline-designer-provisioners.test.ts` asserts on the ABSENCE of
 * LOOM_DATABRICKS_HOSTNAME, so leaving it set here would be a cross-file
 * landmine the moment vitest's per-file isolation is relaxed.
 */
const ENV_KEYS = ['LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_WORKSPACE_URL', 'LOOM_DATABRICKS_LINKED_SERVICE'] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  adfPlane.puts = []; adfPlane.linkedServices = []; adfPlane.datasets = []; adfPlane.runs = [];
  adfPlane.putThrows = null;
  synapsePlane.puts = []; synapsePlane.runs = [];
  for (const k of ENV_KEYS) delete process.env[k];
  // Databricks wired on this estate, so the activities' linked service resolves.
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.4.azuredatabricks.net';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe('adfPipelineAutoBind.seedFromContent', () => {
  it('is registered at all (the hook the engine looks for)', () => {
    expect(typeof adfPipelineAutoBind.seedFromContent).toBe('function');
    expect(typeof synapsePipelineAutoBind.seedFromContent).toBe('function');
  });

  it('PUTs the bundle\'s three activities — not the empty document create leaves', async () => {
    const r = await adfPipelineAutoBind.seedFromContent!('Daily-Batch-Processing-Pipeline', COORDS, gatedCtx());

    expect(r.seeded).toBe(true);
    const put = adfPlane.puts.at(-1);
    expect(put?.name).toBe('Daily-Batch-Processing-Pipeline');
    const activities = put?.body?.properties?.activities ?? [];
    expect(activities).toHaveLength(3);
    expect(activities.map((a: any) => a.name)).toEqual([
      'BronzeToSilverDQ', 'GoldAggregation', 'OptimizeGold',
    ]);
  });

  it('puts activity type-properties under typeProperties, not the root', async () => {
    await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());
    const first = adfPlane.puts.at(-1)!.body.properties.activities[0];

    // The ADF wire contract: engine-specific bits live under typeProperties.
    expect(first.typeProperties.notebookPath).toBe('/Shared/RealTimeAnalytics/02_structured_streaming');
    // The parameter-reference expression must survive VERBATIM — an escaped or
    // re-interpolated `@{…}` is a live ADF failure, not a cosmetic difference.
    expect(first.typeProperties.baseParameters).toEqual({ processing_date: PROCESSING_DATE_EXPR });
    expect(first.typeProperties.baseParameters.processing_date).toContain('pipeline().parameters.ProcessingDate');
    // …and NOT at the activity root, which is the canvas-render shape.
    expect(first.notebookPath).toBeUndefined();
    // `description` IS a root sibling and must be lifted out of typeProperties.
    expect(first.description).toContain('Drains the streaming checkpoint');
    expect(first.typeProperties.description).toBeUndefined();
  });

  it('carries dependsOn across in ADF\'s expanded form, preserving the graph', async () => {
    await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());
    const acts = adfPlane.puts.at(-1)!.body.properties.activities;

    expect(acts[0].dependsOn).toBeUndefined(); // the root activity
    expect(acts[1].dependsOn).toEqual([{ activity: 'BronzeToSilverDQ', dependencyConditions: ['Succeeded'] }]);
    expect(acts[2].dependsOn).toEqual([{ activity: 'GoldAggregation', dependencyConditions: ['Succeeded'] }]);
  });

  it('carries the pipeline parameters across', async () => {
    await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());
    expect(adfPlane.puts.at(-1)!.body.properties.parameters).toEqual({
      ProcessingDate: { type: 'string', defaultValue: '@utcnow()' },
    });
  });

  it('injects the Databricks linked service the bundle omits, so the PUT validates', async () => {
    await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());

    // Auto-stubbed against LOOM_DATABRICKS_HOSTNAME …
    expect(adfPlane.linkedServices).toContain('AzureDatabricks_LinkedService');
    // … and referenced from every Databricks activity.
    for (const a of adfPlane.puts.at(-1)!.body.properties.activities) {
      expect(a.linkedServiceName).toEqual({
        referenceName: 'AzureDatabricks_LinkedService',
        type: 'LinkedServiceReference',
      });
    }
  });

  it('authors the pipeline WITHOUT triggering a billed run', async () => {
    // Install proves a pipeline by running it. Opening an editor must not.
    await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());
    expect(adfPlane.puts).toHaveLength(1);
    expect(adfPlane.runs).toEqual([]);
  });

  it('seeds NOTHING for a blank item created from the catalog picker', async () => {
    const ctx = { ...gatedCtx(), state: {} };
    const r = await adfPipelineAutoBind.seedFromContent!('uat-adf-pipeline-1', COORDS, ctx);

    expect(r.seeded).toBe(false);
    expect(r.error).toBeUndefined();   // absence of content is not a failure
    expect(adfPlane.puts).toEqual([]); // and we do not touch the empty object
  });

  it('refuses to write a lakehouse bundle into a pipeline', async () => {
    const r = await adfPipelineAutoBind.seedFromContent!(
      'P1', COORDS, gatedCtx({ kind: 'lakehouse', deltaTables: [{ name: 'orders' }] }),
    );
    expect(r.seeded).toBe(false);
    expect(adfPlane.puts).toEqual([]);
  });

  it('reports seeded:false with the reason when the PUT is refused', async () => {
    adfPlane.putThrows = Object.assign(new Error('ADF pipelines failed 403: Forbidden'), { status: 403 });
    const r = await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());

    expect(r.seeded).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  it('gates honestly when the graph needs Databricks and the estate has none', async () => {
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    const r = await adfPipelineAutoBind.seedFromContent!('P1', COORDS, gatedCtx());

    expect(r.seeded).toBe(false);
    expect(r.error).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    // Nothing half-written: we gate BEFORE the PUT rather than after a 400.
    expect(adfPlane.puts).toEqual([]);
  });
});

describe('synapsePipelineAutoBind.seedFromContent', () => {
  it('authors the same graph through the Synapse dev client, no run', async () => {
    const ctx = { ...gatedCtx({ ...RTA_CONTENT, kind: 'synapse-pipeline' }), itemType: 'synapse-pipeline' };
    const r = await synapsePipelineAutoBind.seedFromContent!('P1', { workspace: 'syn-loom' }, ctx);

    expect(r.seeded).toBe(true);
    expect(synapsePlane.puts).toHaveLength(1);
    expect(synapsePlane.puts[0].body.properties.activities).toHaveLength(3);
    expect(synapsePlane.puts[0].body.properties.activities[0].typeProperties.notebookPath)
      .toBe('/Shared/RealTimeAnalytics/02_structured_streaming');
    expect(synapsePlane.runs).toEqual([]);
  });
});

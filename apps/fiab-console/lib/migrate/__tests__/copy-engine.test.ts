/**
 * M2 — copy-in ENGINE: pipeline-authoring safety (issue #4087).
 *
 * WHAT THESE PIN, and why each can actually fail.
 *
 * 1. COPY-THEN-RETIRE ORDERING. The engine used to author the Delete as a ROOT
 *    activity (`dependsOn: []`) with the Copy chained behind it, so a Copy
 *    failure left Bronze EMPTY — the previous snapshot destroyed by a run that
 *    then wrote nothing. Copy must be the root and every Delete must be gated
 *    on its own Copy having SUCCEEDED.
 *
 * 2. THE FIXTURE IS DELIBERATELY TWO-TABLE. A single-table fixture inspected
 *    with `acts.find(...)` cannot see the per-object loop at all: it passes
 *    identically whether the gating is applied to every object or to the first
 *    one only. Every ordering assertion below is therefore made PER OBJECT over
 *    a plan with two objects, and asserts each Delete is gated on ITS OWN
 *    Copy — not merely on "some Copy".
 *
 * 3. THE INVARIANT IS KEYED TO THE SHAPE OF THE DEFECT, NOT TO A LIST OF
 *    EVASIONS. Round 1 of this PR checked "does this Delete have SOME
 *    dependency, on SOMETHING typed Copy, whose condition list mentions
 *    Succeeded?". An independent verifier defeated that, and re-measuring it
 *    here before the rewrite found FIVE shapes it accepted with no throw:
 *    cross-wired (DeletePrev_B gated on Copy_A), a widened condition set
 *    (`['Succeeded','Failed']`), an orphan target nothing writes, a Delete with
 *    no target at all, and a root Delete nested inside a ForEach. All five are
 *    asserted below — not because they are the list, but because each one
 *    exercises a different way the PER-TARGET dominance question can be dodged,
 *    and the question is what is being pinned.
 *
 * 4. THE TRANSFER GATE READS THE TYPE. `planCopyTransfer` must reject the
 *    AzureBlobFS Bronze sink even though its NAME is a perfectly good non-empty
 *    string — a name-only check is what let the invalid pairing be authored.
 *
 * Per .claude/rules/no-vaporware.md these assert only what they exercise: they
 * cover pipeline AUTHORING (pure, no ARM), plus `startCopyIn`'s gate/refusal
 * behaviour with the ARM surface mocked. They do NOT prove a real ADF run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCopyActivities, findUnsafeDeletes, assertSafeCopyPipeline,
  planCopyTransfer, datasetNamesFor, MAX_COPY_OBJECTS,
} from '@/lib/migrate/copy-engine';
import type { CopyObjectPlan } from '@/lib/migrate/copy-plan';

// ── Fixtures ────────────────────────────────────────────────────────────────

function obj(name: string, schema: string): CopyObjectPlan {
  return {
    source: { database: 'ANALYTICS', schema, name, sourceKind: 'relational-table' },
    targetKind: 'lakehouse',
    targetTable: name.toLowerCase(),
    landingSegment: `ANALYTICS.${schema}.${name}`,
    columnMapping: 'by-name',
  };
}

/** TWO objects — see header note 2. A one-object fixture is blind here. */
const TWO_TABLES: CopyObjectPlan[] = [obj('Orders', 'sales'), obj('Customers', 'ops')];

const BUILD_OPTS = {
  pipelineName: 'loom_copyin_mig1',
  sourceType: 'SnowflakeV2Source',
  stagingLinkedService: 'loom_stage_blob',
  stagingPath: 'loom-copyin-staging/mig1',
};

type Act = {
  name: string;
  type: string;
  dependsOn?: { activity?: string; dependencyConditions?: string[] }[];
  inputs?: { referenceName?: string }[];
  outputs?: { referenceName?: string }[];
  typeProperties?: any;
};

function byName(acts: readonly unknown[]): Map<string, { type?: string }> {
  return new Map((acts as Act[]).map((a) => [a.name, { type: a.type }]));
}

// ── 1. Ordering: Copy is the root, Delete is gated — FOR EVERY OBJECT ───────

describe('buildCopyActivities — copy-then-retire ordering (#4087)', () => {
  const acts = buildCopyActivities(TWO_TABLES, BUILD_OPTS) as Act[];

  it('authors exactly one Copy and one Delete per object', () => {
    expect(acts).toHaveLength(TWO_TABLES.length * 2);
    expect(acts.filter((a) => a.type === 'Copy')).toHaveLength(TWO_TABLES.length);
    expect(acts.filter((a) => a.type === 'Delete')).toHaveLength(TWO_TABLES.length);
  });

  it('makes EVERY Copy a graph root (nothing is destroyed before it runs)', () => {
    const copies = acts.filter((a) => a.type === 'Copy');
    expect(copies.length).toBe(TWO_TABLES.length);
    for (const c of copies) {
      expect(c.dependsOn, `Copy ${c.name} must be a root`).toEqual([]);
    }
  });

  it('gates EVERY Delete on ITS OWN Copy having Succeeded', () => {
    const names = byName(acts);
    const deletes = acts.filter((a) => a.type === 'Delete');
    expect(deletes.length).toBe(TWO_TABLES.length);

    for (const [i, o] of TWO_TABLES.entries()) {
      const del = deletes[i];
      // Not merely "gated on some Copy" — gated on the Copy for THIS object.
      const deps = del.dependsOn ?? [];
      expect(deps).toHaveLength(1);
      const parentName = deps[0].activity!;
      expect(deps[0].dependencyConditions).toEqual(['Succeeded']);
      expect(names.get(parentName)?.type).toBe('Copy');

      // The parent Copy must be the one writing THIS object's sink dataset.
      const parent = acts.find((a) => a.name === parentName)!;
      const { sinkDs } = datasetNamesFor(BUILD_OPTS.pipelineName, o);
      expect(parent.outputs?.[0]?.referenceName).toBe(sinkDs);
      expect(del.typeProperties.dataset.referenceName).toBe(sinkDs);
    }
  });

  it('scopes each Delete to the PREVIOUS generation only', () => {
    for (const del of acts.filter((a) => a.type === 'Delete')) {
      const ss = del.typeProperties.storeSettings;
      // wildcardFileName is required whenever a modifiedDatetime filter is used.
      expect(ss.wildcardFileName).toBe('*');
      expect(ss.modifiedDatetimeEnd).toEqual({ value: '@pipeline().TriggerTime', type: 'Expression' });
    }
  });

  it('passes its own output to assertSafeCopyPipeline', () => {
    expect(() => assertSafeCopyPipeline(acts)).not.toThrow();
  });
});

// ── 2. Connector shape: V2 types + the REQUIRED exportSettings ──────────────

describe('buildCopyActivities — Snowflake connector shape', () => {
  it('uses the source type it was handed (V1 or V2 — never hard-coded)', () => {
    const v2 = buildCopyActivities(TWO_TABLES, BUILD_OPTS) as Act[];
    for (const c of v2.filter((a) => a.type === 'Copy')) {
      expect(c.typeProperties.source.type).toBe('SnowflakeV2Source');
    }
    const v1 = buildCopyActivities(TWO_TABLES, { ...BUILD_OPTS, sourceType: 'SnowflakeSource' }) as Act[];
    for (const c of v1.filter((a) => a.type === 'Copy')) {
      expect(c.typeProperties.source.type).toBe('SnowflakeSource');
    }
  });

  it('always sets exportSettings (REQUIRED on both V1 and V2)', () => {
    for (const c of (buildCopyActivities(TWO_TABLES, BUILD_OPTS) as Act[]).filter((a) => a.type === 'Copy')) {
      expect(c.typeProperties.source.exportSettings).toEqual({ type: 'SnowflakeExportCopyCommand' });
    }
  });

  it('stages through the interim Blob linked service with MergeFiles', () => {
    for (const c of (buildCopyActivities(TWO_TABLES, BUILD_OPTS) as Act[]).filter((a) => a.type === 'Copy')) {
      expect(c.typeProperties.enableStaging).toBe(true);
      expect(c.typeProperties.stagingSettings.linkedServiceName.referenceName).toBe('loom_stage_blob');
      // Without MergeFiles only the LAST partitioned file of the unload lands.
      expect(c.typeProperties.sink.storeSettings.copyBehavior).toBe('MergeFiles');
    }
  });
});

// ── 3. The invariant is keyed to PER-TARGET dominance, not to a spelling ───

/**
 * Hand-built shapes, deliberately NOT produced by `buildCopyActivities`.
 *
 * A test that can only look at the builder's current output cannot tell an
 * invariant that ENFORCES the safety property from one that merely happens to
 * agree with today's builder. Every case below is handed straight to the
 * exported invariant.
 */
const copyAct = (name: string, sink: string, dependsOn: unknown[] = []) => ({
  name, type: 'Copy', dependsOn,
  outputs: [{ referenceName: sink, type: 'DatasetReference' }],
});
const deleteAct = (
  name: string, sink: string | null, dep: string | null, conds: string[] = ['Succeeded'],
) => ({
  name, type: 'Delete',
  dependsOn: dep ? [{ activity: dep, dependencyConditions: conds }] : [],
  typeProperties: sink ? { dataset: { referenceName: sink, type: 'DatasetReference' } } : {},
});

describe('findUnsafeDeletes — per-target dominance, not "some Copy succeeded"', () => {
  it('accepts the safe shape: each Delete gated on the Copy that writes ITS dataset', () => {
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'Copy_A'),
      copyAct('Copy_B', 'sink_B'), deleteAct('DeletePrev_B', 'sink_B', 'Copy_B'),
    ])).toEqual([]);
  });

  it('BYPASS 1 — CROSS-WIRED: DeletePrev_B gated on Copy_A, not on Copy_B', () => {
    // The exact evasion an independent verifier used against round 1, which
    // ACCEPTED it. Copy_A succeeding says nothing about table B, so B's landing
    // folder is cleared whether or not Copy_B ever wrote a byte.
    const bad = findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'Copy_A'),
      copyAct('Copy_B', 'sink_B'), deleteAct('DeletePrev_B', 'sink_B', 'Copy_A'),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toBe('DeletePrev_B');
    expect(bad[0].reason).toBe('producer-not-proven');
    // It names the producer that was not proven — Copy_B — not just "a Copy".
    expect(bad[0].detail).toMatch(/Copy_B/);
  });

  it('BYPASS 2 — WIDENED CONDITION SET: Succeeded alongside Failed is no gate', () => {
    // `includes('Succeeded')` was true for each of these, which is how round 1
    // read them as success gates. A list that also names Failed/Skipped/
    // Completed does not establish that the Copy succeeded, so it must not be
    // allowed to stand in for one.
    for (const conds of [['Succeeded', 'Failed'], ['Succeeded', 'Skipped'], ['Completed', 'Succeeded']]) {
      const bad = findUnsafeDeletes([
        copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'Copy_A', conds),
      ]);
      expect(bad, `conditions ${JSON.stringify(conds)} must not gate`).toHaveLength(1);
      expect(bad[0].reason).toBe('producer-not-proven');
    }
  });

  it('BYPASS 3 — ORPHAN TARGET: deleting a dataset nothing in the pipeline writes', () => {
    const bad = findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      deleteAct('DeletePrev_ORPHAN', 'sink_nobody_writes', 'Copy_A'),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe('no-producer');
  });

  it('BYPASS 4 — NO TARGET: a Delete that names no dataset is unknowable, so unsafe', () => {
    const bad = findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_X', null, 'Copy_A'),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe('no-target');
  });

  it('BYPASS 5 — NESTED: a root Delete inside a container is still in the population', () => {
    const bad = findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      {
        name: 'ForEach_1', type: 'ForEach', dependsOn: [],
        typeProperties: { items: '@pipeline().parameters.x', activities: [
          deleteAct('DeletePrev_NESTED', 'sink_A', null),
        ] },
      },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toBe('DeletePrev_NESTED');
  });

  it('a nested Delete IS safe when its container runs behind the producing Copy', () => {
    // The mirror of BYPASS 5: dominance is inherited from the container, so the
    // check is not merely "refuse anything nested".
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      {
        name: 'ForEach_1', type: 'ForEach',
        dependsOn: [{ activity: 'Copy_A', dependencyConditions: ['Succeeded'] }],
        typeProperties: { activities: [deleteAct('DeletePrev_NESTED', 'sink_A', null)] },
      },
    ])).toEqual([]);
  });

  it('accepts a TRANSITIVE gate (Copy -> Wait -> Delete)', () => {
    // Dominance, not adjacency: inserting a step between the Copy and the
    // Delete does not make it unsafe, and must not be refused.
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      { name: 'Wait_1', type: 'Wait', dependsOn: [{ activity: 'Copy_A', dependencyConditions: ['Succeeded'] }] },
      deleteAct('DeletePrev_A', 'sink_A', 'Wait_1'),
    ])).toEqual([]);
  });

  it('rejects a transitive chain whose FIRST hop is not a success edge', () => {
    const bad = findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      { name: 'Wait_1', type: 'Wait', dependsOn: [{ activity: 'Copy_A', dependencyConditions: ['Completed'] }] },
      deleteAct('DeletePrev_A', 'sink_A', 'Wait_1'),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe('producer-not-proven');
  });

  it('rejects a ROOT Delete and a Delete gated on a non-writing activity', () => {
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', null),
    ])[0].reason).toBe('producer-not-proven');
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'),
      { name: 'Lookup_1', type: 'Lookup', dependsOn: [] },
      deleteAct('DeletePrev_A', 'sink_A', 'Lookup_1'),
    ])[0].reason).toBe('producer-not-proven');
    // A dependency on an activity that is not in the pipeline is not a gate.
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'Copy_missing'),
    ])[0].reason).toBe('producer-not-proven');
  });

  it('does not read activity NAMES: renaming everything changes nothing', () => {
    // Same graph, no `Copy_`/`DeletePrev_` spelling anywhere.
    expect(findUnsafeDeletes([
      copyAct('zzz', 'ds1'), deleteAct('qqq', 'ds1', 'zzz'),
    ])).toEqual([]);
    expect(findUnsafeDeletes([
      copyAct('zzz', 'ds1'), copyAct('www', 'ds2'), deleteAct('qqq', 'ds2', 'zzz'),
    ])).toHaveLength(1);
  });

  it('refuses rather than reasoning through a dependency CYCLE', () => {
    // Delete-first with a back-edge. ADF cannot run a cyclic pipeline, and the
    // dominance walk has to be cut, so "dominated" was never established —
    // reported as such instead of read as an absence of violations.
    const bad = findUnsafeDeletes([
      { ...copyAct('Copy_A', 'sink_A'), dependsOn: [{ activity: 'DeletePrev_A', dependencyConditions: ['Succeeded'] }] },
      deleteAct('DeletePrev_A', 'sink_A', 'Copy_A'),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe('cycle');

    // A Delete depending on ITSELF proves nothing about its producer either.
    expect(findUnsafeDeletes([
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'DeletePrev_A'),
    ])[0].reason).toBe('producer-not-proven');
  });
});

// ── 4. The pre-upsert invariant refuses to author a destructive pipeline ────

describe('assertSafeCopyPipeline', () => {
  it('throws on a ROOT Delete, naming it', () => {
    const bad = [
      { name: 'DeletePrev_a', type: 'Delete', dependsOn: [],
        typeProperties: { dataset: { referenceName: 'sink_a', type: 'DatasetReference' } } },
      { name: 'Copy_a', type: 'Copy', outputs: [{ referenceName: 'sink_a', type: 'DatasetReference' }],
        dependsOn: [{ activity: 'DeletePrev_a', dependencyConditions: ['Succeeded'] }] },
    ];
    expect(() => assertSafeCopyPipeline(bad)).toThrow(/DeletePrev_a/);
    expect(() => assertSafeCopyPipeline(bad)).toThrow(/has not proven it can replace/);
  });

  it('throws on the CROSS-WIRED shape (round 1 authored this and did not throw)', () => {
    const crossWired = [
      copyAct('Copy_A', 'sink_A'), deleteAct('DeletePrev_A', 'sink_A', 'Copy_A'),
      copyAct('Copy_B', 'sink_B'), deleteAct('DeletePrev_B', 'sink_B', 'Copy_A'),
    ];
    expect(() => assertSafeCopyPipeline(crossWired)).toThrow(/DeletePrev_B/);
    expect(() => assertSafeCopyPipeline(crossWired)).toThrow(/Copy_B/);
  });

  it('throws when the activity count breaches ADF\'s 120 ceiling', () => {
    const tooMany = buildCopyActivities(
      Array.from({ length: MAX_COPY_OBJECTS + 1 }, (_, i) => obj(`T${i}`, 's')),
      BUILD_OPTS,
    );
    expect(tooMany.length).toBeGreaterThan(120);
    expect(() => assertSafeCopyPipeline(tooMany)).toThrow(/exceeds ADF's ceiling of 120/);
  });

  it('counts INNER activities toward the ceiling, as ADF does', () => {
    // "Maximum activities per pipeline, WHICH INCLUDES INNER ACTIVITIES FOR
    // CONTAINERS | 120 | 120" — a container is not a way to buy more budget.
    const nested = [{
      name: 'ForEach_1', type: 'ForEach', dependsOn: [],
      typeProperties: {
        activities: Array.from({ length: 130 }, (_, i) => copyAct(`Copy_${i}`, `s${i}`)),
      },
    }];
    expect(nested).toHaveLength(1);
    expect(() => assertSafeCopyPipeline(nested)).toThrow(/exceeds ADF's ceiling of 120/);
  });

  it('accepts a plan exactly at the derived ceiling', () => {
    const atCap = buildCopyActivities(
      Array.from({ length: MAX_COPY_OBJECTS }, (_, i) => obj(`T${i}`, 's')),
      BUILD_OPTS,
    );
    expect(atCap).toHaveLength(120);
    expect(() => assertSafeCopyPipeline(atCap)).not.toThrow();
  });
});

// ── 5. The transfer gate reads the TYPE, not the name ──────────────────────

describe('planCopyTransfer', () => {
  it('is staged only for an AzureBlobStorage linked service', () => {
    expect(planCopyTransfer('loom_stage_blob', 'AzureBlobStorage'))
      .toEqual({ kind: 'staged', stagingLinkedService: 'loom_stage_blob' });
  });

  it('gates when nothing is configured, naming the infra issue', () => {
    const p = planCopyTransfer(null, null);
    expect(p.kind).toBe('unsupported');
    if (p.kind !== 'unsupported') throw new Error('unreachable');
    expect(p.missing).toBe('LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE');
    expect(p.message).toMatch(/#4086/);
  });

  it('REJECTS the AzureBlobFS Bronze sink even though its name is set', () => {
    // This is the whole point of reading the type: the operator's first move is
    // to point the variable at the ADLS linked service they already have.
    const p = planCopyTransfer('loom_mirror_sink_adls', 'AzureBlobFS');
    expect(p.kind).toBe('unsupported');
    if (p.kind !== 'unsupported') throw new Error('unreachable');
    expect(p.message).toMatch(/AzureBlobFS/);
    expect(p.message).toMatch(/must be AzureBlobStorage/);
  });

  it('reports UNREADABLE distinctly from wrong-type', () => {
    const p = planCopyTransfer('who_knows', null);
    expect(p.kind).toBe('unsupported');
    if (p.kind !== 'unsupported') throw new Error('unreachable');
    // Not conflated with "the type is wrong" — a different missing key entirely.
    expect(p.missing).toBe('staging-linked-service-unreadable');
    expect(p.message).toMatch(/NOT a report that the type is wrong/);
  });
});

// ── 6. startCopyIn refuses rather than authoring an unrunnable pipeline ─────

const arm = vi.hoisted(() => ({
  upsertDataset: vi.fn(async (_name: string, _spec: any) => ({} as any)),
  upsertPipeline: vi.fn(async (_name: string, _spec: any) => ({} as any)),
  runPipeline: vi.fn(async (_name: string) => ({ runId: 'run-1' })),
  getLinkedService: vi.fn(async (_name: string) => ({ properties: { type: 'AzureBlobStorage' } } as any)),
  listActivityRuns: vi.fn(async (_runId: string, _days?: number) => [] as any[]),
}));

vi.mock('@/lib/azure/adf-client', () => ({
  adfConfigGate: () => null,
  upsertDataset: arm.upsertDataset,
  upsertPipeline: arm.upsertPipeline,
  runPipeline: arm.runPipeline,
  getLinkedService: arm.getLinkedService,
  listActivityRuns: arm.listActivityRuns,
}));
vi.mock('@/lib/azure/snowflake-adf', () => ({
  snowflakeDatasetKind: async () => ({ dataset: 'SnowflakeV2Table', source: 'SnowflakeV2Source', assumed: false }),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: () => 'stloomtest',
  pathToHttpsUrl: (c: string, p: string) => `https://stloomtest.dfs.core.windows.net/${c}/${p}`,
}));

const PLAN = {
  sourceType: 'snowflake' as const,
  generatedAt: '2026-08-26T00:00:00.000Z',
  objects: TWO_TABLES,
} as any;

describe('startCopyIn — gates before it authors', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOOM_BRONZE_URL = 'https://stloomtest.dfs.core.windows.net/bronze';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'loom_mirror_sink_adls';
    process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE = 'loom_snowflake';
    process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE = 'loom_stage_blob';
  });
  afterEach(() => { process.env = { ...ENV }; });

  it('authors a pipeline whose stored definition has NO unsafe Delete', async () => {
    const { startCopyIn } = await import('@/lib/migrate/copy-engine');
    const res = await startCopyIn(PLAN, 'mig1');
    expect(res.ok).toBe(true);
    expect(arm.upsertPipeline).toHaveBeenCalledTimes(1);

    // Assert against what was actually handed to ARM, not against the builder.
    const spec = arm.upsertPipeline.mock.calls[0][1] as any;
    const stored: Act[] = spec.properties.activities;
    expect(stored.filter((a) => a.type === 'Delete')).toHaveLength(TWO_TABLES.length);
    // Per-target: every stored Delete is dominated by the Copy writing ITS dataset.
    expect(findUnsafeDeletes(stored)).toEqual([]);
  });

  it('takes the connector types FROM the linked service, never hard-coded', async () => {
    const { startCopyIn } = await import('@/lib/migrate/copy-engine');
    const res = await startCopyIn(PLAN, 'mig1');
    expect(res.ok).toBe(true);

    // snowflakeDatasetKind (mocked) reports V2 for this factory. If the engine
    // re-hard-codes the REMOVED V1 pair, these become SnowflakeTable /
    // SnowflakeSource and this fails — which is the point: the authored types
    // must FOLLOW the linked service that was read back.
    const srcDatasets = arm.upsertDataset.mock.calls
      .map((c) => (c[1] as any).properties.type)
      .filter((t: string) => t !== 'Parquet');
    expect(srcDatasets).toHaveLength(TWO_TABLES.length);
    for (const t of srcDatasets) expect(t).toBe('SnowflakeV2Table');

    const spec = arm.upsertPipeline.mock.calls[0][1] as any;
    const copies = (spec.properties.activities as Act[]).filter((a) => a.type === 'Copy');
    expect(copies).toHaveLength(TWO_TABLES.length);
    for (const c of copies) expect(c.typeProperties.source.type).toBe('SnowflakeV2Source');
  });

  it('gates — and upserts NOTHING — when staging is unconfigured', async () => {
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    const { startCopyIn } = await import('@/lib/migrate/copy-engine');
    const res = await startCopyIn(PLAN, 'mig1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.gate.missing).toBe('LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE');
    // The pre-#4087 engine authored + RAN regardless. Nothing may reach ADF.
    expect(arm.upsertPipeline).not.toHaveBeenCalled();
    expect(arm.runPipeline).not.toHaveBeenCalled();
  });

  it('gates when the staging linked service is the ADLS sink (wrong type)', async () => {
    arm.getLinkedService.mockResolvedValueOnce({ properties: { type: 'AzureBlobFS' } } as any);
    const { startCopyIn } = await import('@/lib/migrate/copy-engine');
    const res = await startCopyIn(PLAN, 'mig1');
    expect(res.ok).toBe(false);
    expect(arm.upsertPipeline).not.toHaveBeenCalled();
  });

  it('refuses a plan that would breach the activity ceiling', async () => {
    const { startCopyIn } = await import('@/lib/migrate/copy-engine');
    const big = { ...PLAN, objects: Array.from({ length: MAX_COPY_OBJECTS + 1 }, (_, i) => obj(`T${i}`, 's')) };
    const res = await startCopyIn(big, 'mig1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.gate.missing).toBe('activity-budget');
    expect(arm.upsertPipeline).not.toHaveBeenCalled();
  });
});

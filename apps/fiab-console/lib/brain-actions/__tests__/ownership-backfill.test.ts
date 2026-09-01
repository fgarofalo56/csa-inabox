/**
 * MANIFEST-DERIVED OWNERSHIP BACKFILL — the candidate rules and the apply
 * guards (#4255 W2).
 *
 * ── MUTATION-GRADE, BY CONSTRUCTION ────────────────────────────────────────
 * Every refusal spec asserts BOTH the refusal AND that the tag-merge mock was
 * never called for that resource. Delete any one of the four apply guards
 * (not-in-manifest / indeterminate / foreign-estate / already-tagged) from
 * `../ownership-backfill.ts` and its spec goes red — the id falls through to
 * the write arm and `merge` records a call the spec forbids. The happy-path
 * spec keeps the suite honest in the other direction: an apply that refuses
 * everything fails THAT one.
 *
 * The REAL `resolveDeployManifest` runs here — it is a pure function of env,
 * and mocking it would let this suite pass against a manifest resolution that
 * does not exist. Only the two Azure edges (tag read, tag merge) are injected.
 *
 * NO REAL IDENTIFIERS: synthetic subscription GUID, synthetic names.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyOwnershipBackfill,
  previewOwnershipBackfill,
  LOOM_ESTATE_TAG_KEY,
  type BackfillDeps,
} from '../ownership-backfill';
import { resolveDeployManifest } from '@/lib/estate/pause-orchestrator';
import { UNBOUND_ESTATE_ID } from '../estate-scope';

const SUB = '00000000-0000-4000-8000-000000000001';
const RG = 'rg-loom-dlz';
const ESTATE = 'estate-under-test';

/**
 * An env the platform bicep genuinely produces: subscription + DLZ RG + the
 * three resource names that make `resolveDeployManifest` resolve three
 * entries. `LOOM_ESTATE_PAUSE_ENABLED` is deliberately UNSET — the backfill
 * must not inherit the PAUSE opt-in, which governs a different, destructive
 * action.
 */
function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    LOOM_ESTATE_ID: ESTATE,
    LOOM_SUBSCRIPTION_ID: SUB,
    LOOM_DLZ_RG: RG,
    LOOM_SYNAPSE_WORKSPACE: 'syn-loom',
    LOOM_SYNAPSE_DEDICATED_POOL: 'pool01',
    LOOM_KUSTO_CLUSTER_NAME: 'adxloom',
    LOOM_AAS_SERVER_NAME: 'aasloom',
  };
  const merged: Record<string, string | undefined> = { ...base, ...over };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return merged as NodeJS.ProcessEnv;
}

const POOL_ID =
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Synapse` +
  `/workspaces/syn-loom/sqlPools/pool01`;
const ADX_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Kusto/clusters/adxloom`;
const AAS_ID =
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.AnalysisServices/servers/aasloom`;

/** Injected Azure edges. `tags` maps resourceId -> the bag, or an Error to throw. */
function deps(
  tags: Record<string, Readonly<Record<string, string>> | Error | null>,
  over: Partial<BackfillDeps> = {},
): BackfillDeps & { merge: ReturnType<typeof vi.fn> } {
  const merge = vi.fn(
    async (resourceId: string, key: string, value: string) => ({
      ...(tags[resourceId] instanceof Error || tags[resourceId] === null
        ? {}
        : ((tags[resourceId] ?? {}) as Record<string, string>)),
      [key]: value,
    }),
  );
  return {
    env: env(),
    readTags: async (resourceId: string) => {
      // `in`, not `?? {}` — an EXPLICIT null (ARM returned no tags collection)
      // must reach the classifier as null. Coalescing it to `{}` here is a bug
      // the first version of this helper had, and it made the null-tags spec
      // pass against a value the production code never saw.
      if (!(resourceId in tags)) return {};
      const t = tags[resourceId]!;
      if (t instanceof Error) throw t;
      return t;
    },
    mergeTag: merge,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    ...over,
    merge,
  };
}

// ---------------------------------------------------------------------------
// The manifest is the ONLY source of candidates
// ---------------------------------------------------------------------------

describe('candidates come from the deploy manifest, never a name guess', () => {
  it('POPULATION: the manifest actually resolves entries for this env', () => {
    // Without this the whole suite could pass over an empty candidate set.
    const { entries } = resolveDeployManifest(env());
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.map((e) => e.resourceId)).toContain(POOL_ID);
  });

  it('every candidate carries a machine-readable reason naming its env vars', async () => {
    const r = await previewOwnershipBackfill(deps({}));
    expect('preview' in r).toBe(true);
    if (!('preview' in r)) return;
    expect(r.preview.candidates.length).toBeGreaterThanOrEqual(3);
    const pool = r.preview.candidates.find((c) => c.resourceId === POOL_ID)!;
    expect(pool.reason.source).toBe('deploy-manifest');
    expect(pool.reason.manifestLabel).toBe('Synapse dedicated SQL pool');
    expect(pool.reason.fromEnv).toContain('LOOM_SYNAPSE_DEDICATED_POOL');
    expect(pool.reason.text).toContain('LOOM_SYNAPSE_WORKSPACE');
    // The reason must state what it is NOT, so a reviewer can check the claim.
    expect(pool.reason.text).toContain('No name matching');
  });

  it('the PAUSE opt-in does NOT gate the backfill — tagging is not pausing', async () => {
    // `resolveDeployManifest().manifest.resourceIds` is emptied without
    // LOOM_ESTATE_PAUSE_ENABLED. Reading THAT instead of `entries` would make
    // this capability inert on every real deployment.
    const gated = resolveDeployManifest(env());
    expect(gated.manifest.resourceIds).toEqual([]);
    expect(gated.manifestGated).toBe(true);

    const r = await previewOwnershipBackfill(deps({}));
    if (!('preview' in r)) throw new Error('expected a preview');
    expect(r.preview.actionableResourceIds.length).toBeGreaterThanOrEqual(3);
  });

  it('the population note states what the manifest does NOT cover', async () => {
    const r = await previewOwnershipBackfill(deps({}));
    if (!('preview' in r)) throw new Error('expected a preview');
    expect(r.preview.populationNote).toContain('does NOT name the Container Apps');
    expect(r.preview.populationNote).toContain('#3922');
  });

  it('an unresolvable estate id refuses BEFORE any ARM read', async () => {
    const readTags = vi.fn(async () => ({}));
    const r = await previewOwnershipBackfill({
      env: {} as NodeJS.ProcessEnv,
      readTags,
    });
    expect('refusal' in r).toBe(true);
    if (!('refusal' in r)) return;
    expect(r.refusal.guard).toBe('estate-scoped');
    expect(r.refusal.reason).toContain(UNBOUND_ESTATE_ID);
    expect(readTags).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The three non-candidate states — each is a separate fact
// ---------------------------------------------------------------------------

describe('a resource whose tags could not be read is INDETERMINATE, never a candidate', () => {
  it('classifies a throwing read as indeterminate and keeps it out of the actionable set', async () => {
    const r = await previewOwnershipBackfill(
      deps({ [ADX_ID]: new Error('ARM 403: the console identity has no Reader here') }),
    );
    if (!('preview' in r)) throw new Error('expected a preview');
    const adx = r.preview.candidates.find((c) => c.resourceId === ADX_ID)!;
    expect(adx.state).toBe('indeterminate');
    // R7: the message says "could NOT be read", not "is not Loom's".
    expect(adx.readError).toContain('could NOT be read');
    expect(adx.readError).toContain('403');
    expect(adx.readError).toContain('does not say the resource is untagged');
    expect(r.preview.actionableResourceIds).not.toContain(ADX_ID);
  });

  it('a null tags collection is ALSO indeterminate — it establishes nothing', async () => {
    const r = await previewOwnershipBackfill(deps({ [ADX_ID]: null }));
    if (!('preview' in r)) throw new Error('expected a preview');
    expect(r.preview.candidates.find((c) => c.resourceId === ADX_ID)!.state).toBe('indeterminate');
  });

  it('APPLY refuses an indeterminate id and never calls the tag write for it', async () => {
    const d = deps({ [ADX_ID]: new Error('ARM 500: gateway timeout') });
    const r = await applyOwnershipBackfill({ resourceIds: [ADX_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.results[0]!.outcome).toBe('refused');
    expect(r.outcome.results[0]!.reason).toContain('could NOT be read');
    expect(r.outcome.results[0]!.mutatedAzure).toBe(false);
    expect(d.merge).not.toHaveBeenCalled();
    expect(r.outcome.mutatedAzure).toBe(false);
  });
});

describe("a DIFFERENT estate's tag is never clobbered", () => {
  it('classifies it foreign-estate and refuses the apply without writing', async () => {
    const d = deps({ [POOL_ID]: { [LOOM_ESTATE_TAG_KEY]: 'someone-elses-estate' } });
    const p = await previewOwnershipBackfill(d);
    if (!('preview' in p)) throw new Error('expected a preview');
    expect(p.preview.candidates.find((c) => c.resourceId === POOL_ID)!.state).toBe(
      'foreign-estate',
    );

    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.results[0]!.outcome).toBe('refused');
    expect(r.outcome.results[0]!.reason).toContain('someone-elses-estate');
    expect(r.outcome.results[0]!.reason).toContain('DIFFERENT Loom estate');
    expect(d.merge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE CLIENT IS NEVER TRUSTED
// ---------------------------------------------------------------------------

describe('a client-supplied id the server does not derive is REFUSED', () => {
  it('refuses an id that is not in the fresh manifest, and writes nothing', async () => {
    const notOurs =
      `/subscriptions/${SUB}/resourceGroups/rg-forzelite/providers/Microsoft.DBforPostgreSQL` +
      '/flexibleServers/forzelite-dev-pgdb';
    const d = deps({});
    const r = await applyOwnershipBackfill({ resourceIds: [notOurs] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.results[0]!.outcome).toBe('refused');
    expect(r.outcome.results[0]!.reason).toContain('not produced by a fresh resolution');
    expect(r.outcome.results[0]!.reason).toContain('never accepts a client-supplied resource id');
    expect(d.merge).not.toHaveBeenCalled();
    expect(r.outcome.tagged).toBe(0);
  });

  it('refuses the NON-manifest id while still tagging the manifest one beside it', async () => {
    // The narrow evasion: smuggle a foreign id in a list that also contains a
    // legitimate one. Per-id re-derivation means the good one proceeds and the
    // smuggled one does not.
    const notOurs = `/subscriptions/${SUB}/resourceGroups/rg-sentinel/providers/Microsoft.App/containerApps/sentinel-api`;
    const d = deps({});
    const r = await applyOwnershipBackfill({ resourceIds: [notOurs, POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.refused).toBe(1);
    expect(r.outcome.tagged).toBe(1);
    expect(d.merge).toHaveBeenCalledTimes(1);
    expect(d.merge.mock.calls[0]![0]).toBe(POOL_ID);
  });

  it('is case-insensitive about ARM ids, as ARM is', async () => {
    const d = deps({});
    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID.toUpperCase()] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.tagged).toBe(1);
  });

  it('a duplicated id in one list produces ONE write, not two', async () => {
    const d = deps({});
    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID, POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(d.merge).toHaveBeenCalledTimes(1);
    expect(r.outcome.tagged).toBe(1);
    expect(r.outcome.refused).toBe(1);
    expect(r.outcome.results[1]!.reason).toContain('more than once');
  });
});

// ---------------------------------------------------------------------------
// The write itself — idempotent, non-clobbering, receipted
// ---------------------------------------------------------------------------

describe('the tag write', () => {
  it('merges the estate tag and returns a real per-resource receipt', async () => {
    const d = deps({ [POOL_ID]: { env: 'dev', 'cost-center': 'cc-42' } });
    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    const res = r.outcome.results[0]!;
    expect(res.outcome).toBe('tagged');
    expect(res.mutatedAzure).toBe(true);
    expect(res.performedAt).toBe('2026-09-01T12:00:00.000Z');
    // The ROLLBACK value: absent before, so an untag restores the prior state.
    expect(res.priorEstateTag).toBeNull();
    expect(res.priorTags).toEqual({ env: 'dev', 'cost-center': 'cc-42' });
    // OTHER TAGS SURVIVE.
    expect(res.afterTags).toEqual({
      env: 'dev',
      'cost-center': 'cc-42',
      [LOOM_ESTATE_TAG_KEY]: ESTATE,
    });
    expect(r.outcome.mutatedAzure).toBe(true);
  });

  it('writes exactly ONE key — never the whole bag (the Merge argument)', async () => {
    const d = deps({ [POOL_ID]: { env: 'dev' } });
    await applyOwnershipBackfill({ resourceIds: [POOL_ID] }, d);
    expect(d.merge).toHaveBeenCalledWith(POOL_ID, LOOM_ESTATE_TAG_KEY, ESTATE);
  });

  it('RE-RUNNING is idempotent: already-tagged writes nothing and says so', async () => {
    const d = deps({ [POOL_ID]: { env: 'dev', [LOOM_ESTATE_TAG_KEY]: ESTATE } });
    const p = await previewOwnershipBackfill(d);
    if (!('preview' in p)) throw new Error('expected a preview');
    expect(p.preview.candidates.find((c) => c.resourceId === POOL_ID)!.state).toBe(
      'already-tagged',
    );
    expect(p.preview.actionableResourceIds).not.toContain(POOL_ID);

    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.results[0]!.outcome).toBe('already-tagged');
    expect(r.outcome.results[0]!.mutatedAzure).toBe(false);
    expect(r.outcome.alreadyTagged).toBe(1);
    expect(d.merge).not.toHaveBeenCalled();
    expect(r.outcome.mutatedAzure).toBe(false);
  });

  it('a failed write is UNCONFIRMED — never claimed as "not mutated" (R7)', async () => {
    const d = deps({});
    d.mergeTag = async () => {
      throw new Error('ARM refused to merge: status 403 (Tag Contributor is not granted)');
    };
    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.results[0]!.outcome).toBe('failed');
    expect(r.outcome.results[0]!.mutatedAzure).toBe('unconfirmed');
    expect(r.outcome.results[0]!.reason).toContain('Tag Contributor');
    expect(r.outcome.failed).toBe(1);
    expect(r.outcome.mutatedAzure).toBe('unconfirmed');
  });

  it('tags several confirmed resources and counts them truthfully', async () => {
    const d = deps({});
    const r = await applyOwnershipBackfill({ resourceIds: [POOL_ID, ADX_ID, AAS_ID] }, d);
    if (!('outcome' in r)) throw new Error('expected an outcome');
    expect(r.outcome.tagged).toBe(3);
    expect(r.outcome.refused).toBe(0);
    expect(r.outcome.failed).toBe(0);
    expect(r.outcome.requested).toBe(3);
    expect(d.merge).toHaveBeenCalledTimes(3);
  });
});

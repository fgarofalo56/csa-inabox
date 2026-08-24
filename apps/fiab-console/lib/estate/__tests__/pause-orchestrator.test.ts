/**
 * ESTATE PAUSE — the SCOPE-SAFETY suite. This is the most important test file
 * in the feature, and it is written to fail loudly rather than to pass quietly.
 *
 * ── WHAT IT IS GUARDING ────────────────────────────────────────────────────
 * MEASURED 2026-08-22 across the reachable Commercial subscriptions: of 23
 * pausable resources, ELEVEN are Loom's and TWELVE belong to ten unrelated
 * resource groups — the operator's blog, a Sentinel dev estate, two Atlas
 * estates, a NASA PoC runner, a SAP HANA sandbox. A subscription-scoped pause
 * takes every one of those down.
 *
 * The fixtures below are that estate in miniature, and they carry the two
 * measured traps deliberately:
 *
 *   • `rg-dlz-aiml-stack-dev`   — Loom-owned, and the string "loom" appears
 *                                 NOWHERE in its name. A name regex MISSES it.
 *   • `rg-loomis-analytics-prod` — matches /loom/i and is NOT ours. A name
 *                                 regex TEARS IT DOWN.
 *   • `rg-shared-mixed-dev`     — holds a Loom resource and a non-Loom one in
 *                                 the SAME group. Any design that resolves
 *                                 ownership at RG granularity gets one of them
 *                                 wrong no matter which way it errs.
 *
 * ── THE MUTATION THESE TESTS ARE CALIBRATED AGAINST ────────────────────────
 * `pause-scope-mutation.md` (PR body) records the run: replacing the per-
 * resource ownership resolution with a subscription-wide sweep — the exact
 * shortcut R-SCOPE-1 forbids — turns the `spares every non-Loom resource` cases
 * RED. A guard that stays green when its subject is mutated is the defect, not
 * the fix, so the mutation was actually run and its RC recorded.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ESTATE_PAUSE_TIER,
  planPause,
  startPause,
  pollPause,
  startResume,
  pollResume,
  applyResumePoll,
  resolveDeployManifest,
  discoverFromManifest,
  normalizePowerState,
  armTypeFromId,
  type EstateActuator,
  type PowerRead,
} from '../pause-orchestrator';
import {
  armPowerReading,
  isResumeSuccess,
  type EstatePauseSnapshot,
  type EstatePowerState,
} from '../pause-state';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';

const ESTATE = 'loom:estate-a';
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const SUB = 'sub-under-test';

// ---------------------------------------------------------------------------
// Fixtures — the measured estate, in miniature
// ---------------------------------------------------------------------------

function res(o: {
  name: string;
  rg: string;
  /** The ARM TYPE, e.g. `Microsoft.Synapse/workspaces/sqlPools`. */
  type: string;
  /**
   * The id path when it differs from the type — a NESTED resource's id
   * interleaves parent names (`workspaces/{ws}/sqlPools/{pool}`) while its
   * TYPE does not (`workspaces/sqlPools`). Conflating the two is exactly the
   * bug that made the first run of this suite miss the Synapse fixture.
   */
  path?: string;
  tags?: Record<string, string> | null;
  tagsError?: string;
}): DiscoveredResource {
  const path = o.path ?? `${o.type}/${o.name}`;
  return {
    resourceId: `/subscriptions/${SUB}/resourceGroups/${o.rg}/providers/${path}`,
    resourceType: o.type,
    name: o.name,
    resourceGroup: o.rg,
    subscriptionId: SUB,
    tags: o.tags === undefined ? {} : o.tags,
    ...(o.tagsError ? { tagsError: o.tagsError } : {}),
    discoverySource: 'deploy-manifest',
  };
}

const ours = { 'loom-estate-id': ESTATE };

/** Loom-owned, in an RG whose name contains NO "loom". The false negative. */
const LOOM_IN_UNNAMED_RG = res({
  name: 'loompool-aiml',
  rg: 'rg-dlz-aiml-stack-dev',
  type: 'Microsoft.Synapse/workspaces/sqlPools',
  path: 'Microsoft.Synapse/workspaces/wsx/sqlPools/loompool-aiml',
  tags: ours,
});

/** NOT ours, in an RG that matches /loom/i. The false positive. */
const LOOMIS_NOT_OURS = res({
  name: 'loomis-warehouse',
  rg: 'rg-loomis-analytics-prod',
  type: 'Microsoft.Synapse/workspaces/sqlPools',
  path: 'Microsoft.Synapse/workspaces/wsy/sqlPools/loomis-warehouse',
  tags: { owner: 'loomis-analytics', 'cost-center': 'not-ours' },
});

/** The MIXED resource group — both of these live in the SAME rg. */
const MIXED_LOOM = res({
  name: 'adx-loom-shared',
  rg: 'rg-shared-mixed-dev',
  type: 'Microsoft.Kusto/clusters',
  tags: ours,
});
const MIXED_NOT_OURS = res({
  name: 'adx-sentinel-dev',
  rg: 'rg-shared-mixed-dev',
  type: 'Microsoft.Kusto/clusters',
  tags: { project: 'sentinel-dev' },
});

/** The rest of the neighbourhood. Every one of these must be left alone. */
const NEIGHBOURS = [
  res({ name: 'blog-aas', rg: 'rg-limitlessdata-blog', type: 'Microsoft.AnalysisServices/servers', tags: {} }),
  res({ name: 'atlas-adx', rg: 'atlasdiag-rg', type: 'Microsoft.Kusto/clusters', tags: { project: 'atlas' } }),
  res({ name: 'nasa-runner-vmss', rg: 'rg-ghrunner-nasa-poc', type: 'Microsoft.Compute/virtualMachineScaleSets', tags: {} }),
  res({ name: 'hana-sandbox', rg: 'rg-sandbox-demo-east2', type: 'Microsoft.Compute/virtualMachineScaleSets', tags: { workload: 'sap-hana' } }),
  // Tags UNREADABLE — must be `indeterminate`, i.e. left running, and must NOT
  // be silently lumped in with "no Loom tag".
  res({ name: 'opaque-cluster', rg: 'artemis-poc-rg', type: 'Microsoft.Kusto/clusters', tags: null, tagsError: 'ARM 403 on the tag read' }),
];

/** Another Loom estate sharing the subscription — positively NOT ours. */
const OTHER_ESTATE = res({
  name: 'adx-loom-other',
  rg: 'rg-csa-loom-admin-westus',
  type: 'Microsoft.Kusto/clusters',
  tags: { 'loom-estate-id': 'loom:estate-b' },
});

const ALL: DiscoveredResource[] = [
  LOOM_IN_UNNAMED_RG,
  LOOMIS_NOT_OURS,
  MIXED_LOOM,
  MIXED_NOT_OURS,
  OTHER_ESTATE,
  ...NEIGHBOURS,
];

/** Everything in ALL that must NEVER be acted on. */
const MUST_BE_SPARED = [LOOMIS_NOT_OURS, MIXED_NOT_OURS, OTHER_ESTATE, ...NEIGHBOURS];

// ---------------------------------------------------------------------------
// A recording actuator — the test's oracle for "what did we actually touch?"
// ---------------------------------------------------------------------------

interface Recorder {
  actuator: EstateActuator;
  touched: string[];
  tagReads: string[];
  powerReads: string[];
}

function recorder(opts?: {
  power?: (id: string) => EstatePowerState | null;
  tags?: (id: string) => Readonly<Record<string, string>> | null | Error;
  pauseFails?: (id: string) => string | null;
  servable?: (id: string) => boolean;
  probed?: boolean;
}): Recorder {
  const touched: string[] = [];
  const tagReads: string[] = [];
  const powerReads: string[] = [];
  const byId = new Map(ALL.map((r) => [r.resourceId, r]));

  const actuator: EstateActuator = {
    async readTags(resourceId) {
      tagReads.push(resourceId);
      const override = opts?.tags?.(resourceId);
      if (override instanceof Error) throw override;
      if (override !== undefined) return override;
      return byId.get(resourceId)?.tags ?? {};
    },
    async readPower(resource): Promise<PowerRead> {
      powerReads.push(resource.resourceId);
      const state = opts?.power ? opts.power(resource.resourceId) : 'Online';
      if (state === null) return { reading: null, error: 'ARM 503 on the state read' };
      return {
        reading: armPowerReading({
          resourceId: resource.resourceId,
          powerState: state,
          armApiVersion: '2021-06-01',
        }),
        sku: { name: 'DW100c', capacity: 100 },
      };
    },
    async pause(candidate) {
      touched.push(candidate.resource.resourceId);
      const err = opts?.pauseFails?.(candidate.resource.resourceId);
      if (err) return { ok: false, detail: `rejected ${candidate.resource.name}`, error: err };
      return { ok: true, detail: `paused ${candidate.resource.name}` };
    },
    async resume(entry) {
      touched.push(entry.resourceId);
      return { ok: true, detail: `resumed ${entry.name}` };
    },
    async probeServable(entry) {
      const servable = opts?.servable ? opts.servable(entry.resourceId) : true;
      return {
        servable,
        probed: opts?.probed ?? true,
        detail: servable ? 'answered a probe' : 'the probe request did not succeed',
      };
    },
  };
  return { actuator, touched, tagReads, powerReads };
}

const ctx = (snapshotId = 'snap-1') => ({
  snapshotId,
  tenantId: 'tenant-1',
  estateId: ESTATE,
  createdBy: 'admin@contoso.com',
  now: '2026-08-23T00:00:00.000Z',
});

// ===========================================================================
// R-SCOPE — the safety-critical cases
// ===========================================================================

describe('R-SCOPE — the pause set spares every resource that is not positively Loom-owned', () => {
  it('THE test: a mixed estate yields ONLY the Loom-owned rows, and every neighbour is spared', () => {
    const plan = planPause(ALL, { scope: SCOPE, now: '2026-08-23T00:00:00.000Z' });
    const wouldPause = plan.dryRun.wouldPause.map((r) => r.resourceId);

    // Exactly the two Loom-owned, in-tier resources.
    expect(wouldPause).toEqual([LOOM_IN_UNNAMED_RG.resourceId, MIXED_LOOM.resourceId]);

    // And NOT ONE of the neighbours, by explicit id — a length check alone
    // would pass if the right COUNT of the wrong resources came back.
    for (const spared of MUST_BE_SPARED) {
      expect(wouldPause).not.toContain(spared.resourceId);
    }
  });

  it('R-SCOPE-2 false NEGATIVE: rg-dlz-aiml-stack-dev is Loom-owned with no "loom" in its RG name', () => {
    // A name regex would MISS this resource. The tag finds it.
    expect(/loom/i.test(LOOM_IN_UNNAMED_RG.resourceGroup)).toBe(false);
    const plan = planPause(ALL, { scope: SCOPE });
    expect(plan.dryRun.wouldPause.map((r) => r.resourceId)).toContain(LOOM_IN_UNNAMED_RG.resourceId);
  });

  it('R-SCOPE-2 false POSITIVE: rg-loomis-analytics-prod matches /loom/i and is NOT ours', () => {
    // A name regex would TEAR THIS DOWN. The tag spares it.
    expect(/loom/i.test(LOOMIS_NOT_OURS.resourceGroup)).toBe(true);
    const plan = planPause(ALL, { scope: SCOPE });
    expect(plan.dryRun.wouldPause.map((r) => r.resourceId)).not.toContain(LOOMIS_NOT_OURS.resourceId);
    const left = plan.dryRun.wouldLeaveRunning.find((r) => r.resourceId === LOOMIS_NOT_OURS.resourceId);
    expect(left?.kind).toBe('not-loom-owned');
  });

  it('R-SCOPE-2b MIXED RG: the same resource group yields one pausable and one spared', () => {
    expect(MIXED_LOOM.resourceGroup).toBe(MIXED_NOT_OURS.resourceGroup);
    const plan = planPause(ALL, { scope: SCOPE });
    const ids = plan.dryRun.wouldPause.map((r) => r.resourceId);
    expect(ids).toContain(MIXED_LOOM.resourceId);
    expect(ids).not.toContain(MIXED_NOT_OURS.resourceId);
    // The discriminator is the RESOURCE, so no RG-level rule could produce this.
  });

  it('another Loom ESTATE in the same subscription is positively not ours', () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const left = plan.dryRun.wouldLeaveRunning.find((r) => r.resourceId === OTHER_ESTATE.resourceId);
    expect(left?.kind).toBe('not-loom-owned');
    expect(left?.reason).toContain('DIFFERENT Loom');
  });

  it('an UNREADABLE tag set is indeterminate — left running, and reported as an error, not as "no tag"', () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const opaque = plan.dryRun.wouldLeaveRunning.find((r) => r.name === 'opaque-cluster');
    expect(opaque?.kind).toBe('ownership-indeterminate');
    expect(opaque?.reason).toContain('403');
  });

  it('nothing is silently dropped: every discovered resource appears in exactly one list', () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const seen = [
      ...plan.dryRun.wouldPause.map((r) => r.resourceId),
      ...plan.dryRun.wouldLeaveRunning.map((r) => r.resourceId),
      ...plan.outOfTier.map((r) => r.resourceId),
    ];
    expect(new Set(seen).size).toBe(ALL.length);
    expect(seen.sort()).toEqual(ALL.map((r) => r.resourceId).sort());
  });

  it('the dry run carries the OWNING TAG per row, which is what the confirm dialog shows', () => {
    const plan = planPause(ALL, { scope: SCOPE });
    for (const row of plan.dryRun.wouldPause) {
      expect(row.owningTagKey).toBe('loom-estate-id');
      expect(row.owningTagValue).toBe(ESTATE);
      expect(row.ownershipSource).toBe('ownership-tag');
    }
  });

  it('a subscription- or resource-group-scoped request is REFUSED at the type AND at runtime', () => {
    expect(() => planPause(ALL, { scope: { kind: 'subscription', estateId: ESTATE } as unknown as PauseScope }))
      .toThrow(/explicit\s+inventory/i);
    expect(() => planPause(ALL, { scope: { kind: 'resource-group', estateId: ESTATE } as unknown as PauseScope }))
      .toThrow(/R-SCOPE-1/);
  });
});

describe('R-SCOPE-3 — ownership is RE-VERIFIED immediately before the mutation', () => {
  it('a resource whose Loom tag was removed between preview and confirm is left RUNNING', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    // The tag disappears after the preview — someone re-tagged it, or the
    // resource was re-created under different ownership.
    const rec = recorder({ tags: (id) => (id === MIXED_LOOM.resourceId ? {} : undefined as never) });
    const run = await startPause(plan, rec.actuator, ctx());

    expect(rec.touched).toEqual([LOOM_IN_UNNAMED_RG.resourceId]);
    const skipped = run.actions.find((a) => a.resourceId === MIXED_LOOM.resourceId);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.detail).toMatch(/Leaving it RUNNING/);
    // …and it is NOT in the snapshot, so a later resume cannot act on it either.
    expect(run.snapshot.resources.map((r) => r.resourceId)).not.toContain(MIXED_LOOM.resourceId);
  });

  it('a THROWING tag re-read leaves the resource RUNNING (fail-safe, never fail-down)', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder({
      tags: (id) => (id === LOOM_IN_UNNAMED_RG.resourceId ? new Error('ARM 429 throttled') : (undefined as never)),
    });
    const run = await startPause(plan, rec.actuator, ctx());
    expect(rec.touched).toEqual([MIXED_LOOM.resourceId]);
    const skipped = run.actions.find((a) => a.resourceId === LOOM_IN_UNNAMED_RG.resourceId);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.detail).toContain('429');
  });

  it('every mutation was preceded by a tag re-read of that same resource', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder();
    await startPause(plan, rec.actuator, ctx());
    for (const touchedId of rec.touched) {
      expect(rec.tagReads).toContain(touchedId);
    }
    // And no tag was ever read for a resource outside the plan.
    for (const spared of MUST_BE_SPARED) {
      expect(rec.tagReads).not.toContain(spared.resourceId);
      expect(rec.powerReads).not.toContain(spared.resourceId);
    }
  });
});

// ===========================================================================
// PAUSE — snapshot-before-mutate, and PAUSED is never claimed on a dispatch
// ===========================================================================

describe('startPause / pollPause', () => {
  it('records the pre-pause ARM state BEFORE mutating, with provenance', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder();
    const run = await startPause(plan, rec.actuator, ctx());
    expect(run.snapshot.resources).toHaveLength(2);
    for (const entry of run.snapshot.resources) {
      expect(entry.powerStateSource).toBe('arm');
      expect(entry.powerStateApiVersion).toBe('2021-06-01');
      expect(entry.prePausePowerState).toBe('Online');
      expect(entry.ownership.verdict).toBe('loom-owned');
    }
  });

  it('refuses to pause a resource whose authoritative power read FAILED', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? null : 'Online') });
    const run = await startPause(plan, rec.actuator, ctx());
    expect(rec.touched).toEqual([LOOM_IN_UNNAMED_RG.resourceId]);
    const skipped = run.actions.find((a) => a.resourceId === MIXED_LOOM.resourceId);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.detail).toMatch(/could not be recorded/i);
    expect(skipped?.detail).toMatch(/Left RUNNING/);
  });

  it('an already-stopped resource is snapshotted but NOT mutated', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? 'Paused' : 'Online') });
    const run = await startPause(plan, rec.actuator, ctx());
    expect(rec.touched).toEqual([LOOM_IN_UNNAMED_RG.resourceId]);
    expect(run.actions.find((a) => a.resourceId === MIXED_LOOM.resourceId)?.status).toBe('already-paused');
    expect(run.snapshot.resources.map((r) => r.resourceId)).toContain(MIXED_LOOM.resourceId);
  });

  it('leaves the estate PAUSING — never PAUSED — because a pause verb is a 202', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder();
    const run = await startPause(plan, rec.actuator, ctx());
    expect(run.snapshot.state).toBe('PAUSING');
  });

  it('pollPause promotes to PAUSED only when a FRESH ARM read confirms every resource stopped', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const dispatched = await startPause(plan, recorder().actuator, ctx());

    // Still stopping: one confirmed, one not.
    const half = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? 'Paused' : 'Pausing') });
    const mid = await pollPause(dispatched.snapshot, half.actuator);
    expect(mid.state).toBe('PAUSING');
    expect(mid.confirmed).toBe(1);

    // Both confirmed.
    const done = recorder({ power: () => 'Paused' });
    const end = await pollPause(dispatched.snapshot, done.actuator);
    expect(end.state).toBe('PAUSED');
    expect(end.confirmed).toBe(2);
  });

  it('a FAILED state read counts as NOT confirmed — Unknown is not Paused', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const dispatched = await startPause(plan, recorder().actuator, ctx());
    const blind = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? null : 'Paused') });
    const poll = await pollPause(dispatched.snapshot, blind.actuator);
    expect(poll.state).toBe('PAUSING');
    expect(poll.confirmed).toBe(1);
    expect(poll.progress.find((p) => p.resourceId === MIXED_LOOM.resourceId)?.phase).toBe('unknown');
    expect(poll.progress.find((p) => p.resourceId === MIXED_LOOM.resourceId)?.detail)
      .toMatch(/NOT established/);
  });

  it('DRIFT: a PAUSED estate with a resource back Online is reported as DRIFT, not as "still PAUSING"', async () => {
    // PRP §5 lists four mechanisms that restart a paused resource unprompted —
    // Postgres auto-restart after 7 days, Event Hubs auto-inflate, the
    // Commercial estate rolling itself on every merge, and any ARM PUT. The
    // first version always said "still PAUSING", which flatly contradicted the
    // PAUSED state it was reporting alongside.
    const plan = planPause(ALL, { scope: SCOPE });
    const run = await startPause(plan, recorder().actuator, ctx());
    const paused: EstatePauseSnapshot = { ...run.snapshot, state: 'PAUSED' };

    const drifted = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? 'Online' : 'Paused') });
    const poll = await pollPause(paused, drifted.actuator);

    expect(poll.state).toBe('PAUSED');
    expect(poll.drifted).toBe(true);
    expect(poll.driftedResources).toEqual([MIXED_LOOM.resourceId]);
    expect(poll.reason).toMatch(/The estate is PAUSED, but 1 of 2 resource\(s\) are RUNNING again/);
    // It does NOT claim to have fixed anything — the reconciler (W6) is not built.
    expect(poll.reason).toMatch(/Nothing has been re-paused/);
    // And it never says "still PAUSING" over a PAUSED estate.
    expect(poll.reason).not.toMatch(/still PAUSING/);
    // The per-resource detail names the drift too.
    expect(poll.progress.find((p) => p.resourceId === MIXED_LOOM.resourceId)?.detail)
      .toMatch(/restarted it out of band/);
  });

  it('a PAUSING estate that has not settled still reports its OWN state, not a hard-coded one', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const run = await startPause(plan, recorder().actuator, ctx());
    const poll = await pollPause(run.snapshot, recorder({ power: () => 'Pausing' }).actuator);
    expect(poll.state).toBe('PAUSING');
    expect(poll.drifted).toBe(false);
    expect(poll.driftedResources).toEqual([]);
    expect(poll.reason).toMatch(/still PAUSING/);
  });

  it('drift is NOT reported for a PAUSING estate — a resource still up is just in flight', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const run = await startPause(plan, recorder().actuator, ctx());
    const poll = await pollPause(run.snapshot, recorder({ power: () => 'Online' }).actuator);
    expect(poll.state).toBe('PAUSING');
    expect(poll.drifted).toBe(false);
  });
});

// ===========================================================================
// RESUME — R-CAP-4, and the Synapse ONLINE-but-not-servable lie window
// ===========================================================================

/** A snapshot of two Loom resources that were Online before the pause. */
async function pausedSnapshot(): Promise<EstatePauseSnapshot> {
  const plan = planPause(ALL, { scope: SCOPE });
  const run = await startPause(plan, recorder().actuator, ctx());
  return { ...run.snapshot, state: 'PAUSED', pausedAt: '2026-08-23T00:05:00.000Z' };
}

describe('R-CAP-4 — an unconfirmed resume is RESUME_FAILED, NEVER RUNNING', () => {
  it('confirms RUNNING only when every resource is Online AND answers a real probe', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    expect(started.snapshot.state).toBe('RESUMING');

    const rec = recorder({ power: () => 'Online', servable: () => true });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T00:30:00.000Z' });
    expect(poll.state).toBe('RUNNING');
    expect(poll.unconfirmed).toEqual([]);
  });

  it('ARM says Online but the resource does NOT answer a probe -> RESUME_FAILED, not RUNNING', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });

    // The measured Synapse behaviour: the status field flips to ONLINE 2-3
    // minutes before the pool will accept a query.
    const rec = recorder({ power: () => 'Online', servable: (id) => id !== LOOM_IN_UNNAMED_RG.resourceId });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });

    expect(poll.state).toBe('RESUME_FAILED');
    expect(poll.state).not.toBe('RUNNING');
    const bad = poll.unconfirmed.find((u) => u.resourceId === LOOM_IN_UNNAMED_RG.resourceId);
    expect(bad?.confirmation).toBe('unknown');
    expect(bad?.reason).toMatch(/2-3 minutes before it can serve/);
  });

  it('a FAILED power read after resume -> unknown -> RESUME_FAILED', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const rec = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? null : 'Online') });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });
    expect(poll.state).toBe('RESUME_FAILED');
    expect(poll.unconfirmed.map((u) => u.confirmation)).toContain('unknown');
  });

  it('an UNPROBEABLE type is not assumed servable', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const rec = recorder({ power: () => 'Online', servable: () => false, probed: false });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });
    expect(poll.state).toBe('RESUME_FAILED');
    expect(poll.progress.every((p) => p.probed === false)).toBe(true);
  });

  it('inside the published resume window an unconfirmed resource reads RESUMING, not a false failure', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const rec = recorder({ power: () => 'Resuming' });
    // 30s into a 10-minute ADX start.
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T00:10:30.000Z' });
    expect(poll.state).toBe('RESUMING');
    expect(poll.terminal).toBe(false);
    // …and it is NOT a success claim: the unconfirmed set is reported either way.
    expect(poll.unconfirmed.length).toBeGreaterThan(0);
    expect(poll.reason).toMatch(/not a\s+success claim/i);
  });

  it('the settle window can only DELAY a verdict, never manufacture a RUNNING one', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    // Inside the window AND every resource genuinely up -> RUNNING immediately.
    const rec = recorder({ power: () => 'Online', servable: () => true });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T00:10:05.000Z' });
    expect(poll.state).toBe('RUNNING');
    expect(poll.terminal).toBe(true);
  });

  it('a resource that was ALREADY stopped before the pause is not started by a resume', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const preStopped = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? 'Paused' : 'Online') });
    const run = await startPause(plan, preStopped.actuator, ctx());
    const snap: EstatePauseSnapshot = { ...run.snapshot, state: 'PAUSED' };

    const rec = recorder();
    const started = await startResume(snap, rec.actuator, { now: '2026-08-23T00:10:00.000Z' });
    expect(rec.touched).toEqual([LOOM_IN_UNNAMED_RG.resourceId]);
    expect(started.dispatches.find((d) => d.resourceId === MIXED_LOOM.resourceId)?.status).toBe('skipped');
  });

  /**
   * ── THE PAUSE/RESUME ASYMMETRY (independent review, 2026-08-23) ────────────
   * `reverifyBeforeAct` had exactly ONE call site — inside `startPause`.
   * `startResume` iterated `snapshot.resources` and called `actuator.resume`
   * guarded only by the STRUCTURAL `assertActuationTarget`, which establishes
   * that an id is well-formed and self-consistent, NOT that it is ours. A grep
   * for a test asserting resume refuses a foreign entry returned zero.
   *
   * Resume deliberately does not re-read live tags — that is the recovery
   * direction, and a tag changed while the estate was down would strand a paused
   * resource permanently. It re-asserts the snapshot's OWN recorded verdict,
   * which `capturePrePauseState` guarantees for every legitimately written
   * entry, so nothing recoverable is ever refused.
   */
  it('RESUME refuses a snapshot entry that is not recorded loom-owned, and touches NOTHING', async () => {
    // EVERY non-`loom-owned` member of the OwnershipVerdict union, not just one.
    // A first draft of this case used a single made-up verdict, and a mutation
    // that inverted the guard into an allowlist (`=== 'not-loom-owned'`) then
    // SURVIVED a full green run while still resuming an `indeterminate` entry.
    // Enumerating the union is what makes the guard's polarity testable.
    for (const verdict of ['not-loom-owned', 'indeterminate'] as const) {
      const snap = await pausedSnapshot();
      const foreign: EstatePauseSnapshot = {
        ...snap,
        resources: snap.resources.map((r) => ({
          ...r,
          ownership: { verdict, source: 'none' as const, reason: 'tampered snapshot document' },
        })),
      };
      const rec = recorder();
      const started = await startResume(foreign, rec.actuator, { now: '2026-08-23T00:10:00.000Z' });
      expect(rec.touched, verdict).toEqual([]);
      expect(started.dispatches.length, verdict).toBeGreaterThan(0);
      for (const d of started.dispatches) {
        expect(d.status, verdict).toBe('skipped');
        expect(d.detail, verdict).toMatch(/not 'loom-owned'/);
      }
    }
  });

  it('RESUME still dispatches normally for a properly loom-owned snapshot', async () => {
    // The control: the guard above must refuse the tampered entry WITHOUT
    // refusing the ordinary one, or it would simply be a broken resume.
    const snap = await pausedSnapshot();
    const rec = recorder();
    const started = await startResume(snap, rec.actuator, { now: '2026-08-23T00:10:00.000Z' });
    expect(rec.touched.length).toBeGreaterThan(0);
    expect(started.dispatches.some((d) => d.status === 'dispatched')).toBe(true);
  });

  it('RESUME_FAILED cannot be laundered into RUNNING by a state write', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const rec = recorder({ power: () => 'Stopped' });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });
    const failed = applyResumePoll(started.snapshot, poll, '2026-08-23T01:00:00.000Z');
    expect(failed.state).toBe('RESUME_FAILED');

    // Guard 1 (outcomes): the outcomes do not support RUNNING.
    expect(() => applyResumePoll(failed, { ...poll, state: 'RUNNING' }))
      .toThrow(/Refusing to report the estate RUNNING/);

    // Guard 2 (state machine): even with PERFECT outcomes, RESUME_FAILED has
    // exactly one legal exit and it is not RUNNING. The two guards are
    // independent — neither is load-bearing alone.
    const perfect = {
      ...poll,
      state: 'RUNNING' as const,
      outcomes: failed.resources.map((r) => ({
        resourceId: r.resourceId,
        confirmation: 'confirmed-running' as const,
        observedState: 'Online' as const,
        reason: 'up',
      })),
    };
    expect(() => applyResumePoll(failed, perfect)).toThrow(/Illegal estate transition/);
  });
});

// ===========================================================================
// The tier + the deploy-emitted manifest
// ===========================================================================

describe('the PAUSE tier', () => {
  it('excludes Container Apps, so the console cannot pause the surface that resumes it', () => {
    expect(ESTATE_PAUSE_TIER).not.toContain('microsoft.app/containerapps');
    const aca = res({ name: 'loom-console', rg: 'rg-shared-mixed-dev', type: 'Microsoft.App/containerApps', tags: ours });
    const plan = planPause([...ALL, aca], { scope: SCOPE });
    expect(plan.dryRun.wouldPause.map((r) => r.resourceId)).not.toContain(aca.resourceId);
    const held = plan.outOfTier.find((r) => r.resourceId === aca.resourceId);
    expect(held?.reason).toMatch(/console itself runs as a Container App/);
  });

  it('an out-of-tier resource is still VISIBLE — nothing vanishes from the preview', () => {
    const asa = res({ name: 'asa-job', rg: 'rg-shared-mixed-dev', type: 'Microsoft.StreamAnalytics/streamingJobs', tags: ours });
    const plan = planPause([...ALL, asa], { scope: SCOPE });
    expect(plan.outOfTier.map((r) => r.resourceId)).toContain(asa.resourceId);
  });
});

describe('resolveDeployManifest — ownership from the deploy, per RESOURCE', () => {
  const env = {
    LOOM_SUBSCRIPTION_ID: 'sub-a',
    LOOM_SYNAPSE_RG: 'rg-dlz-aiml-stack-dev',
    LOOM_SYNAPSE_WORKSPACE: 'syn-ws',
    LOOM_SYNAPSE_DEDICATED_POOL: 'pool1',
    LOOM_KUSTO_RG: 'rg-shared-mixed-dev',
    LOOM_KUSTO_CLUSTER_NAME: 'adx-loom-shared',
    LOOM_ESTATE_ID: ESTATE,
  } as unknown as NodeJS.ProcessEnv;

  it('names EXACT resources, never a subscription and never a resource group', () => {
    const { manifest, entries } = resolveDeployManifest({ ...env, LOOM_ESTATE_PAUSE_ENABLED: 'true' });
    expect(manifest.estateId).toBe(ESTATE);
    expect(entries).toHaveLength(2);
    for (const id of manifest.resourceIds) {
      // Every id addresses one resource: it has a provider segment and a name.
      expect(id).toMatch(/\/providers\/[^/]+\/[^/]+\/[^/]+/);
    }
    expect(entries.map((e) => e.resourceType).sort()).toEqual([
      'microsoft.kusto/clusters',
      'microsoft.synapse/workspaces/sqlpools',
    ]);
  });

  it('a resource with no env var naming it is simply NOT in the pause set', () => {
    const { entries, unresolved } = resolveDeployManifest(env);
    expect(entries.map((e) => e.resourceType)).not.toContain('microsoft.analysisservices/servers');
    const aas = unresolved.find((u) => u.label.includes('Analysis Services'));
    expect(aas?.needs).toContain('LOOM_AAS_SERVER_NAME');
  });

  it('an empty environment yields an EMPTY pause set — fail-safe, not fail-wide', () => {
    const { manifest, entries } = resolveDeployManifest({} as NodeJS.ProcessEnv);
    expect(entries).toEqual([]);
    expect(manifest.resourceIds).toEqual([]);
  });

  it('the manifest makes a resource Loom-owned even with NO tag on it — WHEN ARMED', async () => {
    const { manifest, entries } = resolveDeployManifest({ ...env, LOOM_ESTATE_PAUSE_ENABLED: 'true' });
    const discovered = await discoverFromManifest(entries, async () => ({}));
    const plan = planPause(discovered, { scope: SCOPE, manifest });
    expect(plan.dryRun.wouldPause).toHaveLength(2);
    expect(plan.dryRun.wouldPause.every((r) => r.ownershipSource === 'deploy-manifest')).toBe(true);
  });

  it('UNARMED, the same manifest grants NOTHING — the arming switch is the whole difference', async () => {
    // The blocker: the deploy sets every env var this manifest is built from,
    // so without the gate this path is live on the estate today. Same inputs as
    // the case above, minus LOOM_ESTATE_PAUSE_ENABLED.
    const { manifest, entries, gateReason, namedByDeploy } = resolveDeployManifest(env);
    expect(namedByDeploy).toBe(2);
    const discovered = await discoverFromManifest(entries, async () => ({}));
    const plan = planPause(discovered, { scope: SCOPE, manifest, gateReason, namedByDeploy });
    expect(plan.dryRun.wouldPause).toEqual([]);
    expect(plan.population.armed).toBe(false);
    expect(plan.population.namedByDeploy).toBe(2);
    expect(plan.population.statement).toMatch(/NOT ARMED/);
    expect(plan.population.statement).toContain('LOOM_ESTATE_PAUSE_ENABLED');
    // The resources are still EXAMINED and reported — the gate withholds
    // ownership, it does not hide the estate from the operator.
    expect(plan.population.examined).toBe(2);
  });

  it('a THROWING tag read yields indeterminate ownership — the resource is left running', async () => {
    const { manifest, entries } = resolveDeployManifest({ ...env, LOOM_ESTATE_PAUSE_ENABLED: 'true' });
    const discovered = await discoverFromManifest(entries, async () => {
      throw new Error('ARM 403 Forbidden on the tag read');
    });
    const plan = planPause(discovered, { scope: SCOPE, manifest });
    // The manifest still establishes ownership, so these ARE ours…
    expect(plan.dryRun.wouldPause).toHaveLength(0);
    // …but the tags could not be read, so ownership is indeterminate and the
    // fail-safe wins. Never act on uncertainty.
    expect(plan.dryRun.wouldLeaveRunning.every((r) => r.kind === 'ownership-indeterminate')).toBe(true);
  });
});

describe('normalizePowerState / armTypeFromId', () => {
  it('maps each provider vocabulary onto the shared state, and unknown text to Unknown', () => {
    expect(normalizePowerState('microsoft.kusto/clusters', 'Running')).toBe('Online');
    expect(normalizePowerState('microsoft.kusto/clusters', 'Stopped')).toBe('Stopped');
    expect(normalizePowerState('microsoft.synapse/workspaces/sqlpools', 'Online')).toBe('Online');
    expect(normalizePowerState('microsoft.synapse/workspaces/sqlpools', 'Paused')).toBe('Paused');
    expect(normalizePowerState('microsoft.analysisservices/servers', 'Succeeded')).toBe('Online');
    expect(normalizePowerState('microsoft.analysisservices/servers', 'Paused')).toBe('Paused');
    // The load-bearing one: an unrecognised value is NOT optimistically Online.
    expect(normalizePowerState('microsoft.kusto/clusters', 'Frobnicating')).toBe('Unknown');
    expect(normalizePowerState('microsoft.kusto/clusters', undefined)).toBe('Unknown');
  });

  it('derives the ARM type from a nested resource id', () => {
    expect(armTypeFromId('/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c'))
      .toBe('microsoft.kusto/clusters');
    expect(armTypeFromId('/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/sqlPools/p'))
      .toBe('microsoft.synapse/workspaces/sqlpools');
  });
});

describe('the actuator seam is real', () => {
  it('the orchestrator never imports an Azure client at module scope', async () => {
    // If it did, this import would construct a credential chain in a unit test.
    // Asserting the module loads with no Azure env is the cheap proof.
    const mod = await import('../pause-orchestrator');
    expect(typeof mod.planPause).toBe('function');
    expect(vi.isMockFunction(mod.planPause)).toBe(false);
  });
});

// ===========================================================================
// ZERO POPULATION — the answer when nothing carries the tag (#3922)
// ===========================================================================

describe('the population report — a guard with a zero population must SAY so', () => {
  /** The live estate today: `loom-managed` present, `loom-estate-id` absent. */
  const MANAGED_ONLY: DiscoveredResource[] = [
    res({ name: 'aas-loom-semantic', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.AnalysisServices/servers', tags: { 'loom-managed': 'true' } }),
    res({ name: 'adx-loom-shared', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.Kusto/clusters', tags: { 'loom-managed': 'true' } }),
  ];

  it('reports EMPTY, loudly, and explains which signal is missing', () => {
    const plan = planPause(MANAGED_ONLY, { scope: SCOPE });
    expect(plan.dryRun.wouldPause).toEqual([]);
    expect(plan.population.empty).toBe(true);
    expect(plan.population.pausable).toBe(0);
    expect(plan.population.examined).toBe(2);
    expect(plan.population.statement).toMatch(/NOTHING would be paused/);
    expect(plan.population.statement).toContain('loom-estate-id');
  });

  it('counts loom-managed and REFUSES to act on it — a boolean cannot discriminate estates', () => {
    const plan = planPause(MANAGED_ONLY, { scope: SCOPE });
    // Reported…
    expect(plan.population.tagCensus.loomManaged).toBe(2);
    expect(plan.population.statement).toMatch(/deliberately does NOT accept it/);
    expect(plan.population.statement).toContain('#3922');
    // …and NOT acted on. This is the whole point: a resolver keyed to
    // `loom-managed` would look alive today and silently pause a SIBLING
    // estate's Analysis Services server in a shared subscription.
    expect(plan.population.pausable).toBe(0);
  });

  it('counts the three ownership tags SEPARATELY — never one summed "tagged" number', () => {
    const mixed: DiscoveredResource[] = [
      ...MANAGED_ONLY,
      res({ name: 'a', rg: 'rg-x', type: 'Microsoft.Kusto/clusters', tags: { 'loom-estate-id': ESTATE } }),
      res({ name: 'b', rg: 'rg-x', type: 'Microsoft.Kusto/clusters', tags: { 'loom-item-id': 'act-1' } }),
      res({ name: 'c', rg: 'rg-x', type: 'Microsoft.Kusto/clusters', tags: {} }),
    ];
    const census = planPause(mixed, { scope: SCOPE }).population.tagCensus;
    expect(census).toEqual({ loomEstateId: 1, loomItemId: 1, loomManaged: 2, untagged: 1 });
  });

  it('states the evidence split when the set is NOT empty', () => {
    const plan = planPause(ALL, { scope: SCOPE });
    expect(plan.population.empty).toBe(false);
    expect(plan.population.byEvidence).toEqual({ ownershipTag: 2, deployManifest: 0 });
    expect(plan.population.statement).toMatch(/2 of 10 examined resource\(s\) would be paused/);
  });

  it('a pause that captured NOTHING records RUNNING, not PAUSING over an empty snapshot', async () => {
    const plan = planPause(MANAGED_ONLY, { scope: SCOPE });
    const rec = recorder();
    const run = await startPause(plan, rec.actuator, ctx());
    expect(run.capturedNone).toBe(true);
    expect(run.snapshot.resources).toEqual([]);
    // NOT 'PAUSING'. An empty snapshot would later "resume successfully"
    // (deriveResumeState returns RUNNING for an empty resource list), so a
    // whole no-op would render as a success.
    expect(run.snapshot.state).toBe('RUNNING');
    expect(rec.touched).toEqual([]);
  });

  it('a partial capture still records the resources it DID capture', async () => {
    const plan = planPause(ALL, { scope: SCOPE });
    const rec = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? null : 'Online') });
    const run = await startPause(plan, rec.actuator, ctx());
    expect(run.capturedNone).toBe(false);
    expect(run.snapshot.resources).toHaveLength(1);
    expect(run.snapshot.state).toBe('PAUSING');
  });
});

// ===========================================================================
// The progress model must not key off a ResumeConfirmation string
// ===========================================================================

describe('the progress model branches on the OBSERVED state, not on a confirmation enum', () => {
  it('a correctly-still-paused resource is NOT rendered as running', async () => {
    // W1 split the old single `confirmed-running` into two success members
    // because a badge bound to the string was wrong in one direction; comparing
    // against `confirmed-running` alone is now wrong in the OTHER direction.
    // The progress model sidesteps both by never reading the enum: it derives
    // everything from the OBSERVED ARM state plus the recorded expectation.
    const plan = planPause(ALL, { scope: SCOPE });
    const preStopped = recorder({ power: (id) => (id === MIXED_LOOM.resourceId ? 'Paused' : 'Online') });
    const run = await startPause(plan, preStopped.actuator, ctx());
    const snap: EstatePauseSnapshot = { ...run.snapshot, state: 'PAUSED' };
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });

    const rec = recorder({
      power: (id) => (id === MIXED_LOOM.resourceId ? 'Paused' : 'Online'),
      servable: () => true,
    });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });

    const stopped = poll.progress.find((p) => p.resourceId === MIXED_LOOM.resourceId)!;
    const up = poll.progress.find((p) => p.resourceId === LOOM_IN_UNNAMED_RG.resourceId)!;

    // The two outcomes carry DIFFERENT confirmation members…
    const stoppedOutcome = poll.outcomes.find((o) => o.resourceId === MIXED_LOOM.resourceId)!;
    const upOutcome = poll.outcomes.find((o) => o.resourceId === LOOM_IN_UNNAMED_RG.resourceId)!;
    expect(stoppedOutcome.confirmation).toBe('confirmed-restored-paused');
    expect(upOutcome.confirmation).toBe('confirmed-running');
    // …and BOTH are successes. A consumer comparing against 'confirmed-running'
    // alone would mark the restored-paused one FAILED.
    expect(isResumeSuccess(stoppedOutcome.confirmation)).toBe(true);
    expect(isResumeSuccess(upOutcome.confirmation)).toBe(true);

    // The progress model reports them distinctly, from the observed state.
    expect(stopped.expectation).toBe('stopped');
    expect(stopped.powerState).toBe('Paused');
    expect(up.expectation).toBe('running');
    expect(up.powerState).toBe('Online');
    // Both are "at their expected state" — which is what the UI renders — while
    // only one of them is running.
    expect(stopped.atExpectedState).toBe(true);
    expect(up.atExpectedState).toBe(true);
    // …and the estate verdict is RUNNING, because both resources reached the
    // state the snapshot says they were in.
    expect(poll.state).toBe('RUNNING');
  });

  it('atExpectedState for a running resource requires the PROBE, not just Online', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const rec = recorder({ power: () => 'Online', servable: () => false });
    const poll = await pollResume(started.snapshot, rec.actuator, { now: '2026-08-23T01:00:00.000Z' });
    expect(poll.progress.every((p) => p.powerState === 'Online')).toBe(true);
    expect(poll.progress.every((p) => p.atExpectedState === false)).toBe(true);
    expect(poll.state).toBe('RESUME_FAILED');
  });
});

// ===========================================================================
// applyResumePoll — the false-green guard is INDEPENDENT of the transition table
// ===========================================================================

describe('applyResumePoll refuses a RUNNING write that the outcomes do not support', () => {
  it('rejects RUNNING with an unconfirmed outcome, even though RESUMING -> RUNNING is a LEGAL transition', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    // The state machine alone would allow this — LEGAL_TRANSITIONS has
    // RESUMING -> RUNNING. Only the outcome check stops it.
    const forged = {
      state: 'RUNNING' as const,
      outcomes: [{ resourceId: LOOM_IN_UNNAMED_RG.resourceId, confirmation: 'unknown' as const, reason: 'never checked' }],
      progress: [],
      unconfirmed: [],
      terminal: true,
      reason: 'forged',
    };
    expect(() => applyResumePoll(started.snapshot, forged)).toThrow(/Refusing to report the estate RUNNING/);
  });

  it('rejects RUNNING with ZERO outcomes over a non-empty snapshot', async () => {
    const snap = await pausedSnapshot();
    const started = await startResume(snap, recorder().actuator, { now: '2026-08-23T00:10:00.000Z' });
    const forged = {
      state: 'RUNNING' as const,
      outcomes: [],
      progress: [],
      unconfirmed: [],
      terminal: true,
      reason: 'forged',
    };
    expect(() => applyResumePoll(started.snapshot, forged)).toThrow(/ZERO confirmation outcomes/);
  });
});

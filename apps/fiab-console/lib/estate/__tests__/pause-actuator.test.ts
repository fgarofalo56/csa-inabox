/**
 * THE ACTUATOR SUITE — the only tests that exercise the code which actually
 * touches Azure.
 *
 * ── WHY THIS FILE EXISTS (independent review, 2026-08-23) ──────────────────
 * Every other suite in this feature injects a fake `EstateActuator`. That is
 * the right design — it is what makes the scope rules testable — but it meant
 * `createArmActuator()`, the ONE function that issues real ARM calls, had ZERO
 * coverage. A blocker hid there for exactly that reason:
 *
 *     const { pausePool } = await import('@/lib/azure/synapse-pool-arm');
 *     await pausePool();          // <- no argument
 *
 * `pausePool()` re-derives its target from `process.env`, so the resource that
 * got PAUSED was not the resource whose ownership had just been RE-VERIFIED.
 * Today they coincide; they diverge the moment #3922 makes the tag the
 * discovery source. AAS and VMSS in the same switch used the id correctly, and
 * that inconsistency was the tell.
 *
 * So these cases stub the ARM TRANSPORT (`armGet`/`armPost`/`armPatch`) rather
 * than the actuator, and assert on the URL that would go on the wire. The
 * invariant under test is one sentence: **the id in the URL is the id whose
 * ownership was verified** — for every type, with no exceptions and no
 * env-derived fallback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const armGet = vi.fn();
const armPost = vi.fn();
const armPatch = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armPost: (...a: unknown[]) => armPost(...a),
  armPatch: (...a: unknown[]) => armPatch(...a),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

/**
 * If the actuator ever reaches for the env-derived clients again, these throw
 * — so the regression cannot come back quietly. The whole point of the fix is
 * that these modules are no longer on the pause/resume path.
 */
const pausePool = vi.fn(() => { throw new Error('pausePool() was called — it re-derives its target from process.env'); });
const resumePool = vi.fn(() => { throw new Error('resumePool() was called — it re-derives its target from process.env'); });
vi.mock('@/lib/azure/synapse-pool-arm', () => ({
  pausePool: () => pausePool(),
  resumePool: () => resumePool(),
  getPoolState: vi.fn(),
}));
const stopKustoCluster = vi.fn(() => { throw new Error('stopKustoCluster() was called — it re-derives its target from process.env'); });
const startKustoCluster = vi.fn(() => { throw new Error('startKustoCluster() was called — it re-derives its target from process.env'); });
vi.mock('@/lib/azure/kusto-arm-client', () => ({
  stopKustoCluster: () => stopKustoCluster(),
  startKustoCluster: () => startKustoCluster(),
}));

/**
 * The CONFIRM path's clients. `dedicatedTarget()` and `listDatabases()` are the
 * probe-side twins of `pausePool()` — zero-argument, env-deriving — so they
 * throw here for exactly the same reason: reaching for them means the probe
 * asked a DIFFERENT resource than the one whose ownership was verified.
 */
const synapseExecuteQuery = vi.fn();
const dedicatedTarget = vi.fn(() => {
  throw new Error('dedicatedTarget() was called — it re-derives its target from process.env');
});
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...a: unknown[]) => synapseExecuteQuery(...a),
  dedicatedTarget: () => dedicatedTarget(),
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
const kustoExecuteQuery = vi.fn();
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: unknown[]) => kustoExecuteQuery(...a),
}));
const listDatabases = vi.fn(() => {
  throw new Error('listDatabases() was called — it re-derives its target from process.env');
});
vi.mock('@/lib/azure/aas-server-client', () => ({
  listDatabases: () => listDatabases(),
}));

import {
  assertActuationTarget,
  createArmActuator,
  estatePauseEnabled,
  ESTATE_PAUSE_ENABLED_ENV,
  resolveDeployManifest,
} from '../pause-orchestrator';
import type { PauseCandidate } from '../pause-inventory';
import type { PausedResourceSnapshot } from '../pause-state';

// ---------------------------------------------------------------------------
// Fixtures — ids that deliberately DO NOT match any env var
// ---------------------------------------------------------------------------

const SUB = 'sub-verified';
const ids = {
  pool: `/subscriptions/${SUB}/resourceGroups/rg-verified/providers/Microsoft.Synapse/workspaces/ws-verified/sqlPools/pool-verified`,
  adx: `/subscriptions/${SUB}/resourceGroups/rg-verified/providers/Microsoft.Kusto/clusters/adx-verified`,
  aas: `/subscriptions/${SUB}/resourceGroups/rg-verified/providers/Microsoft.AnalysisServices/servers/aas-verified`,
  vmss: `/subscriptions/${SUB}/resourceGroups/rg-verified/providers/Microsoft.Compute/virtualMachineScaleSets/vmss-verified`,
};
const types = {
  pool: 'microsoft.synapse/workspaces/sqlpools',
  adx: 'microsoft.kusto/clusters',
  aas: 'microsoft.analysisservices/servers',
  vmss: 'microsoft.compute/virtualmachinescalesets',
};

function candidateFor(kind: keyof typeof ids): PauseCandidate {
  return {
    resource: {
      resourceId: ids[kind],
      resourceType: types[kind],
      name: `${kind}-verified`,
      resourceGroup: 'rg-verified',
      subscriptionId: SUB,
      tags: { 'loom-estate-id': 'loom:estate-a' },
      discoverySource: 'deploy-manifest',
    },
    spec: {
      resourceType: types[kind],
      label: kind,
      mechanism: 'arm-pause-action',
      capacityConstrained: true,
      armApiVersion: '2021-06-01',
    },
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 'tagged' },
  };
}

function entryFor(kind: keyof typeof ids, over?: Partial<PausedResourceSnapshot>): PausedResourceSnapshot {
  return {
    resourceId: ids[kind],
    resourceType: types[kind],
    name: `${kind}-verified`,
    resourceGroup: 'rg-verified',
    subscriptionId: SUB,
    prePausePowerState: 'Online',
    powerStateSource: 'arm',
    powerStateReadAt: '2026-08-23T00:00:00.000Z',
    powerStateApiVersion: '2021-06-01',
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 'tagged' },
    ...over,
  };
}

/** Every URL the transport was asked to hit, across all three verbs. */
function urls(): string[] {
  return [
    ...armPost.mock.calls.map((c) => String(c[0])),
    ...armPatch.mock.calls.map((c) => String(c[0])),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Keyed on the URL so the ADX probe's two reads (the cluster, then its
  // databases) can return different bodies while every other caller keeps the
  // power-read shape it had.
  armGet.mockImplementation(async (url: unknown) => {
    if (/\/databases\?/.test(String(url))) {
      // ARM names a child database `{clusterName}/{databaseName}` — the probe
      // must strip that prefix rather than pass it through as a database name.
      return { value: [{ name: 'adx-verified/loomdb' }] };
    }
    return {
      tags: {},
      properties: { state: 'Running', uri: 'https://adx-verified.eastus2.kusto.windows.net' },
      sku: { name: 'DW100c', capacity: 100 },
    };
  });
  armPost.mockResolvedValue({});
  armPatch.mockResolvedValue({});
  synapseExecuteQuery.mockResolvedValue({ rows: [{ loom_pause_probe: 1 }] });
  kustoExecuteQuery.mockResolvedValue({ rows: [[1]] });
  // The env deliberately names DIFFERENT resources than the fixtures, so any
  // env-derived target is immediately visible as a mismatch.
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-FROM-ENV';
  process.env.LOOM_SYNAPSE_RG = 'rg-FROM-ENV';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws-FROM-ENV';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool-FROM-ENV';
  process.env.LOOM_KUSTO_RG = 'rg-FROM-ENV';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adx-FROM-ENV';
});

// ===========================================================================
// THE BLOCKER-2 REGRESSION GUARD
// ===========================================================================

describe('createArmActuator — the mutation lands on the VERIFIED id', () => {
  it('PAUSE targets the candidate id for EVERY type, never the env-derived one', async () => {
    const actuator = await createArmActuator();
    for (const kind of ['pool', 'adx', 'aas', 'vmss'] as const) {
      await actuator.pause(candidateFor(kind));
    }
    const hit = urls();
    expect(hit).toHaveLength(4);
    // Every URL addresses the VERIFIED id…
    expect(hit.some((u) => u.startsWith(`${ids.pool}/pause?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.adx}/stop?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.aas}/suspend?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.vmss}?`))).toBe(true);
    // …and NOT ONE mentions anything the env named.
    for (const u of hit) expect(u).not.toContain('FROM-ENV');
  });

  it('RESUME targets the snapshot id for EVERY type, never the env-derived one', async () => {
    const actuator = await createArmActuator();
    for (const kind of ['pool', 'adx', 'aas', 'vmss'] as const) {
      await actuator.resume(entryFor(kind));
    }
    const hit = urls();
    expect(hit).toHaveLength(4);
    expect(hit.some((u) => u.startsWith(`${ids.pool}/resume?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.adx}/start?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.aas}/resume?`))).toBe(true);
    expect(hit.some((u) => u.startsWith(`${ids.vmss}?`))).toBe(true);
    for (const u of hit) expect(u).not.toContain('FROM-ENV');
  });

  it('NEVER calls the zero-argument, env-deriving clients', async () => {
    // These mocks THROW if reached. Asserting "not called" as well as relying on
    // the throw means the regression is caught whether or not the call is
    // wrapped in a try/catch that swallows it.
    const actuator = await createArmActuator();
    await actuator.pause(candidateFor('pool'));
    await actuator.pause(candidateFor('adx'));
    await actuator.resume(entryFor('pool'));
    await actuator.resume(entryFor('adx'));
    expect(pausePool).not.toHaveBeenCalled();
    expect(resumePool).not.toHaveBeenCalled();
    expect(stopKustoCluster).not.toHaveBeenCalled();
    expect(startKustoCluster).not.toHaveBeenCalled();
  });

  it('the authoritative power read is issued against the verified id too', async () => {
    const actuator = await createArmActuator();
    await actuator.readPower({ resourceId: ids.pool, resourceType: types.pool, name: 'pool-verified' });
    const url = String(armGet.mock.calls[0][0]);
    expect(url.startsWith(`${ids.pool}?`)).toBe(true);
    expect(url).not.toContain('FROM-ENV');
  });

  it('VMSS resume restores the RECORDED capacity, not a hard-coded 1', async () => {
    const actuator = await createArmActuator();
    await actuator.resume(entryFor('vmss', { replicaCount: 4 }));
    expect(armPatch).toHaveBeenCalledWith(expect.stringContaining(ids.vmss), { sku: { capacity: 4 } });
  });

  it('an ARM rejection is reported as a failure with the raw text, never as success', async () => {
    armPost.mockRejectedValueOnce(new Error('ARM POST failed 403: AuthorizationFailed'));
    const actuator = await createArmActuator();
    const r = await actuator.pause(candidateFor('pool'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('AuthorizationFailed');
  });
});

describe('assertActuationTarget — fail closed on anything it cannot establish', () => {
  it('refuses an id that is not fully qualified', () => {
    expect(() => assertActuationTarget({ resourceId: 'pool-verified', resourceType: types.pool, name: 'x' }))
      .toThrow(/not a fully-qualified ARM resource id/);
  });

  it('refuses when the recorded TYPE disagrees with the type the id addresses', () => {
    // A snapshot that says "Kusto cluster" but whose id addresses a Synapse pool
    // is a snapshot nobody can act on safely.
    expect(() => assertActuationTarget({ resourceId: ids.pool, resourceType: types.adx, name: 'x' }))
      .toThrow(/its recorded type is 'microsoft.kusto\/clusters' but its resource id addresses/);
  });

  it('accepts a well-formed, self-consistent target', () => {
    for (const kind of ['pool', 'adx', 'aas', 'vmss'] as const) {
      expect(() => assertActuationTarget({ resourceId: ids[kind], resourceType: types[kind], name: kind }))
        .not.toThrow();
    }
  });

  it('a mismatched target is REFUSED at actuation time, not merely logged', async () => {
    const actuator = await createArmActuator();
    const bad = candidateFor('pool');
    const r = await actuator.pause({
      ...bad,
      resource: { ...bad.resource, resourceType: types.adx },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recorded type/);
    expect(armPost).not.toHaveBeenCalled();
    expect(armPatch).not.toHaveBeenCalled();
  });

  /**
   * ── WHY THIS LOOPS OVER THE DECLARED TYPE (review, 2026-08-23) ─────────────
   * The case above only ever declares ONE type, so a reviewer's mutation that
   * skipped `assertActuationTarget` for a SINGLE type (VMSS) survived a full
   * green run: per-type INVOCATION was untested even though the check itself
   * was.
   *
   * Each pair below declares a different type against an id of some OTHER type,
   * so every branch of both switches is entered with a target that must be
   * refused. A skip keyed to any one type now fails.
   */
  const wrongPairs = [
    { declared: types.pool, id: ids.adx, label: 'pool-declared / adx id' },
    { declared: types.adx, id: ids.aas, label: 'adx-declared / aas id' },
    { declared: types.aas, id: ids.vmss, label: 'aas-declared / vmss id' },
    { declared: types.vmss, id: ids.pool, label: 'vmss-declared / pool id' },
  ];

  it('PAUSE refuses a mismatched target for EVERY declared type', async () => {
    const actuator = await createArmActuator();
    for (const { declared, id, label } of wrongPairs) {
      const bad = candidateFor('pool');
      const r = await actuator.pause({
        ...bad,
        resource: { ...bad.resource, resourceId: id, resourceType: declared },
      });
      expect(r.ok, label).toBe(false);
      expect(r.error, label).toMatch(/recorded type/);
    }
    // Nothing was mutated, for any of them.
    expect(armPost).not.toHaveBeenCalled();
    expect(armPatch).not.toHaveBeenCalled();
  });

  it('RESUME refuses a mismatched target for EVERY declared type', async () => {
    const actuator = await createArmActuator();
    for (const { declared, id, label } of wrongPairs) {
      const r = await actuator.resume(entryFor('pool', { resourceId: id, resourceType: declared }));
      expect(r.ok, label).toBe(false);
      expect(r.error, label).toMatch(/recorded type/);
    }
    expect(armPost).not.toHaveBeenCalled();
    expect(armPatch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// THE CONFIRM PATH — probeServable (review round 2, 2026-08-23)
// ===========================================================================

/**
 * `createArmActuator()` returns FIVE verbs. The first fix rewired four of them
 * to address `resourceId` and left `probeServable` using its `entry` argument
 * only for `entry.name` in message strings — the original defect, verbatim, on
 * the confirm path. A reviewer proved the gap by gutting the whole function to
 * `servable:true` and watching the full 258-test suite stay GREEN.
 *
 * These cases are per-verb and per-type, so a regression in ONE branch cannot
 * hide behind the other two.
 */
describe('probeServable — the CONFIRM path addresses the VERIFIED id too', () => {
  it('SYNAPSE probes the workspace+pool named by the ID, not the env-named pool', async () => {
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('pool'));
    expect(r.probed).toBe(true);
    expect(r.servable).toBe(true);
    // A gutted probe never calls the client at all, so this indexing is itself
    // the guard against "always return servable:true".
    const target = synapseExecuteQuery.mock.calls[0][0] as { server: string; database: string };
    expect(target.server).toBe('ws-verified.sql.azuresynapse.net');
    expect(target.database).toBe('pool-verified');
    expect(JSON.stringify(target)).not.toContain('FROM-ENV');
    expect(dedicatedTarget).not.toHaveBeenCalled();
  });

  it('ADX probes the cluster ID\'s OWN endpoint and OWN database', async () => {
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('adx'));
    expect(r.probed).toBe(true);
    expect(r.servable).toBe(true);
    const [db, kql, opts] = kustoExecuteQuery.mock.calls[0] as [string, string, { clusterUri: string }];
    // `adx-verified/loomdb` -> `loomdb`: the ARM child-name prefix is stripped,
    // never passed through as a database name.
    expect(db).toBe('loomdb');
    expect(kql).toContain('print');
    expect(opts.clusterUri).toBe('https://adx-verified.eastus2.kusto.windows.net');
    // kusto-client's module-level fallback is a HARD-CODED cluster and region.
    // Reaching it would probe a completely different cluster.
    expect(opts.clusterUri).not.toContain('adx-csa-loom-shared');
    // Every ARM read the probe made addressed the verified id.
    expect(armGet.mock.calls.length).toBeGreaterThan(0);
    for (const c of armGet.mock.calls) expect(String(c[0])).toContain(ids.adx);
  });

  it('AAS probes its OWN resource id, never the env-pinned server', async () => {
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('aas'));
    expect(r.probed).toBe(true);
    expect(r.servable).toBe(true);
    expect(listDatabases).not.toHaveBeenCalled();
    expect(armGet).toHaveBeenCalledWith(expect.stringContaining(`${ids.aas}/databases?`));
    for (const c of armGet.mock.calls) expect(String(c[0])).not.toContain('FROM-ENV');
    // R7 — the old string claimed "over XMLA" for what is an ARM control-plane
    // read. It must not claim a transport it did not use.
    expect(r.detail).not.toMatch(/XMLA/i);
  });

  it('reads NO env var to decide WHAT to probe — the id is the only input', async () => {
    // The removed `LOOM_KUSTO_DATABASE` was emitted by no bicep module and was
    // absent from the live console, so its branch was the DEFAULT on the real
    // estate: servable:false -> confirmation 'unknown' -> RESUME_FAILED for a
    // cluster that had resumed perfectly.
    // Indexed rather than spelled as `process.env.LOOM_*` on purpose: the
    // env-sync guard's read-detector is /process\.env\.(LOOM_[A-Z0-9_]+)/, so
    // naming them literally here would re-register LOOM_KUSTO_DATABASE as a
    // console READ and re-fail the very guard this change was made to satisfy.
    for (const k of ['LOOM_KUSTO_DATABASE', 'LOOM_AAS_SERVER_NAME', 'LOOM_AAS_REGION']) {
      delete process.env[k];
    }
    const actuator = await createArmActuator();
    for (const kind of ['pool', 'adx', 'aas'] as const) {
      const r = await actuator.probeServable(entryFor(kind));
      expect(r.probed, kind).toBe(true);
      expect(r.servable, kind).toBe(true);
    }
  });

  it('a probe whose id and recorded TYPE disagree is refused, and asks NOTHING', async () => {
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('pool', { resourceType: types.adx }));
    expect(r.servable).toBe(false);
    // `probed:false` — no request was issued, so nothing was established. This
    // must NOT read as "we asked and it said no".
    expect(r.probed).toBe(false);
    expect(r.detail).toMatch(/recorded type/);
    expect(synapseExecuteQuery).not.toHaveBeenCalled();
    expect(kustoExecuteQuery).not.toHaveBeenCalled();
  });

  it('an ADX cluster with no databases is honestly UNPROBED, never a fallback db', async () => {
    armGet.mockImplementation(async (url: unknown) =>
      (/\/databases\?/.test(String(url))
        ? { value: [] }
        : { properties: { state: 'Running', uri: 'https://adx-verified.eastus2.kusto.windows.net' } }));
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('adx'));
    expect(r.probed).toBe(false);
    expect(r.servable).toBe(false);
    expect(r.detail).toMatch(/no databases/i);
    // The critical part: it did NOT fall back to kusto-client's DEFAULT_DB.
    expect(kustoExecuteQuery).not.toHaveBeenCalled();
  });

  it('a failed round-trip is probed:true + servable:false — distinct from unprobed', async () => {
    synapseExecuteQuery.mockRejectedValueOnce(new Error('Login timeout expired'));
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('pool'));
    expect(r.probed).toBe(true);
    expect(r.servable).toBe(false);
    expect(r.detail).toContain('Login timeout expired');
  });

  it('a type with no probe wired reports UNPROBED, never a fabricated servable', async () => {
    const actuator = await createArmActuator();
    const r = await actuator.probeServable(entryFor('vmss'));
    expect(r.probed).toBe(false);
    expect(r.servable).toBe(false);
    expect(r.detail).toMatch(/NOT\s+established/i);
  });
});

// ===========================================================================
// THE BLOCKER-1 ARMING GATE
// ===========================================================================

describe(`${ESTATE_PAUSE_ENABLED_ENV} — the arming switch`, () => {
  /**
   * The env vars the platform bicep ACTUALLY sets, with the file:line the
   * independent review measured them at. This fixture is the merge risk.
   */
  const deployEnv = {
    LOOM_SUBSCRIPTION_ID: 'sub-a',              // admin-plane/main.bicep (5 files)
    LOOM_DLZ_RG: 'rg-loom-dlz',                 // (6 files) — the RG fallback for every type
    LOOM_SYNAPSE_RG: 'rg-loom',                 // LOOM_DLZ_RG (6 files)
    LOOM_SYNAPSE_WORKSPACE: 'syn-ws',           // (6 files)
    LOOM_SYNAPSE_DEDICATED_POOL: 'pool1',       // admin-plane/main.bicep:4138
    LOOM_KUSTO_RG: 'rg-loom',
    LOOM_KUSTO_CLUSTER_NAME: 'adx1',            // admin-plane/main.bicep:4769
    LOOM_AAS_RG: 'rg-loom',
    LOOM_AAS_SERVER_NAME: 'aas1',               // (2 files)
    LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss1',       // admin-plane/main.bicep:4374
    // LOOM_ESTATE_ID is the ONLY one nothing sets — and resolveEstateId()
    // synthesizes it deterministically, so its absence changes nothing.
  } as unknown as NodeJS.ProcessEnv;

  it('is OFF for an unset, empty, or non-affirmative value', () => {
    for (const v of [undefined, '', ' ', 'false', '0', 'no', 'maybe', 'TRUEISH']) {
      const env = (v === undefined ? {} : { [ESTATE_PAUSE_ENABLED_ENV]: v }) as NodeJS.ProcessEnv;
      expect(estatePauseEnabled(env), String(v)).toBe(false);
    }
  });

  it('is ON only for an explicit affirmative', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', ' true ']) {
      expect(estatePauseEnabled({ [ESTATE_PAUSE_ENABLED_ENV]: v } as unknown as NodeJS.ProcessEnv), v).toBe(true);
    }
  });

  it('THE BLOCKER: the deploy DOES name resources, and unarmed yields an EMPTY manifest', () => {
    const gated = resolveDeployManifest(deployEnv);
    // The env names FOUR real resources — roughly $3,000/mo of compute. This is
    // the merge risk the first version of this PR mis-stated as "nothing is
    // stamped by the platform today", which was true of the TAG and false of
    // the MANIFEST.
    expect(gated.namedByDeploy).toBe(4);
    expect(gated.entries).toHaveLength(4);
    expect(gated.unresolved).toEqual([]);
    // …and NONE of them is in the manifest that grants ownership.
    expect(gated.manifest.resourceIds).toEqual([]);
    expect(gated.manifestGated).toBe(true);
    expect(gated.gateReason).toContain(ESTATE_PAUSE_ENABLED_ENV);
    expect(gated.gateReason).toMatch(/NAMES 4 resource\(s\)/);
  });

  it('an estate id is SYNTHESIZED when LOOM_ESTATE_ID is unset — its absence gates nothing', () => {
    // The other half of the blocker: even with no LOOM_ESTATE_ID anywhere,
    // resolveEstateId() derives a stable one from sub+RG, so the manifest still
    // resolves. Only the arming switch stops it.
    const armed = resolveDeployManifest({ ...deployEnv, [ESTATE_PAUSE_ENABLED_ENV]: 'true' });
    expect(deployEnv.LOOM_ESTATE_ID).toBeUndefined();
    expect(armed.manifest.estateId).toBeTruthy();
    expect(armed.manifest.estateId).not.toBe('loom:unbound');
    expect(armed.manifest.resourceIds).toHaveLength(4);
  });

  it('ARMED, the same env yields the full manifest — the gate is the ONLY difference', () => {
    const armed = resolveDeployManifest({ ...deployEnv, [ESTATE_PAUSE_ENABLED_ENV]: 'true' });
    expect(armed.manifest.resourceIds).toHaveLength(4);
    expect(armed.manifestGated).toBe(false);
    expect(armed.gateReason).toBeUndefined();
    // Same entries either way: the gate withholds OWNERSHIP, it does not hide
    // the resources from the operator.
    expect(armed.entries.map((e) => e.resourceId).sort())
      .toEqual(resolveDeployManifest(deployEnv).entries.map((e) => e.resourceId).sort());
  });

  it('the gate reason states WHY, not merely THAT — no live receipt, R-CAP-2 missing', () => {
    const { gateReason } = resolveDeployManifest(deployEnv);
    expect(gateReason).toMatch(/no pause has ever been run against a live Azure resource/i);
    expect(gateReason).toMatch(/Wave 0/);
  });
});

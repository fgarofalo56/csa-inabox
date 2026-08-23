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
  armGet.mockResolvedValue({ tags: {}, properties: { state: 'Running' }, sku: { name: 'DW100c', capacity: 100 } });
  armPost.mockResolvedValue({});
  armPatch.mockResolvedValue({});
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

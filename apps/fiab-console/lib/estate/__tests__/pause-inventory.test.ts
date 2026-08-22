/**
 * ESTATE PAUSE/RESUME — inventory/scope tests.
 *
 * The two tests that matter most in this file:
 *
 *   1. `R-SCOPE-2 — the resource-group NAME trap` proves a `/loom/i` filter over
 *      RG names is wrong in BOTH directions on this real estate, and that the
 *      resolver gets both right. It carries an explicit CONTROL that runs the
 *      bad filter and asserts it produces the wrong answer — without that
 *      control the test could pass against a resolver that happened to agree
 *      with the name filter, and would not be watching anything.
 *
 *   2. `fail-safe` proves an ERRORED tag lookup classifies the resource as
 *      NOT pausable — left RUNNING — and never as pausable.
 *
 * All ids in this file are obviously-fake placeholders. Resource-group names are
 * the real measured ones because the whole point of the trap test is that these
 * specific names defeat a name filter; RG names are not secrets.
 */
import { describe, it, expect } from 'vitest';
import {
  LOOM_ESTATE_TAG_KEY,
  LOOM_ITEM_TAG_KEY,
  PAUSABLE_RESOURCE_TYPES,
  assertExplicitScope,
  buildPauseInventory,
  dryRunPause,
  pausableTypeSpec,
  resolveOwnership,
  reverifyBeforeAct,
  type DeployManifest,
  type DiscoveredResource,
  type PauseScope,
} from '../pause-inventory';

// Obviously-fake placeholder subscriptions. NOT real ids.
const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';
const ESTATE = 'loom-commercial-centralus';
const OTHER_ESTATE = 'loom-someone-elses-estate';

const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };

function res(p: {
  name: string;
  rg: string;
  type: string;
  sub?: string;
  tags?: Record<string, string> | null;
  tagsError?: string;
}): DiscoveredResource {
  const sub = p.sub ?? SUB_A;
  return {
    resourceId: `/subscriptions/${sub}/resourceGroups/${p.rg}/providers/${p.type}/${p.name}`,
    resourceType: p.type,
    name: p.name,
    resourceGroup: p.rg,
    subscriptionId: sub,
    location: 'centralus',
    tags: p.tags === undefined ? {} : p.tags,
    ...(p.tagsError ? { tagsError: p.tagsError } : {}),
    discoverySource: 'resource-graph',
  };
}

/** Tagged as belonging to THIS estate. */
function loomTags(extra: Record<string, string> = {}): Record<string, string> {
  return { [LOOM_ESTATE_TAG_KEY]: ESTATE, ...extra };
}

// ---------------------------------------------------------------------------
// The measured estate: 23 pausable-type resources, 11 Loom's, 12 unrelated
// across 10 resource groups (measured 2026-08-22, Commercial).
// ---------------------------------------------------------------------------

/** The 11 genuinely Loom-owned resources. */
const LOOM_RESOURCES: DiscoveredResource[] = [
  res({ name: 'ca-loom-console', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.App/containerApps', tags: loomTags() }),
  res({ name: 'ca-loom-copilot', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.App/containerApps', tags: loomTags() }),
  res({ name: 'ca-loom-weave', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.App/containerApps', tags: loomTags() }),
  res({ name: 'aas-loom-semantic', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.AnalysisServices/servers', tags: loomTags() }),
  res({ name: 'loompool', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.Synapse/workspaces/sqlPools', tags: loomTags() }),
  res({ name: 'adx-loom-default', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.Kusto/clusters', tags: loomTags() }),
  res({ name: 'vmss-loom-shir-default', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.Compute/virtualMachineScaleSets', tags: loomTags() }),
  res({ name: 'asa-loom-eventstream', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.StreamAnalytics/streamingJobs', tags: loomTags() }),
  res({ name: 'ca-loom-dbt-runner', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.App/containerApps', tags: loomTags() }),
  res({ name: 'ca-loom-direct-lake-shim', rg: 'rg-csa-loom-dlz-default-centralus', type: 'Microsoft.App/containerApps', tags: loomTags() }),
  // ── THE TRAP ────────────────────────────────────────────────────────────
  // A genuine Loom component living in a resource group with NO "loom" in its
  // name. A /loom/i RG-name filter MISSES this and would leave a real Loom
  // resource running (or, on the resume side, never restore it).
  res({
    name: 'func-csa-inabox-copilot-fg',
    rg: 'rg-dlz-aiml-stack-dev',
    type: 'Microsoft.Web/sites',
    tags: loomTags({ [LOOM_ITEM_TAG_KEY]: 'item-placeholder-0001' }),
  }),
];

/**
 * The 12 unrelated resources, across 10 resource groups. Every one of these
 * would be stopped by a subscription-scoped pause. None carries a Loom tag.
 *
 * Note `rg-dlz-aiml-stack-dev` appears in BOTH lists: it is a MIXED resource
 * group. That kills resource-group-level scoping too, not just name matching.
 */
const UNRELATED_RESOURCES: DiscoveredResource[] = [
  res({ name: 'ca-blog-web', rg: 'rg-limitlessdata-blog', type: 'Microsoft.App/containerApps' }),
  res({ name: 'vm-sentinel-hunt', rg: 'sentinel-dev-rg', type: 'Microsoft.Compute/virtualMachines' }),
  res({ name: 'vmss-sentinel-agents', rg: 'sentinel-dev-rg', type: 'Microsoft.Compute/virtualMachineScaleSets' }),
  res({ name: 'ca-atlasdiag-api', rg: 'atlasdiag-rg', type: 'Microsoft.App/containerApps' }),
  res({ name: 'ca-renderix-worker', rg: 'rg-atlas-renderix-dev-eastus2', type: 'Microsoft.App/containerApps', sub: SUB_B }),
  res({ name: 'ca-forzelite-api', rg: 'rg-forzelite-dev-eastus2', type: 'Microsoft.App/containerApps', sub: SUB_B }),
  res({ name: 'vmss-gh-runner-nasa', rg: 'rg-ghrunner-nasa-poc', type: 'Microsoft.Compute/virtualMachineScaleSets' }),
  res({ name: 'vm-hana-sandbox-01', rg: 'rg-sandbox-demo-east2', type: 'Microsoft.Compute/virtualMachines', sub: SUB_B }),
  res({ name: 'vm-hana-sandbox-02', rg: 'rg-sandbox-demo-east2', type: 'Microsoft.Compute/virtualMachines', sub: SUB_B }),
  res({ name: 'ca-simplechat-web', rg: 'rg-simplechat-dev', type: 'Microsoft.App/containerApps' }),
  res({ name: 'vm-artemis-poc', rg: 'artemis-poc-rg', type: 'Microsoft.Compute/virtualMachines' }),
  res({ name: 'vm-aiml-training-node', rg: 'rg-dlz-aiml-stack-dev', type: 'Microsoft.Compute/virtualMachines' }),
];

const MEASURED_ESTATE: DiscoveredResource[] = [...LOOM_RESOURCES, ...UNRELATED_RESOURCES];

describe('the measured 2026-08-22 estate', () => {
  it('is the shape the scope rules exist for: 23 resources, 12 of them unrelated across 10 RGs', () => {
    expect(MEASURED_ESTATE).toHaveLength(23);
    expect(UNRELATED_RESOURCES).toHaveLength(12);
    expect(new Set(UNRELATED_RESOURCES.map((r) => r.resourceGroup)).size).toBe(10);
  });

  it('pauses exactly the 11 Loom resources and leaves all 12 unrelated ones running', () => {
    const inv = buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE });
    expect(inv.pausable).toHaveLength(11);
    expect(inv.excluded).toHaveLength(12);

    const pausedNames = inv.pausable.map((c) => c.resource.name).sort();
    expect(pausedNames).toEqual(LOOM_RESOURCES.map((r) => r.name).sort());

    // Not one unrelated resource is in the act-on set.
    for (const u of UNRELATED_RESOURCES) {
      expect(pausedNames).not.toContain(u.name);
    }
  });

  it('names the blast radius a subscription-wide pause would have had (R-SCOPE-1)', () => {
    const dry = dryRunPause(buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE }));
    // The blog, the Sentinel dev estate, the Atlas estates, the NASA PoC runner
    // and the SAP HANA sandbox are all explicitly left alone.
    const spared = dry.wouldLeaveRunning.map((r) => r.name);
    for (const name of [
      'ca-blog-web',
      'vm-sentinel-hunt',
      'ca-atlasdiag-api',
      'ca-renderix-worker',
      'vmss-gh-runner-nasa',
      'vm-hana-sandbox-01',
    ]) {
      expect(spared).toContain(name);
    }
    expect(dry.summary).toMatch(/Would pause 11 Loom-owned resource\(s\)/);
    expect(dry.summary).toMatch(/12 resource\(s\) across 10 resource group\(s\)/);
  });

  it('classifies every discovered resource — nothing is silently dropped', () => {
    const inv = buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE });
    expect(inv.pausable.length + inv.excluded.length).toBe(MEASURED_ESTATE.length);
    const seen = [
      ...inv.pausable.map((c) => c.resource.resourceId),
      ...inv.excluded.map((e) => e.resource.resourceId),
    ];
    expect(new Set(seen).size).toBe(MEASURED_ESTATE.length);
  });
});

// ---------------------------------------------------------------------------
// R-SCOPE-2 — THE RESOURCE-GROUP NAME TRAP. The most important test here.
// ---------------------------------------------------------------------------

describe('R-SCOPE-2 — the resource-group NAME trap', () => {
  /** Loom-owned, and its RG name contains no "loom". A name filter MISSES it. */
  const loomInNonLoomRg = res({
    name: 'func-csa-inabox-copilot-fg',
    rg: 'rg-dlz-aiml-stack-dev',
    type: 'Microsoft.Web/sites',
    tags: loomTags(),
  });

  /** NOT Loom's, and its RG name DOES contain "loom". A name filter TEARS IT DOWN. */
  const decoyLoomNamedRg = res({
    name: 'ca-loomis-quotes-api',
    rg: 'rg-loomis-analytics-prod',
    type: 'Microsoft.App/containerApps',
    tags: { owner: 'loomis-analytics', costCenter: 'CC-4417' },
  });

  const trapSet = [loomInNonLoomRg, decoyLoomNamedRg];

  it('CONTROL: a /loom/i resource-group-name filter gets BOTH of these wrong', () => {
    // This control is the reason the assertions below mean something. It runs
    // the exact heuristic R-SCOPE-2 forbids and shows it is wrong in both
    // directions on this data — so a resolver that merely agreed with the name
    // filter could not pass the next two tests.
    const nameFilter = (r: DiscoveredResource) => /loom/i.test(r.resourceGroup);

    // FALSE NEGATIVE: misses a genuine Loom resource.
    expect(nameFilter(loomInNonLoomRg)).toBe(false);
    // FALSE POSITIVE: claims someone else's resource.
    expect(nameFilter(decoyLoomNamedRg)).toBe(true);
  });

  it('classifies the Loom resource in rg-dlz-aiml-stack-dev as Loom-owned', () => {
    const own = resolveOwnership(loomInNonLoomRg, { estateId: ESTATE });
    expect(own.verdict).toBe('loom-owned');
    expect(own.tagKey).toBe(LOOM_ESTATE_TAG_KEY);
    expect(own.tagValue).toBe(ESTATE);
  });

  it('classifies the "loom"-named decoy RG as NOT Loom-owned', () => {
    const own = resolveOwnership(decoyLoomNamedRg, { estateId: ESTATE });
    expect(own.verdict).toBe('not-loom-owned');
    expect(own.reason).toMatch(/resource-group NAME is deliberately not consulted/);
  });

  it('the inventory acts on the trap resource and spares the decoy — the opposite of the name filter', () => {
    const inv = buildPauseInventory(trapSet, { scope: SCOPE });
    expect(inv.pausable.map((c) => c.resource.name)).toEqual(['func-csa-inabox-copilot-fg']);
    expect(inv.excluded.map((e) => e.resource.name)).toEqual(['ca-loomis-quotes-api']);
    expect(inv.excluded[0].kind).toBe('not-loom-owned');
  });

  it('the same resource flips verdict with the TAG, not with the RG name', () => {
    // Same RG name in both arms; only the tag differs. If ownership were name-
    // derived, these two would agree — they must not.
    const untagged = res({ name: 'x', rg: 'rg-dlz-aiml-stack-dev', type: 'Microsoft.App/containerApps', tags: {} });
    const tagged = res({ name: 'x', rg: 'rg-dlz-aiml-stack-dev', type: 'Microsoft.App/containerApps', tags: loomTags() });
    expect(resolveOwnership(untagged, { estateId: ESTATE }).verdict).toBe('not-loom-owned');
    expect(resolveOwnership(tagged, { estateId: ESTATE }).verdict).toBe('loom-owned');

    // And symmetrically inside a "loom"-named RG: the name buys nothing.
    const untaggedInLoomRg = res({ name: 'y', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.App/containerApps', tags: {} });
    expect(resolveOwnership(untaggedInLoomRg, { estateId: ESTATE }).verdict).toBe('not-loom-owned');
  });
});

// ---------------------------------------------------------------------------
// FAIL-SAFE — an errored lookup leaves the resource RUNNING
// ---------------------------------------------------------------------------

describe('fail-safe: uncertainty never becomes pausable', () => {
  const unreadable = res({
    name: 'ca-loom-console',
    rg: 'rg-csa-loom-admin-centralus',
    type: 'Microsoft.App/containerApps',
    tags: null,
    tagsError: 'AuthorizationFailed: the console identity cannot read tags on this resource',
  });

  it('an errored tag lookup is INDETERMINATE, not "no tags"', () => {
    const own = resolveOwnership(unreadable, { estateId: ESTATE });
    expect(own.verdict).toBe('indeterminate');
    expect(own.verdict).not.toBe('loom-owned');
    expect(own.reason).toMatch(/AuthorizationFailed/);
    expect(own.reason).toMatch(/left running \(fail-safe\)/);
  });

  it('an indeterminate resource is EXCLUDED from the pause set', () => {
    const inv = buildPauseInventory([unreadable], { scope: SCOPE });
    expect(inv.pausable).toHaveLength(0);
    expect(inv.excluded).toHaveLength(1);
    expect(inv.excluded[0].kind).toBe('ownership-indeterminate');
    expect(dryRunPause(inv).wouldPause).toHaveLength(0);
  });

  it('re-verify: a reader that THROWS refuses to proceed (R-SCOPE-3)', async () => {
    const inv = buildPauseInventory(LOOM_RESOURCES, { scope: SCOPE });
    const candidate = inv.pausable[0];
    const verdict = await reverifyBeforeAct(
      candidate,
      async () => {
        throw new Error('ARM returned 429 TooManyRequests');
      },
      { estateId: ESTATE },
    );
    expect(verdict.proceed).toBe(false);
    expect(verdict.ownership.verdict).toBe('indeterminate');
    expect(verdict.reason).toMatch(/429 TooManyRequests/);
    expect(verdict.reason).toMatch(/Leaving it RUNNING/);
  });

  it('re-verify: a reader that returns NO tags refuses to proceed', async () => {
    const inv = buildPauseInventory(LOOM_RESOURCES, { scope: SCOPE });
    const verdict = await reverifyBeforeAct(inv.pausable[0], async () => null, { estateId: ESTATE });
    expect(verdict.proceed).toBe(false);
    expect(verdict.ownership.verdict).toBe('indeterminate');
  });

  it('re-verify: the tag having been REMOVED since discovery refuses to proceed', async () => {
    const inv = buildPauseInventory(LOOM_RESOURCES, { scope: SCOPE });
    // Discovery saw the estate tag; by act time it is gone (re-created resource,
    // re-tagged estate, or an operator excluding it deliberately).
    const verdict = await reverifyBeforeAct(inv.pausable[0], async () => ({ owner: 'someone-else' }), {
      estateId: ESTATE,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.ownership.verdict).toBe('not-loom-owned');
  });

  it('re-verify: an unchanged, still-tagged resource DOES proceed (the control)', async () => {
    // Without this arm the four refusals above are satisfied by a function that
    // always returns false.
    const inv = buildPauseInventory(LOOM_RESOURCES, { scope: SCOPE });
    const verdict = await reverifyBeforeAct(inv.pausable[0], async () => loomTags(), {
      estateId: ESTATE,
    });
    expect(verdict.proceed).toBe(true);
    expect(verdict.ownership.verdict).toBe('loom-owned');
  });
});

// ---------------------------------------------------------------------------
// R-SCOPE-1 — never scope by subscription
// ---------------------------------------------------------------------------

describe('R-SCOPE-1 — the pause set is an explicit inventory', () => {
  it('refuses a subscription-wide scope by name', () => {
    expect(() => assertExplicitScope({ kind: 'subscription', subscriptionId: SUB_A })).toThrow(
      /Pause scope kind 'subscription' is refused/,
    );
  });

  it('refuses resource-group and tenant scopes too', () => {
    expect(() => assertExplicitScope({ kind: 'resource-group', estateId: ESTATE })).toThrow(/refused/);
    expect(() => assertExplicitScope({ kind: 'tenant', estateId: ESTATE })).toThrow(/refused/);
  });

  it('refuses a missing scope and a scope with no estateId', () => {
    expect(() => assertExplicitScope(undefined)).toThrow(/Pause scope is missing/);
    expect(() => assertExplicitScope({ kind: 'explicit-inventory' })).toThrow(/no estateId/);
  });

  it('accepts an explicit inventory scope', () => {
    expect(() => assertExplicitScope(SCOPE)).not.toThrow();
  });

  it('a resource in the same subscription is NOT thereby in scope', () => {
    // Every unrelated resource in SUB_A shares a subscription with Loom's.
    const sameSubUnrelated = UNRELATED_RESOURCES.filter((r) => r.subscriptionId === SUB_A);
    expect(sameSubUnrelated.length).toBeGreaterThan(0);
    const inv = buildPauseInventory(sameSubUnrelated, { scope: SCOPE });
    expect(inv.pausable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ownership sources and multi-estate safety
// ---------------------------------------------------------------------------

describe('ownership resolution', () => {
  it('a DIFFERENT Loom estate is positively not ours', () => {
    const other = res({
      name: 'ca-other-loom-console',
      rg: 'rg-csa-loom-admin-eastus',
      type: 'Microsoft.App/containerApps',
      tags: { [LOOM_ESTATE_TAG_KEY]: OTHER_ESTATE },
    });
    const own = resolveOwnership(other, { estateId: ESTATE });
    expect(own.verdict).toBe('not-loom-owned');
    expect(own.reason).toMatch(/DIFFERENT Loom estate/);
    expect(buildPauseInventory([other], { scope: SCOPE }).pausable).toHaveLength(0);
  });

  it('a deploy manifest is a valid membership source when the tag is absent', () => {
    const untagged = res({ name: 'ca-loom-legacy', rg: 'rg-anything', type: 'Microsoft.App/containerApps', tags: {} });
    const manifest: DeployManifest = { estateId: ESTATE, resourceIds: [untagged.resourceId.toUpperCase()] };
    const own = resolveOwnership(untagged, { estateId: ESTATE, manifest });
    expect(own.verdict).toBe('loom-owned');
    expect(own.source).toBe('deploy-manifest');
  });

  it('a manifest belonging to another estate confers nothing', () => {
    const untagged = res({ name: 'ca-loom-legacy', rg: 'rg-anything', type: 'Microsoft.App/containerApps', tags: {} });
    const manifest: DeployManifest = { estateId: OTHER_ESTATE, resourceIds: [untagged.resourceId] };
    expect(resolveOwnership(untagged, { estateId: ESTATE, manifest }).verdict).toBe('not-loom-owned');
  });

  it('tag keys match case-insensitively, as ARM treats them', () => {
    const odd = res({
      name: 'ca-loom-x',
      rg: 'rg-x',
      type: 'Microsoft.App/containerApps',
      tags: { 'LOOM-Estate-Id': ESTATE },
    });
    expect(resolveOwnership(odd, { estateId: ESTATE }).verdict).toBe('loom-owned');
  });

  it('a per-item tag with no conflicting estate tag is Loom-owned', () => {
    const item = res({
      name: 'ca-loom-item',
      rg: 'rg-x',
      type: 'Microsoft.App/containerApps',
      tags: { [LOOM_ITEM_TAG_KEY]: 'item-placeholder-0002' },
    });
    const own = resolveOwnership(item, { estateId: ESTATE });
    expect(own.verdict).toBe('loom-owned');
    expect(own.tagKey).toBe(LOOM_ITEM_TAG_KEY);
  });

  it('a per-item tag does NOT override another estate\'s estate tag', () => {
    const conflicted = res({
      name: 'ca-loom-item',
      rg: 'rg-x',
      type: 'Microsoft.App/containerApps',
      tags: { [LOOM_ESTATE_TAG_KEY]: OTHER_ESTATE, [LOOM_ITEM_TAG_KEY]: 'item-placeholder-0003' },
    });
    expect(resolveOwnership(conflicted, { estateId: ESTATE }).verdict).toBe('not-loom-owned');
  });
});

// ---------------------------------------------------------------------------
// Pausable-type registry, R-CAP-1 fallbacks, and the §3c type enforcement
// ---------------------------------------------------------------------------

describe('pausable-type registry', () => {
  it('every capacity-constrained type declares a fallback SKU (R-CAP-1)', () => {
    const missing = Object.values(PAUSABLE_RESOURCE_TYPES)
      .filter((s) => s.capacityConstrained && !s.fallbackSku)
      .map((s) => s.resourceType);
    expect(missing).toEqual([]);
  });

  it('every fallback SKU carries an operator-facing reason', () => {
    for (const spec of Object.values(PAUSABLE_RESOURCE_TYPES)) {
      if (spec.fallbackSku) expect(spec.fallbackSku.reason.length).toBeGreaterThan(20);
    }
  });

  it('every spec declares the ARM api-version its power-state read uses', () => {
    for (const spec of Object.values(PAUSABLE_RESOURCE_TYPES)) {
      expect(spec.armApiVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('an unregistered type is not pausable, even when Loom-owned', () => {
    expect(pausableTypeSpec('Microsoft.Storage/storageAccounts')).toBeNull();
    const storage = res({
      name: 'stloomdefault',
      rg: 'rg-csa-loom-dlz-default-centralus',
      type: 'Microsoft.Storage/storageAccounts',
      tags: loomTags(),
    });
    const inv = buildPauseInventory([storage], { scope: SCOPE });
    expect(inv.pausable).toHaveLength(0);
    expect(inv.excluded[0].kind).toBe('type-not-pausable');
    expect(inv.excluded[0].ownership.verdict).toBe('loom-owned');
  });

  it('type lookup is case-insensitive on the ARM type', () => {
    expect(pausableTypeSpec('MICROSOFT.SYNAPSE/WORKSPACES/SQLPOOLS')?.mechanism).toBe('arm-pause-action');
  });
});

describe('PRP §3c — discovery carries no usable power state', () => {
  it('a DiscoveredResource has no power-state value at runtime', () => {
    const r = LOOM_RESOURCES[0];
    expect(r.powerState).toBeUndefined();
    expect(Object.keys(r)).not.toContain('powerState');
  });

  it('assigning a power state to a discovery row is a COMPILE error', () => {
    // The @ts-expect-error below is the assertion. NOTE the explicit
    // `: DiscoveredResource` annotation — without it the literal's type is
    // INFERRED, excess-property checking never runs against DiscoveredResource,
    // and the directive is unused (tsc TS2578, which is how the first version of
    // this test was caught). If `powerState` ever becomes assignable (someone
    // drops the `?: never`), this directive has nothing to suppress and `tsc`
    // fails on THIS LINE — so the type-level guard cannot be removed silently.
    const bad: DiscoveredResource = {
      ...LOOM_RESOURCES[0],
      // @ts-expect-error - powerState is `never`: Resource Graph is not authoritative for state.
      powerState: 'Online',
    };
    expect(bad).toBeTruthy();
  });
});

describe('dryRunPause (R-SCOPE-4)', () => {
  it('returns exactly what would be acted on, each row with its owning tag', () => {
    const dry = dryRunPause(buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE }));
    expect(dry.wouldPause).toHaveLength(11);
    for (const row of dry.wouldPause) {
      expect(row.ownershipSource).not.toBe('none');
      expect(row.owningTagKey).toBe(LOOM_ESTATE_TAG_KEY);
      expect(row.owningTagValue).toBe(ESTATE);
      expect(row.ownershipReason).toBeTruthy();
      expect(row.mechanism).toBeTruthy();
    }
  });

  it('carries the declared fallback SKU for capacity-constrained rows', () => {
    const dry = dryRunPause(buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE }));
    const pool = dry.wouldPause.find((r) => r.name === 'loompool')!;
    expect(pool.fallbackSku?.name).toBe('DW100c');
    expect(pool.fallbackSku?.reason).toMatch(/smallest service level/);

    // Serverless rows carry none — a fallback there would be meaningless.
    const app = dry.wouldPause.find((r) => r.name === 'ca-loom-console')!;
    expect(app.fallbackSku).toBeUndefined();
  });

  it('lists every left-alone resource with a reason — no silent omissions', () => {
    const dry = dryRunPause(buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE }));
    expect(dry.wouldLeaveRunning).toHaveLength(12);
    for (const row of dry.wouldLeaveRunning) {
      expect(row.reason.length).toBeGreaterThan(20);
      expect(row.kind).toBeTruthy();
    }
  });

  it('changes nothing — it is a projection of the inventory', () => {
    const inv = buildPauseInventory(MEASURED_ESTATE, { scope: SCOPE });
    const before = JSON.stringify(inv);
    dryRunPause(inv);
    expect(JSON.stringify(inv)).toBe(before);
  });
});

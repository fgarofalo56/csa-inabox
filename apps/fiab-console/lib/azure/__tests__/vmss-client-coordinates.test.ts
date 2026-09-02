/**
 * #4248 — the SHIR SCALING surface must address the same VM scale set the
 * deploy actually created.
 *
 * ── WHAT THIS IS GUARDING ──────────────────────────────────────────────────
 * `vmss-client` is the engine behind the Manage-hub IR metrics tile, the
 * Scale & manage drawer, the Purview scan pre-scale, and the idle-stop
 * workflow. Two of its verbs MUTATE: `scaleVmss` PATCHes `sku.capacity`, and
 * `ensureShirUp` calls it. So an id composed from the wrong coordinates does
 * not merely 404 — if a same-named scale set happens to exist in the assumed
 * resource group, it scales SOMEONE ELSE'S machine.
 *
 * Before this fix both resolvers took a VMSS **name** from one deployment and
 * a **home** from another's assumptions:
 *
 *     purviewShirVmssConfig  name LOOM_PURVIEW_SHIR_VMSS_NAME
 *                              rg LOOM_ADMIN_RG          (assumed)
 *                             sub LOOM_SUBSCRIPTION_ID   (assumed, no fallback)
 *     shirVmssConfig         name LOOM_SHIR_VMSS_NAME    (a DLZ resource)
 *                             sub LOOM_SUBSCRIPTION_ID   (the ADMIN sub, always)
 *
 * That is the mismatched-coordinates family that produced the deterministic
 * ARM 404 in the estate-pause manifest (#4243). PR #4247 fixed the pause path
 * and made the admin-plane bicep emit the authoritative coordinates
 * (LOOM_PURVIEW_SHIR_RG / LOOM_SHIR_SUB); this file proves the scaling surface
 * now reads them, with the SAME fallback order the pause path uses.
 *
 * ── THE MUTATIONS THESE TESTS ARE CALIBRATED AGAINST ───────────────────────
 * Each `describe` below names the exact source deletion that turns it red. The
 * mutation receipt in the PR body records the runs and their RCs. A guard that
 * stays green when its subject is deleted is the defect, not the fix.
 *
 * No network: `fetch-with-timeout` is mocked, and the two refusal cases assert
 * it was never called at all — "no ARM request was sent" is the claim the
 * error string makes (deploy-integrity R7), so the test measures it.
 *
 * No AUTH either, and mocking the fetch alone does NOT get you that: `armFetch`
 * builds its header object with `` `Bearer ${await token()}` ``, and JS evaluates
 * that argument BEFORE it calls `fetchWithTimeout`. So every case that gets past
 * the refusal and reaches the wire would acquire a REAL token — on a CI runner
 * that is a `DefaultAzureCredential` walking its whole chain to an
 * `AggregateAuthenticationError`, and the resolving cases below fail. Hence the
 * `@azure/identity` stub, the same one `scaling-routes.test.ts` (the other suite
 * that drives this module) and ~148 sibling suites under this directory use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

import {
  assertVmssTarget,
  purviewShirVmssConfig,
  scaleVmss,
  shirVmssConfig,
  VmssError,
  getVmssStatus,
  type VmssConfig,
} from '@/lib/azure/vmss-client';
import { resolveDeployManifest } from '@/lib/estate/pause-orchestrator';

const VMSS_PROVIDER = 'providers/Microsoft.Compute/virtualMachineScaleSets';
const id = (sub: string, rg: string, name: string) =>
  `/subscriptions/${sub}/resourceGroups/${rg}/${VMSS_PROVIDER}/${name}`;

/** Every env key either resolver or the pause manifest reads for a SHIR. */
const ENV_KEYS = [
  'LOOM_SUBSCRIPTION_ID',
  'LOOM_ADMIN_RG',
  'LOOM_DLZ_RG',
  'LOOM_DLZ_SUBSCRIPTION_ID',
  'LOOM_DLZ_SUB',
  'LOOM_SHIR_SUB',
  'LOOM_PURVIEW_SHIR_RG',
  'LOOM_PURVIEW_SHIR_VMSS_NAME',
  'LOOM_SHIR_VMSS_NAME',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchWithTimeout.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// The admin-plane bicep emits LOOM_SUBSCRIPTION_ID + LOOM_ADMIN_RG on every
// estate, so every fixture carries them — which is exactly what makes the old
// code's silent wrong answer possible: it never had a reason to return null.
const base = {
  LOOM_SUBSCRIPTION_ID: 'admin-sub',
  LOOM_ADMIN_RG: 'rg-admin',
} as unknown as NodeJS.ProcessEnv;

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 purviewShirVmssConfig — the Purview SHIR resolves with ITS OWN home', () => {
  it('prefers the deploy-produced LOOM_PURVIEW_SHIR_RG over the assumed LOOM_ADMIN_RG', () => {
    // MUTATION TARGET: delete the `v(env,'LOOM_PURVIEW_SHIR_RG') ||` prefix and
    // this returns rg-admin — the pre-fix answer, and a guaranteed 404 (or a
    // PATCH against a stranger) on any estate that places the SHIR elsewhere.
    const cfg = purviewShirVmssConfig({
      ...base,
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-loom-pvw-shir-default',
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
      LOOM_SHIR_SUB: 'shir-sub',
    });
    expect(cfg).toEqual({
      subscriptionId: 'shir-sub',
      resourceGroup: 'rg-purview-shir',
      name: 'vmss-loom-pvw-shir-default',
    });
  });

  it('prefers the deploy-produced LOOM_SHIR_SUB over the assumed LOOM_SUBSCRIPTION_ID', () => {
    // MUTATION TARGET: delete the `v(env,'LOOM_SHIR_SUB') ||` prefix → 'admin-sub'.
    const cfg = purviewShirVmssConfig({
      ...base,
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw',
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
      LOOM_SHIR_SUB: 'shir-sub',
    });
    expect(cfg!.subscriptionId).toBe('shir-sub');
    expect(cfg!.subscriptionId).not.toBe('admin-sub');
  });

  it('falls back to LOOM_ADMIN_RG + LOOM_SUBSCRIPTION_ID when the deploy emitted neither', () => {
    // The brownfield-override shape: LOOM_PURVIEW_SHIR_VMSS_NAME names an
    // EXISTING VMSS, so purviewShirDeployed was false and the bicep bound both
    // coordinate vars to ''. The old pair is the only information available and
    // remains the honest fallback — this case must stay green. It is MARKED,
    // though: the name has external provenance and the RG is this template's,
    // assumed, which scaleVmss refuses (see the mutating-path describe below).
    const cfg = purviewShirVmssConfig({ ...base, LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw' });
    expect(cfg).toEqual({
      subscriptionId: 'admin-sub',
      resourceGroup: 'rg-admin',
      name: 'vmss-pvw',
      resourceGroupAssumed: true,
    });
  });

  it('never lets LOOM_DLZ_RG leak into the Purview SHIR id', () => {
    // The name-from-one-VMSS + RG-from-the-other mix is the measured #4243 404.
    const cfg = purviewShirVmssConfig({
      ...base,
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
    });
    expect(cfg!.resourceGroup).toBe('rg-admin');
    expect(cfg!.subscriptionId).toBe('admin-sub');
  });

  it('returns null (honest gate) when the estate does not name a Purview SHIR', () => {
    expect(purviewShirVmssConfig({ ...base })).toBeNull();
  });

  it('treats an all-whitespace coordinate as ABSENT, not as a value', () => {
    // MUTATION TARGET: drop `.trim()` from `v()` and LOOM_PURVIEW_SHIR_RG=' '
    // wins the `||` chain, composing `/resourceGroups/ /` — a path ARM answers
    // with a generic error naming neither the value nor this deployment.
    const cfg = purviewShirVmssConfig({
      ...base,
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw',
      LOOM_PURVIEW_SHIR_RG: '   ',
      LOOM_SHIR_SUB: '\t',
    });
    expect(cfg).toEqual({
      subscriptionId: 'admin-sub',
      resourceGroup: 'rg-admin',
      name: 'vmss-pvw',
      resourceGroupAssumed: true,
    });
  });

  it('reads process.env by default, so the zero-arg callers get the same chain', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'admin-sub';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    process.env.LOOM_PURVIEW_SHIR_VMSS_NAME = 'vmss-pvw';
    process.env.LOOM_PURVIEW_SHIR_RG = 'rg-purview-shir';
    process.env.LOOM_SHIR_SUB = 'shir-sub';
    expect(purviewShirVmssConfig()).toEqual({
      subscriptionId: 'shir-sub',
      resourceGroup: 'rg-purview-shir',
      name: 'vmss-pvw',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 shirVmssConfig — the DLZ ADF SHIR resolves in the DLZ subscription', () => {
  it('uses LOOM_DLZ_SUBSCRIPTION_ID, not the admin sub, on a multi-sub estate', () => {
    // MUTATION TARGET: collapse the chain back to `v(env,'LOOM_SUBSCRIPTION_ID')`
    // and this returns admin-sub — the pre-fix answer. The DLZ RG lives in the
    // DLZ sub, so that pair is the measured ResourceGroupNotFound shape.
    const cfg = shirVmssConfig({
      ...base,
      LOOM_SHIR_VMSS_NAME: 'vmss-loom-shir-default',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
    });
    expect(cfg).toEqual({
      subscriptionId: 'dlz-sub',
      resourceGroup: 'rg-dlz',
      name: 'vmss-loom-shir-default',
    });
  });

  it('honours the legacy LOOM_DLZ_SUB alias a partially-migrated deploy still emits', () => {
    // MUTATION TARGET: delete the `|| v(env,'LOOM_DLZ_SUB')` link → admin-sub.
    const cfg = shirVmssConfig({
      ...base,
      LOOM_SHIR_VMSS_NAME: 'vmss-shir',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_DLZ_SUB: 'legacy-dlz-sub',
    });
    expect(cfg!.subscriptionId).toBe('legacy-dlz-sub');
  });

  it('ranks the chain LOOM_SHIR_SUB > LOOM_DLZ_SUBSCRIPTION_ID > LOOM_DLZ_SUB > LOOM_SUBSCRIPTION_ID', () => {
    // Order, not merely membership: peel one var off at a time and assert the
    // NEXT one wins. Reordering any two links turns one of these four red.
    const full = {
      ...base,
      LOOM_SHIR_VMSS_NAME: 'vmss-shir',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_SHIR_SUB: 'shir-sub',
      LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
      LOOM_DLZ_SUB: 'legacy-dlz-sub',
    } as unknown as NodeJS.ProcessEnv;
    const { LOOM_SHIR_SUB: _s, ...noShirSub } = full as Record<string, string>;
    const { LOOM_DLZ_SUBSCRIPTION_ID: _d, ...noDlzSubId } = noShirSub;
    const { LOOM_DLZ_SUB: _l, ...noneOfThem } = noDlzSubId;
    expect(shirVmssConfig(full)!.subscriptionId).toBe('shir-sub');
    expect(shirVmssConfig(noShirSub as NodeJS.ProcessEnv)!.subscriptionId).toBe('dlz-sub');
    expect(shirVmssConfig(noDlzSubId as NodeJS.ProcessEnv)!.subscriptionId).toBe('legacy-dlz-sub');
    expect(shirVmssConfig(noneOfThem as NodeJS.ProcessEnv)!.subscriptionId).toBe('admin-sub');
  });

  it('single-sub estate: falls back to LOOM_SUBSCRIPTION_ID when no DLZ sub var exists', () => {
    const cfg = shirVmssConfig({ ...base, LOOM_SHIR_VMSS_NAME: 'vmss-shir', LOOM_DLZ_RG: 'rg-dlz' });
    expect(cfg!.subscriptionId).toBe('admin-sub');
  });

  it('keeps LOOM_DLZ_RG as the RG and NEVER substitutes the admin or Purview RG', () => {
    // Deliberate narrowing vs. the pause path (documented in the source): with
    // no LOOM_DLZ_RG this returns null rather than composing a DLZ VMSS name
    // with the admin RG on a MUTATING path. An honest gate is a safe outcome;
    // scaling the wrong scale set is not.
    const withDlz = shirVmssConfig({
      ...base,
      LOOM_SHIR_VMSS_NAME: 'vmss-shir',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
    });
    expect(withDlz!.resourceGroup).toBe('rg-dlz');
    const withoutDlz = shirVmssConfig({
      ...base,
      LOOM_SHIR_VMSS_NAME: 'vmss-shir',
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
    });
    expect(withoutDlz).toBeNull();
  });

  it('returns null (honest gate) when the estate does not name a DLZ SHIR', () => {
    expect(shirVmssConfig({ ...base, LOOM_DLZ_RG: 'rg-dlz' })).toBeNull();
  });

  it('the two resolvers never return the same machine when both SHIRs are deployed', () => {
    // A Purview SHIR cannot share a VMSS with the ADF SHIR (Microsoft
    // constraint). If a chain edit ever made these converge, the idle-stop
    // workflow would scale the ADF SHIR to 0 believing it was the Purview one.
    const env = {
      ...base,
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw',
      LOOM_PURVIEW_SHIR_RG: 'rg-admin',
      LOOM_SHIR_SUB: 'admin-sub',
      LOOM_SHIR_VMSS_NAME: 'vmss-shir',
      LOOM_DLZ_RG: 'rg-dlz',
    } as unknown as NodeJS.ProcessEnv;
    const pvw = purviewShirVmssConfig(env)!;
    const dlz = shirVmssConfig(env)!;
    expect(pvw.name).not.toBe(dlz.name);
    expect(pvw.resourceGroup).not.toBe(dlz.resourceGroup);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 the scaling surface and the estate-pause manifest agree on the id', () => {
  // The whole point of #4248: one machine, one id. If the scaling surface
  // resolved differently from `resolveDeployManifest`, Pause would tag a
  // resource the Scale drawer never touches. These compare the two producers
  // over the SAME env rather than re-asserting a hand-written string, so a
  // future edit to EITHER chain that breaks the agreement turns them red.
  const withEstate = (e: Record<string, string>) =>
    ({ ...base, LOOM_ESTATE_ID: 'loom:estate-a', ...e }) as unknown as NodeJS.ProcessEnv;
  const manifestShir = (env: NodeJS.ProcessEnv) =>
    resolveDeployManifest(env).entries.find(
      (x) => x.resourceType === 'microsoft.compute/virtualmachinescalesets',
    );

  it('Purview SHIR: purviewShirVmssConfig composes the manifest entry byte-for-byte', () => {
    const env = withEstate({
      LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-loom-pvw-shir-default',
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
      LOOM_SHIR_SUB: 'shir-sub',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
    });
    const cfg = purviewShirVmssConfig(env)!;
    const entry = manifestShir(env)!;
    expect(entry).toBeDefined();
    expect(id(cfg.subscriptionId, cfg.resourceGroup, cfg.name)).toBe(entry.resourceId);
  });

  it('DLZ ADF SHIR: shirVmssConfig composes the manifest entry byte-for-byte', () => {
    const env = withEstate({
      LOOM_SHIR_VMSS_NAME: 'vmss-loom-shir-default',
      LOOM_DLZ_RG: 'rg-dlz',
      LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
    });
    const cfg = shirVmssConfig(env)!;
    const entry = manifestShir(env)!;
    expect(entry).toBeDefined();
    expect(id(cfg.subscriptionId, cfg.resourceGroup, cfg.name)).toBe(entry.resourceId);
  });

  it('single-sub estate: both producers agree on the DLZ SHIR id', () => {
    const env = withEstate({ LOOM_SHIR_VMSS_NAME: 'vmss-shir', LOOM_DLZ_RG: 'rg-dlz' });
    const cfg = shirVmssConfig(env)!;
    expect(id(cfg.subscriptionId, cfg.resourceGroup, cfg.name)).toBe(manifestShir(env)!.resourceId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 assertVmssTarget — an incomplete coordinate is NAMED, never composed', () => {
  const complete: VmssConfig = { subscriptionId: 's', resourceGroup: 'rg', name: 'vmss' };

  it('accepts a complete config', () => {
    expect(() => assertVmssTarget(complete)).not.toThrow();
  });

  it.each([
    ['subscriptionId', { ...complete, subscriptionId: '' }, 'LOOM_SHIR_SUB'],
    ['resourceGroup', { ...complete, resourceGroup: '  ' }, 'LOOM_PURVIEW_SHIR_RG'],
    ['name', { ...complete, name: '' }, 'LOOM_PURVIEW_SHIR_VMSS_NAME'],
  ] as const)('refuses on an empty %s and names the env var that supplies it', (field, cfg, envVar) => {
    // MUTATION TARGET: delete the corresponding `if (!c?.<field>...)` push and
    // this case goes green-into-silence — the exact "silently wrong id" the
    // guard exists to convert into an actionable error.
    let thrown: unknown;
    try {
      assertVmssTarget(cfg as VmssConfig);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VmssError);
    expect((thrown as VmssError).status).toBe(400);
    expect((thrown as VmssError).message).toContain(field);
    expect((thrown as VmssError).message).toContain(envVar);
  });

  it('states only what it established — that no ARM request was sent (R7)', () => {
    // The message must not assert a CAUSE it did not verify (e.g. "the scale
    // set does not exist"). It knows one thing: the target was not established.
    let msg = '';
    try {
      assertVmssTarget({ subscriptionId: '', resourceGroup: '', name: '' });
    } catch (e) {
      msg = (e as VmssError).message;
    }
    expect(msg).toContain('NOT established');
    expect(msg).toContain('no ARM request was sent');
    expect(msg).not.toMatch(/does not exist|not found|deleted/i);
    // All three missing → all three named, and the plural form is used.
    expect(msg).toContain('are empty');
  });

  it('uses the singular form when exactly one coordinate is missing', () => {
    let msg = '';
    try {
      assertVmssTarget({ subscriptionId: 's', resourceGroup: 'rg', name: '' });
    } catch (e) {
      msg = (e as VmssError).message;
    }
    expect(msg).toContain('is empty');
    expect(msg).not.toContain('are empty');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 basePath is guarded — the MUTATING verb never reaches ARM half-addressed', () => {
  // MUTATION TARGET: delete the `assertVmssTarget(c);` call at the top of
  // basePath. Both cases go red: the throw disappears and fetchWithTimeout is
  // called with `/subscriptions//resourceGroups/rg/...`.
  it('scaleVmss refuses an empty subscriptionId and sends NOTHING', async () => {
    await expect(scaleVmss({ subscriptionId: '', resourceGroup: 'rg', name: 'vmss' }, 4))
      .rejects.toBeInstanceOf(VmssError);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('getVmssStatus refuses an empty resourceGroup and sends NOTHING', async () => {
    await expect(getVmssStatus({ subscriptionId: 's', resourceGroup: '', name: 'vmss' }))
      .rejects.toBeInstanceOf(VmssError);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('the capacity range check still fires before anything else on a valid target', async () => {
    await expect(scaleVmss({ subscriptionId: 's', resourceGroup: 'rg', name: 'v' }, 9))
      .rejects.toThrow(/capacity must be an integer 0-8/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 the NAME coordinate is pinned to its own deployment', () => {
  // The RG and subscription chains are pinned hard above. The NAME was not —
  // and the name is the coordinate this issue is about. On an estate that
  // deploys BOTH SHIRs every name var is populated, so cross-wiring one
  // resolver to the other's name variable yields a complete, plausible config.
  //
  // MUTATION TARGET (purview): read LOOM_SHIR_VMSS_NAME in purviewShirVmssConfig.
  // MUTATION TARGET (dlz):     read LOOM_PURVIEW_SHIR_VMSS_NAME in shirVmssConfig.
  // Either one composes the OTHER machine's name with this one's home — the
  // exact mismatched-coordinates shape this file exists to prevent, and the one
  // direction the original spec left unmeasured.
  const bothDeployed = {
    ...base,
    LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-pvw-shir',
    LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
    LOOM_SHIR_VMSS_NAME: 'vmss-dlz-shir',
    LOOM_DLZ_RG: 'rg-dlz',
    LOOM_DLZ_SUBSCRIPTION_ID: 'dlz-sub',
  } as unknown as NodeJS.ProcessEnv;

  it('purviewShirVmssConfig reads LOOM_PURVIEW_SHIR_VMSS_NAME, never the DLZ name', () => {
    const cfg = purviewShirVmssConfig(bothDeployed)!;
    expect(cfg.name).toBe('vmss-pvw-shir');
    expect(cfg.name).not.toBe('vmss-dlz-shir');
  });

  it('shirVmssConfig reads LOOM_SHIR_VMSS_NAME, never the Purview name', () => {
    const cfg = shirVmssConfig(bothDeployed)!;
    expect(cfg.name).toBe('vmss-dlz-shir');
    expect(cfg.name).not.toBe('vmss-pvw-shir');
  });

  it('each resolver gates on ITS OWN name — the other being set does not make one resolvable', () => {
    // Without this, a resolver reading the wrong name var would still return a
    // config here rather than the honest null, and the two tests above would be
    // the only thing standing between a populated env and a wrong PATCH.
    const onlyDlzName = { ...bothDeployed, LOOM_SHIR_VMSS_NAME: 'vmss-dlz-shir' } as Record<string, string>;
    delete onlyDlzName.LOOM_PURVIEW_SHIR_VMSS_NAME;
    expect(purviewShirVmssConfig(onlyDlzName as NodeJS.ProcessEnv)).toBeNull();

    const onlyPvwName = { ...bothDeployed } as Record<string, string>;
    delete onlyPvwName.LOOM_SHIR_VMSS_NAME;
    expect(shirVmssConfig(onlyPvwName as NodeJS.ProcessEnv)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#4248 an ASSUMED resource group is refused on the MUTATING path', () => {
  // MUTATION TARGET (resolver): drop the `...(declaredRg ? {} : {resourceGroupAssumed:true})`
  // spread from purviewShirVmssConfig — every case below goes green-to-red in the
  // refusal direction (the PATCH is sent with a guessed home).
  // MUTATION TARGET (verb): delete the `if (c?.resourceGroupAssumed)` block in
  // scaleVmss — same result, one layer later.
  const brownfield = { ...base, LOOM_PURVIEW_SHIR_VMSS_NAME: 'vmss-existing-pvw-shir' } as unknown as NodeJS.ProcessEnv;

  const ok = () => ({ ok: true, status: 200, text: async () => '{"sku":{"capacity":0}}' });

  it('flags the config the bicep leaves half-emitted (name external, RG assumed)', () => {
    expect(purviewShirVmssConfig(brownfield)!.resourceGroupAssumed).toBe(true);
  });

  it('scaleVmss refuses it and sends NOTHING', async () => {
    const cfg = purviewShirVmssConfig(brownfield)!;
    await expect(scaleVmss(cfg, 4)).rejects.toBeInstanceOf(VmssError);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('the refusal states what it assumed and what to set — never ARM’s "does not exist"', async () => {
    const cfg = purviewShirVmssConfig(brownfield)!;
    let msg = '';
    let status = 0;
    try {
      await scaleVmss(cfg, 4);
    } catch (e) {
      msg = (e as VmssError).message;
      status = (e as VmssError).status;
    }
    expect(msg).toContain('ASSUMED from LOOM_ADMIN_RG');
    expect(msg).toContain('rg-admin');
    expect(msg).toContain('vmss-existing-pvw-shir');
    expect(msg).toContain('Set LOOM_PURVIEW_SHIR_RG');
    expect(msg).toContain('no PATCH was sent');
    expect(msg).not.toMatch(/does not exist/i);
    expect(status).toBe(409);
  });

  it('the READ path is untouched — the metrics tile keeps reporting on the same config', async () => {
    const cfg = purviewShirVmssConfig(brownfield)!;
    fetchWithTimeout.mockResolvedValue(ok());
    await expect(getVmssStatus(cfg)).resolves.toMatchObject({ name: 'vmss-existing-pvw-shir' });
    expect(fetchWithTimeout).toHaveBeenCalled();
  });

  it('a DECLARED LOOM_PURVIEW_SHIR_RG is not a guess, so the PATCH goes through', async () => {
    const cfg = purviewShirVmssConfig({
      ...brownfield,
      LOOM_PURVIEW_SHIR_RG: 'rg-purview-shir',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(cfg.resourceGroupAssumed).toBeUndefined();
    fetchWithTimeout.mockResolvedValue(ok());
    await expect(scaleVmss(cfg, 4)).resolves.toBeUndefined();
    const [url, init] = fetchWithTimeout.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/resourceGroups/rg-purview-shir/');
    expect(init.method).toBe('PATCH');
  });

  it('a caller-supplied config is never treated as a guess', async () => {
    // shir-autoscale, the register route and the stored-binding paths hand-build
    // VmssConfig. An explicit resourceGroup is a declaration by construction.
    fetchWithTimeout.mockResolvedValue(ok());
    const hand: VmssConfig = { subscriptionId: 's', resourceGroup: 'rg', name: 'vmss' };
    await expect(scaleVmss(hand, 0)).resolves.toBeUndefined();
    expect(fetchWithTimeout).toHaveBeenCalled();
  });
});

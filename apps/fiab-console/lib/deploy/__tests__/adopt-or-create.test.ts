import { describe, it, expect } from 'vitest';
import {
  ADOPTION_CATALOG,
  adoptableServices,
  adoptionArmTypes,
  armTypeToServiceKey,
  canAdopt,
  canCreate,
  getServiceDef,
} from '../adoption-catalog';
import {
  validatePlan,
  emptyNetworkDecision,
  type DeploymentPlan,
  type ServiceDecision,
} from '../plan-model';
import {
  computePlanHash,
  greenfieldPlan,
  supersede,
} from '../plan-hash';
import {
  planToAdoptBag,
  planToAdoptJson,
  planToArmParameters,
  planToCliTokens,
  planToDispatchInputs,
  planToGrants,
  mergeDispatchInputs,
  GITHUB_DISPATCH_INPUT_CAP,
} from '../plan-to-arm';
import { evaluateFitness, assertPlanIsDeployable, rollUpVerdict } from '../fitness';

const NOW = '2026-08-05T12:00:00.000Z';

function planWith(services: Record<string, ServiceDecision>): DeploymentPlan {
  const base = {
    planId: 'plan-1',
    schemaVersion: 1 as const,
    createdAt: NOW,
    createdBy: 'operator@example.gov',
    boundary: 'commercial' as const,
    topology: 'single-sub' as const,
    installSubscriptionId: 'sub-install',
    region: 'centralus',
    tenantId: 'tenant-a',
    scanScope: { subscriptions: [], managementGroups: [] },
    scanResults: [],
    services,
    network: emptyNetworkDecision(),
    featureFlags: {},
  };
  return { ...base, planHash: computePlanHash(base) };
}

const adoptDecision = (over: Partial<ServiceDecision> = {}): ServiceDecision => ({
  mode: 'adopt',
  source: 'discovered',
  target: { name: 'pv-corp', rg: 'rg-gov', sub: 'sub-9' },
  fitness: { verdict: 'usable', checks: [] },
  decidedBy: 'operator@example.gov',
  decidedAt: NOW,
  ...over,
});

describe('adoption-catalog', () => {
  it('has unique keys and generates its ARM type filter rather than hard-coding one', () => {
    const keys = ADOPTION_CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    const types = adoptionArmTypes();
    expect(types).toContain('microsoft.purview/accounts');
    expect(types).toEqual([...types].sort());
    // Every catalog armType is represented — the list cannot silently drop one.
    for (const d of ADOPTION_CATALOG) expect(types).toContain(d.armType);
  });

  it('disambiguates the Cognitive Services type by ARM kind', () => {
    expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'AIServices')).toBe('foundry');
    expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'SpeechServices')).toBeNull();
    expect(armTypeToServiceKey('microsoft.maps/accounts')).toBe('maps');
    expect(armTypeToServiceKey('microsoft.compute/virtualmachines')).toBeNull();
  });

  it('takes the granted role from the day-2 attach catalog so both paths agree', () => {
    for (const d of adoptableServices()) {
      expect(d.roleGuid, `${d.key} must name a role`).toBeTruthy();
      expect(d.roleName, `${d.key} must name a role`).toBeTruthy();
    }
    // Purview's day-0 grant is the same GUID the attach wizard uses.
    expect(getServiceDef('purview')!.roleGuid).toBe('200bba9e-f0c8-430f-892b-6f0794863803');
  });

  it('refuses "create new" for a tenant singleton that already exists', () => {
    // Deploying a second Purview account fails the WHOLE deployment with
    // EnterpriseTenantAlreadyExists, so the option is disabled rather than
    // offered and then failed.
    expect(canCreate('purview', /* candidateExists */ true)).toBe(false);
    expect(canCreate('purview', false)).toBe(true);
    expect(canAdopt('purview')).toBe(true);
  });

  it('locks the services Loom must always create, each with a reason', () => {
    for (const key of ['keyvault', 'containerappsenv', 'acr', 'postgres']) {
      const d = getServiceDef(key)!;
      expect(d.cls, key).toBe('create-only');
      expect(canAdopt(key), key).toBe(false);
      expect((d.createOnlyReason ?? '').length, `${key} must explain why`).toBeGreaterThan(80);
    }
  });

  it('states what Loom CHANGES about an adopted resource', () => {
    const dbx = getServiceDef('databricks')!;
    expect(dbx.mutations).toContain('assigns the workspace to a Unity Catalog metastore');
    expect(dbx.mutations.length).toBeGreaterThan(1);
  });
});

describe('plan-model', () => {
  it('hashes deterministically and independently of key order', () => {
    const a = planWith({ purview: adoptDecision() });
    const reordered: DeploymentPlan = {
      ...a,
      services: { purview: { ...a.services.purview } },
    };
    expect(computePlanHash(reordered)).toBe(a.planHash);
  });

  it('detects tampering — a changed decision changes the hash', () => {
    const a = planWith({ purview: adoptDecision() });
    const tampered = {
      ...a,
      services: { purview: adoptDecision({ target: { name: 'pv-attacker', rg: 'rg', sub: 's' } }) },
    };
    expect(computePlanHash(tampered)).not.toBe(a.planHash);
  });

  it('a greenfield plan is EMPTY, because an absent key already means create', () => {
    const p = greenfieldPlan({
      planId: 'g1', createdBy: 'me', now: NOW, boundary: 'commercial', topology: 'single-sub',
      installSubscriptionId: 'sub', region: 'centralus', tenantId: 't',
    });
    expect(p.services).toEqual({});
    expect(validatePlan(p)).toEqual([]);
    expect(planToAdoptBag(p)).toEqual({});
  });

  it('rejects an adopt with no target', () => {
    const p = planWith({ purview: adoptDecision({ target: undefined }) });
    expect(validatePlan(p).map((i) => i.code)).toContain('missing-target');
  });

  it('rejects an adopt that was never validated', () => {
    const p = planWith({ purview: adoptDecision({ fitness: undefined }) });
    expect(validatePlan(p).map((i) => i.code)).toContain('fitness-not-evaluated');
  });

  it('rejects an adopt whose fitness is unusable OR unknown', () => {
    for (const verdict of ['unusable', 'unknown'] as const) {
      const p = planWith({ purview: adoptDecision({ fitness: { verdict, checks: [] } }) });
      expect(validatePlan(p).map((i) => i.code), verdict).toContain('fitness-blocking');
    }
  });

  it('rejects adopting a create-only service', () => {
    const p = planWith({ keyvault: adoptDecision() });
    expect(validatePlan(p).map((i) => i.code)).toContain('adopt-not-permitted');
  });

  it('rejects a requested subscription with no coverage row — coverage is recorded, not inferred', () => {
    const p = planWith({});
    const withScope: DeploymentPlan = { ...p, scanScope: { subscriptions: ['sub-a', 'sub-b'], managementGroups: [] } };
    const issues = validatePlan(withScope);
    expect(issues.filter((i) => i.code === 'scan-coverage-missing')).toHaveLength(2);
  });

  it('supersede produces a new immutable revision linked to the old one', () => {
    const a = planWith({ purview: adoptDecision() });
    const b = supersede(a, { services: {} }, 'plan-2', 'other@example.gov', NOW);
    expect(b.planId).toBe('plan-2');
    expect(b.supersedes).toBe('plan-1');
    expect(b.planHash).not.toBe(a.planHash);
    expect(computePlanHash(b)).toBe(b.planHash);
    // the original is untouched
    expect(a.services.purview.mode).toBe('adopt');
  });
});

describe('plan-to-arm', () => {
  it('emits a create decision with NO target', () => {
    // bicep `union()` DEEP-merges, so a target left on a create entry would
    // survive a merge over the legacy EXISTING_* env and rebind the Console to
    // the customer's resource while a new one was ALSO deployed.
    const p = planWith({
      purview: { mode: 'create', source: 'default', target: { name: 'leftover', rg: 'rg', sub: 's' }, decidedBy: 'x', decidedAt: NOW },
    });
    expect(planToAdoptBag(p)).toStrictEqual({ purview: { mode: 'create' } });
  });

  it('emits adopt with the full coordinate triple and extras', () => {
    const p = planWith({
      foundry: adoptDecision({
        target: { name: 'aoai-corp', rg: 'rg-ai', sub: 'sub-2' },
        extra: { chatDeployment: 'gpt-4o', embedDeployment: 'text-embedding-3-large' },
      }),
    });
    expect(planToAdoptBag(p)).toStrictEqual({
      foundry: {
        mode: 'adopt',
        target: { name: 'aoai-corp', rg: 'rg-ai', sub: 'sub-2' },
        extra: { chatDeployment: 'gpt-4o', embedDeployment: 'text-embedding-3-large' },
      },
    });
  });

  it('drops a key the adoption catalog does not know rather than emitting it to bicep', () => {
    const p = planWith({ 'not-a-service': adoptDecision() });
    expect(planToAdoptBag(p)).toStrictEqual({});
  });

  it('all four tiers serialize the SAME adopt object', () => {
    const p = planWith({ purview: adoptDecision(), aisearch: { mode: 'skip', source: 'manual', decidedBy: 'x', decidedAt: NOW } });
    const bag = planToAdoptBag(p);

    // tier 0 / 1 — ARM parameters
    expect(planToArmParameters(p).adopt).toStrictEqual(bag);
    // tier 2 — dispatch fallback
    expect(JSON.parse(planToDispatchInputs(p, { preferPlanId: false }).plan_json)).toStrictEqual(bag);
    // tier 3 — CLI token
    const token = planToCliTokens(p)[0];
    expect(token.startsWith("adopt='")).toBe(true);
    expect(JSON.parse(token.slice("adopt='".length, -1))).toStrictEqual(bag);
    // the LOOM_ADOPT_JSON env the bicepparams read
    expect(JSON.parse(planToAdoptJson(p))).toStrictEqual(bag);
  });

  it('prefers plan_id so the deployed plan is provably the persisted one', () => {
    const p = planWith({ purview: adoptDecision() });
    expect(planToDispatchInputs(p, { preferPlanId: true })).toStrictEqual({ plan_id: 'plan-1' });
  });

  it('FAILS CLOSED rather than silently dropping the plan at GitHub dispatch cap', () => {
    // The shipped allow-list was exactly 10 entries and silently dropped
    // serviceChoices. Dropping the plan is the one thing that must never happen
    // quietly, because the deploy then provisions duplicates.
    const base: Record<string, string> = {};
    for (let i = 0; i < GITHUB_DISPATCH_INPUT_CAP; i++) base[`k${i}`] = 'v';
    expect(() => mergeDispatchInputs(base, { plan_id: 'plan-1' })).toThrow(/must not be the thing that is dropped/);
    // under the cap it merges
    delete base.k9;
    expect(mergeDispatchInputs(base, { plan_id: 'plan-1' }).plan_id).toBe('plan-1');
  });

  it('derives the grant set from the plan, only for adopted services', () => {
    const p = planWith({
      purview: adoptDecision(),
      aisearch: { mode: 'create', source: 'default', decidedBy: 'x', decidedAt: NOW },
    });
    expect(planToGrants(p)).toStrictEqual([
      {
        serviceKey: 'purview',
        roleName: 'Purview Data Source Administrator',
        roleGuid: '200bba9e-f0c8-430f-892b-6f0794863803',
        scope: 'rg-gov/pv-corp',
      },
    ]);
  });
});

describe('fitness', () => {
  const ctx = { hubRegion: 'centralus', hubTenantId: 'tenant-a' };

  it('never collapses "could not read" into "is wrong"', () => {
    const res = evaluateFitness(
      { serviceKey: 'storage-adls', name: 'sa1', resourceGroup: 'rg', subscriptionId: 's', location: 'centralus', networkPosture: 'public', properties: {} },
      ctx,
    );
    const hns = res.checks.find((c) => c.id === 'adls.hns')!;
    expect(hns.verdict).toBe('unknown');
    expect(hns.what).toMatch(/could not read/i);
    expect(hns.established).toMatch(/absent/);
    expect(res.verdict).toBe('unknown');
  });

  it('reports a REAL false as a hard fail with the observation recorded', () => {
    const res = evaluateFitness(
      { serviceKey: 'storage-adls', name: 'sa1', resourceGroup: 'rg', subscriptionId: 's', location: 'centralus', networkPosture: 'public', properties: { isHnsEnabled: false, skuKind: 'StorageV2' } },
      ctx,
    );
    const hns = res.checks.find((c) => c.id === 'adls.hns')!;
    expect(hns.verdict).toBe('fail');
    expect(hns.established).toContain('isHnsEnabled=false');
    expect(hns.remediation).toStrictEqual({
      kind: 'not-remediable',
      description: 'isHnsEnabled is set at account creation and cannot be turned on afterwards.',
      alternative: 'Point Loom at an account created with a hierarchical namespace, or let Loom create one.',
    });
    expect(res.verdict).toBe('unusable');
  });

  it('blocks a Databricks workspace on a FOREIGN metastore', () => {
    const res = evaluateFitness(
      {
        serviceKey: 'databricks', name: 'dbx', resourceGroup: 'rg', subscriptionId: 's',
        location: 'centralus', sku: { tier: 'premium' }, networkPosture: 'public',
        properties: { metastoreId: 'ms-someone-else', loomMetastoreId: 'ms-loom' },
      },
      ctx,
    );
    expect(res.checks.find((c) => c.id === 'databricks.metastoreAssignment')!.verdict).toBe('fail');
    expect(res.verdict).toBe('unusable');
  });

  it('accepts an UNASSIGNED Databricks workspace', () => {
    const res = evaluateFitness(
      {
        serviceKey: 'databricks', name: 'dbx', resourceGroup: 'rg', subscriptionId: 's',
        location: 'centralus', sku: { tier: 'premium' }, networkPosture: 'public',
        properties: { metastoreId: null, loomMetastoreId: 'ms-loom' },
      },
      { ...ctx, rbac: { holdsRole: true, canGrant: true } },
    );
    expect(res.verdict).toBe('usable');
  });

  it('rejects an AI Search Free tier by name and says why', () => {
    const res = evaluateFitness(
      { serviceKey: 'aisearch', name: 'srch', resourceGroup: 'rg', subscriptionId: 's', location: 'centralus', sku: { name: 'free' }, networkPosture: 'public', properties: { indexCount: 0, indexLimit: 3 } },
      ctx,
    );
    const sku = res.checks.find((c) => c.id === 'aisearch.sku')!;
    expect(sku.verdict).toBe('fail');
    expect(sku.why).toMatch(/Free tier caps a service at 3 indexes/);
  });

  it('treats a private-endpoint resource as fixable BY THE PLATFORM, not by the operator', () => {
    const res = evaluateFitness(
      { serviceKey: 'aisearch', name: 'srch', resourceGroup: 'rg', subscriptionId: 's', location: 'centralus', sku: { name: 'standard' }, networkPosture: 'private-endpoint', properties: { indexCount: 0, indexLimit: 50 } },
      { ...ctx, rbac: { holdsRole: true, canGrant: true } },
    );
    const net = res.checks.find((c) => c.id === 'aisearch.network')!;
    expect(net.verdict).toBe('warn');
    expect(net.remediation?.kind).toBe('platform-will-fix');
    expect(res.verdict).toBe('usable-with-changes');
  });

  it('names the exact role when neither Loom nor the operator can grant it', () => {
    const res = evaluateFitness(
      { serviceKey: 'apim', name: 'apim1', resourceGroup: 'rg-api', subscriptionId: 's', location: 'centralus', sku: { tier: 'developer' }, networkPosture: 'public', properties: { virtualNetworkType: 'None' } },
      { ...ctx, rbac: { holdsRole: false, canGrant: false } },
    );
    const rbac = res.checks.find((c) => c.id === 'apim.rbac')!;
    expect(rbac.verdict).toBe('fail');
    expect(rbac.remediation).toMatchObject({
      kind: 'operator-action',
      role: { name: 'API Management Service Contributor', scope: 'rg-api/apim1' },
    });
  });

  it('blocks a Purview account in another tenant', () => {
    const res = evaluateFitness(
      { serviceKey: 'purview', name: 'pv', resourceGroup: 'rg', subscriptionId: 's', location: 'eastus2', networkPosture: 'public', tenantId: 'tenant-b', properties: { rootCollectionAdmin: true, freeCapacityUnits: 4 } },
      { ...ctx, rbac: { holdsRole: true, canGrant: true } },
    );
    expect(res.checks.find((c) => c.id === 'purview.sameTenant')!.verdict).toBe('fail');
  });

  it('allows Purview cross-REGION, because purviewLocation supports it', () => {
    const res = evaluateFitness(
      { serviceKey: 'purview', name: 'pv', resourceGroup: 'rg', subscriptionId: 's', location: 'eastus2', networkPosture: 'public', tenantId: 'tenant-a', properties: { rootCollectionAdmin: true, freeCapacityUnits: 4 } },
      { ...ctx, rbac: { holdsRole: true, canGrant: true } },
    );
    expect(res.checks.find((c) => c.id === 'purview.region')).toBeUndefined();
    expect(res.verdict).toBe('usable');
  });

  it('fails an adopted Foundry account with no chat deployment', () => {
    const res = evaluateFitness(
      { serviceKey: 'foundry', name: 'aoai', resourceGroup: 'rg', subscriptionId: 's', location: 'centralus', kind: 'AIServices', networkPosture: 'public', properties: { chatDeployment: '', embedDeployment: 'emb' } },
      { ...ctx, rbac: { holdsRole: true, canGrant: true } },
    );
    expect(res.checks.find((c) => c.id === 'foundry.chatDeployment')!.verdict).toBe('fail');
  });

  it('a catalog check with no implementation is LOUD, never a silent pass', () => {
    // A named check that silently skipped would be a validation that cannot fail.
    expect(rollUpVerdict([{ id: 'x', verdict: 'unknown', what: 'w', why: 'y', established: 'e' }])).toBe('unknown');
    const res = evaluateFitness({ serviceKey: 'nope', name: 'n', resourceGroup: 'r', subscriptionId: 's' }, ctx);
    expect(res.verdict).toBe('unknown');
    expect(res.checks[0].id).toBe('catalog.unknownService');
  });

  it('assertPlanIsDeployable blocks BOTH unusable and unknown, before anything deploys', () => {
    expect(() => assertPlanIsDeployable([{ serviceKey: 'aisearch', fitness: { verdict: 'usable', checks: [] } }])).not.toThrow();
    expect(() => assertPlanIsDeployable([{ serviceKey: 'aisearch', fitness: { verdict: 'usable-with-changes', checks: [] } }])).not.toThrow();
    for (const verdict of ['unusable', 'unknown'] as const) {
      expect(() =>
        assertPlanIsDeployable([
          { serviceKey: 'storage-adls', fitness: { verdict, checks: [{ id: 'adls.hns', verdict: 'fail', what: 'no HNS', why: 'w', established: 'isHnsEnabled=false' }] } },
        ]),
      ).toThrow(/storage-adls/);
    }
  });
});

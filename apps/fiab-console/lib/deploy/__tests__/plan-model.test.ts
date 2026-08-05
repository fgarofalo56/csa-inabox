/**
 * Tests for the deployment plan model + builder.
 *
 * These pin the invariants that make the plan HONEST, because each one has a
 * corresponding real defect in this repo's history:
 *
 *   · "nothing found" vs "could not look" must not collapse   (the
 *     `subsSeen.size` coverage lie, and `csa_loom_unknown_as_negative_class`)
 *   · coverage is counted from what was REQUESTED
 *   · a known-impossible choice is disabled, not offered      (a second
 *     Enterprise Purview → EnterpriseTenantAlreadyExists)
 *   · fitness `unknown` BLOCKS — it is not a pass
 *   · greenfield is derived, never stored
 */
import { describe, it, expect } from 'vitest';
import {
  coverageSentence,
  coverageSummary,
  isGreenfieldPlan,
  planBlockers,
  planCounts,
  type DeploymentPlan,
  type ServiceDecision,
  type SubscriptionScanResult,
} from '@/lib/deploy/plan-model';
import {
  canonicalPlanJson,
  computePlanHash,
  verifyPlanHash,
  withPlanHash,
} from '@/lib/deploy/plan-hash';
import {
  allowedModes,
  applyDecision,
  applyFitness,
  buildPlanFromDiscovery,
  noCandidateSentence,
  recommendFor,
  supersede,
  type AdoptableServiceView,
  type AdoptionCandidate,
  type ServiceScanRow,
} from '@/lib/deploy/plan-builder';

const NOW = () => '2026-08-05T00:00:00.000Z';

function svc(over: Partial<AdoptableServiceView> = {}): AdoptableServiceView {
  return {
    key: 'aisearch',
    label: 'AI Search',
    class: 'adoptable',
    usedFor: 'search',
    mutations: ['creates four indexes'],
    ...over,
  };
}

function cand(over: Partial<AdoptionCandidate> = {}): AdoptionCandidate {
  return {
    serviceKey: 'aisearch',
    id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Search/searchServices/srch',
    name: 'srch',
    resourceGroup: 'rg',
    subscriptionId: 's1',
    subscriptionName: 'Sub One',
    location: 'eastus2',
    networkPosture: 'public',
    credentialTier: 1,
    ...over,
  };
}

function led(over: Partial<SubscriptionScanResult> = {}): SubscriptionScanResult {
  return {
    subscriptionId: 's1',
    displayName: 'Sub One',
    status: 'scanned',
    credentialTier: 1,
    matchedResources: 0,
    truncated: false,
    ...over,
  };
}

describe('coverage accounting', () => {
  it('counts from the requested ledger, not from matched results', () => {
    // 12 requested, hits in 2 — the old code reported "2 scanned".
    const ledger = Array.from({ length: 12 }, (_, i) =>
      led({ subscriptionId: `s${i}`, matchedResources: i < 2 ? 3 : 0 }),
    );
    const c = coverageSummary(ledger);
    expect(c.requested).toBe(12);
    expect(c.scanned).toBe(12);
    expect(c.incomplete).toBe(false);
    expect(coverageSentence(ledger)).toContain('Read 12 of 12 subscriptions');
  });

  it('keeps "read, nothing found" and "could not read" apart', () => {
    const ledger = [led({ subscriptionId: 'a' }), led({ subscriptionId: 'b', status: 'no-access' })];
    const c = coverageSummary(ledger);
    expect(c.scanned).toBe(1);
    expect(c.noAccess).toBe(1);
    expect(c.incomplete).toBe(true);
    expect(coverageSentence(ledger)).toContain('1 could not be read');
    expect(coverageSentence(ledger)).toContain('not found in what I could read');
  });

  it('treats a truncated scan as incomplete even when every sub was readable', () => {
    const ledger = [led({ truncated: true })];
    expect(coverageSummary(ledger).incomplete).toBe(true);
  });
});

describe('recommendFor', () => {
  it('recommends create when nothing was found', () => {
    const r = recommendFor({ service: svc(), candidates: [] }, 'eastus2');
    expect(r.recommendation).toBe('create');
    expect(r.reason).toContain('No existing AI Search was found');
  });

  it('recommends adopt for exactly one candidate', () => {
    const r = recommendFor({ service: svc(), candidates: [cand()] }, 'eastus2');
    expect(r.recommendation).toBe('adopt');
    expect(r.candidateIndex).toBe(0);
  });

  it('says so when the single candidate is cross-region', () => {
    const r = recommendFor({ service: svc(), candidates: [cand({ location: 'westus' })] }, 'eastus2');
    expect(r.recommendation).toBe('adopt');
    expect(r.reason).toContain('westus');
    expect(r.reason).toContain('cross-region');
  });

  it('falls back to create when several candidates are ambiguous', () => {
    const r = recommendFor(
      { service: svc(), candidates: [cand({ name: 'a' }), cand({ name: 'b' }), cand({ name: 'c' })] },
      'westus',
    );
    expect(r.recommendation).toBe('create');
    expect(r.reason).toContain('none is an obvious match');
  });

  it('picks the single hub-region candidate out of several', () => {
    const r = recommendFor(
      {
        service: svc(),
        candidates: [cand({ name: 'a', location: 'westus' }), cand({ name: 'b', location: 'eastus2' })],
      },
      'eastus2',
    );
    expect(r.recommendation).toBe('adopt');
    expect(r.candidateIndex).toBe(1);
  });

  it('marks a tenant singleton adopt-required rather than offering a create that would fail', () => {
    const purview = svc({ key: 'purview', label: 'Microsoft Purview', cls: 'adopt-required', singleton: 'tenant' });
    const r = recommendFor({ service: purview, candidates: [cand({ serviceKey: 'purview', name: 'pv' })] }, 'eastus2');
    expect(r.recommendation).toBe('adopt-required');

    const modes = allowedModes({ service: purview, candidates: [cand()] }, true);
    expect(modes.create).toBe(false);
    expect(modes.createDisabledReason).toContain('EnterpriseTenantAlreadyExists');
  });

  it('renders a create-only service locked, with its reason', () => {
    const kv = svc({ key: 'keyvault', label: 'Key Vault', cls: 'create-only', createOnlyReason: 'trust root', mutations: [] });
    const r = recommendFor({ service: kv, candidates: [] }, 'eastus2');
    expect(r.recommendation).toBe('create');
    expect(r.reason).toBe('trust root');
    const modes = allowedModes({ service: kv, candidates: [] }, false);
    expect(modes.adopt).toBe(false);
    expect(modes.adoptDisabledReason).toBe('trust root');
  });
});

describe('buildPlanFromDiscovery', () => {
  const rows: ServiceScanRow[] = [
    { service: svc(), candidates: [cand()] },
    { service: svc({ key: 'adx', label: 'ADX', mutations: [] }), candidates: [] },
  ];

  function build(ledger: SubscriptionScanResult[]) {
    return buildPlanFromDiscovery({
      planId: 'plan_1',
      createdBy: 'tester',
      boundary: 'commercial',
      topology: 'single-sub',
      installSubscriptionId: 's1',
      region: 'eastus2',
      scanScope: { subscriptions: ['s1'], managementGroups: [] },
      ledger,
      rows,
      now: NOW,
    });
  }

  it('produces an all-create plan for an empty estate, and calls it greenfield', () => {
    const plan = build([led()]);
    const empty = buildPlanFromDiscovery({
      planId: 'p',
      createdBy: 't',
      boundary: 'commercial',
      topology: 'single-sub',
      installSubscriptionId: 's1',
      region: 'eastus2',
      scanScope: { subscriptions: ['s1'], managementGroups: [] },
      ledger: [led()],
      rows: [{ service: svc(), candidates: [] }],
      now: NOW,
    });
    expect(isGreenfieldPlan(empty)).toBe(true);
    // The plan WITH a candidate adopts, so it is brownfield — derived, not stored.
    expect(isGreenfieldPlan(plan)).toBe(false);
  });

  it('does not mark a create uncertain when coverage was complete', () => {
    const plan = build([led()]);
    expect(plan.services.adx.mode).toBe('create');
    expect(plan.services.adx.uncertain).toBeUndefined();
    expect(noCandidateSentence(rows[1], plan.services.adx, [led()])).toContain('in any subscription you selected');
  });

  it('marks a create uncertain when a subscription could not be read, and says so', () => {
    const ledger = [led(), led({ subscriptionId: 's2', displayName: 'Two', status: 'no-access' })];
    const plan = build(ledger);
    expect(plan.services.adx.uncertain).toBe(true);
    const sentence = noCandidateSentence(rows[1], plan.services.adx, ledger);
    expect(sentence).toContain('could not be read');
    // The critical negative: it must NOT assert absence.
    expect(sentence).not.toContain('in any subscription you selected');
  });

  it('never marks an adopt decision uncertain — it names a resource we actually saw', () => {
    const plan = build([led(), led({ subscriptionId: 's2', status: 'no-access' })]);
    expect(plan.services.aisearch.mode).toBe('adopt');
    expect(plan.services.aisearch.uncertain).toBeUndefined();
  });
});

describe('applyDecision / immutability / hash', () => {
  const base = buildPlanFromDiscovery({
    planId: 'plan_1',
    createdBy: 'tester',
    boundary: 'commercial',
    topology: 'single-sub',
    installSubscriptionId: 's1',
    region: 'eastus2',
    scanScope: { subscriptions: ['s1'], managementGroups: [] },
    ledger: [led()],
    rows: [{ service: svc(), candidates: [cand()] }],
    now: NOW,
  });

  it('returns a new plan and leaves the original untouched', () => {
    const next = applyDecision(base, 'aisearch', { mode: 'create' }, 'tester', NOW);
    expect(base.services.aisearch.mode).toBe('adopt');
    expect(next.services.aisearch.mode).toBe('create');
  });

  it('drops the target when switching away from adopt', () => {
    const next = applyDecision(base, 'aisearch', { mode: 'create' }, 'tester', NOW);
    expect(next.services.aisearch.target).toBeUndefined();
  });

  it('refuses to attach a fitness result to a non-adopt decision', () => {
    const created = applyDecision(base, 'aisearch', { mode: 'create' }, 'tester', NOW);
    const attempted = applyFitness(created, 'aisearch', { verdict: 'usable', checks: [] });
    expect(attempted.services.aisearch.fitness).toBeUndefined();
  });

  it('hashes independently of key insertion order', () => {
    const reordered: DeploymentPlan = {
      ...base,
      services: Object.fromEntries(Object.entries(base.services).reverse()),
    };
    expect(computePlanHash(reordered)).toBe(computePlanHash(base));
    expect(verifyPlanHash(withPlanHash(base))).toBe(true);
  });

  it('the PLANNER leaves the plan unstamped — the hash is stamped server-side', () => {
    // plan-builder runs in the browser (setup-wizard is a 'use client' tree) and
    // cannot compute the authoritative sha256: lib/deploy/plan-hash.ts imports
    // node:crypto and is server-only by design. A hash computed in the browser
    // would prove nothing about the plan the deploy received.
    expect(base.planHash).toBe('');
    // And an UNSTAMPED plan is reported NOT verified, never verified-trivially.
    expect(verifyPlanHash(base)).toBe(false);
  });

  it('changes the hash when a decision changes', () => {
    const next = applyDecision(base, 'aisearch', { mode: 'skip' }, 'tester', NOW);
    // Stamp both sides the way writePlanIfAbsent() does on the server.
    const a = withPlanHash(base);
    const b = withPlanHash(next);
    expect(b.planHash).not.toBe(a.planHash);
    expect(verifyPlanHash(b)).toBe(true);
  });

  it('excludes the hash field from its own input', () => {
    expect(canonicalPlanJson(base)).not.toContain('planHash');
  });

  it('records a supersedes link on an edit', () => {
    const next = supersede(base, 'plan_2', 'tester', NOW);
    expect(next.supersedes).toBe('plan_1');
    expect(next.planId).toBe('plan_2');
  });
});

describe('planBlockers — validation is blocking, and unknown is not a pass', () => {
  function planWith(d: Partial<ServiceDecision>): DeploymentPlan {
    return withPlanHash({
      planId: 'p',
      schemaVersion: 1 as const,
      createdAt: NOW(),
      createdBy: 't',
      boundary: 'commercial' as const,
      topology: 'single-sub' as const,
      installSubscriptionId: 's1',
      region: 'eastus2',
      scanScope: { subscriptions: ['s1'], managementGroups: [] },
      scanResults: [led()],
      services: {
        aisearch: {
          mode: 'adopt',
          source: 'discovered',
          target: { name: 'srch', rg: 'rg', sub: 's1' },
          decidedBy: 't',
          decidedAt: NOW(),
          ...d,
        } as ServiceDecision,
      },
      network: { hub: { mode: 'create' }, spokes: {}, privateDns: { mode: 'create', zones: {} }, firewall: { mode: 'create' }, logAnalytics: { mode: 'create' } },
      featureFlags: {},
    });
  }

  it('blocks an adopt that has not been validated', () => {
    expect(planBlockers(planWith({}))).toHaveLength(1);
    expect(planBlockers(planWith({}))[0]).toContain('has not been validated');
  });

  it('blocks an unusable verdict and names the failed check', () => {
    const p = planWith({
      fitness: {
        verdict: 'unusable',
        checks: [
          {
            id: 'adls.hns',
            verdict: 'fail',
            what: 'Hierarchical namespace is not enabled',
            why: 'Delta needs the Gen2 API',
            established: 'isHnsEnabled=false from Microsoft.Storage/storageAccounts@2023-05-01',
          },
        ],
      },
    });
    expect(planBlockers(p)[0]).toContain('Hierarchical namespace is not enabled');
  });

  it('BLOCKS an unknown verdict — "I could not verify" is not "this is fine"', () => {
    const p = planWith({
      fitness: {
        verdict: 'unknown',
        checks: [
          {
            id: 'net.posture',
            verdict: 'unknown',
            what: 'Could not determine whether the Console can reach this resource',
            why: 'A private endpoint may exist in an unpeered VNet',
            established: 'the ARG row carried no network posture fields',
          },
        ],
      },
    });
    const blockers = planBlockers(p);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('could not verify');
    expect(planCounts(p.services).unusable).toBe(1);
  });

  it('does not block a green or amber verdict', () => {
    expect(planBlockers(planWith({ fitness: { verdict: 'usable', checks: [] } }))).toHaveLength(0);
    expect(planBlockers(planWith({ fitness: { verdict: 'usable-with-changes', checks: [] } }))).toHaveLength(0);
  });

  it('blocks an adopt with no resource chosen', () => {
    const p = planWith({ target: undefined, fitness: { verdict: 'usable', checks: [] } });
    expect(planBlockers(p)[0]).toContain('no resource was chosen');
  });
});

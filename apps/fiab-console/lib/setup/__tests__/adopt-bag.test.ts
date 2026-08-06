/**
 * adopt-bag — the ONE derivation of the `adopt` object every deploy tier
 * consumes (#3016).
 *
 * The mutation these tests prove: making `deriveAdoptBag` stop honouring the
 * posted plan (or silently drop a malformed pick instead of failing closed)
 * goes RED here before it can reach a tier.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAdoptBag,
  sanitizeSubmittedPlan,
  collectLegacyAdoptBag,
  adoptBagHasDecisions,
  adoptCliParam,
} from '../adopt-bag';

const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A minimal wizard-shaped plan carrying one adopt + one create decision. */
function planWith(services: Record<string, unknown>) {
  return {
    planId: 'plan_test',
    schemaVersion: 1,
    services,
  };
}

describe('deriveAdoptBag — plan source (the wizard posts body.plan)', () => {
  it('serializes an adopt decision from the plan into the bag', () => {
    const d = deriveAdoptBag({
      plan: planWith({
        purview: {
          mode: 'adopt',
          target: { name: 'pv-existing', rg: 'rg-data', sub: SUB },
          decidedBy: 'op',
          decidedAt: 'now',
        },
        aisearch: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
      }),
    });
    expect(d.problems).toEqual([]);
    expect(d.source).toBe('plan');
    expect(d.bag.purview).toEqual({
      mode: 'adopt',
      target: { name: 'pv-existing', rg: 'rg-data', sub: SUB },
    });
    // The explicit create entry survives (the belt against a stale
    // LOOM_ADOPT_JSON env merge — plan-to-arm rule 1) and carries NO target.
    expect(d.bag.aisearch).toEqual({ mode: 'create' });
    expect(adoptBagHasDecisions(d.bag)).toBe(true);
  });

  it('an all-create plan is NOT a meaningful bag (greenfield keeps every tier)', () => {
    const d = deriveAdoptBag({
      plan: planWith({
        purview: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
        adx: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
      }),
    });
    expect(d.problems).toEqual([]);
    expect(adoptBagHasDecisions(d.bag)).toBe(false);
  });

  it('a skip decision IS meaningful (dropping it would deploy what the operator skipped)', () => {
    const d = deriveAdoptBag({
      plan: planWith({ maps: { mode: 'skip', decidedBy: 'op', decidedAt: 'now' } }),
    });
    expect(d.problems).toEqual([]);
    expect(d.bag.maps).toEqual({ mode: 'skip' });
    expect(adoptBagHasDecisions(d.bag)).toBe(true);
  });

  it('FAILS CLOSED on an adopt of a service the catalog does not know', () => {
    const d = deriveAdoptBag({
      plan: planWith({
        'not-a-service': { mode: 'adopt', target: { name: 'x', rg: 'y', sub: SUB } },
      }),
    });
    expect(d.problems.join(' ')).toMatch(/not in the adoption catalog/);
    expect(Object.keys(d.bag)).toHaveLength(0);
  });

  it('FAILS CLOSED on an adopt with no resource named', () => {
    const d = deriveAdoptBag({
      plan: planWith({ purview: { mode: 'adopt', target: { name: '', rg: '', sub: '' } } }),
    });
    expect(d.problems.join(' ')).toMatch(/names no resource/);
  });

  it('FAILS CLOSED on a non-GUID target subscription', () => {
    const d = deriveAdoptBag({
      plan: planWith({ purview: { mode: 'adopt', target: { name: 'pv', rg: 'rg', sub: 'nope' } } }),
    });
    expect(d.problems.join(' ')).toMatch(/not a subscription GUID/);
  });

  it('FAILS CLOSED on a name that would break the copy-paste quoting', () => {
    const d = deriveAdoptBag({
      plan: planWith({ purview: { mode: 'adopt', target: { name: "pv'; rm -rf /", rg: 'rg', sub: SUB } } }),
    });
    expect(d.problems.length).toBeGreaterThan(0);
  });
});

describe('deriveAdoptBag — legacy source (pre-plan clients)', () => {
  it('collects serviceChoices use-existing + the dedicated existing* fields', () => {
    const d = deriveAdoptBag({
      serviceChoices: {
        aisearch: { mode: 'use-existing', existing: { name: 'search1', rg: 'rg-s', sub: SUB } },
        purview: { mode: 'new' },
        keyvault: { mode: 'use-existing', existing: { name: 'kv', rg: 'rg', sub: SUB } }, // not adoptable → ignored
      },
      existingCosmosAccount: 'cosmos1',
      existingCosmosRg: 'rg-c',
      existingCosmosSub: SUB,
      existingAdxClusterName: 'adx1',
    });
    expect(d.problems).toEqual([]);
    expect(d.source).toBe('legacy');
    expect(d.bag.aisearch.target?.name).toBe('search1');
    expect(d.bag.cosmos.target).toEqual({ name: 'cosmos1', rg: 'rg-c', sub: SUB });
    expect(d.bag.adx.target?.name).toBe('adx1');
    expect(d.bag.keyvault).toBeUndefined();
    expect(adoptBagHasDecisions(d.bag)).toBe(true);
  });

  it('a request with no picks derives an EMPTY bag (greenfield unchanged)', () => {
    const d = deriveAdoptBag({});
    expect(d.bag).toEqual({});
    expect(d.source).toBe('none');
    expect(adoptBagHasDecisions(d.bag)).toBe(false);
  });

  it('legacy fields also fail closed on unsafe values', () => {
    const { problems } = collectLegacyAdoptBag({ existingAdxClusterName: "adx'--" });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('sanitizeSubmittedPlan', () => {
  it('null/undefined plan is simply absent (legacy path), not a problem', () => {
    expect(sanitizeSubmittedPlan(undefined)).toEqual({ plan: null, problems: [] });
    expect(sanitizeSubmittedPlan(null)).toEqual({ plan: null, problems: [] });
  });

  it('a non-object plan is a problem, never a silent drop', () => {
    expect(sanitizeSubmittedPlan('x').problems.length).toBeGreaterThan(0);
    expect(sanitizeSubmittedPlan([1]).problems.length).toBeGreaterThan(0);
  });

  it('preserves the submitted fitness result on an adopt decision (the #3014 gate reads it)', () => {
    const fitness = { verdict: 'unusable', checks: [] };
    const { plan, problems } = sanitizeSubmittedPlan(
      planWith({
        purview: { mode: 'adopt', target: { name: 'pv', rg: 'rg', sub: SUB }, fitness },
      }),
    );
    expect(problems).toEqual([]);
    expect(plan?.services.purview.fitness).toEqual(fitness);
  });
});

describe('adoptCliParam', () => {
  it('emits a single-quoted adopt=… assignment', () => {
    const { bag } = deriveAdoptBag({ existingAdxClusterName: 'adx1' });
    const s = adoptCliParam(bag);
    expect(s.startsWith("adopt='")).toBe(true);
    expect(s).toContain('"adx"');
  });
});

/**
 * Prototype-safety of the ARM parameter serializers (ledger C23).
 *
 * `planToAdoptBag()` and `planToArmParameters()` build maps keyed by strings
 * that originate outside this module. `bag`'s keys are catalog-filtered by
 * `getServiceDef()`, but `params`' keys are the raw `featureFlags` keys and are
 * filtered by nothing.
 *
 * The assertion below is a READ of an inherited key, never a
 * write-then-check-a-bystander. That distinction is load-bearing: this repo
 * previously shipped a prototype-pollution test that passed on the mutant
 * because assigning a *string* to `__proto__` is a silent no-op, so
 * `({}).polluted === undefined` held for a plain object too and the test never
 * discriminated. `rec.constructor === undefined` only holds for a
 * null-prototype record, so it goes red the moment the structural fix is
 * reverted.
 *
 * The featureFlags case is a CORRECTNESS defect before it is a security one: on
 * a plain object `params['__proto__'] = false` is a silent no-op, so the flag
 * would be dropped from the deployment rather than rejected.
 */
import { describe, expect, it } from 'vitest';

import { planToAdoptBag, planToArmParameters } from '../plan-to-arm';
import type { DeploymentPlan } from '../plan-model';

function planWith(
  featureFlags: Record<string, boolean>,
  services: Record<string, unknown> = {},
): DeploymentPlan {
  return {
    planId: 'plan-c23',
    schemaVersion: 1,
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'c23-test',
    boundary: 'Commercial',
    topology: 'single',
    installSubscriptionId: '00000000-0000-0000-0000-000000000000',
    region: 'centralus',
    tenantId: '00000000-0000-0000-0000-000000000000',
    scanScope: { subscriptions: [], managementGroups: [] },
    services,
    featureFlags,
  } as unknown as DeploymentPlan;
}

describe('plan-to-arm prototype safety', () => {
  it('drops a hostile service key at the catalog gate — the bag is protected by filtering, not by its prototype', () => {
    // `bag` is deliberately a plain object: the `getServiceDef()` gate is what
    // keeps hostile keys out, and four tiers assert the bag round-trips through
    // JSON to an identical value (a null-prototype record would break that for
    // no real gain). So the thing worth pinning is the FILTER, not the shape.
    const services = JSON.parse('{"__proto__":{"mode":"create"},"purview":{"mode":"create"}}');
    const bag = planToAdoptBag(planWith({}, services));

    expect(Object.prototype.hasOwnProperty.call(bag, '__proto__')).toBe(false);
    expect(bag.purview).toEqual({ mode: 'create' });
    // Nothing leaked onto the global prototype on the way through.
    expect(({} as Record<string, unknown>).mode).toBeUndefined();
  });

  it('planToArmParameters returns a null-prototype record', () => {
    const params = planToArmParameters(planWith({ enableFoo: true }));
    // Reading an inherited key IS the discriminator — a plain `{}` would
    // return `[Function: Object]` here.
    expect((params as Record<string, unknown>).constructor).toBeUndefined();
    expect(Object.getPrototypeOf(params)).toBeNull();
  });

  it('keeps a __proto__ feature flag as an OWN key instead of dropping it', () => {
    // The fixture MUST come from JSON.parse, not an object literal: in a literal
    // `{ __proto__: true }` is prototype-setter syntax and creates no own key at
    // all, so a literal-based fixture would model the test's idea of the input
    // rather than the real one. JSON.parse creates a genuine own `__proto__`
    // property — and JSON is exactly how featureFlags arrives from a request.
    const hostileFlags = JSON.parse('{"__proto__":true,"enableFoo":false}') as Record<
      string,
      boolean
    >;
    expect(Object.prototype.hasOwnProperty.call(hostileFlags, '__proto__')).toBe(true);

    // On a plain object this assignment is a silent no-op and the flag vanishes
    // from the deployment. On a null-prototype record it lands as a real own
    // property, so the value survives to ARM and to validation.
    const params = planToArmParameters(planWith(hostileFlags));

    expect(Object.prototype.hasOwnProperty.call(params, '__proto__')).toBe(true);
    expect(params['__proto__']).toBe(true);
    expect(params.enableFoo).toBe(false);
    // Nothing leaked onto the global prototype.
    expect(({} as Record<string, unknown>).enableFoo).toBeUndefined();
  });

  it('adopt is still reachable after the null-prototype change', () => {
    // Guards the refactor itself: `adopt` moved from an object-literal property
    // to an assignment, and dropping it would be silent.
    const params = planToArmParameters(planWith({}));
    expect(params.adopt).toBeDefined();
  });
});

/**
 * Selected-factory override resolution — the fix for the pipeline bind picker /
 * Factory Resources tree diverging from the factory the operator selected.
 *
 * Covers:
 *   1. Pure coord resolution (`resolveFactoryOverride` / `factoryOverrideFromSearchParams`).
 *   2. AsyncLocalStorage propagation (`withFactoryOverride` / `currentFactoryOverride`),
 *      including across an `await` — the mechanism every `/api/adf/*` + bind
 *      route relies on so `adf-client` calls pick up the selection.
 *   3. `adf-client.resolveFactoryCoords` — SELECTED coords win inside the
 *      override, the env default is the fallback, and a partial selection
 *      (factory name only) is merged with the env subscription/RG. This is the
 *      exact resolution `base()` uses for `listPipelines()` (the bind dropdown)
 *      and `upsertPipeline()` (Create-&-bind), so these assertions prove those
 *      calls target the selected factory.
 *   4. `adfConfigGate` honors a fully-specified selection even when the env
 *      default is unset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveFactoryOverride,
  factoryOverrideFromSearchParams,
  withFactoryOverride,
  currentFactoryOverride,
} from '../adf-factory-context';
import { resolveFactoryCoords, adfConfigGate } from '../adf-client';

const ENV = { sub: 'env-sub-0000', rg: 'env-rg', name: 'adf-env-default' };
const SELECTED = { subscriptionId: 'sel-sub-1111', resourceGroup: 'sel-rg', factoryName: 'adf-selected' };

describe('resolveFactoryOverride', () => {
  it('returns undefined for empty / missing input (→ env default)', () => {
    expect(resolveFactoryOverride(undefined)).toBeUndefined();
    expect(resolveFactoryOverride(null)).toBeUndefined();
    expect(resolveFactoryOverride({})).toBeUndefined();
    expect(resolveFactoryOverride({ subscriptionId: '', resourceGroup: '  ', factoryName: null })).toBeUndefined();
  });

  it('trims and carries only the coords supplied', () => {
    expect(resolveFactoryOverride({ subscriptionId: ' s ', resourceGroup: 'r', factoryName: 'f' }))
      .toEqual({ subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' });
    // Partial selection (name only) is honored — the rest falls through to env.
    expect(resolveFactoryOverride({ factoryName: 'only-name' })).toEqual({ factoryName: 'only-name' });
  });
});

describe('factoryOverrideFromSearchParams', () => {
  it('parses factorySubscriptionId / factoryResourceGroup / factoryName', () => {
    const sp = new URLSearchParams({
      factorySubscriptionId: SELECTED.subscriptionId,
      factoryResourceGroup: SELECTED.resourceGroup,
      factoryName: SELECTED.factoryName,
      name: 'some-pipeline', // unrelated param must be ignored
    });
    expect(factoryOverrideFromSearchParams(sp)).toEqual(SELECTED);
  });

  it('returns undefined when no factory params are present', () => {
    expect(factoryOverrideFromSearchParams(new URLSearchParams({ name: 'p' }))).toBeUndefined();
  });
});

describe('withFactoryOverride / currentFactoryOverride', () => {
  it('exposes the override only inside the callback', () => {
    expect(currentFactoryOverride()).toBeUndefined();
    const inside = withFactoryOverride(SELECTED, () => currentFactoryOverride());
    expect(inside).toEqual(SELECTED);
    expect(currentFactoryOverride()).toBeUndefined();
  });

  it('propagates the override across awaits (the route → adf-client path)', async () => {
    const seen = await withFactoryOverride(SELECTED, async () => {
      await Promise.resolve();
      return currentFactoryOverride();
    });
    expect(seen).toEqual(SELECTED);
    expect(currentFactoryOverride()).toBeUndefined();
  });

  it('runs the callback unchanged when the override is undefined (env-default path)', () => {
    expect(withFactoryOverride(undefined, () => currentFactoryOverride())).toBeUndefined();
  });
});

describe('adf-client.resolveFactoryCoords (what base() / listPipelines / bind target)', () => {
  beforeEach(() => {
    process.env.LOOM_SUBSCRIPTION_ID = ENV.sub;
    process.env.LOOM_DLZ_RG = ENV.rg;
    process.env.LOOM_ADF_NAME = ENV.name;
    delete process.env.LOOM_ADF_SUB;
    delete process.env.LOOM_ADF_RG;
  });
  afterEach(() => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_RG;
    delete process.env.LOOM_ADF_NAME;
  });

  it('falls back to the env-default factory when nothing is selected', () => {
    expect(resolveFactoryCoords()).toEqual({
      subscriptionId: ENV.sub, resourceGroup: ENV.rg, factoryName: ENV.name,
    });
  });

  it('uses the SELECTED factory coords inside withFactoryOverride (bind + list target the selection)', () => {
    const coords = withFactoryOverride(SELECTED, () => resolveFactoryCoords());
    expect(coords).toEqual({
      subscriptionId: SELECTED.subscriptionId,
      resourceGroup: SELECTED.resourceGroup,
      factoryName: SELECTED.factoryName,
    });
    // Outside the override, back to the env default.
    expect(resolveFactoryCoords().factoryName).toBe(ENV.name);
  });

  it('merges a partial selection (factory name only) with the env subscription/RG', () => {
    const coords = withFactoryOverride({ factoryName: 'adf-picked' }, () => resolveFactoryCoords());
    expect(coords).toEqual({ subscriptionId: ENV.sub, resourceGroup: ENV.rg, factoryName: 'adf-picked' });
  });

  it('an explicit target argument wins over both the override and the env', () => {
    const coords = withFactoryOverride(SELECTED, () =>
      resolveFactoryCoords({ subscriptionId: 'arg-sub', resourceGroup: 'arg-rg', factoryName: 'arg-adf' }),
    );
    expect(coords).toEqual({ subscriptionId: 'arg-sub', resourceGroup: 'arg-rg', factoryName: 'arg-adf' });
  });
});

describe('adfConfigGate honors a full selection over the env default', () => {
  afterEach(() => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_RG;
    delete process.env.LOOM_ADF_NAME;
  });

  it('gates (missing var) when neither env nor a full selection is present', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_RG;
    delete process.env.LOOM_ADF_NAME;
    expect(adfConfigGate()).toEqual({ missing: 'LOOM_SUBSCRIPTION_ID' });
  });

  it('passes when a fully-specified factory is selected even with the env unset', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_RG;
    delete process.env.LOOM_ADF_NAME;
    const gate = withFactoryOverride(SELECTED, () => adfConfigGate());
    expect(gate).toBeNull();
  });

  it('passes on the env default when nothing is selected', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ENV.sub;
    process.env.LOOM_DLZ_RG = ENV.rg;
    process.env.LOOM_ADF_NAME = ENV.name;
    expect(adfConfigGate()).toBeNull();
  });
});

describe('#3513 review — the gate reads exactly what the resolvers read', () => {
  const KEYS = [
    'LOOM_SUBSCRIPTION_ID', 'LOOM_ADF_SUB',
    'LOOM_DLZ_RG', 'LOOM_ADF_RG',
    'LOOM_ADF_NAME', 'LOOM_ADF_FACTORY',
  ];
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of KEYS) delete process.env[k]; });

  it('accepts the ADF-SPECIFIC spelling on every axis (was a false RED)', () => {
    // sub() and rg() have always preferred LOOM_ADF_SUB / LOOM_ADF_RG, but the
    // gate demanded the platform-wide spelling, so an estate pinned to a reused
    // factory in another subscription resolved every coordinate correctly and
    // was still told it was unconfigured.
    process.env.LOOM_ADF_SUB = 'adf-sub-2222';
    process.env.LOOM_ADF_RG = 'adf-rg';
    process.env.LOOM_ADF_NAME = 'adf-pinned';
    expect(adfConfigGate()).toBeNull();
    expect(resolveFactoryCoords()).toEqual({
      subscriptionId: 'adf-sub-2222', resourceGroup: 'adf-rg', factoryName: 'adf-pinned',
    });
  });

  it('LOOM_ADF_FACTORY is a REAL alias, not decoration (was a false GREEN)', () => {
    // hub-console-dlz-env.bicep:228 writes both spellings and gov-discover.yml:84
    // suggests the alias to brownfield operators. Until the client read it, the
    // svc-adf Fix-it wrote a key nothing consumed: the gate flipped to
    // configured and the install stayed blocked.
    process.env.LOOM_SUBSCRIPTION_ID = ENV.sub;
    process.env.LOOM_DLZ_RG = ENV.rg;
    process.env.LOOM_ADF_FACTORY = 'adf-via-alias';
    expect(adfConfigGate()).toBeNull();
    expect(resolveFactoryCoords().factoryName).toBe('adf-via-alias');
  });

  it('the canonical spelling WINS when both are set', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ENV.sub;
    process.env.LOOM_DLZ_RG = ENV.rg;
    process.env.LOOM_ADF_NAME = 'canonical';
    process.env.LOOM_ADF_FACTORY = 'alias';
    expect(resolveFactoryCoords().factoryName).toBe('canonical');
  });

  it('still gates — and names the CANONICAL key — when an axis is wholly absent', () => {
    // Fail-closed is the property that must survive widening. The missing-key
    // string stays the canonical spelling so the remediation never sends an
    // operator to the alias.
    process.env.LOOM_SUBSCRIPTION_ID = ENV.sub;
    process.env.LOOM_DLZ_RG = ENV.rg;
    expect(adfConfigGate()).toEqual({ missing: 'LOOM_ADF_NAME' });

    delete process.env.LOOM_DLZ_RG;
    expect(adfConfigGate()).toEqual({ missing: 'LOOM_DLZ_RG' });

    delete process.env.LOOM_SUBSCRIPTION_ID;
    expect(adfConfigGate()).toEqual({ missing: 'LOOM_SUBSCRIPTION_ID' });
  });
});

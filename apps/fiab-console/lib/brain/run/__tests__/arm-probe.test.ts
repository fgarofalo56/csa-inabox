/**
 * LOOM BRAIN W10 — the REAL probe, against a fake ARM (#3936).
 *
 * The probe is the module that decides whether a verdict can be formed at all,
 * so it gets the same treatment as the classifier: every failure mode is
 * asserted, and each assertion is paired with the control that makes it mean
 * something.
 *
 * ── WHAT IS BEING PROVEN ───────────────────────────────────────────────────
 *   • The discovery query and the reader table are ONE decision. If they drift,
 *     the probe reports a FAILURE rather than silently skipping the resource —
 *     because a silently skipped resource shrinks the examined population, which
 *     PRP §3.8 names as this repo's dominant evasion.
 *   • A thrown fetch carries `httpStatus: null`, NOT 0. "Azure said no" and
 *     "Azure was never asked" must stay distinguishable.
 *   • A 401/403 is classified `auth`; anything else non-2xx is `arm-error`.
 *   • ARG's own `totalRecords` is cross-checked, so a partial pull becomes a
 *     failure rather than a plausible-looking estate.
 *   • `Unknown` is a first-class power state, never a convenience default.
 */

import { describe, expect, it } from 'vitest';
import {
  ArmEstateProbe,
  POWER_READERS,
  SCOPED_TYPES,
  UnsafeQueryScopeError,
  assertKustoLiteralSafe,
  containerAppState,
  discoveryQuery,
  type FetchLike,
} from '../azure/arm-probe';

const BASE = 'https://arm.example';
const SCOPE = 'https://arm.example/.default';

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

function fakeArm(handlers: {
  arg?: (body: unknown) => ReturnType<typeof res>;
  get?: (url: string) => ReturnType<typeof res>;
  throwOn?: 'arg' | 'get';
}): FetchLike {
  return async (url, init) => {
    const isArg = url.includes('Microsoft.ResourceGraph');
    if (handlers.throwOn === 'arg' && isArg) throw new TypeError('fetch failed');
    if (handlers.throwOn === 'get' && !isArg) throw new TypeError('fetch failed');
    if (isArg) {
      return handlers.arg
        ? handlers.arg(init.body ? JSON.parse(init.body) : {})
        : res({ data: [], totalRecords: 0 });
    }
    return handlers.get ? handlers.get(url) : res({ properties: { runningStatus: 'Running' } });
  };
}

const APP = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.App/containerApps/loom-console';

function probeWith(fetchImpl: FetchLike, opts: Partial<{ estateTag: string }> = {}) {
  return new ArmEstateProbe({
    armBase: BASE,
    armScope: SCOPE,
    getToken: async () => 'token',
    fetchImpl,
    ...opts,
  });
}

describe('ArmEstateProbe — the happy path', () => {
  it('discovers, reads each resource with an ARM GET, and produces branded readings', async () => {
    const result = await probeWith(
      fakeArm({
        arg: () => res({ data: [{ id: APP, type: 'Microsoft.App/containerApps' }], totalRecords: 1 }),
        get: () => res({ properties: { runningStatus: 'Running' } }),
      }),
    ).probe();

    expect(result.failures).toHaveLength(0);
    expect(result.discovered).toBe(1);
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0].powerState).toBe('Online');
    // The api-version is on the reading — it is what makes it an ARM reading
    // rather than a Resource Graph row wearing the same shape.
    expect(result.readings[0].armApiVersion).toBe(POWER_READERS['microsoft.app/containerapps'].apiVersion);
  });

  it('follows the $skipToken to exhaustion', async () => {
    let page = 0;
    const result = await probeWith(
      fakeArm({
        arg: () => {
          page += 1;
          return page === 1
            ? res({
                data: [{ id: `${APP}-a`, type: 'Microsoft.App/containerApps' }],
                totalRecords: 2,
                $skipToken: 'more',
              })
            : res({ data: [{ id: `${APP}-b`, type: 'Microsoft.App/containerApps' }] });
        },
      }),
    ).probe();
    expect(result.discovered).toBe(2);
    expect(result.readings).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
  });
});

describe('ArmEstateProbe — failures say what they established', () => {
  it('a thrown fetch is `network` with httpStatus NULL, not 0', async () => {
    const result = await probeWith(fakeArm({ throwOn: 'arg' })).probe();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].classification).toBe('network');
    // null, not 0. "Azure said no" and "Azure was never asked" are different
    // facts and a falsy status would collapse them.
    expect(result.failures[0].httpStatus).toBeNull();
    expect(result.failures[0].detail).toContain('no HTTP exchange completed');
  });

  it('a 403 is classified `auth` and carries the body verbatim', async () => {
    const result = await probeWith(
      fakeArm({ arg: () => res('{"error":{"code":"AuthorizationFailed"}}', 403) }),
    ).probe();
    expect(result.failures[0].classification).toBe('auth');
    expect(result.failures[0].httpStatus).toBe(403);
    expect(result.failures[0].detail).toContain('AuthorizationFailed');
  });

  it('a 500 is `arm-error`, NOT auth — the control for the assertion above', async () => {
    const result = await probeWith(fakeArm({ arg: () => res('boom', 500) })).probe();
    expect(result.failures[0].classification).toBe('arm-error');
  });

  it('a per-resource GET failure is reported without losing the readings that worked', async () => {
    const result = await probeWith(
      fakeArm({
        arg: () =>
          res({
            data: [
              { id: `${APP}-a`, type: 'Microsoft.App/containerApps' },
              { id: `${APP}-b`, type: 'Microsoft.App/containerApps' },
            ],
            totalRecords: 2,
          }),
        get: (url) =>
          url.includes('-b') ? res('forbidden', 403) : res({ properties: { runningStatus: 'Running' } }),
      }),
    ).probe();
    expect(result.discovered).toBe(2);
    expect(result.readings).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].stage).toBe('power-read');
  });

  it('a totalRecords mismatch is a FAILURE, not a plausible partial estate', async () => {
    const result = await probeWith(
      fakeArm({
        arg: () => res({ data: [{ id: APP, type: 'Microsoft.App/containerApps' }], totalRecords: 99 }),
      }),
    ).probe();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].detail).toContain('totalRecords=99');
    expect(result.failures[0].detail).toContain('INCOMPLETE');
  });

  it('a null token is `auth` and states that NO query was issued', async () => {
    const result = await new ArmEstateProbe({
      armBase: BASE,
      armScope: SCOPE,
      getToken: async () => null,
      fetchImpl: fakeArm({}),
    }).probe();
    expect(result.failures[0].classification).toBe('auth');
    expect(result.failures[0].detail).toContain('NO query was issued');
    // R7 — it does NOT claim there are no resources, because nothing was asked.
    expect(result.failures[0].detail).not.toContain('no resources');
  });
});

describe('ArmEstateProbe — the query and the reader table are ONE decision', () => {
  it('every scoped type has a reader, and every reader is in the query', () => {
    for (const t of SCOPED_TYPES) expect(POWER_READERS[t]).toBeDefined();
    const q = discoveryQuery();
    for (const t of SCOPED_TYPES) expect(q).toContain(t);
  });

  it('a discovered type with NO reader is a FAILURE, never a silent skip', async () => {
    // The drift case. A silent skip would shrink the examined population with
    // nothing to see it — PRP §3.8's dominant evasion.
    const result = await probeWith(
      fakeArm({
        arg: () =>
          res({
            data: [{ id: '/subscriptions/x/providers/Microsoft.Sql/servers/s', type: 'Microsoft.Sql/servers' }],
            totalRecords: 1,
          }),
      }),
    ).probe();
    expect(result.discovered).toBe(1);
    expect(result.readings).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].detail).toContain('POWER_READERS');
    expect(result.failures[0].detail).toContain('drifted');
  });

  it('the estate-tag filter is applied only when supplied', () => {
    expect(discoveryQuery()).not.toContain('loom-estate-id');
    expect(discoveryQuery({ estateTag: 'my-estate' })).toContain(
      "tags['loom-estate-id'] == 'my-estate'",
    );
  });

  it('the resource-group filter uses the CASE-INSENSITIVE membership operator', () => {
    // ARM resource-group names are case-insensitive and Azure returns them in
    // inconsistent casing. A case-SENSITIVE comparison here would silently drop
    // resources and shrink the examined population.
    const q = discoveryQuery({ resourceGroups: ['rg-a', 'rg-b'] });
    expect(q).toContain("resourceGroup in~ ('rg-a', 'rg-b')");
    expect(q).not.toContain('resourceGroup in (');
    expect(discoveryQuery()).not.toContain('resourceGroup in');
  });

  it('both scopes compose, and both are reported in the probe scope text', async () => {
    const result = await new ArmEstateProbe({
      armBase: BASE,
      armScope: SCOPE,
      getToken: async () => 'token',
      fetchImpl: fakeArm({ arg: () => res({ data: [], totalRecords: 0 }) }),
      estateTag: 'my-estate',
      resourceGroups: ['rg-a'],
    }).probe();
    expect(result.scope).toContain("tagged loom-estate-id='my-estate'");
    expect(result.scope).toContain('in resource group(s) rg-a');
  });

  it('an UNSCOPED probe says so — the scope text never implies a narrowing it did not do', async () => {
    const result = await probeWith(fakeArm({ arg: () => res({ data: [], totalRecords: 0 }) })).probe();
    expect(result.scope).toContain('ALL tags');
    expect(result.scope).toContain('in ALL resource groups');
    expect(result.scope).toContain('across every readable subscription');
  });
});

/**
 * THE QUERY SCOPE IS VALIDATED, NOT ESCAPED (`check-sql-quoting`).
 *
 * The first version hand-rolled a quote-DOUBLING replace next to the query —
 * the exact pattern that guard exists to keep out of the codebase, and the same
 * defect class as the CodeQL finding in `report.ts`: local escaping that looks
 * right and is not centrally reviewed. (The literal is not reproduced here: the
 * guard scans comments too, and it is right to — a copy in a comment is how the
 * next author learns the pattern.)
 *
 * The Azure Resource Graph REST API has NO parameter binding (`QueryRequest`
 * carries only a query string), so a literal is the only construction
 * available. But every value this query interpolates has a documented,
 * restrictive character set — so it is VALIDATED and REFUSED, which is strictly
 * stronger than escaping: an input that cannot contain a quote cannot break out
 * of one.
 */
describe('discoveryQuery — validated scope, no hand-rolled quoting', () => {
  /** Hostile in ANY position. Length limits differ, so they are separate. */
  const HOSTILE = [
    "o'brien",
    "x' or '1'=='1",
    "rg'; Resources | project id //",
    'a\\b',
    'a"b',
    'a\nb',
    'a\rb',
    'a|b',
  ];

  it.each(HOSTILE)('REFUSES a hostile resource group: %j', (value) => {
    expect(() => discoveryQuery({ resourceGroups: [value] })).toThrow(UnsafeQueryScopeError);
  });

  it.each(HOSTILE)('REFUSES a hostile estate tag: %j', (value) => {
    expect(() => discoveryQuery({ estateTag: value })).toThrow(UnsafeQueryScopeError);
  });

  it('REFUSES an over-long value in each position, at ITS OWN limit', () => {
    // The limits differ — 90 for an ARM resource-group name, 128 for the tag
    // value — so a single shared fixture would silently only exercise one of
    // them. Absolute numbers, not arithmetic on the constants they guard.
    expect(() => discoveryQuery({ resourceGroups: ['x'.repeat(91)] })).toThrow(
      UnsafeQueryScopeError,
    );
    expect(() => discoveryQuery({ resourceGroups: ['x'.repeat(90)] })).not.toThrow();
    expect(() => discoveryQuery({ estateTag: 'x'.repeat(129) })).toThrow(UnsafeQueryScopeError);
    expect(() => discoveryQuery({ estateTag: 'x'.repeat(128) })).not.toThrow();
  });

  it('a refused value NEVER reaches the query text', () => {
    // The property that matters. A "validate then continue anyway" bug would
    // still throw somewhere and still emit the value.
    let query = '';
    try {
      query = discoveryQuery({ resourceGroups: ["rg'; drop //"] });
    } catch {
      // expected
    }
    expect(query).toBe('');
  });

  it('CONTROL: the real resource-group names are ACCEPTED', () => {
    // Without this the validator could reject everything and pass every test
    // above while breaking the lane completely.
    for (const rg of [
      'rg-csa-loom-admin-centralus',
      'rg-csa-loom-admin-usgovvirginia',
      'rg_with_underscores',
      'rg.with.dots',
      'rg(with-parens)',
    ]) {
      expect(() => discoveryQuery({ resourceGroups: [rg] })).not.toThrow();
      expect(discoveryQuery({ resourceGroups: [rg] })).toContain(`'${rg}'`);
    }
  });

  it('CONTROL: the derived estate id shape is ACCEPTED', () => {
    // `loom:<sub8>:<rg>` — what resolveScanEstateId produces.
    const id = 'loom:abcdef01:rg-csa-loom-admin-centralus';
    expect(() => discoveryQuery({ estateTag: id })).not.toThrow();
    expect(discoveryQuery({ estateTag: id })).toContain(`'${id}'`);
  });

  it('the emitted query contains no doubled quote — nothing is being escaped', () => {
    const q = discoveryQuery({
      estateTag: 'loom:abcdef01:rg-x',
      resourceGroups: ['rg-a', 'rg-b'],
    });
    expect(q).not.toContain("''");
  });

  it('the belt-and-braces check fires if the PATTERN is ever widened', () => {
    // The second assertion inside assertKustoLiteralSafe is not defence-in-depth
    // theatre — it is the check that survives an edit to the first one. Proven
    // by handing it a deliberately over-permissive pattern.
    expect(() => assertKustoLiteralSafe('thing', "a'b", /^.*$/)).toThrow(
      /no longer guarantees what this check assumes/,
    );
  });

  it('the refusal message says WHY escaping was not the answer', () => {
    let message = '';
    try {
      discoveryQuery({ resourceGroups: ["o'brien"] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('REJECTED rather than escaped');
    expect(message).toContain('no parameter binding');
  });
});

describe('containerAppState', () => {
  it('maps the states ARM actually returns', () => {
    expect(containerAppState({ properties: { runningStatus: 'Running' } })).toBe('Online');
    expect(containerAppState({ properties: { runningStatus: 'Stopped' } })).toBe('Stopped');
    expect(containerAppState({ properties: { runningStatus: 'Progressing' } })).toBe('Scaling');
    expect(containerAppState({ properties: { runningStatus: 'Suspended' } })).toBe('Paused');
  });

  it('anything it cannot establish is Unknown — NOT Stopped, and NOT Online', () => {
    // `Unknown` is a first-class state. Defaulting it to Stopped would let a
    // whole estate of unreadable resources read as PAUSED; defaulting it to
    // Online would scan an estate that is switched off.
    expect(containerAppState({})).toBe('Unknown');
    expect(containerAppState({ properties: {} })).toBe('Unknown');
    expect(containerAppState({ properties: { runningStatus: 'SomethingNew' } })).toBe('Unknown');
    expect(containerAppState(null)).toBe('Unknown');
  });
});

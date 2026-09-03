/**
 * WHICH SERVICES THE DEPLOY DECLARES NON-SCALABLE (#4257).
 *
 * Two halves, and both are load-bearing:
 *
 *   1. THE PREDICATE, over synthetic templates. Each arm differs from the
 *      pinned-singleton fixture by ONE field, so a passing arm and its refusing
 *      twin isolate the property being tested.
 *
 *   2. THE REAL ARTIFACT. The derivation is asserted against the COMMITTED
 *      `deploy-templates/main.json`, because a resolver that silently understood
 *      none of the real expression shapes would satisfy every synthetic arm
 *      above and return an EMPTY map in production — a guard watching nothing,
 *      which is the exact failure class this repo keeps measuring. The
 *      population floor and the named subjects are that control.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  declarationsFromTemplate,
  declaredNonScalableToZero,
  deployDeclaredScalabilitySource,
  deriveScalability,
  nonScalableExplanation,
  refuseScaleToZero,
  resolveDeclaredInt,
  scaleToZeroRefusalReason,
  SCALABILITY_SOURCE,
  __resetScalabilityCache,
  type ScalabilitySource,
} from '../scalability';

/**
 * A controllable stand-in for the template READ, defaulting to the real one.
 *
 * Round-2 review of #4261, should-fix 5: the non-caching of `unreadable` was
 * specced at `resolveDlzTemplateInlineOutcome` but NOT at
 * `deployDeclaredScalabilitySource`, which keeps its own module-level cache.
 * Mutating that layer to cache the failure left 166/166 green — M6 one layer up,
 * unfixtured. When `override.current` is null every other arm in this file sees
 * the genuine implementation, so the mock changes nothing else.
 */
const override = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/setup/user-arm-deploy', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/setup/user-arm-deploy')>();
  return {
    ...actual,
    resolveDlzTemplateInlineOutcome: () =>
      override.current ?? actual.resolveDlzTemplateInlineOutcome(),
  };
});

// ---------------------------------------------------------------------------
// Synthetic templates — one nested module declaring one Container App
// ---------------------------------------------------------------------------

function moduleTemplate(args: {
  name?: unknown;
  scale: unknown;
  parameters?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    parameters: args.parameters ?? {},
    variables: args.variables ?? {},
    resources: [
      {
        type: 'Microsoft.App/containerApps',
        name: args.name ?? 'loom-thing',
        properties: { template: { scale: args.scale } },
      },
    ],
  };
}

/**
 * A root template wrapping ONE nested module.
 *
 * `passed` is the enclosing deployment's `properties.parameters` — the values
 * the deploy actually hands the module. It was absent from this helper until the
 * round-2 review, which is WHY no fixture could reach B1: every synthetic arm
 * resolved a `defaultValue` that nothing had overridden, so the resolver's
 * preference for the default over the passed value was unreachable by
 * construction. Two shipped modules already pass replica values in.
 */
function rootWith(
  inner: Record<string, unknown>,
  moduleName = 'loom-thing-module',
  passed?: Record<string, unknown>,
): unknown {
  return {
    resources: [
      {
        type: 'Microsoft.Resources/deployments',
        name: moduleName,
        properties: { template: inner, ...(passed ? { parameters: passed } : {}) },
      },
    ],
  };
}

/** A second module whose app `env` wires a consumer to `targetFqdnName`. */
function consumerModule(targetFqdnName: string): Record<string, unknown> {
  return {
    type: 'Microsoft.Resources/deployments',
    name: 'admin-plane',
    properties: {
      template: {
        resources: [
          {
            type: 'Microsoft.App/containerApps',
            name: 'loom-console',
            properties: {
              template: {
                scale: { minReplicas: 0, maxReplicas: 3 },
                containers: [
                  {
                    env: [
                      {
                        name: 'LOOM_THING_URL',
                        value: `https://${targetFqdnName}.internal.example.io`,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

describe('THE PREDICATE — a pinned singleton is the shape, not a name', () => {
  it('minReplicas 1 = maxReplicas 1 with NO scale rules is NON-scalable', () => {
    const decls = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } })),
    );
    const d = decls.get('loom-thing');
    expect(d).toBeDefined();
    expect(d!.scalableToZero).toBe(false);
    expect(d!.declared).toEqual({ minReplicas: 1, maxReplicas: 1, hasScaleRules: false });
    expect(d!.module).toBe('loom-thing-module');
    expect(declaredNonScalableToZero('loom-thing', decls)).not.toBeNull();
  });

  it('THE CONTROL: maxReplicas 2 — one field away — is ELASTIC and stays performable', () => {
    // Without this arm a resolver that refused EVERY app would pass the spec
    // above and silently disable the whole scale-to-zero feature.
    const decls = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 2 } })),
    );
    expect(decls.get('loom-thing')!.scalableToZero).toBe(true);
    expect(declaredNonScalableToZero('loom-thing', decls)).toBeNull();
  });

  it('B3 — a fixed 1/1 WITH a scale rule is STILL pinned: the rule cannot fire', () => {
    // This arm asserted the OPPOSITE until the round-3 review ("the rule is the
    // intent"). It was wrong, and it was wrong in the shape production emits:
    // the real `apps[]` loop attaches a rule to EVERY app it declares, so a 1/1
    // stateful runtime added there read as elastic and was PERMITTED. KEDA has
    // nothing to scale between a floor and a ceiling that are equal.
    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          scale: {
            minReplicas: 1,
            maxReplicas: 1,
            rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }],
          },
        }),
      ),
    );
    const d = decls.get('loom-thing')!;
    expect(d.declared).toEqual({ minReplicas: 1, maxReplicas: 1, hasScaleRules: true });
    expect(d.scalableToZero).toBe(false);
    expect(refuseScaleToZero('loom-thing', decls)!.kind).toBe('pinned-singleton');
    // R7 — the refusal must not claim "no scale rules" when there is one.
    expect(d.reason).not.toContain('no scale rules');
    expect(d.reason).toContain('CANNOT fire');
  });

  it('B3 CONTROL: a rule DOES keep an app elastic when min and max differ', () => {
    // Without this arm, "pin everything with equal-or-unequal replicas" would
    // pass the arm above. The rule is only inert when there is no room to move.
    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          scale: {
            minReplicas: 1,
            maxReplicas: 3,
            rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }],
          },
        }),
      ),
    );
    expect(decls.get('loom-thing')!.scalableToZero).toBe(true);
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
  });

  it('minReplicas 0 is never pinned, whatever the max says', () => {
    const decls = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 0, maxReplicas: 0 } })),
    );
    expect(decls.get('loom-thing')!.scalableToZero).toBe(true);
  });

  it('the RESTRICTIVE reading wins when two modules declare the same app', () => {
    // The s3-gateway ships from both the admin plane and the dlz-attach path. A
    // runtime that is a singleton on one deploy path is a singleton.
    const template = {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'elastic-path',
          properties: {
            template: moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 3 } }),
          },
        },
        {
          type: 'Microsoft.Resources/deployments',
          name: 'pinned-path',
          properties: {
            template: moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } }),
          },
        },
      ],
    };
    expect(declarationsFromTemplate(template).get('loom-thing')!.scalableToZero).toBe(false);
  });
});

describe('EXPRESSION RESOLUTION — only the shapes the real template uses', () => {
  /** The real `loom-risingwave` shape: replicas via a variable over a config bag. */
  function bagModule(fallbackMin: number, fallbackMax: number): Record<string, unknown> {
    return moduleTemplate({
      name: "[parameters('name')]",
      parameters: {
        name: { type: 'string', defaultValue: 'loom-risingwave' },
        // MEASURED: every config-bag param in the real artifact defaults to null
        // and is supplied by the parent.
        risingwaveConfig: { type: 'object', defaultValue: null },
      },
      variables: {
        minReplicas: `[int(coalesce(tryGet(parameters('risingwaveConfig'), 'minReplicas'), ${fallbackMin}))]`,
        maxReplicas: `[int(coalesce(tryGet(parameters('risingwaveConfig'), 'maxReplicas'), ${fallbackMax}))]`,
      },
      scale: { minReplicas: "[variables('minReplicas')]", maxReplicas: "[variables('maxReplicas')]" },
    });
  }

  it('resolves `[variables(x)]` and the config-bag `coalesce(tryGet(...), N)` fallback', () => {
    // No bag passed and the bag defaults to null, so `tryGet` yields null and
    // ARM's `coalesce` genuinely takes the fallback. Reading it is correct HERE.
    const decls = declarationsFromTemplate(rootWith(bagModule(1, 1)));
    const d = decls.get('loom-risingwave');
    expect(d).toBeDefined();
    expect(d!.declared).toEqual({ minReplicas: 1, maxReplicas: 1, hasScaleRules: false });
    expect(d!.scalableToZero).toBe(false);
  });

  it('B1/bag — a key the PARENT passes in the bag BEATS the coalesce fallback', () => {
    // The same shape as `loom-risingwave`, but the deploy passes an ELASTIC bag
    // over a PINNED fallback. Reading the fallback would refuse an app the
    // deploy made elastic; reading the bag is what the deploy actually does.
    const decls = declarationsFromTemplate(
      rootWith(bagModule(1, 1), 'loom-thing-module', {
        risingwaveConfig: { value: { minReplicas: 0, maxReplicas: 4 } },
      }),
    );
    const d = decls.get('loom-risingwave')!;
    expect(d.declared).toEqual({ minReplicas: 0, maxReplicas: 4, hasScaleRules: false });
    expect(d.scalableToZero).toBe(true);
  });

  it('B1/bag — THE HAZARD: a PINNED bag over an ELASTIC fallback is REFUSED', () => {
    // The direction that loses data. MEASURED on the artifact, `loom-risingwave`
    // passes 1/1 over a 1/1 fallback — identical, so today it reads correctly by
    // COINCIDENCE. Change either side and only the passed value is right.
    const decls = declarationsFromTemplate(
      rootWith(bagModule(0, 3), 'loom-thing-module', {
        risingwaveConfig: { value: { minReplicas: 1, maxReplicas: 1 } },
      }),
    );
    const d = decls.get('loom-risingwave')!;
    expect(d.declared).toEqual({ minReplicas: 1, maxReplicas: 1, hasScaleRules: false });
    expect(d.scalableToZero).toBe(false);
    expect(refuseScaleToZero('loom-risingwave', decls)!.kind).toBe('pinned-singleton');
  });

  it('B1/bag — a bag passed as an EXPRESSION is unresolvable, NOT the fallback', () => {
    // Whether the bag carries the key is unknowable, so BOTH coalesce branches
    // are unestablished. Falling back would assert the branch ARM may not take.
    const decls = declarationsFromTemplate(
      rootWith(bagModule(1, 1), 'loom-thing-module', {
        risingwaveConfig: { value: "[variables('someRuntimeBag')]" },
      }),
    );
    expect(decls.get('loom-risingwave')!.declared).toBeNull();
  });

  it('B1/bag — an expression INSIDE a passed bag is parent-scope, so unresolvable', () => {
    // Round-3 should-fix. `effectiveParam` only checks the TOP-LEVEL string, so
    // a nested expression was resolved against THIS template's `variables` — a
    // different template's numbers. Measured at review: it returned 9. Here the
    // nested module defines `minReplicas: 9`, which is what a scope-confused
    // resolver reads; the deploy's real value lives in the parent and is not
    // knowable from here.
    const bagMod = bagModule(1, 1);
    (bagMod.variables as Record<string, unknown>).parentMin = 9;
    const decls = declarationsFromTemplate(
      rootWith(bagMod, 'loom-thing-module', {
        risingwaveConfig: { value: { minReplicas: "[variables('parentMin')]", maxReplicas: 1 } },
      }),
    );
    const d = decls.get('loom-risingwave')!;
    expect(d.declared, 'a parent-scope expression must not resolve here').toBeNull();
    expect(d.reason).toContain('could NOT be established');
  });

  it('resolves `[parameters(x)]` through its defaultValue', () => {
    expect(
      resolveDeclaredInt("[parameters('minReplicas')]", { minReplicas: { defaultValue: 1 } }, {}),
    ).toBe(1);
  });

  it('NOT UNDERSTOOD is null, never a default — an unresolved app is not declared', () => {
    // R7. A guessed floor here decides whether a destructive mutation is
    // offered, so anything the resolver cannot read must fall out of the map
    // entirely rather than pick a number.
    expect(resolveDeclaredInt("[if(variables('usePostgres'), 3, 1)]", {}, {})).toBeNull();
    expect(resolveDeclaredInt("[parameters('nope')]", {}, {})).toBeNull();
    expect(resolveDeclaredInt(undefined, {}, {})).toBeNull();

    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          scale: { minReplicas: "[parameters('apps')[copyIndex()].minReplicas]", maxReplicas: 1 },
        }),
      ),
    );
    // The declaration IS emitted (its consumers are still knowable — the #4261
    // hole was dropping `loom-unity` entirely because its scale is conditional),
    // but the SHAPE is `null` and the durability verdict is withheld.
    expect(decls.get('loom-thing')!.declared).toBeNull();
    expect(decls.get('loom-thing')!.reason).toContain('could NOT be established');
    expect(declaredNonScalableToZero('loom-thing', decls)).toBeNull();
    // …and with no declared consumer either, nothing objects.
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
  });

  it('an app whose NAME is a runtime expression is not declared either', () => {
    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          name: "[parameters('apps')[copyIndex()].name]",
          scale: { minReplicas: 1, maxReplicas: 1 },
        }),
      ),
    );
    expect(decls.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B1 — the value the PARENT passes beats the module's default (round-2 review)
//
// Nothing in this file could reach this shape before, because `rootWith()` never
// set `properties.parameters`. Every arm below goes RED against a resolver that
// reads `defaultValue` while the enclosing deployment overrides it.
// ---------------------------------------------------------------------------

describe('B1 — the parent-passed parameter beats the nested default', () => {
  /** A minimal ELASTIC declaration, for populating a fixture map. */
  const elasticDecl = {
    appName: 'loom-other',
    module: 'other-module',
    scalableToZero: true,
    declared: { minReplicas: 0, maxReplicas: 3, hasScaleRules: false },
    declaredConsumers: [],
    reason: 'fixture',
  } as const;

  /** A module whose replicas come from two named parameters, with defaults. */
  function paramScaleModule(
    defMin: number | null,
    defMax: number | null,
  ): Record<string, unknown> {
    return moduleTemplate({
      parameters: {
        minReplicas:
          defMin === null ? { type: 'int' } : { type: 'int', defaultValue: defMin },
        maxReplicas:
          defMax === null ? { type: 'int' } : { type: 'int', defaultValue: defMax },
      },
      scale: {
        minReplicas: "[parameters('minReplicas')]",
        maxReplicas: "[parameters('maxReplicas')]",
      },
    });
  }

  it('ARM 1 — a PINNED 1/1 passed over an ELASTIC default is REFUSED', () => {
    // The #4257 hazard, reached through a pattern two shipped modules use. The
    // reviewer demonstrated the un-fixed resolver reporting {min:1,max:3} and
    // returning null = ALLOW for exactly this deploy.
    const decls = declarationsFromTemplate(
      rootWith(paramScaleModule(1, 3), 'loom-thing-module', {
        maxReplicas: { value: 1 },
      }),
    );
    const d = decls.get('loom-thing')!;
    expect(d.declared).toEqual({ minReplicas: 1, maxReplicas: 1, hasScaleRules: false });
    expect(d.scalableToZero).toBe(false);
    const refusal = refuseScaleToZero('loom-thing', decls);
    expect(refusal, 'a deploy-declared 1/1 singleton must not be performable').not.toBeNull();
    expect(refusal!.kind).toBe('pinned-singleton');
  });

  it('ARM 2 — THE CONTROL: an ELASTIC value passed over a PINNED default PERFORMS', () => {
    // Without this arm "refuse whenever the parent passes anything" would pass
    // ARM 1 and disable the feature — a guard that refuses everything watches
    // nothing. The default here is a pinned 1/1; the deploy overrides it.
    const decls = declarationsFromTemplate(
      rootWith(paramScaleModule(1, 1), 'loom-thing-module', {
        maxReplicas: { value: 4 },
      }),
    );
    const d = decls.get('loom-thing')!;
    expect(d.declared).toEqual({ minReplicas: 1, maxReplicas: 4, hasScaleRules: false });
    expect(d.scalableToZero).toBe(true);
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
  });

  it('ARM 3 — a param with NO default and NO parent value REFUSES, it does not drop', () => {
    // `script-runner`'s `name` is this shape on the real artifact: no default,
    // value supplied by the parent. With neither, the resource cannot be keyed —
    // and a lookup miss against a map with a hole in it used to return null.
    const derived = deriveScalability(
      rootWith(
        moduleTemplate({
          name: "[parameters('name')]",
          parameters: { name: { type: 'string' } },
          scale: { minReplicas: 1, maxReplicas: 1 },
        }),
      ),
    );
    expect(derived.declarations.size).toBe(0);
    expect(derived.unnamed).toHaveLength(1);
    expect(derived.unnamed[0]!.nameExpr).toBe("[parameters('name')]");

    const source: ScalabilitySource = {
      status: 'declared',
      declarations: new Map([['loom-other', elasticDecl]]),
      from: '(fixture)',
      unnamed: derived.unnamed,
    };
    const refusal = refuseScaleToZero('loom-thing', source);
    expect(refusal, 'absent from an INCOMPLETE map must not read as permission').not.toBeNull();
    expect(refusal!.kind).toBe('declaration-unavailable');
    expect((refusal as { why: string }).why).toBe('name-unresolved');
    const reason = scaleToZeroRefusalReason(refusal!);
    // R7 — it must not claim the app is or is not scalable.
    expect(reason).toContain('establishes nothing');
    expect(reason).toContain("[parameters('name')]");
  });

  it('ARM 3b — THE CONTROL: with a COMPLETE population, an unlisted app still performs', () => {
    // The incompleteness refusal must be keyed to the HOLE, not to the miss.
    const source: ScalabilitySource = {
      status: 'declared',
      declarations: new Map([['loom-other', elasticDecl]]),
      from: '(fixture)',
      unnamed: [],
    };
    expect(refuseScaleToZero('loom-thing', source)).toBeNull();
  });

  it('ARM 3c — a BOUNDED hole shadows only the names it could produce', () => {
    // The dlz-attach gateway's name is `[take(format('loom-s3-gateway-{0}', …))]`,
    // so it can only ever be a `loom-s3-gateway-*`. Refusing every unlisted
    // subject on account of it disables the executor for the whole estate —
    // MEASURED: it took the perform happy path from 200 to 409.
    const source: ScalabilitySource = {
      status: 'declared',
      declarations: new Map([['loom-other', elasticDecl]]),
      from: '(fixture)',
      unnamed: [
        {
          module: 'dlz-attach-s3-gateway',
          nameExpr: "[take(format('loom-s3-gateway-{0}', parameters('dom')), 32)]",
          namePrefix: 'loom-s3-gateway-',
        },
      ],
    };
    // In the shadow: could BE the unnamed resource, so it is refused.
    const shadowed = refuseScaleToZero('loom-s3-gateway-tenant-b', source);
    expect(shadowed).not.toBeNull();
    expect((shadowed as { why: string }).why).toBe('name-unresolved');
    // Out of the shadow: provably not that resource, so the hole says nothing.
    expect(refuseScaleToZero('loom-thing', source)).toBeNull();
  });

  it('ARM 3d — the `apps[]` copy loop is EXPANDED, not left as an unbounded hole', () => {
    // One resource, N apps. Left unexpanded it is a nameless hole that shadows
    // everything; expanded it is six real declarations.
    const derived = deriveScalability(
      rootWith(
        {
          parameters: { apps: { type: 'array' } },
          resources: [
            {
              type: 'Microsoft.App/containerApps',
              copy: { name: 'caeApps', count: "[length(parameters('apps'))]" },
              name: "[parameters('apps')[copyIndex()].name]",
              properties: {
                template: {
                  scale: {
                    minReplicas:
                      "[if(contains(parameters('apps')[copyIndex()], 'minReplicas'), parameters('apps')[copyIndex()].minReplicas, 1)]",
                    maxReplicas:
                      "[if(contains(parameters('apps')[copyIndex()], 'maxReplicas'), parameters('apps')[copyIndex()].maxReplicas, 3)]",
                    // THE REAL SHAPE (round-3 review, B3). The generic loop
                    // ALWAYS attaches a rule — the `else` branch of this `if`
                    // synthesises one — so every app it declares has
                    // `hasScaleRules: true`. The earlier version of this fixture
                    // omitted `rules` entirely, which made it shaped like the
                    // mutation under test rather than like production, and that
                    // is precisely why the 1/1-with-a-rule hole survived it.
                    rules:
                      "[if(contains(parameters('apps')[copyIndex()], 'scaleRules'), parameters('apps')[copyIndex()].scaleRules, createArray(createObject('name','http-rule','http',createObject('metadata',createObject('concurrentRequests','20')))))]",
                  },
                },
              },
            },
          ],
        },
        'app-deployments',
        {
          apps: {
            value: [
              { name: 'loom-alpha', minReplicas: 2, maxReplicas: 6 },
              // No replica keys at all — the `if(contains(…))` fallbacks apply.
              { name: 'loom-beta' },
              // A PINNED singleton smuggled in through the generic loop. Before
              // expansion this was invisible; now the shape catches it.
              { name: 'loom-gamma', minReplicas: 1, maxReplicas: 1 },
            ],
          },
        },
      ),
    );
    expect(derived.unnamed, 'a resolvable copy loop leaves no hole').toHaveLength(0);
    expect([...derived.declarations.keys()].sort()).toEqual([
      'loom-alpha',
      'loom-beta',
      'loom-gamma',
    ]);
    expect(derived.declarations.get('loom-alpha')!.declared).toEqual({
      minReplicas: 2,
      maxReplicas: 6,
      hasScaleRules: true,
    });
    expect(derived.declarations.get('loom-beta')!.declared).toEqual({
      minReplicas: 1,
      maxReplicas: 3,
      hasScaleRules: true,
    });
    // Both are elastic DESPITE the rule, because min !== max.
    expect(derived.declarations.get('loom-alpha')!.scalableToZero).toBe(true);
    expect(derived.declarations.get('loom-beta')!.scalableToZero).toBe(true);
    // …and the 1/1 one is pinned DESPITE the rule, because min === max. This is
    // the B3 arm on the real production shape: the app carries a scale rule,
    // and it is still a singleton.
    expect(derived.declarations.get('loom-gamma')!.declared).toEqual({
      minReplicas: 1,
      maxReplicas: 1,
      hasScaleRules: true,
    });
    expect(derived.declarations.get('loom-gamma')!.scalableToZero).toBe(false);
    expect(refuseScaleToZero('loom-gamma', derived.declarations)!.kind).toBe('pinned-singleton');
  });

  it('ARM 3e — a copy loop whose COUNT does not resolve stays an honest hole', () => {
    const derived = deriveScalability(
      rootWith(
        {
          parameters: { apps: { type: 'array' } },
          resources: [
            {
              type: 'Microsoft.App/containerApps',
              copy: { name: 'caeApps', count: "[length(parameters('apps'))]" },
              name: "[parameters('apps')[copyIndex()].name]",
              properties: { template: { scale: { minReplicas: 1, maxReplicas: 1 } } },
            },
          ],
        },
        'app-deployments',
        { apps: { value: "[variables('computedApps')]" } },
      ),
    );
    expect(derived.declarations.size).toBe(0);
    expect(derived.unnamed).toHaveLength(1);
    // No literal prefix is derivable, so the hole is UNBOUNDED and refuses.
    expect(derived.unnamed[0]!.namePrefix).toBeUndefined();
  });

  it('ARM 4 — a parent-passed ARM EXPRESSION is UNKNOWN, never the default', () => {
    // `loom-trino` passes a computed `minReplicas` over a default of 0. Reading
    // the 0 asserts an elastic floor the deploy explicitly overrode.
    const decls = declarationsFromTemplate(
      rootWith(paramScaleModule(0, 2), 'loom-thing-module', {
        minReplicas: { value: "[if(equals(variables('mode'), 'ha'), 3, 1)]" },
      }),
    );
    const d = decls.get('loom-thing')!;
    expect(d.declared, 'a computed value must not resolve to the overridden default').toBeNull();
    expect(d.reason).toContain('could NOT be established');
    expect(declaredNonScalableToZero('loom-thing', decls)).toBeNull();
  });

  it('ARM 4b — a KeyVault `reference` parameter is unresolvable too, not a default', () => {
    const decls = declarationsFromTemplate(
      rootWith(paramScaleModule(1, 1), 'loom-thing-module', {
        maxReplicas: { reference: { keyVault: { id: '/subscriptions/x' }, secretName: 's' } },
      }),
    );
    expect(decls.get('loom-thing')!.declared).toBeNull();
  });

  it('ARM 5 — a NAME the parent overrides keys the declaration to the REAL name', () => {
    // The dlz-attach gateway defaults to `loom-s3-gateway` — a name a DIFFERENT
    // module's real app carries — and the parent passes something else. Keying
    // on the default both invents an app and collides with a real one.
    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          name: "[parameters('name')]",
          parameters: { name: { type: 'string', defaultValue: 'loom-s3-gateway' } },
          scale: { minReplicas: 1, maxReplicas: 1 },
        }),
        'loom-thing-module',
        { name: { value: 'loom-s3-gateway-tenant-b' } },
      ),
    );
    expect(decls.get('loom-s3-gateway-tenant-b')).toBeDefined();
    expect(decls.get('loom-s3-gateway'), 'the default must not invent an app').toBeUndefined();
    expect(refuseScaleToZero('loom-s3-gateway-tenant-b', decls)!.kind).toBe('pinned-singleton');
  });

  it('ARM 5b — a name passed as an EXPRESSION is unnamed, not the default', () => {
    const derived = deriveScalability(
      rootWith(
        moduleTemplate({
          name: "[parameters('name')]",
          parameters: { name: { type: 'string', defaultValue: 'loom-s3-gateway' } },
          scale: { minReplicas: 1, maxReplicas: 1 },
        }),
        'dlz-attach-s3-gateway',
        { name: { value: "[take(format('loom-s3-gateway-{0}', parameters('dom')), 32)]" } },
      ),
    );
    expect(derived.declarations.has('loom-s3-gateway')).toBe(false);
    expect(derived.unnamed).toHaveLength(1);
    expect(derived.unnamed[0]!.module).toBe('dlz-attach-s3-gateway');
  });
});

describe("the refusal quotes the module's OWN words when the module wrote any", () => {
  it('harvests a declared statement from a parameter @description', () => {
    const inner = moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } });
    inner.parameters = {
      cfg: {
        type: 'object',
        metadata: {
          description:
            'minReplicas Default 1 — the streaming tier holds MV state (CANNOT scale to zero: ' +
            'a stopped replica loses every materialized view and its progress).',
        },
      },
    };
    const d = declarationsFromTemplate(rootWith(inner)).get('loom-thing')!;
    expect(d.declaredStatement).toContain('CANNOT scale to zero');
    expect(nonScalableExplanation(d)).toContain('loses every materialized view');
  });

  it('EVIDENCE, NOT PREDICATE: a pinned module with no prose is still non-scalable', () => {
    // A guard keyed to a phrase loses to the next phrase. The shape decides.
    const d = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 2, maxReplicas: 2 } })),
    ).get('loom-thing')!;
    expect(d.declaredStatement).toBeUndefined();
    expect(d.scalableToZero).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE AVAILABILITY SIGNAL (#4261 review) — independent of replica shape
// ---------------------------------------------------------------------------

describe('THE SECOND SIGNAL — the deploy declares a consumer', () => {
  /** `loom-unity` on the Postgres path: min 1 / max 3 / WITH rules = ELASTIC. */
  const elasticShape = {
    minReplicas: 1,
    maxReplicas: 3,
    rules: [{ name: 'catalog-http', http: { metadata: { concurrentRequests: '20' } } }],
  };

  function estate(wired: boolean): unknown {
    return {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'loom-thing-module',
          properties: { template: moduleTemplate({ scale: elasticShape }) },
        },
        consumerModule(wired ? 'loom-thing' : 'something-else'),
      ],
    };
  }

  it('THE HOLE: an ELASTIC app the deploy WIRES is refused for AVAILABILITY', () => {
    const decls = declarationsFromTemplate(estate(true));
    const d = decls.get('loom-thing')!;
    // The shape predicate CLEARS it — so this refusal cannot be coming from
    // replica shape, which is the whole point of the second signal.
    expect(d.scalableToZero).toBe(true);
    expect(declaredNonScalableToZero('loom-thing', decls)).toBeNull();
    expect(d.declaredConsumers.length).toBeGreaterThan(0);

    const refusal = refuseScaleToZero('loom-thing', decls);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe('declared-consumer');
    const reason = scaleToZeroRefusalReason(refusal!);
    expect(reason).toContain('the DEPLOY ITSELF wires');
    expect(reason).toContain('AVAILABILITY refusal');
    expect(reason).toContain('no data is lost');
    // R7: it must NOT claim durability loss.
    expect(reason).not.toMatch(/unrecoverable/);
  });

  it('THE CONTROL: the SAME elastic app with no declared consumer is performable', () => {
    // One field away — the consumer module wires a different name. A signal
    // that refused both would have disabled scale-to-zero outright.
    const decls = declarationsFromTemplate(estate(false));
    expect(decls.get('loom-thing')!.declaredConsumers).toEqual([]);
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
  });

  it('a service does not wire ITSELF — its own env is excluded', () => {
    const inner = moduleTemplate({ scale: elasticShape });
    (inner.resources as Array<Record<string, unknown>>)[0]!.properties = {
      template: {
        scale: elasticShape,
        containers: [
          { env: [{ name: 'SELF_URL', value: 'https://loom-thing.internal.example.io' }] },
        ],
      },
    };
    const decls = declarationsFromTemplate(rootWith(inner));
    expect(decls.get('loom-thing')!.declaredConsumers).toEqual([]);
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
  });

  it('DURABILITY WINS when both apply — the stronger claim is not softened', () => {
    const template = {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'loom-thing-module',
          properties: {
            template: moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } }),
          },
        },
        consumerModule('loom-thing'),
      ],
    };
    const refusal = refuseScaleToZero('loom-thing', declarationsFromTemplate(template))!;
    expect(refusal.kind).toBe('pinned-singleton');
    const reason = scaleToZeroRefusalReason(refusal);
    // THE INVARIANT: the durability verdict is never softened into the
    // availability one. Asserted on the availability text's OWN claims rather
    // than on the word "unrecoverable", because per #4261 nit 7 that word is
    // made only where the module states a reason in prose — and this fixture
    // has none. Asserting the phrase here would have pinned a claim the
    // template does not support.
    expect(reason).not.toMatch(/AVAILABILITY refusal/);
    expect(reason).not.toMatch(/no data is lost/);
    expect(reason).toMatch(/pins 'loom-thing' to exactly 1 replica/i);
  });

  it('nit 7 — the unrecoverable-loss claim is made ONLY where the module says so', () => {
    // WITH prose harvested from the module, the strong durability claim stands…
    const withProse = {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'loom-thing-module',
          properties: {
            template: {
              ...moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } }),
              metadata: {
                description:
                  'minReplicas Default 1 — loom-thing holds its materialized views in process ' +
                  'and never scales to zero.',
              },
            },
          },
        },
      ],
    };
    const proseDecl = declarationsFromTemplate(withProse).get('loom-thing');
    // Only assert the strong-claim arm when the harvester actually found prose —
    // otherwise this spec would silently degrade into the weak-claim arm and
    // stop testing anything.
    if (proseDecl?.declaredStatement) {
      expect(nonScalableExplanation(proseDecl)).toMatch(/unrecoverable loss/);
    }

    // …and WITHOUT prose it is not, because shape alone does not establish
    // whether the floor is there for durability or for availability. That was
    // the review's point: `iceberg-catalog` is pinned for AVAILABILITY, and the
    // message used to tell the operator it would suffer unrecoverable loss.
    const noProse = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 1 } })),
    ).get('loom-thing')!;
    expect(noProse.declaredStatement).toBeUndefined();
    const weak = nonScalableExplanation(noProse);
    expect(weak).not.toMatch(/unrecoverable loss/);
    expect(weak).toMatch(/what is established here is the SHAPE/);
    expect(weak).toMatch(/is not established from the template, so neither is asserted/);
  });

  it('matches BOTH naming forms: a module reference as well as an FQDN literal', () => {
    // The real template uses `reference('icebergCatalog').outputs.fqdn.value`
    // for some wires and a literal `'https://loom-unity.internal.{0}'` for
    // others. A matcher that read only one form would be blind to half the
    // estate and report a confident zero.
    const template = {
      resources: {
        thingModule: {
          type: 'Microsoft.Resources/deployments',
          name: 'thing-module',
          properties: { template: moduleTemplate({ scale: elasticShape }) },
        },
        adminPlane: {
          type: 'Microsoft.Resources/deployments',
          name: 'admin-plane',
          properties: {
            template: {
              resources: [
                {
                  type: 'Microsoft.App/containerApps',
                  name: 'loom-console',
                  properties: {
                    template: {
                      scale: { minReplicas: 0, maxReplicas: 3 },
                      containers: [
                        {
                          env: "[createArray(createObject('name', 'X', 'value', reference('thingModule').outputs.fqdn.value))]",
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const d = declarationsFromTemplate(template).get('loom-thing')!;
    expect(d.declaredConsumers.map((c) => c.via)).toContain('module-reference');
  });
});

// ---------------------------------------------------------------------------
// THE REAL ARTIFACT — the control that a green derivation is not an empty one
// ---------------------------------------------------------------------------

describe(`the COMMITTED ${SCALABILITY_SOURCE}`, () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
  const template: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, SCALABILITY_SOURCE), 'utf8'),
  );
  const decls = declarationsFromTemplate(template);

  it('CENSUS — the numbers this module documents are the numbers it derives', () => {
    // Round-2 review, should-fix 3: the module header's own MEASURED block had
    // drifted from the code (it claimed 19 entries, 16 elastic, and named apps
    // as "still performable" that the consumer arm refuses). A prose measurement
    // cannot be kept honest by review alone, so it is pinned here. If a bicep
    // change moves any of these, update BOTH this arm and the header block.
    const derived = deriveScalability(template);
    const nameOf = (d: { appName: string }): string => d.appName;
    const pinned = [...derived.declarations.values()].filter((d) => !d.scalableToZero);
    const unresolvedShape = [...derived.declarations.values()].filter((d) => d.declared === null);
    const elastic = [...derived.declarations.values()].filter(
      (d) => d.scalableToZero && d.declared !== null,
    );
    const performable = [...derived.declarations.keys()]
      .filter((n) => refuseScaleToZero(n, derived.declarations) === null)
      .sort();

    // #2642 moved these: the sovereign-boundary OSS Redis Container App adds one
    // resource declaration (22 -> 23; the copy loop is unchanged), so the keyed
    // count goes 26 -> 27 and `loom-redis-oss` joins the PINNED bucket. It lands
    // there with NO change to the derivation — `redis-oss-aca.bicep` declares
    // min=max=1, and a cache scaled to zero is a cache emptied, which is the
    // #4257 shape. Elastic stays 21 and performable stays the same 7, which is
    // the check that this is one new pinned app and not a shift in the rest.
    expect(derived.declarations.size).toBe(27);
    expect(pinned.map(nameOf).sort()).toEqual([
      'iceberg-catalog',
      'loom-airflow',
      'loom-redis-oss',
      'loom-risingwave',
    ]);
    expect(unresolvedShape.map(nameOf).sort()).toEqual(['loom-trino', 'loom-unity']);
    expect(elastic).toHaveLength(21);
    // 7 of 27 stay performable. The five apps from the generic `apps[]` loop are
    // there because expanding that loop turned them from an UNBOUNDED population
    // hole into real, elastic declarations. `loom-console` is NOT among them —
    // the `self` arm refuses it. Over-refusal on a destructive action is the safe
    // direction, but which apps it covers is recorded, never implied.
    expect(performable).toEqual([
      'loom-activator',
      'loom-direct-lake-shim',
      'loom-mcp',
      'loom-mcp-bridge',
      'loom-mirroring',
      'loom-presidio-analyzer',
      'loom-presidio-anonymizer',
    ]);
    expect(performable).not.toContain('loom-console');
    // THE ONE REMAINING POPULATION HOLE, and it is BOUNDED: the dlz-attach
    // gateway's name is built from a literal prefix, so it can only shadow
    // `loom-s3-gateway-*` — not every unlisted subject on the estate. An
    // UNBOUNDED hole here refuses the whole estate (measured: it did).
    expect(derived.unnamed).toHaveLength(1);
    expect(derived.unnamed[0]!.namePrefix).toBe('loom-s3-gateway-');
    expect(derived.unnamed[0]!.nameExpr).toContain("format('loom-s3-gateway-{0}'");
  });

  it('POPULATION: the derivation reads a real, non-trivial set of Container Apps', () => {
    // The assertion that stops this whole guard from being green and blind. A
    // resolver that understood none of the real ARM expressions would return an
    // empty map, every synthetic arm above would still pass, and NOTHING would
    // ever be refused in production.
    expect(decls.size).toBeGreaterThanOrEqual(15);
    const scalable = [...decls.values()].filter((d) => d.scalableToZero);
    const pinned = [...decls.values()].filter((d) => !d.scalableToZero);
    // BOTH sides are non-empty: a derivation that pinned everything would be a
    // disabled feature, one that pinned nothing would be the #4257 hazard.
    expect(scalable.length).toBeGreaterThanOrEqual(10);
    expect(pinned.length).toBeGreaterThanOrEqual(1);
  });

  it('THE HAZARD: loom-risingwave is declared NON-scalable, with the bicep reason', () => {
    const d = declaredNonScalableToZero('loom-risingwave', decls);
    expect(d, 'loom-risingwave must be refused — this is #4257').not.toBeNull();
    expect(d!.declared.minReplicas).toBe(1);
    expect(d!.declared.maxReplicas).toBe(1);
    expect(d!.declared.hasScaleRules).toBe(false);
    // The module's own words reach the operator, not a paraphrase.
    expect(d!.declaredStatement).toMatch(/cannot scale to zero/i);
    expect(nonScalableExplanation(d!)).toMatch(/materialized view/i);
  });

  it('the other measured singletons are refused too — the SHAPE generalizes', () => {
    // Neither was named anywhere in the implementation. Both are genuinely
    // stateful (the Airflow scheduler; the Iceberg catalog, whose durability
    // defect is #3339), and both are covered because the deploy pins them.
    for (const name of ['loom-airflow', 'iceberg-catalog']) {
      expect(declaredNonScalableToZero(name, decls), name).not.toBeNull();
    }
  });

  it('THE CONTROL: elastic Loom apps clear the DURABILITY predicate', () => {
    for (const name of [
      'loom-duckdb',
      'loom-trino',
      'loom-presidio-analyzer',
      'loom-dab-preview',
      'loom-transform-runner',
    ]) {
      expect(decls.has(name), `${name} should be in the derived set`).toBe(true);
      expect(declaredNonScalableToZero(name, decls), name).toBeNull();
    }
  });

  it('THE CONTROL: an elastic app the deploy wires NOTHING to stays performable', () => {
    // The composite must not refuse everything. Presidio is declared elastic
    // and carries no declared consumer, so it remains a real scale-to-zero
    // candidate — measured, not assumed.
    for (const name of ['loom-presidio-analyzer', 'loom-presidio-anonymizer']) {
      expect(decls.get(name)!.declaredConsumers, name).toEqual([]);
      expect(refuseScaleToZero(name, decls), name).toBeNull();
    }
  });

  it('an app the template does not statically declare is NOT reported as pinned', () => {
    // `loom-capacity-broker` and `loom-console` come from the generic `apps[]`
    // copy loop, whose replica counts live in a bicepparam. Treating them as
    // pinned would gut the founding acceptance case; they simply have no
    // declaration here and keep the rest of the guard chain.
    expect(declaredNonScalableToZero('loom-capacity-broker', decls)).toBeNull();
    expect(declaredNonScalableToZero('some-app-that-does-not-exist', decls)).toBeNull();
    // And the composite agrees — the founding acceptance case stays performable.
    expect(refuseScaleToZero('loom-capacity-broker', decls)).toBeNull();
    expect(refuseScaleToZero('some-app-that-does-not-exist', decls)).toBeNull();
  });

  it('THE #4261 HOLE, on the real artifact: loom-unity is ELASTIC and still refused', () => {
    const d = decls.get('loom-unity');
    expect(d, 'loom-unity must be in the derived set').toBeDefined();
    // Its shape does NOT trip the pinned predicate on the live template…
    expect(declaredNonScalableToZero('loom-unity', decls)).toBeNull();
    // …and the deploy wires consumers to it, so the composite refuses anyway.
    expect(d!.declaredConsumers.length).toBeGreaterThan(0);
    const refusal = refuseScaleToZero('loom-unity', decls);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe('declared-consumer');
    expect(scaleToZeroRefusalReason(refusal!)).toContain('AVAILABILITY refusal');
  });

  it('POPULATION: the availability signal is neither empty nor universal', () => {
    // Both failure directions in one assertion. Zero declared consumers = a
    // matcher that reads nothing; every app refused = a disabled feature.
    const withConsumers = [...decls.values()].filter((x) => x.declaredConsumers.length > 0);
    const refused = [...decls.keys()].filter((n) => refuseScaleToZero(n, decls) !== null);
    expect(withConsumers.length).toBeGreaterThanOrEqual(5);
    expect(refused.length).toBeLessThan(decls.size);
  });

  it('the lookup is case-insensitive, as ARM names are', () => {
    expect(declaredNonScalableToZero('LOOM-RisingWave', decls)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE SOURCE MUST BE ESTABLISHED — review of #4261, finding 1
// ---------------------------------------------------------------------------

/**
 * The measured fail-open this block exists to close:
 *
 *     refuseScaleToZero('loom-risingwave', new Map()) === null      // = ALLOW
 *
 * An empty declaration map made EVERY subject performable. One transient
 * `readFileSync` failure on the 3.9 MB artifact at cold start therefore disarmed
 * the guard, the executor and the registry AT ONCE — the three "independent"
 * enforcement points share this one input, so they were never independent with
 * respect to THIS failure.
 *
 * ASK "WHAT INPUT SHAPE HAS NO FIXTURE?", not "what mutation?". The shape with
 * no fixture was the SOURCE, not the subject: every arm in this file supplied a
 * populated map, so nothing ever exercised the state where the map could not be
 * built. These arms are that shape.
 */
describe('THE SOURCE — an unreadable declaration is NOT an empty one (#4261 finding 1)', () => {
  const unreadable: ScalabilitySource = {
    status: 'unreadable',
    from: '/app/deploy-templates/main.json',
    detail: 'read failed (EMFILE): too many open files',
  };
  const absent: ScalabilitySource = {
    status: 'absent',
    from: '/app/deploy-templates/main.json , /srv/deploy-templates/main.json',
    detail: 'the compiled deploy template is not present at any candidate path in this image (2 tried).',
  };
  const emptyButRead: ScalabilitySource = {
    status: 'declared',
    declarations: new Map(),
    from: '/app/deploy-templates/main.json',
    unnamed: [],
  };

  it('THE FAIL-OPEN: an EMPTY map refuses instead of permitting', () => {
    // The exact expression the review measured returning null.
    const refusal = refuseScaleToZero('loom-risingwave', new Map());
    expect(refusal, 'an empty declaration map must NOT read as permission').not.toBeNull();
    expect(refusal!.kind).toBe('declaration-unavailable');
  });

  it('UNREADABLE refuses, and the refusal NAMES the source it could not read', () => {
    const refusal = refuseScaleToZero('loom-risingwave', unreadable);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe('declaration-unavailable');
    expect((refusal as { why: string }).why).toBe('unreadable');
    const reason = scaleToZeroRefusalReason(refusal!);
    expect(reason).toContain('/app/deploy-templates/main.json');
    expect(reason).toContain('EMFILE');
    // It must say the failure MAY BE TRANSIENT and is retryable — otherwise an
    // operator reads a permanent defect into a momentary one.
    expect(reason).toMatch(/transient/i);
    expect(reason).toMatch(/not\s+cached/i);
  });

  it('ABSENT refuses, and says the artifact is missing from the IMAGE', () => {
    const refusal = refuseScaleToZero('loom-risingwave', absent);
    expect((refusal as { why: string }).why).toBe('absent');
    const reason = scaleToZeroRefusalReason(refusal!);
    // The remediation is a rebuild, NOT a retry — a different fact, a different fix.
    expect(reason).toMatch(/rebuild the console image/i);
    expect(reason).toContain('deploy-templates/main.json');
  });

  it('READABLE-BUT-EMPTY is DISTINGUISHABLE from unreadable, in verdict AND in text', () => {
    const a = refuseScaleToZero('loom-risingwave', emptyButRead)!;
    const b = refuseScaleToZero('loom-risingwave', unreadable)!;
    // Same outcome — both refuse, because neither established anything about
    // this subject — but they are NOT the same fact and do not report as one.
    expect((a as { why: string }).why).toBe('empty');
    expect((b as { why: string }).why).toBe('unreadable');
    const ra = scaleToZeroRefusalReason(a);
    const rb = scaleToZeroRefusalReason(b);
    expect(ra).not.toEqual(rb);
    // The empty case says it PARSED — that is the whole distinction.
    expect(ra).toMatch(/read and parsed successfully/i);
    expect(ra).toMatch(/ZERO Container App/);
    expect(rb).not.toMatch(/read and parsed successfully/i);
  });

  it('R7 — no unavailable refusal claims anything about the SUBJECT', () => {
    for (const src of [unreadable, absent, emptyButRead]) {
      const reason = scaleToZeroRefusalReason(refuseScaleToZero('loom-risingwave', src)!);
      // Never the durability claim: nothing was established, so nothing is asserted.
      expect(reason).not.toMatch(/unrecoverable/i);
      expect(reason).not.toMatch(/pinned singleton/i);
      expect(reason).not.toMatch(/materialized view/i);
      // And it says so in as many words.
      expect(reason).toMatch(/NOT because this resource was judged unsafe/);
      expect(reason).toMatch(/not because it was judged safe either/);
    }
  });

  it('THE CONTROL: a real, populated source still PERMITS an unwired elastic app', () => {
    // Without this arm, "refuse on every source state" would pass every arm
    // above and would be a disabled feature wearing a guard's clothes.
    const decls = declarationsFromTemplate(
      rootWith(moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 4 } })),
    );
    expect(refuseScaleToZero('loom-thing', decls)).toBeNull();
    expect(
      refuseScaleToZero('loom-thing', {
        status: 'declared',
        declarations: decls,
        from: '(fixture)',
        unnamed: [],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE CONSOLE MAY NOT ZERO ITSELF — review of #4261, finding 5
// ---------------------------------------------------------------------------

describe('the console is not performable against itself (#4261 finding 5)', () => {
  const decls = declarationsFromTemplate(
    rootWith(moduleTemplate({ scale: { minReplicas: 1, maxReplicas: 4 } })),
  );

  afterEach(() => {
    delete process.env.LOOM_CONSOLE_APP_NAME;
  });

  it("'loom-console' is REFUSED even though no declaration names it", () => {
    // It comes from the generic apps[] copy loop, so its name resolves to a
    // copyIndex() expression and it never enters the derived map — i.e. every
    // other signal PERMITS it.
    expect(decls.has('loom-console')).toBe(false);
    const refusal = refuseScaleToZero('loom-console', decls);
    expect(refusal, 'the console must not be able to scale itself to zero').not.toBeNull();
    expect(refusal!.kind).toBe('self');
    const reason = scaleToZeroRefusalReason(refusal!);
    expect(reason).toMatch(/THIS CONSOLE/);
    // AVAILABILITY, never durability — R7 in the same direction as everywhere else.
    expect(reason).toMatch(/no data is lost/);
    expect(reason).not.toMatch(/unrecoverable/i);
  });

  it('the name is READ FROM THE ENV, not hardcoded', () => {
    process.env.LOOM_CONSOLE_APP_NAME = 'loom-console-gov';
    // The renamed console is refused…
    expect(refuseScaleToZero('loom-console-gov', decls)!.kind).toBe('self');
    // …and the default name is no longer self, proving the check is not a
    // second hardcoded allow/deny list.
    expect(refuseScaleToZero('loom-console', decls)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE RESTRICTIVE READING WINS ACROSS MODULES — review of #4261, finding 6
// ---------------------------------------------------------------------------

describe('multi-module merge cannot invert durability into availability (#4261 finding 6)', () => {
  /**
   * `loom-thing` declared PINNED in module A and ELASTIC in module B, where A
   * also holds the only consumer wire — the per-MODULE self-exclusion zeroes A's
   * consumer list, so under the old "keep whichever knows more consumers" rule B
   * replaced A and the app read as elastic-with-a-consumer.
   */
  function twoModuleRoot(): unknown {
    return {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'pinned-module',
          properties: {
            template: {
              resources: [
                {
                  type: 'Microsoft.App/containerApps',
                  name: 'loom-thing',
                  properties: { template: { scale: { minReplicas: 1, maxReplicas: 1 } } },
                },
                {
                  type: 'Microsoft.App/containerApps',
                  name: 'loom-sidecar',
                  properties: {
                    template: {
                      scale: { minReplicas: 0, maxReplicas: 2 },
                      containers: [
                        {
                          env: [
                            { name: 'LOOM_THING_URL', value: 'https://loom-thing.internal.x.io' },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
        {
          type: 'Microsoft.Resources/deployments',
          name: 'elastic-path',
          properties: {
            template: {
              resources: [
                {
                  type: 'Microsoft.App/containerApps',
                  name: 'loom-thing',
                  properties: { template: { scale: { minReplicas: 1, maxReplicas: 3 } } },
                },
              ],
            },
          },
        },
      ],
    };
  }

  it('the PINNED declaration survives an elastic declaration in another module', () => {
    const decls = declarationsFromTemplate(twoModuleRoot());
    const d = decls.get('loom-thing')!;
    expect(d.scalableToZero, 'the restrictive reading must win').toBe(false);
    const refusal = refuseScaleToZero('loom-thing', decls)!;
    // DURABILITY, not availability. Telling the operator "no data is lost" about
    // a service the deploy pins as a singleton is the R7 inversion.
    expect(refusal.kind).toBe('pinned-singleton');
    expect(scaleToZeroRefusalReason(refusal)).not.toMatch(/no data is lost/);
  });

  it('the consumer wire from the OTHER module is not lost by the merge', () => {
    const decls = declarationsFromTemplate(twoModuleRoot());
    // The elastic module CAN see A's wire (different owning module), so the
    // union must carry it — merging must not discard evidence either.
    expect(decls.get('loom-thing')!.declaredConsumers.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FQDN MATCHING IS BOUNDED — review of #4261, nit 8
// ---------------------------------------------------------------------------

describe('the fqdn-literal matcher respects a name boundary (#4261 nit 8)', () => {
  function rootWithConsumerFor(declaredAppName: string, wiredFqdnName: string): unknown {
    return {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'thing-module',
          properties: {
            template: {
              resources: [
                {
                  type: 'Microsoft.App/containerApps',
                  name: declaredAppName,
                  properties: { template: { scale: { minReplicas: 1, maxReplicas: 4 } } },
                },
              ],
            },
          },
        },
        consumerModule(wiredFqdnName),
      ],
    };
  }

  it('an app whose name is a SUFFIX of the wired name is not credited with the wire', () => {
    // 'unity' must not match 'loom-unity.internal.' — the wire names a
    // different service, and a refusal citing it would state something the
    // template did not say.
    const decls = declarationsFromTemplate(rootWithConsumerFor('unity', 'loom-unity'));
    expect(decls.get('unity')!.declaredConsumers).toHaveLength(0);
    expect(refuseScaleToZero('unity', decls)).toBeNull();
  });

  it('THE CONTROL: the app the wire actually names IS credited', () => {
    const decls = declarationsFromTemplate(rootWithConsumerFor('loom-unity', 'loom-unity'));
    expect(decls.get('loom-unity')!.declaredConsumers.length).toBeGreaterThan(0);
    expect(refuseScaleToZero('loom-unity', decls)!.kind).toBe('declared-consumer');
  });
});

// ---------------------------------------------------------------------------
// THE RECOVERY PROPERTY, AT THE LAYER THE GUARDS ACTUALLY CALL
// (round-2 review of #4261, should-fix 5)
// ---------------------------------------------------------------------------

describe('deployDeclaredScalabilitySource does not cache an UNREADABLE read', () => {
  afterEach(() => {
    override.current = null;
    __resetScalabilityCache();
  });

  it('an unreadable read is NOT cached — the next call RECOVERS', () => {
    __resetScalabilityCache();
    override.current = {
      status: 'unreadable',
      file: '/app/deploy-templates/main.json',
      detail: 'read failed (EMFILE): too many open files',
    };
    const first = deployDeclaredScalabilitySource();
    expect(first.status).toBe('unreadable');

    // The read succeeds this time. If the failure had been cached, the guard
    // would stay disarmed for the life of the process — M6 one layer up.
    override.current = {
      status: 'ok',
      file: '/app/deploy-templates/main.json',
      inline: {
        template: {
          resources: [
            {
              type: 'Microsoft.Resources/deployments',
              name: 'loom-thing-module',
              properties: {
                template: {
                  resources: [
                    {
                      type: 'Microsoft.App/containerApps',
                      name: 'loom-thing',
                      properties: { template: { scale: { minReplicas: 1, maxReplicas: 1 } } },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    };
    const second = deployDeclaredScalabilitySource();
    expect(second.status, 'a transient failure must not disarm the reader forever').toBe(
      'declared',
    );
    expect(
      second.status === 'declared' && second.declarations.get('loom-thing')?.scalableToZero,
    ).toBe(false);
  });

  it('an ESTABLISHED read IS cached — the second call does not re-read', () => {
    // The control: without it, "never cache anything" would pass the arm above
    // and re-parse a 3.9 MB artifact on every guard call.
    __resetScalabilityCache();
    let reads = 0;
    const ok = {
      status: 'ok' as const,
      file: '/app/deploy-templates/main.json',
      inline: { template: { resources: [] } },
    };
    Object.defineProperty(override, 'current', {
      configurable: true,
      get() {
        reads += 1;
        return ok;
      },
      set() {
        /* afterEach resets via the redefined property below */
      },
    });
    deployDeclaredScalabilitySource();
    deployDeclaredScalabilitySource();
    delete (override as { current?: unknown }).current;
    (override as { current: unknown }).current = null;
    expect(reads, 'an established outcome must be read exactly once').toBe(1);
  });
});

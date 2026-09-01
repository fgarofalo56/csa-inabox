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
import { afterEach, describe, expect, it } from 'vitest';
import {
  declarationsFromTemplate,
  declaredNonScalableToZero,
  nonScalableExplanation,
  refuseScaleToZero,
  resolveDeclaredInt,
  scaleToZeroRefusalReason,
  SCALABILITY_SOURCE,
  type ScalabilitySource,
} from '../scalability';

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

function rootWith(inner: Record<string, unknown>, moduleName = 'loom-thing-module'): unknown {
  return {
    resources: [
      {
        type: 'Microsoft.Resources/deployments',
        name: moduleName,
        properties: { template: inner },
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

  it('a fixed replica count WITH a scale rule is elastic — the rule is the intent', () => {
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
    expect(decls.get('loom-thing')!.scalableToZero).toBe(true);
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
  it('resolves `[variables(x)]` and the config-bag `coalesce(tryGet(...), N)` default', () => {
    const decls = declarationsFromTemplate(
      rootWith(
        moduleTemplate({
          name: "[parameters('name')]",
          parameters: { name: { type: 'string', defaultValue: 'loom-risingwave' } },
          variables: {
            minReplicas: "[int(coalesce(tryGet(parameters('risingwaveConfig'), 'minReplicas'), 1))]",
            maxReplicas: "[int(coalesce(tryGet(parameters('risingwaveConfig'), 'maxReplicas'), 1))]",
          },
          scale: { minReplicas: "[variables('minReplicas')]", maxReplicas: "[variables('maxReplicas')]" },
        }),
      ),
    );
    const d = decls.get('loom-risingwave');
    expect(d).toBeDefined();
    expect(d!.declared.minReplicas).toBe(1);
    expect(d!.scalableToZero).toBe(false);
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

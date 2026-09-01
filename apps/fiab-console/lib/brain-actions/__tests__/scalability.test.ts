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
import { describe, expect, it } from 'vitest';
import {
  declarationsFromTemplate,
  declaredNonScalableToZero,
  nonScalableExplanation,
  resolveDeclaredInt,
  SCALABILITY_SOURCE,
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
    expect(decls.has('loom-thing')).toBe(false);
    expect(declaredNonScalableToZero('loom-thing', decls)).toBeNull();
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

  it('THE CONTROL: elastic Loom apps stay performable — the feature is not disabled', () => {
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

  it('an app the template does not statically declare is NOT reported as pinned', () => {
    // `loom-capacity-broker` and `loom-console` come from the generic `apps[]`
    // copy loop, whose replica counts live in a bicepparam. Treating them as
    // pinned would gut the founding acceptance case; they simply have no
    // declaration here and keep the rest of the guard chain.
    expect(declaredNonScalableToZero('loom-capacity-broker', decls)).toBeNull();
    expect(declaredNonScalableToZero('some-app-that-does-not-exist', decls)).toBeNull();
  });

  it('the lookup is case-insensitive, as ARM names are', () => {
    expect(declaredNonScalableToZero('LOOM-RisingWave', decls)).not.toBeNull();
  });
});

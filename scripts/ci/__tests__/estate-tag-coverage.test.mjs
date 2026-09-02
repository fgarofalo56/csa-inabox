/**
 * estate-tag-coverage self-test (#3922, #4255).
 *
 * The guard's real work — compiling the actual `main.bicep` and judging 300+
 * resources — happens in CI. This suite pins the parts a green CI run does NOT
 * exercise: the failure branches, the refuse-to-pass-vacuously floors, and the
 * expression machinery whose FIRST TWO VERSIONS WERE BOTH WRONG in ways a
 * passing template would have hidden.
 *
 * FIXTURES ARE REAL COMPILER OUTPUT, NOT A GUESS. Every expression string below
 * was copied verbatim out of `az bicep build -f platform/fiab/bicep/main.bicep`
 * (bicep 0.45.15, 2026-09-01). That matters here more than usual, because both
 * bugs this suite now pins came from modelling what the compiler "obviously"
 * emits rather than what it does:
 *
 *   1. The first resolver did textual substitution of `parameters()` /
 *      `variables()`. On the real template that is super-exponential — it died
 *      with `RangeError: Invalid string length`. A hand-written two-level
 *      fixture passes it happily. `expressionReaches` walks the reference graph
 *      instead, so `a deep parameter chain resolves` below is the arm that
 *      would have caught it.
 *
 *   2. The first `LOOM_ESTATE_ID` detector looked for a literal
 *      `{name, value}` object. bicep emits a computed Container App env array
 *      as ONE expression string of `createObject(...)` calls, so it found ZERO
 *      env entries in a template that emitted one. `extractEnvValueExpressions`
 *      exists for that, and the fixture is the actual emitted substring.
 *
 * MUTATION-PROVEN. Each failure arm below mutates the SHAPE the guard depends
 * on, not just the happy path: a resource that drops `tags:`, a tag bag that no
 * longer reaches the key, an estate id built with the full subscription GUID
 * instead of `sub8`, a missing env emission, a NON_TAGGABLE entry that is dead,
 * a NON_TAGGABLE entry that is wrong, and an out-of-band exemption whose
 * applier stopped applying the tag. A guard that only proved the passing case
 * would be the "green while watching nothing" shape this repo keeps measuring.
 *
 * Run: node --test scripts/ci/__tests__/estate-tag-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTATE_ENV_NAME,
  ESTATE_TAG_KEY,
  MIN_NESTED_TEMPLATES,
  MIN_TAGGABLE_RESOURCES,
  NON_TAGGABLE,
  OUT_OF_BAND_TAGGED,
  audit,
  bindNestedParams,
  collectEstateEnv,
  expressionReaches,
  extractEnvValueExpressions,
  hasCanonicalFormat,
  makeScope,
  resourceEntries,
  verdict,
} from '../check-estate-tag-coverage.mjs';

// ── real compiler output, captured 2026-09-01 (bicep 0.45.15) ────────────────

/** `variables('loomTags')` in the compiled root template. */
const REAL_LOOM_TAGS =
  "[union(parameters('complianceTags'), createObject('loom-estate-id', variables('effectiveLoomEstateId')))]";

/** `variables('effectiveLoomEstateId')` in the compiled root template. */
const REAL_ROOT_ESTATE_ID =
  "[if(not(empty(parameters('loomEstateId'))), parameters('loomEstateId'), format('loom:{0}:{1}', substring(variables('effHubSubscriptionId'), 0, 8), variables('adminPlaneRgName')))]";

/** `variables('effectiveLoomEstateId')` in the compiled admin-plane nested template. */
const REAL_ADMIN_ESTATE_ID =
  "[if(not(empty(parameters('loomEstateId'))), parameters('loomEstateId'), format('loom:{0}:{1}', substring(subscription().subscriptionId, 0, 8), resourceGroup().name))]";

/**
 * A slice of the real `apps` parameter expression the admin-plane template
 * passes to `app-deployments.bicep`. This is the shape that defeated the first
 * detector — note that `LOOM_ESTATE_ID` is INSIDE a string, and that the value
 * expression that follows it contains no parentheses of its own while its
 * NEIGHBOURS do, which is what makes a naive "read to the next `)`" wrong.
 */
const REAL_ENV_EXPRESSION =
  "[createArray(createObject('name', 'LOOM_SUBSCRIPTION_ID', 'value', subscription().subscriptionId), " +
  "createObject('name', 'LOOM_ADMIN_RG', 'value', resourceGroup().name), " +
  "createObject('name', 'LOOM_ESTATE_ID', 'value', variables('effectiveLoomEstateId')), " +
  "createObject('name', 'LOOM_SETUP_ORCHESTRATOR_URL', 'value', if(variables('setupOrchestratorActive'), reference('setupOrchestrator').outputs.url.value, '')))]";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * A minimal but STRUCTURALLY REAL template: a root that folds the estate id
 * into a tag bag and passes it down two levels of nested deployment, plus the
 * padding needed to clear the population floors so a shape test is not silently
 * decided by them.
 *
 * @param {object} [opts]
 * @param {string} [opts.tagsVar] the root `loomTags` expression
 * @param {boolean} [opts.emitEnv] emit the LOOM_ESTATE_ID env entry
 * @param {boolean} [opts.leafUntagged] make one leaf resource declare no tags
 */
function makeTemplate(opts = {}) {
  const { tagsVar = REAL_LOOM_TAGS, emitEnv = true, leafUntagged = false } = opts;

  // Enough leaf resources + nested templates to clear both floors. Each leaf
  // reaches the tag key only through `parameters('complianceTags')`, exactly
  // like the real modules do.
  const leafResources = {};
  for (let i = 0; i < 4; i++) {
    leafResources[`store${i}`] = {
      type: 'Microsoft.Storage/storageAccounts',
      name: `s${i}`,
      tags: "[parameters('complianceTags')]",
    };
  }
  if (leafUntagged) {
    leafResources.untagged = { type: 'Microsoft.App/containerApps', name: 'lonely' };
  }
  // Every exemption must be REACHED, or `verdict` fails them as dead entries —
  // which is itself one of the behaviours under test.
  let n = 0;
  for (const type of NON_TAGGABLE.keys()) leafResources[`exempt${n++}`] = { type, name: `e${n}` };
  for (const type of OUT_OF_BAND_TAGGED.keys()) leafResources[`oob${n++}`] = { type, name: `o${n}` };

  const leafTemplate = { variables: {}, resources: leafResources };

  const midResources = {};
  for (let i = 0; i < Math.ceil(MIN_NESTED_TEMPLATES / 2) + 2; i++) {
    midResources[`leaf${i}`] = {
      type: 'Microsoft.Resources/deployments',
      name: `leaf${i}`,
      properties: {
        parameters: { complianceTags: { value: "[parameters('complianceTags')]" } },
        template: leafTemplate,
      },
    };
  }
  if (emitEnv) {
    midResources.apps = {
      type: 'Microsoft.Resources/deployments',
      name: 'apps',
      properties: {
        parameters: { apps: { value: REAL_ENV_EXPRESSION } },
        template: { variables: {}, resources: {} },
      },
    };
  }

  const midTemplate = {
    variables: { effectiveLoomEstateId: REAL_ADMIN_ESTATE_ID },
    resources: midResources,
  };

  const rootResources = {
    adminPlaneRg: { type: 'Microsoft.Resources/resourceGroups', name: 'rg', tags: "[variables('loomTags')]" },
  };
  for (let i = 0; i < 2; i++) {
    rootResources[`plane${i}`] = {
      type: 'Microsoft.Resources/deployments',
      name: `plane${i}`,
      properties: {
        parameters: {
          complianceTags: { value: "[variables('loomTags')]" },
          loomEstateId: { value: "[variables('effectiveLoomEstateId')]" },
        },
        template: midTemplate,
      },
    };
  }

  return {
    $schema: 'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
    variables: {
      loomTags: tagsVar,
      effectiveLoomEstateId: REAL_ROOT_ESTATE_ID,
      effHubSubscriptionId: "[parameters('adminPlaneSubId')]",
      adminPlaneRgName: "[format('rg-csa-loom-admin-{0}', parameters('location'))]",
    },
    resources: rootResources,
  };
}

/** A reader that satisfies the out-of-band applier check. */
const applierPresent = (rel) =>
  rel === OUT_OF_BAND_TAGGED.get('Microsoft.ContainerRegistry/registries').applier
    ? `#!/usr/bin/env bash\nESTATE_TAG_KEY="${ESTATE_TAG_KEY}"\n`
    : null;

// ── expression machinery ─────────────────────────────────────────────────────

test('a deep parameter chain resolves without exploding the string', () => {
  // Regression arm for bug #1: the substituting resolver died on the real
  // template with RangeError. This chain is only three levels but each binding
  // carries a bulky sibling value, which is what made substitution quadratic.
  const bulk = JSON.stringify({ padding: 'x'.repeat(4000) });
  const root = makeScope({ loomTags: REAL_LOOM_TAGS, effectiveLoomEstateId: REAL_ROOT_ESTATE_ID }, new Map());
  const mid = makeScope(
    { junk: bulk },
    bindNestedParams({ complianceTags: { value: "[variables('loomTags')]" }, junk: { value: bulk } }, root),
  );
  const leaf = makeScope(
    { junk: bulk },
    bindNestedParams({ complianceTags: { value: "[parameters('complianceTags')]" }, junk: { value: bulk } }, mid),
  );

  assert.equal(expressionReaches("[parameters('complianceTags')]", leaf, ESTATE_TAG_KEY), true);
  assert.equal(hasCanonicalFormat("[parameters('complianceTags')]", leaf), true);
});

test('an UNBOUND reference fails closed — never "probably fine"', () => {
  const leaf = makeScope({}, new Map());
  assert.equal(expressionReaches("[parameters('complianceTags')]", leaf, ESTATE_TAG_KEY), false);
});

test('a reference CYCLE terminates and does not assert a match', () => {
  const scope = makeScope({ a: "[variables('b')]", b: "[variables('a')]" }, new Map());
  assert.equal(expressionReaches("[variables('a')]", scope, ESTATE_TAG_KEY), false);
});

test('a LITERAL tag object carrying the key is accepted', () => {
  const scope = makeScope({}, new Map());
  assert.equal(expressionReaches({ [ESTATE_TAG_KEY]: 'loom:abcd1234:rg' }, scope, ESTATE_TAG_KEY), true);
});

test('resourceEntries handles both the object and array resource shapes', () => {
  assert.deepEqual(resourceEntries({ a: 1, b: 2 }), [['a', 1], ['b', 2]]);
  assert.deepEqual(resourceEntries([9, 8]), [['0', 9], ['1', 8]]);
  assert.deepEqual(resourceEntries(undefined), []);
});

// ── the env-expression scanner (bug #2) ──────────────────────────────────────

test('extractEnvValueExpressions pulls the value out of a real createObject array', () => {
  const found = extractEnvValueExpressions(REAL_ENV_EXPRESSION, ESTATE_ENV_NAME);
  assert.deepEqual(found, ["variables('effectiveLoomEstateId')"]);
});

test('the scanner is paren-balanced — a nested call in the value is not truncated', () => {
  const text = "createObject('name', 'LOOM_ESTATE_ID', 'value', if(a(), b(c()), 'z')), createObject('name', 'OTHER', 'value', 1)";
  assert.deepEqual(extractEnvValueExpressions(text, ESTATE_ENV_NAME), ["if(a(), b(c()), 'z')"]);
});

test("the scanner is string-aware — a ')' inside an ARM literal does not end the value", () => {
  const text = "createObject('name', 'LOOM_ESTATE_ID', 'value', concat('a)b', d()))";
  assert.deepEqual(extractEnvValueExpressions(text, ESTATE_ENV_NAME), ["concat('a)b', d())"]);
});

test('collectEstateEnv finds the env entry inside a nested deployment PARAMETER', () => {
  // The literal shape the first detector assumed would have found nothing here.
  const out = [];
  const scope = makeScope({ effectiveLoomEstateId: REAL_ADMIN_ESTATE_ID }, new Map());
  collectEstateEnv(
    {
      resources: {
        apps: {
          type: 'Microsoft.Resources/deployments',
          properties: { parameters: { apps: { value: REAL_ENV_EXPRESSION } }, template: { resources: {} } },
        },
      },
    },
    scope,
    '/adminPlane',
    out,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].formatOk, true);
});

// ── the whole guard, on a structurally real template ─────────────────────────

test('the passing shape passes, and it is not passing vacuously', () => {
  const result = audit(makeTemplate());
  assert.deepEqual(verdict(result, applierPresent), []);
  assert.ok(result.covered >= MIN_TAGGABLE_RESOURCES, `covered=${result.covered}`);
  assert.ok(result.nestedTemplates >= MIN_NESTED_TEMPLATES, `nested=${result.nestedTemplates}`);
  assert.equal(result.estateEnv.length, 2); // one per admin-plane instance
});

test('a resource that declares NO tags is reported MISSING', () => {
  const result = audit(makeTemplate({ leafUntagged: true }));
  const fails = verdict(result, applierPresent);
  assert.ok(result.missing.length > 0);
  assert.match(fails.join('\n'), /Microsoft\.App\/containerApps/);
  assert.match(fails.join('\n'), /declares no `tags:` at all/);
});

test('a tag bag that no longer reaches the key is reported MISSING', () => {
  // The most likely real regression: someone drops the `union` and passes the
  // compliance bag straight through.
  const result = audit(makeTemplate({ tagsVar: "[parameters('complianceTags')]" }));
  const fails = verdict(result, applierPresent);
  assert.ok(result.missing.length > 0, 'expected missing resources');
  assert.match(fails.join('\n'), new RegExp(`never reaches .${ESTATE_TAG_KEY}`));
});

test('the FULL-GUID variant of the estate id is rejected', () => {
  // `loom:<whole subscription id>:<rg>` still LOOKS like an estate id and still
  // deploys; it just matches nothing the console computes. This is the drift
  // that produces zero owned resources with no error anywhere.
  const tmpl = makeTemplate();
  tmpl.variables.effectiveLoomEstateId =
    "[format('loom:{0}:{1}', variables('effHubSubscriptionId'), variables('adminPlaneRgName'))]";
  const fails = verdict(audit(tmpl), applierPresent);
  assert.match(fails.join('\n'), /canonical `loom:<sub8>:<rg>` algorithm/);
});

test('a renamed estate-id format is rejected', () => {
  const tmpl = makeTemplate();
  tmpl.variables.effectiveLoomEstateId =
    "[format('estate:{0}:{1}', substring(variables('effHubSubscriptionId'), 0, 8), variables('adminPlaneRgName'))]";
  const fails = verdict(audit(tmpl), applierPresent);
  assert.match(fails.join('\n'), /canonical `loom:<sub8>:<rg>` algorithm/);
});

test('the tag WITHOUT the LOOM_ESTATE_ID env is rejected', () => {
  const fails = verdict(audit(makeTemplate({ emitEnv: false })), applierPresent);
  assert.match(fails.join('\n'), new RegExp(`nothing in the compiled template emits .${ESTATE_ENV_NAME}`));
});

test('an empty template FAILS the population floors rather than reporting a clean estate', () => {
  const fails = verdict(audit({ variables: {}, resources: {} }), applierPresent);
  const joined = fails.join('\n');
  assert.match(joined, /taggable resource\(s\) were found to examine/);
  assert.match(joined, /nested template\(s\) were walked/);
});

// ── the exemptions must stay honest ──────────────────────────────────────────

test('a NON_TAGGABLE type that appears WITH tags fails the exemption, not the resource', () => {
  const tmpl = makeTemplate();
  const midTmpl = tmpl.resources.plane0.properties.template;
  const leafTmpl = midTmpl.resources.leaf0.properties.template;
  leafTmpl.resources.exempt0.tags = "[parameters('complianceTags')]";
  const fails = verdict(audit(tmpl), applierPresent);
  assert.match(fails.join('\n'), /NON_TAGGABLE claims cannot carry tags — but it carries a `tags` property/);
});

test('a NON_TAGGABLE entry the template never reaches is a DEAD exemption and fails', () => {
  const tmpl = makeTemplate();
  const midTmpl = tmpl.resources.plane0.properties.template;
  const leafTmpl = midTmpl.resources.leaf0.properties.template;
  delete leafTmpl.resources.exempt0;
  const fails = verdict(audit(tmpl), applierPresent);
  assert.match(fails.join('\n'), /but the template contains none/);
});

test('the out-of-band exemption fails when its applier no longer stamps the tag', () => {
  // The exemption's whole justification is that a script applies the tag after
  // the apply. If that stops being true the exemption is a hole with a citation.
  const applierWithoutTag = (rel) =>
    rel === OUT_OF_BAND_TAGGED.get('Microsoft.ContainerRegistry/registries').applier ? '#!/usr/bin/env bash\necho hi\n' : null;
  const fails = verdict(audit(makeTemplate()), applierWithoutTag);
  assert.match(fails.join('\n'), new RegExp(`never mentions .${ESTATE_TAG_KEY}`));
});

test('the out-of-band exemption fails when its applier does not exist', () => {
  const fails = verdict(audit(makeTemplate()), () => null);
  assert.match(fails.join('\n'), /and that file does not exist/);
});

test('the exemption lists carry a reason for every entry — no bare type names', () => {
  for (const [type, why] of NON_TAGGABLE) {
    assert.equal(typeof why, 'string', type);
    assert.ok(why.length > 20, `${type} has no substantive recorded reason`);
  }
  for (const [type, spec] of OUT_OF_BAND_TAGGED) {
    assert.ok(spec.applier && spec.applier.length > 0, `${type} names no applier`);
    assert.ok(spec.why && spec.why.length > 20, `${type} has no substantive recorded reason`);
  }
});

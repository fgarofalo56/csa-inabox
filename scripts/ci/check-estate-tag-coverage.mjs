#!/usr/bin/env node
/**
 * GUARDRAIL: every taggable resource the Loom deploy creates must carry the
 * `loom-estate-id` ownership tag, and the Console must read the SAME value.
 * (merge-blocker — #3922, #4255)
 *
 * WHY THIS EXISTS
 * ---------------
 * `loom-estate-id` is the ONLY signal that proves a resource belongs to a given
 * Loom install. Two independent consumers match it by EXACT STRING EQUALITY:
 *
 *   apps/fiab-console/lib/estate/pause-inventory.ts        (what may be paused)
 *   apps/fiab-console/lib/brain/graph/extractors/resource-graph.ts
 *                                                   (what gets an `owns` edge,
 *                                          i.e. which findings are approvable)
 *
 * Nothing else confers ownership, deliberately: RG NAME was measured wrong in
 * both directions on this estate, and `CSA_Loom` / `loom-next-level` /
 * `csa-loom` / `loom-band` / `loom-item` are not estate-scoped (`loom-item` was
 * measured claiming one resource for TWO unrelated estates).
 *
 * And until #3922 NOTHING STAMPED IT. Measured 2026-08-23 across six
 * subscriptions: 105 container-tier resources, ZERO carrying `loom-estate-id`,
 * 29 with no tags at all. The visible consequences were not cosmetic —
 * `dryRunPause` returned `wouldPause: []` against a ~$3k/mo pausable estate
 * while the button rendered and accepted a click, and 0 of 17 Brain
 * recommendations were approvable because `guardOwnership` could not prove even
 * Loom's own `loom-risingwave` was Loom's.
 *
 * THE STAMP IS THE FIX; THIS IS WHAT KEEPS IT. A tag applied once by a merge is
 * one new resource away from a partially-owned estate, and a partially-owned
 * estate is WORSE than an unowned one: the Brain would report a confident
 * inventory that silently omits whatever landed last. #3922's own acceptance
 * criteria name this guard: "A guard asserting new cost-bearing resources carry
 * the tag, so the population cannot silently drop back to zero."
 *
 * WHAT IT CHECKS
 * --------------
 *  1. COVERAGE   — every taggable, non-`existing` resource in the compiled
 *                  template resolves a `tags` expression containing
 *                  `loom-estate-id`.
 *  2. FORMAT     — the estate id is built with the canonical
 *                  `loom:<sub8>:<rg>` algorithm, not an invented one. A
 *                  different format does not error at deploy time; it resolves
 *                  ZERO owned resources, which is indistinguishable from the
 *                  bug being fixed.
 *  3. READER     — the Console environment carries `LOOM_ESTATE_ID`. The tag
 *                  without the env leaves `estateScope()` writing to the
 *                  `'unscoped'` Cosmos partition; the env without the tag
 *                  narrows ownership to a key nothing carries. Both halves or
 *                  neither.
 *
 * IT JUDGES THE SOURCE, NOT THE COMMITTED ARTIFACT. `az bicep build` is run on
 * `platform/fiab/bicep/main.bicep` here rather than reading
 * `apps/fiab-console/deploy-templates/main.json`, so a stale committed artifact
 * can neither mask an untagged resource nor manufacture a false RED. (That
 * artifact's freshness is `check-deploy-template-sync.mjs`'s job; the two guards
 * are deliberately not chained.) Unlike that guard this one does NOT pin a bicep
 * version — the verdict is semantic, not byte-exact, so any compiler that can
 * build the template can answer it.
 *
 * REFUSES TO PASS VACUOUSLY (the repo's "guards that do not watch" class):
 *   - `az` missing / `az bicep build` non-zero / no output  → FAIL, never skip.
 *   - fewer than {@link MIN_TAGGABLE_RESOURCES} taggable resources examined, or
 *     fewer than {@link MIN_NESTED_TEMPLATES} nested templates walked → FAIL.
 *     A resolver that quietly stops descending would otherwise report a clean
 *     estate having looked at the top-level template alone.
 *   - an entry in {@link NON_TAGGABLE} that appears WITH a `tags` property →
 *     FAIL. The exemption would be excusing a type that does carry tags.
 *   - an entry in {@link NON_TAGGABLE} that never appears at all → FAIL. A dead
 *     exemption excuses nothing today and silently excuses whatever lands under
 *     that type name tomorrow.
 *   - an unresolvable `tags` expression → counted as MISSING, never as covered.
 *
 * Usage: node scripts/ci/check-estate-tag-coverage.mjs [repo-root]
 *   The optional argument exists for the self-test; CI passes nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertInterpreterSafeArgs, resolveWindowsInterpreter } from './check-deploy-template-sync.mjs';

/** The bicep this guard compiles and judges. */
export const SOURCE = 'platform/fiab/bicep/main.bicep';

/** The ownership tag key. Same literal `lib/brain/graph/extractors/resource-graph.ts` exports as `LOOM_ESTATE_TAG_KEY`. */
export const ESTATE_TAG_KEY = 'loom-estate-id';

/** The Console env var the two halves must agree on. */
export const ESTATE_ENV_NAME = 'LOOM_ESTATE_ID';

/**
 * The canonical estate-id format, as an ARM `format()` template string.
 *
 * NOT A CHOICE MADE HERE. It is what the two readers already synthesize when
 * `LOOM_ESTATE_ID` is unset, and they compare the result to the tag by exact
 * equality:
 *
 *   apps/fiab-console/lib/estate/pause-orchestrator.ts  resolveEstateId()
 *   apps/fiab-console/lib/brain/run/cli.ts              resolveScanEstateId()
 *       `loom:${sub.slice(0, 8)}:${rg}`
 *
 * A deploy that stamped any other shape would not fail — it would resolve zero
 * owned resources, which reads exactly like the unstamped estate this fixes.
 * That is why the format is asserted and not merely commented.
 */
export const ESTATE_ID_FORMAT = "format('loom:{0}:{1}'";

/** The `sub8` half, asserted alongside the format so a full-GUID variant cannot slip in. */
export const ESTATE_ID_SUB8 = 'substring(';

/**
 * ARM types that CANNOT carry tags, so requiring one would make this guard
 * unsatisfiable rather than useful.
 *
 * MEASURED, not assumed. Each was declared with `tags: {}` in a scratch bicep
 * and compiled with bicep 0.45.15 on 2026-09-01; every one answered
 *
 *   BCP187: The property "tags" does not exist in the resource or type
 *           definition
 *
 * from bicep's own type index. That is the evidence for each line below, and it
 * is re-verifiable in a minute — which matters, because a hand-written
 * "these are not taggable" list is precisely the shape that grows into a
 * blanket exemption nobody rechecks.
 *
 * Two structural safeguards keep it honest, both enforced in {@link audit}:
 *   • an entry that appears WITH a `tags` property is a FAIL (the exemption is
 *     wrong — the type does carry tags);
 *   • an entry that appears NOWHERE is a FAIL (a dead exemption would silently
 *     excuse a future resource of that type).
 */
export const NON_TAGGABLE = new Map([
  ['Microsoft.Authorization/roleAssignments', 'BCP187 — RBAC assignments have no tags property (254 in this template).'],
  ['Microsoft.Authorization/policyAssignments', 'BCP187 — policy assignments carry identity/location but no tags.'],
  ['Microsoft.Insights/diagnosticSettings', 'BCP187 — an extension resource on its target; no tags property.'],
  ['Microsoft.SecurityInsights/alertRules', 'BCP187 — Sentinel extension resource on the LAW; no tags property.'],
  ['Microsoft.SecurityInsights/onboardingStates', 'BCP187 — Sentinel onboarding state; no tags property.'],
  ['Microsoft.SecurityInsights/automationRules', 'BCP187 — Sentinel automation rule; no tags property.'],
  ['Microsoft.Security/pricings', 'BCP187 — Defender plan selection, a subscription setting; no tags property.'],
  ['Microsoft.Consumption/budgets', 'BCP187 — budgets have no tags property (they FILTER on tags instead).'],
]);

/**
 * The ONE resource type that is taggable but must not be tagged declaratively,
 * and the out-of-band applier that tags it instead.
 *
 * `Microsoft.ContainerRegistry/registries` — the Loom admin-plane ACR. Both
 * declarative options were tried and BOTH shipped broken:
 *
 *   #3676  `tags:` on the registry. ARM PUTs top-level tags as an ABSOLUTE
 *          REPLACE, which erased `acr-firewall-lease.sh`'s live mutex
 *          (`loomAcrFw*`) mid-apply and denied an in-flight `az acr build` —
 *          an ~8-minute outage.
 *   #3691  a `Microsoft.Resources/tags` resource that read its own current
 *          value to union into. Its scope expression IS its own resource id,
 *          so ARM refused the template outright ("Circular dependency detected
 *          on resource: …/registries/<acr>/providers/Microsoft.Resources/tags/
 *          default") and every Commercial deploy failed while it was on main.
 *
 * So this exemption is real, not a shortcut — see the long-form record in
 * platform/fiab/bicep/modules/admin-plane/registry.bicep.
 *
 * IT IS NOT A FREE PASS. {@link verdict} requires the named script to exist AND
 * to mention {@link ESTATE_TAG_KEY}: an exemption that points at an applier
 * which does not apply the key is a hole with a citation, which is worse than
 * no exemption at all. Removing the tag from the script therefore turns this
 * guard RED rather than quietly widening it.
 */
export const OUT_OF_BAND_TAGGED = new Map([
  [
    'Microsoft.ContainerRegistry/registries',
    {
      applier: 'scripts/csa-loom/apply-acr-compliance-tags.sh',
      why: '#3676 (declarative `tags:` is an absolute replace and erased the live firewall-lease mutex) and #3691 (a Microsoft.Resources/tags resource is self-referential and ARM refuses the template). Tagged by a server-side `az tag update --operation Merge` after the apply instead.',
    },
  ],
]);

/**
 * Population floors. A resolver that stopped descending, or a template that
 * compiled to almost nothing, must FAIL rather than report a clean estate.
 *
 * Measured on this template at the time of writing: 335 taggable resources
 * across 200+ nested templates. The floors sit well below that so ordinary
 * churn does not trip them, and well above zero so a broken walk cannot pass.
 */
export const MIN_TAGGABLE_RESOURCES = 200;
export const MIN_NESTED_TEMPLATES = 100;

/** Guard against a pathological or cyclic expression graph. */
const MAX_RESOLVE_DEPTH = 24;

// ── pure core (exported for scripts/ci/__tests__/estate-tag-coverage.test.mjs) ──

/** Monotonic scope ids, so the reachability walk can dedupe per (scope, symbol). */
let SCOPE_SEQ = 0;

/**
 * A template's symbol environment.
 *
 * `params` binds each parameter name to the expression the PARENT passed AND
 * the parent's own scope, rather than to a pre-substituted string. That is the
 * whole trick: textual substitution of a template like this one is
 * super-exponential — the first version spliced whole object parameters into
 * each other and died with `RangeError: Invalid string length` on the real
 * `main.bicep`. Keeping a reference plus its scope turns the same question into
 * a linear graph walk.
 *
 * @param {Record<string, unknown>} variables
 * @param {Map<string, {expr: unknown, scope: any}>} params
 */
export function makeScope(variables, params) {
  return { id: ++SCOPE_SEQ, variables: variables || {}, params: params || new Map() };
}

/**
 * Does `expr`, followed through every `parameters()` / `variables()` reference
 * it transitively reaches, mention `needle` anywhere?
 *
 * FAILS CLOSED in every direction: an unbound reference, a cycle, or a depth
 * overrun all end the branch without asserting a match, so the caller reports
 * the resource MISSING. Nothing here can turn "could not tell" into "covered".
 *
 * @param {unknown} expr a `tags` value — an ARM expression string, or a literal object
 * @param {ReturnType<typeof makeScope>} scope
 * @param {string} needle
 * @param {Set<string>} [seen] visited (scope, kind, symbol) triples
 * @param {number} [depth]
 * @returns {boolean}
 */
export function expressionReaches(expr, scope, needle, seen = new Set(), depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  const text = typeof expr === 'string' ? expr : JSON.stringify(expr ?? null);
  if (text.includes(needle)) return true;

  for (const m of text.matchAll(/(parameters|variables)\('([^']+)'\)/g)) {
    const [, kind, name] = m;
    const key = `${scope.id}:${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (kind === 'parameters') {
      const binding = scope.params.get(name);
      if (!binding) continue;
      if (expressionReaches(binding.expr, binding.scope, needle, seen, depth + 1)) return true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(scope.variables, name)) continue;
    if (expressionReaches(scope.variables[name], scope, needle, seen, depth + 1)) return true;
  }
  return false;
}

/**
 * Bind a nested deployment's `properties.parameters` to the PARENT scope.
 *
 * @param {Record<string, unknown>|undefined} parameters
 * @param {ReturnType<typeof makeScope>} parentScope
 * @returns {Map<string, {expr: unknown, scope: any}>}
 */
export function bindNestedParams(parameters, parentScope) {
  const out = new Map();
  for (const [name, spec] of Object.entries(parameters || {})) {
    const expr = spec && typeof spec === 'object' && 'value' in spec ? spec.value : spec;
    out.set(name, { expr, scope: parentScope });
  }
  return out;
}

/**
 * Normalize a template's `resources` into `[symbolicName, resource]` pairs.
 * languageVersion 2.0 emits an OBJECT keyed by symbolic name; older templates
 * emit an ARRAY. Both shapes appear in this tree's nested modules.
 * @param {unknown} resources @returns {Array<[string, any]>}
 */
export function resourceEntries(resources) {
  if (Array.isArray(resources)) return resources.map((r, i) => [String(i), r]);
  if (resources && typeof resources === 'object') return Object.entries(resources);
  return [];
}

/**
 * Walk a compiled ARM template and classify every resource.
 *
 * @param {any} template the compiled template (subscription-scope root)
 * @returns {{
 *   covered: number,
 *   missing: Array<{path: string, type: string, why: string}>,
 *   exempt: Map<string, number>,
 *   outOfBand: Map<string, number>,
 *   wronglyExempt: Array<{path: string, type: string}>,
 *   nestedTemplates: number,
 *   estateEnv: Array<{path: string, formatOk: boolean}>,
 *   taggedSamples: Array<{path: string, formatOk: boolean}>,
 * }}
 */
export function audit(template) {
  const missing = [];
  const wronglyExempt = [];
  const exempt = new Map();
  const outOfBand = new Map();
  const estateEnv = [];
  const taggedSamples = [];
  let covered = 0;
  let nestedTemplates = 1;

  /** @param {any} tmpl @param {Map<string, {expr: unknown, scope: any}>} params @param {string} where */
  function walk(tmpl, params, where) {
    const scope = makeScope(tmpl.variables, params);

    // The READER half. `LOOM_ESTATE_ID` is emitted inside a Container App's env
    // array, which is buried in `properties.template.containers[].env[]`, so it
    // is found by scanning the serialized template rather than by walking a
    // shape that differs per container platform (ACA vs AKS manifests).
    collectEstateEnv(tmpl, scope, where, estateEnv);

    for (const [name, res] of resourceEntries(tmpl.resources)) {
      if (!res || typeof res !== 'object') continue;
      const at = `${where}/${name}`;
      const type = typeof res.type === 'string' ? res.type : '<no type>';

      if (type === 'Microsoft.Resources/deployments') {
        const inner = res.properties && res.properties.template;
        if (!inner) continue;
        nestedTemplates += 1;
        walk(inner, bindNestedParams(res.properties.parameters, scope), at);
        continue;
      }

      // An `existing` reference declares nothing; ARM never writes its tags.
      if (res.existing === true) continue;

      // CHILD resources (Microsoft.X/y/z) are proxy resources that Azure
      // Resource Graph does not return in the container tier the Brain and the
      // pause path scan, and most have no tags property at all. Ownership is
      // established on the TOP-LEVEL resource that owns them.
      if (type.split('/').length !== 2) continue;

      if (NON_TAGGABLE.has(type)) {
        exempt.set(type, (exempt.get(type) || 0) + 1);
        // The exemption must be TRUE, not merely convenient: if this type turns
        // up carrying tags, bicep's type index disagrees with the list and the
        // list is what is wrong.
        if (res.tags !== undefined) wronglyExempt.push({ path: at, type });
        continue;
      }

      if (OUT_OF_BAND_TAGGED.has(type)) {
        outOfBand.set(type, (outOfBand.get(type) || 0) + 1);
        continue;
      }

      if (res.tags === undefined) {
        missing.push({ path: at, type, why: 'declares no `tags:` at all' });
        continue;
      }

      if (!expressionReaches(res.tags, scope, ESTATE_TAG_KEY)) {
        missing.push({
          path: at,
          type,
          why: `its tags expression ${truncate(asText(res.tags))} never reaches \`${ESTATE_TAG_KEY}\` through any parameter or variable it references`,
        });
        continue;
      }
      covered += 1;
      // Sample a few for the FORMAT assertion. Sampling rather than checking all
      // 300+ is honest and sufficient: every one of them reaches the tag key
      // through the SAME `var loomTags`, so a format drift shows in any of them.
      if (taggedSamples.length < 8) {
        taggedSamples.push({ path: at, formatOk: hasCanonicalFormat(res.tags, scope) });
      }
    }
  }

  walk(template, new Map(), '');
  return { covered, missing, exempt, outOfBand, wronglyExempt, nestedTemplates, estateEnv, taggedSamples };
}

/**
 * Does this expression build the estate id with the canonical
 * `loom:<sub8>:<rg>` algorithm?
 *
 * Both halves are required. `ESTATE_ID_FORMAT` alone would accept a full-GUID
 * variant (`loom:<whole subscription id>:<rg>`), which is the most plausible
 * accidental drift and produces exactly the silent-zero failure this guards.
 *
 * @param {unknown} expr @param {ReturnType<typeof makeScope>} scope @returns {boolean}
 */
export function hasCanonicalFormat(expr, scope) {
  return expressionReaches(expr, scope, ESTATE_ID_FORMAT) && expressionReaches(expr, scope, ESTATE_ID_SUB8);
}

/**
 * Pull the VALUE expression out of every `createObject('name', '<envName>',
 * 'value', <expr>)` in an ARM expression string.
 *
 * WHY THIS IS NEEDED AND A KEY LOOKUP IS NOT. bicep does not emit a Container
 * App's env array as literal JSON when any entry is computed — the whole array
 * becomes ONE expression string built from `createObject(...)` calls. Measured
 * on this template: `LOOM_ESTATE_ID` lives inside the `apps` parameter of the
 * `appDeployments` nested deployment as
 *
 *     …createObject('name', 'LOOM_ESTATE_ID', 'value', variables('effectiveLoomEstateId'))…
 *
 * so `node.name === 'LOOM_ESTATE_ID'` matches nothing. The first version of
 * this guard did exactly that and reported "0 app env entries" against a
 * template that emitted three — a false RED, but the same blindness would have
 * been a false GREEN had the requirement been the other way round.
 *
 * The scan is paren-balanced and STRING-AWARE (ARM single-quoted literals,
 * `''` escaping), because a naive "read to the next `)`" truncates at the first
 * `)` inside a nested call and would hand the format check a fragment.
 *
 * @param {string} text @param {string} envName @returns {string[]}
 */
export function extractEnvValueExpressions(text, envName) {
  const out = [];
  const marker = `'name', '${envName}', 'value', `;
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return out;
    let i = at + marker.length;
    let depth = 1; // we are already inside the enclosing createObject(
    let inStr = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (inStr) {
        if (c !== "'") continue;
        if (text[i + 1] === "'") i += 1; // '' is an escaped quote, still in-string
        else inStr = false;
        continue;
      }
      if (c === "'") inStr = true;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
    }
    out.push(text.slice(at + marker.length, depth === 0 ? i - 1 : i));
    from = i;
  }
}

/**
 * Find every `LOOM_ESTATE_ID` env entry a template contributes and record
 * whether its value uses the canonical estate-id format.
 *
 * @param {any} tmpl
 * @param {ReturnType<typeof makeScope>} scope
 * @param {string} where
 * @param {Array<{path: string, formatOk: boolean}>} out
 */
export function collectEstateEnv(tmpl, scope, where, out) {
  const stack = [tmpl.resources];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;

    // The expression form (the one that actually occurs — see above).
    if (typeof node === 'string') {
      for (const expr of extractEnvValueExpressions(node, ESTATE_ENV_NAME)) {
        out.push({ path: where, formatOk: hasCanonicalFormat(expr, scope) });
      }
      continue;
    }
    if (typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    // A nested deployment's `properties.template` belongs to a DIFFERENT scope
    // (`walk` visits it with its own parameter bindings), but its
    // `properties.parameters` are expressions in THIS scope — and that is where
    // the console's env array actually lives: admin-plane/main.bicep builds the
    // `apps` bag and passes it into app-deployments.bicep, so `LOOM_ESTATE_ID`
    // is a PARAMETER of that deployment, not a resource property inside it.
    if (node.type === 'Microsoft.Resources/deployments') {
      if (node.properties && node.properties.parameters) stack.push(node.properties.parameters);
      continue;
    }
    // The literal-object form, for any surface bicep does emit as plain JSON.
    if (node.name === ESTATE_ENV_NAME && 'value' in node) {
      out.push({ path: where, formatOk: hasCanonicalFormat(node.value, scope) });
      continue;
    }
    for (const v of Object.values(node)) stack.push(v);
  }
}

/** @param {unknown} v @returns {string} */
function asText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}

/** @param {string} s @returns {string} */
function truncate(s) {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Turn an audit into the guard's verdict.
 *
 * @param {ReturnType<typeof audit>} result
 * @param {(rel: string) => string|null} [readFile] repo-relative reader; returns
 *   null when the file is absent. Injected so the out-of-band applier check is
 *   testable without a real tree.
 * @returns {string[]} failure messages; empty means PASS
 */
export function verdict(result, readFile = () => null) {
  const fail = [];

  if (result.missing.length) {
    const byType = new Map();
    for (const m of result.missing) byType.set(m.type, [...(byType.get(m.type) || []), m]);
    const lines = [
      `${result.missing.length} taggable resource(s) reach ARM WITHOUT the \`${ESTATE_TAG_KEY}\` tag.`,
      '',
      'Every one of these is invisible to the Brain and to estate pause: neither can prove it',
      'is this install\'s, so it is never recommended on and never paused — silently.',
      '',
      'FIX: thread the `complianceTags` parameter into the module and set `tags: complianceTags`',
      `on the resource. ${SOURCE} already folds \`${ESTATE_TAG_KEY}\` into that bag (\`var loomTags\`),`,
      'so nothing else is needed — do NOT add a second tagging mechanism.',
      '',
    ];
    for (const [type, items] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${type} — ${items.length}`);
      for (const m of items.slice(0, 6)) lines.push(`      ${m.path}: ${m.why}`);
      if (items.length > 6) lines.push(`      … and ${items.length - 6} more`);
    }
    fail.push(lines.join('\n'));
  }

  for (const w of result.wronglyExempt) {
    fail.push(
      `${w.path} is a \`${w.type}\`, which NON_TAGGABLE claims cannot carry tags — but it carries a \`tags\` property.\n` +
        '  The exemption is wrong, not the resource. Remove the NON_TAGGABLE entry so this type is required to carry\n' +
        `  \`${ESTATE_TAG_KEY}\` like every other taggable resource.`,
    );
  }

  for (const [type, why] of NON_TAGGABLE) {
    if (!result.exempt.has(type)) {
      fail.push(
        `NON_TAGGABLE lists \`${type}\` but the template contains none.\n` +
          `  Recorded reason: ${why}\n` +
          '  A dead exemption excuses nothing today and would silently excuse whatever lands under that type name\n' +
          '  tomorrow. Delete the entry; re-add it (with a fresh BCP187 measurement) if the type comes back.',
      );
    }
  }

  // OUT-OF-BAND. The exemption is only honest while the applier it names really
  // applies the key — CHASE THE SILENCE: a guard whose exemption points at a
  // script that stopped stamping the tag is green over the exact hole it was
  // written to cover.
  for (const [type, spec] of OUT_OF_BAND_TAGGED) {
    if (!result.outOfBand.has(type)) {
      fail.push(
        `OUT_OF_BAND_TAGGED lists \`${type}\` but the template contains none.\n` +
          `  Recorded reason: ${spec.why}\n` +
          '  A dead exemption would silently excuse whatever lands under that type name next. Delete the entry.',
      );
      continue;
    }
    const body = readFile(spec.applier);
    if (body === null) {
      fail.push(
        `\`${type}\` is exempted from declarative tagging on the grounds that ${spec.applier} applies the tag\n` +
          '  out of band — and that file does not exist. The exemption currently excuses an UNTAGGED resource.',
      );
      continue;
    }
    if (!body.includes(ESTATE_TAG_KEY)) {
      fail.push(
        `\`${type}\` is exempted from declarative tagging because ${spec.applier} is supposed to apply the tag\n` +
          `  after the ARM apply — but that script never mentions \`${ESTATE_TAG_KEY}\`.\n` +
          `  Recorded reason for the exemption: ${spec.why}\n` +
          '  So nothing stamps ownership on this resource at all. Either restore the tag in that script, or remove\n' +
          '  the exemption so the resource is required to carry it declaratively.',
      );
    }
  }

  if (result.covered < MIN_TAGGABLE_RESOURCES) {
    fail.push(
      `only ${result.covered} taggable resource(s) were found to examine (floor ${MIN_TAGGABLE_RESOURCES}).\n` +
        '  This template deploys hundreds. A count this low means the walk stopped early or the template did not\n' +
        '  compile to what it should, and a guard that examined almost nothing must not report a clean estate.',
    );
  }

  if (result.nestedTemplates < MIN_NESTED_TEMPLATES) {
    fail.push(
      `only ${result.nestedTemplates} nested template(s) were walked (floor ${MIN_NESTED_TEMPLATES}).\n` +
        '  Almost every Loom resource lives inside a nested module deployment. A walk that did not descend would\n' +
        '  report full coverage having examined the root template alone.',
    );
  }

  if (result.estateEnv.length === 0) {
    fail.push(
      `nothing in the compiled template emits \`${ESTATE_ENV_NAME}\` to an app environment.\n` +
        `  The tag without the env leaves lib/brain-actions/state-store.ts#estateScope() writing findings to the\n` +
        "  'unscoped' Cosmos partition, and app/api/admin/brain/graph/route.ts omitting the ownership scope — which\n" +
        '  widens the match to ANY non-empty estate tag, exactly what a mutating caller must not do.\n' +
        `  FIX: emit \`{ name: '${ESTATE_ENV_NAME}', value: effectiveLoomEstateId }\` next to LOOM_SUBSCRIPTION_ID /\n` +
        '  LOOM_ADMIN_RG in platform/fiab/bicep/modules/admin-plane/main.bicep.',
    );
  }

  // FORMAT. Checked on both halves — the tag value AND the env value — because
  // they only agree if they were built the same way, and a format drift in
  // either produces zero owned resources rather than an error.
  const formatSubjects = [
    ...result.taggedSamples.map((s) => [`the \`tags\` expression at ${s.path}`, s.formatOk]),
    ...result.estateEnv.map((s) => [`the \`${ESTATE_ENV_NAME}\` value emitted at ${s.path}`, s.formatOk]),
  ];
  for (const [label, ok] of formatSubjects) {
    if (ok) continue;
    fail.push(
      `${label} does not build the estate id with the canonical \`loom:<sub8>:<rg>\` algorithm.\n` +
        `  expected the expression to reach BOTH \`${ESTATE_ID_FORMAT}\` and \`${ESTATE_ID_SUB8}\`.\n` +
        '  lib/estate/pause-orchestrator.ts#resolveEstateId and lib/brain/run/cli.ts#resolveScanEstateId both\n' +
        '  synthesize `loom:${sub.slice(0,8)}:${rg}` and compare it to the tag by EXACT EQUALITY. A different\n' +
        '  shape here does not fail the deploy — it resolves ZERO owned resources, which is indistinguishable\n' +
        '  from the unstamped estate this guard exists to prevent.',
    );
  }

  return fail;
}

// ── az plumbing ──────────────────────────────────────────────────────────────

/**
 * Run `az`. NO output is discarded — stderr is captured and surfaced on failure.
 *
 * The Windows path goes through cmd.exe (`az` is a .cmd and Node refuses to
 * spawn it directly), which re-parses the rendered command line; the two guards
 * imported from check-deploy-template-sync.mjs are the SAME implementation that
 * CodeQL #773/#774 forced there. Importing rather than re-deriving them is
 * deliberate: a second copy is a second thing to get wrong.
 *
 * @param {string[]} args
 */
function runAz(args) {
  const opts = { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };
  if (process.platform === 'win32') {
    const interpreter = resolveWindowsInterpreter();
    assertInterpreterSafeArgs(['az', ...args]);
    const res = spawnSync(interpreter, ['/d', '/c', 'az', ...args], opts);
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
  }
  const res = spawnSync('az', args, opts);
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

/**
 * Compile `srcAbs` into a fresh temp dir and return the parsed template.
 * mkdtemp, not a fixed name under a shared root — see check-temp-artifact-safety.mjs.
 * @param {string} srcAbs
 */
function compile(srcAbs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-estatetag-'));
  const out = path.join(dir, 'compiled.json');
  try {
    const res = runAz(['bicep', 'build', '-f', srcAbs, '--outfile', out]);
    if (res.error) {
      throw new Error(
        `could not run \`az bicep build\`: ${res.error.message}. This guard COMPILES the template; it cannot verify without the Azure CLI, and it will not pass without verifying.`,
      );
    }
    if (res.status !== 0) throw new Error(`\`az bicep build\` failed (exit ${res.status}).\n${res.stderr.trim().slice(-4000)}`);
    if (!fs.existsSync(out)) throw new Error('`az bicep build` exited 0 but produced no output file');
    const buf = fs.readFileSync(out);
    if (buf.length === 0) throw new Error('`az bicep build` produced an empty file');
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!parsed || typeof parsed.$schema !== 'string' || !/deploymentTemplate\.json/i.test(parsed.$schema)) {
      throw new Error(`the compiled output is not an ARM template (got $schema ${JSON.stringify(parsed && parsed.$schema)})`);
    }
    if (parsed.resources === undefined) throw new Error('the compiled output has no "resources"');
    return parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(root = process.cwd()) {
  const log = (m) => console.log(`[estate-tag-coverage] ${m}`);
  const srcAbs = path.join(root, SOURCE);

  if (!fs.existsSync(srcAbs)) {
    console.error(`\n::error::estate-tag-coverage — ${SOURCE} is missing; nothing could be verified.`);
    process.exit(1);
  }

  let template;
  try {
    log(`compiling ${SOURCE} …`);
    template = compile(srcAbs);
  } catch (e) {
    console.error(`\n::error::estate-tag-coverage — ${e.message}`);
    process.exit(1);
  }

  const result = audit(template);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  log(
    `walked ${result.nestedTemplates} template(s): ${result.covered} taggable resource(s) carry \`${ESTATE_TAG_KEY}\`, ` +
      `${result.missing.length} do not, ${sum(result.exempt)} are not taggable, ` +
      `${sum(result.outOfBand)} are tagged out-of-band, ` +
      `${result.estateEnv.length} app env entr(ies) emit ${ESTATE_ENV_NAME}.`,
  );

  const readRepoFile = (rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };
  const fail = verdict(result, readRepoFile);
  if (fail.length) {
    console.error(`\n::error::estate-tag-coverage — the deploy does not stamp \`${ESTATE_TAG_KEY}\` on everything it creates.`);
    for (const f of fail) console.error(`\n${f}`);
    console.error(
      '\nOwnership is the Brain\'s ONLY safety scope and estate pause\'s ONLY inventory. A resource that reaches ARM\n' +
        'without this tag is not merely untidy — it is invisible to both, and it makes the estate report look complete\n' +
        'while omitting whatever landed last (#3922, #4255).\n',
    );
    process.exit(1);
  }

  log(`PASS — every taggable resource carries \`${ESTATE_TAG_KEY}\`, and ${ESTATE_ENV_NAME} is wired to the same value.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

#!/usr/bin/env node
/**
 * check-appimagetags-coverage — every boundary's `appImageTags` bag must carry
 * every key the SHIPPED ARM template dereferences UNSAFELY.
 *
 * WHY THIS EXISTS (measured 2026-08-06, FINISHLINE L-GOV).
 * `platform/fiab/bicep/params/il5.bicepparam` assigned an `appImageTags` object
 * that omitted five keys the template reads with a PLAIN `.` — mcpBridge, maf,
 * setupOrchestrator, scriptRunner, wrangler. A `.bicepparam` object assignment
 * REPLACES the template default; it does not merge with it. So the IL5 bag was
 * simply missing them, and the compiled template contains:
 *
 *   /resources/adminPlane/properties/template/resources/appDeployments
 *     condition: containerPlatform == 'containerApps' && deployAppsEnabled
 *     .../parameters/apps/value[2]/image:
 *        "[format('loom-mcp-bridge:{0}', parameters('appImageTags').mcpBridge)]"
 *
 * IL5 sets BOTH condition operands true, so ARM evaluates that expression and
 * fails the whole nested deployment with "The language expression property
 * 'mcpBridge' doesn't exist" — before a single resource is touched. The entire
 * IL5 boundary could not deploy, while GCC-High (whose param file carries the
 * keys, with a comment documenting this exact hazard since PR #2640) could.
 *
 * That is a `.claude/rules/cloud-parity.md` violation of the worst kind: not a
 * feature that behaves differently per cloud, but a boundary that cannot deploy
 * at all — and nothing measured it, because `bicep build-params` type-checks the
 * param file in isolation and `appImageTags` is an untyped `object`, so a
 * missing property is invisible until ARM evaluates it in a real deployment.
 *
 * WHAT IT CHECKS. The required key set is derived from the SHIPPED ARTIFACT
 * (apps/fiab-console/deploy-templates/main.json), not from a hand-maintained
 * list, so it tracks the template automatically:
 *   REQUIRED = keys read as `parameters('appImageTags').<key>`      (plain — ARM
 *              throws when absent)
 *   IGNORED  = keys read as `tryGet(parameters('appImageTags'), '<key>')` (the
 *              `.?x ?? 'v0.1'` form — absent is fine by construction)
 * Every `params/*.bicepparam` that ASSIGNS `param appImageTags = { … }` must
 * carry every REQUIRED key. A param file that does not assign the bag inherits
 * the template default and is correctly skipped.
 *
 * MUTATION PROOF: delete any required key from any params/*.bicepparam →ing this
 * check goes red naming the file and the key; restore → green.
 *
 * Usage: node scripts/ci/check-appimagetags-coverage.mjs [repo-root]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const ROOT = resolve(process.argv[2] ?? process.cwd());
const TEMPLATE = join(ROOT, 'apps/fiab-console/deploy-templates/main.json');
const PARAMS_DIR = join(ROOT, 'platform/fiab/bicep/params');

const failures = [];
const notes = [];

if (!existsSync(TEMPLATE)) {
  console.error(`[appimagetags-coverage] FAIL — compiled template not found at ${TEMPLATE}.`);
  console.error('  This check derives the required key set from the SHIPPED artifact. Without it');
  console.error('  the check would measure nothing, so it fails closed rather than passing blind.');
  process.exit(1);
}
if (!existsSync(PARAMS_DIR)) {
  console.error(`[appimagetags-coverage] FAIL — params directory not found at ${PARAMS_DIR}.`);
  process.exit(1);
}

const template = readFileSync(TEMPLATE, 'utf8');

const plain = new Set([...template.matchAll(/parameters\('appImageTags'\)\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
const safe = new Set(
  [...template.matchAll(/tryGet\(parameters\('appImageTags'\),\s*'([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
);
// A key read BOTH ways is still required — the plain read is the one that throws.
const required = [...plain].sort();

if (required.length === 0) {
  console.error('[appimagetags-coverage] FAIL — found ZERO plain appImageTags dereferences in the compiled');
  console.error('  template. Either the template stopped shipping the app tier, or the extraction regex no');
  console.error('  longer matches what bicep emits. Both mean this check is measuring nothing — failing closed.');
  console.error('  (Expected expressions of the form: parameters(\'appImageTags\').console)');
  process.exit(1);
}

notes.push(`required (plain deref, ARM throws when absent): ${required.join(', ')}`);
notes.push(`ignored  (tryGet/?? deref, absent is safe):      ${[...safe].sort().join(', ') || '(none)'}`);

/**
 * Extract the keys assigned inside `param appImageTags = { … }` by brace
 * matching, so nested objects and `readEnvironmentVariable(...)` calls with
 * braces in comments cannot confuse it. Returns null when the file does not
 * assign the bag at all (it then inherits the template default — correct).
 */
function extractAssignedKeys(src) {
  const m = /^\s*param\s+appImageTags\s*=\s*\{/m.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { unterminated: true, keys: [] };
  const body = src.slice(start + 1, end);
  const keys = [];
  for (const line of body.split('\n')) {
    // Skip comment lines so a `// foo: bar` note is never read as a key.
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
    if (km) keys.push(km[1]);
  }
  return { unterminated: false, keys };
}

const paramFiles = readdirSync(PARAMS_DIR).filter((f) => f.endsWith('.bicepparam')).sort();
let assigning = 0;

for (const file of paramFiles) {
  const src = readFileSync(join(PARAMS_DIR, file), 'utf8');
  const found = extractAssignedKeys(src);
  if (found === null) {
    notes.push(`${file}: does not assign appImageTags — inherits the template default (OK).`);
    continue;
  }
  if (found.unterminated) {
    failures.push(`${file}: \`param appImageTags = {\` has no matching closing brace — cannot verify.`);
    continue;
  }
  assigning += 1;
  const missing = required.filter((k) => !found.keys.includes(k));
  if (missing.length) {
    failures.push(
      `${file}: appImageTags is MISSING ${missing.map((k) => `\`${k}\``).join(', ')}.\n` +
        `    The shipped template reads these with a plain \`.\`, so an ARM deployment using this\n` +
        `    param file aborts with "The language expression property '${missing[0]}' doesn't exist"\n` +
        `    before any resource is touched. A .bicepparam object assignment REPLACES the template\n` +
        `    default — it does not merge — so every key has to be listed here.`,
    );
  } else {
    notes.push(`${file}: all ${required.length} required keys present (${found.keys.length} assigned).`);
  }
}

if (assigning === 0) {
  console.error('[appimagetags-coverage] FAIL — no params/*.bicepparam assigns appImageTags.');
  console.error('  Every boundary inheriting the default would make this check vacuous; failing closed.');
  process.exit(1);
}

for (const n of notes) console.log(`[appimagetags-coverage] ${n}`);

if (failures.length) {
  console.error('');
  console.error('[appimagetags-coverage] FAIL — a boundary cannot deploy with its own param file:');
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  console.error('  Fix: add the missing key(s) to that .bicepparam, e.g.');
  console.error("    mcpBridge: readEnvironmentVariable('LOOM_MCP_BRIDGE_TAG', 'v0.1')");
  console.error('  A tag for an app that is boundary-gated OFF is still required — it is a placeholder');
  console.error('  that is never pulled, but the property must EXIST for the expression to evaluate.');
  console.error('  See .claude/rules/cloud-parity.md: a boundary that cannot deploy is not "Gov lag".');
  process.exit(1);
}

console.log(
  `[appimagetags-coverage] PASS — ${assigning} param file(s) carry all ${required.length} plainly-dereferenced appImageTags keys.`,
);

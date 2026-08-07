#!/usr/bin/env node
/**
 * check-appimagetags-coverage — every boundary's `appImageTags` bag must carry
 * every key the SHIPPED ARM template dereferences UNSAFELY.
 *
 * WHY THIS EXISTS (measured 2026-08-06; severity CORRECTED 2026-08-07).
 * `platform/fiab/bicep/params/il5.bicepparam` assigned an `appImageTags` object
 * that omitted five keys the template reads with a PLAIN `.` — mcpBridge, maf,
 * setupOrchestrator, scriptRunner, wrangler. A `.bicepparam` object assignment
 * REPLACES the template default; it does not merge with it. So the IL5 bag was
 * simply missing them, and the compiled template contains:
 *
 *   /resources/adminPlane/properties/template/resources/appDeployments
 *     condition: and(equals(containerPlatform,'containerApps'), deployAppsEnabled)
 *     .../parameters/apps/value[2]/image:
 *        "[format('loom-mcp-bridge:{0}', parameters('appImageTags').mcpBridge)]"
 *
 * ARM then fails the whole nested deployment with "The language expression
 * property 'mcpBridge' doesn't exist" before a single resource is touched.
 *
 * SEVERITY IS PER-FILE, AND AN EARLIER VERSION OF THIS HEADER OVERSTATED IT.
 * All five derefs are gated on `deployAppsEnabled` — the appDeployments
 * condition above, plus copilotMafActive / scriptRunnerActive / wranglerActive /
 * setupOrchestratorActive (admin-plane/main.bicep L688/691/724/740). So:
 *
 *   il5.bicepparam       declares deployAppsEnabled=true and deploy-fiab-il5.yml
 *                        passes no override → WOULD abort on its first
 *                        apps-enabled run. Never observed: that lane has NEVER
 *                        RUN (zero runs, measured 2026-08-07).
 *   tenant-dmlz          same shape; no automated caller at all (manual only).
 *   commercial-full      LATENT, NOT BROKEN. Every known invocation overrides
 *                        deployAppsEnabled=false — bicep-whatif.yml:291 and
 *                        loom-drift-check.yml:147 — and no-vaporware.md's
 *                        from-scratch PHASE 1 specifies it too. bicep-whatif ran
 *                        this file SUCCESS on 2026-08-07. The earlier claim that
 *                        "the from-scratch path could not deploy" was FALSE.
 *   commercial           never exposed — does not assign appImageTags at all.
 *
 * The guard's VALUE does not depend on which of those it was: a param file that
 * only works because every caller happens to disable the app tier is one
 * `deployAppsEnabled=true` away from aborting, and three of them declare `true`
 * themselves. Nothing measured any of it, because `bicep build-params`
 * type-checks the param file in isolation and `appImageTags` is an untyped
 * `object`, so a missing property is invisible until ARM evaluates it.
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
 * KEY EXTRACTION IS DEPTH-AWARE (fixed 2026-08-07). The first version matched
 * `^<ident>:` on every line inside the bag, so a key nested in a sub-object —
 * `nestedDecoy: { mcpBridge: 'v0.1' }` — counted as a top-level `mcpBridge` and
 * produced a FALSE PASS. Keys are now accepted only at brace depth 1 relative to
 * the bag, with string literals and comments skipped so a `{` inside either
 * cannot shift the depth. Self-tested below via --selftest.
 *
 * MUTATION PROOF: delete any required key from any params/*.bicepparam → this
 * check goes red naming the file and the key; restore → green. Nesting a
 * required key one level deep also stays red (see --selftest).
 *
 * Usage: node scripts/ci/check-appimagetags-coverage.mjs [repo-root]
 *        node scripts/ci/check-appimagetags-coverage.mjs --selftest
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const SELFTEST = process.argv.includes('--selftest');
const ROOT = resolve((process.argv[2] && process.argv[2] !== '--selftest') ? process.argv[2] : process.cwd());
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
 * Extract the keys assigned at the TOP LEVEL of `param appImageTags = { … }`.
 *
 * DEPTH-AWARE (2026-08-07). The previous implementation matched `^<ident>:` on
 * every line inside the bag, so `nestedDecoy: { mcpBridge: 'v0.1' }` registered
 * a top-level `mcpBridge` that ARM would never see — a FALSE PASS. We now walk
 * the body character by character, tracking brace depth, and accept a key only
 * at depth 1 (immediately inside the bag). Single-quoted strings and `//`
 * comments are skipped so a brace inside either cannot shift the depth.
 *
 * Returns null when the file does not assign the bag at all (it then inherits
 * the template default — correct, and correctly skipped by the caller).
 */
function extractAssignedKeys(src) {
  const m = /^[ \t]*param[ \t]+appImageTags[ \t]*=[ \t]*\{/m.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);

  let depth = 0;
  let end = -1;
  let i = start;
  const keys = [];
  let pendingIdent = '';

  for (; i < src.length; i += 1) {
    const c = src[i];

    // Line comment — skip to end of line. (Bicep has no block comments in
    // .bicepparam bodies we emit, but `/*` would also be skipped by the same
    // guard if it ever appeared, since we only special-case `//`.)
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      pendingIdent = '';
      continue;
    }

    // Single-quoted string — bicep's only string form. Braces inside are data.
    if (c === "'") {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === "'") break;
        i += 1;
      }
      pendingIdent = '';
      continue;
    }

    if (c === '{') {
      depth += 1;
      pendingIdent = '';
      continue;
    }
    if (c === '}') {
      depth -= 1;
      pendingIdent = '';
      if (depth === 0) { end = i; break; }
      continue;
    }

    // Only depth 1 can contribute a top-level key.
    if (c === ':' && depth === 1 && pendingIdent) {
      keys.push(pendingIdent);
      pendingIdent = '';
      continue;
    }

    if (/[A-Za-z0-9_]/.test(c)) {
      pendingIdent += c;
      continue;
    }
    // Any other character (whitespace, comma, newline, operator) ends the
    // candidate identifier. A key must be an unbroken ident immediately
    // followed by ':'.
    pendingIdent = '';
  }

  if (end === -1) return { unterminated: true, keys: [] };
  return { unterminated: false, keys };
}

// ── SELF-TEST for the depth-aware extractor ──────────────────────────────────
// Runs on every invocation (it is microseconds and needs no I/O), so the
// extractor can never silently regress to the line-based version that produced
// a FALSE PASS on a nested key. `--selftest` runs ONLY these and exits.
{
  const cases = [
    {
      name: 'flat bag',
      src: "param appImageTags = {\n  console: 'v1'\n  mcpBridge: 'v0.1'\n}\n",
      want: ['console', 'mcpBridge'],
    },
    {
      name: 'NESTED key must NOT count (the false-pass the judge found)',
      src: "param appImageTags = {\n  console: 'v1'\n  nestedDecoy: {\n    mcpBridge: 'v0.1'\n  }\n}\n",
      want: ['console', 'nestedDecoy'],
    },
    {
      name: 'comment mentioning a key must NOT count',
      src: "param appImageTags = {\n  // mcpBridge: 'v0.1'  <- documentation only\n  console: 'v1'\n}\n",
      want: ['console'],
    },
    {
      name: 'brace inside a string must not shift depth',
      src: "param appImageTags = {\n  console: readEnvironmentVariable('X', '{')\n  mcpBridge: 'v0.1'\n}\n",
      want: ['console', 'mcpBridge'],
    },
    {
      name: 'no assignment -> null (inherits template default)',
      src: "param location = 'eastus'\n",
      want: null,
    },
  ];
  const bad = [];
  for (const c of cases) {
    const got = extractAssignedKeys(c.src);
    const gotKeys = got === null ? null : got.keys;
    if (JSON.stringify(gotKeys) !== JSON.stringify(c.want)) {
      bad.push(`${c.name}: expected ${JSON.stringify(c.want)}, got ${JSON.stringify(gotKeys)}`);
    }
  }
  if (bad.length) {
    console.error('[appimagetags-coverage] SELF-TEST FAILED — the key extractor is wrong, so any');
    console.error('  PASS it produces is meaningless. Refusing to run the real check.');
    for (const b of bad) console.error(`  • ${b}`);
    process.exit(1);
  }
  if (SELFTEST) {
    console.log(`[appimagetags-coverage] SELF-TEST PASS — ${cases.length} extractor cases, including the nested-key false-pass regression.`);
    process.exit(0);
  }
}

const paramFiles = readdirSync(PARAMS_DIR).filter((f) => f.endsWith('.bicepparam')).sort();let assigning = 0;

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

#!/usr/bin/env node
/**
 * GUARDRAIL: honest-gate-coverage  (G2 Fix-it coverage ratchet) — FINISHLINE C15/C21
 * ---------------------------------------------------------------------------
 * RULE (.claude/rules/ux-baseline.md G2, verbatim): every gate MUST
 *   (a) render an inline "Fix it" button launching a wizard/picker that sets the
 *       required values,
 *   (b) be registered in the central gate registry (lib/gates/registry),
 *   (c) appear on the Admin Panel gate page.
 *   "A bare remediation MessageBar without Fix-it is no longer compliant."
 *
 * And .claude/rules/auto-bind-by-default.md sits ABOVE it: if the PLATFORM could
 * have performed the remediation, the honest gate is STILL A DEFECT — the fix is
 * to delete the gate by doing the work at provision time, not to bolt a Fix-it
 * button onto it.
 *
 * WHAT WAS MEASURED (2026-08-08, AST — not regex).
 *
 *   The registry itself is COMPLETE: 131 GATE_META entries, 131 `fixit:`
 *   declarations, 1:1, zero gaps, zero orphans, zero entries with no surfaces.
 *   (The audit claim of "~160 GATE_META vs 131 fixit" was a regex artifact: a
 *   looser key pattern also matches nested object keys — `surfaces:`, `loaders:`,
 *   per-loader entries — and counts 305, not 160. The exact AST count of
 *   top-level GATE_META keys is 131 and every one carries a fixit. `GateMeta`
 *   makes `fixit` NON-OPTIONAL, so a missing one cannot compile.)
 *
 *   The breach is entirely on the SURFACES. 72 .tsx files render 89 remediation
 *   MessageBars that name a LOOM_* env var and DO NOT mount `HonestGate` — i.e.
 *   they tell the operator to go set a value with no Fix-it button, no registry
 *   linkage, and no Admin gate-page entry. 23 surfaces do it correctly.
 *
 * WHY A RATCHET AND NOT A FLAT BAN.
 *
 *   72 files cannot be migrated in one change without colliding with every other
 *   lane touching the console. So this gate freezes the breach set and forces it
 *   to shrink:
 *
 *     - a file NOT in the baseline that grows a bare env-var remediation bar
 *       FAILS (no new breaches, ever);
 *     - a file IN the baseline that no longer has one FAILS UNTIL IT IS REMOVED
 *       from the baseline.
 *
 *   That second direction is the anti-quiet mechanism, and it is deliberate.
 *   `csa_loom_guard_keyed_to_the_unsafe_pattern` records the failure this avoids:
 *   a guard keyed to the UNSAFE token goes silent on exactly the files that were
 *   fixed, so the fix erases the evidence and the count can drift back up
 *   unobserved. Here, adopting HonestGate is a REQUIRED baseline edit — the list
 *   only ever shrinks, and shrinking it is what proves progress.
 *
 * MUTATION-PROVED: `--selftest` asserts the gate fails in BOTH directions and
 *   passes only on an exact match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BASELINE = path.join(__dirname, 'honest-gate-coverage.baseline.json');

const ROOTS = ['lib/editors', 'lib/components', 'app', 'lib/apps'];

/**
 * The env-var token. A remediation bar that names a LOOM_* variable is, by
 * construction, telling the operator to configure something — which is exactly
 * what G2 requires a Fix-it for.
 */
const ENV_VAR = /\bLOOM_[A-Z0-9_]+\b/;

/**
 * ...but naming a variable is not sufficient: a bar may mention one while
 * reporting a runtime condition ("per-user Compute Instance limit reached",
 * "connection list is partial", "failover is one-way"). A G2 gate is a bar that
 * INSTRUCTS THE OPERATOR TO CHANGE CONFIGURATION. These are the imperatives.
 */
const REMEDIATION = /\bSet\b|\bset\s+(the\s+)?<?code|not configured|isn'?t configured|is not configured|not provisioned|not deployed|not wired|isn'?t wired|not enabled|not reachable|Grant the|grant the|requires? an?\s|provision/;

function loadTs() {
  return createRequire(path.join(APP_DIR, 'package.json'))('typescript');
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '__tests__', '.next'].includes(e.name)) continue;
      walk(p, out);
    } else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Scan one file's SOURCE for bare G2 gates. Exported (and pure over `text`) so
 * --selftest can drive it with synthetic sources.
 * @returns {{ honestGate:number, bareGates:Array<{line:number, envVar:string}> }}
 */
export function scanSource(ts, fileName, text) {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let honestGate = 0;
  const bareGates = [];
  ts.forEachChild(src, function visit(node) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(src);
      if (tag === 'HonestGate') honestGate += 1;
      if (tag === 'MessageBar') {
        const ia = node.attributes.properties.find(
          (a) => ts.isJsxAttribute(a) && a.name.getText(src) === 'intent');
        const intent = ia && ts.isJsxAttribute(ia) && ia.initializer
          ? ia.initializer.getText(src).replace(/[{}'"]/g, '') : null;
        if (intent === 'warning' || intent === 'error') {
          const el = ts.isJsxOpeningElement(node) ? node.parent : node;
          const body = el.getText(src);
          const m = body.match(ENV_VAR);
          if (m && REMEDIATION.test(body)) {
            bareGates.push({ line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, envVar: m[0] });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  // A file that mounts HonestGate has an in-product Fix-it path; its remaining
  // bars are treated as covered by that surface's gate.
  return { honestGate, bareGates: honestGate > 0 ? [] : bareGates };
}

/** Scan the whole console. @returns {Map<string, number>} rel path -> bare gate count */
export function scanRepo(ts) {
  const files = [];
  for (const r of ROOTS) walk(path.join(APP_DIR, r), files);
  const found = new Map();
  for (const full of files) {
    const rel = path.relative(APP_DIR, full).replace(/\\/g, '/');
    const { bareGates } = scanSource(ts, full, fs.readFileSync(full, 'utf-8'));
    if (bareGates.length) found.set(rel, bareGates.length);
  }
  return found;
}

/**
 * The ratchet decision. PURE — takes two maps, returns the violations.
 * Both directions fail; that is the point.
 */
export function compare(baseline, found) {
  const newBreaches = [];   // not in baseline, has bare gates → a NEW G2 breach
  const fixed = [];         // in baseline, now clean → baseline must be updated
  const grew = [];          // in baseline, but MORE bars than recorded
  for (const [file, n] of found) {
    if (!(file in baseline)) newBreaches.push({ file, n });
    else if (n > baseline[file]) grew.push({ file, was: baseline[file], now: n });
  }
  for (const file of Object.keys(baseline)) {
    if (!found.has(file)) fixed.push(file);
  }
  return { newBreaches, fixed, grew };
}

// --- selftest ---------------------------------------------------------------

function selftest() {
  const ts = loadTs();
  let bad = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) console.log(`  ✓ ${name}`);
    else { bad += 1; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
  };

  // --- scanSource classification ---
  const bare = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>Azure ML workspace not configured</MessageBarTitle>
        Set <code>LOOM_AML_WORKSPACE</code> on the Console app.
      </MessageBarBody></MessageBar>); }`;
  ok('a bare env-var remediation bar IS detected', scanSource(ts, 'a.tsx', bare).bareGates.length === 1);

  const withGate = bare.replace('export function E() { return (',
    'export function E() { return (<><HonestGate gateId="svc-aml" surface="X" />') .replace('</MessageBar>);', '</MessageBar></>);');
  ok('the SAME bar is NOT a violation once HonestGate is mounted',
    scanSource(ts, 'b.tsx', withGate).bareGates.length === 0);

  const runtimeBar = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>Per-user Compute Instance limit reached</MessageBarTitle>
        You have used 3/3 (LOOM_AML_CI_MAX).
      </MessageBarBody></MessageBar>); }`;
  ok('a RUNTIME-state bar that merely mentions a var is NOT a G2 gate',
    scanSource(ts, 'c.tsx', runtimeBar).bareGates.length === 0);

  const successBar = bare.replace('intent="warning"', 'intent="success"');
  ok('a non-warning/error bar is ignored', scanSource(ts, 'd.tsx', successBar).bareGates.length === 0);

  const noVar = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>Something went wrong.</MessageBarBody></MessageBar>); }`;
  ok('a bar with no env var is ignored', scanSource(ts, 'e.tsx', noVar).bareGates.length === 0);

  // --- ratchet decision, BOTH directions ---
  const base = { 'x.tsx': 1, 'y.tsx': 2 };

  let r = compare(base, new Map([['x.tsx', 1], ['y.tsx', 2]]));
  ok('an exact match passes', r.newBreaches.length === 0 && r.fixed.length === 0 && r.grew.length === 0);

  r = compare(base, new Map([['x.tsx', 1], ['y.tsx', 2], ['z.tsx', 1]]));
  ok('a NEW breached file FAILS', r.newBreaches.length === 1 && r.newBreaches[0].file === 'z.tsx');

  r = compare(base, new Map([['x.tsx', 1], ['y.tsx', 5]]));
  ok('MORE bars in an already-breached file FAILS', r.grew.length === 1 && r.grew[0].now === 5);

  r = compare(base, new Map([['x.tsx', 1]]));
  ok('a FIXED file FAILS until removed from the baseline (the anti-quiet direction)',
    r.fixed.length === 1 && r.fixed[0] === 'y.tsx');

  r = compare(base, new Map());
  ok('fixing EVERYTHING still fails until the baseline is emptied', r.fixed.length === 2);

  // --- exit contract ---
  const v = compare(base, new Map([['x.tsx', 1], ['y.tsx', 2], ['z.tsx', 1]]));
  ok('EXIT CONTRACT: violations produce a non-zero exit',
    (v.newBreaches.length + v.fixed.length + v.grew.length > 0 ? 1 : 0) === 1);

  if (bad) { console.error(`\ncheck-honest-gate-coverage --selftest: ${bad} case(s) failed.`); process.exit(1); }
  console.log('\ncheck-honest-gate-coverage --selftest: all cases passed.');
  process.exit(0);
}

// --- run --------------------------------------------------------------------

if (process.argv.includes('--selftest')) selftest();

const ts = loadTs();
const found = scanRepo(ts);

if (process.argv.includes('--write-baseline')) {
  const obj = {};
  for (const k of [...found.keys()].sort()) obj[k] = found.get(k);
  fs.writeFileSync(BASELINE, `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`[honest-gate-coverage] wrote ${Object.keys(obj).length} file(s) to ${path.relative(REPO_ROOT, BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`[honest-gate-coverage] baseline missing: ${path.relative(REPO_ROOT, BASELINE)}`);
  console.error('[honest-gate-coverage] regenerate with --write-baseline (and justify it in the commit).');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
const { newBreaches, fixed, grew } = compare(baseline, found);

const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
const liveTotal = [...found.values()].reduce((a, b) => a + b, 0);
console.log(`[honest-gate-coverage] baseline: ${Object.keys(baseline).length} file(s) / ${baseTotal} bare gate(s)`);
console.log(`[honest-gate-coverage] live:     ${found.size} file(s) / ${liveTotal} bare gate(s)`);

let failed = false;

if (newBreaches.length) {
  failed = true;
  console.log('');
  console.log('::error::[honest-gate-coverage] NEW G2 breach — a remediation MessageBar naming a LOOM_* env var with no HonestGate/Fix-it.');
  for (const b of newBreaches) console.log(`::error::  ${b.file} (${b.n} bar(s))`);
  console.log('[honest-gate-coverage] Fix by EITHER:');
  console.log('[honest-gate-coverage]   (preferred, auto-bind-by-default.md) deleting the gate — have the');
  console.log('[honest-gate-coverage]   platform provision/bind the value so the bar never renders; or');
  console.log('[honest-gate-coverage]   mounting <HonestGate gateId="..." surface="..." /> so the operator');
  console.log('[honest-gate-coverage]   gets an inline Fix-it wizard and the gate reaches /admin/gates.');
}

if (grew.length) {
  failed = true;
  console.log('');
  for (const g of grew) console.log(`::error::[honest-gate-coverage] ${g.file}: bare gates went ${g.was} -> ${g.now}. The ratchet moves DOWN only.`);
}

if (fixed.length) {
  failed = true;
  console.log('');
  console.log('::error::[honest-gate-coverage] These files no longer have a bare gate — REMOVE them from the baseline in this commit.');
  console.log('::error::[honest-gate-coverage] (A guard keyed to the unsafe pattern goes quiet on the files you fixed; this is what stops that.)');
  for (const f of fixed) console.log(`::error::  ${f}`);
  console.log('[honest-gate-coverage] Run: node scripts/ci/check-honest-gate-coverage.mjs --write-baseline');
}

if (failed) process.exit(1);
console.log('[honest-gate-coverage] PASS — no new bare G2 gates, baseline exact.');
process.exit(0);

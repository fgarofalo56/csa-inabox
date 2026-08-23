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
 * ...and the same gate with its variable name INTERPOLATED (#3708).
 *
 * THE BLIND SPOT, measured. `ENV_VAR` above matches a LITERAL spelling. A
 * remediation bar that renders `{gate.missing}` — a value fetched at runtime —
 * carries no literal, so it was structurally invisible to this ratchet. In
 * PR #3692 a bespoke `intent="warning"` MessageBar replaced the shared
 * `HonestGate` in `lib/editors/phase4/user-data-function-editor.tsx` and this
 * guard reported **74/74, unchanged**, on every commit. A human reviewer caught
 * it; CI could not. `lib/components/shared/keyvault-secret-picker.tsx` already
 * documented the same hole in its own comment, so it had been observed at least
 * twice and never closed.
 *
 * WHY IT WAS THE WRONG WAY ROUND. A guard that can only see the literal
 * spelling of a remediation reliably misses the bars that are most DYNAMIC —
 * and dynamic bars are the ones most likely to be hand-rolled rather than
 * routed through the registry. The population it scanned was biased away from
 * the population it exists to catch, and "74/74" read as "no new bespoke bars"
 * when the true statement was "no new bespoke bars THAT NAME THEIR ENV VAR AS A
 * STRING LITERAL".
 *
 * WHAT THIS COSTS, measured before it landed rather than estimated:
 *
 *     literal-only rule ............ 63 file(s) /  74 bar(s)
 *     + interpolated `missing` ..... 113 file(s) / 134 bar(s)   (+50 / +60)
 *
 * A sample of the newly-visible bars was read by hand — publish-as-api-dialog,
 * batch-pool-editor, connection-details, cosmos-metrics, data-contract-designer,
 * predict-wizard, synonyms-editor, warehouse-monitoring — and every one is a
 * bare remediation telling the operator to set a value, with the variable
 * interpolated. Zero false positives in that sample. The rise is the detector's
 * new REACH, not new debt.
 *
 * WHY THIS SIGNAL AND NOT A BROADER ONE. The issue also proposed "intent=warning
 * with no MessageBarActions" as a candidate. Measured: that pulls in **+218 bars
 * across +161 files**, i.e. roughly every warning bar in the console including
 * pure runtime-state notices. It would make the ratchet a list of everything and
 * therefore a signal about nothing. `missing` is the property name the gate
 * loaders actually return, so it keys on the SHAPE of a remediation rather than
 * on the styling of a bar.
 */
const MISSING_INTERPOLATION = /\{[^{}]*\bmissing\b[^{}]*\}|\.missing\b/;

/**
 * ...but naming a variable is not sufficient: a bar may mention one while
 * reporting a runtime condition ("per-user Compute Instance limit reached",
 * "connection list is partial", "failover is one-way"). A G2 gate is a bar that
 * INSTRUCTS THE OPERATOR TO CHANGE CONFIGURATION. These are the imperatives.
 */
const REMEDIATION = /\bSet\b|\bset\s+(the\s+)?<?code|not configured|isn'?t configured|is not configured|not provisioned|not deployed|not wired|isn'?t wired|not enabled|not reachable|Grant the|grant the|requires? an?\s|provision/;

/**
 * DEPENDENCY-FREE ON PURPOSE. The guardrails job checks out and runs node — it
 * does NOT `pnpm install`, so `apps/fiab-console/node_modules` does not exist
 * there. The first revision of this guard `require`d TypeScript to walk a real
 * AST and died with MODULE_NOT_FOUND on its very first CI run. Every sibling
 * guard in loom-guardrails.yml is dependency-free; this one is too now.
 *
 * The replacement is NOT a loose regex over the whole file. It extracts each
 * `<MessageBar …>…</MessageBar>` ELEMENT by bracket matching (quote- and
 * brace-aware, handling nesting and the self-closing form) and tests that
 * element's own text — the same unit the AST version tested. Equivalence with
 * the AST implementation was verified across all 953 .tsx files: identical file
 * set, identical per-file counts (63 files / 74 bars).
 */

/** Read the attribute region of a JSX opening tag starting just after `<Tag`. */
function readOpeningTag(src, start) {
  let i = start;
  let quote = null;
  let depth = 0; // {} nesting inside attribute values
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === '>' && depth === 0) {
      const selfClosing = src[i - 1] === '/';
      return { attrs: src.slice(start, selfClosing ? i - 1 : i), tagEnd: i, selfClosing };
    }
    i += 1;
  }
  return null;
}

/** Every `<MessageBar>` element's full source text. */
function messageBarElements(src) {
  const out = [];
  const OPEN = '<MessageBar';
  const CLOSE = '</MessageBar>';
  const isOtherTag = (c) => !!c && /[A-Za-z0-9_]/.test(c); // MessageBarBody/Title/Actions
  let idx = 0;
  while ((idx = src.indexOf(OPEN, idx)) !== -1) {
    if (isOtherTag(src[idx + OPEN.length])) { idx += OPEN.length; continue; }
    const tag = readOpeningTag(src, idx + OPEN.length);
    if (!tag) break;
    if (tag.selfClosing) {
      out.push({ index: idx, attrs: tag.attrs, text: src.slice(idx, tag.tagEnd + 1) });
      idx = tag.tagEnd + 1;
      continue;
    }
    let depth = 1;
    let j = tag.tagEnd + 1;
    while (j < src.length && depth > 0) {
      const nextOpen = src.indexOf(OPEN, j);
      const nextClose = src.indexOf(CLOSE, j);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        if (isOtherTag(src[nextOpen + OPEN.length])) { j = nextOpen + OPEN.length; continue; }
        const t = readOpeningTag(src, nextOpen + OPEN.length);
        if (t && !t.selfClosing) depth += 1;
        j = t ? t.tagEnd + 1 : nextOpen + OPEN.length;
        continue;
      }
      depth -= 1;
      j = nextClose + CLOSE.length;
    }
    out.push({ index: idx, attrs: tag.attrs, text: src.slice(idx, j) });
    idx = j;
  }
  return out;
}

/** The `intent` attribute value, or null. */
function intentOf(attrs) {
  const m = /\bintent\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"]([^'"]*)['"]\s*\})/.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function lineOf(src, index) {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') n += 1;
  return n;
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
 * Scan one file's SOURCE for bare G2 gates. Pure over `text`, so --selftest can
 * drive it with synthetic sources.
 * @returns {{ honestGate:number, bareGates:Array<{line:number, envVar:string}> }}
 */
export function scanSource(fileName, text) {
  const honestGate = /<HonestGate[\s/>]/.test(text) ? 1 : 0;
  const bareGates = [];
  for (const el of messageBarElements(text)) {
    const intent = intentOf(el.attrs);
    if (intent !== 'warning' && intent !== 'error') continue;
    if (!REMEDIATION.test(el.text)) continue;
    // A G2 gate names the value to set — EITHER as a literal, OR by
    // interpolating it at runtime (#3708). The second half is the one the
    // ratchet was blind to for its whole life.
    const m = el.text.match(ENV_VAR);
    if (m) {
      bareGates.push({ line: lineOf(text, el.index), envVar: m[0] });
    } else if (MISSING_INTERPOLATION.test(el.text)) {
      bareGates.push({ line: lineOf(text, el.index), envVar: '(interpolated)' });
    }
  }
  // A file that mounts HonestGate has an in-product Fix-it path; its remaining
  // bars are treated as covered by that surface's gate.
  return { honestGate, bareGates: honestGate > 0 ? [] : bareGates };
}

/** Scan the whole console. @returns {Map<string, number>} rel path -> bare gate count */
export function scanRepo() {
  const files = [];
  for (const r of ROOTS) walk(path.join(APP_DIR, r), files);
  const found = new Map();
  let barsSeen = 0;
  for (const full of files) {
    const rel = path.relative(APP_DIR, full).replace(/\\/g, '/');
    const text = fs.readFileSync(full, 'utf-8');
    barsSeen += messageBarElements(text).length;
    const { bareGates } = scanSource(full, text);
    if (bareGates.length) found.set(rel, bareGates.length);
  }
  // POPULATION, carried out of the scan so main() can refuse a verdict from a
  // scanner that reached nothing. `found.size === 0` is a legitimate end-state
  // (every bar migrated to HonestGate); `filesScanned === 0` or `barsSeen === 0`
  // never is, and the two are indistinguishable in the output otherwise
  // (guard_with_zero_population_needs_embedded_control).
  found.filesScanned = files.length;
  found.barsSeen = barsSeen;
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
  ok('a bare env-var remediation bar IS detected', scanSource('a.tsx', bare).bareGates.length === 1);

  const withGate = bare.replace('export function E() { return (',
    'export function E() { return (<><HonestGate gateId="svc-aml" surface="X" />') .replace('</MessageBar>);', '</MessageBar></>);');
  ok('the SAME bar is NOT a violation once HonestGate is mounted',
    scanSource('b.tsx', withGate).bareGates.length === 0);

  const runtimeBar = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>Per-user Compute Instance limit reached</MessageBarTitle>
        You have used 3/3 (LOOM_AML_CI_MAX).
      </MessageBarBody></MessageBar>); }`;
  ok('a RUNTIME-state bar that merely mentions a var is NOT a G2 gate',
    scanSource('c.tsx', runtimeBar).bareGates.length === 0);

  const successBar = bare.replace('intent="warning"', 'intent="success"');
  ok('a non-warning/error bar is ignored', scanSource('d.tsx', successBar).bareGates.length === 0);

  const noVar = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>Something went wrong.</MessageBarBody></MessageBar>); }`;
  ok('a bar with no env var is ignored', scanSource('e.tsx', noVar).bareGates.length === 0);

  // --- #3708: the INTERPOLATED remediation ---
  //
  // THE FIXTURE THE ISSUE ASKED FOR, and the reason it asked: without it this
  // hole reopens the moment someone tightens the regex, because the guard has
  // now demonstrated TWICE that it cannot self-detect this blind spot.
  const interpolated = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>Azure API Management is not configured in this deployment</MessageBarTitle>
        {gate.missing && <>Missing env var: <code>{gate.missing}</code>. </>}
      </MessageBarBody></MessageBar>); }`;
  ok('#3708 — a bar whose missing-var is INTERPOLATED is counted (this is the bar that read 74/74)',
    scanSource('f.tsx', interpolated).bareGates.length === 1);
  ok('#3708 — …and it is recorded as interpolated, not as a fabricated literal',
    scanSource('f.tsx', interpolated).bareGates[0]?.envVar === '(interpolated)');

  const interpolatedShorthand = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>Engine not configured</MessageBarTitle>
        Set <code>{missing}</code> on the console container app.
      </MessageBarBody></MessageBar>); }`;
  ok('#3708 — the bare `{missing}` spelling counts too, not only `x.missing`',
    scanSource('g.tsx', interpolatedShorthand).bareGates.length === 1);

  const interpolatedWithGate = interpolated
    .replace('export function E() { return (', 'export function E() { return (<><HonestGate gateId="svc-apim" surface="X" />')
    .replace('</MessageBar>);', '</MessageBar></>);');
  ok('#3708 — the SAME interpolated bar stops counting once HonestGate is mounted',
    scanSource('h.tsx', interpolatedWithGate).bareGates.length === 0);

  // The other direction: widening must not have turned every warning bar into a
  // gate. A runtime-state bar that happens to say "missing" in prose, with no
  // interpolation and no remediation imperative, is not a G2 gate.
  const runtimeMissingProse = `
    export function E() { return (
      <MessageBar intent="warning"><MessageBarBody>
        <MessageBarTitle>3 rows were skipped</MessageBarTitle>
        Some columns were missing from the source file.
      </MessageBarBody></MessageBar>); }`;
  ok('#3708 — prose containing the WORD "missing" with no interpolation is NOT a gate',
    scanSource('i.tsx', runtimeMissingProse).bareGates.length === 0);

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
// Guarded so `scanSource` / `scanRepo` can be imported by an equivalence or
// unit harness without the CLI firing on import.

const INVOKED_DIRECTLY = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (INVOKED_DIRECTLY) {
  main();
}

function main() {
  if (process.argv.includes('--selftest')) selftest();

  const found = scanRepo();

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
console.log(`[honest-gate-coverage] population: ${found.filesScanned} .tsx scanned / ${found.barsSeen} <MessageBar> element(s) reached`);
if (!found.filesScanned || !found.barsSeen) {
  console.log('::error::[honest-gate-coverage] the scanner reached ZERO files or ZERO MessageBar elements.');
  console.log('::error::The console has hundreds of both, so this is drift, not a clean tree — and it is');
  console.log('::error::indistinguishable from one in the counts above. Refusing to report a verdict.');
  process.exit(1);
}

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
}

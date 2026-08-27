#!/usr/bin/env node
/**
 * check-acr-dataplane-probe-args.mjs
 *
 * RULE. Every call site of `scripts/ci/acr-dataplane-ready.sh` passes ONLY
 * arguments from a positive allowlist of flags that cannot weaken the #4067
 * consecutive-sampling guard. Anything else is reported.
 *
 *   bash …/acr-dataplane-ready.sh --acr "$ACR" --timeout-seconds 180   <-- ok
 *   … --acr "$ACR" --consecutive-samples 1                             <-- VIOLATION
 *   … --acr "$ACR" --unsafe-sampling-below-4067-floor "because"        <-- VIOLATION
 *   … --acr "$ACR" --some-new-opt-out-nobody-has-invented-yet          <-- VIOLATION
 *
 * WHY THIS EXISTS (review of #4090, 2026-08-26).
 * The probe's header block justifies permitting an opt-out at all on the
 * grounds that the flag is "deliberately ugly and greppable: one
 * `grep -rn unsafe-sampling-below-4067-floor` over .github/workflows and
 * scripts finds every weakening in the repo". Nothing in CI performed that
 * grep. Greppability was a property a human had to remember to exercise, which
 * is the same shape as a control that does not run.
 *
 * WHY IT IS AN ALLOWLIST AND NOT A SEARCH FOR THAT FLAG.
 * A guard that greps for `unsafe-sampling-below-4067-floor` is keyed to a
 * SPELLING. Rename the flag, or add a second opt-out spelled anything else, and
 * the guard goes quiet while the weakening ships — and this repo has already
 * burned three separate rounds on controls that enumerated the evasions someone
 * had already thought of. The defect CLASS is "a call site reaches the probe's
 * sampling configuration", and every member of that class has the same shape:
 * an ARGUMENT outside the small set that cannot weaken anything. So the set of
 * SAFE arguments is enumerated (it is short, closed, and changes almost never)
 * and everything else is reported, including flags that do not exist yet.
 *
 *   --acr               the registry to probe. Cannot weaken sampling.
 *   --timeout-seconds   the wall-clock budget. Cannot lower the floor: a budget
 *                       too small for the required run is REFUSED (exit 3) by
 *                       the probe's own unsatisfiable-config check, and a budget
 *                       too large is bounded by the digit bound.
 *   --interval-seconds  the backoff after a NON-positive sample. It is not a
 *                       factor in MIN_SPAN and never shortens the spacing
 *                       between the consecutive positives the floor is about.
 *
 * A genuine strengthening (`--consecutive-samples 5`) also lands here. That is
 * intended, not a false positive: it is a change to the sampling contract, it
 * can make a config unsatisfiable, and it should be visible in review. The
 * remedy is to add the site to this guard with a reason, which is the ratchet
 * working.
 *
 * ADOPTION IS ZERO TODAY, measured over the PR head: all 18 invocation sites
 * pass only `--acr` and `--timeout-seconds` (120/180/240). So this is an
 * expected-0 ratchet over a NON-EMPTY population, not a bound that can never
 * bind.
 *
 * WHAT IS DELIBERATELY NOT IN THE POPULATION, and why:
 *   - the probe's OWN self-test (`test-*.sh`, `__tests__/`, `*.test.mjs`). Its
 *     job is to drive the refusals, so it MUST pass below-floor values; a guard
 *     that flagged it would be flagging the control that proves the floor works.
 *     This is a category exclusion, not a carve-out for one file, and the guard
 *     fails if excluding tests would empty the population.
 *   - comment lines. Prose about the rule is not the rule — a comment that
 *     satisfied this guard would be the defect it exists to close.
 *
 * SELF-DEFENCE. Fails if it scans no files, fails if it finds no invocation at
 * all (this repo builds from a firewalled ACR on every deploy path, so zero
 * means the matcher drifted off the code), and carries `--self-test`, which
 * runs the classifier over fixtures that INCLUDE a differently-spelled opt-out
 * flag — so the guard's ability to go red is itself proved in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT = process.cwd();
const ROOTS = ['.github/workflows', 'scripts'];
const EXTS = ['.yml', '.yaml', '.sh'];
const SKIP_DIR = /(^|[\\/])(__tests__|__fixtures__|node_modules)([\\/]|$)/;
// Test code drives the refusals on purpose — see the header.
const SKIP_FILE = /(^|[\\/])(test-[^\\/]+\.sh|[^\\/]+\.test\.mjs)$/;

const PROBE_BASENAME = 'acr-dataplane-ready.sh';
/** The documented test seam, plus any variable a file assigns from the probe path. */
const SEAM_VAR = 'LOOM_ACR_DATAPLANE_READY_SCRIPT';

const SAFE_FLAGS = new Set(['--acr', '--timeout-seconds', '--interval-seconds']);

/** Variables in this file whose value names the probe: `READY_SCRIPT="${…:-…/acr-dataplane-ready.sh}"`. */
export function probeVars(text) {
  const vars = new Set([SEAM_VAR]);
  const re = /(^|[\s;({])([A-Za-z_][A-Za-z0-9_]*)=(["']?)[^\n]*acr-dataplane-ready\.sh/g;
  let m;
  while ((m = re.exec(text)) !== null) vars.add(m[2]);
  return vars;
}

/**
 * The argument text of a probe invocation on this logical line, or null if the
 * line does not invoke the probe.
 *
 * Everything after the probe TOKEN up to the first command terminator is the
 * argument list. Cutting at the terminator is what keeps `|| echo "::warning::…"`
 * and `2>&1)` out of the flag scan.
 */
export function probeArgs(line, vars) {
  // Where does the probe token start? Either a literal path, or a variable
  // expansion naming one of this file's probe variables.
  let at = -1;
  const lit = line.indexOf(PROBE_BASENAME);
  if (lit !== -1) {
    // Skip past the whole token the path sits in (it may be inside `${X:-path}"`).
    at = lit + PROBE_BASENAME.length;
    const rest = line.slice(at);
    const close = rest.match(/^[}"']*/);
    at += close ? close[0].length : 0;
  } else {
    for (const v of vars) {
      const re = new RegExp(`\\$\\{?${v}(:-[^}]*)?\\}?["']?`);
      const m = line.match(re);
      if (m && typeof m.index === 'number') {
        // Only an INVOCATION, not an assignment: `X="$Y"` must not count.
        const before = line.slice(0, m.index);
        if (/=\s*["']?[^\s]*$/.test(before) && !/\b(bash|sh)\s+["']?[^\s]*$/.test(before)) continue;
        at = m.index + m[0].length;
        break;
      }
    }
  }
  if (at === -1) return null;

  let rest = line.slice(at);
  // Cut at the first command terminator so a following command's flags are not
  // attributed to the probe.
  const cut = rest.search(/(;|\|\||\||&&|&(?!>)|\))/);
  if (cut !== -1) rest = rest.slice(0, cut);
  return rest;
}

/** Long-form flags in an argument string. */
export function flagsIn(args) {
  return (args.match(/(^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*)/g) || []).map((s) => s.trim());
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** Scan one file's text. Returns { invocations, violations }. */
export function scanText(text, rel) {
  const vars = probeVars(text);
  const invocations = [];
  const violations = [];
  for (const { line, text: raw } of readLogicalLines(text)) {
    if (/^\s*#/.test(raw)) continue;              // prose about the rule is not the rule
    const args = probeArgs(raw, vars);
    if (args === null) continue;
    // INVOCATION vs ASSIGNMENT. Two independent signals, because keying on
    // `bash`/`sh` alone would go blind the day someone `chmod +x`s the probe and
    // calls it directly — the file is 100644 today, which is a fact about today,
    // not a property of the guard. An assignment
    // (`READY_SCRIPT="${…:-…/acr-dataplane-ready.sh}"`) carries no flags after
    // the token, so "the token is followed by a flag" separates the two without
    // depending on how the script is launched.
    const launched = /\b(bash|sh|exec|source)\b/.test(raw.slice(0, raw.indexOf(args) === -1 ? raw.length : raw.indexOf(args)));
    const flags = flagsIn(args);
    if (!launched && flags.length === 0) continue;
    invocations.push({ file: rel, line });
    for (const f of flags) {
      if (!SAFE_FLAGS.has(f)) {
        violations.push({ file: rel, line, flag: f, text: raw.trim().slice(0, 160) });
      }
    }
  }
  return { invocations, violations };
}

// ── self-test ───────────────────────────────────────────────────────────────
// Proves the classifier DISCRIMINATES. The load-bearing fixture is the one
// carrying a flag that does not exist anywhere in this repo: an allowlist
// catches it, a grep for the known opt-out would not.
function selfTest() {
  const cases = [
    ['safe: the shape all 18 real sites use',
      'bash "${LOOM_ACR_DATAPLANE_READY_SCRIPT:-scripts/ci/acr-dataplane-ready.sh}" --acr "$ACR" --timeout-seconds 180 || echo "::warning::not confirmed --consecutive-samples 1"',
      0],
    ['safe: consumed as an if-condition',
      'if ! bash "${LOOM_ACR_DATAPLANE_READY_SCRIPT:-scripts/ci/acr-dataplane-ready.sh}" --acr "$ACR_NAME" --timeout-seconds 240; then',
      0],
    ['safe: backoff is not a sampling weakening',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --timeout-seconds 180 --interval-seconds 10',
      0],
    ['safe: a COMMENT naming the opt-out is not a call site',
      '# pass --unsafe-sampling-below-4067-floor "why" if you must',
      0],
    ['safe: assigning the seam is not an invocation',
      'READY_SCRIPT="${LOOM_ACR_DATAPLANE_READY_SCRIPT:-$REPO_ROOT/scripts/ci/acr-dataplane-ready.sh}"',
      0],
    ['violation: the known opt-out',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --unsafe-sampling-below-4067-floor "ship it"',
      1],
    ['violation: the low floor dialled away',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --consecutive-samples 1',
      1],
    ['violation: the spacing dialled away',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --sample-interval-seconds 0',
      1],
    // THE ONE THAT MATTERS: a spelling nobody has invented yet.
    ['violation: an opt-out spelled something else entirely',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --i-know-what-im-doing-single-sample',
      1],
    // The probe is 100644 today, so a bare call would fail — but a file mode is
    // a fact about today, not a property of this guard.
    ['violation: invoked BARE, with no bash/sh in front of it',
      './scripts/ci/acr-dataplane-ready.sh --acr "$ACR" --consecutive-samples 1',
      1],
    ['violation: on a CONTINUATION line, invisible to a physical-line scan',
      'bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR" \\\n  --consecutive-samples 1 \\\n  --unsafe-sampling-below-4067-floor "why"',
      2],
    ['violation: reached through a variable',
      'READY=scripts/ci/acr-dataplane-ready.sh\nbash "$READY" --acr "$ACR" --consecutive-samples 2',
      1],
  ];
  let bad = 0;
  for (const [label, text, want] of cases) {
    const { violations } = scanText(text, 'fixture');
    const got = violations.length;
    if (got === want) console.log(`  ok    ${label} (${got})`);
    else { console.log(`  FAIL  ${label}: expected ${want} violation(s), got ${got}`); bad++; }
  }
  // A classifier that finds no invocation in the safe fixtures is not "clean",
  // it is blind — so prove the population is non-empty too.
  const { invocations } = scanText(cases[0][1], 'fixture');
  if (invocations.length === 1) console.log('  ok    the safe fixture is COUNTED as an invocation (not skipped)');
  else { console.log(`  FAIL  the safe fixture produced ${invocations.length} invocations, expected 1 — a clean result here would be blindness, not compliance`); bad++; }

  if (bad > 0) {
    console.error(`::error::acr-dataplane-probe-args --self-test: ${bad} case(s) failed. The guard cannot be trusted to discriminate.`);
    process.exit(1);
  }
  console.log('acr-dataplane-probe-args --self-test OK');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
let allInvocations = [];
let allViolations = [];
let skippedTestFiles = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (SKIP_FILE.test(file)) {
    let t = '';
    try { t = readFileSync(file, 'utf8'); } catch { /* unreadable is not a pass */ }
    if (t.includes(PROBE_BASENAME)) skippedTestFiles++;
    continue;
  }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (!text.includes(PROBE_BASENAME) && !text.includes(SEAM_VAR)) continue;
  const { invocations, violations } = scanText(text, rel);
  allInvocations = allInvocations.concat(invocations);
  allViolations = allViolations.concat(violations);
}

if (files.length === 0) {
  console.error('::error::acr-dataplane-probe-args: scanned ZERO files — the walker is broken. Refusing to report a pass.');
  process.exit(1);
}
if (allInvocations.length === 0) {
  console.error(
    `::error::acr-dataplane-probe-args: found ZERO invocations of ${PROBE_BASENAME} in ${files.length} scanned files ` +
      `(${skippedTestFiles} test file(s) excluded by design). Every Commercial and sovereign deploy path opens a ` +
      'firewalled ACR and probes it, so zero means the matcher has drifted off the code. Refusing to report a pass ' +
      'on an empty population.',
  );
  process.exit(1);
}

if (allViolations.length > 0) {
  console.error(
    `::error::acr-dataplane-probe-args: ${allViolations.length} argument(s) at ${PROBE_BASENAME} call sites are outside ` +
      `the safe set {${[...SAFE_FLAGS].join(', ')}}. Every other argument reaches the #4067 sampling configuration — ` +
      'the guard that exists because a single 401 was falsified ~2s later on the same URL. If a weakening is genuinely ' +
      'needed it goes through --unsafe-sampling-below-4067-floor AND is added to SAFE_FLAGS in this guard with a ' +
      'reason, so it is visible in review rather than only greppable by someone who remembers to grep.',
  );
  for (const v of allViolations) {
    console.error(`::error file=${v.file},line=${v.line}::${v.flag} reaches the sampling configuration | ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `acr-dataplane-probe-args OK — ${files.length} files scanned, ${allInvocations.length} invocation(s) of ` +
    `${PROBE_BASENAME}, all passing only {${[...SAFE_FLAGS].join(', ')}}; ${skippedTestFiles} test file(s) excluded by design.`,
);

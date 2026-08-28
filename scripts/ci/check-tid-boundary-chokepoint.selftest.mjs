#!/usr/bin/env node
/**
 * SELF-TEST for check-tid-boundary-chokepoint.mjs section 10 (merge-blocker).
 *
 * WHY THIS FILE EXISTS. Section 10's stale-pin rule has a third arm: a pinned
 * expression that has DISAPPEARED from a file which now imports
 * `lib/auth/tenant-boundary` is the INTENDED end state (the site consolidated
 * onto the shared comparison), so it prints a NOTE instead of failing. Without
 * that arm the guard made the correct fix a red build and then told the author
 * not to fix it.
 *
 * THAT ARM SHIPPED DEAD. `importsTenantBoundary` tested the module specifier
 * against MASKED source, and `mask()` blanks string-literal INTERIORS — so by
 * the time the regex ran, `'./tenant-boundary'` was spaces and the arm COULD
 * NEVER FIRE. Applying exactly the consolidation the pin's own reason names as
 * the follow-up produced exit 1 with "…that file does NOT import
 * `lib/auth/tenant-boundary`" WHILE the file imported it. The guard asserted as
 * fact something it never established — the R7 defect its own docblock condemns.
 *
 * Nothing measured the arm, so nothing noticed. This measures it:
 *
 *   CASE 0  POPULATION CONTROL (#3840) — before inferring anything from the
 *           guard's reaction to the fixture, prove the guard can SEE it, in both
 *           directions: unpinned it must FAIL naming a private copy, and pinned
 *           it must return to exit 0. Without this, a fixture the scan never
 *           reached would make CASE 1 report "exit 0, no failure" — identical to
 *           success, while measuring nothing. It also re-measures the isolation
 *           claim below: the candidate-export census must not move when the
 *           fixture appears.
 *   CASE 1  NEGATIVE CONTROL — consolidate a PINNED site onto
 *           `sameTenantConfirmed`. EXPECT exit 0, a NOTE naming the file, and NO
 *           "does NOT import" failure. It ALSO asserts the per-pin
 *           `onConsolidation` clause is in that NOTE (#3877-f2): the note used
 *           to be one template for every pin, and for `item-access.ts` the
 *           template said "that is the intended end state, delete the entry"
 *           while that pin's own reason said its lenient boundary was
 *           deliberate, that tightening it was a review, and that its
 *           POST_DELEGATION position pin made deleting it a red build. A NOTE
 *           that contradicts the pin it is about is worse than no NOTE.
 *   CASE 2  DISCRIMINATION — reintroduce the dead arm verbatim and re-run
 *           CASE 1. EXPECT it to FAIL. A control that cannot fail is not a
 *           control, which is the whole lesson of this file.
 *   CASE 3  TYPE-ONLY IMPORT (#3877-f1) — perform the SAME removal but bring the
 *           module in with `import type { … }`. A type-only import is ERASED at
 *           compile time: nothing arrives in the module, so it cannot be the
 *           consolidation the arm exists to bless. EXPECT the arm to REFUSE —
 *           non-zero exit and the "does NOT import" failure. Before the fix this
 *           was a green build with an approving NOTE over a DELETED boundary,
 *           i.e. the arm blessing exactly the change it exists to catch.
 *
 * It edits ONE tracked file in place (the guard), writes and deletes ONE
 * UNTRACKED synthetic fixture, and restores both in a `finally` — then verifies
 * the tracked file byte-for-byte and the fixture's ABSENCE. Run it from the repo
 * root; it takes a few minutes, because it runs the guard eight times:
 *
 *     node scripts/ci/check-tid-boundary-chokepoint.selftest.mjs
 *
 * WHY IN PLACE, AND WHAT THAT COSTS. Section 10 scans `apps/fiab-console/{app,lib}`
 * by path relative to the repo root, and the pins are keyed on those paths — so
 * the subject cannot live outside the console tree. Until #3840 the subject was
 * a REAL file (`lib/auth/item-access.ts`) mutated in place; it is now a synthetic
 * fixture under `lib/__tid_selftest_fixture__/`, which removes the real-file
 * mutation window entirely and, more importantly, decouples this control from a
 * state its own subject was expected to leave (see the FIXTURE block below).
 * `apps/fiab-console/lib/auth/workspace-access.ts` is still mutated in place by
 * CASE 4.
 *
 * The remaining window is bounded three ways: a `finally`, SIGINT/SIGTERM/
 * uncaughtException handlers, and the verification afterwards that FAILS LOUDLY
 * if the tree is not back.
 *
 * WHAT THOSE HANDLERS DO NOT COVER — MEASURED, not assumed. This file used to
 * say only "nothing survives SIGKILL". That understates it: the script spends
 * almost all of its wall-clock inside `spawnSync`, which BLOCKS the event loop,
 * so a SIGTERM arriving during a guard run cannot be delivered to the JS handler
 * either. Observed 2026-08-28 — a `timeout 120` kill left the guard mutated and
 * the fixture on disk, with no handler output. If this script is killed for ANY
 * reason, run:
 *
 *     git checkout -- scripts/ci/check-tid-boundary-chokepoint.mjs \
 *                     apps/fiab-console/lib/auth/workspace-access.ts
 *     rm -rf apps/fiab-console/lib/__tid_selftest_fixture__
 *
 * The fixture needs the `rm` because it is UNTRACKED — `git checkout --` will
 * not remove it, and a leftover copy fails the guard on the next run with a
 * private-copy error nobody would trace back to here.
 *
 * IT IS DELIBERATELY NOT A `node:test` SUITE. `check-node-test-suites.mjs`
 * discovers `__tests__/*.test.mjs` and runs suites CONCURRENTLY in separate
 * processes, where an in-place mutation window can be observed by a concurrent
 * working-tree check. Measured: this file is absent from that runner's 124-suite
 * discovery list. It is invoked as its OWN step in
 * `.github/workflows/loom-guardrails.yml`, next to the guard it tests — which is
 * also what `check-ci-guard-reachability.mjs` requires, since a control no
 * workflow runs proves nothing (that gate caught this file on its first push).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const GUARD = 'scripts/ci/check-tid-boundary-chokepoint.mjs';

// ── THE SUBJECT IS A SYNTHETIC FIXTURE, NOT A REAL FILE (#3840) ──────────────
//
// CASES 1-3 used to consolidate `apps/fiab-console/lib/auth/item-access.ts` in
// place, pinned to its PRE-fix text. #3840 then applied that very consolidation
// for real, so the pinned string vanished from the tree and this file began
// exiting `2 — SETUP FAILED`: the control was coupled to a state its own subject
// was expected to leave. A control that breaks when the fix it describes finally
// lands is a control that gets deleted rather than fixed.
//
// WHY NOT JUST RE-POINT IT AT ANOTHER REAL FILE. `lib/auth/workspace-access.ts`
// is the only other file left carrying a raw pinned comparison, and it ALREADY
// value-imports `sameTenantConfirmed` (step 4, post-#3900). CASE 1 and CASE 3
// differ by exactly one token — a VALUE import versus a TYPE-only one — so a
// subject that already satisfies the import predicate before the mutation makes
// the two cases indistinguishable, and CASE 3 would pass for the wrong reason.
// There is no real file with the shape these cases need, which is the point:
// the tree is supposed to have run out of them.
//
// WHERE IT LIVES, AND WHY THAT EXACT DIRECTORY. Measured against the guard, not
// assumed — see the SETUP population control below, which asserts both halves on
// every run:
//   * section 10 walks `SCAN_DIRS = [apps/fiab-console/app, apps/fiab-console/lib]`,
//     so a file here IS seen as a private copy of the comparison and DOES require
//     a pin — which is the subject CASES 1-3 need;
//   * the authorizer derivation reads `AUTHZ_DIR = apps/fiab-console/lib/auth`
//     ONLY, so a fixture outside that directory cannot perturb the candidate-export
//     census, the delegation checks, or the guarded-call-site count.
// Measured on a clean tree: guarded call sites 29 -> 29 and candidate exports
// 29 -> 29 with the fixture present, while the comparison census moves 8-in-2-files
// -> 9-in-3-files. It is visible to exactly the scan under test and invisible to
// the others.
const FIXTURE_DIR = 'apps/fiab-console/lib/__tid_selftest_fixture__';
const FIXTURE = `${FIXTURE_DIR}/fixture.ts`;
/** The pin key is repo-relative to CONSOLE_ROOT, the way the guard keys them. */
const FIXTURE_REL = 'lib/__tid_selftest_fixture__/fixture.ts';

const IMPORT_ANCHOR = '// selftest-import-anchor';
const VALUE_IMPORT = "import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';";
/** CASE 3 — the same specifier brought in as a TYPE, which is erased at build. */
const TYPE_ONLY_IMPORT = "import type { TenantMatch } from '@/lib/auth/tenant-boundary';";
const OLD_CMP = 'if (wsDoc?.tid && wsDoc.tid !== tid) return null;';
const NEW_CMP = 'if (!sameTenantConfirmed(tid, wsDoc?.tid)) return null;';

/**
 * The fixture in its PRE-consolidation form: it carries the raw comparison the
 * injected pin names, and does not import the shared module.
 *
 * `sameTenantConfirmed` must be CALLED for `importsTenantBoundary` to count the
 * import — an unused binding consolidates nothing (#3877-1) — which is why the
 * consolidated form substitutes a call rather than only adding an import line.
 */
const FIXTURE_SRC = [
  IMPORT_ANCHOR,
  '/**',
  ' * SYNTHETIC FIXTURE — written and deleted by',
  ' * `scripts/ci/check-tid-boundary-chokepoint.selftest.mjs` within a single process.',
  ' *',
  ' * IT MUST NEVER BE COMMITTED. If you are reading this in a diff or a `git status`,',
  ' * the self-test did not clean up: delete the whole',
  ' * `apps/fiab-console/lib/__tid_selftest_fixture__/` directory.',
  ' */',
  'export function selftestTenantFixture(',
  '  wsDoc: { tid?: string } | undefined,',
  '  tid: string | undefined,',
  '): { tid?: string } | null {',
  `  ${OLD_CMP}`,
  '  return wsDoc ?? null;',
  '}',
  '',
].join('\n');

/**
 * The TID_COMPARISON_PINS entry injected for the fixture, and the anchor it is
 * inserted after. Injected at runtime and removed with the rest of the mutation,
 * so a committed tree carries neither the fixture nor a pin for it — a pin with
 * no file is exactly the stale-pin state this guard fails on.
 */
//
// THE ANCHOR CARRIES NO LINE TERMINATOR, AND THE PIN IS JOINED WITH THE GUARD'S
// OWN EOL. `core.autocrlf` checks this repo out with CRLF on Windows and LF in
// CI, so an anchor written as `…new Map([\n` matches in CI and silently misses
// on a developer's machine — SETUP FAILED, which halts before CASE 1 and
// therefore measures nothing while still going red. Same reason `RESOLVER_EOL`
// exists below; this is that lesson applied to the injection.
const PIN_ANCHOR = 'const TID_COMPARISON_PINS = new Map([';
const FIXTURE_PIN_LINES = [
  "  [",
  `    '${FIXTURE_REL}',`,
  '    {',
  '      reason:',
  "        'SYNTHETIC FIXTURE, injected at runtime by check-tid-boundary-chokepoint.selftest.mjs '",
  "        + 'and removed again in the same process. It gives CASES 1-3 a pinned site to '",
  "        + 'consolidate without mutating a real one. Never present on a committed tree.',",
  '      onConsolidation:',
  "        'this clause exists so the self-test can prove the per-pin onConsolidation text '",
  "        + 'actually reaches the NOTE (#3877-f2). A real pin says what the behaviour change '",
  "        + 'costs; this one only has to be distinguishable from the generic sentence.',",
  "      exprs: ['wsDoc.tid !== tid'],",
  '    },',
  '  ],',
];

/**
 * The defect, reintroduced for CASE 2. It USED to live at the CALL — the arm
 * took `(masked, raw)` and the call could pass masked twice — and this file
 * pinned that call's exact text. `importsTenantBoundary` now takes ONE raw
 * string and masks internally (#3877-f1), so that mutation is no longer
 * expressible and the pin moves to the MECHANISM: the one line that decides
 * whether the specifier is read from raw source or from masked source, where
 * `mask` has already blanked it to spaces.
 */
const ARM_LIVE = 'const stmt = raw.slice(a, b);';
const ARM_DEAD = 'const stmt = masked.slice(a, b);';

/** The #3877-f2 per-pin clause CASE 1 requires to be present in the NOTE. */
const ONCONSOLIDATION_MARKER = 'READ THIS FIRST';

// ── CASE 4 fixtures: the sections-1..4 tenant-comparison test (#3900) ────────
// The section is exercised in-process by ten embedded control arms inside the
// guard. CASE 4 is the END-TO-END pair for the two that matter most, applied to
// the real resolver on disk rather than to a synthetic string, because the
// defect it pins was a FALSE POSITIVE against a real file: the test was keyed to
// a proximity window (a refusal within 80 characters of the comparison) and
// #3900's refusal is 2007 characters below its comparison — separated by a long
// comment and a nested diagnostic — and unconditional. The guard failed correct
// code and reported the cause as "DISCARDED", which it had not measured.
const RESOLVER = 'apps/fiab-console/lib/auth/workspace-access.ts';
/**
 * THE BOUNDARY STATEMENT IS NO LONGER ONE LINE, SO THIS ANCHOR IS BRACE-MATCHED
 * RATHER THAN QUOTED. #3900 consolidated the comparison onto
 * `sameTenantConfirmed(...)`, and the refusal now sits at the top level of a
 * ~35-line block, below a long comment and a nested diagnostic — which is
 * precisely the shape CASE 4a exists to protect. Pinning that block as a literal
 * would mean quoting every one of those comment lines, so any reword of a COMMENT
 * would break this control.
 *
 * AND BREAKING IT MEANS `exit 2 — SETUP FAILED`, WHICH IS WORSE THAN A FAILING
 * CASE, NOT MILDER: the harness stops before CASE 1, so nothing is measured at
 * all while the job still goes red. The previous literal did exactly that the
 * moment #3900 removed the line it quoted. Anchor on the opening `if` — the one
 * thing the section under test actually keys on — and take the rest structurally.
 */
const RESOLVER_CMP_OPEN = 'if (!sameTenantConfirmed(callerTid, wsDoc.tid)) {';

/**
 * The whole `if (…) { … }` statement that `open` begins, comment- and
 * string-aware so that a `}` inside a comment or inside a log string cannot
 * close it early. Returns null when the anchor is absent or the braces never
 * balance; the caller reports both as SETUP FAILED rather than quietly
 * measuring a truncated block.
 */
function braceMatchedStatement(src, open) {
  const start = src.indexOf(open);
  if (start === -1) return null;
  let i = start + open.length; // just past the `{` that `open` ends with
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const e = src.indexOf('\n', i);
      if (e === -1) return null;
      i = e + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e === -1) return null;
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(start, i) : null;
}
/** The message the section emits. CASE 4 asserts on THIS, not on the exit code:
 *  any edit to this function also moves its NON_AUTHORIZER_BODY_PINS digest, so
 *  both arms exit non-zero for that separate (and correct) reason. */
const RESOLVER_CMP_FAILURE = 'no longer makes a REFUSING tenant comparison';

const problems = [];
const read = (p) => readFileSync(p, 'utf8');

function runGuard() {
  // Decode explicitly as utf-8: the guard's output carries em-dashes, and a
  // locale-decoded (cp1252 on Windows) buffer makes every needle miss. That
  // cost one false FAIL of this control while the arm was working.
  const r = spawnSync('node', [GUARD], { encoding: 'buffer' });
  const out =
    (r.stdout ?? Buffer.alloc(0)).toString('utf8') + (r.stderr ?? Buffer.alloc(0)).toString('utf8');
  return { code: r.status, out };
}

/** Write the synthetic fixture, creating its directory. */
function writeFixture(src) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE, src);
}

/** Remove the fixture and its directory. Idempotent. */
function removeFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

/** The guard with the fixture's TID_COMPARISON_PINS entry injected, using the
 *  guard's OWN line terminator so this works on a CRLF checkout too. */
function guardWithFixturePin(guardSrc) {
  const eol = guardSrc.includes('\r\n') ? '\r\n' : '\n';
  const at = guardSrc.indexOf(PIN_ANCHOR);
  if (at === -1) throw new Error('PIN_ANCHOR vanished between the setup check and the injection');
  const after = at + PIN_ANCHOR.length;
  return guardSrc.slice(0, after) + eol + FIXTURE_PIN_LINES.join(eol) + guardSrc.slice(after);
}

/** Apply the consolidation to the FIXTURE, run the guard, return the observation.
 *  `importLine` is what the consolidating commit adds — a VALUE import for the
 *  real fix, a TYPE-ONLY one for CASE 3. Restoration is the caller's job. */
function measureConsolidation(guardSrc, importLine = VALUE_IMPORT) {
  writeFixture(
    FIXTURE_SRC.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${importLine}`).replace(OLD_CMP, NEW_CMP),
  );
  writeFileSync(GUARD, guardWithFixturePin(guardSrc));
  const { code, out } = runGuard();
  // ASCII-only needles on purpose — see runGuard().
  return {
    code,
    note:
      out.includes('no longer carries') &&
      out.includes(FIXTURE_REL) &&
      out.includes('imports the shared comparison'),
    perPinNote: out.includes(ONCONSOLIDATION_MARKER),
    falseFail: out.includes('does NOT import'),
  };
}

const guardBefore = read(GUARD);
const resolverBefore = read(RESOLVER);
const RESOLVER_EOL = resolverBefore.includes('\r\n') ? '\r\n' : '\n';
/** Read out of the tree rather than quoted — see RESOLVER_CMP_OPEN above. */
const RESOLVER_CMP = braceMatchedStatement(resolverBefore, RESOLVER_CMP_OPEN);

/** Replace the resolver's boundary statement, run the guard, report whether the
 *  sections-1..4 comparison failure fired. Restoration is the caller's job. */
function measureResolver(replacement) {
  writeFileSync(RESOLVER, resolverBefore.replace(RESOLVER_CMP, replacement));
  const { code, out } = runGuard();
  return { code, cmpFailure: out.includes(RESOLVER_CMP_FAILURE) };
}

/**
 * Restore on the way out, however we leave. `finally` covers a thrown error; a
 * SIGINT/SIGTERM (a cancelled CI job, a Ctrl-C) would otherwise leave two
 * TRACKED files mutated on disk, which is the hazard that makes in-place
 * mutation worth guarding rather than assuming.
 */
let restored = false;
function restoreTree() {
  if (restored) return;
  restored = true;
  try {
    writeFileSync(GUARD, guardBefore);
    writeFileSync(RESOLVER, resolverBefore);
    // The fixture is CREATED by this script, so restoring it means deleting it —
    // leaving it behind would be an untracked file that fails the guard on the
    // next run for a reason nobody would connect to this script.
    removeFixture();
  } catch (e) {
    console.error(
      `[selftest] RESTORE THREW — run: git checkout -- ${GUARD} ${RESOLVER}` +
        `  &&  rm -rf ${FIXTURE_DIR}`,
      e,
    );
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restoreTree();
    console.error(`[selftest] ${sig} — tracked files restored; exiting.`);
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restoreTree();
  console.error('[selftest] uncaught exception — tracked files restored.', e);
  process.exit(1);
});

// THE RESOLVER ANCHOR IS CHECKED SEPARATELY FROM THE LITERAL NEEDLES BELOW,
// because it is COMPUTED and can be null, and `String.prototype.includes(null)`
// coerces to a search for the text "null" — which this resolver contains, so a
// missing anchor would have PASSED that loop and left CASE 4 mutating nothing.
// Uniqueness is asserted too: `measureResolver` substitutes with
// `String.replace`, which rewrites only the FIRST occurrence.
{
  const hits = RESOLVER_CMP === null ? 0 : resolverBefore.split(RESOLVER_CMP).length - 1;
  if (RESOLVER_CMP === null || hits !== 1) {
    const why =
      RESOLVER_CMP === null
        ? 'not found, or its braces never balanced'
        : `matched ${hits}x, expected exactly 1`;
    console.error(
      `[selftest] SETUP FAILED — resolver boundary statement ${why}: ${JSON.stringify(RESOLVER_CMP_OPEN)}`,
    );
    console.error('[selftest] This self-test anchors on that exact opening; re-point it as part of whatever moved it.');
    process.exit(2);
  }
}

for (const [label, hay, needle] of [
  ['fixture import anchor', FIXTURE_SRC, IMPORT_ANCHOR],
  ['fixture comparison', FIXTURE_SRC, OLD_CMP],
  ['guard pin-map anchor', guardBefore, PIN_ANCHOR],
  ['guard arm call site', guardBefore, ARM_LIVE],
]) {
  if (!hay.includes(needle)) {
    console.error(`[selftest] SETUP FAILED — ${label} not found: ${JSON.stringify(needle.slice(0, 70))}`);
    console.error('[selftest] This self-test is pinned to those exact strings; re-point it as part of whatever moved them.');
    process.exit(2);
  }
}

// THE FIXTURE MUST NOT ALREADY EXIST. If it does, a previous run died between
// writing it and cleaning up, and every case below would be measuring a tree
// somebody else left behind.
if (existsSync(FIXTURE_DIR)) {
  console.error(`[selftest] SETUP FAILED — ${FIXTURE_DIR} already exists.`);
  console.error('[selftest] A previous run did not clean up. Delete it and re-run.');
  process.exit(2);
}

let clean;
try {
  clean = runGuard();

  // ── CASE 0: POPULATION CONTROL — the fixture is actually SEEN ─────────────
  //
  // Every case below infers something from the guard's reaction to the fixture.
  // If the guard could not see the fixture at all, CASE 1 would report exit 0
  // and no failure — indistinguishable from success — while measuring nothing.
  // That is the single most common way a control in this repo has been green
  // over an empty population, so it is asserted rather than assumed, and it is
  // asserted in BOTH directions:
  //
  //   0a  fixture present, NO pin  -> the guard must FAIL naming it a private
  //       copy. This proves section 10's walk reaches the directory.
  //   0b  fixture present, WITH the pin -> the guard must return to exit 0.
  //       This proves the injected pin is the thing that satisfies it, so the
  //       pin text is wired correctly and CASE 1 starts from a green baseline.
  //
  // It also re-measures the isolation claim in the header comment: the
  // candidate-export census must not move when the fixture appears, because the
  // authorizer derivation reads lib/auth only.
  const exportsOf = (out) => /(\d+) candidate export\(s\)/.exec(out)?.[1] ?? 'unknown';
  const cleanExports = exportsOf(clean.out);

  writeFixture(FIXTURE_SRC);
  const unpinned = runGuard();
  writeFileSync(GUARD, guardWithFixturePin(guardBefore));
  const pinned = runGuard();
  writeFileSync(GUARD, guardBefore);
  removeFixture();

  const sawFixture = unpinned.out.includes(FIXTURE_REL) && unpinned.out.includes('PRIVATE copy');
  const pinnedExports = exportsOf(pinned.out);

  console.log('CASE 0 — POPULATION CONTROL (is the synthetic fixture in the scan set at all?)');
  console.log(`    0a unpinned: guard exit            ${unpinned.code}   (expected non-zero)`);
  console.log(`    0a unpinned: named a PRIVATE copy  ${sawFixture}   (expected true)`);
  console.log(`    0b pinned:   guard exit            ${pinned.code}   (expected 0)`);
  console.log(`    isolation:   candidate exports     ${cleanExports} -> ${pinnedExports}   (expected unchanged)`);
  if (unpinned.code === 0 || !sawFixture) {
    problems.push(
      'CASE 0a: the guard did NOT flag the unpinned fixture as a private copy of the tenant ' +
        'comparison, so section 10 is not reading ' + FIXTURE_DIR + ' and every case below is ' +
        'measuring an empty population. Either SCAN_DIRS narrowed, the walk filter stopped ' +
        'admitting this path, or the operand tiering stopped rating `wsDoc.tid` as strong. Fix ' +
        'that before trusting CASES 1-3 — a green run here would otherwise mean nothing.',
    );
  }
  if (pinned.code !== 0) {
    problems.push(
      'CASE 0b: with its pin injected the fixture still does not pass, so the injected ' +
        'TID_COMPARISON_PINS entry is not satisfying the guard — its key, its `exprs`, or the ' +
        'PIN_ANCHOR insertion point has drifted from what the guard expects. CASES 1-3 cannot ' +
        'start from a green baseline until this does.',
    );
  }
  if (cleanExports !== pinnedExports) {
    problems.push(
      `CASE 0 isolation: the candidate-export census moved ${cleanExports} -> ${pinnedExports} when ` +
        'the fixture appeared. The fixture is supposed to sit OUTSIDE `AUTHZ_DIR` precisely so it ' +
        'cannot perturb the authorizer derivation; if it now does, it is no longer an inert ' +
        'subject and could mask or manufacture a finding in the sections it was chosen not to touch.',
    );
  }

  // ── CASE 1: the arm must FIRE on a genuine consolidation ──────────────────
  const live = measureConsolidation(guardBefore);
  writeFileSync(GUARD, guardBefore);
  removeFixture();

  console.log('CASE 1 — NEGATIVE CONTROL (a pinned site consolidates onto the shared comparison)');
  console.log(`    guard exit                         ${live.code}   (expected 0)`);
  console.log(`    NOTE naming the file               ${live.note}   (expected true)`);
  console.log(`    per-pin onConsolidation clause     ${live.perPinNote}   (expected true)`);
  console.log(`    false "does NOT import" failure    ${live.falseFail}   (expected false)`);
  if (live.code !== 0 || !live.note || live.falseFail) {
    problems.push(
      'CASE 1: the stale-pin third arm did NOT fire on a genuine consolidation. Either it is ' +
        'dead again (the shipped defect: `importsTenantBoundary` reading MASKED source, where the ' +
        'module specifier has been blanked), or the guard now fails for another reason — read its ' +
        'output. While it is dead, the guard blocks the exact end state it asks for.',
    );
  }
  if (live.code === 0 && live.note && !live.perPinNote) {
    problems.push(
      'CASE 1: the NOTE fired but carried no per-pin `onConsolidation` clause (#3877-f2), so a ' +
        'pin can no longer say anything specific to itself when it is consolidated. The case ' +
        'that motivated this was `item-access.ts` (pin since removed by #3840, which performed ' +
        'the consolidation for real): the generic sentence — "that is the intended end state; ' +
        'DELETE its entry" — contradicted that pin\'s own reason, which said its lenient boundary ' +
        'was deliberate, that consolidating it CHANGED access, and that its POST_DELEGATION ' +
        'position pin had to move in the same commit. Either the clause was dropped from the ' +
        'fixture pin or the NOTE stopped printing it.',
    );
  }

  // ── CASE 2: and the control must NOTICE when it is dead ───────────────────
  const dead = measureConsolidation(guardBefore.replace(ARM_LIVE, ARM_DEAD));
  writeFileSync(GUARD, guardBefore);
  removeFixture();

  console.log('CASE 2 — DISCRIMINATION (the dead arm reintroduced verbatim)');
  console.log(`    guard exit                         ${dead.code}   (expected non-zero)`);
  console.log(`    NOTE naming the file               ${dead.note}   (expected false)`);
  console.log(`    false "does NOT import" failure    ${dead.falseFail}   (expected true)`);
  if (dead.code === 0 || dead.note || !dead.falseFail) {
    problems.push(
      'CASE 2: reintroducing the dead arm did NOT change the outcome, so CASE 1 proves nothing — ' +
        'it would pass over a dead arm too. Fix this control before trusting it ' +
        '(`csa_loom_mutation_that_does_not_move_the_verdict`).',
    );
  }

  // ── CASE 3: a TYPE-ONLY import must NOT bless a removal (#3877-f1) ────────
  const typeOnly = measureConsolidation(guardBefore, TYPE_ONLY_IMPORT);
  writeFileSync(GUARD, guardBefore);
  removeFixture();

  console.log('CASE 3 — TYPE-ONLY IMPORT (the boundary removed, `import type { … }` added)');
  console.log(`    guard exit                         ${typeOnly.code}   (expected non-zero)`);
  console.log(`    NOTE naming the file               ${typeOnly.note}   (expected false)`);
  console.log(`    "does NOT import" failure          ${typeOnly.falseFail}   (expected true)`);
  if (typeOnly.code === 0 || typeOnly.note || !typeOnly.falseFail) {
    problems.push(
      'CASE 3: a TYPE-ONLY import blessed the removal of a pinned comparison. `import type { … } ' +
        "from './tenant-boundary'` is erased at compile time — no comparison arrives in the " +
        'module — so treating it as a consolidation lets the boundary be DELETED at exit 0 with ' +
        'an approving NOTE, which is the arm blessing the exact change it exists to catch. Note ' +
        'CASE 1 and CASE 3 differ by ONE token (`type`), so if both pass the same way the ' +
        'specifier test is not reading the import kind at all.',
    );
  }

  // ── CASE 4: DISTANCE is not the property — control-flow POSITION is (#3900) ─
  // A matched pair, both applied to the real resolver. They differ in exactly
  // the dimension the old window could not see: 4a's refusal is far away and
  // UNCONDITIONAL, 4b's is close and NESTED under a further condition. Under the
  // 80-character window 4a failed (the false positive that blocked #3900) and 4b
  // passed (a partial boundary blessed). If either arm ever flips, the section
  // has been re-keyed to distance again.
  const distant = measureResolver(
    'if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) {' + RESOLVER_EOL +
    '    // A refusal, not an absence. Everything between this comment and the' + RESOLVER_EOL +
    '    // return exists to explain and record WHY, which is what a reviewer is' + RESOLVER_EOL +
    '    // supposed to do here, and it is exactly what a proximity window' + RESOLVER_EOL +
    '    // punishes. The refusal below is unconditional: it is a statement of' + RESOLVER_EOL +
    '    // this block, not of the diagnostic inside it.' + RESOLVER_EOL +
    '    const cause = Boolean(callerTid) && Boolean(wsDoc.tid);' + RESOLVER_EOL +
    '    if (cause) {' + RESOLVER_EOL +
    '      console.warn("[workspace-access] REFUSED at the tid boundary");' + RESOLVER_EOL +
    '    }' + RESOLVER_EOL +
    '    return null;' + RESOLVER_EOL +
    '  }',
  );
  writeFileSync(RESOLVER, resolverBefore);

  const nested = measureResolver(
    'if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) {' + RESOLVER_EOL +
    '    if (opts.tenantAdmin) return null;' + RESOLVER_EOL +
    '  }',
  );
  writeFileSync(RESOLVER, resolverBefore);

  console.log('CASE 4 — DISTANCE vs POSITION (the #3900 false positive, and its mirror)');
  console.log(`    4a refusal +530 chars / +10 lines, UNCONDITIONAL — comparison failure   ${distant.cmpFailure}   (expected false)`);
  console.log(`    4b refusal +53 chars but NESTED                  — comparison failure   ${nested.cmpFailure}   (expected true)`);
  if (distant.cmpFailure) {
    problems.push(
      'CASE 4a: the sections-1..4 test FAILED a refusal that is unconditional but far from its ' +
        'comparison. That is the #3900 false positive restored — the guard going red because the ' +
        'code got more explanatory, and (R7) asserting "DISCARDED" about a verdict it never ' +
        'measured. Key the test to control-flow position, never to a character budget: a budget ' +
        'is also unstable across checkouts, since core.autocrlf makes the same source measure ' +
        'longer on Windows than in CI.',
    );
  }
  if (!nested.cmpFailure) {
    problems.push(
      'CASE 4b: the sections-1..4 test PASSED a boundary whose only refusal is nested under a ' +
        'further condition — every caller for whom that inner condition is false crosses the ' +
        'tenant boundary. Without this arm CASE 4a proves nothing: a test that simply stopped ' +
        'asking for a refusal would satisfy 4a too ' +
        '(`csa_loom_mutation_that_does_not_move_the_verdict`).',
    );
  }
} finally {
  writeFileSync(GUARD, guardBefore);
  writeFileSync(RESOLVER, resolverBefore);
  removeFixture();
}

// Restoration is VERIFIED, not assumed — this script edits tracked files.
for (const [p, want] of [[GUARD, guardBefore], [RESOLVER, resolverBefore]]) {
  if (read(p) !== want) problems.push(`RESTORE FAILED for ${p} — the working tree is DIRTY. Restore it from git before continuing.`);
}
// The fixture is UNTRACKED, so `git checkout --` would not remove it and a
// leftover copy would fail the guard on the next run with a private-copy error
// nobody would trace back here. Verified as an absence, for the same reason the
// tracked files are verified as content.
if (existsSync(FIXTURE_DIR)) {
  problems.push(
    `RESTORE FAILED — ${FIXTURE_DIR} still exists. It is UNTRACKED, so git will not clean it up: ` +
      `remove it with \`rm -rf ${FIXTURE_DIR}\` before running the guard again.`,
  );
}

console.log(`clean tree (no mutation)               exit ${clean?.code}   (expected 0)`);
if (clean && clean.code !== 0) {
  problems.push('the guard does not pass on the unmutated tree, so neither case above means anything.');
}

if (problems.length > 0) {
  console.error('\n[tid-boundary-chokepoint selftest] FAIL\n');
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}
console.log('\n[tid-boundary-chokepoint selftest] OK — the stale-pin third arm fires, and this control notices when it does not.');

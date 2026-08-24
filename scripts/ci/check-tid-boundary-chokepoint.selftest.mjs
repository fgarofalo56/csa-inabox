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
 *   CASE 1  NEGATIVE CONTROL — consolidate a PINNED site onto
 *           `sameTenantConfirmed` (and re-pin the POST_DELEGATION region that
 *           consolidation necessarily moves, exactly as the real commit would).
 *           EXPECT exit 0, a NOTE naming the file, and NO "does NOT import"
 *           failure. It ALSO asserts the per-pin `onConsolidation` clause is in
 *           that NOTE (#3877-f2): the note used to be one template for every
 *           pin, and for `item-access.ts` the template said "that is the
 *           intended end state, delete the entry" while that pin's own reason
 *           says its lenient boundary is deliberate, that tightening it is a
 *           review, and that its POST_DELEGATION position pin makes deleting it
 *           a red build. A NOTE that contradicts the pin it is about is worse
 *           than no NOTE.
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
 * It edits two tracked files IN PLACE and restores them in a `finally`, then
 * verifies byte-for-byte that the tree is back. Run it from the repo root:
 *
 *     node scripts/ci/check-tid-boundary-chokepoint.selftest.mjs
 *
 * WHY IN PLACE, AND WHAT THAT COSTS. Section 10 scans `apps/fiab-console/{app,lib}`
 * by path relative to the repo root, and the pins are keyed on those paths — so
 * the subject cannot be a copy without copying the console. The mutation window
 * is therefore real, and it is bounded three ways: a `finally`, SIGINT/SIGTERM/
 * uncaughtException handlers that restore before exiting, and a byte-for-byte
 * verification afterwards that FAILS LOUDLY if the tree is not back. Nothing
 * survives SIGKILL; if that happens, `git checkout --` the two files named at the
 * top of this file.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const GUARD = 'scripts/ci/check-tid-boundary-chokepoint.mjs';
const SITE = 'apps/fiab-console/lib/auth/item-access.ts';

/** The consolidation, as the real follow-up commit would write it. */
const IMPORT_ANCHOR =
  "import { itemsContainer, itemPermissionsContainer } from '@/lib/azure/cosmos-client';";
const VALUE_IMPORT = "import { sameTenantConfirmed } from './tenant-boundary';";
/** CASE 3 — the same specifier brought in as a TYPE, which is erased at build. */
const TYPE_ONLY_IMPORT = "import type { TenantMatch } from './tenant-boundary';";
const OLD_CMP = 'if (wsDoc?.tid && wsDoc.tid !== tid) return null;';
const NEW_CMP = 'if (!sameTenantConfirmed(tid, wsDoc?.tid)) return null;';

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
const RESOLVER_CMP = 'if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null;';
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

/** Apply the consolidation, run the guard, restore. Returns the observation.
 *  `importLine` is what the consolidating commit adds — a VALUE import for the
 *  real fix, a TYPE-ONLY one for CASE 3. */
function measureConsolidation(guardSrc, siteSrc, importLine = VALUE_IMPORT) {
  writeFileSync(
    SITE,
    siteSrc.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${importLine}`).replace(OLD_CMP, NEW_CMP),
  );
  // The POST_DELEGATION_PINS `region` for this site quotes the comparison, so a
  // faithful consolidation commit re-pins it too. Not doing so would make CASE 1
  // fail for an unrelated (and correct) reason.
  writeFileSync(GUARD, guardSrc.split(OLD_CMP).join(NEW_CMP));
  const { code, out } = runGuard();
  // ASCII-only needles on purpose — see runGuard().
  return {
    code,
    note:
      out.includes('no longer carries') &&
      out.includes('item-access.ts') &&
      out.includes('imports the shared comparison'),
    perPinNote: out.includes(ONCONSOLIDATION_MARKER),
    falseFail: out.includes('does NOT import'),
  };
}

const guardBefore = read(GUARD);
const siteBefore = read(SITE);
const resolverBefore = read(RESOLVER);
const RESOLVER_EOL = resolverBefore.includes('\r\n') ? '\r\n' : '\n';

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
    writeFileSync(SITE, siteBefore);
    writeFileSync(RESOLVER, resolverBefore);
  } catch (e) {
    console.error(`[selftest] RESTORE THREW — run: git checkout -- ${GUARD} ${SITE} ${RESOLVER}`, e);
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

for (const [label, hay, needle] of [
  ['site import anchor', siteBefore, IMPORT_ANCHOR],
  ['site comparison', siteBefore, OLD_CMP],
  ['guard region pin', guardBefore, OLD_CMP],
  ['guard arm call site', guardBefore, ARM_LIVE],
  ['resolver boundary statement', resolverBefore, RESOLVER_CMP],
]) {
  if (!hay.includes(needle)) {
    console.error(`[selftest] SETUP FAILED — ${label} not found: ${JSON.stringify(needle.slice(0, 70))}`);
    console.error('[selftest] This self-test is pinned to those exact strings; re-point it as part of whatever moved them.');
    process.exit(2);
  }
}

let clean;
try {
  clean = runGuard();

  // ── CASE 1: the arm must FIRE on a genuine consolidation ──────────────────
  const live = measureConsolidation(guardBefore, siteBefore);
  writeFileSync(GUARD, guardBefore);
  writeFileSync(SITE, siteBefore);

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
      'CASE 1: the NOTE fired but carried no per-pin `onConsolidation` clause (#3877-f2). For ' +
        '`item-access.ts` the generic sentence — "that is the intended end state; DELETE its ' +
        'entry" — contradicts that pin\'s own reason, which says the lenient boundary is ' +
        'deliberate, that consolidating it CHANGES access, and that its POST_DELEGATION position ' +
        'pin must move in the same commit. Either the clause was dropped from the pin or the NOTE ' +
        'stopped printing it.',
    );
  }

  // ── CASE 2: and the control must NOTICE when it is dead ───────────────────
  const dead = measureConsolidation(guardBefore.replace(ARM_LIVE, ARM_DEAD), siteBefore);
  writeFileSync(GUARD, guardBefore);
  writeFileSync(SITE, siteBefore);

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
  const typeOnly = measureConsolidation(guardBefore, siteBefore, TYPE_ONLY_IMPORT);
  writeFileSync(GUARD, guardBefore);
  writeFileSync(SITE, siteBefore);

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
  writeFileSync(SITE, siteBefore);
  writeFileSync(RESOLVER, resolverBefore);
}

// Restoration is VERIFIED, not assumed — this script edits tracked files.
for (const [p, want] of [[GUARD, guardBefore], [SITE, siteBefore], [RESOLVER, resolverBefore]]) {
  if (read(p) !== want) problems.push(`RESTORE FAILED for ${p} — the working tree is DIRTY. Restore it from git before continuing.`);
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

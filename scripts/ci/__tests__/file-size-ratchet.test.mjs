/**
 * check-file-size `--update-baseline` RATCHET-DIRECTION self-test.
 *
 * The guard's header states the invariant in its own words, and the FAIL path
 * repeats it as the remediation — "reduce below the ceiling, or bump via
 * --update-baseline". Until 2026-09-10 `updateBaseline()` did not hold that
 * invariant, and there was no test over this guard at all (`scripts/ci/__tests__`
 * held 136 suites at this PR's merge base and none of them covered
 * `check-file-size`; this file is the 137th).
 *
 * MEASURED on the tree at that date — 66 ALLOWLIST entries, 58 files above the
 * 1500 warn line — pasting the emitted JSON back into the allowlist would have:
 *
 *   - LOOSENED 12 of the 58, by +38 to +94 LOC each, because every ceiling was
 *     rewritten to `ceilTo100(loc)` without reference to the ceiling already
 *     recorded. Those 12 are exactly the entries pinned at their EXACT LOC on
 *     purpose (foundry-hub-editor 2620, unified-sql-database-editor 2407,
 *     uc-dialogs 3106, purview-client 2922, ...), each saying so in its own
 *     `reason` so that the next line of growth has to be argued.
 *   - DROPPED all 8 entries whose file now sits at or below the warn line,
 *     because only files above it were emitted. A dropped entry is unratcheted
 *     up to 1500: `apim-editors.tsx` is frozen at 100 after a 3581 -> 25 LOC
 *     decomposition, and the paste would have released it to 1500.
 *
 * AND, found by the 2026-09-11 re-review of the FIRST fix and closed here: the
 * fix stopped ceilings being handed BACK headroom, but the third `nextCeiling`
 * branch — a file that genuinely outgrew its pin RISES to its exact LOC —
 * emitted the raised number carrying the OLD entry's justification verbatim, so
 * `--update-baseline` manufactured an argument for a ceiling nobody had argued.
 * A rise is now stamped `TODO(bump):` and the guard FAILS on the stamp.
 *
 * WHAT THIS SUITE ASSERTS, and why each arm is not redundant:
 *
 *   1. `nextCeiling` on synthetic inputs — the rule itself, independent of any
 *      population: new file rounds, an entry that fits keeps the TIGHTER of its
 *      ceiling and the rounded count, an entry that outgrew its ceiling rises
 *      to the EXACT count and no further.
 *   2. THE REAL POPULATION, through the real CLI as a PROCESS at its production
 *      defaults, with an oracle that is `nextCeiling` itself rather than a
 *      one-sided `>` comparison. Arm 1 can pass while `main()` ignores
 *      `nextCeiling` entirely — an exported helper is presence, not
 *      reachability. This arm reads the bytes the guard actually prints.
 *
 *      The one-sided oracle this replaces was WORSE THAN ABSENT: on a tree where
 *      an allowlisted file had grown one line past its pin, the CORRECT code
 *      went red ("these ceilings got looser" — a cause it had not established;
 *      the tool had not loosened anything, the FILE had grown) while code that
 *      clamped the rise away, breaking the documented bump path outright, went
 *      green. It asserted the wrong direction on the only branch it could see.
 *   3. NO ENTRY IS DROPPED — the second half of the 2026-09-10 defect, invisible
 *      to any ceiling comparison because a dropped key has no ceiling to
 *      compare.
 *   4. THE COUNTERFACTUAL. Arms 2 and 3 are green on a tree where the old rule
 *      would ALSO have been green, so on their own they cannot distinguish
 *      "the fix works" from "this population never exercised the bug". This arm
 *      runs the PRE-FIX rule over the same tree and requires it to loosen at
 *      least one ceiling and drop at least one entry. If the repo ever
 *      decomposes its way out of that population, this arm goes RED — NOT-RUN
 *      reported as a failure, never as a pass.
 *   5. A FIXTURE POPULATION through the pure planner, for the RISE branch. The
 *      real tree cannot exercise it: a file over its ceiling makes
 *      check-file-size red, so no green tree contains one, so arms 2-4 are
 *      structurally blind to a third of the rule. `planBaseline(counts,
 *      allowlist)` is pure in both arguments, which is the seam.
 *   6. THE STAMP HAS TEETH, through the guard AS A PROCESS. A marker the guard
 *      does not fail on is decoration; a `unarguedBumps()` export that `main()`
 *      never calls is presence again. This arm runs a copy of the real guard
 *      (outside the repo, REPO_ROOT pinned back to it) with one marked entry
 *      injected and requires exit 1 — against a CONTROL run of the same copy
 *      unmodified, which must exit 0, so the red is attributable to the marker
 *      and not to the copy.
 *   7. `reason` and `bundleExempt` survive the regeneration, since the emitted
 *      JSON is meant to be pasted over the allowlist verbatim and a lost
 *      `bundleExempt` re-arms the 6000-LOC backstop against a generated bundle.
 *      Including: a marker already present is NOT stripped on a later run, which
 *      is what stops a bump being laundered green in two passes.
 *
 * Mutation harness (run it, do not take this comment's word):
 *   node scripts/ci/__tests__/file-size-ratchet.mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWLIST,
  BUMP_MARKER,
  BUMP_SEPARATOR,
  WARN_THRESHOLD,
  ceilTo100,
  loc,
  nextCeiling,
  planBaseline,
  reasonWithoutBumpMarker,
  unarguedBumps,
} from '../check-file-size.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', 'check-file-size.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * Run the guard as a process, exactly as an author following the FAIL text
 * would. Memoized: three arms need the same bytes and the scan costs ~4 s each.
 */
let EMITTED;
function emittedBaseline() {
  if (EMITTED) return EMITTED;
  const stdout = execFileSync(process.execPath, [GUARD, '--update-baseline'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const brace = stdout.indexOf('{');
  assert.ok(brace >= 0, '--update-baseline printed no JSON object');
  EMITTED = JSON.parse(stdout.slice(brace));
  return EMITTED;
}

/** LOC per allowlisted file, counted with the guard's own exported rule. */
function currentLoc() {
  const out = new Map();
  for (const file of Object.keys(ALLOWLIST)) {
    const abs = path.join(REPO_ROOT, file);
    if (existsSync(abs)) out.set(file, loc(abs));
  }
  return out;
}

test('nextCeiling: a file the allowlist has never seen gets ceilTo100 slack, once', () => {
  assert.equal(nextCeiling(undefined, 1501), 1600);
  assert.equal(nextCeiling(undefined, 1600), 1600);
  assert.equal(nextCeiling(undefined, 1601), 1700);
});

test('nextCeiling: an existing ceiling is never raised while the file fits under it', () => {
  // The exact-LOC pins. ceilTo100 would have handed each of these ~100 LOC back.
  assert.equal(nextCeiling(2620, 2620), 2620);
  assert.equal(nextCeiling(2407, 2407), 2407);
  assert.equal(nextCeiling(3106, 3106), 3106);
  // A rounded ceiling with real headroom stays where it is, too.
  assert.equal(nextCeiling(2900, 2843), 2900);
  assert.equal(nextCeiling(100, 25), 100);
});

test('nextCeiling: a decomposed file TIGHTENS to the rounded count', () => {
  assert.equal(nextCeiling(1900, 1781), 1800);
  assert.equal(nextCeiling(2905, 2856), 2900);
  assert.equal(nextCeiling(3550, 1200), 1200);
});

test('nextCeiling: a file that outgrew its ceiling rises to the EXACT LOC, no further', () => {
  assert.equal(nextCeiling(2600, 2620), 2620);
  assert.equal(nextCeiling(2400, 2407), 2407);
  assert.equal(nextCeiling(1500, 1501), 1501);
});

test('the CLI emits exactly nextCeiling(recorded, LOC) for every entry it keeps', () => {
  const emitted = emittedBaseline();
  const locs = currentLoc();
  const wrong = [];
  for (const [file, entry] of Object.entries(emitted)) {
    const prev = ALLOWLIST[file];
    if (!prev) continue; // a genuinely new large file — ceilTo100 slack is by design
    const n = locs.get(file);
    assert.ok(
      n !== undefined,
      `${file}: the CLI emitted a ceiling for it, but this suite could not read it off disk to ` +
        'check that ceiling. That is an unmeasured entry, not a passing one.',
    );
    const want = nextCeiling(prev.max, n);
    if (entry.max !== want) {
      // Say only what is established: the emitted number and the rule's number
      // disagree. Which side is "wrong" is the reader's call, and asserting a
      // cause here is the same R7 defect this guard exists to fix.
      wrong.push(`${file}: recorded ${prev.max}, ${n} LOC on disk -> emitted ${entry.max}, rule says ${want}`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    'the CLI disagrees with nextCeiling() on these entries — the rule is exported but the CLI is ' +
      'not applying it',
  );
});

test('the CLI drops no existing allowlist entry whose file is still in the tree', () => {
  const emitted = emittedBaseline();
  const locs = currentLoc();
  const dropped = [];
  for (const file of Object.keys(ALLOWLIST)) {
    if (!locs.has(file)) continue; // genuinely gone from disk; the guard says so on its own line
    if (!emitted[file]) dropped.push(`${file} (max ${ALLOWLIST[file].max}, now ${locs.get(file)} LOC)`);
  }
  assert.deepEqual(dropped, [], 'a dropped entry is unratcheted all the way to the warn line');
});

test('COUNTERFACTUAL: the pre-fix rule DOES loosen and DOES drop on this same tree', () => {
  const locs = currentLoc();
  // Verbatim pre-fix behaviour: emit only files above the warn line, and set
  // every ceiling to ceilTo100(loc) with no reference to the recorded one.
  let wouldLoosen = 0;
  let wouldDrop = 0;
  for (const [file, n] of locs) {
    if (n <= WARN_THRESHOLD) {
      wouldDrop++;
      continue;
    }
    if (ceilTo100(n) > ALLOWLIST[file].max) wouldLoosen++;
  }
  assert.ok(
    wouldLoosen > 0,
    'no allowlisted file is pinned below ceilTo100(its LOC) any more, so the ' +
      '"emits exactly nextCeiling" arm above cannot distinguish the fix from the bug. ' +
      'This suite is NOT-RUN, not passing — re-ground it before deleting this arm.',
  );
  assert.ok(
    wouldDrop > 0,
    'no allowlisted file sits at or below the warn line any more, so the ' +
      '"drops no entry" arm above cannot distinguish the fix from the bug. ' +
      'This suite is NOT-RUN, not passing — re-ground it before deleting this arm.',
  );
});

// ── the RISE branch, over a fixture population ─────────────────────────────
// A file over its ceiling makes check-file-size RED, so the real tree never
// carries one while it is green and the CLI arms above are structurally blind
// to this third of the rule. `planBaseline` is pure in (counts, allowlist).

/** One entry of each shape, including the one that outgrew its exact-LOC pin. */
const FIXTURE_ALLOWLIST = {
  'apps/fiab-console/lib/editors/pinned.tsx': { max: 2620, reason: 'ZERO HEADROOM IS THE POINT — pinned at 2620, its exact LOC.' },
  'apps/fiab-console/lib/editors/fits.tsx': { max: 2900, reason: 'rounded ceiling with real headroom' },
  'apps/fiab-console/lib/editors/decomposed.tsx': { max: 3550, reason: 'decomposition target' },
  'apps/fiab-console/lib/editors/barrel.tsx': { max: 100, reason: 'decomposed to a barrel', bundleExempt: true },
};
const FIXTURE_COUNTS = {
  'apps/fiab-console/lib/editors/pinned.tsx': 2621, // ONE line over the pin
  'apps/fiab-console/lib/editors/fits.tsx': 2843,
  'apps/fiab-console/lib/editors/decomposed.tsx': 1200,
  'apps/fiab-console/lib/editors/barrel.tsx': 25,
  'apps/fiab-console/lib/editors/brand-new.tsx': 1731, // never allowlisted
};

test('FIXTURE: a file one line over its pin rises to the EXACT LOC — not ceilTo100, not clamped', () => {
  const { out } = planBaseline(FIXTURE_COUNTS, FIXTURE_ALLOWLIST);
  // 2621, not 2700 (that is the 2026-09-10 loosening) and not 2620 (that would
  // make the FAIL text's own remediation dead: paste it and CI is still red).
  assert.equal(out['apps/fiab-console/lib/editors/pinned.tsx'].max, 2621);
  assert.equal(out['apps/fiab-console/lib/editors/fits.tsx'].max, 2900);
  assert.equal(out['apps/fiab-console/lib/editors/decomposed.tsx'].max, 1200);
  assert.equal(out['apps/fiab-console/lib/editors/barrel.tsx'].max, 100);
  assert.equal(out['apps/fiab-console/lib/editors/barrel.tsx'].bundleExempt, true);
  assert.equal(out['apps/fiab-console/lib/editors/brand-new.tsx'].max, 1800);
});

test('FIXTURE: a raised ceiling is STAMPED, and the old justification is demoted, not reused', () => {
  const { out } = planBaseline(FIXTURE_COUNTS, FIXTURE_ALLOWLIST);
  const risen = out['apps/fiab-console/lib/editors/pinned.tsx'].reason;
  assert.ok(
    risen.startsWith(BUMP_MARKER),
    `a raised ceiling must be stamped ${BUMP_MARKER} or the tool has written the argument for the ` +
      `growth itself. Got: ${risen.slice(0, 120)}`,
  );
  assert.match(risen, /2620->2621/);
  // The old reason is still there — but AFTER the marker, labelled as previous,
  // so a generated entry never reads as an argument for a number it predates.
  assert.ok(risen.includes(BUMP_SEPARATOR));
  assert.equal(reasonWithoutBumpMarker(risen), FIXTURE_ALLOWLIST['apps/fiab-console/lib/editors/pinned.tsx'].reason);
  // Nothing that did NOT rise is stamped.
  for (const file of ['fits', 'decomposed', 'barrel'].map((s) => `apps/fiab-console/lib/editors/${s}.tsx`)) {
    assert.equal(out[file].reason, FIXTURE_ALLOWLIST[file].reason, `${file}: reason changed without a rise`);
  }
  // And the stamp is what FAIL rule 4 keys on.
  assert.deepEqual(unarguedBumps(out), ['apps/fiab-console/lib/editors/pinned.tsx']);
  assert.deepEqual(unarguedBumps(FIXTURE_ALLOWLIST), []);
});

test('FIXTURE: a second --update-baseline does NOT launder the stamp away', () => {
  // grow, paste, re-run, paste again: the two-pass evasion. The second run sees
  // an entry that now FITS (2621 <= 2621), so nothing rises — and a non-rising
  // entry must carry its reason byte-for-byte, marker included.
  const { out: first } = planBaseline(FIXTURE_COUNTS, FIXTURE_ALLOWLIST);
  const { out: second } = planBaseline(FIXTURE_COUNTS, first);
  const file = 'apps/fiab-console/lib/editors/pinned.tsx';
  assert.equal(second[file].max, 2621);
  assert.equal(second[file].reason, first[file].reason);
  assert.deepEqual(unarguedBumps(second), [file], 'the marker survived one paste and must survive the next');
});

test('CONTROL: the real ALLOWLIST at this head carries no unargued bump', () => {
  assert.deepEqual(
    unarguedBumps(),
    [],
    'a marker left in the committed allowlist means someone pasted a raised ceiling and never ' +
      'wrote the justification',
  );
});

// ── the stamp has TEETH — the guard as a process ───────────────────────────

const REPO_ROOT_DECL = /const REPO_ROOT = path\.resolve\(__dirname, '\.\.', '\.\.'\);/;

/**
 * Run a copy of the real guard OUTSIDE the repo, with its REPO_ROOT pinned back
 * to this checkout so the scan is identical to the real one's.
 *
 * The copy deliberately does NOT live beside the original. It did in the first
 * draft, and `node --test scripts/ci/__tests__/*.test.mjs` — which runs the
 * suites in PARALLEL — went red in check-role-guid-consistency.test.mjs: that
 * suite lists `scripts/ci` and then reads what it listed, so a file that appears
 * and disappears mid-run is an ENOENT in someone else's assertion. A test that
 * writes into a directory other tests enumerate is a flake generator.
 *
 * `transform` may rewrite the source; the CONTROL run applies only the REPO_ROOT
 * pin, which is what makes a red attributable to the injection rather than to
 * the copying or the relocation.
 */
function runGuardCopy(tag, transform) {
  const raw = readFileSync(GUARD, 'utf8');
  const rootHits = raw.match(new RegExp(REPO_ROOT_DECL.source, 'g')) ?? [];
  assert.equal(rootHits.length, 1, 'the REPO_ROOT declaration must match EXACTLY once, or the copy scans the wrong tree');
  const src = raw.replace(REPO_ROOT_DECL, `const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};`);
  const copy = path.join(mkdtempSync(path.join(tmpdir(), `file-size-${tag}-`)), 'check-file-size.mjs');
  writeFileSync(copy, transform(src), 'utf8');
  try {
    const r = execFileSync(process.execPath, [copy], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: r, stderr: '' };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  } finally {
    rmSync(path.dirname(copy), { force: true, recursive: true });
  }
}

// `\r?\n`, not `\n`: this repo's working tree is CRLF while the committed blob
// is LF, and a `\n`-only anchor would match ZERO times on a Windows checkout —
// the arm would inject nothing and "pass" on a guard it never modified.
const ALLOWLIST_CLOSE = /\};(\r?\n)\/\/ __ALLOWLIST_END__/;
const FIXTURE_FILE = 'apps/fiab-console/lib/editors/__fixture-unargued__.tsx';

test('the guard FAILS on an allowlist entry still carrying the stamp (process, not helper)', () => {
  const src = readFileSync(GUARD, 'utf8');
  const hits = src.match(new RegExp(ALLOWLIST_CLOSE.source, 'g')) ?? [];
  assert.equal(hits.length, 1, 'the allowlist-close anchor must match EXACTLY once, or this arm is injecting blind');

  const control = runGuardCopy('control', (s) => s);
  assert.equal(
    control.code,
    0,
    `CONTROL: an unmodified sibling copy must be GREEN, or a red below proves nothing about the ` +
      `marker. stderr: ${control.stderr.slice(0, 400)}`,
  );

  const marked = runGuardCopy('marked', (s) =>
    s.replace(ALLOWLIST_CLOSE, (m, eol) => {
      const entry =
        `  ${JSON.stringify(FIXTURE_FILE)}: { max: 9999, reason: ` +
        `${JSON.stringify(`${BUMP_MARKER} injected by file-size-ratchet.test.mjs${BUMP_SEPARATOR}fixture`)} },`;
      return `${entry}${eol}${m}`;
    }),
  );
  assert.equal(marked.code, 1, `injecting one ${BUMP_MARKER} entry must FAIL the guard; got exit ${marked.code}`);
  assert.match(marked.stderr, /UNARGUED BUMP/);
  assert.match(marked.stderr, /__fixture-unargued__\.tsx/);
  // and the census line reports it rather than staying silent
  assert.match(marked.stdout, /1 carrying an unargued TODO\(bump\): marker/);
});

// Scope note: the real tree is GREEN, so nothing in it rises and every emitted
// reason here is a carried one. The rise case — where the reason is deliberately
// NOT carried unchanged but stamped — is the fixture arm above; the two do not
// contradict, they cover the two branches.
test('regeneration preserves reason and bundleExempt verbatim (the JSON is pasted back)', () => {
  const emitted = emittedBaseline();
  for (const [file, prev] of Object.entries(ALLOWLIST)) {
    const now = emitted[file];
    if (!now) continue; // covered by the drop arm
    assert.equal(now.reason, prev.reason, `${file}: reason changed on regeneration`);
    assert.equal(
      Boolean(now.bundleExempt),
      Boolean(prev.bundleExempt),
      `${file}: bundleExempt changed on regeneration — losing it re-arms the ${6000}-LOC backstop`,
    );
  }
});

/**
 * check-file-size `--update-baseline` RATCHET-DIRECTION self-test.
 *
 * The guard's header states the invariant in its own words: "The ratchet only
 * tightens: decompose a file and its ceiling drops on the next
 * --update-baseline." The FAIL path repeats it as the remediation — "reduce
 * below the ceiling, or justify + bump via --update-baseline". Until
 * 2026-09-10 `updateBaseline()` did not hold that invariant, and there was no
 * test over this guard at all (137 suites in this directory, none of them
 * `check-file-size`).
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
 * WHAT THIS SUITE ASSERTS, and why each arm is not redundant:
 *
 *   1. `nextCeiling` on synthetic inputs — the rule itself, independent of any
 *      population: new file rounds, an entry that fits keeps the TIGHTER of its
 *      ceiling and the rounded count, an entry that outgrew its ceiling rises
 *      to the EXACT count and no further.
 *   2. THE REAL POPULATION, through the real CLI as a PROCESS at its production
 *      defaults. Arm 1 can pass while `main()` ignores `nextCeiling` entirely —
 *      an exported helper is presence, not reachability. This arm reads the
 *      bytes the guard actually prints.
 *   3. NO ENTRY IS DROPPED — the second half of the defect, invisible to any
 *      ceiling comparison because a dropped key has no ceiling to compare.
 *   4. THE COUNTERFACTUAL. Arms 2 and 3 are green on a tree where the old rule
 *      would ALSO have been green, so on their own they cannot distinguish
 *      "the fix works" from "this population never exercised the bug". This arm
 *      runs the PRE-FIX rule over the same tree and requires it to loosen at
 *      least one ceiling and drop at least one entry. If the repo ever
 *      decomposes its way out of that population, this arm goes RED — NOT-RUN
 *      reported as a failure, never as a pass.
 *   5. `reason` and `bundleExempt` survive the regeneration, since the emitted
 *      JSON is meant to be pasted over the allowlist verbatim and a lost
 *      `bundleExempt` re-arms the 6000-LOC backstop against a generated bundle.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWLIST, WARN_THRESHOLD, ceilTo100, loc, nextCeiling } from '../check-file-size.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', 'check-file-size.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Run the guard as a process, exactly as an author following the FAIL text would. */
function emittedBaseline() {
  const stdout = execFileSync(process.execPath, [GUARD, '--update-baseline'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const brace = stdout.indexOf('{');
  assert.ok(brace >= 0, '--update-baseline printed no JSON object');
  return JSON.parse(stdout.slice(brace));
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

test('the CLI never emits a ceiling looser than the one already recorded', () => {
  const emitted = emittedBaseline();
  const loosened = [];
  for (const [file, entry] of Object.entries(emitted)) {
    const prev = ALLOWLIST[file];
    if (!prev) continue; // a genuinely new large file — ceilTo100 slack is by design
    if (entry.max > prev.max) loosened.push(`${file}: ${prev.max} -> ${entry.max}`);
  }
  assert.deepEqual(loosened, [], 'the ratchet only tightens — these ceilings got looser');
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
      '"never loosen" arm above cannot distinguish the fix from the bug. ' +
      'This suite is NOT-RUN, not passing — re-ground it before deleting this arm.',
  );
  assert.ok(
    wouldDrop > 0,
    'no allowlisted file sits at or below the warn line any more, so the ' +
      '"drops no entry" arm above cannot distinguish the fix from the bug. ' +
      'This suite is NOT-RUN, not passing — re-ground it before deleting this arm.',
  );
});

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

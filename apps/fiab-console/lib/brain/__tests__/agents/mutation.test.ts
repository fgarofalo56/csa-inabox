/**
 * MUTATION RECORD — the measured proof that this suite can go red.
 *
 * A test suite that passes is evidence of nothing until you have watched it
 * FAIL for the right reason. Every guard in the agent layer was mutated at its
 * subject and the suite re-run; the exit codes below are measured, not asserted
 * — they are recorded here so a reviewer can reproduce them rather than take
 * them on trust.
 *
 * Baseline for every row: `pnpm vitest run lib/brain` → **RC 0, 16 files, 231
 * tests** (re-measured 2026-08-23). Every mutation was reverted and the baseline
 * re-measured at RC 0 before the next was applied.
 *
 * ── THE RECORDED BASELINE HAD DRIFTED, AND SO HAVE THE COUNTS ──────────────
 * This header previously read *"14 files, 212 tests"*. That number was measured
 * before `cost.test.ts` (5 tests) and this file (9 tests) existed, so it stopped
 * reproducing the moment they landed — and a reviewer who followed the standing
 * invitation to reproduce measured 16/226 instead, which is exactly the kind of
 * small false claim this suite exists to catch. It is corrected here rather than
 * quietly dropped.
 *
 * The consequence is that the `tests failed` column below is ALSO historical: it
 * was measured against the 14/212 baseline and is NOT re-measured per row here.
 * Where tests have since been added over the same subject, the count moves. M1
 * was re-measured on 2026-08-23 at **RC 1, 5 tests across 2 files** — the record
 * says 4; the fifth is `mutation.test.ts`'s own needle check firing correctly.
 * Treat the RC column as the load-bearing one and the count column as indicative.
 *
 * ┌────┬──────────────────────────────────────────────┬────────┬──────────────┐
 * │ #  │ mutation                                     │ RC     │ tests failed │
 * ├────┼──────────────────────────────────────────────┼────────┼──────────────┤
 * │ M1 │ pipeline.ts — remove the Critic gate:        │ 1      │ 4            │
 * │    │ `.filter(f => !refutedIds.has(f.id))`        │ (was 0)│              │
 * │    │ → `.filter(() => true)`                      │        │              │
 * │ M2 │ critic.ts — give the MODEL refute authority: │ 1      │ 3 (2 files)  │
 * │    │ challenge `wouldRefute` → `'refuted'`        │        │              │
 * │ M3 │ critic.ts — disable the blind-population     │ 1      │ 9            │
 * │    │ check: `if (!blind) return null` → always    │        │              │
 * │ M4 │ remediator.ts — make `isPureData` vacuously  │ 1      │ 1 (CONTROL)  │
 * │    │ true                                         │        │              │
 * │ M5 │ correlator.ts — widen the component-index    │ 1      │ 1            │
 * │    │ range check so an invented index applies     │        │              │
 * │ M6 │ explainer.ts — make `unverifiedNumbers`      │ 1      │ 4            │
 * │    │ always return `[]`                           │        │              │
 * │ M7 │ critic.ts — plant a REAL ARM DELETE          │ 1      │ 1            │
 * │    │ (`fetch(management.azure.com…, DELETE)`)     │        │              │
 * └────┴──────────────────────────────────────────────┴────────┴──────────────┘
 *
 * ── WHAT THE ROWS ACTUALLY TELL YOU ────────────────────────────────────────
 *
 * **M4 is the one to read twice.** It fails exactly ONE test, and that test is
 * the CONTROL — the assertion that `isPureData` rejects an object containing a
 * function. Every other purity assertion in `remediator.test.ts` still passed
 * against a check that returned `true` for everything. Without the control, a
 * vacuous purity check would have shipped green. That is the shape this repo
 * keeps finding, and it is why a guard with no control is not a guard.
 *
 * **M2 was widened after it was first measured.** In its first form the model's
 * refute authority was caught by ONE assertion, in a pure helper. A single-point
 * guard on the layer's central property is thin, so two more were added — the
 * same property through `criticize()` and again through `runBrainAgents()` —
 * and M2 was re-measured at 3 failures across 2 files. The first measurement is
 * recorded here rather than quietly replaced, because "the guard was thin" is
 * the finding.
 *
 * **M7 proves the source scan reads real files.** A planted `fetch(…, DELETE)`
 * against `management.azure.com` inside `critic.ts` turns
 * `no-azure-mutation.test.ts` red. So the scan is not merely running its own
 * synthetic control — it is looking at the directory's actual source.
 *
 * **But M7 chose the one shape that was never blind.** `fetch(` was matched by a
 * call-shaped pattern; three of the scan's other patterns were anchored on the
 * keyword `from`, and an independent review on 2026-08-23 walked straight past
 * all three with `await import('node:https')` — a real ARM DELETE inside an
 * agent, RC 0, whole suite green. A mutation that confirms the guard you already
 * believe in is worth less than one aimed at the shape you did not try, and this
 * row is the local example of that. The evasions are now pinned as controls in
 * `no-azure-mutation.test.ts`.
 *
 * ── A PREDICTION THAT WAS WRONG, KEPT ──────────────────────────────────────
 * Before running M1 I expected the pipeline suite to fail broadly, since
 * removing the gate lets every refuted finding through. It failed FOUR tests,
 * not the whole file: the assembly, cost, correlation and degradation tests are
 * indifferent to whether a refuted finding is present, because none of them
 * asserts on the finding SET. That is correct behaviour and a fair description
 * of the suite's shape — the gate is guarded by four targeted assertions, not
 * by a broad smell test. Recorded rather than tidied away.
 *
 * ── WHAT NONE OF THIS ESTABLISHES ──────────────────────────────────────────
 * Every row above is a unit measurement with a stubbed model. NOTHING here has
 * run against a live Azure estate, a live AOAI deployment, or Azure Government.
 * See the PR body.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');

/**
 * The mutated lines, asserted to be present EXACTLY ONCE each.
 *
 * This is the anti-theatre check. A mutation needle that matches zero times
 * reads identically to a mutation that was applied and had no effect — and on
 * this repo, where every file is CRLF, an LF-authored needle matches zero times
 * silently. Pinning each subject line to exactly one occurrence means the table
 * above describes edits that could actually be made, and it fails loudly if a
 * refactor moves or duplicates one of them.
 *
 * The needles are line fragments with no newline in them, so they are immune to
 * the line-ending trap by construction rather than by luck.
 */
const MUTATION_SUBJECTS: readonly { id: string; file: string; needle: string }[] = [
  { id: 'M1', file: 'pipeline.ts', needle: 'allFindings.filter((f) => !refutedIds.has(f.id))' },
  { id: 'M2', file: 'critic.ts', needle: "if (modelChallenges.some((c) => c.wouldRefute)) return 'downgraded';" },
  { id: 'M3', file: 'critic.ts', needle: 'if (!f.population.blind) return null;' },
  { id: 'M4', file: 'remediator.ts', needle: 'export function isPureData(v: unknown, depth = 0): boolean {' },
  { id: 'M5', file: 'correlator.ts', needle: 'if (ci < 0 || ci >= components.length) {' },
  { id: 'M6', file: 'explainer.ts', needle: 'export function unverifiedNumbers(prose: string, given: string): string[] {' },
  { id: 'M7', file: 'critic.ts', needle: 'const CONFIDENCE_RANK: Record<Confidence, number>' },
];

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

describe('mutation record — every mutated subject is still uniquely addressable', () => {
  const sources = new Map<string, string>();
  for (const s of MUTATION_SUBJECTS) {
    if (!sources.has(s.file)) sources.set(s.file, readFileSync(join(AGENTS_DIR, s.file), 'utf8'));
  }

  it('POPULATION — the record covers seven mutations across five files', () => {
    expect(MUTATION_SUBJECTS).toHaveLength(7);
    expect(new Set(MUTATION_SUBJECTS.map((s) => s.file)).size).toBe(5);
    // A scan over empty sources is green and blind.
    expect([...sources.values()].every((s) => s.length > 500)).toBe(true);
  });

  for (const s of MUTATION_SUBJECTS) {
    it(`${s.id} — its subject line appears exactly once in ${s.file}`, () => {
      expect(occurrences(sources.get(s.file)!, s.needle)).toBe(1);
    });
  }

  it('CONTROL — the occurrence counter can return 0 and 2, not only 1', () => {
    // Without this, a counter hard-wired to 1 would satisfy every row above.
    expect(occurrences('abc', 'zzz')).toBe(0);
    expect(occurrences('abcabc', 'abc')).toBe(2);
    expect(occurrences('aaaa', 'aa')).toBe(2); // non-overlapping, as intended
  });
});

/**
 * LOOM BRAIN — the MUTATION RECEIPT for the detectors.
 *
 * Every predicate in `lib/brain/detectors` was verified by MUTATION, not by
 * inspection: the predicate was broken, the suites were run, the exit code was
 * captured, and the file was reverted. Eight mutations, all measured 2026-08-23
 * on this branch.
 *
 * Each needle was asserted to match EXACTLY ONCE before being applied. That check
 * is not ceremony — every `.ts` file in this repo is CRLF in the working tree
 * (`core.autocrlf=true`), so a needle written with an embedded LF matches ZERO
 * times, the harness reports "no change", and the whole exercise reads exactly
 * like a test that is theatre. All eight needles are single-line and contain no
 * newline for that reason.
 *
 * ── THE RECEIPT ────────────────────────────────────────────────────────────
 *   clean arm      RC=0   10 files, 145 passed
 *   reverted arm   RC=0   10 files, 145 passed
 *
 *   #   file : needle -> mutation                             RC   tests red
 *   --------------------------------------------------------------------------
 *   M1  unreachable-service.ts
 *       `...'configured').length === 0;`  ->  `... >= 0;`      1   2
 *   M2  unreachable-service.ts
 *       `node.scale!.minReplicas > 0 &&`  ->  `... >= 0 &&`    1   1
 *   M3  unreachable-service.ts
 *       `const vacuous = vacuityReason(graph, 'configured');`
 *                                         ->  `= null`         1   4
 *   M4  dangling-wire.ts
 *       `REPORTED_REASONS = ['empty-value','missing-resource']`
 *                                         ->  drop empty-value 1   5
 *   M5  orphan.ts
 *       `if (parentNode !== undefined) continue;`
 *                                         ->  `=== undefined`  1   5
 *   M6  declared-but-dead.ts
 *       `hasInboundOnly(graph, 'declared', 'configured')`
 *                                         ->  args swapped     1   4
 *   M7  always-on-unused.ts
 *       `if (vacuous !== null) {`         ->  `=== null`        1   9
 *   M8  config-drift.ts
 *       `} else if (!isInterpolated(dRaw) && !isInterpolated(cRaw) && ...`
 *                                         ->  guard removed    1   2
 *
 * ── THE INSTRUCTIVE PARTS ──────────────────────────────────────────────────
 *
 * **M2 turns exactly ONE test red**, and that test is
 * `"THE CONTROL: a scale-to-zero unreachable app is NOT reported"` in the
 * acceptance suite. So the entire `minReplicas > 0` half of the flagship
 * predicate rests on a single assertion about `loom-scratch`. Delete that one
 * `it` block and the always-on half becomes undetectable — the detector would
 * silently start reporting every unreachable app, including the ten that
 * correctly scale to zero, and every other test would stay green. That fixture
 * exists for this reason and must not be trimmed as redundant.
 *
 * **M7 flips BOTH arms**, which is the strongest result in the set. Inverting the
 * vacuity gate makes the no-telemetry graph emit findings AND makes the
 * with-telemetry graph emit none. A one-armed suite could not have shown that:
 * with only the no-telemetry arm the mutation looks like "now it finds things",
 * which is indistinguishable from an improvement.
 *
 * **M3 and M7 are the two that protect against the failure this repo keeps
 * shipping** — a detector that is green because it is blind. Between them they
 * turn 13 tests red, and none of those tests assert a finding: they all assert
 * that the detector REFUSED to answer and said why.
 *
 * **M4 removes the RECEIPT while leaving most verdicts intact.** Dropping
 * `empty-value` from the reported reasons does not change whether
 * `unreachable-service` finds the broker — that detector reads inbound edges, not
 * dangling ones, and it stays green throughout. What dies is the evidence: the
 * `main.bicep:4730` line, the symbol, and the `''`. This is the same lesson the
 * graph substrate recorded from its own mutation, reproduced one layer up:
 * assert the specific evidence, in its own `it` block, or a passing verdict masks
 * its loss.
 *
 * ── HOW TO REPRODUCE ───────────────────────────────────────────────────────
 * Apply one needle above with an editor that does not touch line endings, run
 * `pnpm vitest run lib/brain/__tests__/detectors`, read the exit code on the line
 * IMMEDIATELY after the command (never after a pipe — the pipe's status is
 * `tail`'s, not vitest's), then revert. The harness that automated this ran from
 * `temp/` and is deliberately not committed; the needles above are the durable
 * artifact because they are what a reviewer re-applies by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const D = (f: string) => join(__dirname, '..', '..', 'detectors', f);

/**
 * The exact needles that were mutated. Asserting they still match EXACTLY ONCE
 * is what keeps this receipt honest: if a refactor moves or duplicates a
 * predicate, the recorded mutation no longer describes the code and this test
 * says so, rather than the receipt quietly going stale.
 */
const MUTATED_NEEDLES: readonly { readonly id: string; readonly file: string; readonly needle: string }[] = [
  {
    id: 'M1/M2 unreachable-service predicate',
    file: 'unreachable-service.ts',
    needle: "      node.scale!.minReplicas > 0 && inbound(graph, node.id, 'configured').length === 0;",
  },
  {
    id: 'M3 unreachable-service vacuity gate',
    file: 'unreachable-service.ts',
    needle: "  const vacuous = vacuityReason(graph, 'configured');",
  },
  {
    id: 'M4 dangling-wire reported reasons',
    file: 'dangling-wire.ts',
    needle: "export const REPORTED_REASONS: readonly DanglingReason[] = ['empty-value', 'missing-resource'];",
  },
  {
    id: 'M5 orphan parent-missing predicate',
    file: 'orphan.ts',
    needle: '      if (parentNode !== undefined) continue;',
  },
  {
    id: 'M6 declared-but-dead provenance order',
    file: 'declared-but-dead.ts',
    needle: "  const dead = hasInboundOnly(graph, 'declared', 'configured');",
  },
  {
    id: 'M7 always-on-unused vacuity gate',
    file: 'always-on-unused.ts',
    needle: '  if (vacuous !== null) {',
  },
  {
    id: 'M8 config-drift false-positive guard',
    file: 'config-drift.ts',
    needle:
      '    } else if (!isInterpolated(dRaw) && !isInterpolated(cRaw) && dRaw !== undefined && cRaw !== undefined) {',
  },
];

describe('the mutation receipt still describes the code it was measured against', () => {
  it('POPULATION: seven needles across six detector modules', () => {
    // A receipt over an empty needle list would pass forever.
    expect(MUTATED_NEEDLES.length).toBe(7);
    expect(new Set(MUTATED_NEEDLES.map((n) => n.file)).size).toBe(6);
  });

  it('CONTROL: the match counter can actually report a miss', () => {
    // Without this, a counter that always returned 1 and a set of intact needles
    // would be indistinguishable.
    const text = 'alpha beta alpha';
    expect(text.split('alpha').length - 1).toBe(2);
    expect(text.split('gamma').length - 1).toBe(0);
  });

  it.each(MUTATED_NEEDLES)('$id — the needle matches EXACTLY once in $file', ({ file, needle }) => {
    const text = readFileSync(D(file), 'utf8');
    const hits = text.split(needle).length - 1;
    expect(
      hits,
      `needle matched ${hits} times; the recorded mutation no longer describes this file`,
    ).toBe(1);
    // …and it contains no newline, so CRLF cannot silently zero it out.
    expect(needle).not.toContain('\n');
  });
});

describe('the assertions that die under each mutation are SEPARATE from the verdicts', () => {
  it('the M2 control lives in its own `it` block and must not be folded in', () => {
    // M2 turns exactly ONE test red. Folded into the reachability test, a passing
    // verdict would mask it and the always-on half of the predicate would become
    // unverifiable. This is the executable reminder.
    const acceptance = readFileSync(join(__dirname, 'acceptance-capacity-broker.test.ts'), 'utf8');
    expect(acceptance).toContain("it('THE CONTROL: a scale-to-zero unreachable app is NOT reported'");
    expect(acceptance).toContain("it('THE CONTROL: the wired always-on service is NOT reported'");
    expect(acceptance).toContain("it('THE EVIDENCE CHAIN:");
  });

  it('the M7 receipt requires BOTH telemetry arms to exist', () => {
    const arms = readFileSync(join(__dirname, 'always-on-unused.test.ts'), 'utf8');
    expect(arms).toContain('ARM A: NO telemetry');
    expect(arms).toContain('ARM B: WITH telemetry');
    // The arm that would be dropped first as "redundant" is the one that proves
    // the two differ.
    expect(arms).toContain('the two arms genuinely differ');
  });
});

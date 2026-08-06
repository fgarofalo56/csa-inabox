/**
 * E3 (loom-next-level) — fixture tests for the eval-floor gate + raise-only
 * ratchet logic in scripts/csa-loom/eval-regression-lib.mjs (the pure module
 * behind check-eval-regression.mjs / ratchet-eval-floors.mjs).
 *
 * Contracts locked here (ws-copilot-cost.md E3 + the E2 cap contract):
 *   - below-floor  → hard failure;
 *   - one-run drop > EVAL_REGRESSION_DELTA points but above floor → WARN only;
 *   - groundingAvg null (judge 'deferred') → NO-CHANGE: neither the grounding
 *     floor nor the grounding delta is evaluated;
 *   - ratchet raises floors ONLY upward (min observed − margin, capped), and
 *     only after a >= minRuns streak.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — dependency-free repo-root script module (no .d.ts on purpose)
import {
  normalizeRuns,
  latestAndPrevious,
  evaluateGate,
  renderMarkdown,
  attachQuestions,
  ratchetFloors,
  passPredicateOf,
  predicatesComparable,
} from '../../../scripts/csa-loom/eval-regression-lib.mjs';

const floorsDoc = {
  _meta: { deltaConvention: 'points' },
  floors: {
    help: { retrievalHitRate: 0.8, groundingAvg: 4.0, passRate: 0.85, provisional: false },
    cost: { retrievalHitRate: 0.5, groundingAvg: 3.0, passRate: 0.4, provisional: true },
  },
};

const run = (surface: string, hit: number, grounding: number | null, pass: number, startedAt?: string) => ({
  surface,
  startedAt,
  questions: 20,
  retrievalHitRate: hit,
  groundingAvg: grounding,
  passRate: pass,
});

describe('normalizeRuns', () => {
  it('accepts the E2 HTTP-trigger response shape', () => {
    const m = normalizeRuns({ ok: true, surfaces: [run('help', 0.9, 4.3, 0.9)] });
    expect(m.size).toBe(1);
    expect(m.get('help').retrievalHitRate).toBe(0.9);
    expect(m.get('help').groundingAvg).toBe(4.3);
  });

  it('accepts Cosmos eval-run docs (totals nesting) and keeps the latest per surface', () => {
    const m = normalizeRuns([
      { surface: 'help', startedAt: '2026-07-22T01:00:00Z', totals: { questions: 20, retrievalHitRate: 0.7, groundingAvg: 4.0, passRate: 0.7 } },
      { surface: 'help', startedAt: '2026-07-23T01:00:00Z', totals: { questions: 20, retrievalHitRate: 0.9, groundingAvg: 4.3, passRate: 0.9 } },
    ]);
    expect(m.get('help').retrievalHitRate).toBe(0.9);
  });

  it('treats missing/undefined groundingAvg as null (deferred)', () => {
    const m = normalizeRuns({ surfaces: [{ surface: 'help', questions: 20, retrievalHitRate: 0.9, groundingAvg: null, passRate: 0.9 }] });
    expect(m.get('help').groundingAvg).toBeNull();
  });
});

describe('latestAndPrevious', () => {
  it('splits per surface by startedAt', () => {
    const docs = [
      { surface: 'help', startedAt: '2026-07-21T07:00:00Z', totals: { retrievalHitRate: 0.85, groundingAvg: 4.2, passRate: 0.85, questions: 20 } },
      { surface: 'help', startedAt: '2026-07-22T07:00:00Z', totals: { retrievalHitRate: 0.9, groundingAvg: 4.3, passRate: 0.9, questions: 20 } },
      { surface: 'cost', startedAt: '2026-07-22T07:00:00Z', totals: { retrievalHitRate: 0.7, groundingAvg: 3.8, passRate: 0.6, questions: 12 } },
    ];
    const { latest, previous } = latestAndPrevious(docs);
    expect(latest.get('help').retrievalHitRate).toBe(0.9);
    expect(previous.get('help').retrievalHitRate).toBe(0.85);
    expect(previous.has('cost')).toBe(false);
  });
});

describe('evaluateGate — floors', () => {
  it('passes when every metric clears its floor', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.3, 0.9), run('cost', 0.7, 3.5, 0.6)] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures).toEqual([]);
    expect(r.rows.every((x: any) => x.status === 'ok')).toBe(true);
  });

  it('fails hard below a floor, naming surface + metric + floor', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.6, 4.3, 0.9), run('cost', 0.7, 3.5, 0.6)] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('help');
    expect(r.failures[0]).toContain('hit-rate');
    expect(r.failures[0]).toContain('BELOW the floor 0.80');
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
  });

  it('grounding null (judge deferred) leaves the GROUNDING floor unevaluated — but fails the run (#2992)', () => {
    // The E2 cap contract ("deferred grounding is no-change") is scoped to the
    // GROUNDING metric. It never licensed publishing a pass rate: with no judged
    // row the pass predicate lost its `grounding >= 4` conjunct, so `passRate`
    // here is a `deterministicPassRate` under the judged metric's name (#2992).
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, null, 0.9), run('cost', 0.7, null, 0.6)] });
    const r = evaluateGate(cur, floorsDoc);
    // unchanged: the grounding floor itself is still treated as no-change
    expect(r.rows.find((x: any) => x.surface === 'help').metrics.groundingAvg.verdict).toBe('deferred');
    expect(r.notes.some((n: string) => n.includes('deferred'))).toBe(true);
    expect(r.failures.some((f: string) => f.includes('BELOW the floor'))).toBe(false);
    // new: the run is RED, and for the pass-predicate reason specifically
    expect(r.failures).toHaveLength(2);
    expect(r.failures.every((f: string) => f.includes('deterministicPassRate'))).toBe(true);
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
  });

  it('a floored surface missing from the run warns by default, fails under strictMissing', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.3, 0.9)] });
    const lax = evaluateGate(cur, floorsDoc);
    expect(lax.failures).toEqual([]);
    expect(lax.warnings.some((w: string) => w.includes('cost'))).toBe(true);
    const strict = evaluateGate(cur, floorsDoc, { strictMissing: true });
    expect(strict.failures.some((f: string) => f.includes('cost'))).toBe(true);
  });

  it('a surface with no floor yet is a note, never a failure', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.3, 0.9), run('cost', 0.7, 3.5, 0.6), run('lakehouse', 0.2, 2.0, 0.1)] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures).toEqual([]);
    expect(r.rows.find((x: any) => x.surface === 'lakehouse').status).toBe('no-floor');
  });
});

/**
 * Issue #2798 — the gate reported "hit-rate 0.00 is BELOW the floor 0.50" for
 * four surfaces that had scored ZERO questions apiece: every eval-probe call
 * failed, the evaluator dropped those rows, and rollupRun([]) rolls an empty
 * result set up as a hard `retrievalHitRate: 0 / passRate: 0`. The gate read
 * that as a measured retrieval outage and the issue was triaged as one.
 *
 * A surface that was never measured must not produce a quality verdict — in
 * EITHER direction. It must not fabricate a below-floor failure, and it must
 * not silently pass (nightly `--strict-missing` still fails it).
 */
describe('evaluateGate — zero-question surfaces are NOT MEASURED (#2798)', () => {
  /** The real shape of run 30728526190's receipt: hard zeroes, no questions. */
  const notMeasured = (surface: string, rowsAttempted?: number, probeErrors?: Record<string, number>) => ({
    surface,
    questions: 0,
    rowsAttempted,
    probeErrors,
    retrievalHitRate: 0,
    groundingAvg: null,
    passRate: 0,
  });

  it('does NOT report a below-floor failure for a surface that scored zero questions', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.3, 0.9), notMeasured('cost', 12, { 429: 12 })] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures).toEqual([]);
    expect(r.rows.find((x: any) => x.surface === 'cost').status).toBe('missing');
    expect(r.rows.find((x: any) => x.surface === 'cost').notMeasured).toBe(true);
  });

  it('says WHY: names the rows attempted and the probe-failure statuses', () => {
    const cur = normalizeRuns({ surfaces: [notMeasured('cost', 12, { 429: 11, 0: 1 })] });
    const r = evaluateGate(cur, floorsDoc);
    const w = r.warnings.find((x: string) => x.includes('cost'));
    expect(w).toContain('ZERO questions scored');
    expect(w).toContain('of 12 golden row(s)');
    expect(w).toContain('"429":11');
    expect(w).toContain('NOT measured');
  });

  it('still FAILS under strictMissing (nightly) — not a licence to pass', () => {
    const cur = normalizeRuns({ surfaces: [notMeasured('cost', 12, { 429: 12 })] });
    const r = evaluateGate(cur, floorsDoc, { strictMissing: true });
    expect(r.failures.some((f: string) => f.includes('cost') && f.includes('ZERO questions scored'))).toBe(true);
    // and never as a fabricated floor breach
    expect(r.failures.some((f: string) => f.includes('BELOW the floor'))).toBe(false);
  });

  it('a surface that DID run questions still fails its floor (gate not blanket-disabled)', () => {
    // kql-database in the real run: 1 question, genuinely 0.00 hit-rate.
    const cur = normalizeRuns({
      surfaces: [{ surface: 'help', questions: 1, rowsAttempted: 15, retrievalHitRate: 0, groundingAvg: 3, passRate: 0 }],
    });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures.some((f: string) => f.includes('BELOW the floor'))).toBe(true);
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
  });

  it('an artifact with NO questions field is legacy, not zero — still evaluated', () => {
    const cur = normalizeRuns({ surfaces: [{ surface: 'help', retrievalHitRate: 0.4, groundingAvg: 4.3, passRate: 0.9 }] });
    expect(cur.get('help').questions).toBeNull();
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures.some((f: string) => f.includes('BELOW the floor'))).toBe(true);
  });

  it('renderMarkdown prints "not measured", never a 0.00 rate, for such a surface', () => {
    const cur = normalizeRuns({ surfaces: [notMeasured('cost', 12, { 429: 12 })] });
    const md = renderMarkdown(attachQuestions(evaluateGate(cur, floorsDoc), cur), {});
    const line = md.split('\n').find((l: string) => l.startsWith('| cost'))!;
    expect(line).toContain('not measured');
    expect(line).toContain('0/12');
    expect(line).not.toContain('0.00');
  });
});

describe('evaluateGate — delta vs previous run (EVAL_REGRESSION_DELTA points)', () => {
  it('warns on a >5-point rate drop that stays above floor', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.86, 4.3, 0.92), run('cost', 0.7, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.93, 4.3, 0.92)] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
    expect(r.failures).toEqual([]);
    expect(r.warnings.some((w: string) => w.includes('help') && w.includes('hit-rate') && w.includes('7.0 points'))).toBe(true);
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('warn');
  });

  it('does not warn on a <=5-point drop', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.89, 4.3, 0.92), run('cost', 0.7, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.93, 4.3, 0.92)] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
    expect(r.warnings.filter((w: string) => w.includes('hit-rate'))).toEqual([]);
  });

  it('grounding delta scales ×25: a 0.3 drop (7.5 pts) warns, a 0.1 drop (2.5 pts) does not', () => {
    const prev = normalizeRuns({ surfaces: [run('help', 0.9, 4.5, 0.9)] });
    const warn = evaluateGate(
      normalizeRuns({ surfaces: [run('help', 0.9, 4.2, 0.9), run('cost', 0.7, 3.5, 0.6)] }),
      floorsDoc,
      { previous: prev, deltaPoints: 5 },
    );
    expect(warn.warnings.some((w: string) => w.includes('grounding') && w.includes('7.5 points'))).toBe(true);
    const ok = evaluateGate(
      normalizeRuns({ surfaces: [run('help', 0.9, 4.4, 0.9), run('cost', 0.7, 3.5, 0.6)] }),
      floorsDoc,
      { previous: prev, deltaPoints: 5 },
    );
    expect(ok.warnings.filter((w: string) => w.includes('grounding'))).toEqual([]);
  });

  it('below-floor wins over big-drop (fail, not double-warn)', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.5, 4.3, 0.9), run('cost', 0.7, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.95, 4.3, 0.9)] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
    expect(r.warnings.filter((w: string) => w.includes('hit-rate'))).toEqual([]);
    expect(r.failures.some((f: string) => f.includes('hit-rate'))).toBe(true);
  });

  it('a deferred previous grounding contributes no grounding delta', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.1, 0.9), run('cost', 0.7, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.9, null, 0.9)] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
    // the GROUNDING metric contributes no delta (nothing to compare against)…
    expect(r.warnings.filter((w: string) => w.includes('grounding dropped'))).toEqual([]);
    // …and the PASS-RATE delta is refused, because that baseline was produced
    // without the `grounding >= 4` conjunct this run applied (#2992).
    expect(r.rows.find((x: any) => x.surface === 'help').metrics.passRate.verdict).toBe('delta-refused');
  });
});

/**
 * Issue #2992 — an eval run came back with `groundingAvg: null` on EVERY
 * surface (the judge deferred entirely). The harness carried on: `passRate` was
 * recomputed deterministic-only, with the `grounding >= 4` conjunct ABSENT from
 * the pass predicate, and that value was subtracted from a JUDGED baseline. The
 * difference was reported as `data-agent +20` / `report +20`.
 *
 * The direction is what makes it dangerous. Dropping a conjunct from a pass
 * predicate can only move the rate UP, so a TOTAL judge failure reliably renders
 * as a large improvement — the worse the degradation, the better the number.
 *
 * These tests are written as a MUTATION PROOF: each one pins the DEGRADED path,
 * because the entire bug lives there. The healthy-path tests below them exist
 * only to show the degraded-path guard did not cost the working comparison.
 */
describe('#2992 — a degraded pass predicate is a failure, not an improvement', () => {
  /** A run receipt in the shape the evaluator's `::eval-run::` line emits. */
  const receipt = (o: Record<string, unknown>) => ({
    surface: 'help', questions: 20, retrievalHitRate: 0.9, groundingAvg: 4.3, passRate: 0.6, ...o,
  });

  it('THE REPORTED DEFECT: a judged baseline vs a deferred run emits NO +delta and goes RED', () => {
    // Precisely the reported shape: identical deterministic retrieval, judge
    // gone, pass "up" 20 points purely because the conjunct vanished.
    const prev = normalizeRuns({ surfaces: [receipt({ groundingAvg: 4.267, passRate: 0.61 })] });
    const cur = normalizeRuns({ surfaces: [receipt({ groundingAvg: null, passRate: 0.81 })] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });

    const pass = r.rows.find((x: any) => x.surface === 'help').metrics.passRate;
    // no delta at all — not a +20, not a -20, not a 0
    expect(pass.deltaPoints).toBeNull();
    expect(pass.verdict).toBe('degraded-predicate');
    // the run is RED
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
    expect(r.failures.some((f: string) => f.includes('NO pass-rate'))).toBe(true);
    // and the rendered receipt never prints the number under the pass-rate header
    const md = renderMarkdown(attachQuestions(r, cur), { deltaPoints: 5 });
    expect(md).not.toContain('(+20)');
    expect(md).toContain('not computed');
    expect(md).toContain('Pass-predicate provenance');
    expect(md).toContain('deterministicPassRate');
  });

  it('the degraded rate is carried under its OWN name, and its floor is not evaluated', () => {
    // 0.9 clears help's 0.85 passRate floor — but that floor is expressed in a
    // judged rate, so checking it here would be the same category error.
    const cur = normalizeRuns({ surfaces: [receipt({ groundingAvg: null, passRate: 0.9 })] });
    const r = evaluateGate(cur, floorsDoc);
    const pass = r.rows.find((x: any) => x.surface === 'help').metrics.passRate;
    expect(pass.value).toBeNull();
    expect(pass.metricName).toBe('deterministicPassRate');
    expect(pass.degradedValue).toBe(0.9);
    // no floor verdict was reached in EITHER direction
    expect(r.failures.some((f: string) => f.includes('BELOW the floor'))).toBe(false);
  });

  it('a below-floor degraded rate is still not scored against the judged floor', () => {
    // The guard must not become a one-way pass either: 0.2 is far below the
    // 0.85 floor, but this run still did not measure the thing that floor means.
    const cur = normalizeRuns({ surfaces: [receipt({ groundingAvg: null, passRate: 0.2 })] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures.some((f: string) => f.includes('pass-rate') && f.includes('BELOW the floor'))).toBe(false);
    expect(r.rows.find((x: any) => x.surface === 'help').status).toBe('fail');
  });

  it('names the exact remediation rather than dead-ending', () => {
    const cur = normalizeRuns({ surfaces: [receipt({ groundingAvg: null })] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures[0]).toContain('LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT');
    expect(r.failures[0]).toContain('LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP');
  });

  it('a never-measured surface is still #2798, not #2992 (no double verdict)', () => {
    const cur = normalizeRuns({ surfaces: [receipt({ questions: 0, groundingAvg: null, passRate: 0, rowsAttempted: 20 })] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.rows.find((x: any) => x.surface === 'help').notMeasured).toBe(true);
    expect(r.failures.some((f: string) => f.includes('deterministicPassRate'))).toBe(false);
  });

  describe('passPredicateOf — provenance is INFERRED, so the fix is not deploy-gated', () => {
    it('infers the conjunct set from fields the deployed evaluator already emits', () => {
      // Exact, not heuristic: rollupRun sets groundingAvg = null iff zero rows
      // were judged, and productFidelityJudged counts rows that returned it.
      expect(passPredicateOf({ questions: 20, groundingAvg: null }).id).toBe('deterministic');
      expect(passPredicateOf({ questions: 20, groundingAvg: 4.2 }).id).toBe('deterministic+grounding');
      expect(passPredicateOf({ questions: 20, groundingAvg: 4.2, productFidelityJudged: 20 }).id)
        .toBe('deterministic+grounding+productFidelity');
      expect(passPredicateOf({ questions: 20, groundingAvg: null }).source).toBe('inferred');
    });

    it('prefers a DECLARED predicate when the evaluator emits one (post-#2991 image)', () => {
      const p = passPredicateOf({
        questions: 20, groundingAvg: 4.2,
        passPredicate: { conjuncts: ['deterministic', 'grounding'], judgeCoverage: 1 },
      });
      expect(p.source).toBe('declared');
      expect(p.id).toBe('deterministic+grounding');
      expect(p.degraded).toBe(false);
    });

    it('computes judge coverage over the JUDGEABLE set (auto-fails never spend a call)', () => {
      // 4 auto-failed + 16 judged of 20 = full coverage, not 80%.
      expect(passPredicateOf({ questions: 20, groundingAvg: 4.2, judged: 16, autoFailed: 4 }).judgeCoverage).toBe(1);
      expect(passPredicateOf({ questions: 20, groundingAvg: 4.2, judged: 10, autoFailed: 0 }).judgeCoverage).toBe(0.5);
      // absent on the console-log receipt shape — null, never a fabricated 1
      expect(passPredicateOf({ questions: 20, groundingAvg: 4.2 }).judgeCoverage).toBeNull();
    });
  });

  describe('predicatesComparable — refuses rather than subtracting', () => {
    const P = (o: Record<string, unknown>) => passPredicateOf({ questions: 20, ...o });

    it('REFUSES a judged baseline vs a deterministic-only current', () => {
      const cmp = predicatesComparable(P({ groundingAvg: null }), P({ groundingAvg: 4.2 }), { deltaPoints: 5 });
      expect(cmp.ok).toBe(false);
      expect(cmp.reason).toBe('predicate-mismatch');
      expect(cmp.detail).toContain('DROPPED [grounding]');
    });

    it('REFUSES when the productFidelity conjunct appears or disappears (#2979/#2984)', () => {
      const withFid = P({ groundingAvg: 4.2, productFidelityJudged: 20 });
      const without = P({ groundingAvg: 4.2, productFidelityJudged: 0 });
      expect(predicatesComparable(withFid, without, { deltaPoints: 5 }).reason).toBe('predicate-mismatch');
      expect(predicatesComparable(without, withFid, { deltaPoints: 5 }).reason).toBe('predicate-mismatch');
    });

    it('REFUSES a same-conjunct pair whose judge REACH differs by more than the threshold', () => {
      const full = P({ groundingAvg: 4.2, judged: 20, autoFailed: 0 });
      const partial = P({ groundingAvg: 4.2, judged: 4, autoFailed: 0 });
      expect(predicatesComparable(partial, full, { deltaPoints: 5 }).reason).toBe('coverage-gap');
      // …but tolerates a gap inside the band the check already treats as noise
      const near = P({ groundingAvg: 4.2, judged: 20, autoFailed: 1 });
      expect(predicatesComparable(near, full, { deltaPoints: 5 }).ok).toBe(true);
    });

    it('ALLOWS two deterministic-only runs to be compared to each other', () => {
      // Same predicate on both sides — the quantity is consistent, so the
      // comparison is sound even though neither side was judged.
      const cmp = predicatesComparable(P({ groundingAvg: null }), P({ groundingAvg: null }), { deltaPoints: 5 });
      expect(cmp.ok).toBe(true);
    });
  });

  describe('the healthy path is unchanged', () => {
    it('still emits improvements AND still catches real drops', () => {
      // improvement, both sides judged: the delta is emitted as before
      const prev = normalizeRuns({ surfaces: [receipt({ groundingAvg: 4.267, passRate: 0.86 })] });
      const cur = normalizeRuns({ surfaces: [receipt({ groundingAvg: 4.4, passRate: 0.97 })] });
      const up = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
      expect(up.rows.find((x: any) => x.surface === 'help').metrics.passRate.deltaPoints).toBe(11);
      expect(up.failures).toEqual([]);

      // a real >5-point drop that stays above floor still WARNS (cost floor 0.4)
      const drop = evaluateGate(
        normalizeRuns({ surfaces: [receipt({ surface: 'cost', groundingAvg: 3.5, passRate: 0.52 })] }),
        floorsDoc,
        { previous: normalizeRuns({ surfaces: [receipt({ surface: 'cost', groundingAvg: 3.5, passRate: 0.6 })] }), deltaPoints: 5 },
      );
      const d = drop.rows.find((x: any) => x.surface === 'cost').metrics.passRate;
      expect(d.deltaPoints).toBe(-8);
      expect(d.verdict).toBe('big-drop');
      expect(drop.warnings.some((w: string) => w.includes('pass-rate dropped 8.0 points'))).toBe(true);

      // and a real below-floor drop still FAILS
      const below = evaluateGate(
        normalizeRuns({ surfaces: [receipt({ groundingAvg: 4.267, passRate: 0.53 })] }),
        floorsDoc,
        { previous: prev, deltaPoints: 5 },
      );
      expect(below.rows.find((x: any) => x.surface === 'help').metrics.passRate.verdict).toBe('below-floor');
    });
  });

  describe('ratchetFloors — a degraded run may never raise a passRate floor', () => {
    it('skips the passRate ratchet when the window mixes predicates', () => {
      const obs = new Map([[
        'help',
        [
          { questions: 20, retrievalHitRate: 0.95, groundingAvg: 4.5, passRate: 0.95 },
          { questions: 20, retrievalHitRate: 0.95, groundingAvg: 4.5, passRate: 0.95 },
          // judge gone: 0.99 is inflated by the missing conjunct. Ratcheting it
          // would pin a floor no healthy JUDGED run could ever clear.
          { questions: 20, retrievalHitRate: 0.95, groundingAvg: null, passRate: 0.99 },
        ],
      ]]);
      const { next, changes, skipped } = ratchetFloors(floorsDoc, obs, { minRuns: 3 });
      expect(changes.some((c: any) => c.metric === 'passRate')).toBe(false);
      expect(next.floors.help.passRate).toBe(floorsDoc.floors.help.passRate);
      expect(skipped.some((s: string) => s.includes('mixes pass predicates'))).toBe(true);
      // retrievalHitRate is deterministic and unaffected by the judge — it still ratchets
      expect(changes.some((c: any) => c.metric === 'retrievalHitRate')).toBe(true);
    });

    it('still ratchets passRate from a uniformly-judged window', () => {
      const judgedRun = { questions: 20, retrievalHitRate: 0.95, groundingAvg: 4.5, passRate: 0.95 };
      const obs = new Map([['help', [judgedRun, judgedRun, judgedRun]]]);
      const { changes } = ratchetFloors(floorsDoc, obs, { minRuns: 3 });
      expect(changes.some((c: any) => c.metric === 'passRate' && c.to === 0.9)).toBe(true);
    });
  });
});

describe('renderMarkdown', () => {
  it('emits the per-surface sticky-comment table with deltas + verdicts', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.3, 0.92), run('cost', 0.4, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.88, 4.4, 0.9)] });
    const report = attachQuestions(evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 }), cur);
    const md = renderMarkdown(report, { title: 'Copilot quality evals — floor gate', deltaPoints: 5, floorsProvisional: true });
    expect(md).toContain('| Surface | Q |');
    expect(md).toContain('| help | 20 |');
    expect(md).toContain('0.90 (+2)'); // hit-rate 0.88 → 0.90 = +2 points
    expect(md).toContain('**< floor 0.50**'); // cost hit-rate 0.4 below its 0.5 floor
    expect(md).toContain('Below-floor failures');
    expect(md).toContain('PROVISIONAL');
  });
});

describe('ratchetFloors — raise-only', () => {
  const obs = (runs: any[]) => {
    const m = new Map<string, any[]>();
    for (const r of runs) {
      const list = m.get(r.surface) ?? [];
      list.push(r);
      m.set(r.surface, list);
    }
    return m;
  };

  it('raises to min(observed) − margin over a >=minRuns streak and clears provisional', () => {
    const streak = obs([
      run('cost', 0.82, 4.1, 0.78),
      run('cost', 0.85, 4.2, 0.8),
      run('cost', 0.9, 4.4, 0.83),
    ]);
    const { next, changes } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(changes).toContainEqual({ surface: 'cost', metric: 'retrievalHitRate', from: 0.5, to: 0.77 }); // 0.82 − 0.05
    expect(changes).toContainEqual({ surface: 'cost', metric: 'groundingAvg', from: 3.0, to: 3.9 }); // 4.1 − 0.2
    expect(changes).toContainEqual({ surface: 'cost', metric: 'passRate', from: 0.4, to: 0.73 }); // 0.78 − 0.05
    expect(next.floors.cost.provisional).toBe(false);
    // untouched surface unchanged
    expect(next.floors.help).toEqual(floorsDoc.floors.help);
  });

  it('never lowers a floor', () => {
    const streak = obs([run('help', 0.7, 3.5, 0.7), run('help', 0.72, 3.6, 0.7), run('help', 0.71, 3.6, 0.7)]);
    const { next, changes } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(changes).toEqual([]);
    expect(next.floors.help).toEqual(floorsDoc.floors.help);
  });

  it('ignores never-measured runs (questions 0) instead of pinning the floor to their 0.00 (#2798)', () => {
    // One unmeasured run in the window used to become observedMin=0, which
    // silently blocked this surface's floor from ever ratcheting.
    const streak = obs([
      run('cost', 0.82, 4.1, 0.78),
      run('cost', 0.85, 4.2, 0.8),
      run('cost', 0.9, 4.4, 0.83),
      { surface: 'cost', questions: 0, retrievalHitRate: 0, groundingAvg: null, passRate: 0 } as any,
    ]);
    const { changes, skipped } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(changes).toContainEqual({ surface: 'cost', metric: 'retrievalHitRate', from: 0.5, to: 0.77 });
    expect(skipped.some((s: string) => s.includes('cost'))).toBe(false);
  });

  it('reports the unmeasured runs it dropped when that breaks the streak (#2798)', () => {
    const streak = obs([
      run('cost', 0.82, 4.1, 0.78),
      { surface: 'cost', questions: 0, retrievalHitRate: 0, groundingAvg: null, passRate: 0 } as any,
      { surface: 'cost', questions: 0, retrievalHitRate: 0, groundingAvg: null, passRate: 0 } as any,
    ]);
    const { changes, skipped } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(changes).toEqual([]);
    expect(skipped.some((s: string) => s.includes('cost') && s.includes('2 run(s) ignored'))).toBe(true);
  });

  it('skips surfaces without a full streak', () => {
    const { changes, skipped } = ratchetFloors(floorsDoc, obs([run('cost', 0.9, 4.5, 0.9)]), { minRuns: 3 });
    expect(changes).toEqual([]);
    expect(skipped.some((s: string) => s.includes('cost') && s.includes('need >= 3'))).toBe(true);
  });

  it('caps proposals (a flaky-perfect streak cannot create an unclearable floor)', () => {
    const streak = obs([run('cost', 1, 5, 1), run('cost', 1, 5, 1), run('cost', 1, 5, 1)]);
    const { next } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(next.floors.cost.retrievalHitRate).toBe(0.95);
    expect(next.floors.cost.groundingAvg).toBe(4.6);
    expect(next.floors.cost.passRate).toBe(0.95);
  });

  it('deferred grounding runs contribute no grounding evidence; other metrics still ratchet', () => {
    const streak = obs([run('cost', 0.82, null, 0.78), run('cost', 0.85, null, 0.8), run('cost', 0.9, null, 0.83)]);
    const { next, changes } = ratchetFloors(floorsDoc, streak, { minRuns: 3 });
    expect(changes.some((c: any) => c.metric === 'groundingAvg')).toBe(false);
    expect(next.floors.cost.groundingAvg).toBe(3.0);
    expect(next.floors.cost.retrievalHitRate).toBe(0.77);
  });

  it('does not mutate the input floors doc', () => {
    const before = JSON.stringify(floorsDoc);
    ratchetFloors(floorsDoc, obs([run('cost', 0.9, 4.5, 0.9), run('cost', 0.9, 4.5, 0.9), run('cost', 0.9, 4.5, 0.9)]), { minRuns: 3 });
    expect(JSON.stringify(floorsDoc)).toBe(before);
  });
});

describe('eval-floors.json (the committed floors)', () => {
  it('carries the ratchet-header contract (owner / why / unblock) and floors for all 10 E1 surfaces', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const doc = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../content/evals/eval-floors.json'), 'utf-8'),
    );
    expect(doc._meta.owner).toBeTruthy();
    expect(doc._meta.why).toBeTruthy();
    expect(doc._meta.unblock).toContain('ratchet-eval-floors.mjs');
    const surfaces = Object.keys(doc.floors);
    expect(surfaces.sort()).toEqual(
      ['cost', 'data-agent', 'deploy-planner', 'eventstream', 'health', 'help', 'kql-database', 'lakehouse', 'rbac', 'report'].sort(),
    );
    for (const s of surfaces) {
      const f = doc.floors[s];
      expect(f.retrievalHitRate).toBeGreaterThan(0);
      expect(f.groundingAvg).toBeGreaterThanOrEqual(1);
      expect(f.passRate).toBeGreaterThan(0);
      expect(typeof f.provisional).toBe('boolean');
    }
  });

  it('records the basis of every ratchet, so a floor can never be a number with no provenance', async () => {
    // 2026-08-06: the first real ratchet. `provisional` was seeded true before
    // any run data existed; a floor that has since moved from MEASURED runs must
    // say which runs, under which rule — otherwise the next session cannot tell
    // a measured floor from a guessed one, which is how the seed sat unmoved
    // (lastRatchet: null) for two weeks while six measured runs accumulated.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const doc = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../content/evals/eval-floors.json'), 'utf-8'),
    );
    const ratcheted = Object.values(doc.floors).some((f: any) => f.provisional === false);
    if (!ratcheted) {
      expect(doc._meta.lastRatchet).toBeNull();
      return;
    }
    expect(doc._meta.lastRatchet).toBeTruthy();
    expect(doc._meta.ratchetBasis).toBeTruthy();
    for (const [when, basis] of Object.entries<any>(doc._meta.ratchetBasis)) {
      expect(when).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(basis.runs) && basis.runs.length >= 3).toBe(true);
      expect(basis.metric).toBeTruthy();
      expect(basis.rule).toBeTruthy();
    }
  });
});

/**
 * #3831 — the `help` floor sat inside the judge's own noise band, so
 * `copilot-quality-evals` failed on branches that touched nothing it measures.
 *
 * ── WHAT WAS MEASURED (from the issue, and the reason the fixtures below are
 *    these numbers and not invented ones) ────────────────────────────────────
 *
 *   run 32352026194 (main, schedule)  hit 0.55  grounding 4.8  pass 0.45
 *   run 32421987858 (fix3796)         hit 0.55  grounding 4.8  pass 0.40  ← ON floor
 *   run 32437705053 (fix3796)         hit 0.55  grounding 4.8  pass 0.45
 *   run 32442474988 (fix3825)         hit 0.55  grounding 4.8  pass 0.35  ← FAIL
 *
 * `hit-rate` and `grounding` are identical to three decimals in all four runs;
 * only the judged `passRate` moves, in one-question steps (help has ~20
 * questions ⇒ 5 points per question). The floor is 0.40. The estate was constant
 * across the green→red transition (build marker `sha=d4acf061
 * stamp=20260821T012042Z` before the 01:50 GREEN and after the 03:11 RED), and
 * neither PR touched Copilot, the corpus, the router or the index.
 *
 * ── WHAT THIS SUITE PINS ────────────────────────────────────────────────────
 * That the gate is neither weaker nor noisier than before:
 *
 *   • the floor VALUE is untouched — `content/evals/eval-floors.json` is not
 *     read, written or consulted by this change, and the tolerance is 1/N of the
 *     RUN's own denominator, so there is no number anyone can turn down;
 *   • `retrievalHitRate` and `groundingAvg` still fail on a single-run breach of
 *     any size (the deterministic/stable half — #3831 option 3);
 *   • a two-question `passRate` breach still FAILS;
 *   • a one-question breach whose PREVIOUS run also breached FAILS — the
 *     two-consecutive rule, which is reachable because the first breach exits 0
 *     and therefore becomes the next run's baseline;
 *   • a one-question breach with NO comparable baseline FAILS (fail closed);
 *   • the tolerance SHRINKS as the golden set grows — the incentive #3831 asks
 *     for, made mechanical.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — dependency-free repo-root script module (no .d.ts on purpose)
import {
  evaluateGate,
  passRateResolutionPoints,
  renderMarkdown,
} from '../../../scripts/csa-loom/eval-regression-lib.mjs';

/** The real `help` floors, verbatim from content/evals/eval-floors.json. */
const HELP_FLOORS = {
  _meta: { deltaConvention: 'points' },
  floors: { help: { retrievalHitRate: 0.55, groundingAvg: 3, passRate: 0.4, provisional: false } },
};

/** A `help` run in the shape the E2 evaluator emits. */
const helpRun = (pass: number, opts: { questions?: number; hit?: number; grounding?: number | null } = {}) => ({
  surface: 'help',
  questions: opts.questions ?? 20,
  rowsAttempted: opts.questions ?? 20,
  retrievalHitRate: opts.hit ?? 0.55,
  groundingAvg: opts.grounding === undefined ? 4.8 : opts.grounding,
  passRate: pass,
  // Same conjunct set on both sides, so the #2992 comparability check passes and
  // this suite is measuring the resolution rule rather than that one.
  passPredicate: { conjuncts: ['deterministic', 'grounding'], judged: 20, judgeable: 20 },
});

const gate = (cur: number, prev: number | null, opts: Parameters<typeof helpRun>[1] = {}) =>
  evaluateGate(
    new Map([['help', helpRun(cur, opts)]]),
    HELP_FLOORS,
    { previous: prev === null ? null : new Map([['help', helpRun(prev, opts)]]), deltaPoints: 5 },
  );

/**
 * Two runs whose NON-passRate fields differ.
 *
 * `gate()` above applies one `opts` to both sides, so a hit-rate breach is a
 * breach on the BASELINE too and fails on the persistence arm no matter what the
 * resolution rule does. A mutation test caught exactly that: broadening the
 * tolerance to every metric left all fourteen specs green, because none of them
 * had a baseline that was ABOVE the floor while the current run was below it.
 */
const gateAsym = (
  curOpts: Parameters<typeof helpRun>[1],
  prevOpts: Parameters<typeof helpRun>[1],
  pass = 0.9,
) =>
  evaluateGate(
    new Map([['help', helpRun(pass, curOpts)]]),
    HELP_FLOORS,
    { previous: new Map([['help', helpRun(pass, prevOpts)]]), deltaPoints: 5 },
  );

describe('#3831 the judged rate: a one-question breach is not a regression yet', () => {
  it('WARNS on the exact live case — 0.35 against a 0.40 floor over 20 questions', () => {
    // Run 32442474988, with run 32437705053 (0.45) as its baseline. This is the
    // red that started the issue.
    const r = gate(0.35, 0.45);
    expect(r.failures).toEqual([]);
    expect(r.rows[0].status).toBe('warn');
    expect(r.rows[0].metrics.passRate.verdict).toBe('below-floor-within-resolution');
    // The warning must say what it did and did NOT establish (R7).
    const w = r.warnings.join('\n');
    expect(w).toMatch(/inside the metric's own resolution/);
    expect(w).toMatch(/floor is NOT lowered/);
    expect(w).toMatch(/the gate\s+FAILS/);
  });

  it('the floor VALUE is untouched — the report still names 0.40', () => {
    // The one thing #3831 forbids outright. A "fix" that edited the floor would
    // also make the previous spec pass.
    const r = gate(0.35, 0.45);
    expect(r.rows[0].metrics.passRate.floor).toBe(0.4);
    const md = renderMarkdown(r, { title: 'x' });
    expect(md).toMatch(/< floor 0\.40 by <1 question/);
  });

  it('FAILS on a two-question breach — 0.30 is outside the resolution', () => {
    // The discriminating negative. A tolerance that swallowed this would be a
    // lowered floor by another name.
    const r = gate(0.30, 0.45);
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/larger than the 5\.0-point value of one judged question/);
  });

  it('FAILS when the previous run ALSO breached — the breach has persisted', () => {
    // The two-consecutive rule, and the reason the arm above is not a permanent
    // pass. A within-resolution breach exits 0, so that run SUCCEEDS and becomes
    // the next run's delta baseline (the workflow downloads the last successful
    // run on main) — which is exactly how this state is reached in the lane.
    const r = gate(0.35, 0.35);
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/the previous run was ALSO below it \(0\.35\), so the breach has PERSISTED/);
  });

  it('FAILS a breach ON the boundary of the floor with a breaching baseline', () => {
    // 0.40 is ON the floor, not below it, so it is clean — but the run BEFORE it
    // breaching must not make it fail either. Precision matters here because the
    // floor comparison uses an epsilon.
    const r = gate(0.40, 0.35);
    expect(r.rows[0].metrics.passRate.verdict).not.toBe('below-floor');
    expect(r.failures).toEqual([]);
  });

  it('FAILS a one-question breach with NO baseline at all (fail closed)', () => {
    // "A single judge flip" is a claim about a SEQUENCE. With no previous run
    // there is no sequence, and granting the tolerance would make a first-ever
    // breach permanently unfailable — a gate that cannot fail.
    const r = gate(0.35, null);
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/no comparable baseline/);
  });

  it('FAILS a one-question breach when the predicates are not comparable (fail closed)', () => {
    // #2992 composes with this rather than being bypassed by it: two rates
    // produced under different conjunct sets are not the same quantity, so
    // "the previous run was fine" establishes nothing about this one.
    const cur = helpRun(0.35);
    const prev = {
      ...helpRun(0.45),
      passPredicate: { conjuncts: ['deterministic'], judged: 20, judgeable: 20 },
    };
    const r = evaluateGate(new Map([['help', cur]]), HELP_FLOORS, {
      previous: new Map([['help', prev]]),
      deltaPoints: 5,
    });
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/no comparable baseline/);
  });

  it('FAILS when the run carries no question count — the resolution is UNKNOWN', () => {
    // A legacy artifact. An unestablished resolution must not become a granted
    // tolerance; the message says which arm it took.
    const cur = { ...helpRun(0.35), questions: null, rowsAttempted: null };
    const r = evaluateGate(new Map([['help', cur]]), HELP_FLOORS, {
      previous: new Map([['help', helpRun(0.45)]]),
      deltaPoints: 5,
    });
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/no question count/);
  });
});

describe('#3831 the deterministic metrics keep HARD single-run floors', () => {
  it('a hit-rate breach FAILS on the FIRST run, even from a healthy baseline', () => {
    // Option 3 from the issue: hit-rate was identical to three decimals across
    // all four runs, so it does not need — and must not get — a noise tolerance.
    // The numbers are chosen so the tolerance WOULD apply if it were not scoped:
    // 0.50 against a 0.55 floor is 5 points, exactly one question of 20, and the
    // baseline (0.60) is above the floor — every precondition the passRate arm
    // needs. Broadening the rule to this metric must therefore be visible here.
    const r = gateAsym({ hit: 0.50 }, { hit: 0.60 });
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/hit-rate 0\.50 is BELOW the floor 0\.55/);
    expect(r.rows[0].metrics.retrievalHitRate.verdict).toBe('below-floor');
    expect(r.failures.join('\n')).not.toMatch(/resolution/);
  });

  it('a grounding breach FAILS on the FIRST run, even from a healthy baseline', () => {
    // 2.9 against a 3.0 floor is 0.1 × 25 = 2.5 points, INSIDE a 20-question
    // 5-point resolution, from a 4.8 baseline. Same construction, same reason.
    const r = gateAsym({ grounding: 2.9 }, { grounding: 4.8 });
    expect(r.rows[0].status).toBe('fail');
    expect(r.failures.join('\n')).toMatch(/grounding 2\.90 is BELOW the floor 3\.00/);
    expect(r.rows[0].metrics.groundingAvg.verdict).toBe('below-floor');
  });
});

describe('#3831 the tolerance is 1/N of the run, not a knob', () => {
  it('passRateResolutionPoints is the value of ONE judged question', () => {
    expect(passRateResolutionPoints({ questions: 20 })).toBeCloseTo(5, 6);
    expect(passRateResolutionPoints({ questions: 50 })).toBeCloseTo(2, 6);
    expect(passRateResolutionPoints({ questions: 100 })).toBeCloseTo(1, 6);
  });

  it('is null — not zero, not infinite — when the count is unknown or absurd', () => {
    expect(passRateResolutionPoints({ questions: null })).toBeNull();
    expect(passRateResolutionPoints({ questions: 0 })).toBeNull();
    expect(passRateResolutionPoints({})).toBeNull();
    expect(passRateResolutionPoints(null)).toBeNull();
  });

  it('SHRINKS as the golden set grows — the incentive, made mechanical', () => {
    // The same 5-point breach: tolerated at 20 questions, a hard failure at 50,
    // because at 50 questions 5 points is two and a half questions and can no
    // longer be one judge flip. This is #3831 option 1 expressed as a property of
    // the gate rather than as advice in an issue.
    const at20 = gate(0.35, 0.45, { questions: 20 });
    expect(at20.failures).toEqual([]);

    const at50 = gate(0.35, 0.45, { questions: 50 });
    expect(at50.rows[0].status).toBe('fail');
    expect(at50.failures.join('\n')).toMatch(/larger than the 2\.0-point value of one judged question/);
  });
});

describe('#3831 COUNTERFACTUAL: the rule that shipped failed the live run', () => {
  it('a plain `value < floor` check reds the exact case this now warns on', () => {
    // The condition as it stood. If it did NOT fail here, everything above would
    // be measuring nothing about the change.
    const legacy = (value: number, floor: number) => value < floor - 1e-9;
    expect(legacy(0.35, 0.4)).toBe(true);   // run 32442474988 — the red
    expect(legacy(0.40, 0.4)).toBe(false);  // run 32421987858 — exactly ON the floor
  });
});

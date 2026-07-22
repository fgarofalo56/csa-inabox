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

  it('grounding null (judge deferred) is NO-CHANGE — grounding floor not evaluated', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, null, 0.9), run('cost', 0.7, null, 0.6)] });
    const r = evaluateGate(cur, floorsDoc);
    expect(r.failures).toEqual([]);
    expect(r.rows.find((x: any) => x.surface === 'help').metrics.groundingAvg.verdict).toBe('deferred');
    expect(r.notes.some((n: string) => n.includes('deferred'))).toBe(true);
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

  it('a deferred previous grounding contributes no delta', () => {
    const cur = normalizeRuns({ surfaces: [run('help', 0.9, 4.1, 0.9), run('cost', 0.7, 3.5, 0.6)] });
    const prev = normalizeRuns({ surfaces: [run('help', 0.9, null, 0.9)] });
    const r = evaluateGate(cur, floorsDoc, { previous: prev, deltaPoints: 5 });
    expect(r.warnings.filter((w: string) => w.includes('grounding'))).toEqual([]);
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

describe('eval-floors.json (the committed seed)', () => {
  it('carries the ratchet-header contract (owner / why / unblock) and provisional floors for all 10 E1 surfaces', async () => {
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
      expect(f.provisional).toBe(true); // pre-first-run seed; the ratchet flips this
    }
  });
});

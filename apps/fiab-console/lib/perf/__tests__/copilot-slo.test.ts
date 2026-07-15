/** PSR-8 — Copilot turn-latency SLO: targets, objective evaluation, error-budget burn. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  copilotSloTargets, evaluateSlo, evaluateCopilotSlos,
  DEFAULT_FIRST_TOKEN_BUDGET_MS, DEFAULT_FULL_TURN_BUDGET_MS,
} from '../copilot-slo';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; });

describe('copilotSloTargets', () => {
  it('defaults to the budget-matched ceilings, default-ON', () => {
    delete process.env.LOOM_COPILOT_SLO_FIRST_TOKEN_MS;
    delete process.env.LOOM_COPILOT_SLO_FULL_TURN_MS;
    const t = copilotSloTargets();
    expect(t.find((x) => x.id === 'copilot-first-token')?.budgetMs).toBe(DEFAULT_FIRST_TOKEN_BUDGET_MS);
    expect(t.find((x) => x.id === 'copilot-full-turn')?.budgetMs).toBe(DEFAULT_FULL_TURN_BUDGET_MS);
  });
  it('honours env-tunable budgets + objective', () => {
    process.env.LOOM_COPILOT_SLO_FIRST_TOKEN_MS = '3000';
    process.env.LOOM_COPILOT_SLO_OBJECTIVE = '0.9';
    const ft = copilotSloTargets().find((x) => x.id === 'copilot-first-token')!;
    expect(ft.budgetMs).toBe(3000);
    expect(ft.objective).toBe(0.9);
  });
});

describe('evaluateSlo', () => {
  const target = { id: 'copilot-full-turn' as const, label: 'x', budgetMs: 1000, objective: 0.95, learnUrl: '', description: '' };

  it('is met with no samples (nothing has breached yet)', () => {
    const e = evaluateSlo(target, []);
    expect(e.met).toBe(true);
    expect(e.burn).toBe(0);
    expect(e.sampled).toBe(0);
  });
  it('counts turns under budget as good and computes attainment', () => {
    const e = evaluateSlo(target, [100, 200, 1000, 1500]); // 3 of 4 <= 1000
    expect(e.good).toBe(3);
    expect(e.attainment).toBeCloseTo(0.75, 5);
    expect(e.met).toBe(false); // 0.75 < 0.95
  });
  it('burn > 1 when breaching faster than the error budget allows', () => {
    // objective 0.95 → allowed fail 5%. 20% failing → burn = 0.20/0.05 = 4.
    const samples = [500, 500, 500, 500, 500, 500, 500, 500, 2000, 2000];
    const e = evaluateSlo(target, samples);
    expect(e.attainment).toBeCloseTo(0.8, 5);
    expect(e.burn).toBeCloseTo(4, 5);
    expect(e.met).toBe(false);
  });
  it('burn < 1 and met when within the error budget', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i < 98 ? 500 : 2000)); // 2% fail
    const e = evaluateSlo(target, samples);
    expect(e.met).toBe(true);
    expect(e.burn).toBeCloseTo(0.4, 5); // 0.02 / 0.05
  });
});

describe('evaluateCopilotSlos', () => {
  it('evaluates both SLOs from a per-id sample map', () => {
    const evals = evaluateCopilotSlos({ 'copilot-first-token': [100], 'copilot-full-turn': [999999] });
    const ft = evals.find((e) => e.id === 'copilot-first-token')!;
    const full = evals.find((e) => e.id === 'copilot-full-turn')!;
    expect(ft.good).toBe(1);
    expect(full.good).toBe(0); // 999999ms blows the full-turn budget
    expect(full.met).toBe(false);
  });
});

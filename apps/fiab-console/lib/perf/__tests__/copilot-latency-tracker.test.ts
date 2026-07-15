/** PSR-8 — rolling Copilot latency window + live full-turn SLO burn. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordCopilotTurn, recentFullTurnBurn, recentCopilotSloEvaluations,
  copilotLatencyWindow, _resetCopilotLatency,
} from '../copilot-latency-tracker';

const ORIG = { ...process.env };
beforeEach(() => { _resetCopilotLatency(); });
afterEach(() => { process.env = { ...ORIG }; _resetCopilotLatency(); });

describe('copilot-latency-tracker', () => {
  it('burn is 0 with no samples', () => {
    expect(recentFullTurnBurn()).toBe(0);
    expect(copilotLatencyWindow().fullTurn).toBe(0);
  });

  it('records turns and reports a healthy burn when under budget', () => {
    for (let i = 0; i < 20; i++) recordCopilotTurn(1000); // well under 30s
    expect(copilotLatencyWindow().fullTurn).toBe(20);
    expect(recentFullTurnBurn()).toBe(0); // 100% good → 0 fail rate → 0 burn
  });

  it('burn exceeds 1 when many turns blow the full-turn budget', () => {
    process.env.LOOM_COPILOT_SLO_FULL_TURN_MS = '1000';
    // 5 of 10 over the 1000ms budget → 50% fail, allowed 5% → burn = 10.
    for (let i = 0; i < 5; i++) recordCopilotTurn(500);
    for (let i = 0; i < 5; i++) recordCopilotTurn(5000);
    expect(recentFullTurnBurn()).toBeGreaterThan(1);
  });

  it('caps the rolling window at 100 turns (oldest evicted)', () => {
    for (let i = 0; i < 150; i++) recordCopilotTurn(1000);
    expect(copilotLatencyWindow().fullTurn).toBe(100);
  });

  it('evaluates both SLOs live over the window', () => {
    recordCopilotTurn(1000, 200);
    const evals = recentCopilotSloEvaluations();
    expect(evals.map((e) => e.id).sort()).toEqual(['copilot-first-token', 'copilot-full-turn']);
    expect(evals.find((e) => e.id === 'copilot-first-token')!.sampled).toBe(1);
  });
});

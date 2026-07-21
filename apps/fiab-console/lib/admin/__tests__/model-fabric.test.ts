import { describe, it, expect } from 'vitest';
import {
  decideModelFabric, compositeScore, normalizeTraffic,
  DEFAULT_FABRIC_POLICY, type ModelSignals,
} from '@/lib/admin/model-fabric';

describe('WS-7 model-fabric — pure decision service', () => {
  it('compositeScore blends eval + safety and penalizes errors; null with no signal', () => {
    expect(compositeScore({ key: 'a', currentWeight: 0 })).toBeNull();
    // eval only: 4/5 = 0.8
    expect(compositeScore({ key: 'a', evalScore: 4, currentWeight: 0 })).toBeCloseTo(0.8, 5);
    // eval + refusal: (0.6*0.8 + 0.3*0.9) / 0.9
    const c = compositeScore({ key: 'a', evalScore: 4, refusalRate: 90, currentWeight: 0 })!;
    expect(c).toBeCloseTo((0.6 * 0.8 + 0.3 * 0.9) / 0.9, 5);
    // error penalty lowers the score
    const withErr = compositeScore({ key: 'a', evalScore: 4, errorRate: 0.5, currentWeight: 0 })!;
    expect(withErr).toBeLessThan(0.8);
  });

  it('normalizeTraffic always sums to exactly 100', () => {
    expect(Object.values(normalizeTraffic({ a: 33, b: 33, c: 33 })).reduce((x, y) => x + y, 0)).toBe(100);
    expect(Object.values(normalizeTraffic({ a: 1, b: 2 })).reduce((x, y) => x + y, 0)).toBe(100);
    expect(normalizeTraffic({ a: 0, b: 0 })).toEqual({ a: 100, b: 0 });
  });

  it('PROMOTE: the live-eval winner gains traffic, the loser is demoted', () => {
    const signals: ModelSignals[] = [
      { key: 'blue', model: 'gpt-a', evalScore: 3.0, evalSamples: 8, currentWeight: 60 },
      { key: 'green', model: 'gpt-b', evalScore: 4.8, evalSamples: 8, currentWeight: 40 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals });
    expect(d.held).toBe(false);
    expect(d.changed).toBe(true);
    // winner green promoted above its 40% start; loser blue demoted below 60%.
    expect(d.newTraffic.green).toBeGreaterThan(40);
    expect(d.newTraffic.blue).toBeLessThan(60);
    expect(Object.values(d.newTraffic).reduce((a, b) => a + b, 0)).toBe(100);
    const green = d.candidates.find((c) => c.key === 'green')!;
    const blue = d.candidates.find((c) => c.key === 'blue')!;
    expect(green.action).toBe('promote');
    expect(blue.action).toBe('demote');
  });

  it('DEMOTE: a regressed model is demoted even though its raw eval is highest', () => {
    const signals: ModelSignals[] = [
      { key: 'a', model: 'stable', evalScore: 4.6, evalSamples: 8, currentWeight: 50 },
      { key: 'b', model: 'challenger', evalScore: 4.7, evalSamples: 8, regressed: true, currentWeight: 50 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals });
    expect(d.changed).toBe(true);
    const a = d.candidates.find((c) => c.key === 'a')!;
    const b = d.candidates.find((c) => c.key === 'b')!;
    // b regressed → demoted (never promoted despite the higher raw score); a wins.
    expect(b.action).toBe('demote');
    expect(a.action).toBe('promote');
    expect(d.newTraffic.b).toBeLessThan(50);
  });

  it('DEMOTE on safety: a model below the red-team refusal floor is demoted', () => {
    const signals: ModelSignals[] = [
      { key: 'safe', evalScore: 4.4, evalSamples: 8, refusalRate: 99, currentWeight: 50 },
      { key: 'leaky', evalScore: 4.9, evalSamples: 8, refusalRate: 60, currentWeight: 50 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals });
    const leaky = d.candidates.find((c) => c.key === 'leaky')!;
    expect(leaky.action).toBe('demote'); // refusal 60% < floor 80%
    expect(d.candidates.find((c) => c.key === 'safe')!.action).toBe('promote');
  });

  it('HYSTERESIS: holds inside the cooldown window (no actuation)', () => {
    const signals: ModelSignals[] = [
      { key: 'blue', evalScore: 3.0, evalSamples: 8, currentWeight: 60 },
      { key: 'green', evalScore: 4.8, evalSamples: 8, currentWeight: 40 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals, msSinceLastActuation: 1000 });
    expect(d.held).toBe(true);
    expect(d.heldReason).toBe('cooldown');
    expect(d.changed).toBe(false);
    expect(d.newTraffic).toEqual(d.currentTraffic);
    // Past the cooldown it would actuate.
    const after = decideModelFabric({ endpoint: 'ep1', signals, msSinceLastActuation: DEFAULT_FABRIC_POLICY.cooldownMs + 1 });
    expect(after.changed).toBe(true);
  });

  it('HYSTERESIS: holds when the winner does not beat the leader by the margin', () => {
    const signals: ModelSignals[] = [
      { key: 'a', evalScore: 4.5, evalSamples: 8, currentWeight: 50 },
      { key: 'b', evalScore: 4.55, evalSamples: 8, currentWeight: 50 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals });
    expect(d.held).toBe(true);
    expect(d.heldReason).toBe('no-margin');
    expect(d.changed).toBe(false);
  });

  it('HYSTERESIS: holds when the winner has too few eval samples', () => {
    const signals: ModelSignals[] = [
      { key: 'a', evalScore: 4.9, evalSamples: 2, currentWeight: 40 }, // below minEvalSamples
      { key: 'b', evalScore: 3.0, evalSamples: 8, currentWeight: 60 },
    ];
    const d = decideModelFabric({ endpoint: 'ep1', signals });
    expect(d.held).toBe(true);
    expect(d.heldReason).toBe('insufficient-data');
  });

  it('holds with a single candidate (nothing to split)', () => {
    const d = decideModelFabric({ endpoint: 'ep1', signals: [{ key: 'only', evalScore: 5, evalSamples: 8, currentWeight: 100 }] });
    expect(d.held).toBe(true);
    expect(d.heldReason).toBe('single-candidate');
  });
});

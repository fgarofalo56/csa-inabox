import { describe, it, expect } from 'vitest';
import { PhaseTimer } from '../phase-timer';

/** Deterministic clock: returns each value in sequence, holding the last. */
function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('PhaseTimer', () => {
  it('records elapsed-since-mark into a phase on lap and resets the mark', () => {
    // construct@0, lap@10 → classify=10, lap@25 → prompt-build=15
    const t = new PhaseTimer(fakeClock([0, 10, 25]));
    t.lap('classify');
    t.lap('prompt-build');
    expect(t.timings()).toEqual([
      { phase: 'classify', ms: 10 },
      { phase: 'prompt-build', ms: 15 },
    ]);
  });

  it('accumulates explicit durations with add (independent of the mark)', () => {
    const t = new PhaseTimer(fakeClock([0]));
    t.add('llm', 100);
    t.add('llm', 50);
    t.add('tools', 30);
    expect(t.timings()).toEqual([
      { phase: 'llm', ms: 150 },
      { phase: 'tools', ms: 30 },
    ]);
    expect(t.total()).toBe(180);
  });

  it('preserves first-seen phase order and rounds to whole ms', () => {
    const t = new PhaseTimer(fakeClock([0]));
    t.add('classify', 1.4);
    t.add('llm', 2.6);
    t.add('classify', 0.2);
    expect(t.timings()).toEqual([
      { phase: 'classify', ms: 2 },
      { phase: 'llm', ms: 3 },
    ]);
  });

  it('ignores negative / non-finite durations on add', () => {
    const t = new PhaseTimer(fakeClock([0]));
    t.add('llm', -5);
    t.add('llm', NaN);
    t.add('llm', 10);
    expect(t.timings()).toEqual([{ phase: 'llm', ms: 10 }]);
  });
});

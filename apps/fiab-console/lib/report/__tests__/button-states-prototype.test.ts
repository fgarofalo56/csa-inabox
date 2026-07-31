/**
 * `sanitizeButtonStates` must build its map on a null-prototype target.
 *
 * CodeQL js/remote-property-injection flagged five writes in
 * report-definition-sanitizer.ts. Four write into `safeRecord()`
 * (`Object.create(null)`) and are false positives — the query does not model
 * that helper as a sanitiser. The fifth, `sanitizeButtonStates`, was the one map
 * builder in the file still using a plain `{}`.
 *
 * It was NOT exploitable: `BUTTON_STATES.has(k)` gates every write against a
 * closed four-value allowlist that cannot contain `__proto__`. The defect was
 * that the guarantee rested entirely on that allowlist staying closed, while
 * every sibling sanitizer here is safe by construction. Widening BUTTON_STATES
 * or reordering the guard would have silently reintroduced the sink.
 *
 * These tests pin BOTH halves: the allowlist still rejects hostile keys, AND the
 * container is prototype-free so a future lapse in the allowlist cannot reach
 * Object.prototype.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeElements } from '../report-definition-sanitizer';

/** A button element carrying the supplied `states` map. */
function buttonWith(states: unknown) {
  return [
    {
      id: 'btn-1',
      kind: 'button',
      layout: { x: 0, y: 0, w: 100, h: 40, unit: 'px' },
      states,
    },
  ];
}

/** The `states` map off the first sanitized element, if any. */
function statesOf(raw: unknown): Record<string, unknown> | undefined {
  const els = sanitizeElements(raw) as Array<{ states?: Record<string, unknown> }> | undefined;
  return els?.[0]?.states;
}

describe('sanitizeButtonStates — prototype safety', () => {
  it('keeps legitimate button states', () => {
    const states = statesOf(buttonWith({ hover: { fill: '#112233' } }));
    expect(states?.hover).toEqual({ fill: '#112233' });
  });

  it('drops keys outside the BUTTON_STATES allowlist', () => {
    // `__proto__` is not one of default/hover/press/disabled, so the guard skips
    // it. Asserted separately from the prototype check below so a regression in
    // EITHER layer fails a named test rather than both hiding behind one assert.
    const states = statesOf(buttonWith({ __proto__: { fill: '#000000' }, notAState: { fill: '#ffffff' } }));
    expect(states).toBeUndefined();
  });

  it('does not pollute Object.prototype', () => {
    statesOf(buttonWith({ constructor: { fill: '#000000' }, __proto__: { fill: '#000000' } }));
    expect(({} as Record<string, unknown>).fill).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('fill');
  });

  it('builds the map on a null-prototype container', () => {
    // The structural half. Reverting `safeRecord()` to `{}` turns THIS red while
    // the allowlist tests above stay green — which is the point: they cover
    // different failure modes.
    const states = statesOf(buttonWith({ hover: { fill: '#112233' } }));
    expect(states).toBeDefined();
    expect(Object.getPrototypeOf(states as object)).toBeNull();
  });
});

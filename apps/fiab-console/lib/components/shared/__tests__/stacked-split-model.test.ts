/**
 * StackedSplit pure model + keyboard contract. Each assertion names the value
 * that would break it (assertion-design.md). Fixtures use DISTINCT, non-equal
 * sizes so a swapped-operand or wrong-donor bug cannot hide behind symmetry.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultState, fitTarget, pxToShares, reflow, resolveState, serializeState, setCollapsed,
  type PaneSpecLite, type ReflowItem,
} from '../stacked-split-model';
import { resolveResizeKey } from '../resize-keyboard';

const canvas = (px: number, min = 120): ReflowItem => ({ id: 'canvas', role: 'canvas', min, px });
const dock = (id: string, px: number, min = 80): ReflowItem => ({ id, role: 'dock', min, px });
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('reflow — grow', () => {
  it('takes from docks before the canvas, proportional to size, capped at each floor', () => {
    // C grows 200 -> 300 (need 100). A=300 (room 220), B=100 (room 20).
    // Round 1: A gives min(220, 100*300/400=75)=75, B gives min(20, 25)=20 (floor);
    // round 2: A gives the remaining 5. => A=220, B=80, canvas UNTOUCHED at 400.
    const out = reflow([canvas(400), dock('A', 300), dock('B', 100), dock('C', 200)], 'C', 300, null);
    // Breaks if canvas gives first (canvas would be 300, A 300).
    expect(out.canvas).toBe(400);
    expect(out.A).toBeCloseTo(220, 6);
    expect(out.B).toBeCloseTo(80, 6);
    expect(out.C).toBeCloseTo(300, 6);
  });

  it('splits the take proportionally to current size when no dock hits its floor', () => {
    // A=300, B=100, need 40 => A gives 30, B gives 10 (a 3:1 split, NOT 20/20).
    const out = reflow([canvas(400), dock('A', 300), dock('B', 100, 10), dock('C', 200)], 'C', 240, null);
    expect(out.A).toBeCloseTo(270, 6);
    expect(out.B).toBeCloseTo(90, 6);
  });

  it('falls through to the canvas only once every dock sibling is at its floor', () => {
    // B already at floor (80); A is the only dock with room (20). Need 100:
    // A gives 20, canvas gives the other 80.
    const out = reflow([canvas(400), dock('A', 100), dock('B', 80), dock('C', 200)], 'C', 300, null);
    expect(out.A).toBe(80);
    expect(out.B).toBe(80);
    expect(out.canvas).toBeCloseTo(320, 6);
    expect(out.C).toBeCloseTo(300, 6);
  });

  it('never drops the canvas below its floor even when asked for far more', () => {
    const out = reflow([canvas(400), dock('A', 100), dock('B', 80)], 'A', 5000, null);
    // Canvas gives exactly 400-120=280 (B gives 0): A = 100+280.
    expect(out.canvas).toBe(120);
    expect(out.B).toBe(80);
    expect(out.A).toBe(380);
  });

  it('End (Infinity) takes everything the siblings can give and conserves the total', () => {
    const items = [canvas(400), dock('A', 100), dock('B', 180)];
    const out = reflow(items, 'A', Number.POSITIVE_INFINITY, null);
    expect(out.canvas).toBe(120);
    expect(out.B).toBe(80);
    expect(sum(out)).toBeCloseTo(680, 6);
    expect(out.A).toBeCloseTo(480, 6);
  });

  it('a canvas target only takes from docks, never below their floors', () => {
    const out = reflow([canvas(200), dock('A', 150), dock('B', 90)], 'canvas', 1000, null);
    expect(out.A).toBe(80);
    expect(out.B).toBe(80);
    expect(out.canvas).toBeCloseTo(200 + 70 + 10, 6);
  });
});

describe('reflow — shrink', () => {
  it('stops at the floor and hands the freed space to the recipient', () => {
    const out = reflow([dock('A', 300), dock('B', 100)], 'A', 10, 'B');
    // Breaks if the floor is ignored (A would be 10) or the space is lost (B != 320).
    expect(out.A).toBe(80);
    expect(out.B).toBe(320);
  });

  it('is refused (sizes unchanged) with no recipient', () => {
    const out = reflow([dock('A', 300), dock('B', 100)], 'A', 100, null);
    expect(out).toEqual({ A: 300, B: 100 });
  });
});

describe('fitTarget', () => {
  it('caps at 70% of the available stack', () => {
    expect(fitTarget(1000, 500, 80)).toBeCloseTo(350, 6); // breaks if uncapped (1000) or 100% (500)
  });
  it('returns the content extent when it is under the cap and over the floor', () => {
    expect(fitTarget(200, 500, 80)).toBe(200);
  });
  it('never goes below the floor', () => {
    expect(fitTarget(10, 500, 80)).toBe(80);
  });
});

describe('pxToShares', () => {
  it('keeps the expanded share-sum constant and the px ratio', () => {
    const out = pxToShares({ a: 300, b: 100 }, { a: 2, b: 2 });
    expect(out.a).toBeCloseTo(3, 6);
    expect(out.b).toBeCloseTo(1, 6);
  });
});

describe('collapse', () => {
  it('collapse then expand restores the exact prior share (no recompute)', () => {
    const start = { v: 1 as const, shares: { a: 2.5, b: 0.7 }, collapsed: { a: false, b: false } };
    const collapsed = setCollapsed(start, 'b', true);
    expect(collapsed.collapsed.b).toBe(true);
    expect(collapsed.shares.b).toBe(0.7); // breaks if collapsing zeroes/rewrites the share
    const back = setCollapsed(collapsed, 'b', false);
    expect(back.shares).toEqual({ a: 2.5, b: 0.7 });
    expect(back.collapsed.b).toBe(false);
  });
});

describe('persistence', () => {
  const panes: PaneSpecLite[] = [
    { id: 'canvas', role: 'canvas', defaultFlex: 3 },
    { id: 'val', defaultFlex: 1.5 },
    { id: 'out', defaultCollapsed: true },
  ];

  it('defaults: defaultFlex, 1 when absent, defaultCollapsed only for collapsible panes', () => {
    const d = defaultState([...panes, { id: 'c2', role: 'canvas', defaultCollapsed: true }]);
    expect(d.shares).toEqual({ canvas: 3, val: 1.5, out: 1, c2: 1 });
    expect(d.collapsed).toEqual({ canvas: false, val: false, out: true, c2: false });
  });

  it('unknown id (pane added later) falls back to ITS defaults, others keep persisted values', () => {
    const raw = JSON.stringify({ v: 1, shares: { canvas: 9, val: 2 }, collapsed: { val: true } });
    const { state } = resolveState(panes, raw);
    expect(state.shares).toEqual({ canvas: 9, val: 2, out: 1 });
    expect(state.collapsed).toEqual({ canvas: false, val: true, out: true }); // out: defaultCollapsed
  });

  it('stale persisted ids are ignored for state but survive a re-save', () => {
    const raw = JSON.stringify({ v: 1, shares: { canvas: 9, val: 2, gone: 4 }, collapsed: { gone: true } });
    const { state, extras } = resolveState(panes, raw);
    expect(Object.keys(state.shares)).not.toContain('gone');
    expect(state.shares.canvas).toBe(9); // other panes NOT discarded
    expect(extras.shares).toEqual({ gone: 4 });
    const saved = JSON.parse(serializeState(state, extras));
    expect(saved.shares.gone).toBe(4); // positive pair: the stale entry is kept for the future pane
    expect(saved.shares.canvas).toBe(9);
    expect(saved.collapsed.gone).toBe(true);
  });

  it.each([
    ['not JSON', '{nope'],
    ['JSON null', 'null'],
    ['a string', '"x"'],
    ['wrong version', JSON.stringify({ v: 2, shares: { canvas: 99 }, collapsed: {} })],
    ['missing version', JSON.stringify({ shares: { canvas: 99 } })],
  ])('corrupt input (%s) yields defaults and does not throw', (_n, raw) => {
    const { state } = resolveState(panes, raw);
    expect(state).toEqual(defaultState(panes)); // canvas stays 3, never 99
  });

  it('rejects non-positive / non-finite / non-numeric shares per pane', () => {
    const raw = '{"v":1,"shares":{"canvas":-1,"val":"7","out":0},"collapsed":{}}';
    expect(resolveState(panes, raw).state.shares).toEqual({ canvas: 3, val: 1.5, out: 1 });
  });

  it('a non-collapsible pane cannot be restored as collapsed', () => {
    const raw = JSON.stringify({ v: 1, shares: {}, collapsed: { canvas: true } });
    expect(resolveState(panes, raw).state.collapsed.canvas).toBe(false);
  });

  it('round-trips a state through serialize/resolve', () => {
    const s = { v: 1 as const, shares: { canvas: 2.25, val: 0.5, out: 4 }, collapsed: { canvas: false, val: true, out: false } };
    expect(resolveState(panes, serializeState(s, { shares: {}, collapsed: {} })).state).toEqual(s);
  });
});

describe('resolveResizeKey', () => {
  const v = (key: string, shiftKey = false) => resolveResizeKey({ key, shiftKey }, 'vertical');
  it('Arrow = 24, Shift+Arrow = 96, signed by direction', () => {
    expect(v('ArrowDown')).toEqual({ kind: 'delta', px: 24 });
    expect(v('ArrowUp')).toEqual({ kind: 'delta', px: -24 });
    expect(v('ArrowDown', true)).toEqual({ kind: 'delta', px: 96 });
    expect(v('ArrowUp', true)).toEqual({ kind: 'delta', px: -96 });
  });
  it('PageUp/PageDown = +/-96, Home/End = min/max', () => {
    expect(v('PageUp')).toEqual({ kind: 'delta', px: 96 });
    expect(v('PageDown')).toEqual({ kind: 'delta', px: -96 });
    expect(v('Home')).toEqual({ kind: 'edge', edge: 'min' });
    expect(v('End')).toEqual({ kind: 'edge', edge: 'max' });
  });
  it('horizontal stacks use Left/Right and ignore Up/Down', () => {
    expect(resolveResizeKey({ key: 'ArrowRight' }, 'horizontal')).toEqual({ kind: 'delta', px: 24 });
    expect(resolveResizeKey({ key: 'ArrowDown' }, 'horizontal')).toBeNull();
    expect(resolveResizeKey({ key: 'ArrowLeft' }, 'vertical')).toBeNull();
  });
  it('ignores Enter/Space (those belong to the header chevron) and modifier chords', () => {
    expect(v('Enter')).toBeNull();
    expect(v(' ')).toBeNull();
    expect(resolveResizeKey({ key: 'ArrowDown', altKey: true }, 'vertical')).toBeNull();
  });
});

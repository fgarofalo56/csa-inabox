/**
 * Regression test for the org-reports client render loop (PR #1882 → #1888 → #1893).
 *
 * The report-canvas `useElementSize` hook drives every SVG visual off a
 * ResizeObserver. Two failure modes have to stay closed:
 *
 *  1. Sub-pixel jitter (253.4 ↔ 253.6) — the original guard rounded to an
 *     integer BEFORE comparing, so the committed value flipped a whole pixel
 *     every notification and the "same-value" bail never matched (#1888 added
 *     the raw-epsilon compare).
 *  2. A GENUINE size oscillation (a scrollbar toggling the width ~15px each
 *     frame, or an SVG that nudges its own container) — every notification is a
 *     real >epsilon change, so the epsilon guard commits, React relayouts, and
 *     the observer re-fires synchronously in the SAME frame → unbounded
 *     re-entry → the tab freezes (confirmed live on rev 0000226). #1893 fixes
 *     this by rAF-debouncing: a burst of notifications coalesces into ONE commit
 *     per animation frame, and a `committing` flag drops the notifications our
 *     own commit's relayout triggers.
 *
 * These tests drive a controllable ResizeObserver mock AND a controllable
 * requestAnimationFrame queue so they can flush the debounce deterministically,
 * then assert the hook commits state ONLY on a real (> sub-pixel) size change,
 * exactly once per frame — never on a same-value or sub-pixel-jitter burst.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElementSize } from '../report-canvas';

type ROCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;

/** Captures the observer callback so a test can push notifications by hand. */
class ControllableResizeObserver {
  static callbacks: ROCallback[] = [];
  private cb: ROCallback;
  constructor(cb: ROCallback) {
    this.cb = cb;
    ControllableResizeObserver.callbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  /** Fire every live observer with a single-entry contentRect. */
  static emit(width: number, height: number) {
    for (const cb of ControllableResizeObserver.callbacks) {
      cb([{ contentRect: { width, height } }]);
    }
  }
}

const originalRO = globalThis.ResizeObserver;
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

/**
 * Controllable rAF: queue callbacks and run them on demand. The hook schedules
 * both the debounced measure AND the `committing`-flag release via rAF, so a
 * test must drain the queue to advance a frame. Draining re-runs any callbacks a
 * flushed callback itself schedules (the commit → release-guard chain).
 */
const rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
function installRAF() {
  rafQueue.clear();
  rafSeq = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.set(rafSeq, cb);
    return rafSeq;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue.delete(id);
  }) as typeof cancelAnimationFrame;
}
/** Advance frames until the queue is idle, inside act() so React flushes. */
function flushRAF() {
  act(() => {
    let guard = 0;
    while (rafQueue.size > 0) {
      if ((guard += 1) > 100) throw new Error('rAF queue never drained — real loop?');
      const [[id, cb]] = rafQueue;
      rafQueue.delete(id);
      cb(performance.now?.() ?? 0);
    }
  });
}

/** Render the hook against a real attached element so clientWidth/Height read 0. */
function renderSize() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    const [ref, size] = useElementSize<HTMLDivElement>();
    // Attach the ref so the effect's `ref.current` is non-null and observes.
    React.useLayoutEffect(() => {
      const el = document.createElement('div');
      (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }, [ref]);
    return size;
  });
  // Drain the initial synchronous commit's guard-release frame so the first
  // real emit isn't swallowed by the `committing` flag.
  flushRAF();
  return { hook, getRenders: () => renders };
}

describe('useElementSize render-loop guard', () => {
  beforeEach(() => {
    ControllableResizeObserver.callbacks = [];
    (globalThis as any).ResizeObserver = ControllableResizeObserver;
    installRAF();
  });
  afterEach(() => {
    (globalThis as any).ResizeObserver = originalRO;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    vi.restoreAllMocks();
  });

  it('commits a real resize', () => {
    const { hook } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    flushRAF();
    expect(hook.result.current).toEqual({ width: 800, height: 600 });
  });

  it('does NOT re-render on an identical repeat notification', () => {
    const { hook, getRenders } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    flushRAF();
    const settled = getRenders();
    // Same size delivered 5 more times — the classic RO re-notification.
    act(() => {
      for (let i = 0; i < 5; i += 1) ControllableResizeObserver.emit(800, 600);
    });
    flushRAF();
    expect(getRenders()).toBe(settled);
    expect(hook.result.current).toEqual({ width: 800, height: 600 });
  });

  it('does NOT re-render on sub-pixel jitter across a .5 boundary (the loop)', () => {
    const { hook, getRenders } = renderSize();
    act(() => ControllableResizeObserver.emit(253.4, 140.4));
    flushRAF();
    const settled = getRenders();
    // Wobble 253.4 ↔ 253.6 rounds to 253 ↔ 254 — the old guard flipped state
    // every time. The epsilon guard must swallow all of it.
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        ControllableResizeObserver.emit(253.6, 140.6);
        ControllableResizeObserver.emit(253.4, 140.4);
      }
    });
    flushRAF();
    expect(getRenders()).toBe(settled);
    // Committed value stays at the first-seen rounded size.
    expect(hook.result.current).toEqual({ width: 253, height: 140 });
  });

  it('coalesces a burst of real changes into a single commit per frame', () => {
    const { hook, getRenders } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    flushRAF();
    const settled = getRenders();
    // A genuine oscillation: 20 alternating >epsilon notifications in ONE frame.
    // Without the rAF-debounce each would commit + relayout (the freeze); with it
    // only the LAST pending value commits, so exactly one re-render happens.
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        ControllableResizeObserver.emit(900, 600); // scrollbar gone (+width)
        ControllableResizeObserver.emit(885, 600); // scrollbar back (-15px)
      }
    });
    flushRAF();
    expect(getRenders()).toBe(settled + 1);
    expect(hook.result.current).toEqual({ width: 885, height: 600 });
  });

  it('still commits when a change accumulates past the epsilon', () => {
    const { hook } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    flushRAF();
    // A genuine growth well beyond sub-pixel must commit.
    act(() => ControllableResizeObserver.emit(801, 620));
    flushRAF();
    expect(hook.result.current).toEqual({ width: 801, height: 620 });
  });
});

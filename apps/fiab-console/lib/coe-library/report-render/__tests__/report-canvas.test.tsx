/**
 * Regression test for the org-reports client render loop (PR #1882 follow-up).
 *
 * The report-canvas `useElementSize` hook drives every SVG visual off a
 * ResizeObserver. The original guard rounded `contentRect` to an integer BEFORE
 * comparing, so a sub-pixel layout wobble that straddled a .5 boundary
 * (253.4 ↔ 253.6) flipped the committed integer by a whole pixel every
 * notification — the "same-value" bail never matched, and the resulting
 * re-render → relayout → re-observe loop pegged the browser tab's CPU
 * (content scripts timed out; the page never reached document_idle).
 *
 * These tests drive a controllable ResizeObserver mock and assert that the
 * hook commits state ONLY on a real (> sub-pixel) size change — never on a
 * same-value or sub-pixel-jitter notification.
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
  return { hook, getRenders: () => renders };
}

describe('useElementSize render-loop guard', () => {
  beforeEach(() => {
    ControllableResizeObserver.callbacks = [];
    (globalThis as any).ResizeObserver = ControllableResizeObserver;
  });
  afterEach(() => {
    (globalThis as any).ResizeObserver = originalRO;
    vi.restoreAllMocks();
  });

  it('commits a real resize', () => {
    const { hook } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    expect(hook.result.current).toEqual({ width: 800, height: 600 });
  });

  it('does NOT re-render on an identical repeat notification', () => {
    const { hook, getRenders } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    const settled = getRenders();
    // Same size delivered 5 more times — the classic RO re-notification.
    act(() => {
      for (let i = 0; i < 5; i += 1) ControllableResizeObserver.emit(800, 600);
    });
    expect(getRenders()).toBe(settled);
    expect(hook.result.current).toEqual({ width: 800, height: 600 });
  });

  it('does NOT re-render on sub-pixel jitter across a .5 boundary (the loop)', () => {
    const { hook, getRenders } = renderSize();
    act(() => ControllableResizeObserver.emit(253.4, 140.4));
    const settled = getRenders();
    // Wobble 253.4 ↔ 253.6 rounds to 253 ↔ 254 — the old guard flipped state
    // every time. The epsilon guard must swallow all of it.
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        ControllableResizeObserver.emit(253.6, 140.6);
        ControllableResizeObserver.emit(253.4, 140.4);
      }
    });
    expect(getRenders()).toBe(settled);
    // Committed value stays at the first-seen rounded size.
    expect(hook.result.current).toEqual({ width: 253, height: 140 });
  });

  it('still commits when jitter accumulates past the epsilon', () => {
    const { hook } = renderSize();
    act(() => ControllableResizeObserver.emit(800, 600));
    // A genuine growth well beyond sub-pixel must commit.
    act(() => ControllableResizeObserver.emit(801, 620));
    expect(hook.result.current).toEqual({ width: 801, height: 620 });
  });
});

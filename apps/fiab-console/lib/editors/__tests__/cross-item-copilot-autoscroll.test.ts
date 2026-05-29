/**
 * Unit tests for the Copilot step-stream autoscroll guard.
 *
 * This guard is the load-bearing half of the "/copilot constant flicker" fix:
 * the old code fired a smooth scrollIntoView on every streamed SSE step, which
 * stacked animations and bubbled to the outer page scroll, producing a constant
 * screen flicker during a run. shouldAutoScroll() restricts the (now instant,
 * inner-container-only) scroll to the case where the user is already at the
 * bottom, so streaming no longer fights a user who scrolled up to read history.
 *
 * Pure predicate → testable in the repo's `node` vitest env (no DOM needed).
 */
import { describe, it, expect } from 'vitest';
import { shouldAutoScroll } from '../cross-item-copilot-editor';

describe('shouldAutoScroll', () => {
  it('auto-scrolls when pinned to the bottom', () => {
    // scrollTop === scrollHeight - clientHeight → exactly at bottom.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it('auto-scrolls when within the near-bottom threshold (default 120px)', () => {
    // 60px from the bottom → still considered "near bottom".
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 740, clientHeight: 200 })).toBe(true);
  });

  it('does NOT auto-scroll when the user has scrolled up beyond the threshold', () => {
    // 300px from the bottom → user is reading history; leave them be.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })).toBe(false);
  });

  it('treats the exact threshold boundary as not-near (strict <)', () => {
    // distance === threshold (120) → predicate uses strict `<`, so false.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 680, clientHeight: 200 })).toBe(false);
    // distance === threshold - 1 → true.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 681, clientHeight: 200 })).toBe(true);
  });

  it('respects a custom threshold', () => {
    // 300px from bottom, threshold 400 → near.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }, 400)).toBe(true);
    // 300px from bottom, threshold 50 → far.
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }, 50)).toBe(false);
  });

  it('handles a non-scrollable (short) container as near-bottom', () => {
    // content shorter than viewport → distance is negative → always near.
    expect(shouldAutoScroll({ scrollHeight: 150, scrollTop: 0, clientHeight: 200 })).toBe(true);
  });
});

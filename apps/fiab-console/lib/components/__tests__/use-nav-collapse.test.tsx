/**
 * #2673 — the nav rail must collapse on a narrow viewport.
 *
 * The bug was an ABSENCE: `AppShell` had a manual toggle and localStorage and
 * no viewport logic at all, so at 900px the rail stayed expanded, labels wrapped
 * mid-word, and the content pane overlapped it.
 *
 * These tests pin the whole decision table rather than just "does it collapse",
 * because the two ways a fix like this regresses are subtler than the original
 * bug:
 *
 *   - the viewport starts overriding the operator's explicit choice, so the
 *     toggle button visibly does nothing;
 *   - the operator's pin becomes permanent, so the responsive behaviour is
 *     present in the code and never executes — the exact shape of the original
 *     defect, reintroduced one level up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNavCollapse, NAV_COLLAPSE_KEY, NAV_AUTO_COLLAPSE_PX } from '../use-nav-collapse';

/** A controllable matchMedia: jsdom's returns matches:false and never changes. */
function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.delete(fn); },
    addListener: (fn: (e: MediaQueryListEvent) => void) => { listeners.add(fn); },
    removeListener: (fn: (e: MediaQueryListEvent) => void) => { listeners.delete(fn); },
    dispatchEvent: () => true,
    onchange: null,
  };
  const query = vi.fn(() => mql);
  Object.defineProperty(window, 'matchMedia', { value: query, writable: true, configurable: true });
  /** Simulate the viewport crossing the breakpoint. */
  const cross = (matches: boolean) => {
    mql.matches = matches;
    act(() => { listeners.forEach((fn) => fn({ matches } as MediaQueryListEvent)); });
  };
  return { cross, query, listenerCount: () => listeners.size };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('useNavCollapse — viewport', () => {
  it('collapses when the viewport is below the breakpoint', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(true);
  });

  it('stays expanded on a wide viewport', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(false);
  });

  it('queries the documented breakpoint', () => {
    const { query } = installMatchMedia(false);
    renderHook(() => useNavCollapse());
    expect(query).toHaveBeenCalledWith(`(max-width: ${NAV_AUTO_COLLAPSE_PX - 1}px)`);
  });

  it('collapses when the viewport SHRINKS past the breakpoint mid-session', () => {
    const { cross } = installMatchMedia(false);
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(false);
    cross(true);
    expect(result.current.collapsed).toBe(true);
  });

  it('unsubscribes on unmount (no listener leak across route changes)', () => {
    const { listenerCount } = installMatchMedia(false);
    const { unmount } = renderHook(() => useNavCollapse());
    expect(listenerCount()).toBe(1);
    unmount();
    expect(listenerCount()).toBe(0);
  });
});

describe('useNavCollapse — the operator pin', () => {
  it('lets the operator EXPAND a viewport-collapsed rail', () => {
    // The half a naive `!pref` toggle breaks: pref starts null, the viewport
    // forced collapsed, so `!pref` would be `true` — collapsing an already
    // collapsed rail and appearing to do nothing.
    installMatchMedia(true);
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
  });

  it('lets the operator collapse a wide-viewport rail', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useNavCollapse());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(NAV_COLLAPSE_KEY)).toBe('1');
  });

  it('restores a pinned choice on mount without the viewport overriding it', () => {
    localStorage.setItem(NAV_COLLAPSE_KEY, '1');
    installMatchMedia(false);                    // wide — would otherwise expand
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(true);
  });

  it('does NOT clear a restored pin on mount', () => {
    // Mount reads the media query; if that read went through the same path as a
    // breakpoint CROSSING it would wipe the preference the operator just had
    // restored, one render after restoring it.
    localStorage.setItem(NAV_COLLAPSE_KEY, '0');
    installMatchMedia(true);
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(NAV_COLLAPSE_KEY)).toBe('0');
  });

  it('hands control back to the viewport when the breakpoint is crossed', () => {
    // Without this the pin is permanent and the responsive behaviour is present
    // in the code but never runs again — the original bug, one level up.
    const { cross } = installMatchMedia(false);
    const { result } = renderHook(() => useNavCollapse());
    act(() => result.current.toggle());          // pin collapsed on a wide screen
    expect(result.current.collapsed).toBe(true);

    cross(true);                                  // shrink
    cross(false);                                 // grow back
    expect(result.current.collapsed).toBe(false); // viewport wins again
    expect(localStorage.getItem(NAV_COLLAPSE_KEY)).toBeNull();
  });
});

describe('useNavCollapse — hostile environments', () => {
  it('survives storage being unavailable (private mode / disabled cookies)', () => {
    installMatchMedia(false);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { result } = renderHook(() => useNavCollapse());
      expect(result.current.collapsed).toBe(false);
      act(() => result.current.toggle());
      expect(result.current.collapsed).toBe(true);   // still works in-session
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('falls back to addListener when addEventListener is absent (Safari < 14)', () => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const mql: any = {
      matches: false,
      addListener: (fn: (e: MediaQueryListEvent) => void) => { listeners.add(fn); },
      removeListener: (fn: (e: MediaQueryListEvent) => void) => { listeners.delete(fn); },
    };
    Object.defineProperty(window, 'matchMedia', { value: () => mql, writable: true, configurable: true });

    const { result, unmount } = renderHook(() => useNavCollapse());
    expect(listeners.size).toBe(1);
    mql.matches = true;
    act(() => { listeners.forEach((fn) => fn({ matches: true } as MediaQueryListEvent)); });
    expect(result.current.collapsed).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('does not throw when matchMedia is missing entirely', () => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    const { result } = renderHook(() => useNavCollapse());
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
  });
});

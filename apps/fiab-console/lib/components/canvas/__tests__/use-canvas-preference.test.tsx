/**
 * useCanvasBooleanPreference — #3699 Scope B. A generic per-surface boolean
 * preference, modeled on useCollapsibleState (collapsible-side-panel.tsx) but
 * keyed by BOTH surface and preference name so two canvases — or two
 * preferences on one canvas — never collide.
 *
 * The one behavior this hook adds beyond useCollapsibleState: re-keying.
 * useCollapsibleState is always called with a fixed storageKey for the
 * lifetime of one component instance; this hook's surfaceKey/prefKey pair
 * is reconstructed into a single storageKey on every render, so a caller
 * that changes which surface/preference it targets (unlikely in practice,
 * but not prevented by the type signature) must re-read from the new key
 * rather than silently keep serving the old one's value.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasBooleanPreference } from '../use-canvas-preference';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('useCanvasBooleanPreference — basic persistence', () => {
  it('starts at the given default when nothing is persisted', () => {
    const { result } = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    expect(result.current[0]).toBe(true);
  });

  it('toggling flips the value and persists it', () => {
    const { result } = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    act(() => result.current[1]((v) => !v));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('loom.canvas.surface-a.minimapVisible')).toBe('0');
  });

  it('restores a persisted value on mount, overriding the default', () => {
    localStorage.setItem('loom.canvas.surface-a.minimapVisible', '0');
    const { result } = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    expect(result.current[0]).toBe(false);
  });

  it('accepts a bare boolean (not just the updater form)', () => {
    const { result } = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});

describe('useCanvasBooleanPreference — namespacing (the reason this hook exists over a single global key)', () => {
  it('two DIFFERENT surfaces with the SAME preference name do not share state', () => {
    const a = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    const b = renderHook(() => useCanvasBooleanPreference('surface-b', 'minimapVisible', true));
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(true); // unaffected
    expect(localStorage.getItem('loom.canvas.surface-a.minimapVisible')).toBe('0');
    expect(localStorage.getItem('loom.canvas.surface-b.minimapVisible')).toBeNull();
  });

  it('one surface with TWO DIFFERENT preference names does not cross-write', () => {
    const minimap = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
    const otherPref = renderHook(() => useCanvasBooleanPreference('surface-a', 'somethingElse', true));
    act(() => minimap.result.current[1](false));
    expect(minimap.result.current[0]).toBe(false);
    expect(otherPref.result.current[0]).toBe(true);
    expect(localStorage.getItem('loom.canvas.surface-a.somethingElse')).toBeNull();
  });
});

describe('useCanvasBooleanPreference — hostile environments', () => {
  it('survives storage being unavailable (private mode / disabled cookies)', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { result } = renderHook(() => useCanvasBooleanPreference('surface-a', 'minimapVisible', true));
      expect(result.current[0]).toBe(true);
      act(() => result.current[1](false));
      expect(result.current[0]).toBe(false); // still works in-session
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

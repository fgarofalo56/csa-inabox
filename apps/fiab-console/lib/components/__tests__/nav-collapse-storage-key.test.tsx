/**
 * #5467 — nav-collapse's useNavCollapse (section collapse, NOT the whole-rail
 * hook in use-nav-collapse.ts) takes a storage key so each sidebar persists
 * separately.
 *
 * Breaking inputs: a hook that ignores `storageKey` (both instances share one
 * map, so B reads A's collapse); a default other than NAV_COLLAPSE_LS_KEY (the
 * main left nav loses every user's saved state); a setCollapsed that writes
 * only the first key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNavCollapse, NAV_COLLAPSE_LS_KEY } from '../nav-collapse';

beforeEach(() => localStorage.clear());

describe('nav-collapse useNavCollapse(storageKey)', () => {
  it('defaults to the main left-nav key', () => {
    const { result } = renderHook(() => useNavCollapse());
    act(() => result.current.toggle('Data'));
    expect(JSON.parse(localStorage.getItem(NAV_COLLAPSE_LS_KEY)!)).toEqual({ Data: true });
  });

  it('two keys never share state', () => {
    const a = renderHook(() => useNavCollapse('k.a'));
    act(() => a.result.current.toggle('Security'));
    expect(a.result.current.collapsed('Security')).toBe(true);

    const b = renderHook(() => useNavCollapse('k.b'));
    expect(b.result.current.collapsed('Security')).toBe(false);
    expect(localStorage.getItem('k.b')).toBeNull();
    expect(localStorage.getItem(NAV_COLLAPSE_LS_KEY)).toBeNull();
  });

  it('setCollapsed sets every key; expand opens one', () => {
    const { result } = renderHook(() => useNavCollapse('k.c'));
    act(() => result.current.setCollapsed(['x', 'y', 'z'], true));
    expect(['x', 'y', 'z'].map((k) => result.current.collapsed(k))).toEqual([true, true, true]);
    act(() => result.current.expand('y'));
    expect(['x', 'y', 'z'].map((k) => result.current.collapsed(k))).toEqual([true, false, true]);
    expect(JSON.parse(localStorage.getItem('k.c')!)).toEqual({ x: true, y: false, z: true });
  });
});

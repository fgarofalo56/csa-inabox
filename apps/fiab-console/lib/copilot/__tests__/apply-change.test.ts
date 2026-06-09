/**
 * apply-change — editor-mutation bridge registry.
 *
 * Verifies the contract the CopilotDiff Keep handler relies on:
 *  - register → applyChange routes the approved `after` to the owning editor
 *  - the cleanup function removes exactly that registration
 *  - applyChange returns false (no mutation) when the target is not registered
 *    (a stale proposed_change whose editor has closed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerBridge, applyChange, hasBridge, _registrySize, _resetBridges,
} from '../apply-change';

beforeEach(() => { _resetBridges(); });

describe('apply-change bridge registry', () => {
  it('routes an approved change to the registered bridge', () => {
    const seen: string[] = [];
    registerBridge('notebook-cell:abc', (after) => seen.push(after));

    const applied = applyChange('notebook-cell:abc', 'df = df.cache()');
    expect(applied).toBe(true);
    expect(seen).toEqual(['df = df.cache()']);
  });

  it('returns false and mutates nothing when the target is not registered', () => {
    const applied = applyChange('notebook-cell:missing', 'whatever');
    expect(applied).toBe(false);
  });

  it('cleanup removes only its own registration', () => {
    const a = vi.fn();
    const b = vi.fn();
    const cleanupA = registerBridge('notebook-cell:a', a);
    registerBridge('notebook-cell:b', b);
    expect(_registrySize()).toBe(2);

    cleanupA();
    expect(hasBridge('notebook-cell:a')).toBe(false);
    expect(hasBridge('notebook-cell:b')).toBe(true);
    expect(applyChange('notebook-cell:a', 'x')).toBe(false);
    expect(applyChange('notebook-cell:b', 'y')).toBe(true);
    expect(b).toHaveBeenCalledWith('y');
  });

  it('cleanup does not clobber a newer bridge that replaced the key', () => {
    const first = vi.fn();
    const second = vi.fn();
    const cleanupFirst = registerBridge('notebook-cell:k', first);
    registerBridge('notebook-cell:k', second); // replace
    cleanupFirst(); // stale cleanup must NOT remove the newer bridge

    expect(applyChange('notebook-cell:k', 'z')).toBe(true);
    expect(second).toHaveBeenCalledWith('z');
    expect(first).not.toHaveBeenCalled();
  });
});

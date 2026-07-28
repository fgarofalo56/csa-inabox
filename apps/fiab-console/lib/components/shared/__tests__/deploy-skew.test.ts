/**
 * deploy-skew helpers (loom-apex A1) — pins the ChunkLoadError classifier and
 * the one-shot-reload loop guard. These guarantee that (a) every browser's
 * failed-chunk / failed-dynamic-import shape is recognized, and (b) a
 * genuinely broken chunk can never cause a hard-reload loop.
 */
import { describe, expect, it } from 'vitest';
import {
  isChunkLoadError,
  markReloadOnce,
  reloadGuardKey,
  type StorageLike,
} from '../deploy-skew';

function fakeStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => { store.set(k, v); },
  };
}

describe('isChunkLoadError', () => {
  it('detects webpack ChunkLoadError by name regardless of message', () => {
    const err = new Error('anything at all');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('detects the webpack "Loading chunk N failed" message', () => {
    expect(isChunkLoadError(new Error(
      'Loading chunk 4732 failed.\n(error: https://loom.example/_next/static/chunks/4732-ab12cd.js)',
    ))).toBe(true);
  });

  it('detects the webpack "Loading CSS chunk" message', () => {
    expect(isChunkLoadError(new Error('Loading CSS chunk 42 failed (/_next/static/css/42.css)'))).toBe(true);
  });

  it('detects the Chromium failed dynamic import message', () => {
    expect(isChunkLoadError(new TypeError(
      'Failed to fetch dynamically imported module: https://loom.example/_next/static/chunks/app/items/page-1a2b.js',
    ))).toBe(true);
  });

  it('detects the Firefox failed dynamic import message', () => {
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
  });

  it('detects the Safari failed module script message', () => {
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('rejects ordinary render errors', () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false); // plain network fetch ≠ chunk skew
  });

  it('rejects non-error values', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false); // bare string, not an error object
    expect(isChunkLoadError(42)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });

  it('accepts error-shaped plain objects (unhandledrejection reasons)', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'x' })).toBe(true);
    expect(isChunkLoadError({ message: 'Failed to fetch dynamically imported module: /x.js' })).toBe(true);
  });
});

describe('reloadGuardKey', () => {
  it('is distinct per pathname and per build id', () => {
    const a = reloadGuardKey('/monitor', 'abc123');
    expect(a).not.toBe(reloadGuardKey('/admin/gates', 'abc123'));
    expect(a).not.toBe(reloadGuardKey('/monitor', 'def456'));
    expect(a).toBe(reloadGuardKey('/monitor', 'abc123'));
  });
});

describe('markReloadOnce (loop guard)', () => {
  it('allows exactly one reload per (pathname, buildId)', () => {
    const s = fakeStorage();
    expect(markReloadOnce(s, '/monitor', 'sha1')).toBe(true);
    expect(markReloadOnce(s, '/monitor', 'sha1')).toBe(false);
    expect(markReloadOnce(s, '/monitor', 'sha1')).toBe(false);
  });

  it('a new build id resets the budget for the same pathname', () => {
    const s = fakeStorage();
    expect(markReloadOnce(s, '/monitor', 'sha1')).toBe(true);
    expect(markReloadOnce(s, '/monitor', 'sha2')).toBe(true); // post-reload new bundle
    expect(markReloadOnce(s, '/monitor', 'sha2')).toBe(false);
  });

  it('different pathnames have independent budgets', () => {
    const s = fakeStorage();
    expect(markReloadOnce(s, '/monitor', 'sha1')).toBe(true);
    expect(markReloadOnce(s, '/admin/gates', 'sha1')).toBe(true);
  });

  it('refuses (never loops) when storage is unavailable', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('sessionStorage blocked'); },
      setItem: () => { throw new Error('sessionStorage blocked'); },
    };
    expect(markReloadOnce(throwing, '/monitor', 'sha1')).toBe(false);
  });

  it('refuses when only setItem fails (quota) — attempt was never recorded', () => {
    const quota: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(markReloadOnce(quota, '/monitor', 'sha1')).toBe(false);
  });
});

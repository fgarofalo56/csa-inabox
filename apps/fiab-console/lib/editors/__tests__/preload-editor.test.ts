/**
 * preloadEditor — chunk warming for item editors.
 *
 * WHAT THIS PROTECTS. Editors are `dynamic(..., { ssr: false })`, so the chunk
 * only begins downloading when the route mounts. Measured on the 2026-08-11 UAT
 * sweep: at 2500 ms, 26 of 142 item types rendered `tabs=13, buttons=0` — the
 * skeleton was up and not one interactive control had painted. preloadEditor
 * spends the hover interval on that download instead.
 *
 * WHY THE POPULATION TEST BELOW IS THE IMPORTANT ONE. preloadEditor is written
 * to be safe: unknown slug, missing loader, and rejected import all return
 * quietly. That is correct for a prefetch — a failed warm must never surface to
 * a user — but it means the feature can DIE SILENTLY. If `reg()` ever stops
 * stashing `__loomLoader`, every call becomes a no-op, nothing throws, no test
 * that only checks "does not crash" would notice, and the only symptom is that
 * editors are slow again. So we assert the stash exists across the WHOLE
 * registry, and we fail on an empty population rather than pass vacuously.
 */
import { describe, it, expect } from 'vitest';
import { getEditor, preloadEditor, EDITOR_SLUGS } from '../registry';

type WithLoader = { __loomLoader?: () => Promise<unknown> };

describe('preloadEditor', () => {
  it('every registered editor carries a callable loader', () => {
    // Self-defence: a registry that has drifted to empty must not report a pass.
    expect(EDITOR_SLUGS.length).toBeGreaterThan(50);

    const missing = EDITOR_SLUGS.filter((slug) => {
      const comp = getEditor(slug) as unknown as WithLoader | null;
      return typeof comp?.__loomLoader !== 'function';
    });

    expect(missing).toEqual([]);
  });

  it('invokes the loader for a known slug, exactly once', () => {
    const slug = EDITOR_SLUGS[0];
    const comp = getEditor(slug) as unknown as WithLoader;
    const original = comp.__loomLoader;
    try {
      let calls = 0;
      comp.__loomLoader = () => {
        calls++;
        return Promise.resolve({});
      };

      preloadEditor(slug);
      expect(calls).toBe(1);

      // Memoized — hovering a row repeatedly must not refetch.
      preloadEditor(slug);
      expect(calls).toBe(1);
    } finally {
      comp.__loomLoader = original;
    }
  });

  it('is a silent no-op for unknown and empty slugs', () => {
    expect(() => preloadEditor('no-such-editor-slug')).not.toThrow();
    expect(() => preloadEditor('')).not.toThrow();
  });

  it('does not resolve slugs through Object.prototype', () => {
    // `EDITOR_REGISTRY['constructor']` is TRUTHY on a plain object literal, so a
    // truthiness check hands back Object's constructor as if it were an editor.
    //
    // Asserting only "preloadEditor does not throw" here would be a test that
    // CANNOT FAIL — it passed before the own-property fix too, because the bogus
    // component simply had no loader. The assertion has to be on the READ.
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(getEditor(inherited)).toBeNull();
      expect(() => preloadEditor(inherited)).not.toThrow();
    }
  });

  it('does not memoize a loader that rejected, so real navigation still retries', async () => {
    const slug = EDITOR_SLUGS[1];
    const comp = getEditor(slug) as unknown as WithLoader;
    const original = comp.__loomLoader;
    try {
      let calls = 0;
      comp.__loomLoader = () => {
        calls++;
        return Promise.reject(new Error('offline'));
      };

      preloadEditor(slug);
      expect(calls).toBe(1);
      // Let the rejection handler clear the memo.
      await new Promise((r) => setTimeout(r, 0));

      preloadEditor(slug);
      expect(calls).toBe(2);
    } finally {
      comp.__loomLoader = original;
    }
  });
});

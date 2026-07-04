/**
 * bundle-items manifest drift guard — rel-T63.
 *
 * `./bundle-items.ts` is a lightweight, statically-importable projection of
 * each content bundle's ORDERED item-type list. The apps-catalog seed + the
 * bootstrap route build every catalog doc's `items:[{type, template}]` from it
 * WITHOUT importing the heavy (~3.1 MB) per-bundle content payloads (those are
 * now lazy `await import()` behind getBundle). This suite pins the manifest to
 * the REAL bundles so it can never silently disagree:
 *
 *   1. The manifest's key set === listBundleIds() (no missing / stray bundle).
 *   2. For every bundle, BUNDLE_ITEM_TYPES[id] deep-equals the real
 *      (await getBundle(id)).items mapped to itemType, in order, with
 *      duplicates preserved.
 *
 * If a bundle's items change, (2) fails until bundle-items.ts is regenerated —
 * turning a would-be silent catalog regression (wrong "Bundled items (N)" /
 * broken Install manifest) into a hard test failure. Pure static-data
 * assertions, no Azure traffic (per .claude/rules/no-vaporware.md).
 */
import { describe, it, expect } from 'vitest';

import { listBundleIds, getBundle, getBundleItemTypes } from '@/lib/apps/content-bundles';
import { BUNDLE_ITEM_TYPES } from '@/lib/apps/content-bundles/bundle-items';

describe('bundle-items manifest', () => {
  const ids = listBundleIds();

  it('manifest key set exactly matches the registered bundle ids', () => {
    expect(new Set(Object.keys(BUNDLE_ITEM_TYPES))).toEqual(new Set(ids));
  });

  it('every bundle manifest matches the real bundle items (ordered, with duplicates)', async () => {
    for (const id of ids) {
      const bundle = await getBundle(id);
      expect(bundle, `getBundle("${id}") returned undefined`).toBeTruthy();
      const real = (bundle!.items || []).map((i) => i.itemType);
      expect(
        getBundleItemTypes(id),
        `bundle-items.ts is stale for "${id}" — regenerate the BUNDLE_ITEM_TYPES manifest`,
      ).toEqual(real);
    }
  });
});

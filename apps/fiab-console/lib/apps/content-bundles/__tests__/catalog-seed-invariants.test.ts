/**
 * Apps-catalog seed invariants (A+ apps-catalog cluster, 2026-06-20).
 *
 * Guards the two vaporware defects fixed in this cluster so they can never
 * silently regress:
 *
 *   1. **id drift** — the GLOBAL Cosmos seed (POST /api/admin/bootstrap-catalogs)
 *      and the deploy-time shell seed (scripts/csa-loom/seed-catalogs.sh) used
 *      five bare-slug ids (`change-feed-processor`, `direct-lake-replacement`,
 *      `federal-data-mesh`, `ml-pipeline`, `multi-agency-onboarding`) while the
 *      registered content-bundle's appId is `app-<slug>`. Install does
 *      getBundle(id) → so a mismatched id makes install resolve no bundle (no
 *      rich starter content) AND collides with the registry-backstop's
 *      correctly-id'd copy → a broken duplicate tile.
 *   2. **drift / missing apps** — the seed was a hand-maintained subset (15 of
 *      29 registered bundles), so the documented use-cases + Supercharge
 *      bundles + workspace-monitoring never reached the GLOBAL seed.
 *
 * The fix derives the seed from the registry (`listBundleIds`) + `CATALOG_META`
 * so the seed, the live registry backstop (app/api/apps-catalog/route.ts), and
 * the install resolver (getBundle) can never disagree. These are pure
 * static-data assertions (no Azure traffic) per .claude/rules/no-vaporware.md.
 */
import { describe, it, expect } from 'vitest';

import { listBundleIds, getBundle, hasBundle } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';

describe('apps-catalog seed invariants', () => {
  const ids = listBundleIds();

  it('registers at least the 29 known curated app bundles', () => {
    expect(ids.length).toBeGreaterThanOrEqual(29);
  });

  it('every registered bundle uses the app-<slug> id convention', () => {
    for (const id of ids) {
      expect(id, `bundle id "${id}" must use the app-<slug> convention`).toMatch(/^app-/);
    }
  });

  it('every registered bundle has a CATALOG_META entry whose id matches (install → getBundle(id) resolves)', () => {
    for (const id of ids) {
      const meta = CATALOG_META[id];
      expect(meta, `bundle "${id}" has no CATALOG_META entry — tile would be undiscoverable`).toBeTruthy();
      expect(meta.id, `CATALOG_META["${id}"].id must equal "${id}"`).toBe(id);
    }
  });

  it('every CATALOG_META entry resolves to a registered bundle (no orphan tiles)', () => {
    for (const id of Object.keys(CATALOG_META)) {
      expect(hasBundle(id), `CATALOG_META has "${id}" but no bundle is registered — install would 404`).toBe(true);
    }
  });

  it('every registered bundle ships at least one item so Install is never disabled', async () => {
    for (const id of ids) {
      const bundle = await getBundle(id);
      expect(bundle, `getBundle("${id}") returned undefined`).toBeTruthy();
      expect(
        (bundle?.items?.length ?? 0),
        `bundle "${id}" has zero items — the /apps/[id] Install button disables (disabled={!app.items?.length})`,
      ).toBeGreaterThan(0);
    }
  });
});

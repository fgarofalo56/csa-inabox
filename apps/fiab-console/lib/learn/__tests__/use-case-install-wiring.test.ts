/**
 * Use-case "Install live example" wiring invariant (audit-t38).
 *
 * The Learn portal surfaces an "Install live example" button on every use-case
 * card whose `appId` is INSTALLABLE — i.e. the matching content bundle is
 * registered in BOTH the REGISTRY (`getBundle`) and `CATALOG_META`. That gate
 * lives in `getLearnCatalog()`:
 *
 *     const appInstallable =
 *       !!u.appId && !!getBundle(u.appId) && !!CATALOG_META[u.appId];
 *
 * The failure mode this suite guards against is SILENT: if a future use case
 * names an `appId` whose bundle was never registered (or whose CATALOG_META
 * entry was forgotten), `appInstallable` evaluates false and the Install button
 * just disappears from the card — no error, no CI failure, a dead-end use case
 * that "card opens doc today" exactly the regression audit-t38 fixed.
 *
 * Per no-vaporware.md + no-fabric-dependency.md these are pure static-data
 * assertions (no Azure traffic) that pin the install path end to end:
 *
 *   1. Every authored `appId` resolves in BOTH registries → button SHOWS.
 *   2. `getLearnCatalog()` actually emits `appId` + `appHref` for those cards,
 *      so the wired button + dialog (learn-topic-card.tsx / learn/page.tsx)
 *      and the /apps/<appId> detail link both have their inputs.
 *   3. The resolved bundle's `appId` equals the use-case `appId` and the
 *      CATALOG_META `id` equals it too (the install handler does
 *      `getBundle(appId)` → so id MUST match or install 404s).
 */
import { describe, it, expect } from 'vitest';

import { USE_CASES, getLearnCatalog, type LearnTopic } from '@/lib/learn/content';
import { getBundle } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';

const APPID_USE_CASES = USE_CASES.filter((u) => !!u.appId);

describe('use-case "Install live example" wiring', () => {
  it('ships at least one installable use case (sanity: the feature is live)', () => {
    expect(APPID_USE_CASES.length).toBeGreaterThan(0);
  });

  it('every authored appId resolves in BOTH the bundle REGISTRY and CATALOG_META', () => {
    for (const u of APPID_USE_CASES) {
      const appId = u.appId!;
      const bundle = getBundle(appId);
      expect(
        bundle,
        `use case "${u.id}" names appId "${appId}" but no bundle is registered in content-bundles/index.ts — the Install button would silently vanish (no-vaporware)`,
      ).toBeDefined();
      // id MUST equal appId so the install handler's getBundle(appId) resolves.
      expect(bundle!.appId, `bundle for "${appId}" must self-report appId "${appId}"`).toBe(appId);

      const meta = CATALOG_META[appId];
      expect(
        meta,
        `use case "${u.id}" names appId "${appId}" but CATALOG_META has no entry — the appInstallable gate evaluates false and the Install button vanishes`,
      ).toBeDefined();
      expect(meta.id, `CATALOG_META["${appId}"].id must equal "${appId}"`).toBe(appId);
    }
  });

  it('getLearnCatalog surfaces appId + appHref on every installable use-case card', () => {
    const catalog = getLearnCatalog();
    const useCaseTopics = new Map<string, LearnTopic>(
      catalog.filter((t) => t.id.startsWith('usecase:')).map((t) => [t.id, t]),
    );

    for (const u of APPID_USE_CASES) {
      const topic = useCaseTopics.get(`usecase:${u.id}`);
      expect(topic, `catalog must contain a topic for use case "${u.id}"`).toBeDefined();
      // The button (onClick → InstallAppDialog) keys off topic.appId; the
      // /apps/<id> detail link keys off topic.appHref. Both must be present.
      expect(topic!.appId, `topic "usecase:${u.id}" must carry appId so the Install button renders`).toBe(u.appId);
      expect(topic!.appHref).toBe(`/apps/${u.appId}`);
      expect(topic!.appLabel).toBeTruthy();
    }
  });

  it('does NOT emit appId for use cases without an authored appId (no phantom button)', () => {
    const catalog = getLearnCatalog();
    const noAppIdIds = new Set(USE_CASES.filter((u) => !u.appId).map((u) => `usecase:${u.id}`));
    for (const t of catalog) {
      if (noAppIdIds.has(t.id)) {
        expect(t.appId, `topic "${t.id}" has no authored appId and must not surface an Install button`).toBeUndefined();
        expect(t.appHref).toBeUndefined();
      }
    }
  });
});

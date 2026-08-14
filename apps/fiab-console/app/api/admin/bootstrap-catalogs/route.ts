/**
 * POST /api/admin/bootstrap-catalogs — one-time seed of apps-catalog and
 * workloads-catalog under tenant=GLOBAL. Idempotent (upserts).
 *
 * Cosmos is PE-locked from the outside, so the bash equivalent at
 * scripts/csa-loom/seed-catalogs.sh only works from inside the VNet.
 * This route runs from inside the container app where the data-plane
 * is reachable. Auth gate: tenant-admin only (requireTenantAdmin) — the
 * seed writes tenant-GLOBAL catalog docs, so it is not open to any
 * signed-in user.
 *
 * The response counts ONLY successful upserts and returns `ok:false` with a
 * per-doc `errors[]` when any write fails, so a Cosmos RBAC/throttle failure
 * can never masquerade as a completed seed (rel-T96).
 *
 * After this is called once per environment, the per-tenant copy on
 * first /api/apps-catalog GET = [] handles new tenants automatically.
 */

import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { appsCatalogContainer, workloadsCatalogContainer } from '@/lib/azure/cosmos-client';
import { ensureDataProductsIndex } from '@/lib/azure/loom-data-products-search';
import { listBundleIds, getBundleItemTypes } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';
import { WORKLOAD_SEEDS } from '@/lib/apps/workloads-catalog-seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT = 'GLOBAL';

/**
 * Apps to seed under tenant=GLOBAL.
 *
 * SINGLE SOURCE OF TRUTH (apps-catalog A+ cluster, 2026-06-20):
 * derived from the content-bundle registry (`listBundleIds`) +
 * `CATALOG_META`, NOT a hand-maintained array. The previous hard-coded
 * `APPS` const had two vaporware defects this eliminates:
 *
 *   1. **id drift** — five entries used the bare slug
 *      (`change-feed-processor`, `direct-lake-replacement`,
 *      `federal-data-mesh`, `ml-pipeline`, `multi-agency-onboarding`)
 *      while the registered bundle's appId is `app-<slug>`. Install →
 *      getBundle(id) then returned undefined for those, so the GLOBAL
 *      seed produced catalog docs whose rich content never resolved (and
 *      collided with the registry-backstop's correctly-id'd copy → two
 *      tiles for the same app, one broken).
 *   2. **14 missing apps** — the array seeded only 15 of the 29
 *      registered bundles. The documented use-cases (data-governance,
 *      logic-apps-integration, real-time-dashboards, azure-realtime-
 *      analytics, sovereign-ai-agents, hybrid-topology), the Supercharge
 *      bundles, and workspace-monitoring never reached the GLOBAL seed,
 *      so a fresh deploy showed them only after the live
 *      /api/apps-catalog registry backstop ran (and never at all where
 *      the per-tenant copy is taken straight from GLOBAL).
 *
 * Deriving from the registry guarantees the GLOBAL seed, the live
 * registry backstop (app/api/apps-catalog/route.ts), and the install
 * resolver (getBundle) all agree on id + items[], so EVERY app is
 * installable for real. items[] carries the lean `{type, template}`
 * shape (rich content stays in-process per content-bundles/index.ts so
 * the Cosmos doc stays well under the 2 MB per-doc limit).
 */
export function buildApps() {
  const apps: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    publisher: string;
    items: { type: string; template: string }[];
  }> = [];
  for (const appId of listBundleIds()) {
    const meta = CATALOG_META[appId];
    if (!meta) continue; // bundle without catalog metadata — skip (still installable directly)
    apps.push({
      id: appId,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      category: meta.category,
      publisher: meta.publisher,
      // Lean {type, template} refs from the lightweight manifest (rel-T63) —
      // install reads getBundle(appId) for the rich starter content, so
      // template just points back at the bundle id. This module-level
      // buildApps() stays synchronous and never loads a heavy payload.
      items: getBundleItemTypes(appId).map((t) => ({ type: t, template: appId })),
    });
  }
  return apps;
}

const APPS = buildApps();

const WORKLOADS = WORKLOAD_SEEDS;

// Route-toolkit: withTenantAdmin (R3). Replaces the hand-rolled prologue
// `getSession() -> apiUnauthorized(); requireTenantAdmin(s) -> gate`, which is
// what withTenantAdmin runs verbatim (it composes withSession, so the 401 is
// the same apiUnauthorized() and the 403 is the same requireTenantAdmin gate
// object returned unchanged).
export const POST = withTenantAdmin(async () => {
  const now = new Date().toISOString();
  const stamp = { tenantId: TENANT, createdBy: 'bootstrap-catalogs', createdAt: now, updatedAt: now };

  // Count ONLY successful upserts — a Cosmos RBAC / throttle / connectivity
  // failure must NOT masquerade as a completed seed (rel-T96). Each failed
  // write is captured (id + message) so the admin sees exactly what didn't land
  // and the response `ok` reflects the truth.
  const apps = await appsCatalogContainer();
  let appsSeeded = 0;
  const appFailures: string[] = [];
  for (const a of APPS) {
    try {
      await apps.items.upsert({ ...a, ...stamp, installedBy: [] });
      appsSeeded++;
    } catch (e: any) {
      appFailures.push(`app:${a.id}: ${e?.message || String(e)}`);
    }
  }

  const wls = await workloadsCatalogContainer();
  let workloadsSeeded = 0;
  const wlFailures: string[] = [];
  for (const w of WORKLOADS) {
    try {
      await wls.items.upsert({ ...w, ...stamp, publisher: 'CSA', iconUrl: null });
      workloadsSeeded++;
    } catch (e: any) {
      wlFailures.push(`workload:${w.id}: ${e?.message || String(e)}`);
    }
  }

  // Provision the consumer-discovery AI Search index for the Data Marketplace.
  // Idempotent + best-effort: a brand-new env gets the index here; a missing
  // LOOM_AI_SEARCH_SERVICE just reports the honest gate (no throw).
  const dataProductsIndex = await ensureDataProductsIndex().catch((e: any) => ({
    created: false, ok: false, error: e?.message || String(e),
  }));

  const seeded = appsSeeded + workloadsSeeded;
  const failed = appFailures.length + wlFailures.length;
  const summary = {
    tenant: TENANT,
    seeded,
    failed,
    appsSeeded,
    appsTotal: APPS.length,
    workloadsSeeded,
    workloadsTotal: WORKLOADS.length,
    dataProductsIndex,
    ...(failed ? { errors: [...appFailures, ...wlFailures].slice(0, 25) } : {}),
  };

  // Partial or total write failure → ok:false so callers never treat a
  // half-seeded catalog as done (HTTP 200: the route itself ran; the failures
  // are reported in the body, mirroring the health-degraded convention).
  if (failed > 0) {
    return apiError(
      `Catalog seed incomplete — ${seeded} seeded, ${failed} write(s) failed`,
      200,
      summary,
    );
  }
  return apiOk(summary);
});

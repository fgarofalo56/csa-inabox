/**
 * WS-G / G3 — GET /api/admin/performance/retrieval-stats
 *
 * Live docs-Copilot retrieval telemetry: retrieval latency (p50/p95/avg/max),
 * hit-rate, AI-Search→Cosmos fallback rate, per-backend counts
 * (`retrieval-metrics.ts`) + the corpus freshness state (`corpusFreshness`) +
 * the KPI metadata. Real in-process numbers + a real backend read, never
 * fabricated (no-vaporware.md); all Azure-native (no Fabric — no-fabric-
 * dependency.md).
 *
 * Tenant-admin gated (org-wide perf posture) — same authz as the sibling
 * GET /api/admin/performance/cache-stats route.
 */
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { retrievalMetricsSnapshot } from '@/lib/perf/retrieval-metrics';
import { RETRIEVAL_HIT_RATE_KPI } from '@/lib/perf/perf-metrics';
import { corpusFreshness } from '@/lib/azure/loom-docs-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  // Freshness reads the manifest from Cosmos / AI Search; keep the route robust
  // if that backend is briefly unreachable (metrics still return).
  let freshness: unknown;
  try {
    freshness = await corpusFreshness();
  } catch (e: any) {
    freshness = { state: 'unknown', reason: `Freshness check failed: ${e?.message || String(e)}` };
  }

  return apiOk({
    kpi: RETRIEVAL_HIT_RATE_KPI,
    metrics: retrievalMetricsSnapshot(),
    freshness,
  });
}

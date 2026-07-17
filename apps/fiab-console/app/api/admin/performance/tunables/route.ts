/**
 * PERF-4.2 / 4.4 — GET/POST /api/admin/performance/tunables
 *
 * GET → { ok, tunables, heatmaps, schedule, audit, learningCache }
 *   • tunables  — the PerfTunables doc (auto-adjust toggles + bounds, cache
 *                 override, learning config)
 *   • heatmaps  — the REAL learned hour-of-week histograms per (scope, pool)
 *                 from the perf-learning Cosmos container
 *   • schedule  — the 168-hour learned warm-target preview for the default pool
 *   • audit     — recent applied-change audit rows (manual + auto)
 *
 * POST body: Partial<PerfTunables> — sanitized/clamped server-side, persisted
 * to Cosmos, applied to the in-process cache immediately (the pool sweep +
 * query cache consume it live). Tenant-admin gated.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { getTunables, writeTunables, listHistograms, aggregateByPool, listRecentAudit } from '@/lib/perf/usage-store';
import { sanitizeTunables, type PerfTunables } from '@/lib/perf/perf-tunables';
import { learnedSchedule, totalWeight } from '@/lib/perf/usage-learning';
import { learningCacheStatus, refreshLearningCache } from '@/lib/perf/learning-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function snapshot() {
  const tunables = await getTunables();
  const docs = await listHistograms();
  const heatmaps = docs.map((d) => ({
    scope: d.scopeKey,
    poolKey: d.poolKey,
    weights: d.weights,
    total: totalWeight(d.weights),
    events: d.events,
    updatedAt: d.updatedAt,
  }));
  // Learned 168-hour schedule preview for the busiest aggregated pool group.
  const agg = aggregateByPool(docs, tunables.learning.workspaces);
  let schedule: { poolKey: string; decisions: ReturnType<typeof learnedSchedule> } | null = null;
  let busiest: { poolKey: string; weights: number[]; total: number } | null = null;
  for (const [poolKey, v] of agg.entries()) {
    if (!busiest || v.total > busiest.total) busiest = { poolKey, weights: v.weights, total: v.total };
  }
  if (busiest) {
    const { sparkPoolConfig } = await import('@/lib/azure/spark-session-pool');
    const cfg = sparkPoolConfig();
    schedule = { poolKey: busiest.poolKey, decisions: learnedSchedule(busiest.weights, tunables.learning, cfg.min, cfg.max) };
  }
  const audit = await listRecentAudit(20);
  return { tunables, heatmaps, schedule, audit, learningCache: learningCacheStatus() };
}

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    return apiOk(await snapshot());
  } catch (e) {
    return apiServerError(e, 'Failed to load performance tunables');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<PerfTunables>;
    const current = await getTunables();
    // Merge-then-sanitize so a partial PATCH (e.g. only learning.sensitivity)
    // keeps every other admin setting.
    const merged = sanitizeTunables({
      ...current,
      ...body,
      autoAdjust: { ...current.autoAdjust, ...(body.autoAdjust ?? {}) },
      cacheOverride: { ...current.cacheOverride, ...(body.cacheOverride ?? {}) },
      learning: { ...current.learning, ...(body.learning ?? {}) },
    });
    const actor = s.claims.upn || s.claims.email || s.claims.oid || 'admin';
    await writeTunables(merged, actor);
    // Re-aim the learned schedule immediately (not on the next sweep tick).
    await refreshLearningCache(true).catch(() => {});
    return apiOk(await snapshot());
  } catch (e) {
    return apiServerError(e, 'Failed to save performance tunables');
  }
}

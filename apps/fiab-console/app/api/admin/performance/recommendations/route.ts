/**
 * PERF-4.1 — GET /api/admin/performance/recommendations
 *
 * Derives the actionable recommendation cards for the Performance page from
 * LIVE measured signals only: warm-pool acquire hit/miss counters + live pool
 * status, real Livy queue depth (REST list), result-cache hit-rate counters,
 * the Copilot SLO rolling window, the persisted benchmark trend (p95 vs bar),
 * and the real ARM state of the ADX cluster / dedicated SQL pool.
 *
 * Returns { ok:true, recommendations, signals, autoApplicable } — the signal
 * snapshot ships alongside so the UI shows the evidence, and `autoApplicable`
 * lists the rec ids the auto-adjust engine would apply on its next tick.
 *
 * Tenant-admin gated (org-wide perf posture). No fabricated advice — every
 * rule requires a measured threshold breach (no-vaporware.md).
 */
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { collectPerfSignals, autoApplicable, autoTuneStatus } from '@/lib/perf/auto-tune';
import { deriveRecommendations } from '@/lib/perf/recommendations';
import { getTunables } from '@/lib/perf/usage-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  try {
    const tunables = await getTunables();
    const signals = await collectPerfSignals({ includeArmProbes: true, trendMaxRuns: 5 });
    const recommendations = deriveRecommendations(signals, tunables);
    return apiOk({
      recommendations,
      signals,
      autoApplicable: autoApplicable(recommendations, tunables),
      autoTune: autoTuneStatus(),
    });
  } catch (e) {
    return apiServerError(e, 'Failed to derive performance recommendations');
  }
}

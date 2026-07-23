/**
 * GET /api/admin/slo — the SLO / error-budget rollup for the Health &
 * Reliability hub's SLO tab (SLO1, loom-next-level).
 *
 * REAL stores only (no-vaporware.md), aggregated read-only:
 *   • Availability — the V1 synthetic-journey verdicts over 28 days
 *     (readSyntheticRuns → Blob run artifacts), bucketed for the burn-down.
 *   • Latency      — the Copilot first-token/full-turn SLOs
 *     (recentCopilotSloEvaluations, lib/perf/copilot-latency-tracker).
 *   • Efficiency   — the result-cache hit-rate (cacheCountersSnapshot).
 * The pure rollup lives in lib/admin/slo-rollup; this route resolves the
 * stores and hands it the raw inputs.
 *
 * Session-gated + tenant-admin (withTenantAdmin — R1 route-toolkit). The SLO
 * tab spans several feeds, so it is NOT hard-gated on any one: an unwired
 * synthetic-runs store degrades the availability SLI to an honest "no data"
 * row while the Copilot + cache SLIs still render (readSyntheticRuns reports
 * `configured:false` instead of throwing).
 *
 * Burn-rate alerting (SLO1 acceptance): an availability/latency SLI in
 * fast-burn breach (burn >= FAST_BURN_ALERT_THRESHOLD) pages ONE P2 through
 * the shared O1 dispatch (lib/azure/alert-dispatch), deduped per-SLI and
 * throttled per replica so a dashboard poll never spams the on-call bridge.
 *
 * Runbook: docs/fiab/runbooks/slo-error-budget.md.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { readSyntheticRuns } from '@/lib/admin/synthetic-runs-reader';
import { recentCopilotSloEvaluations } from '@/lib/perf/copilot-latency-tracker';
import { cacheCountersSnapshot } from '@/lib/perf/cache-counters';
import { buildSloRollup, type SloRollup, type SloBurnAlert } from '@/lib/admin/slo-rollup';
import { dispatchAlert } from '@/lib/azure/alert-dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cache TTL for the rollup (short — the tab is a live surface). */
const SLO_CACHE_TTL_MS = 30_000;
/** Per-SLI page throttle: re-page a still-breaching SLI at most this often. */
const ALERT_THROTTLE_MS = 60 * 60 * 1000;

/** Days of run history to pull (>= the 28-day window, with headroom for gaps). */
const RUN_HISTORY = 200;

/** Per-replica last-paged clock, keyed by SLI id (module scope — resets on roll). */
const lastPaged = new Map<string, number>();

interface SloPayload extends SloRollup {
  /** Whether the synthetic-runs store is wired (drives the availability row). */
  journeysConfigured: boolean;
  journeysMissing?: string;
}

async function computeRollup(): Promise<SloPayload> {
  const synthetic = await readSyntheticRuns({ n: RUN_HISTORY });
  const copilot = recentCopilotSloEvaluations();
  const cache = cacheCountersSnapshot();
  const rollup = buildSloRollup({ now: new Date(), runs: synthetic.runs, copilot, cache });
  return { ...rollup, journeysConfigured: synthetic.configured, journeysMissing: synthetic.missing };
}

/**
 * Page each fast-burn breach ONCE per throttle window, deduped per SLI through
 * the shared O1 dispatch. Best-effort — never blocks or fails the read.
 */
async function pageBurnAlerts(alerts: readonly SloBurnAlert[]): Promise<void> {
  const now = Date.now();
  for (const a of alerts) {
    const last = lastPaged.get(a.sliId) ?? 0;
    if (now - last < ALERT_THROTTLE_MS) continue;
    lastPaged.set(a.sliId, now);
    try {
      await dispatchAlert({
        source: 'slo-burn',
        severity: 'P2',
        title: `SLO fast-burn: ${a.label}`,
        body:
          `${a.label} is burning its error budget at ${a.burn.toFixed(1)}× the allowed rate ` +
          `(attainment ${(a.attainment * 100).toFixed(2)}% vs objective ${(a.objective * 100).toFixed(2)}%). ` +
          `See the SLO tab of /admin/health and docs/fiab/runbooks/slo-error-budget.md.`,
        dedupKey: `slo-burn:${a.sliId}`,
      });
    } catch {
      // A dispatch hiccup must never take the dashboard down — the surface
      // still shows the burn; the alert retries on the next poll past throttle.
    }
  }
}

export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const bypass = req.nextUrl.searchParams.get('refresh') === '1';
    const { value } = await getOrComputeCached<SloPayload>('admin-slo:rollup', 'admin-slo', computeRollup, {
      ttlMs: SLO_CACHE_TTL_MS,
      bypass,
      serveStaleOnError: true,
    });
    // Fire P2s for any fast-burn breach (throttled + deduped). Awaited so a
    // seeded breach's dispatch is proven in the same request (SLO1 acceptance).
    if (value.alerts.length > 0) await pageBurnAlerts(value.alerts);
    return apiOk({ slo: value });
  } catch (e) {
    return apiServerError(e, 'Failed to assemble the SLO rollup');
  }
});

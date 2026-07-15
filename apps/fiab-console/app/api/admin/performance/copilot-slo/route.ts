/**
 * PSR-8 — GET /api/admin/performance/copilot-slo
 *
 * Live Copilot turn-latency SLO for the perf surface: the objective targets
 * (copilot-slo.ts) evaluated against the rolling window of REAL recent turns
 * (copilot-latency-tracker.ts) — first-token + full-turn attainment, met?, and
 * error-budget burn. Real in-process numbers, never fabricated (no-vaporware.md);
 * Azure OpenAI only (no Fabric — no-fabric-dependency.md).
 *
 * Tenant-admin gated, same authz as the sibling cache-stats + performance routes.
 */
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { copilotSloTargets } from '@/lib/perf/copilot-slo';
import { recentCopilotSloEvaluations, copilotLatencyWindow } from '@/lib/perf/copilot-latency-tracker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  return apiOk({
    targets: copilotSloTargets(),
    evaluations: recentCopilotSloEvaluations(),
    window: copilotLatencyWindow(),
  });
}

/**
 * GET /api/admin/copilot-quality (E5)
 *
 * The per-surface Copilot quality snapshot for /admin/copilot-quality. Reads the
 * REAL `eval-run` docs the copilot-evaluator Function (E2) writes to Cosmos
 * `loom-copilot-evals`, joins them with the E3 per-surface floors
 * (content/evals/eval-floors.json, staged into the image), and returns one
 * scorecard per surface (letter grade + trend + floor status + delta-vs-prev)
 * plus the program roll-up.
 *
 * Tenant-admin scoped (org-wide quality telemetry — same class as the sibling
 * /admin/agent-quality snapshot). Real numbers only (no-vaporware.md): a surface
 * with no runs returns null totals so the page renders a guided EmptyState, not
 * a fabricated 0. Azure OpenAI / AI Search / Cosmos backends only — no Fabric /
 * Power BI dependency (no-fabric-dependency.md).
 *
 * Cached via getOrComputeCached (5-min TTL, Front-Door-safe budget +
 * serve-stale-on-error) so a burst of admin loads never fans out to Cosmos.
 */
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { copilotEvalsContainer } from '@/lib/azure/cosmos-client';
import type { CopilotEvalRunDoc } from '@/lib/azure/copilot-evals-model';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { loadEvalFloors } from '@/lib/admin/copilot-eval-floors';
import {
  buildSurfaceSummaries, overallStats, type SurfaceSummary, type OverallStats,
} from '@/lib/admin/copilot-quality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounded pull: the newest run docs across every surface (cross-partition). */
const RUNS_QUERY =
  "SELECT TOP 400 * FROM c WHERE c.docType = 'eval-run' AND c.surface != '#ledger' ORDER BY c.finishedAt DESC";

export interface CopilotQualitySnapshot {
  ok: true;
  summaries: SurfaceSummary[];
  overall: OverallStats;
  /** Whether the evaluator Function is wired (drives the "Run now" gate). */
  evaluator: { configured: boolean; missing: string[] };
  floorsAvailable: boolean;
  generatedAt: string;
  cache: { hit: boolean; stale: boolean; cachedAt: number };
}

async function computeSnapshot(): Promise<Omit<CopilotQualitySnapshot, 'cache'>> {
  const floorsFile = loadEvalFloors();
  const floors = floorsFile?.floors ?? {};

  let runs: CopilotEvalRunDoc[] = [];
  try {
    const c = await copilotEvalsContainer();
    const { resources } = await c.items
      .query<CopilotEvalRunDoc>({ query: RUNS_QUERY })
      .fetchAll();
    runs = resources ?? [];
  } catch {
    // Cosmos unreachable / container not yet created (no runs have ever landed)
    // → an empty, guided snapshot. The page renders the EmptyState + Fix-it,
    // never an error page (ux-baseline first-open-clean).
    runs = [];
  }

  const summaries = buildSurfaceSummaries(runs, floors, floorsFile?.order);
  const url = (process.env.LOOM_COPILOT_EVALUATOR_URL || '').trim();
  return {
    ok: true,
    summaries,
    overall: overallStats(summaries),
    evaluator: { configured: !!url, missing: url ? [] : ['LOOM_COPILOT_EVALUATOR_URL'] },
    floorsAvailable: !!floorsFile,
    generatedAt: new Date().toISOString(),
  };
}

export const GET = withTenantAdmin(async () => {
  try {
    const { value, meta } = await getOrComputeCached(
      'admin:copilot-quality:summary',
      'copilot-quality',
      computeSnapshot,
      { ttlMs: 5 * 60_000, budgetMs: 45_000, serveStaleOnError: true, staleWhileRevalidate: true },
    );
    return apiOk({ ...value, cache: { hit: meta.hit, stale: meta.stale, cachedAt: meta.cachedAt } });
  } catch (e) {
    return apiServerError(e);
  }
});

/**
 * WS-1.4 — GET /api/admin/agent-quality
 *
 * The consolidated snapshot for the Admin "Agent Quality" page. It does NOT add
 * new plumbing — it reads the EXISTING real backends and returns them under one
 * roof so the page can render evals + red-team + traces + SLO on one surface:
 *
 *   • agents   — the Foundry Agent Service agent list (lib/azure/foundry-agent-client).
 *                Honest-gated (configured:false + gate) when
 *                LOOM_FOUNDRY_PROJECT_ENDPOINT is unset — no mock agents. The
 *                page then lazily drills each agent via the existing
 *                /api/foundry/agents/{eval,rollup,threads} routes.
 *   • redTeam  — every ai-red-team item + its latest persisted run summary,
 *                read from the item's Cosmos state.runs (real refusal-classified
 *                scan results). Tenant-admin scope (org-wide read) — same class
 *                as the sibling admin usage/copilot-usage aggregates.
 *   • slo      — the live Copilot turn-latency SLO (copilot-slo objectives over
 *                the rolling real-turn window) — identical payload to
 *                /api/admin/performance/copilot-slo.
 *
 * Tenant-admin gated (requireTenantAdmin) — it surfaces org-wide agent-quality
 * telemetry. Real numbers only (no-vaporware.md); Azure OpenAI / Cosmos only,
 * no Fabric/Power BI dependency (no-fabric-dependency.md).
 */
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listAgents,
  getProjectId,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';
import { copilotSloTargets } from '@/lib/perf/copilot-slo';
import { recentCopilotSloEvaluations, copilotLatencyWindow } from '@/lib/perf/copilot-latency-tracker';
import { summarizeRedTeam, type RedTeamResultRow } from '@/lib/foundry/red-team';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_RECYCLED = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

interface RedTeamRunSummary {
  id: string;
  startedAt?: string;
  finishedAt?: string;
  deployment?: string;
  categories?: string[];
  refusalRate: number;
  attackSuccessRate: number;
  total: number;
  unsafe: number;
  partial: number;
}

interface RedTeamItemSummary {
  id: string;
  displayName: string;
  workspaceId: string;
  runCount: number;
  latestRun: RedTeamRunSummary | null;
}

/** Read every ai-red-team item (org-wide; admin-gated) + its latest run summary. */
async function loadRedTeam(): Promise<RedTeamItemSummary[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; displayName?: string; workspaceId: string; state?: Record<string, any> }>({
      query: `SELECT c.id, c.displayName, c.workspaceId, c.state FROM c WHERE c.itemType = 'ai-red-team' AND ${NOT_RECYCLED}`,
      parameters: [],
    })
    .fetchAll();
  return resources.map((it) => {
    const runs: any[] = Array.isArray(it.state?.runs) ? it.state!.runs : [];
    const latest = runs[0];
    let latestRun: RedTeamRunSummary | null = null;
    if (latest) {
      // Recompute the summary from the persisted rows so the numbers are the
      // real classifier output, not a re-labelled field.
      const rows: RedTeamResultRow[] = Array.isArray(latest.results) ? latest.results : [];
      const s = rows.length ? summarizeRedTeam(rows) : (latest.summary ?? { total: 0, refusalRate: 0, attackSuccessRate: 0, unsafe: 0, partial: 0 });
      latestRun = {
        id: latest.id,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        deployment: latest.deployment,
        categories: Array.isArray(latest.categories) ? latest.categories : undefined,
        refusalRate: s.refusalRate ?? 0,
        attackSuccessRate: s.attackSuccessRate ?? 0,
        total: s.total ?? 0,
        unsafe: s.unsafe ?? 0,
        partial: s.partial ?? 0,
      };
    }
    return {
      id: it.id,
      displayName: it.displayName || it.id,
      workspaceId: it.workspaceId,
      runCount: runs.length,
      latestRun,
    };
  });
}

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const denied = requireTenantAdmin(session);
  if (denied) return denied;

  // Agents (honest-gated when Foundry isn't configured — no mock list).
  let agents: { configured: boolean; list: Array<{ name: string; description?: string }>; gate?: { code: string; error: string; hint?: string; missing?: string } };
  try {
    const projectId = getProjectId(); // throws when unconfigured
    const list = await listAgents(projectId);
    agents = {
      configured: true,
      list: list.map((a) => ({ name: a.name, description: a.description })),
    };
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      agents = {
        configured: false,
        list: [],
        gate: { code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
      };
    } else {
      const msg = e instanceof FoundryAgentError ? e.message : (e?.message || String(e));
      agents = { configured: false, list: [], gate: { code: 'error', error: msg } };
    }
  }

  // Red-team scans (never fails the whole snapshot — degrade to empty).
  let redTeam: RedTeamItemSummary[] = [];
  let redTeamError: string | undefined;
  try {
    redTeam = await loadRedTeam();
  } catch (e: any) {
    redTeamError = e?.message || String(e);
  }

  return apiOk({
    agents,
    redTeam: { items: redTeam, ...(redTeamError ? { error: redTeamError } : {}) },
    slo: {
      targets: copilotSloTargets(),
      evaluations: recentCopilotSloEvaluations(),
      window: copilotLatencyWindow(),
    },
  }) as NextResponse;
}

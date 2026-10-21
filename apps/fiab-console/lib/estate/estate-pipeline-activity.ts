/**
 * ESTATE PIPELINE ACTIVITY — recent ADF / Synapse pipeline runs, read SERVER-SIDE
 * for idle auto-pause (PRP-02 step 3, #4876).
 *
 * WHY THE CONSOLE READS THIS, NOT THE RUNNER. `scripts/estate-power/autopause.mjs`
 * used to list pipeline runs from the GitHub runner. The Synapse pipeline-run API
 * is data-plane on the workspace endpoint, and the Loom workspace denies public
 * network access — measured 2026-10-19 (run 39242926745):
 *   Forbidden {"code":"PublicNetworkAccessDenied" ...}
 * so every scheduled run skipped `activity-read-failed` and auto-pause could never
 * fire. The console sits inside the VNet and already holds the identity those
 * clients use, so it performs the same read and returns it on the SP state route.
 *
 * SAME CONTRACT as `read-activity.mjs`: `{ ok: true, runs: [{startedAt, status}] }`
 * or `{ ok: false, reason }`, consumed unchanged by `idle-policy.mjs`.
 * FAIL-SAFE: a failed read, or a listing that spans more than one page, is
 * `ok: false` — a partial read is never called idle. A source that is not
 * configured on this estate contributes no runs and is NAMED in `sources`, the
 * same as the runner finding no factory/workspace in the estate's groups.
 */
import type { EstatePipelineActivity } from './estate-power-contract';

/** ADF's listPipelineRuns truncates to this many rows; reaching it means "maybe more". */
export const ADF_PAGE_CAP = 50;

export interface PipelineActivityDeps {
  env: Record<string, string | undefined>;
  listAdfRuns: (windowDays: number) => Promise<Array<{ runStart?: string | null; status?: string | null }>>;
  querySynapseRuns: (afterIso: string, beforeIso: string) => Promise<{
    value: Array<{ runStart?: string | null; status?: string | null }>;
    continuationToken?: string;
  }>;
}

async function defaultDeps(): Promise<PipelineActivityDeps> {
  const adf = await import('@/lib/azure/adf-client');
  const syn = await import('@/lib/azure/synapse-dev-client');
  return {
    env: process.env,
    listAdfRuns: (windowDays) => adf.listPipelineRuns(undefined, windowDays),
    querySynapseRuns: (after, before) => syn.queryPipelineRuns({ lastUpdatedAfter: after, lastUpdatedBefore: before }),
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function loadPipelineActivity(
  windowHours: number,
  now: number = Date.now(),
  deps?: PipelineActivityDeps,
): Promise<EstatePipelineActivity> {
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return { ok: false, reason: 'windowHours is not a positive number', sources: [] };
  }
  const d = deps ?? (await defaultDeps());
  const runs: Array<{ startedAt: string | null; status: string | null }> = [];
  const sources: string[] = [];
  const map = (x: { runStart?: string | null; status?: string | null }) => ({
    startedAt: x?.runStart ?? null,
    status: x?.status ?? null,
  });

  if (d.env.LOOM_ADF_NAME || d.env.LOOM_ADF_FACTORY) {
    sources.push('adf');
    try {
      const list = await d.listAdfRuns(windowHours / 24);
      if (!Array.isArray(list)) return { ok: false, reason: 'adf: the run listing was not an array', sources };
      if (list.length >= ADF_PAGE_CAP) {
        return { ok: false, reason: `adf: ${list.length} runs returned (the listing truncates at ${ADF_PAGE_CAP}); refusing to call a partial read idle`, sources };
      }
      runs.push(...list.map(map));
    } catch (e) {
      return { ok: false, reason: `adf: ${errText(e)}`, sources };
    }
  }

  if (d.env.LOOM_SYNAPSE_WORKSPACE) {
    sources.push('synapse');
    try {
      const after = new Date(now - windowHours * 3600 * 1000).toISOString();
      const page = await d.querySynapseRuns(after, new Date(now).toISOString());
      if (!page || !Array.isArray(page.value)) return { ok: false, reason: 'synapse: response had no value array', sources };
      if (page.continuationToken) {
        return { ok: false, reason: 'synapse: the run listing has more than one page; refusing to call a partial read idle', sources };
      }
      runs.push(...page.value.map(map));
    } catch (e) {
      return { ok: false, reason: `synapse: ${errText(e)}`, sources };
    }
  }

  return { ok: true, runs, sources };
}

/**
 * GET /api/running-workloads
 *
 * Lists the caller's currently-RUNNING notebooks + pipelines across every
 * workspace they can see, so the app-shell switcher can let them navigate BACK
 * to an in-flight run they left. Both run kinds execute server-side and are
 * decoupled from the editor being mounted, so this reads the real, persisted
 * sources of truth — never a mirror that can drift:
 *
 *   • Notebooks — Cosmos items with a live `state.pendingRuns` entry (the run
 *     route writes it on dispatch; the poll route deletes it on terminal Livy
 *     state). Zombie entries older than the run-time bound are ignored.
 *   • Pipelines — the live Azure Data Factory monitor API (`listPipelineRuns`),
 *     filtered to ACTIVE runs and matched back to the owning Loom item by the
 *     bound factory-pipeline name. ADF is the single source of truth.
 *
 * Honest gate: when ADF is not configured, pipelines are simply omitted (no
 * error) — notebooks still list. Response: { ok, workloads: RunningWorkload[] }.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiError, apiServerError } from '@/lib/api/respond';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace-access';
import {
  collectRunningNotebooks,
  matchRunningPipelines,
  orderWorkloads,
  type NotebookRunItem,
  type PipelineBindItem,
  type AdfRunLite,
} from '@/lib/workloads/running-workloads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The longest a notebook run can execute before the poll loop times out is
// ~12 min; give generous headroom so we drop only true zombie pendingRuns.
const NOTEBOOK_STALE_MS = 30 * 60 * 1000;

export async function GET() {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);

  try {
    const oid = session.claims.oid;
    const workspaces = await listAccessibleWorkspaces(oid, { callerTid: session.claims.tid });
    const wsIds = workspaces.map((w) => w.id).filter(Boolean);
    if (wsIds.length === 0) return NextResponse.json({ ok: true, workloads: [] });

    const items = await itemsContainer();
    const wsParams = wsIds.map((_, i) => `@ws${i}`);
    const parameters = wsIds.map((v, i) => ({ name: `@ws${i}`, value: v }));

    // Notebooks with a live pending run (projected — no heavy state blob).
    const nbQuery =
      `SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state.pendingRuns ` +
      `FROM c WHERE c.itemType = 'notebook' AND c.workspaceId IN (${wsParams.join(', ')}) ` +
      `AND IS_DEFINED(c.state.pendingRuns)`;
    const { resources: nbRows } = await items.items
      .query<NotebookRunItem>({ query: nbQuery, parameters })
      .fetchAll();
    const staleBefore = new Date(Date.now() - NOTEBOOK_STALE_MS).toISOString();
    const notebooks = collectRunningNotebooks(nbRows, staleBefore);

    // Bound pipeline items (both the native adf-pipeline binding + the
    // data-pipeline alias) — the name → item map for ADF-run matching.
    const pipeQuery =
      `SELECT c.id, c.workspaceId, c.itemType, c.displayName, ` +
      `c.state.adfPipelineName, c.state.pipelineName ` +
      `FROM c WHERE c.itemType IN ('data-pipeline', 'adf-pipeline') ` +
      `AND c.workspaceId IN (${wsParams.join(', ')}) ` +
      `AND (IS_DEFINED(c.state.adfPipelineName) OR IS_DEFINED(c.state.pipelineName))`;
    const { resources: pipeRows } = await items.items
      .query<PipelineBindItem>({ query: pipeQuery, parameters })
      .fetchAll();

    // Live ADF runs (best-effort — omit pipelines entirely if ADF is not
    // configured / unreachable, rather than failing the whole switcher).
    let pipelines: ReturnType<typeof matchRunningPipelines> = [];
    if (pipeRows.length > 0) {
      try {
        const { listPipelineRuns } = await import('@/lib/azure/adf-client');
        const runs = (await listPipelineRuns(undefined, 1)) as AdfRunLite[];
        pipelines = matchRunningPipelines(pipeRows, runs);
      } catch {
        /* ADF not configured / unreachable — notebooks still list (honest). */
      }
    }

    return NextResponse.json({ ok: true, workloads: orderWorkloads([...notebooks, ...pipelines]) });
  } catch (e) {
    return apiServerError(e, 'failed to list running workloads', 'running_workloads_error');
  }
}

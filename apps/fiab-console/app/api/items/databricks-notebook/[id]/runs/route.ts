/**
 * GET /api/items/databricks-notebook/[id]/runs?runId=12345
 *   (runId set) → { ok, run, output }    — this notebook's run, with cell output
 *   (no runId)  → { ok, runs }            — this notebook's recent runs
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This route had the same shape as the
 * ADX routes in that advisory on a different backend: `GET(req)` did not accept
 * `ctx` at all, so `[id]` was never read; `listJobRuns(undefined, 25)` returned
 * recent runs across the ENTIRE shared Databricks workspace every Loom tenant
 * sits on; and `getRunOutput(runId)` returned NOTEBOOK CELL OUTPUT for any run
 * id a caller named. Read-only, but cross-tenant — and cell output is the
 * notebook's actual results, not just metadata.
 *
 * It is the one route the #2988 sweep of this family left behind: `[id]/run`,
 * `[id]/command`, `[id]/context` and `[id]/schedule` all adopted
 * `_lib/notebook-exec-scope.ts` + `_lib/notebook-path-scope.ts` then; this one
 * did not, because it never consumed `[id]` and so did not look like a route
 * with an id to enforce.
 *
 * Both layers now, matching its siblings exactly:
 *   LAYER 1 — {@link authorizeNotebookItem} runs the canonical
 *     `authorizeItemWorkspace` ladder against the notebook item.
 *   LAYER 2 — every run is bound to that item's own workspace-path scope via
 *     {@link scopeDbxNotebookPath}. Scoping by NOTEBOOK PATH rather than by job
 *     id is deliberate: `[id]/run` submits one-off runs through
 *     `jobs/runs/submit`, which produces runs with no job of their own, so a
 *     job-id filter would have silently emptied the editor's run history.
 *
 * FAIL CLOSED. A run whose notebook path cannot be determined is OUT of scope —
 * an unverifiable run is not an authorized one — and a run touching ANY path
 * outside the item's scope is refused even if it also touches an in-scope one.
 *
 * SCOPE NARROWING, disclosed rather than implied: `authorizeNotebookItem` is
 * WRITE-scoped and makes `allowReadRoles` inexpressible on purpose (see
 * `_lib/notebook-exec-scope.ts` — every other consumer EXECUTES). This GET is
 * read-only, so that is stricter than it needs to be, and a shared read-only
 * Viewer who could previously see run history now gets a 404. It is kept
 * deliberately: `[id]/schedule`'s read-only GET in this same family is held to
 * the same bar for the same reason, and widening the wrapper to admit read roles
 * would put an `allowReadRoles` parameter back within reach of the four handlers
 * that execute code. Loosening it belongs in a change that only touches this
 * surface, not in an advisory fix.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listJobRunsPage, getJobRun, getRunOutput, JOB_RUNS_PAGE_MAX, type JobRun,
} from '@/lib/azure/databricks-client';
import { scopeDbxNotebookPath } from '../../_lib/notebook-path-scope';
import { authorizeNotebookItem } from '../../_lib/notebook-exec-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How many PAGES of the shared workspace's history to walk before giving up.
 *
 * Jobs 2.1 documents `runs/list` limit as "greater than 0 and less than 25", so
 * a single `limit=200` call is a contract violation: the workspace either 400s
 * (the route dies for everyone) or clamps to 25 — and on a busy shared
 * workspace those 25 can all be other tenants' runs, which this route then
 * filters away, handing the owner an EMPTY history. Paging keeps every request
 * inside the documented cap while still reaching back far enough to find this
 * notebook's runs. Bounded so a workspace with a very long foreign history
 * cannot turn one editor open into an unbounded fan-out.
 */
const MAX_PAGES = 8;
/** How many in-scope runs to return (the shape the editor already renders). */
const RETURNED_RUNS = 25;

/** Every notebook path this run touches. Empty when the run declares none. */
function runNotebookPaths(run: JobRun): string[] {
  const out: string[] = [];
  for (const t of run.tasks || []) {
    const p = t?.notebook_task?.notebook_path;
    if (typeof p === 'string' && p) out.push(p);
  }
  // Legacy single-task runs put the notebook_task at the run root.
  const legacy = (run as unknown as { task?: { notebook_task?: { notebook_path?: string } } }).task
    ?.notebook_task?.notebook_path;
  if (typeof legacy === 'string' && legacy) out.push(legacy);
  return out;
}

/**
 * Is this run one THIS notebook item may see? True only when it declares at
 * least one notebook path and EVERY declared path resolves inside the item's
 * own scope. A multi-task run that also touches another tenant's notebook is
 * out of scope: its output would carry that notebook's results.
 */
function runInScope(run: JobRun, item: WorkspaceItem, itemId: string): boolean {
  const paths = runNotebookPaths(run);
  if (paths.length === 0) return false;
  return paths.every((p) => scopeDbxNotebookPath(item, itemId, p).ok);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeNotebookItem(id, req.nextUrl.searchParams.get('workspaceId'));
  if (denied) return denied;

  const runIdParam = req.nextUrl.searchParams.get('runId');
  try {
    if (runIdParam) {
      const runId = Number(runIdParam);
      if (!Number.isFinite(runId))
        return NextResponse.json({ ok: false, error: 'runId must be a number' }, { status: 400 });
      const run = await getJobRun(runId);
      // LAYER 2 — bind the caller-supplied run id BEFORE fetching its output.
      // 404 (not 403) keeps the route from confirming which run ids exist.
      if (!runInScope(run, item, id)) {
        return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      }
      const output = await getRunOutput(runId).catch(() => null);
      return NextResponse.json({ ok: true, run, output });
    }
    // LAYER 2 — the listing is filtered to this item's own scope, so it can no
    // longer enumerate the shared workspace's run history. Paged within the
    // documented per-request cap; see MAX_PAGES.
    const runs: JobRun[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES && runs.length < RETURNED_RUNS; page++) {
      const { runs: batch, nextPageToken } = await listJobRunsPage({
        limit: JOB_RUNS_PAGE_MAX,
        expandTasks: true,
        pageToken,
      });
      for (const r of batch) {
        if (runInScope(r, item, id)) runs.push(r);
      }
      if (!nextPageToken || batch.length === 0) break;
      pageToken = nextPageToken;
    }
    return NextResponse.json({ ok: true, runs: runs.slice(0, RETURNED_RUNS) });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/**
 * POST /api/items/databricks-notebook/[id]/run
 *   body { path, clusterId?, params?: Record<string,string>, runName?, workspaceId? }
 *   → { ok, run_id, path, clusterId }
 *
 * Submits a one-off notebook run (`jobs/runs/submit`) against the item's
 * notebook.
 *
 * SECURITY (#2988). This is the SECOND arbitrary-execution hole in this family
 * and it shipped in the same shape as `[id]/command`: the handler did not accept
 * `ctx.params` (so `[id]` was never read), ran only a bare `getSession()`, and
 * passed a caller-chosen `path` AND a caller-chosen `clusterId` straight to
 * `runNotebook`. Executing another tenant's notebook is executing their code —
 * as the Console's UAMI, on the shared workspace. Both coordinates are now
 * bound: the caller is authorized against the item (WRITE-scoped — a run is a
 * mutation), the path is confined to the item's own folder via
 * `_lib/notebook-path-scope.ts`, and the cluster is derived or
 * entitlement-checked via `_lib/notebook-exec-scope.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runNotebook } from '@/lib/azure/databricks-client';
import { scopeDbxNotebookPath } from '../../_lib/notebook-path-scope';
import { authorizeNotebookItem, resolveAuthorizedClusterId } from '../../_lib/notebook-exec-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const { item, denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;

  const scoped = scopeDbxNotebookPath(item, id, body?.path);
  if (!scoped.ok) {
    return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  }

  const cluster = await resolveAuthorizedClusterId(body?.clusterId, { autoStart: false });
  if (!cluster.ok) {
    return NextResponse.json(
      { ok: false, error: cluster.error, ...(cluster.remediation ? { remediation: cluster.remediation } : {}) },
      { status: cluster.status },
    );
  }

  try {
    const r = await runNotebook(scoped.path, cluster.clusterId, body?.params, body?.runName);
    return NextResponse.json({ ok: true, ...r, path: scoped.path, clusterId: cluster.clusterId });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

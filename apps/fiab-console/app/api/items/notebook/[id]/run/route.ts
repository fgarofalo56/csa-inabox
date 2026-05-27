/**
 * POST /api/items/notebook/[id]/run?workspaceId=...
 *   body: { compute: 'spark:<poolName>' | 'databricks:<clusterId>' }
 *
 * v3.24 — async pattern (Front Door has a hard 30s timeout, so we can't
 * block waiting for Spark cold-start). Returns immediately with a runId
 * the client can poll via /api/items/notebook/[id]/runs/[runId].
 *
 * For Synapse Spark: creates the Livy session, returns its ID.
 * For Databricks: submits the run, returns its ID.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, hint?: string) {
  return NextResponse.json({ ok: false, error, hint }, { status });
}

async function loadNotebook(id: string, workspaceId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    return (resource && resource.itemType === 'notebook') ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const compute: string = body?.compute || '';
  if (!compute) return err('compute required', 400);

  try {
    const nb = await loadNotebook(ctx.params.id, workspaceId);
    if (!nb) return err('notebook not found', 404);
    // Per-cell run path: caller passes { source, lang, cellId } — we run
    // only that cell's source. Fallback to notebook-level `code` blob.
    const state = (nb.state as any) || {};
    const cellSource = typeof body?.source === 'string' ? body.source : '';
    const cellLang = typeof body?.lang === 'string' ? body.lang : '';
    const cellId = typeof body?.cellId === 'string' ? body.cellId : '';
    const code = cellSource || state.code || '';
    if (!code.trim()) return err('notebook is empty — write code before running', 400);

    // Map cell-lang to the statement-kind that Livy / Databricks expects.
    // Livy session-kind affects cold-start; statement-kind controls per-cell
    // interpretation. We always start a 'pyspark' session because it can
    // host pyspark / spark / sql / sparkr statements via per-statement kind
    // override (sparkr requires its own session kind, handled separately).
    function statementKind(): 'pyspark' | 'spark' | 'sql' | 'sparkr' {
      const l = (cellLang || state.lang || 'pyspark').toLowerCase();
      if (l === 'sparksql' || l === 'spark-sql' || l === 'sql') return 'sql';
      if (l === 'spark' || l === 'scala') return 'spark';
      if (l === 'sparkr' || l === 'r') return 'sparkr';
      return 'pyspark'; // python / pyspark / unspecified
    }
    function sessionKind(stmt: 'pyspark' | 'spark' | 'sql' | 'sparkr'): 'pyspark' | 'spark' | 'sparkr' | 'sql' {
      // Livy interactive sessions are typed; per-statement override works for
      // sql + spark + pyspark within a pyspark session, but NOT sparkr.
      if (stmt === 'sparkr') return 'sparkr';
      return 'pyspark';
    }
    function tsqlMode(): boolean {
      const l = (cellLang || state.lang || '').toLowerCase();
      return l === 'tsql' || l === 't-sql';
    }
    const stmtKind = statementKind();
    const sessKind = sessionKind(stmtKind);
    if (tsqlMode()) {
      // T-SQL belongs to Synapse Dedicated / Serverless, not Spark — route
      // the user to the right editor instead of stalling on Livy.
      return NextResponse.json({
        ok: false,
        error: 'T-SQL cells run on a SQL pool, not a Spark pool. Open the Warehouse or Synapse SQL pool editor and run the query there.',
      }, { status: 400 });
    }

    if (compute.startsWith('spark:')) {
      const pool = compute.slice('spark:'.length);
      const { createLivySessionAsync } = await import('@/lib/azure/synapse-dev-client');
      const sess = await createLivySessionAsync(pool, sessKind);
      const runIdStr = `spark:${pool}:${sess.id}`;
      if (cellSource) {
        try {
          const items = await itemsContainer();
          const pendingRuns = { ...(state.pendingRuns || {}) };
          pendingRuns[runIdStr] = { source: cellSource, lang: stmtKind, cellId };
          await items.item(nb.id, workspaceId).replace({
            ...nb,
            state: { ...state, pendingRuns },
            updatedAt: new Date().toISOString(),
          } as WorkspaceItem);
        } catch { /* non-fatal — poll will fall back to state.code */ }
      }
      return NextResponse.json({
        ok: true,
        runId: runIdStr,
        status: sess.state,
        compute: { kind: 'synapse-spark', pool },
        cellId: cellId || null,
        sourcePreview: code.slice(0, 200),
      });
    }

    if (compute.startsWith('databricks:')) {
      const clusterId = compute.slice('databricks:'.length);
      const { runOneTimeNotebook } = await import('@/lib/azure/databricks-client');
      const dbLang =
        stmtKind === 'spark' ? 'SCALA' :
        stmtKind === 'sql' ? 'SQL' :
        stmtKind === 'sparkr' ? 'R' :
        'PYTHON';
      const runRes = await runOneTimeNotebook({
        clusterId,
        code,
        lang: dbLang,
        jobName: `loom-${nb.displayName.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40)}${cellId ? '-' + cellId.slice(0, 6) : ''}`,
      });
      return NextResponse.json({
        ok: true,
        runId: `databricks:${runRes.run_id}`,
        status: 'PENDING',
        compute: { kind: 'databricks-cluster', clusterId },
        runUrl: runRes.run_page_url,
        cellId: cellId || null,
      });
    }

    return err(`unsupported compute kind: ${compute.split(':')[0]}`, 400);
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502, e?.hint);
  }
}

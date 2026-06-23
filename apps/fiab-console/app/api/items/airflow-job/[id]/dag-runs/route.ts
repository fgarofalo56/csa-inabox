/**
 * GET /api/items/airflow-job/[id]/dag-runs?workspaceId=...&dagId=...
 *
 * Lists recent DAG runs for a DAG via the Airflow webserver REST
 * `/api/v1/dags/{dag_id}/dagRuns` (ordered newest-first). Same auth + honest
 * gate model as the sibling /dags route — forwards the optional
 * LOOM_AIRFLOW_BEARER and returns { ok:false, code:'NO_WEBSERVER' } when the
 * item has no webserver URL configured so the editor renders the documented gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const dagId = req.nextUrl.searchParams.get('dagId');
  if (!dagId) return err('dagId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
    const webserverUrl: string | null = ((resource.state || {}) as any).webserverUrl || null;
    if (!webserverUrl) {
      return err('Airflow webserver URL not configured for this item', 503, {
        code: 'NO_WEBSERVER',
        hint: 'In the Settings tab, paste the Airflow webserver URL. See docs/fiab/v3-tenant-bootstrap.md for the AAD role + bearer-token mint steps.',
      });
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.LOOM_AIRFLOW_BEARER) headers.authorization = `Bearer ${process.env.LOOM_AIRFLOW_BEARER}`;

    let url: URL;
    try {
      url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns`, webserverUrl);
      url.searchParams.set('order_by', '-start_date');
      url.searchParams.set('limit', '50');
    } catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!r.ok) {
      return err(`Airflow ${r.status}: ${body?.title || body?.detail || text.slice(0, 240)}`, r.status, { webserverUrl });
    }

    return NextResponse.json({
      ok: true,
      webserverUrl,
      dagId,
      total: body?.total_entries ?? (body?.dag_runs || []).length,
      runs: (body?.dag_runs || []).map((d: any) => ({
        dag_run_id: d.dag_run_id,
        state: d.state,
        run_type: d.run_type,
        logical_date: d.logical_date || d.execution_date,
        start_date: d.start_date,
        end_date: d.end_date,
      })),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

/**
 * GET  /api/items/airflow-job/[id]/dag-runs?workspaceId=...&dagId=...
 *   Lists recent DAG runs for a DAG via the Airflow webserver REST
 *   `/api/v1/dags/{dag_id}/dagRuns` (ordered newest-first).
 *
 * POST /api/items/airflow-job/[id]/dag-runs?workspaceId=...
 *   body: { dagId: string, conf?: object, note?: string, logicalDate?: string }
 *   Triggers a NEW DAG run via `POST /api/v1/dags/{dag_id}/dagRuns` — the same
 *   real Airflow REST the webserver "Trigger DAG" button calls. Returns the
 *   created run id + state.
 *
 * Both share the auth + honest-gate model: forwards the optional
 * LOOM_AIRFLOW_BEARER and returns { ok:false, code:'NO_WEBSERVER' } when the
 * item has no webserver URL configured so the editor renders the documented gate.
 * Azure-native managed Apache Airflow (Workflow Orchestration Manager) — no Fabric.
 *
 * Docs: https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html#operation/post_dag_run
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

const NO_WEBSERVER_HINT =
  'In the Settings tab, paste the Airflow webserver URL. See docs/fiab/v3-tenant-bootstrap.md for the AAD role + bearer-token mint steps.';

/** Resolve the item's stored webserver URL or return the honest NO_WEBSERVER gate. */
async function resolveWebserver(id: string, workspaceId: string): Promise<{ webserverUrl: string } | NextResponse> {
  const items = await itemsContainer();
  const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
  if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
  const webserverUrl: string | null = ((resource.state || {}) as any).webserverUrl || null;
  if (!webserverUrl) return err('Airflow webserver URL not configured for this item', 503, { code: 'NO_WEBSERVER', hint: NO_WEBSERVER_HINT });
  return { webserverUrl };
}

function airflowHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (process.env.LOOM_AIRFLOW_BEARER) headers.authorization = `Bearer ${process.env.LOOM_AIRFLOW_BEARER}`;
  return headers;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const dagId = req.nextUrl.searchParams.get('dagId');
  if (!dagId) return err('dagId required', 400);
  try {
    const resolved = await resolveWebserver((await ctx.params).id, workspaceId);
    if (resolved instanceof NextResponse) return resolved;
    const { webserverUrl } = resolved;
    const headers = airflowHeaders();

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({} as any));
  const dagId = String(body?.dagId || '').trim();
  if (!dagId) return err('dagId required', 400);
  try {
    const resolved = await resolveWebserver((await ctx.params).id, workspaceId);
    if (resolved instanceof NextResponse) return resolved;
    const { webserverUrl } = resolved;

    let url: URL;
    try { url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns`, webserverUrl); }
    catch { return err('webserverUrl invalid on stored item', 400); }

    // Airflow assigns a run id when omitted; pass conf/note/logical_date when provided.
    const runBody: Record<string, unknown> = {};
    if (body?.conf && typeof body.conf === 'object') runBody.conf = body.conf;
    if (body?.note) runBody.note = String(body.note);
    if (body?.logicalDate) runBody.logical_date = String(body.logicalDate);

    const r = await fetch(url.toString(), {
      method: 'POST', headers: airflowHeaders(), cache: 'no-store', body: JSON.stringify(runBody),
    });
    const text = await r.text();
    let resp: any = null;
    try { resp = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    if (!r.ok) {
      return err(`Airflow ${r.status}: ${resp?.title || resp?.detail || text.slice(0, 240)}`, r.status, { webserverUrl });
    }
    return NextResponse.json({
      ok: true,
      triggered: true,
      dagId,
      run: {
        dag_run_id: resp?.dag_run_id,
        state: resp?.state,
        run_type: resp?.run_type,
        logical_date: resp?.logical_date || resp?.execution_date,
        start_date: resp?.start_date,
      },
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

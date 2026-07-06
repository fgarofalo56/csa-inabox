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
 * Both share the auth + honest-gate model via resolveAirflowConn/airflowAuthHeaders:
 * the day-one managed host (LOOM_AIRFLOW_ENDPOINT + Basic auth) is the default, a
 * per-item BYO webserver URL is an opt-in override, and { ok:false,
 * code:'NO_WEBSERVER' } is returned when neither is set so the editor renders the
 * documented gate. Azure-native managed Apache Airflow — no Fabric.
 *
 * Docs: https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html#operation/post_dag_run
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError, apiError } from '@/lib/api/respond';
import { resolveAirflowConn, airflowAuthHeaders, AIRFLOW_NO_WEBSERVER_HINT, type AirflowConn } from '@/lib/airflow/endpoint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

/** Resolve the item's effective Airflow webserver or return the honest NO_WEBSERVER gate. */
async function resolveWebserver(id: string, workspaceId: string): Promise<AirflowConn | NextResponse> {
  const items = await itemsContainer();
  const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
  if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
  const conn = resolveAirflowConn(resource.state as Record<string, unknown> | undefined);
  if (!conn) return err('No Airflow webserver available for this item', 503, { code: 'NO_WEBSERVER', hint: AIRFLOW_NO_WEBSERVER_HINT });
  return conn;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('airflow job not found', 404);
  const dagId = req.nextUrl.searchParams.get('dagId');
  if (!dagId) return err('dagId required', 400);
  try {
    const resolved = await resolveWebserver((await ctx.params).id, workspaceId);
    if (resolved instanceof NextResponse) return resolved;
    const conn = resolved;
    const headers = airflowAuthHeaders(conn, { 'content-type': 'application/json' });

    let url: URL;
    try {
      url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns`, conn.webserverUrl);
      url.searchParams.set('order_by', '-start_date');
      url.searchParams.set('limit', '50');
    } catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!r.ok) {
      return err(`Airflow ${r.status}: ${body?.title || body?.detail || text.slice(0, 240)}`, r.status, { webserverUrl: conn.webserverUrl });
    }

    return NextResponse.json({
      ok: true,
      webserverUrl: conn.webserverUrl,
      managed: conn.managed,
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
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('airflow job not found', 404);
  const body = await req.json().catch(() => ({} as any));
  const dagId = String(body?.dagId || '').trim();
  if (!dagId) return err('dagId required', 400);
  try {
    const resolved = await resolveWebserver((await ctx.params).id, workspaceId);
    if (resolved instanceof NextResponse) return resolved;
    const conn = resolved;

    let url: URL;
    try { url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns`, conn.webserverUrl); }
    catch { return err('webserverUrl invalid on stored item', 400); }

    // Airflow assigns a run id when omitted; pass conf/note/logical_date when provided.
    const runBody: Record<string, unknown> = {};
    if (body?.conf && typeof body.conf === 'object') runBody.conf = body.conf;
    if (body?.note) runBody.note = String(body.note);
    if (body?.logicalDate) runBody.logical_date = String(body.logicalDate);

    const r = await fetch(url.toString(), {
      method: 'POST', headers: airflowAuthHeaders(conn, { 'content-type': 'application/json' }), cache: 'no-store', body: JSON.stringify(runBody),
    });
    const text = await r.text();
    let resp: any = null;
    try { resp = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    if (!r.ok) {
      return err(`Airflow ${r.status}: ${resp?.title || resp?.detail || text.slice(0, 240)}`, r.status, { webserverUrl: conn.webserverUrl });
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
    return apiServerError(e);
  }
}

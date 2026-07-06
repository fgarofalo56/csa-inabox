/**
 * GET /api/items/airflow-job/[id]/dags?workspaceId=...
 *
 * Calls the Airflow webserver REST `/api/v1/dags`. The webserver is resolved by
 * resolveAirflowConn: the day-one managed host (LOOM_AIRFLOW_ENDPOINT, the
 * Azure-native default) OR a per-item BYO webserver URL (opt-in override). When
 * neither is available returns { ok: false, code: 'NO_WEBSERVER' } so the editor
 * renders the documented MessageBar.
 *
 * Auth (airflowAuthHeaders): Basic (LOOM_AIRFLOW_USERNAME/_PASSWORD) for the
 * managed host — WOM/Fabric "Basic authentication" mode — or Bearer
 * (LOOM_AIRFLOW_BEARER) for a BYO webserver behind AAD ingress.
 * Azure-native managed Apache Airflow — no Fabric (no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError, apiError } from '@/lib/api/respond';
import { resolveAirflowConn, airflowAuthHeaders, AIRFLOW_NO_WEBSERVER_HINT } from '@/lib/airflow/endpoint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('airflow job not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
    const conn = resolveAirflowConn(resource.state as Record<string, unknown> | undefined);
    if (!conn) {
      return err('No Airflow webserver available for this item', 503, {
        code: 'NO_WEBSERVER',
        hint: AIRFLOW_NO_WEBSERVER_HINT,
      });
    }

    const headers = airflowAuthHeaders(conn);

    let url: URL;
    try { url = new URL('/api/v1/dags', conn.webserverUrl); }
    catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!r.ok) {
      return err(`Airflow ${r.status}: ${body?.title || body?.detail || text.slice(0, 240)}`, r.status, {
        webserverUrl: conn.webserverUrl,
      });
    }

    return NextResponse.json({
      ok: true,
      webserverUrl: conn.webserverUrl,
      managed: conn.managed,
      total: body?.total_entries ?? (body?.dags || []).length,
      dags: (body?.dags || []).map((d: any) => ({
        dag_id: d.dag_id,
        is_paused: d.is_paused,
        is_active: d.is_active,
        owners: d.owners,
        description: d.description,
        schedule_interval: d.schedule_interval?.value || d.schedule_interval,
        next_dagrun: d.next_dagrun,
      })),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * PATCH /api/items/airflow-job/[id]/dags?workspaceId=...
 *   body: { dagId: string, isPaused: boolean }
 * Pauses / unpauses a DAG via `PATCH /api/v1/dags/{dag_id}?update_mask=is_paused`
 * (real Airflow REST — the webserver's pause toggle). Same NO_WEBSERVER gate.
 * Docs: https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html#operation/patch_dag
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('airflow job not found', 404);
  const body = await req.json().catch(() => ({} as any));
  const dagId = String(body?.dagId || '').trim();
  if (!dagId) return err('dagId required', 400);
  if (typeof body?.isPaused !== 'boolean') return err('isPaused (boolean) required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
    const conn = resolveAirflowConn(resource.state as Record<string, unknown> | undefined);
    if (!conn) {
      return err('No Airflow webserver available for this item', 503, {
        code: 'NO_WEBSERVER',
        hint: AIRFLOW_NO_WEBSERVER_HINT,
      });
    }
    const headers = airflowAuthHeaders(conn, { 'content-type': 'application/json' });

    let url: URL;
    try {
      url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}`, conn.webserverUrl);
      url.searchParams.set('update_mask', 'is_paused');
    } catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), {
      method: 'PATCH', headers, cache: 'no-store', body: JSON.stringify({ is_paused: body.isPaused }),
    });
    const text = await r.text();
    let resp: any = null;
    try { resp = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    if (!r.ok) {
      return err(`Airflow ${r.status}: ${resp?.title || resp?.detail || text.slice(0, 240)}`, r.status, { webserverUrl: conn.webserverUrl });
    }
    return NextResponse.json({ ok: true, dagId, is_paused: resp?.is_paused ?? body.isPaused });
  } catch (e: any) {
    return apiServerError(e);
  }
}

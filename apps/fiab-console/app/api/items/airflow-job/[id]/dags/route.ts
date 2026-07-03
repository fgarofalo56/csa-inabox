/**
 * GET /api/items/airflow-job/[id]/dags?workspaceId=...
 *
 * Calls the Airflow webserver REST `/api/v1/dags`. If no webserver URL is
 * configured for this item, returns { ok: false, code: 'NO_WEBSERVER' } so
 * the editor can render the documented MessageBar.
 *
 * Auth: forwards the optional bearer token configured via env
 * LOOM_AIRFLOW_BEARER. Many self-hosted Airflows deployed alongside Fabric
 * use AAD-protected ingress — in that case the UAMI must have the relevant
 * app role and the deployment scripts (scripts/csa-loom/airflow-bootstrap.sh)
 * mint the token. Until that script runs the call returns 401 from the
 * webserver and Loom surfaces it verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
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
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('airflow job not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'airflow-job') return err('airflow job not found', 404);
    const webserverUrl: string | null = ((resource.state || {}) as any).webserverUrl || null;
    if (!webserverUrl) {
      return err(
        'Airflow webserver URL not configured for this item',
        503,
        {
          code: 'NO_WEBSERVER',
          hint: 'In the Settings tab, paste the Airflow webserver URL (e.g. https://airflow.contoso.com). See docs/fiab/v3-tenant-bootstrap.md for the AAD role-assignment + bearer-token mint steps.',
        },
      );
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.LOOM_AIRFLOW_BEARER) headers.authorization = `Bearer ${process.env.LOOM_AIRFLOW_BEARER}`;

    let url: URL;
    try { url = new URL('/api/v1/dags', webserverUrl); }
    catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!r.ok) {
      return err(`Airflow ${r.status}: ${body?.title || body?.detail || text.slice(0, 240)}`, r.status, {
        webserverUrl,
      });
    }

    return NextResponse.json({
      ok: true,
      webserverUrl,
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
    return err(e?.message || String(e), 500);
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
    const webserverUrl: string | null = ((resource.state || {}) as any).webserverUrl || null;
    if (!webserverUrl) {
      return err('Airflow webserver URL not configured for this item', 503, {
        code: 'NO_WEBSERVER',
        hint: 'In the Settings tab, paste the Airflow webserver URL. See docs/fiab/v3-tenant-bootstrap.md for the AAD role + bearer-token mint steps.',
      });
    }
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    if (process.env.LOOM_AIRFLOW_BEARER) headers.authorization = `Bearer ${process.env.LOOM_AIRFLOW_BEARER}`;

    let url: URL;
    try {
      url = new URL(`/api/v1/dags/${encodeURIComponent(dagId)}`, webserverUrl);
      url.searchParams.set('update_mask', 'is_paused');
    } catch { return err('webserverUrl invalid on stored item', 400); }

    const r = await fetch(url.toString(), {
      method: 'PATCH', headers, cache: 'no-store', body: JSON.stringify({ is_paused: body.isPaused }),
    });
    const text = await r.text();
    let resp: any = null;
    try { resp = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    if (!r.ok) {
      return err(`Airflow ${r.status}: ${resp?.title || resp?.detail || text.slice(0, 240)}`, r.status, { webserverUrl });
    }
    return NextResponse.json({ ok: true, dagId, is_paused: resp?.is_paused ?? body.isPaused });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

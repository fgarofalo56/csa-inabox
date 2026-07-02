/**
 * GET /api/items/airflow-job/[id]/task-logs?workspaceId=...&dagId=...&runId=...[&taskId=&tryNumber=]
 *
 * Without taskId: lists the task instances for a DAG run via the Airflow
 *   webserver REST `GET /api/v1/dags/{dag_id}/dagRuns/{dag_run_id}/taskInstances`
 *   (state + try_number per task).
 * With taskId (+ optional tryNumber, default 1): fetches the task log via
 *   `GET /api/v1/dags/{dag_id}/dagRuns/{dag_run_id}/taskInstances/{task_id}/logs/{try}`.
 *
 * Same auth + honest-gate model as the sibling /dags and /dag-runs routes.
 * Azure-native managed Apache Airflow (Workflow Orchestration Manager) — no Fabric.
 * Docs: https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html#operation/get_task_instances
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
  const sp = req.nextUrl.searchParams;
  const workspaceId = sp.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const dagId = sp.get('dagId');
  const runId = sp.get('runId');
  if (!dagId || !runId) return err('dagId and runId required', 400);
  const taskId = sp.get('taskId');
  const tryNumber = sp.get('tryNumber') || '1';
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

    const base = `/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances`;

    // Single-task log fetch (plain text).
    if (taskId) {
      let logUrl: URL;
      try { logUrl = new URL(`${base}/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(tryNumber)}`, webserverUrl); }
      catch { return err('webserverUrl invalid on stored item', 400); }
      const r = await fetch(logUrl.toString(), { headers: { ...headers, accept: 'text/plain' }, cache: 'no-store' });
      const text = await r.text();
      if (!r.ok) return err(`Airflow ${r.status}: ${text.slice(0, 240)}`, r.status, { webserverUrl });
      return NextResponse.json({ ok: true, dagId, runId, taskId, tryNumber, log: text });
    }

    // Task-instance list for the run.
    let listUrl: URL;
    try { listUrl = new URL(base, webserverUrl); }
    catch { return err('webserverUrl invalid on stored item', 400); }
    const r = await fetch(listUrl.toString(), { headers, cache: 'no-store' });
    const txt = await r.text();
    let bd: any = null;
    try { bd = txt ? JSON.parse(txt) : null; } catch { /* leave as text */ }
    if (!r.ok) return err(`Airflow ${r.status}: ${bd?.title || bd?.detail || txt.slice(0, 240)}`, r.status, { webserverUrl });
    return NextResponse.json({
      ok: true,
      dagId,
      runId,
      tasks: (bd?.task_instances || []).map((t: any) => ({
        task_id: t.task_id,
        state: t.state,
        try_number: t.try_number,
        start_date: t.start_date,
        end_date: t.end_date,
        duration: t.duration,
        operator: t.operator,
      })),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

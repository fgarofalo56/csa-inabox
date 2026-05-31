/**
 * /api/powerbi/[group] — the Power BI **workspace navigator** BFF.
 *
 * One session-guarded route family backing the `powerbi-tree` navigator. The
 * `[group]` segment selects the Power BI object collection for a given
 * workspace (Power BI groupId, passed as `?workspaceId=`):
 *
 *   GET    /api/powerbi/datasets?workspaceId=W    → { ok, datasets: [...] }
 *   GET    /api/powerbi/reports?workspaceId=W     → { ok, reports:  [...] }
 *   GET    /api/powerbi/dashboards?workspaceId=W  → { ok, dashboards:[...] }
 *   GET    /api/powerbi/dataflows?workspaceId=W   → { ok, dataflows:[...] }
 *
 *   POST   /api/powerbi/datasets   { workspaceId, id, action:'refresh' }
 *   POST   /api/powerbi/dataflows  { workspaceId, id, action:'refresh' }
 *
 *   DELETE /api/powerbi/reports?workspaceId=W&id=R    → delete report
 *   DELETE /api/powerbi/dataflows?workspaceId=W&id=D  → delete dataflow
 *   DELETE /api/powerbi/datasets|dashboards           → 501 (REST unsupported)
 *
 * Every list/action hits the real Power BI REST via the existing
 * powerbi-client.ts (no mocks). The honest config-gate (LOOM_UAMI_CLIENT_ID /
 * SP authorization) returns 503; tenant authorization failures (401/403) are
 * surfaced verbatim with the SP remediation hint so the navigator can render
 * the exact one-time admin action required.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  PowerBiError,
  powerbiConfigGate,
  POWERBI_SP_HINT,
  listDatasets,
  listReports,
  listDashboards,
  listDataflows,
  refreshDataset,
  refreshDataflow,
  deleteReport,
  deleteDataflow,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GROUPS = ['datasets', 'reports', 'dashboards', 'dataflows'] as const;
type Group = (typeof GROUPS)[number];

function isGroup(g: string): g is Group {
  return (GROUPS as readonly string[]).includes(g);
}

function gate(): NextResponse | null {
  const g = powerbiConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: g.detail, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: unknown): NextResponse {
  const status = e instanceof PowerBiError ? e.status : 502;
  const message = e instanceof Error ? e.message : String(e);
  const hint = status === 401 || status === 403 ? POWERBI_SP_HINT : undefined;
  return NextResponse.json({ ok: false, error: message, hint }, { status: status >= 400 ? status : 502 });
}

function requireAuth(): NextResponse | null {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return null;
}

// ------------------------------------------------------------------ GET (list)
export async function GET(req: NextRequest, ctx: { params: Promise<{ group: string }> }) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;

  const { group } = await ctx.params;
  if (!isGroup(group)) {
    return NextResponse.json({ ok: false, error: `unknown group '${group}'` }, { status: 404 });
  }
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  if (!workspaceId) {
    return NextResponse.json({ ok: false, error: 'workspaceId query param is required' }, { status: 400 });
  }

  try {
    switch (group) {
      case 'datasets':
        return NextResponse.json({ ok: true, datasets: await listDatasets(workspaceId) });
      case 'reports':
        return NextResponse.json({ ok: true, reports: await listReports(workspaceId) });
      case 'dashboards':
        return NextResponse.json({ ok: true, dashboards: await listDashboards(workspaceId) });
      case 'dataflows':
        return NextResponse.json({ ok: true, dataflows: await listDataflows(workspaceId) });
    }
  } catch (e) {
    return fail(e);
  }
}

// --------------------------------------------------------------- POST (action)
export async function POST(req: NextRequest, ctx: { params: Promise<{ group: string }> }) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;

  const { group } = await ctx.params;
  if (!isGroup(group)) {
    return NextResponse.json({ ok: false, error: `unknown group '${group}'` }, { status: 404 });
  }
  const body = await req.json().catch(() => ({} as any));
  const workspaceId: string = (body?.workspaceId || '').trim();
  const id: string = (body?.id || '').trim();
  const action: string = body?.action || 'refresh';
  if (!workspaceId || !id) {
    return NextResponse.json({ ok: false, error: 'workspaceId and id are required' }, { status: 400 });
  }

  try {
    if (action === 'refresh' && group === 'datasets') {
      await refreshDataset(workspaceId, id, { notifyOption: 'NoNotification' });
      return NextResponse.json({ ok: true });
    }
    if (action === 'refresh' && group === 'dataflows') {
      await refreshDataflow(workspaceId, id, 'NoNotification');
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { ok: false, error: `action '${action}' is not supported for ${group}` },
      { status: 400 },
    );
  } catch (e) {
    return fail(e);
  }
}

// ------------------------------------------------------------------- DELETE
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ group: string }> }) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;

  const { group } = await ctx.params;
  if (!isGroup(group)) {
    return NextResponse.json({ ok: false, error: `unknown group '${group}'` }, { status: 404 });
  }
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!workspaceId || !id) {
    return NextResponse.json({ ok: false, error: 'workspaceId and id query params are required' }, { status: 400 });
  }

  try {
    if (group === 'reports') {
      await deleteReport(workspaceId, id);
      return NextResponse.json({ ok: true });
    }
    if (group === 'dataflows') {
      await deleteDataflow(workspaceId, id);
      return NextResponse.json({ ok: true });
    }
    // Power BI's user-scoped REST has no DELETE for datasets/dashboards.
    return NextResponse.json(
      {
        ok: false,
        error:
          group === 'datasets'
            ? 'Power BI REST does not support deleting a semantic model via the workspace API. Delete it from the Power BI service UI.'
            : 'Power BI REST does not support deleting a dashboard via the workspace API. Delete it from the Power BI service UI.',
      },
      { status: 501 },
    );
  } catch (e) {
    return fail(e);
  }
}

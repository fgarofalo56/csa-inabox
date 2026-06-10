/**
 * Delta Live Tables (Lakeflow Declarative Pipelines) — list / create / start / stop / delete.
 *
 *   GET    /api/databricks/pipelines                          → { ok, pipelines }
 *   POST   /api/databricks/pipelines                          → create pipeline (returns { pipeline_id })
 *   POST   /api/databricks/pipelines  { pipelineId, action }  → start | stop  (action='start'|'stop')
 *   DELETE /api/databricks/pipelines?pipelineId=              → delete pipeline
 *
 * Real Databricks REST (api 2.0):
 *   GET/POST   /api/2.0/pipelines
 *   POST       /api/2.0/pipelines/{id}/updates  (start) | /stop
 *   DELETE     /api/2.0/pipelines/{id}
 * Learn: https://learn.microsoft.com/azure/databricks/delta-live-tables/api-guide
 *
 * Console UAMI needs the `databricks-jobs-api-access` entitlement (granted via the
 * SCIM bootstrap) to author DLT pipelines.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listDltPipelines, createDltPipeline, startDltUpdate, stopDltUpdate, deleteDltPipeline,
  type DltPipelineLibrary,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const pipelines = await listDltPipelines();
    return NextResponse.json({ ok: true, pipelines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  // Lifecycle action on an existing pipeline.
  const action = String(body?.action || '').trim();
  const pipelineId = String(body?.pipelineId || '').trim();
  if (action) {
    if (!pipelineId) return NextResponse.json({ ok: false, error: 'pipelineId is required for an action' }, { status: 400 });
    try {
      if (action === 'start') {
        const update = await startDltUpdate(pipelineId, body?.fullRefresh === true);
        return NextResponse.json({ ok: true, update });
      }
      if (action === 'stop') {
        await stopDltUpdate(pipelineId);
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ ok: false, error: `unknown action '${action}' (expected start|stop)` }, { status: 400 });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // Create a new pipeline.
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const rawLibs = Array.isArray(body?.libraries) ? body.libraries : [];
  const libraries: DltPipelineLibrary[] = rawLibs
    .map((l: any) => {
      if (l?.notebook?.path) return { notebook: { path: String(l.notebook.path) } };
      if (l?.file?.path) return { file: { path: String(l.file.path) } };
      return null;
    })
    .filter(Boolean) as DltPipelineLibrary[];
  if (libraries.length === 0) {
    // A pipeline must have at least one source library; default to a notebook path under the name.
    libraries.push({ notebook: { path: String(body?.notebookPath || `/Workspace/${name}`) } });
  }
  try {
    const created = await createDltPipeline({
      name,
      libraries,
      continuous: body?.continuous === true,
      development: body?.development !== false,
      catalog: body?.catalog ? String(body.catalog) : undefined,
      target: body?.target ? String(body.target) : undefined,
    });
    return NextResponse.json({ ok: true, pipeline_id: created.pipeline_id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const pipelineId = req.nextUrl.searchParams.get('pipelineId')?.trim();
  if (!pipelineId) return NextResponse.json({ ok: false, error: 'pipelineId is required' }, { status: 400 });
  try {
    await deleteDltPipeline(pipelineId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

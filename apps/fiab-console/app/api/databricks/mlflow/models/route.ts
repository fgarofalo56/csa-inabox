/**
 * MLflow registered models — list / create / delete.
 *
 *   GET    /api/databricks/mlflow/models        → { ok, models }
 *   POST   /api/databricks/mlflow/models         → register a model
 *   DELETE /api/databricks/mlflow/models?name=  → delete a registered model
 *
 * Real Databricks REST (api 2.0):
 *   GET    /api/2.0/mlflow/registered-models/list
 *   POST   /api/2.0/mlflow/registered-models/create
 *   DELETE /api/2.0/mlflow/registered-models/delete
 * Learn: https://learn.microsoft.com/azure/databricks/mlflow/model-registry
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listRegisteredModels, createRegisteredModel, deleteRegisteredModel,
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
    const models = await listRegisteredModels();
    return NextResponse.json({ ok: true, models });
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
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required (workspace name or catalog.schema.model for UC)' }, { status: 400 });
  try {
    const model = await createRegisteredModel(name);
    return NextResponse.json({ ok: true, model });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    await deleteRegisteredModel(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

/**
 * MLflow experiments — list / create.
 *
 *   GET  /api/databricks/mlflow/experiments   → { ok, experiments }
 *   POST /api/databricks/mlflow/experiments    → create (returns { experiment_id })
 *
 * Real Databricks REST (api 2.0):
 *   POST /api/2.0/mlflow/experiments/search
 *   POST /api/2.0/mlflow/experiments/create
 * Learn: https://learn.microsoft.com/azure/databricks/mlflow/
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listMlflowExperiments, createMlflowExperiment,
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
    const experiments = await listMlflowExperiments();
    return NextResponse.json({ ok: true, experiments });
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
  if (!name) return NextResponse.json({ ok: false, error: 'name is required (e.g. /Users/me/my-experiment)' }, { status: 400 });
  try {
    const created = await createMlflowExperiment(name, body?.artifact_location ? String(body.artifact_location) : undefined);
    return NextResponse.json({ ok: true, experiment_id: created.experiment_id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

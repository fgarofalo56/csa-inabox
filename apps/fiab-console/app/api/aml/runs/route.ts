/**
 * /api/aml/runs
 *
 * MLflow run search for the ML Experiment editor's sortable/filterable runs
 * table AND the compare-runs view. Talks to the AML MLflow tracking server's
 * runs/search REST directly.
 *
 *   GET  /api/aml/runs?experimentIds=id1,id2&filter=...&maxResults=...&orderBy=...
 *   POST /api/aml/runs   body: { experimentIds: string[], filter?, maxResults?, orderBy?: string[] }
 *
 * Multiple experimentIds are supported so the Compare view can pull runs from
 * more than one experiment in a single call; the editor correlates by runId.
 *
 * Real backend:
 *   POST <mlflow-base>/api/2.0/mlflow/runs/search
 * (see lib/azure/mlflow-client.ts for the AML tracking-URI + Learn refs).
 *
 * MLflow filter strings (e.g. `metrics.accuracy > 0.9 and params.lr = '0.01'`)
 * and order_by (e.g. `metrics.accuracy DESC`, `attributes.start_time DESC`) are
 * passed through to the tracking server unchanged, so server-side sort/filter
 * matches the open-source MLflow semantics.
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML env / LOOM_MLFLOW_TRACKING_URI isn't set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchRuns,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RunSearchInput {
  experimentIds: string[];
  filter?: string;
  maxResults?: number;
  orderBy?: string[];
}

function clampMax(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(v)));
}

async function run(input: RunSearchInput) {
  const runs = await searchRuns({
    experimentIds: input.experimentIds,
    filter: input.filter,
    maxResults: input.maxResults,
    orderBy: input.orderBy,
  });
  return NextResponse.json({ ok: true, configured: true, runs });
}

function gate(e: unknown) {
  if (e instanceof MlflowNotConfiguredError) {
    return NextResponse.json({
      ok: true,
      configured: false,
      runs: [],
      missing: e.missing,
      hint: e.hint,
    });
  }
  const status = e instanceof MlflowError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: (e as any)?.message || String(e), body: (e as any)?.body },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const experimentIds = (url.searchParams.get('experimentIds') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!experimentIds.length) {
    return NextResponse.json({ ok: false, error: 'experimentIds is required' }, { status: 400 });
  }
  const filter = url.searchParams.get('filter') || undefined;
  const maxResultsRaw = url.searchParams.get('maxResults');
  const orderByRaw = url.searchParams.get('orderBy');
  const orderBy = orderByRaw
    ? orderByRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    return await run({
      experimentIds,
      filter,
      maxResults: maxResultsRaw ? clampMax(maxResultsRaw) : undefined,
      orderBy,
    });
  } catch (e) {
    return gate(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: Partial<RunSearchInput> = {};
  try { body = await req.json(); } catch { /* empty / invalid body → 400 below */ }

  const experimentIds = Array.isArray(body.experimentIds)
    ? body.experimentIds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!experimentIds.length) {
    return NextResponse.json({ ok: false, error: 'experimentIds is required' }, { status: 400 });
  }
  const orderBy = Array.isArray(body.orderBy)
    ? body.orderBy.map((s) => String(s)).filter(Boolean)
    : undefined;

  try {
    return await run({
      experimentIds,
      filter: body.filter ? String(body.filter) : undefined,
      maxResults: body.maxResults != null ? clampMax(body.maxResults) : undefined,
      orderBy,
    });
  } catch (e) {
    return gate(e);
  }
}

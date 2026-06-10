/**
 * /api/aml/automl
 *
 * AutoML (automated machine learning) low-code job surface over Azure Machine
 * Learning's control plane (no Fabric / Power BI dependency).
 *
 *   GET  /api/aml/automl?maxResults=200   → listAutoMLJobs() (monitor table)
 *   POST /api/aml/automl                  → submitAutoMLJob() (run the wizard)
 *
 * Real backend (lib/azure/aml-client.ts):
 *   GET <ws>/jobs   (filtered to jobType == AutoML)
 *   PUT <ws>/jobs/{name}   body { properties: { jobType: 'AutoML', taskDetails } }
 * https://learn.microsoft.com/rest/api/azureml/jobs/create-or-update
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML workspace env (LOOM_AML_WORKSPACE + LOOM_AML_REGION + LOOM_SUBSCRIPTION_ID,
 * or LOOM_FOUNDRY_* fallback) isn't set — the editor renders a Fluent
 * MessageBar naming the variable; the full wizard surface still renders.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAutoMLJobs,
  submitAutoMLJob,
  AUTOML_METRICS,
  amlConfigGate,
  AmlError,
  type AutoMLTaskType,
  type AutoMLSubmitInput,
} from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASKS: AutoMLTaskType[] = ['Classification', 'Regression', 'Forecasting'];

function gateBody() {
  const gate = amlConfigGate();
  if (!gate) return null;
  return NextResponse.json({
    ok: true,
    configured: false,
    jobs: [],
    missing: gate.missing,
    hint:
      `Azure ML workspace not addressable (missing ${gate.missing}). ` +
      'Set LOOM_AML_WORKSPACE + LOOM_AML_REGION + LOOM_SUBSCRIPTION_ID (or the ' +
      'LOOM_FOUNDRY_* equivalents), then grant the Console UAMI the AzureML ' +
      'Data Scientist role on the workspace.',
  });
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gated = gateBody();
  if (gated) return gated;

  const url = new URL(req.url);
  const maxResults = clampInt(url.searchParams.get('maxResults'), 200, 1, 1000);

  try {
    const jobs = await listAutoMLJobs({ maxResults });
    return NextResponse.json({ ok: true, configured: true, jobs });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gated = gateBody();
  if (gated) return gated;

  let body: Partial<AutoMLSubmitInput> = {};
  try { body = await req.json(); } catch { /* validated below */ }

  const task = String(body.task || '') as AutoMLTaskType;
  if (!TASKS.includes(task)) {
    return NextResponse.json(
      { ok: false, error: `task must be one of ${TASKS.join(', ')}` },
      { status: 400 },
    );
  }
  const trainingDataUri = String(body.trainingDataUri || '').trim();
  if (!trainingDataUri) {
    return NextResponse.json({ ok: false, error: 'trainingDataUri (MLTable) is required' }, { status: 400 });
  }
  const targetColumnName = String(body.targetColumnName || '').trim();
  if (!targetColumnName) {
    return NextResponse.json({ ok: false, error: 'targetColumnName is required' }, { status: 400 });
  }
  const computeName = String(body.computeName || '').trim();
  if (!computeName) {
    return NextResponse.json({ ok: false, error: 'computeName (an AmlCompute cluster) is required' }, { status: 400 });
  }
  if (task === 'Forecasting' && !String(body.timeColumnName || '').trim()) {
    return NextResponse.json({ ok: false, error: 'timeColumnName is required for Forecasting' }, { status: 400 });
  }

  const primaryMetric = body.primaryMetric && AUTOML_METRICS[task].includes(String(body.primaryMetric))
    ? String(body.primaryMetric)
    : undefined;

  try {
    const job = await submitAutoMLJob({
      task,
      trainingDataUri,
      validationDataUri: body.validationDataUri ? String(body.validationDataUri).trim() : undefined,
      targetColumnName,
      computeName,
      displayName: body.displayName ? String(body.displayName) : undefined,
      experimentName: body.experimentName ? String(body.experimentName) : undefined,
      description: body.description ? String(body.description) : undefined,
      primaryMetric,
      maxTrials: body.maxTrials != null ? clampInt(body.maxTrials, 20, 1, 1000) : undefined,
      maxConcurrentTrials: body.maxConcurrentTrials != null ? clampInt(body.maxConcurrentTrials, 4, 1, 100) : undefined,
      timeout: body.timeout ? String(body.timeout) : undefined,
      trialTimeout: body.trialTimeout ? String(body.trialTimeout) : undefined,
      enableModelExplainability: typeof body.enableModelExplainability === 'boolean' ? body.enableModelExplainability : undefined,
      enableEarlyTermination: typeof body.enableEarlyTermination === 'boolean' ? body.enableEarlyTermination : undefined,
      timeColumnName: body.timeColumnName ? String(body.timeColumnName) : undefined,
      forecastHorizon: body.forecastHorizon != null ? clampInt(body.forecastHorizon, 1, 1, 10000) : undefined,
    });
    return NextResponse.json({ ok: true, configured: true, job });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}

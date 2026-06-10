/**
 * POST /api/items/automl/submit
 *
 * Submit a real Azure ML AutoML job from the wizard. Real ARM PUT of an AutoML
 * job (jobType:'AutoML') against the workspace's /jobs collection.
 *
 * Body (from the wizard):
 *   { task: 'Classification'|'Regression'|'Forecasting',
 *     trainingDataUri, targetColumnName, computeName,
 *     primaryMetric?, experimentTimeoutMinutes?, maxTrials?,
 *     maxConcurrentTrials?, nCrossValidations?, displayName?, experimentName?,
 *     forecastingSettings?: { timeColumnName, forecastHorizon?, timeSeriesIdColumnNames? } }
 *
 * Honest gate: 200 + { ok:false, configured:false, hint } when env unset.
 * Azure-native default — no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  submitAutoMlJob,
  automlConfigGate,
  AutoMlError,
  type AutoMlTaskType,
  type SubmitAutoMlInput,
} from '@/lib/azure/aml-automl-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TASKS: AutoMlTaskType[] = ['Classification', 'Regression', 'Forecasting'];

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = automlConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        error: 'Azure ML workspace not configured',
        hint: `Set ${gate.missing} so AutoML jobs can be submitted to the workspace.`,
      },
      { status: 200 },
    );
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }

  const task = String(body?.task || '') as AutoMlTaskType;
  if (!VALID_TASKS.includes(task)) {
    return NextResponse.json({ ok: false, error: `task must be one of ${VALID_TASKS.join(', ')}` }, { status: 400 });
  }
  if (!body?.trainingDataUri) return NextResponse.json({ ok: false, error: 'trainingDataUri is required' }, { status: 400 });
  if (!body?.targetColumnName) return NextResponse.json({ ok: false, error: 'targetColumnName is required' }, { status: 400 });
  if (!body?.computeName) return NextResponse.json({ ok: false, error: 'computeName is required' }, { status: 400 });
  if (task === 'Forecasting' && !body?.forecastingSettings?.timeColumnName) {
    return NextResponse.json({ ok: false, error: 'forecastingSettings.timeColumnName is required for forecasting' }, { status: 400 });
  }

  const input: SubmitAutoMlInput = {
    task,
    trainingDataUri: String(body.trainingDataUri),
    targetColumnName: String(body.targetColumnName),
    computeName: String(body.computeName),
    primaryMetric: body.primaryMetric ? String(body.primaryMetric) : undefined,
    experimentTimeoutMinutes: num(body.experimentTimeoutMinutes),
    maxTrials: num(body.maxTrials),
    maxConcurrentTrials: num(body.maxConcurrentTrials),
    nCrossValidations: num(body.nCrossValidations),
    displayName: body.displayName ? String(body.displayName) : undefined,
    experimentName: body.experimentName ? String(body.experimentName) : undefined,
    forecastingSettings:
      task === 'Forecasting'
        ? {
            timeColumnName: String(body.forecastingSettings.timeColumnName),
            forecastHorizon: num(body.forecastingSettings?.forecastHorizon),
            timeSeriesIdColumnNames: Array.isArray(body.forecastingSettings?.timeSeriesIdColumnNames)
              ? body.forecastingSettings.timeSeriesIdColumnNames.map((x: unknown) => String(x)).filter(Boolean)
              : undefined,
          }
        : undefined,
  };

  try {
    const job = await submitAutoMlJob(input);
    return NextResponse.json({ ok: true, configured: true, job });
  } catch (e: any) {
    const status = e instanceof AutoMlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

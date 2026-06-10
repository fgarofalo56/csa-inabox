/**
 * GET  /api/foundry/fine-tuning            — list fine-tuning jobs for the account.
 * GET  /api/foundry/fine-tuning?files=1    — list uploaded fine-tune training files.
 * POST /api/foundry/fine-tuning            — create a fine-tuning job.
 *   body: { model, trainingFileId, validationFileId?, suffix?, hyperparameters?, seed?, account?, rg? }
 *
 * Azure OpenAI fine-tuning data-plane:
 *   jobs  = GET/POST {endpoint}/openai/v1/fine_tuning/jobs
 *   files = GET       {endpoint}/openai/v1/files?purpose=fine-tune
 * Role: Cognitive Services OpenAI Contributor (a001fd3d).
 * Ref: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/fine-tuning
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFineTuningJobs,
  listFineTuningFiles,
  createFineTuningJob,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  const hint = status === 404 || status === 403
    ? 'Fine-tuning requires the "Cognitive Services OpenAI Contributor" role on the AI Foundry account and a model + region that supports fine-tuning (Standard / RegionalStandard SKU, not Global). Grant the role via platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep.'
    : undefined;
  return NextResponse.json({ ok: false, error: e?.message || String(e), hint, body: e?.body, notDeployed: status === 404 }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    if (req.nextUrl.searchParams.get('files')) {
      const { account, files } = await listFineTuningFiles(selectorFromQuery(req));
      return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, files });
    }
    const { account, jobs } = await listFineTuningJobs(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, jobs });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const model = String(body?.model || '').trim();
    const trainingFileId = String(body?.trainingFileId || '').trim();
    if (!model) return NextResponse.json({ ok: false, error: 'model (base model to fine-tune) required' }, { status: 400 });
    if (!trainingFileId) return NextResponse.json({ ok: false, error: 'trainingFileId required (upload a JSONL training file first)' }, { status: 400 });
    const hp = body?.hyperparameters && typeof body.hyperparameters === 'object' ? body.hyperparameters : undefined;
    const job = await createFineTuningJob({
      model,
      trainingFileId,
      validationFileId: typeof body.validationFileId === 'string' && body.validationFileId.trim() ? body.validationFileId.trim() : undefined,
      suffix: typeof body.suffix === 'string' && body.suffix.trim() ? body.suffix.trim() : undefined,
      hyperparameters: hp,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}

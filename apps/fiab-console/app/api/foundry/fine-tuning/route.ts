/**
 * GET  /api/foundry/fine-tuning            — list fine-tuning jobs for the account.
 * POST /api/foundry/fine-tuning            — create a fine-tuning job.
 *   body: { model, trainingFile, validationFile?, suffix?, seed?, hyperparameters?, account?, rg? }
 *
 * AOAI fine-tuning data-plane (v1):
 *   list   = GET  {endpoint}/openai/v1/fine_tuning/jobs
 *   create = POST {endpoint}/openai/v1/fine_tuning/jobs
 * Ref: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/fine-tuning
 *
 * Honest gate: a 400/404 here means the chosen model/region does not support
 * fine-tuning — surfaced as notDeployed with a remediation hint (no fake data).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFineTuningJobs,
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
  const isGate = status === 404 || status === 400;
  const hint = isGate
    ? 'Fine-tuning requires a supported base model in a fine-tuning region (e.g. gpt-4o-mini / gpt-4o in East US 2, North Central US, Sweden Central). Upload a JSONL training file on the Files step and choose a fine-tunable model.'
    : undefined;
  return NextResponse.json({ ok: false, error: e?.message || String(e), hint, body: e?.body, notDeployed: isGate }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
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
    const trainingFile = String(body?.trainingFile || '').trim();
    if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
    if (!trainingFile) return NextResponse.json({ ok: false, error: 'trainingFile (uploaded file id) required' }, { status: 400 });
    const { job } = await createFineTuningJob({
      model,
      trainingFile,
      validationFile: typeof body?.validationFile === 'string' && body.validationFile.trim() ? body.validationFile.trim() : undefined,
      suffix: typeof body?.suffix === 'string' && body.suffix.trim() ? body.suffix.trim() : undefined,
      seed: typeof body?.seed === 'number' ? body.seed : undefined,
      hyperparameters: body?.hyperparameters && typeof body.hyperparameters === 'object' ? body.hyperparameters : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}

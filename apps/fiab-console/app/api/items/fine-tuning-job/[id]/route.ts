/**
 * LLM fine-tuning — item BFF (WS-1.3).
 *
 *   GET    /api/items/fine-tuning-job/[id]        → backend + gate + jobs + base models + binding
 *   POST   /api/items/fine-tuning-job/[id]        → submit a fine-tuning job (training-data-eval gate)
 *   PATCH  /api/items/fine-tuning-job/[id]        → bind an EXISTING job id to this item
 *   DELETE /api/items/fine-tuning-job/[id]?job=   → cancel a fine-tuning job
 *
 * `[id]` is the Loom Cosmos GUID (tenant-scoped by session.claims.oid), NEVER an
 * AOAI fine-tuning job id. Real backend: Azure OpenAI in Azure AI Foundry
 * fine-tuning (Azure-native DEFAULT, Gov-correct `*.openai.azure.us`); Databricks
 * Mosaic AI is an opt-in alternative. Honest gate via fineTuneConfigGate /
 * fineTuneGateFromError when no backend is addressable (no-vaporware.md). No Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveFineTuneBackend, fineTuneConfigGate, fineTuneGateFromError,
  submitFineTuningJob, listJobs, cancelJob, shapeFineTuningJobView, listDeployments,
  CsError, type SubmitFineTuningInput,
} from '@/lib/azure/fine-tuning-client';
import {
  resolveFineTuningItem, persistFineTuningItem, fineTuningItemErrorResponse,
} from '@/lib/azure/fine-tuning-item';
import { listCatalogModels } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Base models that support chat fine-tuning (chat-completion capable, in-catalog). */
async function fineTunableBaseModels(): Promise<Array<{ name: string; version?: string }>> {
  try {
    const { models } = await listCatalogModels();
    return models
      .filter((m) => m.inferenceTasks?.includes('chat-completion') || m.capabilities?.includes('chatCompletion'))
      .map((m) => ({ name: m.name, version: m.version }));
  } catch {
    return [];
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const backend = resolveFineTuneBackend();
  const bindingView = {
    jobId: binding.jobId, baseModel: binding.baseModel, fineTunedModel: binding.fineTunedModel,
    deploymentName: binding.deploymentName, deployable: binding.deployable, safetyEval: binding.safetyEval,
  };

  // Databricks opt-in gate (sync). AOAI addressability is checked by the real call below.
  const syncGate = fineTuneConfigGate();
  if (syncGate) {
    return NextResponse.json({ ok: true, backend, gate: syncGate, binding: bindingView, jobs: [], models: [], deployments: [] });
  }
  try {
    const [rawJobs, models, deployments] = await Promise.all([
      listJobs(),
      fineTunableBaseModels(),
      listDeployments().catch(() => []),
    ]);
    return NextResponse.json({
      ok: true, backend, gate: null, binding: bindingView,
      jobs: rawJobs.map(shapeFineTuningJobView), models, deployments,
    });
  } catch (e: any) {
    const gate = fineTuneGateFromError(e);
    if (gate) {
      // Full surface still renders — honest gate names the exact Fix-it var.
      return NextResponse.json({ ok: true, backend, gate, binding: bindingView, jobs: [], models: [], deployments: [] });
    }
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const gate = fineTuneConfigGate();
  if (gate) return NextResponse.json({ ok: false, code: 'not_configured', gate, error: gate.hint }, { status: 503 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const baseModel = String(body?.baseModel || '').trim();
  if (!baseModel) return NextResponse.json({ ok: false, error: 'baseModel is required' }, { status: 400 });
  const input: SubmitFineTuningInput = {
    baseModel,
    trainingData: typeof body?.trainingData === 'string' ? body.trainingData : undefined,
    trainingFileId: typeof body?.trainingFileId === 'string' ? body.trainingFileId : undefined,
    validationData: typeof body?.validationData === 'string' ? body.validationData : undefined,
    validationFileId: typeof body?.validationFileId === 'string' ? body.validationFileId : undefined,
    suffix: typeof body?.suffix === 'string' ? body.suffix : undefined,
    seed: Number.isFinite(Number(body?.seed)) ? Number(body.seed) : undefined,
    hyperparameters: body?.hyperparameters && typeof body.hyperparameters === 'object' ? body.hyperparameters : undefined,
  };
  try {
    const { job, trainingDataEval } = await submitFineTuningJob(input);
    await persistFineTuningItem(id, session.claims.oid, {
      jobId: job.id, baseModel, backend: resolveFineTuneBackend(),
      // A resubmit resets the downstream lifecycle.
      fineTunedModel: '', deploymentName: '', deployable: false, safetyEval: null,
    });
    return NextResponse.json({ ok: true, job: shapeFineTuningJobView(job), trainingDataEval, message: `Fine-tuning job ${job.id} submitted on ${baseModel}.` });
  } catch (e: any) {
    // Training-data-eval failures + bad requests are 400s (message is actionable).
    const msg = e?.message || String(e);
    if (/failed validation|is required|Provide training data/i.test(msg) && !(e instanceof CsError)) {
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: msg, body: e?.body }, { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const jobId = String(body?.jobId || '').trim();
  if (!jobId) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    await persistFineTuningItem(id, session.claims.oid, {
      jobId, backend: resolveFineTuneBackend(),
      baseModel: typeof body?.baseModel === 'string' ? body.baseModel.trim() : undefined,
    });
    return NextResponse.json({ ok: true, message: `Bound to fine-tuning job "${jobId}".` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const jobId = req.nextUrl.searchParams.get('job')?.trim();
  if (!jobId) return NextResponse.json({ ok: false, error: 'job query param is required' }, { status: 400 });
  try {
    const job = await cancelJob(jobId);
    if (binding.jobId === jobId) await persistFineTuningItem(id, session.claims.oid, { jobId: '' });
    return NextResponse.json({ ok: true, job: shapeFineTuningJobView(job), message: `Fine-tuning job "${jobId}" cancellation requested.` });
  } catch (e: any) {
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

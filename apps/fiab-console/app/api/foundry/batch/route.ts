/**
 * AIF-11 — Global / Data-Zone Batch jobs (async high-volume inference).
 *
 * GET  /api/foundry/batch                 — list batch jobs for the account.
 * GET  /api/foundry/batch?output=<fileId> — download an output/error file (JSONL).
 * POST /api/foundry/batch                 — { action:'upload', fileName, content } → upload JSONL (returns fileId)
 *                                           { inputFileId, endpoint? }             → create a batch job
 *
 * Real Azure OpenAI batch data-plane (foundry-cs-client): files upload with
 * purpose=batch, POST /openai/batches, GET /openai/batches/{id}. Batch is NOT
 * available in Azure Government — callers honest-gate the surface there.
 * Account is selected by the AI Foundry account picker (?account=&rg= or body).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listBatchJobs,
  createBatchJob,
  uploadBatchFile,
  getFileContent,
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
    ? 'Batch requires the "Cognitive Services OpenAI Contributor" role on the AI Foundry account and a model deployed with a Global-Batch / Data-Zone-Batch deployment type. Batch is not available in Azure Government.'
    : undefined;
  return NextResponse.json({ ok: false, error: e?.message || String(e), hint, body: e?.body, notDeployed: status === 404 }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const outputFileId = req.nextUrl.searchParams.get('output')?.trim();
    if (outputFileId) {
      const { content } = await getFileContent(outputFileId, selectorFromQuery(req));
      return new NextResponse(content, {
        status: 200,
        headers: {
          'content-type': 'application/jsonl',
          'content-disposition': `attachment; filename="${outputFileId}.jsonl"`,
        },
      });
    }
    const { account, jobs } = await listBatchJobs(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, jobs });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'upload') {
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) return NextResponse.json({ ok: false, error: 'content (JSONL) required' }, { status: 400 });
      const fileName = String(body.fileName || 'batch-input.jsonl');
      const { account, file } = await uploadBatchFile(fileName, content, selectorFromBody(body));
      return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, file });
    }
    const inputFileId = typeof body?.inputFileId === 'string' ? body.inputFileId.trim() : '';
    if (!inputFileId) return NextResponse.json({ ok: false, error: 'inputFileId required (upload a JSONL file first)' }, { status: 400 });
    const job = await createBatchJob(
      { inputFileId, endpoint: body.endpoint ? String(body.endpoint) : undefined },
      selectorFromBody(body),
    );
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}

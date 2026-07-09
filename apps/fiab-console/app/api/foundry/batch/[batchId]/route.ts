/**
 * AIF-11 — one batch job.
 *   GET    /api/foundry/batch/<batchId>  — poll status (request counts, output file id).
 *   DELETE /api/foundry/batch/<batchId>  — cancel an in-progress batch.
 * Account is selected by the AI Foundry account picker (?account=&rg=).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getBatchJob,
  cancelBatchJob,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { batchId } = await params;
  try {
    const job = await getBatchJob(batchId, selectorFromQuery(req));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { batchId } = await params;
  try {
    const job = await cancelBatchJob(batchId, selectorFromQuery(req));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}

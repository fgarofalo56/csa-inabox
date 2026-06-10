/**
 * POST /api/foundry/evaluations/files — upload a JSONL dataset for evals.
 *
 * Accepts multipart/form-data with a `file` field (the .jsonl dataset) plus
 * optional `account` / `rg` selector fields. Streams the content to the AOAI
 * v1 /files endpoint with purpose=evals and returns the file id so a run can
 * be started against it.
 *
 * Backend: POST {endpoint}/openai/v1/files (multipart, purpose=evals).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uploadEvalsFile, CsError, CsNotConfiguredError, type AccountSelector } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ ok: false, error: 'a multipart `file` field (JSONL dataset) is required' }, { status: 400 });
    }
    const fileName = (file as File).name || 'eval-dataset.jsonl';
    const content = await file.text();
    if (!content.trim()) return NextResponse.json({ ok: false, error: 'the uploaded file is empty' }, { status: 400 });

    const account = form.get('account');
    const rg = form.get('rg');
    const selector: AccountSelector | undefined = typeof account === 'string' && account.trim()
      ? { name: account.trim(), rg: typeof rg === 'string' && rg.trim() ? rg.trim() : undefined }
      : undefined;

    const { account: acct, file: uploaded } = await uploadEvalsFile(fileName, content, selector);
    return NextResponse.json({ ok: true, account: { name: acct.name, location: acct.location }, file: uploaded });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), notDeployed: status === 404 }, { status });
  }
}

/**
 * POST /api/foundry/fine-tuning/files — upload a JSONL training/validation file
 * for fine-tuning (purpose=fine-tune).
 *
 * Accepts multipart/form-data with a `file` field plus optional `account`/`rg`.
 * Backend: POST {endpoint}/openai/v1/files (multipart, purpose=fine-tune).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uploadFineTuningFile, CsError, CsNotConfiguredError, type AccountSelector } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ ok: false, error: 'a multipart `file` field (JSONL training file) is required' }, { status: 400 });
    }
    const fileName = (file as File).name || 'training.jsonl';
    const content = await file.text();
    if (!content.trim()) return NextResponse.json({ ok: false, error: 'the uploaded file is empty' }, { status: 400 });

    const account = form.get('account');
    const rg = form.get('rg');
    const selector: AccountSelector | undefined = typeof account === 'string' && account.trim()
      ? { name: account.trim(), rg: typeof rg === 'string' && rg.trim() ? rg.trim() : undefined }
      : undefined;

    const { account: acct, file: uploaded } = await uploadFineTuningFile(fileName, content, selector);
    return NextResponse.json({ ok: true, account: { name: acct.name, location: acct.location }, file: uploaded });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), notDeployed: status === 404 }, { status });
  }
}

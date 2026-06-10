/**
 * GET  /api/foundry/files?purpose=evals|fine-tune   — list uploaded files.
 * POST /api/foundry/files                            — upload a JSONL file.
 *   multipart/form-data: file=<JSONL>, purpose=evals|fine-tune, account?, rg?
 *
 * AOAI files data-plane (v1):
 *   list   = GET  {endpoint}/openai/v1/files?purpose=...
 *   upload = POST {endpoint}/openai/v1/files (multipart)
 * Shared dataset store for the Evals + Fine-tuning surfaces.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFiles,
  uploadFile,
  CsError,
  CsNotConfiguredError,
  type AccountSelector,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, notDeployed: status === 404 }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const purpose = req.nextUrl.searchParams.get('purpose')?.trim() || undefined;
    const { account, files } = await listFiles(purpose, selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, files });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'file (multipart field) required' }, { status: 400 });
    const purposeRaw = String(form.get('purpose') || 'evals').trim();
    const purpose = purposeRaw === 'fine-tune' ? 'fine-tune' : 'evals';
    const account = form.get('account');
    const rg = form.get('rg');
    const selector: AccountSelector | undefined = typeof account === 'string' && account.trim()
      ? { name: account.trim(), rg: typeof rg === 'string' && rg.trim() ? rg.trim() : undefined }
      : undefined;
    const buf = Buffer.from(await file.arrayBuffer());
    const { file: uploaded } = await uploadFile(file.name || 'dataset.jsonl', buf, purpose, selector);
    return NextResponse.json({ ok: true, file: uploaded });
  } catch (e: any) {
    return fail(e);
  }
}

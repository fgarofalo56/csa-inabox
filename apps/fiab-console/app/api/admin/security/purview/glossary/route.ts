/**
 * /api/admin/security/purview/glossary
 *
 * GET  ?glossaryGuid=<g>            → list terms (first 200) under a glossary;
 *                                      if guid omitted, defaults to the first
 *                                      glossary in the account.
 * POST { name, glossaryGuid, ... }   → create a new term.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listGlossaryTerms, createGlossaryTerm } from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const glossaryGuid = req.nextUrl.searchParams.get('glossaryGuid') || undefined;
  try {
    const terms = await listGlossaryTerms(glossaryGuid);
    return NextResponse.json({ ok: true, terms });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.name || !body?.glossaryGuid) {
    return NextResponse.json({ ok: false, error: 'name and glossaryGuid are required' }, { status: 400 });
  }
  try {
    const term = await createGlossaryTerm({
      name: body.name,
      glossaryGuid: body.glossaryGuid,
      shortDescription: body.shortDescription,
      longDescription: body.longDescription,
    });
    return NextResponse.json({ ok: true, term }, { status: 201 });
  } catch (e) { return handleSecurityError(e); }
}

/**
 * /api/admin/security/purview/glossary
 *
 * GET  ?list=glossaries              → list glossaries (domains) in the account
 *                                      as { ok, glossaries: [{ guid, name }] }.
 * GET  ?glossaryGuid=<g>&keyword=<k> → list terms (first 200) under a glossary,
 *                                      optionally keyword-filtered by name; if
 *                                      guid omitted, defaults to the first
 *                                      glossary in the account.
 * POST { name, glossaryGuid, ... }   → create a new term.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  listGlossaryTerms,
  listGlossaries,
  searchGlossaryTermsByKeyword,
  createGlossaryTerm,
} from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const params = req.nextUrl.searchParams;
  const glossaryGuid = params.get('glossaryGuid') || undefined;
  const keyword = params.get('keyword') || undefined;
  try {
    // List glossaries (the "domain" filter source) when explicitly requested.
    if (params.get('list') === 'glossaries') {
      const glossaries = await listGlossaries();
      return NextResponse.json({ ok: true, glossaries });
    }
    const terms = keyword
      ? await searchGlossaryTermsByKeyword(keyword, glossaryGuid)
      : await listGlossaryTerms(glossaryGuid);
    return NextResponse.json({ ok: true, terms });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
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

/**
 * Cross-source glossary ops.
 *
 * POST /api/catalog/glossary
 *   Body: {
 *     term: { name, longDescription?, glossaryGuid? },
 *     // optional cross-source apply target:
 *     applyTo?: {
 *       source: 'purview' | 'unity-catalog' | 'onelake',
 *       // purview: pass entityGuid directly
 *       entityGuid?: string,
 *       // unity-catalog / onelake: registerInPurview first via the
 *       // catalog/register route to get a guid, then this endpoint applies.
 *     }
 *   }
 *
 *   Returns: { ok, term: { guid, name }, applied?: boolean }
 *
 * The endpoint creates the term if it does not yet exist (Atlas dedupes
 * on `name` within a glossary) and optionally applies it to a known
 * Purview entity guid in one round-trip.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createGlossaryTerm, applyGlossaryTerm,
  PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const term = body.term as { name?: string; longDescription?: string; glossaryGuid?: string } | undefined;
  if (!term?.name) {
    return NextResponse.json({ ok: false, error: 'term.name required' }, { status: 400 });
  }
  try {
    const created = await createGlossaryTerm(term);
    let applied = false;
    if (body.applyTo?.entityGuid) {
      await applyGlossaryTerm(created.guid, body.applyTo.entityGuid);
      applied = true;
    }
    return NextResponse.json({ ok: true, term: created, applied });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}

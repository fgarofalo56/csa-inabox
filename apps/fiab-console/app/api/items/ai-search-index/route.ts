/**
 * GET  /api/items/ai-search-index — list indexes
 * POST /api/items/ai-search-index — upsert index { name, definition }
 *
 * Surfaces 503 + notDeployed=true when LOOM_AI_SEARCH_SERVICE is not set
 * (current state — eastus2 capacity hold).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listIndexes, upsertIndex, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const indexes = await listIndexes();
    return NextResponse.json({ ok: true, indexes });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.name || !body?.definition) return NextResponse.json({ ok: false, error: 'name + definition required' }, { status: 400 });
    const index = await upsertIndex(body.name, body.definition);
    return NextResponse.json({ ok: true, index });
  } catch (e: any) { return err(e); }
}

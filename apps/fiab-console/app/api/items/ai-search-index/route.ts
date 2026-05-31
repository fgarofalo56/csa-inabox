/**
 * GET  /api/items/ai-search-index — list every index on the bound search service.
 * POST /api/items/ai-search-index — create a new index from a full definition
 *                                   { definition: { name, fields, ... } }.
 *
 * Both honest-gate (503 + notDeployed) when LOOM_AI_SEARCH_SERVICE is unset.
 * Real Azure AI Search data-plane REST via lib/azure/search-index-client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexes, createIndex, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
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
    const body = await req.json().catch(() => ({}));
    const definition = body?.definition || body;
    if (!definition?.name || !Array.isArray(definition?.fields)) {
      return NextResponse.json({ ok: false, error: 'definition.name + definition.fields[] required' }, { status: 400 });
    }
    const index = await createIndex(definition);
    return NextResponse.json({ ok: true, index });
  } catch (e: any) { return err(e); }
}

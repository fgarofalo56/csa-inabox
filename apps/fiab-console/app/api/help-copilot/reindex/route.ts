/**
 * POST /api/help-copilot/reindex — rebuilds the docs+repo corpus.
 *
 * Admin-only. Walks docs/ + apps/fiab-console/lib/ + PRPs/ + ADRs and
 * pushes chunks into either AI Search (preferred) or Cosmos fallback.
 *
 * GET /api/help-copilot/reindex — returns last reindex stats (lightweight
 * check that the corpus is populated).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reindex, isSearchConfigured } from '@/lib/azure/loom-docs-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5min; corpus build can be slow on a cold replica

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({
    ok: true,
    backend: isSearchConfigured() ? 'ai-search' : 'cosmos',
    hint: isSearchConfigured()
      ? 'AI Search is configured. POST to /api/help-copilot/reindex to refresh.'
      : 'AI Search not configured; using Cosmos substring fallback. Set LOOM_AI_SEARCH_SERVICE for hybrid search.',
  });
}

export async function POST() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const result = await reindex();
    if (!result.ok) {
      return NextResponse.json({ ...result, ok: false }, { status: 502 });
    }
    return NextResponse.json({ ...result, ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

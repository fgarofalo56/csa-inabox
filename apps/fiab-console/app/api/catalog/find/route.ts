/**
 * GET /api/catalog/find — estate-wide catalog search (rel-T92).
 *
 * Searches every workspace ITEM the caller can access (owned + ACL-shared) by
 * name / type / description / tags and returns ranked results. This is the
 * single endpoint behind both `loom find` (the CLI) and the Console search UI;
 * the MCP `catalog_search` tool calls the same {@link searchCatalog} library
 * directly (one source of truth).
 *
 *   ?q=...        Search text. Empty → most-recently-updated items (browse mode).
 *   ?type=...     Optional comma-separated item-type filter (lakehouse,warehouse,…).
 *   ?limit=N      Max hits (default 30, max 200).
 *
 * ACL/tenant scoping is enforced inside searchCatalog via the accessible-workspace
 * resolver — search can never leak an item from outside the caller's tenant/grants.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { searchCatalog } from '@/lib/azure/catalog-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30', 10) || 30, 200);
  const types = (req.nextUrl.searchParams.get('type') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  try {
    const result = await searchCatalog({
      oid: s.claims.oid,
      callerTid: s.claims.tid,
      groups: s.claims.groups,
      q,
      types,
      limit,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

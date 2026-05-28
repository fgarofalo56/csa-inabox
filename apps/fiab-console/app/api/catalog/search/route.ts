/**
 * GET /api/catalog/search
 *   Federated search across Purview + Unity Catalog + OneLake.
 *
 *   ?q=...        Required search keywords. Empty string returns the latest
 *                 50 hits across each source (browse-mode).
 *   ?source=...   Optional comma-separated source filter
 *                 (purview, unity-catalog, onelake).
 *   ?limit=N      Per-source cap (default 30, max 100).
 *
 * Returns: {
 *   ok, total,
 *   hits: FederatedHit[],
 *   sources: { purview: { ok, count, error?, hint? }, ... }
 * }
 *
 * Each source is queried independently and the per-source success/error is
 * surfaced so the UI can render partial results + a precise MessageBar gate
 * for sources that are not provisioned (no fakes, no silent failures).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { searchPurview, PurviewNotConfiguredError } from '@/lib/azure/purview-client';
import { searchUnity, UnityCatalogNotConfiguredError } from '@/lib/azure/unity-catalog-client';
import { searchOneLake } from '@/lib/azure/onelake-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface FederatedHit {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  display_name: string;
  type: string;
  description?: string;
  owner?: string;
  workspace_name?: string;
  domain?: string;
  classifications?: string[];
  qualified_name?: string;
  updated_at?: string;
  /** Source-specific identifiers used to deep-link / open detail pages. */
  detail_path: string;
}

interface SourceResult {
  ok: boolean;
  count: number;
  error?: string;
  hint?: unknown;
  durationMs: number;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const sourceFilter = (req.nextUrl.searchParams.get('source') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30', 10) || 30, 100);

  const sources: Record<string, SourceResult> = {};
  const hits: FederatedHit[] = [];

  // ---------- Purview ----------
  if (!sourceFilter.length || sourceFilter.includes('purview')) {
    const t0 = Date.now();
    try {
      const rows = await searchPurview(q, limit);
      sources.purview = { ok: true, count: rows.length, durationMs: Date.now() - t0 };
      for (const r of rows) {
        hits.push({
          source: 'purview',
          id: r.id,
          display_name: r.name,
          type: r.entityType || 'Asset',
          description: r.description,
          owner: r.owner,
          domain: r.domain,
          classifications: r.classification,
          qualified_name: r.qualifiedName,
          updated_at: r.updatedAt,
          detail_path: `/catalog/purview/${encodeURIComponent(r.id)}`,
        });
      }
    } catch (e: any) {
      sources.purview = {
        ok: false, count: 0, durationMs: Date.now() - t0,
        error: e?.message || String(e),
        hint: e instanceof PurviewNotConfiguredError ? e.hint : undefined,
      };
    }
  }

  // ---------- Unity Catalog ----------
  if (!sourceFilter.length || sourceFilter.includes('unity-catalog')) {
    const t0 = Date.now();
    try {
      const rows = await searchUnity(q, limit);
      sources['unity-catalog'] = { ok: true, count: rows.length, durationMs: Date.now() - t0 };
      for (const r of rows) {
        hits.push({
          source: 'unity-catalog',
          id: r.full_name,
          display_name: r.name,
          type: r.type,
          description: r.comment,
          owner: r.owner,
          workspace_name: r.workspace_hostname,
          qualified_name: r.full_name,
          detail_path: `/catalog/unity-catalog/${encodeURIComponent(r.full_name)}?host=${encodeURIComponent(r.workspace_hostname)}`,
        });
      }
    } catch (e: any) {
      sources['unity-catalog'] = {
        ok: false, count: 0, durationMs: Date.now() - t0,
        error: e?.message || String(e),
        hint: e instanceof UnityCatalogNotConfiguredError ? e.hint : undefined,
      };
    }
  }

  // ---------- OneLake ----------
  if (!sourceFilter.length || sourceFilter.includes('onelake')) {
    const t0 = Date.now();
    try {
      const rows = await searchOneLake(q, limit);
      sources.onelake = { ok: true, count: rows.length, durationMs: Date.now() - t0 };
      for (const r of rows) {
        hits.push({
          source: 'onelake',
          id: r.item_id,
          display_name: r.display_name,
          type: r.type,
          description: r.description,
          workspace_name: r.workspace_name,
          updated_at: r.updated_at,
          detail_path: `/catalog/onelake/${encodeURIComponent(r.item_id)}?workspace=${encodeURIComponent(r.workspace_id)}`,
        });
      }
    } catch (e: any) {
      sources.onelake = {
        ok: false, count: 0, durationMs: Date.now() - t0,
        error: e?.message || String(e),
      };
    }
  }

  return NextResponse.json({
    ok: true,
    q,
    total: hits.length,
    hits,
    sources,
  });
}

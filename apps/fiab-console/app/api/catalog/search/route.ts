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
  /** Loom/Fabric workspace id — passed to register, open-in-workspace, build-report. */
  workspace_id?: string;
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

  // ---------- Loom workspaces (Azure-native DEFAULT; Fabric OneLake opt-in) ----------
  // Per no-fabric-dependency.md the catalog's primary inventory is the caller's
  // OWN Loom workspace items (Cosmos) — NOT real Fabric workspaces. Real Fabric
  // OneLake is used only when explicitly opted in via LOOM_LAKEHOUSE_BACKEND=fabric.
  if (!sourceFilter.length || sourceFilter.includes('onelake')) {
    const t0 = Date.now();
    try {
      if (process.env.LOOM_LAKEHOUSE_BACKEND === 'fabric') {
        const rows = await searchOneLake(q, limit);
        sources.onelake = { ok: true, count: rows.length, durationMs: Date.now() - t0 };
        for (const r of rows) {
          hits.push({
            source: 'onelake', id: r.item_id, display_name: r.display_name, type: r.type,
            description: r.description, workspace_name: r.workspace_name, workspace_id: r.workspace_id,
            updated_at: r.updated_at,
            detail_path: `/catalog/onelake/${encodeURIComponent(r.item_id)}?workspace=${encodeURIComponent(r.workspace_id)}`,
          });
        }
      } else {
        const { listAllOwnedItems, listOwnedWorkspaces } = await import('../../items/_lib/item-crud');
        const [items, wss] = await Promise.all([listAllOwnedItems(s.claims.oid), listOwnedWorkspaces(s.claims.oid)]);
        const wsName = new Map(wss.map((w) => [w.id, w.name]));
        const ql = q.toLowerCase().trim();
        const matched = items
          .filter((it) => !ql || it.displayName.toLowerCase().includes(ql) || it.itemType.toLowerCase().includes(ql))
          .slice(0, limit);
        sources.onelake = { ok: true, count: matched.length, durationMs: Date.now() - t0 };
        for (const it of matched) {
          hits.push({
            source: 'onelake', id: it.id, display_name: it.displayName, type: it.itemType,
            description: it.description, workspace_name: wsName.get(it.workspaceId) || it.workspaceId,
            workspace_id: it.workspaceId,
            updated_at: it.updatedAt, detail_path: `/items/${encodeURIComponent(it.itemType)}/${encodeURIComponent(it.id)}`,
          });
        }
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

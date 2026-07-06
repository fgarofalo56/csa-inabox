/**
 * rel-T92 — estate-wide catalog search (the single source of truth).
 *
 * ONE query surface used by three consumers so they never drift:
 *   • the REST endpoint  GET /api/catalog/find      (Console UI + `loom find`)
 *   • the CLI            `loom find <query>`         (calls the endpoint)
 *   • the MCP tool       `catalog_search`            (Copilot / external agents)
 *
 * WHAT IT SEARCHES: every workspace ITEM the caller can access — the ones they
 * OWN plus the ones SHARED with them via a workspace-roles ACL grant — matched
 * by displayName / itemType / description / tags, ranked, deep-linkable.
 *
 * ACL / TENANT BOUNDARY (critical): the accessible-workspace set is resolved
 * ONCE via {@link listAccessibleWorkspaces} (the Wave-1 chokepoint). That
 * resolver applies the owner fast-path, the `LOOM_MULTIUSER_ACL` kill switch,
 * and the `tid` tenant boundary, so search can NEVER return an item from a
 * workspace outside the caller's tenant / grants. Every backend path below is
 * constrained to that id set — the Cosmos query with `ARRAY_CONTAINS(@w, …)`
 * and the AI Search query with `search.in(workspaceId, …)` — and the AI Search
 * results are re-checked against the accessible set in memory (defense in depth)
 * because the derived index is keyed by the OWNER's oid, not the caller's.
 *
 * BACKEND: when Azure AI Search is provisioned (LOOM_AI_SEARCH_SERVICE) the
 * `loom-items` index provides the ranking (BM25); otherwise a Cosmos scan +
 * in-memory relevance score. Both return the identical {@link CatalogSearchHit}
 * shape (no-vaporware: real Cosmos query, no mock rows).
 */
import { listAccessibleWorkspaces } from '@/lib/auth/workspace-access';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { isSearchConfigured, searchLoomItemsInWorkspaces } from '@/lib/azure/loom-search';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** Soft-deleted-items filter fragment — excludes recycle-bin items. */
const NOT_RECYCLED = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

export interface CatalogSearchHit {
  /** The item id (deep-link: /items/<itemType>/<id>). */
  id: string;
  workspaceId: string;
  workspaceName: string;
  itemType: string;
  displayName: string;
  description?: string;
  /** Free-form tags + governance classifications matched by the query. */
  tags: string[];
  updatedAt?: string;
  /** Relative deep-link path into the Console. */
  url: string;
  /** Relevance score (AI Search @search.score, or the in-memory rank). */
  score: number;
}

export interface CatalogSearchResult {
  ok: true;
  q: string;
  /** Which backend served the ranking. */
  backend: 'ai-search' | 'cosmos';
  total: number;
  /** How many accessible workspaces were in scope (owned + shared). */
  workspacesSearched: number;
  hits: CatalogSearchHit[];
}

export interface CatalogSearchOpts {
  /** The caller's Entra object id (legacy code calls this `tenantId`). */
  oid: string;
  /** The caller's Entra tenant id (`tid` claim) — enforces the tenant boundary. */
  callerTid?: string;
  /** The caller's transitive group ids (unused for listing but kept for parity). */
  groups?: string[];
  /** Search text; empty string = browse-mode (most-recently-updated items). */
  q: string;
  /** Optional item-type filter (one or many). */
  types?: string[];
  /** Max hits to return (default 30, hard cap 200). */
  limit?: number;
}

/** Collect an item's searchable tags: free-form `state.tags` + governance `state.classifications`. */
function extractTags(state?: Record<string, unknown>): string[] {
  if (!state) return [];
  const out = new Set<string>();
  const raw = (state as Record<string, unknown>).tags;
  if (Array.isArray(raw)) for (const t of raw) if (t != null) out.add(String(t));
  const cls = (state as Record<string, unknown>).classifications;
  if (Array.isArray(cls)) for (const c of cls) if (c != null) out.add(String(c));
  return [...out];
}

/**
 * Relevance score for the Cosmos fallback path. Higher = more relevant.
 * Browse-mode (empty query) returns a flat 1 so everything passes and the
 * caller sorts by recency.
 */
function scoreItem(ql: string, name: string, itemType: string, description: string, tags: string[]): number {
  if (!ql) return 1;
  const n = name.toLowerCase();
  const ty = itemType.toLowerCase();
  const d = description.toLowerCase();
  let score = 0;
  if (n === ql) score = Math.max(score, 100);
  else if (n.startsWith(ql)) score = Math.max(score, 75);
  else if (n.includes(ql)) score = Math.max(score, 55);
  if (ty.includes(ql)) score = Math.max(score, 35);
  if (tags.some((t) => t.toLowerCase().includes(ql))) score = Math.max(score, 30);
  if (d.includes(ql)) score = Math.max(score, 20);
  return score;
}

/**
 * Estate-wide catalog search. Always ACL/tid-scoped to the caller's accessible
 * workspaces; never throws for the empty-estate case (returns zero hits).
 */
export async function searchCatalog(opts: CatalogSearchOpts): Promise<CatalogSearchResult> {
  const q = (opts.q || '').trim();
  const ql = q.toLowerCase();
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const typeSet = opts.types && opts.types.length ? new Set(opts.types) : null;

  // ── The chokepoint: owned + shared workspaces, tenant boundary applied. ──
  const workspaces = await listAccessibleWorkspaces(opts.oid, { callerTid: opts.callerTid });
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const wsIds = [...wsName.keys()];
  if (wsIds.length === 0) {
    return { ok: true, q, backend: isSearchConfigured() ? 'ai-search' : 'cosmos', total: 0, workspacesSearched: 0, hits: [] };
  }

  // ── Preferred path: AI Search ranking, scoped to the accessible workspaces. ──
  if (isSearchConfigured()) {
    try {
      const docs = await searchLoomItemsInWorkspaces({
        q,
        workspaceIds: wsIds,
        top: limit,
        // Push a single-type filter to the index; multi-type is filtered below.
        itemType: typeSet && typeSet.size === 1 ? [...typeSet][0] : undefined,
      });
      if (docs) {
        const hits: CatalogSearchHit[] = [];
        for (const d of docs) {
          // Defense in depth — the index is keyed by the OWNER oid, so re-check
          // every hit against the ACL-resolved accessible set before returning.
          if (!d.workspaceId || !wsName.has(d.workspaceId)) continue;
          if (typeSet && d.itemType && !typeSet.has(d.itemType)) continue;
          const rawId = d.id.replace(/^it[:_]/, '');
          hits.push({
            id: rawId,
            workspaceId: d.workspaceId,
            workspaceName: wsName.get(d.workspaceId) || d.workspaceId,
            itemType: d.itemType || 'item',
            displayName: d.displayName,
            description: d.description,
            tags: [],
            updatedAt: d.touchedAt,
            url: d.url || `/items/${d.itemType}/${rawId}`,
            score: d['@search.score'] ?? 0,
          });
        }
        return { ok: true, q, backend: 'ai-search', total: hits.length, workspacesSearched: wsIds.length, hits: hits.slice(0, limit) };
      }
      // docs === null → search unconfigured after all; fall through to Cosmos.
    } catch {
      // Search hit but errored — fall through to Cosmos as a safety net.
    }
  }

  // ── Fallback: Cosmos scan constrained to the accessible workspaces. ──
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<Pick<WorkspaceItem, 'id' | 'workspaceId' | 'itemType' | 'displayName' | 'description' | 'state' | 'updatedAt'>>({
      query:
        `SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.description, c.state, c.updatedAt ` +
        `FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId) AND ${NOT_RECYCLED}`,
      parameters: [{ name: '@w', value: wsIds }],
    })
    .fetchAll();

  const scored: CatalogSearchHit[] = [];
  for (const it of resources) {
    if (typeSet && !typeSet.has(it.itemType)) continue;
    const tags = extractTags(it.state);
    const score = scoreItem(ql, it.displayName || '', it.itemType || '', it.description || '', tags);
    if (score === 0) continue;
    scored.push({
      id: it.id,
      workspaceId: it.workspaceId,
      workspaceName: wsName.get(it.workspaceId) || it.workspaceId,
      itemType: it.itemType,
      displayName: it.displayName,
      description: it.description,
      tags,
      updatedAt: it.updatedAt,
      url: `/items/${it.itemType}/${it.id}`,
      score,
    });
  }
  // Rank by score, tie-break by recency (browse-mode is pure recency).
  scored.sort((a, b) => b.score - a.score || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { ok: true, q, backend: 'cosmos', total: scored.length, workspacesSearched: wsIds.length, hits: scored.slice(0, limit) };
}

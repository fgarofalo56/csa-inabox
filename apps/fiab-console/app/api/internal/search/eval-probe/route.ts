/**
 * POST /api/internal/search/eval-probe (SRCH1)
 *
 * The copilot-evaluator Function's window into the REAL federated catalog
 * search (lib/azure/catalog-search.searchCatalog) — the same estate-wide,
 * ACL/tenant-scoped search users type into `/catalog`. One call runs the exact
 * ranking (AI Search → Cosmos fallback) and returns the ranked hits
 * `{ id, displayName, itemType, score }` so the evaluator scores byte-identical
 * relevance (hit-rate@k / MRR / NDCG@k), never a reimplementation.
 *
 * Auth: machine-to-machine — the shared VNet-internal trust token
 * (LOOM_INTERNAL_TOKEN; fail-closed when unset), the SAME pattern as the E2
 * copilot eval-probe. `oid` in the body is the identity the search runs AS
 * (searchCatalog is ACL-scoped) — the evaluator passes LOOM_EVAL_PROBE_OID (the
 * seeded Demo/service identity that owns the golden items). No mock data.
 */
import { NextRequest } from 'next/server';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { searchCatalog } from '@/lib/azure/catalog-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });

  let body: { query?: string; oid?: string; tid?: string; top?: number; types?: string[] };
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const query = String(body?.query || '').trim();
  if (!query) return apiError('query is required', 400);

  // ACL scope: searchCatalog is always scoped to an identity's accessible
  // workspaces. The evaluator supplies the seeded identity; without one the
  // search would run over an empty accessible set → honest 400 (not silent 0s).
  const oid = String(body?.oid || process.env.LOOM_EVAL_PROBE_OID || '').trim();
  if (!oid) {
    return apiError(
      'oid is required — the search probe runs AS an identity (searchCatalog is ACL-scoped). Set LOOM_EVAL_PROBE_OID (the seeded Demo identity that owns the golden items) or pass oid in the body.',
      400,
      { code: 'no_probe_identity' },
    );
  }
  const top = Math.min(Math.max(Number(body?.top) || 10, 1), 50);

  try {
    const t0 = Date.now();
    const res = await searchCatalog({
      oid,
      callerTid: body?.tid ? String(body.tid) : undefined,
      q: query,
      types: Array.isArray(body?.types) ? body.types.map(String) : undefined,
      limit: top,
    });
    const latencyMs = Date.now() - t0;
    return apiOk({
      query,
      backend: res.backend,
      workspacesSearched: res.workspacesSearched,
      results: res.hits.map((h) => ({
        id: h.id,
        displayName: h.displayName,
        itemType: h.itemType,
        workspaceName: h.workspaceName,
        score: h.score,
        url: h.url,
      })),
      latencyMs,
    });
  } catch (e) {
    return apiServerError(e, 'search eval probe failed', 'search_eval_probe_failed');
  }
}

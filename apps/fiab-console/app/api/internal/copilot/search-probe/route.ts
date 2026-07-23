/**
 * POST /api/internal/copilot/search-probe — SRCH1.
 *
 * The copilot-evaluator Function's window into the REAL federated catalog search
 * (the search users type into /catalog): one call runs the exact
 * `searchCatalog()` ranking (governance-catalog / AI-Search → Cosmos fallback)
 * the marketplace uses, scoped to the configured EVAL PRINCIPAL, and returns the
 * top-K result identifiers so the evaluator scores byte-identical relevance
 * (hit-rate@k / MRR / NDCG@k) — never a reimplementation.
 *
 * Auth: machine-to-machine — the shared VNet-internal trust token
 * (LOOM_INTERNAL_TOKEN; fail-closed when unset), the SAME pattern as
 * /api/internal/copilot/eval-probe. A signed-in session is NOT accepted here.
 *
 * Eval principal: federated search is ACL-scoped per principal, so relevance is
 * measured as a real principal's search. LOOM_EVAL_SEARCH_PRINCIPAL_OID is the
 * oid whose accessible workspaces hold the golden (demo-seed) items — typically
 * the demo/admin oid. Honest 503 gate when unset (no-vaporware): no fabricated
 * results, ever. Azure-native, no Fabric dependency.
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

  const principal = (process.env.LOOM_EVAL_SEARCH_PRINCIPAL_OID || '').trim();
  if (!principal) {
    return apiError(
      'Federated-search evals are not configured — set LOOM_EVAL_SEARCH_PRINCIPAL_OID to the eval principal oid (the demo/admin oid whose accessible workspaces hold the golden items) so the search-probe can run searchCatalog as a real principal.',
      503,
      { code: 'no_eval_principal' },
    );
  }

  let body: { query?: string; top?: number; types?: string[] };
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const query = String(body?.query || '').trim();
  if (!query) return apiError('query is required', 400);
  const top = Math.min(Math.max(Number(body?.top) || 5, 1), 20);

  try {
    const t0 = Date.now();
    const res = await searchCatalog({
      oid: principal,
      q: query,
      limit: top,
      types: Array.isArray(body?.types) && body.types.length ? body.types.map(String) : undefined,
    });
    const latencyMs = Date.now() - t0;
    return apiOk({
      query,
      backend: res.backend,
      workspacesSearched: res.workspacesSearched,
      // Each result flattened to the identifiers the evaluator matches against:
      // display name, an estate-qualified name, item type, and the raw id.
      results: res.hits.map((h) => ({
        id: h.id,
        displayName: h.displayName,
        itemType: h.itemType,
        workspaceName: h.workspaceName,
        qualifiedName: `${h.workspaceName} · ${h.displayName}`,
        score: h.score,
      })),
      latencyMs,
    });
  } catch (e) {
    return apiServerError(e, 'search probe failed', 'search_probe_failed');
  }
}

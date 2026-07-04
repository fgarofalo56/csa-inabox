/**
 * POST /api/data-products/search — consumer discovery query for the Data
 * Marketplace (F14/F18), backed by the `loom-data-products` Azure AI Search
 * index.
 *
 * Real backend only (no-vaporware): every call hits the AI Search data-plane
 * via `searchDataProducts`, which ALWAYS injects `tenantId eq '<oid>'` and
 * `publishStatus eq 'Published'` so a consumer can only ever see Published
 * products in their own tenant. A Draft / Deprecated product never appears.
 *
 * Honest infra-gate: when `LOOM_AI_SEARCH_SERVICE` is unset the route returns
 * HTTP 503 with `{ ok:false, code:'not_configured', missing }` so the editor
 * renders a MessageBar naming the exact env var to set (bicep
 * platform/fiab/bicep/modules/admin-plane/ai-search.bicep). No Microsoft
 * Fabric / Power BI dependency on any path.
 *
 * Body: {
 *   q?: string,            // raw query; a "double-quoted phrase" does exact match
 *   filter?: string,       // extra OData filter from consumer-selected facets
 *   selectedFacets?: { domainName?: string[]; productType?: string[]; owner?: string[]; glossaryTerms?: string[]; CDEs?: string[] },
 *   top?: number, skip?: number, facets?: string[], orderBy?: string,
 * }
 * Returns: { ok, results, facets, count, searchResponse } | gate | error
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchDataProducts, buildFacetFilter, dataProductsSearchGate,
} from '@/lib/azure/loom-data-products-search';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FACET_FIELDS = ['domainName', 'productType', 'owner', 'glossaryTerms', 'CDEs'];

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest gate — AI Search not provisioned in this deployment.
  const gate = dataProductsSearchGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        missing: gate.missing,
        notDeployed: true,
        hint:
          'Azure AI Search is not provisioned in this deployment. Set LOOM_AI_SEARCH_SERVICE to a ' +
          'deployed Microsoft.Search/searchServices name (bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep).',
      },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const q = typeof body?.q === 'string' ? body.q : '';
  const top = Math.min(Math.max(Number(body?.top) || 25, 0), 100);
  const skip = Math.max(Number(body?.skip) || 0, 0);
  const orderBy = typeof body?.orderBy === 'string' ? body.orderBy : undefined;

  // Build the facet filter from selected buckets; an explicit raw `filter`
  // string is ANDed on top of it.
  const selected: Record<string, string[]> = {};
  const sf = body?.selectedFacets || {};
  for (const f of FACET_FIELDS) {
    if (Array.isArray(sf[f]) && sf[f].length) selected[f] = sf[f].map((x: unknown) => String(x));
  }
  const facetFilter = buildFacetFilter(selected);
  const rawFilter = typeof body?.filter === 'string' ? body.filter.trim() : '';
  const filter = [facetFilter, rawFilter].filter(Boolean).join(' and ');

  try {
    const out = await searchDataProducts({
      q,
      tenantId: s.claims.oid,
      filter: filter || undefined,
      top,
      skip,
      facets: Array.isArray(body?.facets) && body.facets.length ? body.facets : undefined,
      orderBy,
    });
    return NextResponse.json({
      ok: true,
      results: out.results,
      facets: out.facets,
      count: out.count,
      // Raw AI Search response — the editor's receipt panel surfaces this so an
      // operator can verify the live index responded.
      searchResponse: out.raw,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * GET /api/foundry/data-sources — the grounding-source picker for the Chat
 * playground's Azure OpenAI "On Your Data" flow.
 *
 * Lists the Azure AI Search indexes on the configured search service so the
 * playground can offer them as real grounding sources. Returns:
 *   { ok:true, configured:true, service, endpoint, indexes:[{name,vectorEnabled,fieldCount}] }
 * or, when AI Search isn't wired in this deployment, an HONEST config-only state
 * (200, no fake data — see .claude/rules/no-vaporware.md):
 *   { ok:true, configured:false, missing:'LOOM_AI_SEARCH_SERVICE', hint }
 *
 * Real AI Search data-plane REST via search-index-client. No mocks. The selected
 * index is threaded to POST /api/foundry/chat as `dataSources`, which maps it to
 * the chat completion's `data_sources[]` (On-Your-Data) server-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexes,
  resolveServiceName,
  searchServiceEndpoint,
  searchConfigGate,
  SearchNotDeployedError,
  SearchDataError,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_CONFIGURED_HINT =
  'Set LOOM_AI_SEARCH_SERVICE on the Console Container App to a deployed ' +
  'Microsoft.Search/searchServices name, and grant the Loom UAMI the ' +
  '"Search Index Data Reader" role on it (bicep: ' +
  'platform/fiab/bicep/modules/admin-plane/ai-search.bicep). For On-Your-Data ' +
  'grounding, the Azure OpenAI account\'s managed identity also needs ' +
  '"Search Index Data Reader" + "Search Service Contributor" on the search service.';

export async function GET(_req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const g = searchConfigGate();
  if (g) {
    return NextResponse.json({ ok: true, configured: false, missing: g.missing, hint: NOT_CONFIGURED_HINT });
  }
  try {
    const service = resolveServiceName();
    const endpoint = searchServiceEndpoint();
    const indexes = await listIndexes();
    return NextResponse.json({
      ok: true,
      configured: true,
      service,
      endpoint,
      indexes: indexes.map((i) => ({ name: i.name, vectorEnabled: i.vectorEnabled, fieldCount: i.fieldCount })),
    });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: true, configured: false, missing: 'LOOM_AI_SEARCH_SERVICE', hint: e.hint || NOT_CONFIGURED_HINT });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

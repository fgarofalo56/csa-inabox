/**
 * POST /api/items/gql-graph/[id]/query
 *   body: { query: string, backend?: 'fabric-graph' | 'cosmos-gremlin-translate' }
 *
 * v3.27: F-vaporware fix for gql-graph editor. Previously the Run button
 * emitted nothing — now it dispatches here. Fabric Graph REST executeQuery
 * is preview; if LOOM_FABRIC_GRAPH_WORKSPACE is not bound we return 501
 * with an explicit deferred-reason payload (rendered by ResultsPreview).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const query: string = body?.query || '';
  const backend: string = body?.backend || 'fabric-graph';

  if (!query.trim()) {
    return NextResponse.json({ ok: false, error: 'query required' }, { status: 400 });
  }

  if (backend === 'fabric-graph') {
    const workspace = process.env.LOOM_FABRIC_GRAPH_WORKSPACE;
    if (!workspace) {
      return NextResponse.json({
        ok: false,
        deferred: true,
        error: 'Fabric Graph executeQuery is preview and requires LOOM_FABRIC_GRAPH_WORKSPACE to be bound. Switch the editor backend to "Cosmos Gremlin (best-effort translate)" or "Persist-only" to use a wired path.',
        hint: 'Set LOOM_FABRIC_GRAPH_WORKSPACE=<workspace-id> in the Container App env and grant the Console UAMI Fabric Workspace Contributor on the target workspace.',
      }, { status: 501 });
    }
    // When wired: dispatch to Fabric Graph REST executeQuery endpoint.
    // POST https://api.fabric.microsoft.com/v1/workspaces/{ws}/graphs/{id}/executeQuery
    // Implementation deferred to the same session that adds lib/azure/fabric-graph-client.ts.
    return NextResponse.json({
      ok: false,
      deferred: true,
      error: 'Fabric Graph client not implemented yet. Workspace is bound but lib/azure/fabric-graph-client.ts is pending.',
    }, { status: 501 });
  }

  if (backend === 'cosmos-gremlin-translate') {
    return NextResponse.json({
      ok: false,
      deferred: true,
      error: 'GQL → Gremlin translation passthrough should be routed via /api/items/cosmos-gremlin-graph/[id]/query directly. Update the client to dispatch there instead.',
    }, { status: 501 });
  }

  return NextResponse.json({
    ok: false,
    error: `Unknown backend: ${backend}. Expected one of: fabric-graph, cosmos-gremlin-translate.`,
  }, { status: 400 });
}

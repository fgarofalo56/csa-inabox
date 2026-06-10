/**
 * GET  /api/items/materialized-lake-view/[id]/lineage
 *   Returns the MLV's cross-workspace dependency graph from Cosmos:
 *   upstream source edges (source-table → MLV) + downstream MLVs that consume
 *   it. Shaped as { ok, focusId, nodes, edges } for the lineage canvas.
 *
 * POST /api/items/materialized-lake-view/[id]/lineage
 *   Re-derives lineage edges from the saved (or supplied) definition and
 *   persists them to Cosmos, then returns the refreshed graph.
 *
 * This is Loom's own Azure-native lineage store (Cosmos thread-edges) — no
 * dependency on a real Microsoft Fabric / OneLake lineage tenant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMlvItem, specFromItem } from '../../_lib/load';
import { getMlvLineage, setMlvLineage, type MlvLineageEdgeInput } from '@/lib/thread/mlv-lineage';
import { deriveSources, type MlvSpec } from '@/lib/azure/materialized-lake-view-model';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toGraph(focusId: string, focusName: string, graph: Awaited<ReturnType<typeof getMlvLineage>>) {
  const nodes: Array<{ id: string; label: string; type?: string; focus?: boolean; openHref?: string }> = [];
  const seen = new Set<string>();
  const ensure = (n: { id: string; label: string; type?: string; focus?: boolean; openHref?: string }) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  ensure({ id: focusId, label: focusName, type: 'materialized-lake-view', focus: true, openHref: `/items/materialized-lake-view/${encodeURIComponent(focusId)}` });
  const edges: Array<{ from: string; to: string; type?: string }> = [];
  for (const e of graph.upstream) {
    ensure({
      id: e.fromItemId,
      label: e.fromName || e.fromItemId,
      type: e.fromType,
      openHref: e.fromType && e.fromType !== 'delta-table' ? `/items/${e.fromType}/${encodeURIComponent(e.fromItemId)}` : undefined,
    });
    edges.push({ from: e.fromItemId, to: focusId });
  }
  for (const e of graph.downstream) {
    ensure({
      id: e.toItemId,
      label: e.toName || e.toItemId,
      type: e.toType,
      openHref: `/items/${e.toType}/${encodeURIComponent(e.toItemId)}`,
    });
    edges.push({ from: focusId, to: e.toItemId });
  }
  return { nodes, edges };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let item: WorkspaceItem | null;
  try { item = await loadMlvItem(id, session.claims.oid); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'lookup failed' }, { status: 500 }); }
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const graph = await getMlvLineage(session, item.id);
  const { nodes, edges } = toGraph(item.id, item.displayName, graph);
  return NextResponse.json({ ok: true, focusId: item.id, nodes, edges, upstream: graph.upstream, downstream: graph.downstream });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  let item: WorkspaceItem | null;
  try { item = await loadMlvItem(id, session.claims.oid); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'lookup failed' }, { status: 500 }); }
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const spec: MlvSpec | null = (body?.spec && typeof body.spec === 'object' ? body.spec : null) || specFromItem(item);
  if (!spec) return NextResponse.json({ ok: false, error: 'No MLV definition to derive lineage from.' }, { status: 400 });

  const sources = deriveSources(spec);
  const edges: MlvLineageEdgeInput[] = sources.map((s) => ({
    mlvItemId: item!.id,
    mlvName: item!.displayName,
    workspaceId: item!.workspaceId,
    source: s,
  }));
  const { written } = await setMlvLineage(session, { itemId: item.id, name: item.displayName, workspaceId: item.workspaceId }, edges);

  const graph = await getMlvLineage(session, item.id);
  const g = toGraph(item.id, item.displayName, graph);
  return NextResponse.json({ ok: true, written, derivedSources: sources, focusId: item.id, nodes: g.nodes, edges: g.edges });
}

/**
 * Mirrored-Database change feed → Eventstream connector (rel-T90).
 *
 * GET  /api/items/eventstream/[id]/mirror-cdf
 *   List the mirrored databases in this eventstream's workspace (+ their
 *   replicated tables) so the source inspector can bind a real mirror + tables.
 *
 * POST /api/items/eventstream/[id]/mirror-cdf   body: { action: 'drain', nodeIdx }
 *   Produce the Spark-staged Delta change-data-feed rows for the bound
 *   mirror-cdf source node to its Event Hub over the real HTTPS data plane.
 *
 * Provisioning (ensure the sink hub + submit the Spark CDF-reader batch) is
 * handled by the shared source route (POST …/source with kind:'mirror-cdf'),
 * which persists the source node; this route reads that persisted binding.
 *
 * Owner-scoped: loadKustoItem() verifies the caller's tenant owns the
 * eventstream's workspace; mirrors are listed only from that same workspace.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem } from '@/lib/azure/kusto-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { drainMirrorCdf } from '@/lib/azure/mirror-cdf-producer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface MirrorOption { id: string; name: string; workspaceId: string; tables: string[] }

/** Replicated table identifiers ("schema.table") recorded on a mirror's state. */
function mirrorTables(state: Record<string, any> | undefined): string[] {
  const out = new Set<string>();
  const push = (schema: unknown, table: unknown) => {
    const t = String(table || '').trim();
    if (!t) return;
    const s = String(schema || '').trim();
    out.add(s ? `${s}.${t}` : t);
  };
  const status: any[] = Array.isArray(state?.tablesStatus) ? state!.tablesStatus : [];
  for (const r of status) push(r?.schema, r?.table);
  const tables: any[] = Array.isArray(state?.tables) ? state!.tables : [];
  for (const r of tables) push(r?.schema, r?.table);
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return apiNotFound();
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem & Record<string, any>>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t',
        parameters: [
          { name: '@w', value: item.workspaceId },
          { name: '@t', value: 'mirrored-database' },
        ],
      })
      .fetchAll();
    const mirrors: MirrorOption[] = resources.map((m) => ({
      id: m.id,
      name: m.displayName || m.id,
      workspaceId: m.workspaceId,
      tables: mirrorTables(m.state as Record<string, any>),
    }));
    return apiOk({ mirrors });
  } catch (e) {
    return apiServerError(e, 'could not list mirrored databases');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || 'drain');
  const nodeIdx = Number.isInteger(body?.nodeIdx) ? body.nodeIdx : 0;
  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return apiNotFound();

    // Resolve the bound mirror-cdf source node from the persisted topology.
    const sources: any[] = Array.isArray(item.state?.sources)
      ? (item.state!.sources as any[])
      : (item.state?.source ? [item.state.source] : []);
    const node = (nodeIdx >= 0 ? sources[nodeIdx] : sources[0]) as Record<string, any> | undefined;
    if (!node) return apiNotFound('source node not found');
    if (node.kind !== 'mirror-cdf') return apiError('this source is not a Mirrored-DB change feed', 400);
    if (!node.mirrorItemId || !node.mirrorWorkspaceId) {
      return apiError('bind a mirrored database + tables on this source first', 409);
    }

    if (action !== 'drain') return apiError(`unsupported action: ${action}`, 400);

    const result = await drainMirrorCdf({
      eventstreamId: id,
      nodeIdx,
      mirrorId: String(node.mirrorItemId),
      mirrorWorkspaceId: String(node.mirrorWorkspaceId),
    });
    if (!result.ok && result.gate) {
      return apiError(result.gate.message, 503, { code: 'not_configured', missing: result.gate.missing });
    }
    if (!result.ok) return apiError(result.error || 'drain failed', 502);
    return apiOk({
      status: result.status, hub: result.hub, produced: result.produced,
      files: result.files, note: result.note,
    });
  } catch (e) {
    return apiServerError(e, 'mirror change-feed drain failed');
  }
}

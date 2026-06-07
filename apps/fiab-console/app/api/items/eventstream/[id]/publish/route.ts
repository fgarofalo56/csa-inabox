/**
 * POST /api/items/eventstream/[id]/publish
 *
 * Publishes the saved Cosmos pipeline config to a REAL Fabric Eventstream
 * item via the definition-based Fabric REST API
 * (POST /workspaces/{ws}/eventstreams with a Base64 eventstream.json part,
 * or updateDefinition when a fabricEventstreamId already exists).
 *
 * The Loom config { source, transforms[], sink } is translated into the
 * Fabric Eventstream topology shape { sources[], destinations[],
 * operators[], streams[] } before publish.
 *
 * Requires a real Fabric workspace id (`fabricWorkspaceId`) — Loom Cosmos
 * workspace UUIDs are not Fabric workspace ids. If the Console UAMI is not
 * authorized in the Fabric tenant, the FabricError (401/403) is surfaced
 * verbatim with a remediation hint — no mock success.
 *
 * GET /api/items/eventstream/[id]/list?fabricWorkspaceId=...
 * is handled by the sibling route; this file only publishes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import { publishEventstream, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LoomNode { kind?: string; name?: string; [k: string]: unknown }
interface LoomConfig {
  source?: LoomNode | null;
  sources?: LoomNode[];
  sink?: LoomNode | null;
  sinks?: LoomNode[];
  transforms?: LoomNode[];
}

/**
 * Translate the Loom designer config into the Fabric Eventstream topology
 * envelope. We keep the original Loom node config under `properties` so the
 * round-trip is loss-less; Fabric ignores unknown keys it doesn't map.
 */
function toFabricTopology(cfg: LoomConfig, displayName: string) {
  const sources = (cfg.sources && cfg.sources.length ? cfg.sources : (cfg.source ? [cfg.source] : []))
    .map((n, i) => ({ name: n.name || `source-${i + 1}`, type: mapSourceType(n.kind), properties: n }));
  const destinations = (cfg.sinks && cfg.sinks.length ? cfg.sinks : (cfg.sink ? [cfg.sink] : []))
    .map((n, i) => ({ name: n.name || `destination-${i + 1}`, type: mapSinkType(n.kind), properties: n }));
  const operators = (cfg.transforms || [])
    .map((n, i) => ({ name: n.name || `operator-${i + 1}`, type: mapOperatorType(n.kind), properties: n }));
  return {
    name: displayName,
    sources,
    destinations,
    operators,
    streams: [{ name: `${displayName}-stream`, type: 'DefaultStream', properties: {} }],
    compatibilityLevel: '1.0',
  };
}

function mapSourceType(kind?: string): string {
  switch (kind) {
    case 'eventhub': return 'AzureEventHub';
    case 'iothub': return 'AzureIoTHub';
    case 'kafka': return 'CustomEndpoint';
    case 'cdc-mirror': return 'SQLServerCDC';
    case 'custom-app': return 'CustomEndpoint';
    case 'sample': return 'SampleData';
    default: return 'CustomEndpoint';
  }
}
function mapSinkType(kind?: string): string {
  switch (kind) {
    case 'kusto': return 'Eventhouse';
    case 'lakehouse': return 'Lakehouse';
    case 'eventhub': return 'CustomEndpoint';
    case 'reflex': return 'Activator';
    case 'derivedStream': return 'DerivedStream';
    default: return 'CustomEndpoint';
  }
}
function mapOperatorType(kind?: string): string {
  switch (kind) {
    case 'filter': return 'Filter';
    case 'aggregate': return 'Aggregate';
    case 'group-by': return 'GroupBy';
    case 'project': return 'ManageFields';
    case 'union': return 'Union';
    case 'join': return 'Join';
    default: return 'Filter';
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const fabricWorkspaceId = req.nextUrl.searchParams.get('fabricWorkspaceId');
  if (!fabricWorkspaceId) {
    return NextResponse.json({
      ok: false,
      error: 'fabricWorkspaceId is required to publish to Fabric.',
      hint: 'Provide the Fabric workspace GUID (app.fabric.microsoft.com → workspace → Settings → copy the workspace ID). The Console UAMI must be a Contributor (or higher) on that workspace.',
    }, { status: 400 });
  }

  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const cfg: LoomConfig = {
      source: item.state?.source as LoomNode | undefined,
      sink: item.state?.sink as LoomNode | undefined,
      transforms: Array.isArray(item.state?.transforms) ? (item.state!.transforms as LoomNode[]) : [],
    };
    const sourceCount = cfg.source ? 1 : 0;
    const sinkCount = cfg.sink ? 1 : 0;
    if (sourceCount === 0 || sinkCount === 0) {
      return NextResponse.json({
        ok: false,
        error: 'Pipeline must have at least one source and one destination before publishing.',
      }, { status: 422 });
    }

    const displayName = item.displayName || `eventstream-${id}`;
    const topology = toFabricTopology(cfg, displayName);
    const existingFabricId = typeof item.state?.fabricEventstreamId === 'string'
      ? (item.state!.fabricEventstreamId as string)
      : undefined;

    const result = await publishEventstream(fabricWorkspaceId, {
      id: existingFabricId,
      displayName,
      description: 'Published from CSA Loom Eventstream designer',
      topology,
    });

    // Persist the Fabric workspace + item id so subsequent publishes update
    // (rather than re-create) and the editor can show the live link.
    const fabricEventstreamId = (result as any)?.id || existingFabricId;
    await saveItemState(item, {
      fabricWorkspaceId,
      fabricEventstreamId: fabricEventstreamId ?? null,
      lastPublishedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      published: true,
      accepted: (result as any)?._accepted === true,
      fabricEventstreamId: fabricEventstreamId ?? null,
      fabricWorkspaceId,
      operationLocation: (result as any)?.location,
    });
  } catch (e: any) {
    if (e instanceof FabricError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

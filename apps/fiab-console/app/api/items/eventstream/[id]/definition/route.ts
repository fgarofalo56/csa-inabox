/**
 * GET /api/items/eventstream/[id]/definition?fabricWorkspaceId=...
 *
 * Pulls the LIVE Fabric Eventstream item definition (the topology
 * eventstream.json) back from Fabric via the real getDefinition REST API,
 * decodes the Base64 payload, and projects it into the Loom designer shape
 * { source, transforms[], sink } so the visual canvas can render the
 * authoritative server-side topology — not just the locally-saved Cosmos copy.
 *
 * Requires the item to have been published (it stores fabricEventstreamId +
 * fabricWorkspaceId in Cosmos state). The caller may override the workspace
 * via the query param. If the Console UAMI is not authorized in Fabric, the
 * FabricError (401/403) is surfaced verbatim with a remediation hint.
 *
 * Docs: https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/api-get-eventstream-definition
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import { getEventstreamDefinition, FabricError, type FabricItemDefinition } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reverse-map a Fabric topology back to the Loom { source, transforms, sink } config. */
function fromFabricTopology(topo: any): { source?: any; transforms: any[]; sink?: any; sources?: any[]; sinks?: any[] } {
  const srcType = (t?: string): string => {
    switch (t) {
      case 'AzureEventHub': return 'eventhub';
      case 'AzureIoTHub': return 'iothub';
      case 'SampleData': return 'sample';
      case 'SQLServerCDC': return 'cdc-mirror';
      default: return 'eventhub';
    }
  };
  const sinkType = (t?: string): string => {
    switch (t) {
      case 'Eventhouse': return 'kusto';
      case 'Lakehouse': return 'lakehouse';
      case 'Activator': return 'reflex';
      case 'DerivedStream': return 'derivedStream';
      default: return 'eventhub';
    }
  };
  const opType = (t?: string): string => {
    switch (t) {
      case 'Filter': return 'filter';
      case 'Aggregate': return 'aggregate';
      case 'GroupBy': return 'group-by';
      case 'ManageFields': return 'project';
      case 'Union': return 'union';
      case 'Join': return 'join';
      default: return 'filter';
    }
  };
  const sources = (topo?.sources || []).map((n: any) => ({ kind: srcType(n.type), name: n.name, ...(n.properties || {}) }));
  const sinks = (topo?.destinations || []).map((n: any) => ({ kind: sinkType(n.type), name: n.name, ...(n.properties || {}) }));
  const transforms = (topo?.operators || []).map((n: any) => ({ kind: opType(n.type), name: n.name, ...(n.properties || {}) }));
  return {
    source: sources[0],
    sink: sinks[0],
    transforms,
    ...(sources.length > 1 ? { sources } : {}),
    ...(sinks.length > 1 ? { sinks } : {}),
  };
}

function decodeDefinition(def: FabricItemDefinition): any | null {
  const part = (def.parts || []).find((p) => p.path === 'eventstream.json') || (def.parts || [])[0];
  if (!part?.payload) return null;
  try {
    const json = Buffer.from(part.payload, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const fabricWorkspaceId = req.nextUrl.searchParams.get('fabricWorkspaceId')
      || (typeof item.state?.fabricWorkspaceId === 'string' ? item.state.fabricWorkspaceId : '');
    const fabricEventstreamId = typeof item.state?.fabricEventstreamId === 'string' ? item.state.fabricEventstreamId : '';

    if (!fabricWorkspaceId || !fabricEventstreamId) {
      return NextResponse.json({
        ok: false,
        error: 'This Eventstream has not been published to Fabric yet — there is no live definition to pull.',
        hint: 'Use "Publish to Fabric" first, then "Pull from Fabric" to round-trip the server-side topology.',
      }, { status: 409 });
    }

    const def = await getEventstreamDefinition(fabricWorkspaceId, fabricEventstreamId);
    if ((def as any)?._accepted) {
      return NextResponse.json({ ok: false, error: 'Fabric returned a long-running operation; retry the pull in a few seconds.' }, { status: 202 });
    }
    const topology = decodeDefinition(def as FabricItemDefinition);
    if (!topology) {
      return NextResponse.json({ ok: false, error: 'Could not decode the Fabric Eventstream definition payload.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, fabricWorkspaceId, fabricEventstreamId, topology, config: fromFabricTopology(topology) });
  } catch (e: any) {
    if (e instanceof FabricError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

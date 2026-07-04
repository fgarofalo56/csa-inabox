/**
 * GET /api/realtime-hub/endpoints?workspaceId=...&eventstreamId=...
 *
 * Real-Time Hub stream "endpoints" — surfaces the connection endpoints of an
 * eventstream so producers/consumers can wire up. **Azure-native by default**
 * (no Microsoft Fabric, per no-fabric-dependency.md): reads the Loom-native
 * eventstream item's topology from Cosmos (`state.definition`) and projects each
 * source / operator / destination into a connectable endpoint descriptor.
 *
 * Fabric opt-in: set `LOOM_EVENTSTREAM_BACKEND=fabric` and pass a
 * `fabricWorkspaceId` to pull the LIVE Fabric eventstream definition instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { getEventstreamDefinition, FabricError, type FabricItemDefinition } from '@/lib/azure/fabric-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_OPT_IN = (process.env.LOOM_EVENTSTREAM_BACKEND || '').toLowerCase() === 'fabric';

export interface StreamEndpoint {
  name: string;
  role: 'source' | 'destination' | 'stream';
  type?: string;
  properties?: Record<string, unknown>;
}

function decodeDefinition(def: FabricItemDefinition): any | null {
  const part = (def.parts || []).find((p) => p.path === 'eventstream.json') || (def.parts || [])[0];
  if (!part?.payload) return null;
  try { return JSON.parse(Buffer.from(part.payload, 'base64').toString('utf-8')); } catch { return null; }
}

function projectTopology(topo: any): StreamEndpoint[] {
  const endpoints: StreamEndpoint[] = [];
  for (const s of (topo?.sources || [])) endpoints.push({ name: s.name, role: 'source', type: s.type, properties: s.properties || {} });
  for (const d of (topo?.destinations || [])) endpoints.push({ name: d.name, role: 'destination', type: d.type, properties: d.properties || {} });
  for (const st of (topo?.streams || [])) endpoints.push({ name: st.name, role: 'stream', type: st.type, properties: st.properties || {} });
  return endpoints;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const eventstreamId = (req.nextUrl.searchParams.get('eventstreamId') || '').trim();
  if (!eventstreamId) return NextResponse.json({ ok: false, error: 'eventstreamId is required.' }, { status: 400 });

  // ---- Fabric opt-in path ----
  const fabricWorkspaceId = (req.nextUrl.searchParams.get('fabricWorkspaceId') || '').trim();
  if (FABRIC_OPT_IN && fabricWorkspaceId) {
    try {
      const def = await getEventstreamDefinition(fabricWorkspaceId, eventstreamId);
      if ((def as any)?._accepted) return NextResponse.json({ ok: false, error: 'Fabric returned a long-running operation; retry shortly.' }, { status: 202 });
      const topo = decodeDefinition(def as FabricItemDefinition);
      if (!topo) return NextResponse.json({ ok: false, error: 'Could not decode the eventstream definition.' }, { status: 502 });
      return NextResponse.json({ ok: true, backend: 'fabric', eventstreamId, endpoints: projectTopology(topo) });
    } catch (e: any) {
      if (e instanceof FabricError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
      return apiServerError(e);
    }
  }

  // ---- Azure-native default: Loom eventstream item topology ----
  const item = await loadOwnedItem(eventstreamId, 'eventstream', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'eventstream not found' }, { status: 404 });
  const topo = (item.state as any)?.definition || {};
  const endpoints = projectTopology(topo);
  if (!endpoints.length) {
    return NextResponse.json({ ok: true, backend: 'azure-native', eventstreamId, endpoints: [], note: 'This eventstream has no sources/destinations yet — open it to add them on the canvas.' });
  }
  return NextResponse.json({ ok: true, backend: 'azure-native', eventstreamId, endpoints });
}

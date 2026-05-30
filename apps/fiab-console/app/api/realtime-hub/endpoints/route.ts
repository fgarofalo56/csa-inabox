/**
 * GET /api/realtime-hub/endpoints?fabricWorkspaceId=...&eventstreamId=...
 *
 * Fabric Real-Time Hub stream "endpoints" — surfaces the connection
 * endpoints of an eventstream so producers/consumers can wire up. We pull
 * the LIVE eventstream item definition (the topology eventstream.json) via
 * the real Fabric getDefinition REST API, decode the Base64 payload, and
 * project each source / destination into a connectable endpoint descriptor
 * (CustomEndpoint exposes Event Hub-compatible / Kafka / AMQP connection
 * info; managed sources expose their connection id + type).
 * (https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/api-get-eventstream-definition)
 *
 * No mocks — if the stream isn't reachable or the UAMI isn't authorized,
 * the FabricError surfaces verbatim with a hint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getEventstreamDefinition, FabricError, type FabricItemDefinition } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface StreamEndpoint {
  /** Endpoint name (== topology node name). */
  name: string;
  /** 'source' | 'destination' | 'stream'. */
  role: 'source' | 'destination' | 'stream';
  /** Fabric source/destination type enum (e.g. AzureEventHub, CustomEndpoint). */
  type?: string;
  /** Connection-relevant properties surfaced from the topology node. */
  properties?: Record<string, unknown>;
}

function decodeDefinition(def: FabricItemDefinition): any | null {
  const part = (def.parts || []).find((p) => p.path === 'eventstream.json') || (def.parts || [])[0];
  if (!part?.payload) return null;
  try {
    return JSON.parse(Buffer.from(part.payload, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const fabricWorkspaceId = (req.nextUrl.searchParams.get('fabricWorkspaceId') || '').trim();
  const eventstreamId = (req.nextUrl.searchParams.get('eventstreamId') || '').trim();
  if (!fabricWorkspaceId || !eventstreamId) {
    return NextResponse.json({
      ok: false,
      error: 'fabricWorkspaceId and eventstreamId are both required.',
    }, { status: 400 });
  }

  try {
    const def = await getEventstreamDefinition(fabricWorkspaceId, eventstreamId);
    if ((def as any)?._accepted) {
      return NextResponse.json({ ok: false, error: 'Fabric returned a long-running operation; retry in a few seconds.' }, { status: 202 });
    }
    const topo = decodeDefinition(def as FabricItemDefinition);
    if (!topo) {
      return NextResponse.json({ ok: false, error: 'Could not decode the eventstream definition payload.' }, { status: 502 });
    }
    const endpoints: StreamEndpoint[] = [];
    for (const s of (topo.sources || [])) {
      endpoints.push({ name: s.name, role: 'source', type: s.type, properties: s.properties || {} });
    }
    for (const d of (topo.destinations || [])) {
      endpoints.push({ name: d.name, role: 'destination', type: d.type, properties: d.properties || {} });
    }
    for (const st of (topo.streams || [])) {
      endpoints.push({ name: st.name, role: 'stream', type: st.type, properties: st.properties || {} });
    }
    return NextResponse.json({ ok: true, fabricWorkspaceId, eventstreamId, endpoints });
  } catch (e: any) {
    if (e instanceof FabricError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

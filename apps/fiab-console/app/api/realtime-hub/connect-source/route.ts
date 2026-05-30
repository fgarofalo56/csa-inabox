/**
 * POST /api/realtime-hub/connect-source
 *
 * Fabric Real-Time Hub "Connect source" / "Get events" flow. Creates a
 * REAL Fabric Eventstream item carrying the chosen Microsoft / Fabric /
 * Azure streaming source (Azure Event Hubs, IoT Hub, Service Bus, Kafka,
 * SQL/Cosmos/Postgres/MySQL CDC, Blob Storage events, Fabric workspace-
 * item / job / OneLake events, etc.).
 *
 * Backend: POST /workspaces/{ws}/eventstreams with a Base64 eventstream.json
 * topology part whose `sources[0].type` is the documented Fabric source
 * enum value — the same definition REST API the Eventstream editor uses.
 * (https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api)
 *
 * No mock success. If the Console UAMI is not authorized in the Fabric
 * tenant, the FabricError (401/403) is surfaced verbatim with a hint.
 *
 * Body:
 *   {
 *     fabricWorkspaceId: string,   // required — Fabric workspace GUID
 *     displayName: string,          // required — new eventstream name
 *     sourceType: RthSourceType,    // required — Fabric source enum
 *     sourceName?: string,
 *     description?: string,
 *     properties?: Record<string, unknown>  // source-specific connection settings
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  connectEventstreamSource,
  isRthSourceType,
  RTH_SOURCE_TYPES,
  FabricError,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Content-type guard — reject non-JSON bodies with 415 before parsing.
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json(
      { ok: false, error: 'Content-Type must be application/json' },
      { status: 415 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const fabricWorkspaceId = String(body.fabricWorkspaceId || '').trim();
  const displayName = String(body.displayName || '').trim();
  const sourceType = String(body.sourceType || '').trim();
  const sourceName = String(body.sourceName || 'source-1').trim() || 'source-1';

  if (!fabricWorkspaceId) {
    return NextResponse.json({
      ok: false,
      error: 'fabricWorkspaceId is required.',
      hint: 'Provide the Fabric workspace GUID (app.fabric.microsoft.com → workspace → Settings → copy the workspace ID). The Console UAMI must be a Contributor (or higher) on that workspace.',
    }, { status: 400 });
  }
  if (!displayName) {
    return NextResponse.json({ ok: false, error: 'displayName is required.' }, { status: 400 });
  }
  if (!isRthSourceType(sourceType)) {
    return NextResponse.json({
      ok: false,
      error: `Unsupported sourceType "${sourceType}".`,
      hint: `Allowed source types: ${RTH_SOURCE_TYPES.join(', ')}`,
    }, { status: 400 });
  }

  try {
    const result = await connectEventstreamSource(fabricWorkspaceId, {
      displayName,
      description: body.description ? String(body.description) : 'Connected from CSA Loom Real-Time Hub',
      sourceName,
      sourceType,
      properties: (body.properties && typeof body.properties === 'object') ? body.properties : {},
    });
    return NextResponse.json({
      ok: true,
      connected: true,
      accepted: (result as any)?._accepted === true,
      fabricEventstreamId: (result as any)?.id ?? null,
      fabricWorkspaceId,
      sourceType,
      operationLocation: (result as any)?.location,
    });
  } catch (e: any) {
    if (e instanceof FabricError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

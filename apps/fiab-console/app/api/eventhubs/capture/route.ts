/**
 * Capture configuration for a single event hub (the namespace navigator →
 * per-hub "Configure capture" panel). Reads and writes the captureDescription
 * inline on the Microsoft.EventHub/namespaces/{ns}/eventhubs/{eh} ARM resource.
 *
 *   GET /api/eventhubs/capture?hub=NAME         → { ok, capture: CaptureSpec | null }
 *   PUT /api/eventhubs/capture  body { hub, enabled, storageAccountResourceId?,
 *        blobContainer?, intervalInSeconds?, sizeLimitInBytes?, archiveNameFormat?,
 *        skipEmptyArchives?, destination? }      → { ok, hub: EventHubEntity }
 *
 * Avro is the only ARM-supported encoding. The Console UAMI needs Storage Blob
 * Data Contributor on the target storage account for Capture writes to succeed.
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, getEventHubCapture, updateEventHubCapture,
  type CaptureSpec,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = eventhubsConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Event Hubs namespace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const hub = req.nextUrl.searchParams.get('hub')?.trim();
  if (!hub) return NextResponse.json({ ok: false, error: 'hub query param is required' }, { status: 400 });
  try {
    const capture = await getEventHubCapture(hub);
    return NextResponse.json({ ok: true, capture });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const hub: string = typeof body?.hub === 'string' ? body.hub.trim() : '';
  if (!hub) return NextResponse.json({ ok: false, error: 'hub is required' }, { status: 400 });
  const spec: CaptureSpec = {
    enabled: !!body?.enabled,
    storageAccountResourceId: typeof body?.storageAccountResourceId === 'string' ? body.storageAccountResourceId : undefined,
    blobContainer: typeof body?.blobContainer === 'string' ? body.blobContainer : undefined,
    intervalInSeconds: Number.isFinite(body?.intervalInSeconds) ? Number(body.intervalInSeconds) : undefined,
    sizeLimitInBytes: Number.isFinite(body?.sizeLimitInBytes) ? Number(body.sizeLimitInBytes) : undefined,
    archiveNameFormat: typeof body?.archiveNameFormat === 'string' ? body.archiveNameFormat : undefined,
    skipEmptyArchives: typeof body?.skipEmptyArchives === 'boolean' ? body.skipEmptyArchives : undefined,
    destination: body?.destination === 'DataLake' ? 'DataLake' : (body?.destination === 'BlockBlob' ? 'BlockBlob' : undefined),
  };
  try {
    const result = await updateEventHubCapture(hub, spec);
    return NextResponse.json({ ok: true, hub: result });
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/**
 * POST /api/items/azure-sql-database/[id]/query/cancel
 *   body { requestId: string }
 *
 * Sends a TDS ATTENTION packet to the in-flight mssql `Request` identified by
 * `requestId`, causing the tedious driver to reject the running `.query()`
 * promise with `RequestError('Canceled.', 'ECANCEL')`. The /query route's catch
 * block then surfaces this to the client as
 * `{ ok: false, error: 'Canceled.', code: 'ECANCEL' }` — that response IS the
 * "TDS reports cancellation" receipt.
 *
 * `requestId` is generated client-side (crypto.randomUUID()) and passed in the
 * /query POST body so the BFF registers the Request in `liveRequests` BEFORE
 * execution begins.
 *
 * Scope note: `liveRequests` is in-process Node.js state on ONE Container App
 * replica. In a scaled-out deployment the cancel POST must reach the SAME
 * replica that started the query — enable ingress sticky sessions
 * (`ingress.stickySessions.affinity: 'sticky'`) or run a single replica. The
 * mssql connection is per-replica, so cross-replica cancel is not meaningful.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { liveRequests } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const requestId = String(body?.requestId || '').trim();
  if (!requestId) {
    return NextResponse.json({ ok: false, error: 'requestId is required' }, { status: 400 });
  }
  const request = liveRequests.get(requestId);
  if (!request) {
    // Already completed, never registered, or handled by another replica —
    // idempotent success so the UI can call cancel without racing completion.
    return NextResponse.json({ ok: true, cancelled: false, reason: 'not found — already completed or on another replica' });
  }
  try {
    request.cancel(); // tedious: connection.cancel() → TDS ATTENTION packet
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  liveRequests.delete(requestId);
  return NextResponse.json({ ok: true, cancelled: true, requestId });
}

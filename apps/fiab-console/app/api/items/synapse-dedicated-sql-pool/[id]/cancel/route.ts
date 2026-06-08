/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/cancel
 * body: { queryId }
 *
 * Sends a TDS ATTENTION packet (mssql `Request.cancel()`) to abort the
 * in-flight T-SQL batch on the Dedicated SQL pool. The client generates a
 * queryId and includes it in the /query body; this route resolves that id to
 * the running request and cancels it.
 *
 * Same-process scope: the request must be in-flight on this Node.js process
 * (holds for single-instance Container App deployments). On scale-out the
 * cancel may land on a different replica and return found:false — the client
 * shows "Cancel sent" and the query completes normally on its own replica.
 * (Production multi-instance would back this with Redis-signalled cancel.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelActiveQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const queryId = (body?.queryId || '').toString().trim();
  if (!queryId) return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });

  const found = cancelActiveQuery(queryId);
  return NextResponse.json({ ok: true, canceled: found, found, canceledBy: session.claims?.upn });
}

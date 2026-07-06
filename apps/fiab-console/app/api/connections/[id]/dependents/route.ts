/**
 * GET /api/connections/[id]/dependents
 *
 * List the items that still bind this connection (mirrored-database sources,
 * report "Get Data" sources — see findConnectionDependents). The Connections
 * page calls this before a delete so it can list dependents in the themed
 * ConfirmDialog and block an orphaning delete (the DELETE route also enforces a
 * 409 server-side, rel-T99). Real Cosmos query — never a fabricated empty list.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { findConnectionDependents } from '@/lib/azure/connections-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const dependents = await findConnectionDependents(session.claims.oid, params.id);
    return apiOk({ dependents });
  } catch (e) {
    return apiServerError(e);
  }
}

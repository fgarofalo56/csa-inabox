/**
 * GET /api/items/synapse-dedicated-sql-pool/[id]/connection
 *
 * Synapse Dedicated pool connection details (FQDN `<ws>.<suffix>`, JDBC URL,
 * sqlcmd snippet). Database is the env-bound LOOM_SYNAPSE_DEDICATED_POOL. The
 * JDBC host + cert wildcard carry the Gov suffix in GCC-High / IL5 / DoD.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { handleConnectionDetails } from '@/app/api/items/_lib/connection-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  return handleConnectionDetails('synapse-dedicated-sql-pool');
}

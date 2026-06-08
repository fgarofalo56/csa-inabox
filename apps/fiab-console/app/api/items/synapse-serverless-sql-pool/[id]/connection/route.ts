/**
 * GET /api/items/synapse-serverless-sql-pool/[id]/connection?database=
 *
 * Synapse Serverless connection details (FQDN `<ws>-ondemand.<suffix>`, JDBC
 * URL, sqlcmd snippet). Cloud-aware AAD: the JDBC host + cert wildcard carry the
 * Gov suffix (`*.sql.azuresynapse.usgovcloudapi.net`) in GCC-High / IL5 / DoD.
 * `database` query param overrides the default `master`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { handleConnectionDetails } from '@/app/api/items/_lib/connection-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const database = req.nextUrl.searchParams.get('database') ?? undefined;
  return handleConnectionDetails('synapse-serverless-sql-pool', undefined, database);
}

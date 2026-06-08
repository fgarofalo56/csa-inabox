/**
 * GET /api/items/databricks-sql-warehouse/[id]/connection?warehouseId=
 *
 * Connection details (server hostname, HTTP path, JDBC URL, CLI snippet) read
 * from the real Databricks warehouse `odbc_params`. Delegates to the shared
 * connection-handler. `warehouseId` query param pins a specific warehouse;
 * otherwise LOOM_DATABRICKS_SQL_WAREHOUSE_ID is used.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { handleConnectionDetails } from '@/app/api/items/_lib/connection-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const warehouseId = req.nextUrl.searchParams.get('warehouseId') ?? undefined;
  return handleConnectionDetails('databricks-sql-warehouse', warehouseId);
}

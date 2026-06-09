/**
 * POST /api/items/azure-sql-database/[id]/scale
 *   body { server, database, skuName, tier, family?, capacity?,
 *          maxSizeBytes?, autoPauseDelay?, minCapacity? }
 *
 * Scales an Azure SQL database's compute + storage via ARM PATCH on
 * Microsoft.Sql/servers/databases — DTU ↔ vCore ↔ serverless SKU change,
 * capacity, max storage, and serverless auto-pause / min-vCore. Polls the
 * Azure-AsyncOperation LRO to completion (up to 10 minutes) and returns a
 * before/after SKU receipt: { ok, beforeSku, afterSku, provisioningState }.
 *
 * Requires the console UAMI to hold "SQL DB Contributor"
 * (9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) — or Contributor — on the server's
 * resource group. ARM 403 surfaces verbatim plus a `hint` naming the role so
 * the editor can render an honest MessageBar gate (per no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { scaleDatabase, AzureSqlError } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCALE_ROLE_HINT =
  'Grant the console UAMI the "SQL DB Contributor" role ' +
  '(9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) on the SQL server\'s resource group, ' +
  'or deploy platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep by setting ' +
  'loomAzureSqlServerRg in your bicep parameters.';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const skuName = String(body?.skuName || '').trim();
  const tier = String(body?.tier || '').trim();

  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
  if (!skuName) return NextResponse.json({ ok: false, error: 'skuName is required' }, { status: 400 });
  if (!tier) return NextResponse.json({ ok: false, error: 'tier is required' }, { status: 400 });

  try {
    const result = await scaleDatabase({
      serverId: server,
      database,
      skuName,
      tier,
      family: body?.family ? String(body.family).trim() : undefined,
      capacity: typeof body?.capacity === 'number' ? body.capacity : undefined,
      maxSizeBytes: typeof body?.maxSizeBytes === 'number' ? body.maxSizeBytes : undefined,
      autoPauseDelay: typeof body?.autoPauseDelay === 'number' ? body.autoPauseDelay : undefined,
      minCapacity: typeof body?.minCapacity === 'number' ? body.minCapacity : undefined,
    });
    return NextResponse.json({ ...result, scaledBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    // 403: honest gate — name the missing role so the editor can instruct the operator.
    const hint = status === 403 ? SCALE_ROLE_HINT : undefined;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint, body: (e as any)?.body },
      { status },
    );
  }
}

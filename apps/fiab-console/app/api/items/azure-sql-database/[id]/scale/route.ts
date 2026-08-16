/**
 * POST /api/items/azure-sql-database/[id]/scale
 *   body { skuName, tier, family?, capacity?, maxSizeBytes?, autoPauseDelay?,
 *          minCapacity? }
 *
 * Scales THIS item's bound Azure SQL database — compute + storage via ARM PATCH
 * on Microsoft.Sql/servers/databases — DTU ↔ vCore ↔ serverless SKU change,
 * capacity, max storage, and serverless auto-pause / min-vCore. Polls the
 * Azure-AsyncOperation LRO to completion (up to 10 minutes) and returns a
 * before/after SKU receipt: { ok, beforeSku, afterSku, provisioningState }.
 *
 * Requires the console UAMI to hold "SQL DB Contributor"
 * (9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) — or Contributor — on the server's
 * resource group. ARM 403 surfaces verbatim plus a `hint` naming the role so
 * the editor can render an honest MessageBar gate (per no-vaporware.md).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2): this route was the advisory's clearest
 * specimen — `POST(req)` with NO `ctx` parameter at all, so the route id was not
 * merely ignored, it was not accepted. `server` arrived as a full ARM id and
 * `scaleDatabase` used it verbatim (`spec.serverId.startsWith('/') ? … `), with
 * no subscription pin and no allowlist, letting any signed-in caller change the
 * SKU — cost and availability — of any database the Console UAMI could reach.
 *
 * NOW: the server + database come from the `[id]` item's bound connection,
 * admitted against the governed subscription scope; the SKU fields stay
 * caller-chosen, which is the feature.
 */
import { NextResponse } from 'next/server';
import { scaleDatabase, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCALE_ROLE_HINT =
  'Grant the console UAMI the "SQL DB Contributor" role ' +
  '(9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) on the SQL server\'s resource group, ' +
  'or deploy platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep by setting ' +
  'loomAzureSqlServerRg in your bicep parameters.';

export const POST = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (_req, { session, server, database, body }) => {
    const skuName = String(body?.skuName || '').trim();
    const tier = String(body?.tier || '').trim();
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
  },
);

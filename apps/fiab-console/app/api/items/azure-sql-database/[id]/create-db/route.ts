/**
 * POST /api/items/azure-sql-database/[id]/create-db
 *   body { server, name, location?, skuName?, tier?, sampleName?, zoneRedundant?,
 *          collation?, requestedBackupStorageRedundancy?, maintenanceConfigurationId? }
 *   Provisions a new Azure SQL database on an existing logical server via
 *   ARM PUT (Microsoft.Sql/servers/databases). Returns the ARM id + status.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). This was `POST(req)` + `getSession()` with
 * `[id]` never read and `server` taken from the body, and `createDatabase`
 * branches `spec.server.startsWith('/') ? spec.server : defaultServerScope(...)`
 * — so a full ARM id skipped the subscription pin and provisioned a database
 * (billable, and a foothold on that server) into ANY subscription the Console
 * UAMI held Contributor / SQL DB Contributor in, including a brownfield-adopted
 * customer server.
 *
 * LAYER 1 + LAYER 3, DELIBERATELY NOT LAYER 2. The server here is a genuine PICK
 * — the database being created does not exist yet, so there is no binding for it
 * to be resolved from, and this route provisions onto a server the item is by
 * design not bound to. Resolving the target from `state.connection` would make
 * "create a database on another server" impossible, which is the feature. So:
 * the caller must OWN the `[id]` item (`withOwnedSqlItem`), and the picked
 * server must be in `sqlAuthorizedSubscriptions()` (`admitPickedServer`). Layer 3
 * is the load-bearing layer for this whole family — see `sql-server-scope.ts`
 * §"WHY LAYER 3 IS THE LOAD-BEARING ONE" — so what is skipped is the weaker of
 * the two. The residual (a governed server the caller does not otherwise use) is
 * recorded at `admitPickedServer`.
 *
 * `maintenanceConfigurationId` is shape-checked below. Requires the console UAMI
 * to hold Contributor (or SQL DB Contributor) on the target server's resource
 * group; ARM errors surface verbatim so the editor renders an honest gate naming
 * the missing role.
 */

import { NextResponse } from 'next/server';
import { createDatabase } from '@/lib/azure/azure-sql-client';
import { withOwnedSqlItem, admitPickedServer, scopeRefused } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A public SQLDB maintenance-configuration id, as `listDbMaintenanceConfigs`
 * returns it (`GET /providers/Microsoft.Maintenance/publicMaintenanceConfigurations`).
 *
 * BOTH ARM FORMS ARE ACCEPTED — the resource-group segment is OPTIONAL. Public
 * maintenance configurations are subscription-scoped, so the ids Azure returns
 * are `/subscriptions/<sub>/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/<name>`
 * with no resource group; the repo's own create-db payload fixtures use exactly
 * that shape. A first draft of this regex REQUIRED a resource group and would
 * have rejected every real value — caught by those fixtures, which is the point
 * of writing the check against the corpus rather than against memory.
 *
 * SCOPE-HONEST ABOUT WHAT THIS IS: a shape check, not a subscription pin. The
 * value is copied verbatim into `properties.maintenanceConfigurationId` of the
 * PUT on the (now-admitted) server, so it is a REFERENCE inside a request whose
 * scope is already bounded — it cannot redirect the PUT. It is checked anyway so
 * an arbitrary caller string cannot be smuggled into an ARM body, and it is
 * deliberately NOT pinned to a subscription: the ids ARM publishes for public
 * configurations are not this deployment's to predict, and refusing a legitimate
 * one would break the create flow to buy nothing (`deploy-integrity.md` R7 — do
 * not assert what has not been established).
 */
const MAINTENANCE_CONFIG_ID_RE =
  /^\/subscriptions\/[^/]+(?:\/resourceGroups\/[^/]+)?\/providers\/Microsoft\.Maintenance\/publicMaintenanceConfigurations\/[A-Za-z0-9_.-]+$/i;

export const POST = withOwnedSqlItem({}, async (_req, { session, body }) => {
  const admitted = admitPickedServer(body?.server, 'sql', {
    code: 'server_required',
    error: 'server is required',
  });
  if (!admitted.ok) return scopeRefused(admitted);
  const server = admitted.server;

  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  // Collation validation — reject anything that isn't a plausible SQL Server
  // collation name before issuing the ARM PUT (defense-in-depth alongside the
  // UI's enumerated dropdown). Collation is immutable after create.
  const collation = body?.collation ? String(body.collation).trim() : undefined;
  if (collation && !/^[A-Za-z0-9_]+$/.test(collation)) {
    return NextResponse.json(
      { ok: false, error: `Invalid collation '${collation}' — must contain only letters, digits, and underscores.` },
      { status: 400 },
    );
  }
  // Backup redundancy — allow-list to the four ARM-accepted values; silently
  // drop anything else so a malformed client can't smuggle an arbitrary string.
  const backupRedundancy = ['Geo', 'GeoZone', 'Local', 'Zone'].includes(body?.requestedBackupStorageRedundancy as string)
    ? (body.requestedBackupStorageRedundancy as 'Geo' | 'GeoZone' | 'Local' | 'Zone')
    : undefined;

  const maintenanceConfigurationId = body?.maintenanceConfigurationId
    ? String(body.maintenanceConfigurationId).trim()
    : undefined;
  if (maintenanceConfigurationId && !MAINTENANCE_CONFIG_ID_RE.test(maintenanceConfigurationId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'maintenanceConfigurationId must be a public SQLDB maintenance-configuration resource id — pick one from the maintenance-configs list for the server’s region.',
      },
      { status: 400 },
    );
  }

  const result = await createDatabase({
    server,
    name,
    location: body?.location ? String(body.location).trim() : undefined,
    skuName: body?.skuName ? String(body.skuName).trim() : undefined,
    tier: body?.tier ? String(body.tier).trim() : undefined,
    sampleName: body?.sampleName ? String(body.sampleName).trim() : undefined,
    zoneRedundant: typeof body?.zoneRedundant === 'boolean' ? body.zoneRedundant : undefined,
    collation,
    requestedBackupStorageRedundancy: backupRedundancy,
    maintenanceConfigurationId,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, status: result.status, provisionedBy: session.claims.upn }, { status: 201 });
});

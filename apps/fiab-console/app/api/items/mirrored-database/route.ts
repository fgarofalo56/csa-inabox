/**
 * Mirrored Database list + create. Cosmos-backed in v3.25; the mirroring
 * engine itself is the loom-mirroring-engine container app (existing).
 *
 * #4059 — THE OWNER-ONLY `loadWs()` THIS FILE USED TO CARRY IS DELIBERATELY
 * GONE. Do not re-add it, and do not re-inline its body.
 *
 * It was a partition point-read `workspacesContainer().item(workspaceId, oid)`
 * followed by `resource?.tenantId === tenantId`. The `workspaces` container is
 * partitioned on `/tenantId` and `Workspace.tenantId` stores the CREATOR's Entra
 * oid, so a workspace document exists ONLY in its creator's partition. That read
 * could therefore only ever answer "did this caller CREATE this workspace" —
 * never "may this caller ACCESS it". A tenant admin, or a member the workspace
 * was shared with, got a 404 on a workspace they legitimately hold. It is the
 * same idiom #2947 removed from 87 other call sites (#2941 semantic-model, #2942
 * pipeline canvas shipped broken on exactly it), and it is ratcheted by
 * `scripts/ci/check-owner-only-workspace-guard.mjs`.
 *
 * THIS IS A WIDENING OF WHO MAY REACH THIS ROUTE, and that is the point. It was
 * written once inside #4031 (a P0 mirroring hotfix) and REVERTED back out in
 * round 5 of that review — not because it was wrong, but because a change to a
 * create route's security surface may not ride inside an unrelated hotfix with
 * no test. `__tests__/mirrored-database-workspace-authz.test.ts` is the test it
 * was owed: it runs the REAL guard and pins the admitted/refused set per role.
 *
 * READ vs WRITE, and why they differ by one key:
 *   GET  — a read-only list. `{ allowReadRoles: true }` admits any workspace
 *          role, so a Viewer/Contributor can SEE the mirrors in a workspace they
 *          hold. Refusing them here would 404 a legitimate viewer.
 *   POST — a MUTATING create. It deliberately does NOT pass `allowReadRoles`, so
 *          it stays write-scoped (Owner/Admin/Member) per the contract in
 *          `lib/auth/workspace-guard.ts`. Adding that one key here would let a
 *          read-only Viewer create mirrors; that is the realistic way this gets
 *          widened later, and the spec goes red on it.
 *
 * Both denials keep the ladder's own 404-not-403 shape (`workspace not found`),
 * byte-identical to the string this route returned before, so a workspace the
 * caller cannot see is not distinguishable from one that does not exist. A
 * tenancy REFUSAL is rendered by the ladder as an honest 409 `tenant_unconfirmed`
 * rather than flattened into that 404 (#3825, deploy-integrity.md R7).
 *
 * Route-toolkit: `withSession` (R3). The hand-rolled
 * `getSession()` + `apiError('unauthenticated', 401)` prologue this file used to
 * carry is what put it in `scripts/ci/route-toolkit-baseline.json`;
 * `apiUnauthorized()` — which `withSession` returns — is that exact envelope, so
 * the 401 is unchanged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // READ surface — Viewer/Contributor members are admitted (see the header).
  const denied = await authorizeWorkspace(session, workspaceId, { allowReadRoles: true });
  if (denied) return denied;
  const items = await itemsContainer();
  const { resources } = await items.items.query<WorkspaceItem>({
    query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
    parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mirrored-database' }],
  }, { partitionKey: workspaceId }).fetchAll();
  return NextResponse.json({
    ok: true, workspaceId,
    mirroredDatabases: resources.map(r => ({
      id: r.id, displayName: r.displayName, description: r.description,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  });
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // WRITE surface — deliberately NO `allowReadRoles` (see the header).
  //
  // Authorization runs BEFORE the body is parsed. Under `loadWs()` it ran after
  // the `displayName` validation, so an unauthorized caller could get a 400 for
  // a body this route was never going to act on. Moving the ladder first is
  // strictly tighter: an unauthorized caller now gets the same 404 whatever they
  // send, and no attacker-controlled JSON is parsed on their behalf.
  const denied = await authorizeWorkspace(session, workspaceId);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return apiError('displayName required', 400);
  const items = await itemsContainer();
  const now = new Date().toISOString();
  // Persist the source config in a flat, engine-readable shape (sourceType +
  // server/database + connectionId + optional table subset) so Start can run
  // the Azure-native mirror without re-deriving everything from definition.
  const definition = body?.definition || {};
  const srcProps = definition?.properties?.source?.typeProperties || {};
  const item: WorkspaceItem = {
    id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-database',
    displayName, description: body?.description,
    state: {
      definition,
      sourceType: body?.sourceType || definition?.properties?.source?.type || '',
      server: body?.server || srcProps.server || '',
      database: body?.database || srcProps.database || '',
      connectionId: body?.connectionId || undefined,
      tables: Array.isArray(body?.tables) ? body.tables : [],
      // Snowflake-only: also mirror Snowflake-managed Iceberg tables.
      includeIcebergTables: !!body?.includeIcebergTables,
      // Ongoing-replication mode (snapshot | incremental | continuous) — consumed
      // by the engine to pick snapshot vs. watermark-incremental vs. ADF CDC/copy.
      syncMode: body?.syncMode || srcProps.syncMode || undefined,
      // Source-specific fields surfaced by the wizard for BigQuery (projectId)
      // and Oracle (serviceName + on-prem data gateway/SHIR + syncUser). Stored
      // flat so Start/edit/monitor read them without re-parsing the definition.
      projectId: body?.projectId || srcProps.projectId || undefined,
      serviceName: body?.serviceName || srcProps.serviceName || undefined,
      gateway: body?.gateway || srcProps.gateway || undefined,
      syncUser: body?.syncUser || srcProps.syncUser || undefined,
      mirroringStatus: 'NotStarted',
    },
    createdBy: session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: now, updatedAt: now,
  };
  const { resource } = await items.items.create(item);
  return NextResponse.json({ ok: true, mirroredDatabase: resource });
});

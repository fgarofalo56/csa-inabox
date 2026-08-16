/**
 * Item-level Share — per-Azure-SQL-database ARM role assignments.
 *
 * GET    /api/items/azure-sql-database/[id]/share
 *        — list the role assignments declared at THIS item's database scope.
 * POST   /api/items/azure-sql-database/[id]/share
 *        body: { principalId, principalType?, roleNameOrGuid }
 *        — PUT a new role assignment at that scope; returns the new assignment
 *          incl. its ARM id (the receipt).
 * DELETE /api/items/azure-sql-database/[id]/share?assignmentId=<full ARM id>
 *        — revoke one role assignment, which must be ON THIS ITEM'S database.
 *
 * Real backend: ARM REST (Microsoft.Authorization/roleAssignments) at the
 * Microsoft.Sql/servers/databases/{db} scope, mirroring the Azure portal
 * "Access control (IAM)" blade. The Console UAMI must hold "Role Based Access
 * Control Administrator" (constrained via ABAC to Reader / Contributor /
 * SQL DB Contributor) on the SQL server's resource group — granted by
 * platform/fiab/bicep/modules/admin-plane/sql-database-share-rbac.bicep.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2): every handler USED TO be session-only, with
 * `server` + `database` taken from the query string / body and `[id]` never
 * read. Because the Console UAMI holds RBAC-Administrator on the SQL resource
 * group, that made this a ROLE-GRANT primitive on any database the UAMI could
 * reach — a caller could grant THEMSELVES a data role on another tenant's
 * database. DELETE was broader still: `revokeDatabaseRoleAssignment` issues a
 * raw `ARM DELETE <id>` on whatever id the query string carried, at any scope.
 *
 * NOW: the caller must own the `[id]` item, the server + database come from that
 * item's bound connection (admitted against the governed subscription scope),
 * and a revocation id is admitted against that same bound database scope.
 *
 * 403 semantics unchanged for the BACKEND case: when the Console UAMI lacks the
 * RBAC-Admin grant ARM returns 403; armRequest throws AzureSqlError(msg, 403)
 * and handleErr surfaces the verbatim ARM message. No fake success
 * (no-vaporware.md).
 */
import { NextResponse } from 'next/server';
import {
  listDatabaseRoleAssignments,
  grantDatabaseRole,
  revokeDatabaseRoleAssignment,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';
import {
  withBoundSqlServer,
  admitBoundRoleAssignmentId,
  scopeRefused,
} from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), body: (e as any)?.body, status },
    { status },
  );
}

export const GET = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true, allowReadRoles: true },
  async (_req, { server, database }) => {
    try {
      const assignments = await listDatabaseRoleAssignments(server, database);
      return NextResponse.json({ ok: true, assignments });
    } catch (e: any) { return handleErr(e); }
  },
);

export const POST = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (_req, { server, database, body }) => {
    const { principalId, principalType, roleNameOrGuid } = body || {};
    if (!principalId || !roleNameOrGuid) {
      return NextResponse.json(
        { ok: false, error: 'principalId, roleNameOrGuid required' },
        { status: 400 },
      );
    }
    try {
      const assignment = await grantDatabaseRole(
        server,
        database,
        String(principalId),
        String(roleNameOrGuid),
        principalType === 'Group' || principalType === 'ServicePrincipal' ? principalType : 'User',
      );
      return NextResponse.json({ ok: true, assignment });
    } catch (e: any) { return handleErr(e); }
  },
);

export const DELETE = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (req, { server, database }) => {
    const admitted = admitBoundRoleAssignmentId(
      new URL(req.url).searchParams.get('assignmentId'),
      server,
      database,
    );
    if (!admitted.ok) return scopeRefused(admitted);
    try {
      await revokeDatabaseRoleAssignment(admitted.assignmentId);
      return NextResponse.json({ ok: true });
    } catch (e: any) { return handleErr(e); }
  },
);

/**
 * Shared workspace-scoped authorization guard for admin/workspaces/[id]/* BFF
 * routes.
 *
 * Many sibling routes (connections/route.ts, git/route.ts, networking/_gate.ts)
 * each re-implemented the same owner-or-admin check locally; several sub-routes
 * (connections/adls-accounts, connections/log-analytics-workspaces,
 * connections/[connId], spark/jobs, spark/runtime, task-flows,
 * task-flows/[flowId]) shipped with ONLY a bare `getSession()` check — so any
 * signed-in user could read/mutate another tenant's workspace resources by id.
 * This module is the single canonical guard.
 *
 * `authorizeWorkspace` allows the caller when they OWN the workspace
 * (self-service) OR are a tenant admin (org-wide management), and otherwise
 * returns a 404 (same not-found shape as the sibling git route — we do not leak
 * existence of workspaces the caller can't see). Use `requireWorkspace` to fold
 * in the 401 unauthenticated check in one call.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';

/** Point-read the workspace on (id, ownerOid); true when the caller owns it. */
export async function assertOwner(workspaceId: string, tenantId: string): Promise<boolean> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    return !!resource && resource.tenantId === tenantId;
  } catch (e: any) {
    if (e?.code === 404) return false;
    throw e;
  }
}

/**
 * Authorize a workspace-scoped request: OWNER (self-service) OR tenant ADMIN
 * (org-wide) OR a shared ACL member (rel-T11). Returns a 404 NextResponse when
 * none holds, else null.
 *
 * By DEFAULT this gates to WRITE-capable access (Owner/Admin/Member) because the
 * workspace sub-routes it protects are overwhelmingly config MUTATIONS — a
 * read-only Viewer/Contributor must never pass a mutation guard. Read-only
 * surfaces opt in via `{ allowReadRoles: true }`, which admits any workspace
 * role. The owner + tenant-admin fast-paths are unchanged, so the
 * single-operator estate behaves exactly as before.
 */
export async function authorizeWorkspace(
  session: SessionPayload,
  workspaceId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<NextResponse | null> {
  if (isTenantAdmin(session)) return null;
  const access = await resolveWorkspaceAccessByOid(session.claims.oid, workspaceId, {
    groups: session.claims.groups,
    callerTid: session.claims.tid,
  });
  if (access && (opts.allowReadRoles || access.canWrite)) return null;
  return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
}

/**
 * One-call guard: resolves the session (401 when absent) then the workspace
 * owner-or-admin-or-ACL authorization (404 when denied). Returns `{ session }`
 * when authorized, else `{ resp }` carrying the response the handler should
 * return. Pass `{ allowReadRoles: true }` on read-only GET routes to admit
 * Viewer/Contributor members.
 */
export async function requireWorkspace(
  workspaceId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<{ session: SessionPayload; resp?: undefined } | { session?: undefined; resp: NextResponse }> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeWorkspace(session, workspaceId, opts);
  if (denied) return { resp: denied };
  return { session };
}

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
 * (org-wide). Returns a 404 NextResponse when neither holds, else null.
 */
export async function authorizeWorkspace(
  session: SessionPayload,
  workspaceId: string,
): Promise<NextResponse | null> {
  if (isTenantAdmin(session)) return null;
  if (await assertOwner(workspaceId, session.claims.oid)) return null;
  return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
}

/**
 * One-call guard: resolves the session (401 when absent) then the workspace
 * owner-or-admin authorization (404 when denied). Returns `{ session }` when
 * authorized, else `{ resp }` carrying the response the handler should return.
 */
export async function requireWorkspace(
  workspaceId: string,
): Promise<{ session: SessionPayload; resp?: undefined } | { session?: undefined; resp: NextResponse }> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeWorkspace(session, workspaceId);
  if (denied) return { resp: denied };
  return { session };
}

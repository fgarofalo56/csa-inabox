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
import { loadWorkspaceAdmin } from '@/lib/clients/workspaces-client';
import type { Workspace } from '@/lib/types/workspace';

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

/**
 * Resolve the actual workspace DOCUMENT for an admin/workspaces/[id]/* route
 * that needs the doc (not just a yes/no authorization) — e.g. to PATCH it, read
 * its bound storage account, or cascade-delete it.
 *
 * The bug this fixes: the per-workspace admin routes used to point-read
 * `container.item(id, caller.oid)`, which only hits the CALLER's partition.
 * Because a workspace lives in its creator's partition (`tenantId === creator
 * oid`), a tenant admin opening a workspace they did NOT create got a spurious
 * 404 — the Settings flyout was broken for every workspace the admin didn't
 * personally own.
 *
 * Resolution order (owner-first, then admin fallback — never a blanket
 * cross-partition read):
 *   1. No session               → 401.
 *   2. Owner point-read on the caller's partition. Found → `via: 'owner'`. This
 *      is the UNCHANGED path for a non-admin owner acting on their own
 *      workspace, so no existing owner behavior is weakened.
 *   3. Not owned AND isTenantAdmin(session) → cross-partition `loadWorkspaceAdmin`.
 *      Found → `via: 'admin'`. This is the ONLY code path that reads across
 *      partitions, and it is gated on the tenant-admin check FIRST so a
 *      non-admin can never read/patch a workspace they don't own.
 *   4. Otherwise                → 404 (same not-found shape; we do not leak the
 *      existence of workspaces the caller can't see).
 *
 * Callers that must additionally restrict to admins ONLY (e.g. the networking
 * gate, or a destructive admin DELETE) check `isTenantAdmin(session)` themselves
 * after this resolves — `via` is returned so they can distinguish owner vs admin
 * access cheaply.
 */
export type AdminWorkspaceResolution =
  | { session: SessionPayload; ws: Workspace; via: 'owner' | 'admin'; resp?: undefined }
  | { session?: undefined; ws?: undefined; via?: undefined; resp: NextResponse };

export async function resolveAdminWorkspace(
  workspaceId: string,
): Promise<AdminWorkspaceResolution> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }

  // 1) Owner point-read on the caller's own partition (unchanged owner path).
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(workspaceId, session.claims.oid).read<Workspace>();
    if (resource && resource.tenantId === session.claims.oid) {
      return { session, ws: resource, via: 'owner' };
    }
  } catch (e: any) {
    if (e?.code !== 404) {
      return {
        resp: NextResponse.json(
          { ok: false, error: e?.message || 'workspace lookup failed' },
          { status: 500 },
        ),
      };
    }
    // 404 → not in the caller's partition; fall through to the admin fallback.
  }

  // 2) Admin-only cross-partition fallback (gated on the tenant-admin check).
  if (isTenantAdmin(session)) {
    try {
      const ws = await loadWorkspaceAdmin(workspaceId);
      if (ws) return { session, ws, via: 'admin' };
    } catch (e: any) {
      return {
        resp: NextResponse.json(
          { ok: false, error: e?.message || 'workspace lookup failed' },
          { status: 500 },
        ),
      };
    }
  }

  // 3) Not owned and not an admin (or admin but no such workspace) → 404.
  return { resp: NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 }) };
}

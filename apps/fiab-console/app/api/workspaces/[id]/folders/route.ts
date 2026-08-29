/**
 * GET    /api/workspaces/[id]/folders          → list folders in workspace
 * POST   /api/workspaces/[id]/folders          → create folder {name, parent?}
 * PATCH  /api/workspaces/[id]/folders          → rename folder {id, name}
 * DELETE /api/workspaces/[id]/folders?id=...   → delete folder (children reparent to root)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { foldersContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { readWorkspaceById } from '@/lib/auth/workspace-access';
import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';
import type { WorkspaceItem } from '@/lib/types/workspace';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * True when the caller may manage this workspace's folders: the owner (partition
 * point-read) OR — ADMIN-OPEN — a tenant admin for a workspace POSITIVELY
 * CONFIRMED to be in that admin's OWN Entra tenant, so an admin opening a
 * workspace from /admin/workspaces sees its folders too rather than a 404 (the
 * Items tab renders both the item list and this folder tree).
 *
 * #3891 — THE ADMIN BRANCH USED TO COERCE AN UNFILTERED READ INTO THE VERDICT.
 * It read `if (isTenantAdmin(session)) return !!(await readWorkspaceById(id));`.
 * `readWorkspaceById` is a raw cross-partition document read with NO tenant
 * predicate — its own docblock says so, and says the RESOLVER is what subjects
 * the result to the tid comparison. Nothing subjected it here, so the boolean
 * that gated GET/POST/PATCH/DELETE on the folder tree was "a workspace with this
 * id exists ANYWHERE", and a tenant admin in tenant A reached tenant B's
 * folders. This is the third executable spelling of the #3833 admin-bypass
 * family: neither `isTenantAdmin(session)) return null` nor an unfiltered
 * `loadWorkspaceAdmin`, which is why the two-shape grep that closed the other
 * members missed it.
 *
 * THE COMPARISON IS NOT WRITTEN HERE. `sameTenantConfirmed`
 * (`lib/auth/tenant-boundary.ts`) is the one implementation; a private fifth
 * copy is exactly what produced #3823, #3825, #3840 and #3843. It is a POSITIVE
 * match that FAILS CLOSED on `unconfirmed`, so a tid-less session (#3845 proved
 * `app/api/auth/cli-session/route.ts` is a live generator of those) and a
 * pre-rel-T11 workspace doc with no `tid` are both REFUSED rather than admitted.
 * The shape `callerTid && doc.tid && doc.tid !== callerTid` is the WRONG one and
 * is deliberately not written.
 *
 * WHAT THIS NARROWS, precisely: nothing is added. The owner point-read is
 * byte-identical. The admin branch loses every workspace whose tenancy Loom
 * cannot positively confirm — cross-tenant, unstamped workspace, or tid-less
 * session. A tenant admin opening a workspace stamped with their own tid is
 * unaffected, which is the /admin/workspaces case the bypass exists for.
 *
 * The refusal stays a 404 at the four handlers, deliberately: the caller supplies
 * `id`, so a 403 (or any code that distinguishes "exists elsewhere" from "does
 * not exist") turns this into an existence oracle over a caller-chosen scope.
 */
async function assertWorkspaceAccess(id: string, session: SessionPayload): Promise<boolean> {
  const oid = session.claims.oid;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(id, oid).read<any>();
    if (resource && resource.tenantId === oid) return true;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (isTenantAdmin(session)) {
    const wsDoc = await readWorkspaceById(id);
    if (!wsDoc) return false;
    if (sameTenantConfirmed(session.claims.tid, wsDoc.tid)) return true;
    // A REFUSAL, not an absence — and the operator can act on the `unconfirmed`
    // half of it. Logged server-side (the response stays 404 for the oracle
    // reason above), stating only what was established (deploy-integrity R7).
    console.warn(
      '[workspaces/folders] tenant-admin folder access REFUSED — workspace tenancy not confirmed (#3891).',
      {
        workspaceId: id,
        callerTidPresent: Boolean(session.claims.tid),
        workspaceTidPresent: Boolean(wsDoc.tid),
        remediation:
          'If this workspace predates rel-T11 it carries no `tid`: run `node ' +
          'scripts/csa-loom/backfill-workspace-tid.mjs` (DRY-RUN by default) then re-run with ' +
          '`--apply`. If your session carries no `tid` claim, sign out and sign in again.',
      },
    );
    return false;
  }
  return false;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await foldersContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.name',
      parameters: [{ name: '@w', value: params.id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, folders: resources });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await foldersContainer();
  const doc = {
    id: crypto.randomUUID(),
    workspaceId: params.id,
    name: body.name,
    parent: body.parent || null,
    createdBy: s.claims.upn,
    createdAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, folder: resource }, { status: 201 });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.id || typeof body.id !== 'string')
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim())
    return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await foldersContainer();
  try {
    const { resource } = await c.item(body.id, params.id).read<any>();
    if (!resource) return NextResponse.json({ ok: false, error: 'folder not found' }, { status: 404 });
    const next = { ...resource, name: body.name.trim() };
    const { resource: saved } = await c.item(body.id, params.id).replace(next);
    return NextResponse.json({ ok: true, folder: saved });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'folder not found' }, { status: 404 });
    return apiServerError(e, 'failed to rename folder');
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  // Move any items in this folder back to root before deleting it.
  try {
    const items = await itemsContainer();
    const { resources: members } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.folderId = @f',
        parameters: [
          { name: '@w', value: params.id },
          { name: '@f', value: id },
        ],
      }, { partitionKey: params.id })
      .fetchAll();
    for (const m of members) {
      const next: WorkspaceItem = { ...m, folderId: null, updatedAt: new Date().toISOString() };
      await items.item(m.id, m.workspaceId).replace(next);
    }
  } catch { /* best-effort */ }
  // Reparent any child folders to root.
  const c = await foldersContainer();
  try {
    const { resources: childFolders } = await c.items
      .query({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.parent = @p',
        parameters: [
          { name: '@w', value: params.id },
          { name: '@p', value: id },
        ],
      })
      .fetchAll();
    for (const cf of childFolders as any[]) {
      await c.item(cf.id, params.id).replace({ ...cf, parent: null });
    }
  } catch { /* best-effort */ }
  try {
    await c.item(id, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}

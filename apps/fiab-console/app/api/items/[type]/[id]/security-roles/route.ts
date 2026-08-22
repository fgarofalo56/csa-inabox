/**
 * OneLake Security BFF (F7) — data-access roles for Lakehouse / Mirrored-
 * Database / Mirrored-Catalog items.
 *
 *   GET    ?list=roles                          → { ok, roles, defaultWarning }
 *   GET    ?verify&roleId=<id>&path=<p>         → { ok, verification }
 *   POST   { action:'create', role }            → upsert Cosmos + apply ADLS ACLs
 *   PUT    { action:'update', role }            → upsert Cosmos + re-apply ACLs
 *   DELETE ?roleId=<id>                         → revoke ADLS ACLs + delete doc
 *   POST   { action:'sync-to-fabric', workspaceId, fabricItemId }
 *          → (opt-in) replace-all PUT to Fabric dataAccessRoles
 *
 * DEFAULT path is 100% Azure-native: the role definition lives in Cosmos and is
 * ENFORCED by real ADLS Gen2 POSIX ACLs (no Fabric workspace needed). The
 * Fabric REST is opt-in behind LOOM_FABRIC_SECURITY_ENABLED=true and is honest-
 * gated off in Gov clouds (Fabric isn't authorized at the GCC-High / IL5
 * boundary). See no-fabric-dependency.md + no-vaporware.md.
 */

import { NextResponse } from 'next/server';
import { type SessionPayload } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import {
  listRoles,
  getRole,
  upsertRole,
  deleteRole,
  applyRoleAcls,
  revokeRoleAcls,
  verifyRoleAcls,
  roleDocId,
  ROLE_NAME_RE,
  isValidRolePath,
  allowedPermissions,
  type OneLakeSecurityRole,
  type OneLakeSecurityItemType,
  type OneLakePermission,
  type SecurityRoleMember,
  type SecurityRoleMemberType,
} from '@/lib/azure/onelake-security-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPES: OneLakeSecurityItemType[] = ['lakehouse', 'mirrored-database', 'mirrored-catalog'];
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const KNOWN_CONTAINERS = ['bronze', 'silver', 'gold', 'landing'];

function parseItemType(v: string): OneLakeSecurityItemType | null {
  return (ITEM_TYPES as string[]).includes(v) ? (v as OneLakeSecurityItemType) : null;
}

function tenantId(): string {
  return process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common';
}

/** Default medallion container per item type when the client doesn't pass one. */
function defaultContainer(itemType: OneLakeSecurityItemType): string {
  // Lakehouses default to the Gold serving layer; mirrors land in Bronze.
  return itemType === 'lakehouse' ? 'gold' : 'bronze';
}

/** True when the Azure-native ADLS-ACL backend for OneLake security is enabled
 *  (the Console UAMI has Storage Blob Data Owner — wired by Bicep). */
function aclBackendEnabled(): boolean {
  return process.env.LOOM_ONELAKE_SECURITY_ACL === 'true';
}

/** THE ONE refusal wording and the ONE way to build it. Every denial on this
 *  route — foreign tenant, unconfirmable tenancy, no such item, no role held —
 *  returns exactly this, so none of them can be told apart. */
const NOT_FOUND = 'item not found';
const notFound = () => NextResponse.json({ ok: false, error: NOT_FOUND }, { status: 404 });

/**
 * OWNERSHIP gate — these handlers read role definitions and grant/revoke REAL
 * ADLS Gen2 POSIX ACLs on the shared DLZ storage, so a bare session + the
 * default-off PDP shadow gate is NOT sufficient authorization.
 *
 * ── #3855 / #3833 — THIS GATE USED TO OPEN BEFORE IT READ ANYTHING ───────────
 *
 * Until this change its first line was
 *
 *     if (isTenantAdmin(session)) return null;   // null == AUTHORIZED
 *
 * ahead of every Cosmos read, over an `itemId` and an `itemType` the CALLER
 * supplies in the URL. Nothing below it ran for an admin: not the item lookup,
 * not the workspace resolution, not the tenant comparison. So a tenant admin in
 * tenant A holding a lakehouse GUID from tenant B reached POST / PUT / DELETE on
 * this route, and those handlers do not read metadata — they call
 * `applyRoleAcls` / `revokeRoleAcls`, which write REAL ADLS Gen2 POSIX ACLs onto
 * the Delta folders of the OTHER TENANT'S LAKE, naming arbitrary Entra object
 * ids as members. That is a cross-tenant WRITE, and it is the reason this was
 * taken first in the #3833 family.
 *
 * THE FAMILY, AND WHY A LOCAL PATCH WOULD HAVE BEEN THE WRONG FIX. #3833 has the
 * same admin-open shape in four places; the two that DESTROY were repaired first
 * (`workspaces/bulk-delete` in #3836 — a cascade delete; `lib/auth/workspace-guard`
 * in #3830). Every one of them was repaired the SAME way, and it is not "add a
 * tid check here": path proliferation is how this family reached seven sites.
 * The private path is DELETED. The tenant decision has one implementation —
 * `resolveWorkspaceAccessByOid` (`lib/auth/workspace-access.ts`) — whose step 6
 * admits a tenant admin ONLY on a POSITIVE tenant match (`callerTid && wsDoc.tid
 * && equal`, #3823/#3824), never on a mere non-contradiction. Both canonical
 * helpers below reach that one resolver:
 *
 *   1. `authorizeItemWorkspace` — the 85-importer item-scoped authorizer. It
 *      resolves the item's OWNING workspace (cross-partition, so a foreign-tenant
 *      item is still FOUND and still judged) and delegates.
 *   2. `loadOwnedItem` — re-resolves the item through the same ladder and is what
 *      proves the item EXISTS at all. `authorizeItemWorkspace` deliberately
 *      returns null (allow) when no item of that type carries the id, because
 *      then there is no other tenant's resource to gate; on THIS route that state
 *      must still 404, or a POST would mint ACLs for an item that does not exist.
 *
 * EVERY REFUSAL IS FLATTENED TO ONE 404, AND THAT COSTS SOMETHING WORTH NAMING.
 * `authorizeItemWorkspace` returns `workspaceDenialResponse(diag) ?? <404>`, and
 * that first arm is a **409 `tenant_unconfirmed` carrying the resolved
 * `workspaceId`** (`lib/auth/workspace-denial.ts`) whenever the workspace doc
 * records no `tid` or the session carries no `tid` claim. On a workspace-OPEN
 * surface that 409 is right — it is R7-honest and it names a remediation the
 * operator can act on. HERE IT IS AN ORACLE. The caller supplies the `itemId`;
 * a 409 tells them "that GUID names a real item, and it lives in workspace
 * <GUID>", while a nonexistent id 404s — so the two are distinguishable, in
 * exactly the tid-less state #3845 proves has a live generator. This route
 * GRANTS ADLS ACLS, so the oracle outweighs the diagnostic, and every refusal
 * returns the identical flat 404 body.
 *
 * WHAT THAT GIVES UP, stated rather than implied: an admin blocked by an
 * unstamped workspace doc gets no in-band remediation from THIS route. It is not
 * lost — `resolveWorkspaceAccessByOid` logs the refusal with its cause and
 * remediation server-side (`[workspace-access] tenant-admin grant REFUSED`), and
 * the same 409 is still rendered by the workspace-open surfaces, which are reads
 * rather than mutations and take a workspace id the caller is entitled to name.
 *
 * NOT A WIDENING FOR ANYONE. Both calls are WRITE-scoped (`allowReadRoles` is not
 * passed, on the GET too), which is exactly what `loadOwnedItem` already required
 * of every non-admin caller before this change. A Viewer 404s on GET today and
 * 404s on GET after. What changed is only that an ADMIN is now judged by the same
 * ladder as everyone else.
 *
 * 404, NOT 403, AND BEFORE THE QUERY. A 403 would confirm that the caller-supplied
 * id names a real item in some tenant — a COUNT is an ORACLE when the caller picks
 * the scope. A foreign-tenant id, an unconfirmable-tenancy id and a nonexistent id
 * all return the identical body here.
 *
 * THE NARROWING, STATED RATHER THAN IMPLIED. A tenant admin who neither owns the
 * item nor holds a workspace ACL role on it is now REFUSED when the workspace doc
 * carries no `tid` (created before rel-T11) or the session carries no `tid` claim
 * (`UserClaims.tid` is optional by design; `lib/auth/pat.ts` mints PATs without
 * one). That is the same trade every other consolidated site takes; the remedy is
 * `node scripts/csa-loom/backfill-workspace-tid.mjs` (dry-run by default,
 * `--apply` to write). Owners and ACL members are untouched — they never depended
 * on the admin bypass. The number of such docs on the live estate is UNMEASURED.
 */
async function assertItemAccess(
  session: SessionPayload,
  itemId: string,
  itemType: string,
): Promise<NextResponse | null> {
  const denied = await authorizeItemWorkspace(session, {
    itemId,
    itemType,
    notFound: NOT_FOUND,
  });
  // Deliberately NOT `return denied` — see the docblock. Any refusal, including
  // the 409 `tenant_unconfirmed` that carries a workspaceId, collapses to the one
  // body, so a caller-supplied id cannot be probed for existence.
  if (denied) return notFound();
  const owned = await loadOwnedItem(itemId, itemType, session.claims.oid, { session });
  if (!owned) return notFound();
  return null;
}

/** Honest infra-gate when the ADLS-ACL backend isn't enabled / configured. */
function aclGate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      gate: true,
      missing: 'LOOM_ONELAKE_SECURITY_ACL=true + Storage Blob Data Owner',
      hint: 'OneLake security roles are enforced as ADLS Gen2 POSIX ACLs on the lakehouse Delta folders. Set LOOM_ONELAKE_SECURITY_ACL=true on loom-console and grant the Console UAMI "Storage Blob Data Owner" on the DLZ storage account (deploy admin-plane with -p loomOnelakeSecurityEnabled=true, and synapse.bicep with loomOnelakeSecurityEnabled=true). The container URLs (LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL) must also be set.',
    },
    { status: 503 },
  );
}

/** Build + validate a role document from a raw request body. */
function buildRole(
  itemId: string,
  itemType: OneLakeSecurityItemType,
  raw: any,
  createdBy: string,
): { role: OneLakeSecurityRole } | { error: string } {
  const roleName = String(raw?.roleName || '').trim();
  if (!ROLE_NAME_RE.test(roleName)) {
    return { error: 'roleName must start with a letter, be alphanumeric, and be at most 128 characters.' };
  }
  const container = String(raw?.container || defaultContainer(itemType)).trim();
  if (!KNOWN_CONTAINERS.includes(container)) {
    return { error: `unknown container "${container}" (expected one of ${KNOWN_CONTAINERS.join(', ')})` };
  }
  const allowed = allowedPermissions(itemType);
  const permsIn: OneLakePermission[] = Array.isArray(raw?.permissions) ? raw.permissions : ['Read'];
  const permissions = permsIn.filter((p) => allowed.includes(p));
  if (permissions.length === 0) {
    return { error: `permissions must be a non-empty subset of ${allowed.join(', ')} for ${itemType}` };
  }
  const pathsIn: string[] = Array.isArray(raw?.paths) && raw.paths.length ? raw.paths : ['*'];
  for (const p of pathsIn) {
    if (!isValidRolePath(String(p))) {
      return { error: `invalid path "${p}" — must be '*' or start with /Tables/ or /Files/` };
    }
  }
  const membersIn: any[] = Array.isArray(raw?.members) ? raw.members : [];
  const members: SecurityRoleMember[] = [];
  for (const m of membersIn) {
    const objectId = String(m?.objectId || '').trim();
    if (!UUID_RE.test(objectId)) {
      return { error: `member objectId "${objectId}" is not a valid Entra object id (GUID)` };
    }
    const objectType: SecurityRoleMemberType =
      m?.objectType === 'Group' || m?.objectType === 'ServicePrincipal' ? m.objectType : 'User';
    members.push({
      objectId,
      objectType,
      tenantId: String(m?.tenantId || tenantId()),
      upn: m?.upn ? String(m.upn) : undefined,
      displayName: m?.displayName ? String(m.displayName) : undefined,
    });
  }
  const isDefault = roleName === 'DefaultReader' || roleName === 'DefaultReadWriter';
  const role: OneLakeSecurityRole = {
    id: roleDocId(itemId, roleName),
    itemId,
    itemType,
    container,
    roleName,
    permissions,
    paths: pathsIn,
    members,
    isDefault,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  return { role };
}

/** True when a DefaultReader/DefaultReadWriter role still spans all folders. */
function defaultRoleSpansAll(roles: OneLakeSecurityRole[]): boolean {
  return roles.some(
    (r) =>
      (r.roleName === 'DefaultReader' || r.roleName === 'DefaultReadWriter') && r.paths.includes('*'),
  );
}

// ── Opt-in Fabric dataAccessRoles sync ───────────────────────────────────────
// ACA-first UAMI chain (see lib/azure/arm-credential.ts — the ACA MI token bug).
const fabricCredential = uamiArmCredential();
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

function toFabricDataAccessRoles(roles: OneLakeSecurityRole[]): any {
  return {
    value: roles.map((r) => {
      const actions = r.permissions.includes('ReadWrite') ? ['Read', 'Write'] : ['Read'];
      const paths = r.paths.includes('*') ? ['*'] : r.paths;
      return {
        name: r.roleName,
        decisionRules: [
          {
            effect: 'Permit',
            permission: [
              { attributeName: 'Path', attributeValueIncludedIn: paths },
              { attributeName: 'Action', attributeValueIncludedIn: actions },
            ],
          },
        ],
        members: {
          microsoftEntraMembers: r.members.map((m) => ({
            objectId: m.objectId,
            objectType: m.objectType,
            tenantId: m.tenantId || tenantId(),
          })),
        },
      };
    }),
  };
}

async function syncToFabric(
  workspaceId: string,
  fabricItemId: string,
  roles: OneLakeSecurityRole[],
): Promise<{ etag?: string }> {
  const t = await fabricCredential.getToken(FABRIC_SCOPE);
  if (!t?.token) throw Object.assign(new Error('Failed to acquire Fabric token'), { status: 401 });
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(fabricItemId)}/dataAccessRoles`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(toFabricDataAccessRoles(roles)),
    cache: 'no-store',
  });
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt)?.message || txt; } catch { /* keep text */ }
    throw Object.assign(new Error(msg || `Fabric ${res.status}`), { status: res.status });
  }
  return { etag: res.headers.get('etag') || undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE-TOOLKIT MIGRATION (boy-scout rule, `scripts/ci/check-route-toolkit.mjs`).
//
// The hand-rolled `getSession()` prologue is what that ratchet exists to delete —
// a per-route auth preamble is exactly the surface this route's own #3855 defect
// grew on. `withSession` is a BEHAVIOUR-PRESERVING swap here and that is
// checkable rather than asserted: its refusal is `apiUnauthorized()` =
// `apiError('unauthenticated', 401)` = `{ ok:false, error:'unauthenticated' }`
// at 401, byte-identical to the four hand-rolled lines it replaces. It also
// wraps each handler in the same try/catch → `apiServerError` discipline; every
// inner try/catch below is untouched, so the modelled failure paths still
// produce their own status codes and only a genuinely unexpected throw changes
// from an unhandled rejection to a safe 500.
//
// `withWorkspaceOwner` is deliberately NOT used: it binds ONE literal itemType,
// and this route serves three through a `[type]` segment. The authorization it
// would perform is what `assertItemAccess` does above, for whichever type the
// segment names.
const params$ = <P>(ctx: { params: P }) => ctx.params;

export const GET = withSession<{ type: string; id: string }>(async (_req, ctx) => {
  const params = params$(ctx);
  const { session } = ctx;
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });

  const denied = await assertItemAccess(session, params.id, params.type);
  if (denied) return denied;

  const sp = _req.nextUrl.searchParams;
  // PDP gate (default-off / shadow-ready). Reading OneLake security roles.
  const blockedGet = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'read');
  if (blockedGet) return blockedGet;
  try {
    if (sp.has('verify')) {
      if (!aclBackendEnabled()) return aclGate();
      const roleId = sp.get('roleId');
      if (!roleId) return NextResponse.json({ ok: false, error: 'roleId required for verify' }, { status: 400 });
      const role = await getRole(params.id, roleId);
      if (!role) return NextResponse.json({ ok: false, error: 'role not found' }, { status: 404 });
      const path = sp.get('path') || role.paths[0] || '*';
      const oids = role.members.map((m) => m.objectId);
      try {
        const verification = await verifyRoleAcls(role.container, path, oids);
        return NextResponse.json({ ok: true, verification });
      } catch (e: any) {
        if (/No LOOM_/.test(String(e?.message))) return aclGate();
        throw e;
      }
    }
    const roles = await listRoles(params.id);
    return NextResponse.json({
      ok: true,
      roles,
      aclEnabled: aclBackendEnabled(),
      defaultWarning: defaultRoleSpansAll(roles),
      allowedPermissions: allowedPermissions(itemType),
      fabricSyncEnabled: process.env.LOOM_FABRIC_SECURITY_ENABLED === 'true' && !isGovCloud(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

export const POST = withSession<{ type: string; id: string }>(async (req, ctx) => {
  const params = params$(ctx);
  const { session } = ctx;
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
  const deniedPost = await assertItemAccess(session, params.id, params.type);
  if (deniedPost) return deniedPost;
  // PDP gate (default-off / shadow-ready). Creating/updating a OneLake security role is admin.
  const blockedPost = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'admin');
  if (blockedPost) return blockedPost;
  const body = await req.json().catch(() => ({}));
  const action = body?.action || 'create';

  try {
    if (action === 'sync-to-fabric') {
      if (isGovCloud()) {
        return NextResponse.json(
          {
            ok: false, gate: true, missing: 'Fabric API (not available in GCC-High / IL5)',
            hint: 'The Fabric OneLake dataAccessRoles API is not authorized at the GCC-High / IL5 boundary. Use the Azure-native ADLS ACL path (the default) — it is fully functional in Gov.',
          },
          { status: 503 },
        );
      }
      if (process.env.LOOM_FABRIC_SECURITY_ENABLED !== 'true') {
        return NextResponse.json(
          {
            ok: false, gate: true, missing: 'LOOM_FABRIC_SECURITY_ENABLED=true',
            hint: 'Fabric sync is opt-in. Set LOOM_FABRIC_SECURITY_ENABLED=true and bind a Fabric workspace + item id to mirror Loom roles into Fabric. The Azure-native ADLS path works without it.',
          },
          { status: 503 },
        );
      }
      const workspaceId = String(body?.workspaceId || '').trim();
      const fabricItemId = String(body?.fabricItemId || '').trim();
      if (!workspaceId || !fabricItemId) {
        return NextResponse.json({ ok: false, error: 'workspaceId and fabricItemId required for sync-to-fabric' }, { status: 400 });
      }
      const roles = await listRoles(params.id);
      const { etag } = await syncToFabric(workspaceId, fabricItemId, roles);
      return NextResponse.json({ ok: true, synced: roles.length, etag });
    }

    // create / update — same handler (upsert + (re)apply ACLs).
    if (!aclBackendEnabled()) return aclGate();
    const built = buildRole(params.id, itemType, body?.role ?? body, session.claims.oid);
    if ('error' in built) return NextResponse.json({ ok: false, error: built.error }, { status: 400 });
    const role = built.role;
    // Preserve original createdAt/createdBy on update.
    const existing = await getRole(params.id, role.id);
    if (existing) {
      role.createdAt = existing.createdAt;
      role.createdBy = existing.createdBy;
      role.updatedAt = new Date().toISOString();
    }
    const saved = await upsertRole(role);
    // Real grant: ADLS Gen2 ACLs on the chosen folders for every member.
    let aclResult;
    try {
      aclResult = await applyRoleAcls(saved);
    } catch (e: any) {
      if (/No LOOM_/.test(String(e?.message))) return aclGate();
      // Surface the ACL failure but keep the saved definition so the user can
      // retry once the UAMI has Storage Blob Data Owner.
      return NextResponse.json(
        { ok: false, error: `Role saved, but ADLS ACL grant failed: ${e?.message || e}`, role: saved, status: e?.statusCode || 502 },
        { status: e?.statusCode === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ ok: true, role: saved, acl: aclResult }, { status: existing ? 200 : 201 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

/** Update shares the POST handler (upsert + re-apply), wrapper included — so the
 *  session prologue and the two authorization gates run exactly once, on the
 *  same path, rather than in a second copy that could drift from it. */
export const PUT = POST;

export const DELETE = withSession<{ type: string; id: string }>(async (req, ctx) => {
  const params = params$(ctx);
  const { session } = ctx;
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
  const deniedDel = await assertItemAccess(session, params.id, params.type);
  if (deniedDel) return deniedDel;
  // PDP gate (default-off / shadow-ready). Deleting a OneLake security role is admin.
  const blockedDel = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'admin');
  if (blockedDel) return blockedDel;
  const roleId = req.nextUrl.searchParams.get('roleId');
  if (!roleId) return NextResponse.json({ ok: false, error: 'roleId required' }, { status: 400 });

  try {
    const role = await getRole(params.id, roleId);
    if (role) {
      try {
        await revokeRoleAcls(role);
      } catch (e: any) {
        if (/No LOOM_/.test(String(e?.message))) return aclGate();
        // Non-fatal — proceed to delete the definition even if ACL cleanup failed.
      }
    }
    await deleteRole(params.id, roleId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

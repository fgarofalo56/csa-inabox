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

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
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
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const fabricCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();
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
export async function GET(_req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });

  const sp = _req.nextUrl.searchParams;
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
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
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
}

export async function PUT(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  // Update shares the POST handler (upsert + re-apply).
  return POST(req, props);
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
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
}

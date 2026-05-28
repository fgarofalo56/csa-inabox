/**
 * GET /api/catalog/permissions?source=...&securable=...&host=...
 *   Read role assignments for a securable.
 *
 *   - source=unity-catalog: ?secType=CATALOG|SCHEMA|TABLE|VOLUME &
 *       securable=<full_name> & host=<workspace_hostname>
 *   - source=onelake: ?workspaceId=<id>
 *   - source=purview: not yet — Purview RBAC requires Microsoft.Authorization
 *     ARM calls; gated until phase 2.
 *
 * POST /api/catalog/permissions
 *   Body: {
 *     source: 'unity-catalog' | 'onelake',
 *     loomRole: 'Reader' | 'Contributor' | 'Admin' | 'Owner',
 *     principal: string,                      // UPN | groupName | clientId
 *     principalType?: 'User'|'Group'|'ServicePrincipal',
 *     // unity-catalog only:
 *     host?: string,
 *     secType?: UCSecurableType,
 *     securable?: string,                     // e.g. main.bronze.customers
 *     useSQL?: boolean,                       // if true, fan out via warehouseId
 *     warehouseId?: string,
 *     // onelake only:
 *     workspaceId?: string,
 *   }
 *
 * The Loom role maps deterministically to back-end privileges per the
 * docs/fiab/catalog/permissions.md table:
 *
 *   Loom Role        UC privileges                              Fabric role
 *   ──────────       ─────────────                              ────────────
 *   Reader           SELECT, USE_CATALOG, USE_SCHEMA, READ_VOLUME  Viewer
 *   Contributor      Reader + MODIFY, REFRESH                      Contributor
 *   Admin            Contributor + APPLY_TAG + EXECUTE             Member
 *   Owner            ALL_PRIVILEGES                                Admin
 *
 * DELETE /api/catalog/permissions
 *   Same body shape, removes the same privilege set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listPermissions, updatePermissions, grantPrivilegesSQL, revokePrivilegesSQL,
  UnityCatalogNotConfiguredError, UnityCatalogError,
  type UCSecurableType,
} from '@/lib/azure/unity-catalog-client';
import {
  listWorkspaceUsers, addWorkspaceRoleAssignment, removeWorkspaceRoleAssignment,
  OneLakeError,
} from '@/lib/azure/onelake-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type LoomRole = 'Reader' | 'Contributor' | 'Admin' | 'Owner';

const UC_PRIVS: Record<LoomRole, string[]> = {
  Reader: ['SELECT', 'USE_CATALOG', 'USE_SCHEMA', 'READ_VOLUME'],
  Contributor: ['SELECT', 'USE_CATALOG', 'USE_SCHEMA', 'READ_VOLUME', 'MODIFY', 'REFRESH', 'WRITE_VOLUME'],
  Admin: ['SELECT', 'USE_CATALOG', 'USE_SCHEMA', 'READ_VOLUME', 'MODIFY', 'REFRESH', 'WRITE_VOLUME', 'APPLY_TAG', 'EXECUTE'],
  Owner: ['ALL_PRIVILEGES'],
};

const FABRIC_ROLE: Record<LoomRole, 'Viewer' | 'Contributor' | 'Member' | 'Admin'> = {
  Reader: 'Viewer',
  Contributor: 'Contributor',
  Admin: 'Member',
  Owner: 'Admin',
};

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const source = req.nextUrl.searchParams.get('source');
  try {
    if (source === 'unity-catalog') {
      const host = req.nextUrl.searchParams.get('host') || '';
      const secType = (req.nextUrl.searchParams.get('secType') || 'CATALOG') as UCSecurableType;
      const securable = req.nextUrl.searchParams.get('securable') || '';
      if (!host || !securable) {
        return NextResponse.json({ ok: false, error: 'host and securable required' }, { status: 400 });
      }
      const perms = await listPermissions(host, secType, securable);
      return NextResponse.json({ ok: true, source, perms });
    }
    if (source === 'onelake') {
      const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
      if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
      const users = await listWorkspaceUsers(workspaceId);
      return NextResponse.json({ ok: true, source, users });
    }
    return NextResponse.json({ ok: false, error: 'source must be unity-catalog or onelake' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof UnityCatalogError || e instanceof OneLakeError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}

export async function POST(req: NextRequest) {
  return mutate(req, 'add');
}
export async function DELETE(req: NextRequest) {
  return mutate(req, 'remove');
}

async function mutate(req: NextRequest, action: 'add' | 'remove') {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const source = body.source as 'unity-catalog' | 'onelake' | undefined;
  const loomRole = body.loomRole as LoomRole | undefined;
  const principal = body.principal as string | undefined;
  if (!source || !loomRole || !principal) {
    return NextResponse.json({ ok: false, error: 'source, loomRole, principal required' }, { status: 400 });
  }
  if (!UC_PRIVS[loomRole]) {
    return NextResponse.json({ ok: false, error: `Unknown loomRole "${loomRole}"` }, { status: 400 });
  }

  try {
    if (source === 'unity-catalog') {
      const host = body.host as string;
      const secType = body.secType as UCSecurableType;
      const securable = body.securable as string;
      if (!host || !secType || !securable) {
        return NextResponse.json({ ok: false, error: 'host, secType, securable required' }, { status: 400 });
      }
      if (body.useSQL && body.warehouseId) {
        const fn = action === 'add' ? grantPrivilegesSQL : revokePrivilegesSQL;
        const result = await fn(body.warehouseId, UC_PRIVS[loomRole], secType, securable, principal);
        return NextResponse.json({ ok: true, mode: 'sql', result });
      }
      const changes = action === 'add'
        ? { add: [{ principal, privileges: UC_PRIVS[loomRole] }] }
        : { remove: [{ principal, privileges: UC_PRIVS[loomRole] }] };
      const result = await updatePermissions(host, secType, securable, changes);
      return NextResponse.json({ ok: true, mode: 'rest', result });
    }

    if (source === 'onelake') {
      const workspaceId = body.workspaceId as string;
      if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
      if (action === 'add') {
        await addWorkspaceRoleAssignment(workspaceId, {
          principal: { id: principal, type: (body.principalType || 'User') as any },
          role: FABRIC_ROLE[loomRole],
        });
      } else {
        await removeWorkspaceRoleAssignment(workspaceId, principal);
      }
      return NextResponse.json({ ok: true, mode: 'fabric', role: FABRIC_ROLE[loomRole] });
    }
    return NextResponse.json({ ok: false, error: `Unsupported source: ${source}` }, { status: 400 });
  } catch (e: any) {
    if (e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof UnityCatalogError || e instanceof OneLakeError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}

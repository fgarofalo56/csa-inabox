/**
 * Permissions BFF for the Lakehouse editor — container RBAC **and** Synapse
 * SQL-plane (table / column / row) grants in one route, keyed by `?tab=`.
 *
 *   tab=object (default)  Azure RBAC role-assignments at the container scope
 *                         (Storage Blob Data Reader/Contributor/Owner) via ARM.
 *   tab=table             Object-level `GRANT SELECT ON [s].[t] TO [upn]`.
 *   tab=column            Column-level `GRANT SELECT ON [s].[t](cols) TO [upn]`.
 *   tab=row               Row-level security via `CREATE SECURITY POLICY` + TVF.
 *   tab=cls               Column-level security (hide columns): table-level
 *                         `GRANT` + column-scope `DENY SELECT` (+ optional
 *                         Serverless masked view). DENY hides the columns.
 *
 * The SQL-plane tabs run real T-SQL against the **Synapse Dedicated SQL pool**
 * (Azure-native — NO Fabric dependency). When the pool isn't configured the
 * route returns `{ ok:false, gate:true, missing:'LOOM_SYNAPSE_DEDICATED_POOL' }`
 * with HTTP 503 so the UI shows a precise MessageBar (no silent no-op).
 *
 * Every GET names the lakehouse it is for (`lakehouseId=`), authorized for read
 * through `authorizeItem` (404 when the caller cannot reach it). For tab=object
 * the container must be that lakehouse's storage container, and the role
 * assignments are listed on the item's bound storage account; a tab=object GET
 * without `lakehouseId` is a 400 `item_required` for every caller, the same
 * answer the grant and the revoke give. Only a tenant admin may list the
 * SQL-plane tabs without `lakehouseId`.
 *
 * The object-tab WRITES (grant, revoke) are tenant-admin only and also name the
 * lakehouse (`lakehouseId`, required): they act on the same container and the
 * same bound account the GET lists, so a row the dialog shows is the row a
 * revoke removes, and a grant appears in the next listing. A binding whose
 * account cannot be read answers 409 on every verb; nothing falls back to the
 * configured account. When Azure refuses the role-assignment read, create or
 * delete itself, the answer is a 403 with a `code` and the role to grant.
 *
 * The SQL-plane tabs read the one shared dedicated pool's catalogue:
 * `lakehouseId` decides who may list, not which objects are listed, because
 * lakehouse tables live in each item's Spark database and nothing links a pool
 * object to a lakehouse item. Narrowing the listing is tracked in #4850.
 *
 * GET  ?lakehouseId=<id>&tab=object[&container=<c>] → { assignments, knownRoles }
 * GET  ?lakehouseId=<id>&tab=table|column        → { grants }
 * GET  ?lakehouseId=<id>&tab=table|column&list=tables → { tables }
 * GET  ?lakehouseId=<id>&tab=column&list=columns&objectId=<n> → { columns }
 * GET  ?lakehouseId=<id>&tab=row                 → { policies }
 * GET  ?lakehouseId=<id>&tab=row&list=tables | &list=columns&objectId=<n>
 * POST { tab:'object', lakehouseId, principalId, role, container? } → grant RBAC (tenant admin)
 * POST { tab, ... }                              → SQL-plane grant / create (tenant admin)
 * DELETE ?tab=object&lakehouseId=<id>&container=<c>&id=<armId> → revoke RBAC (tenant admin; id
 *                                                  must be an assignment listed on <c> on the
 *                                                  item's bound account)
 * DELETE ?tab=table|column body { upn, objectId, columnIds? } → revoke SELECT (tenant admin)
 * DELETE ?tab=row&policyObjectId=<n>             → drop security policy (tenant admin)
 *
 * Principals: RBAC assignments are enriched OID→UPN via Microsoft Graph when
 * LOOM_GRAPH_USERS_ENABLED=true; SQL-plane principals are already UPNs (the
 * database users are CREATE USER … FROM EXTERNAL PROVIDER).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  listKnownBlobDataRoles,
  StorageAccountNotLocatedError,
  StorageRoleDeniedError,
  type ContainerRoleAssignment,
} from '@/lib/azure/adls-client';
import { revokeContainerRoleAssignmentInScope } from '../_lib/container-role-assignment';
import {
  dedicatedTarget,
  serverlessTarget,
  listSqlTables,
  listSqlColumns,
  listTableGrants,
  grantTableSelect,
  revokeTableSelect,
  listColumnDenyGrants,
  denyColumnSelect,
  revokeColumnDeny,
  generateMaskedView,
  listRlsPolicies,
  createRlsPolicy,
  createRlsPolicyWithPredicate,
  dropRlsPolicy,
  RLS_SUBJECTS,
  type RlsSubject,
  type SynapseTarget,
} from '@/lib/azure/synapse-permissions-client';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { graphBase as cloudGraphBase, getGraphScope } from '@/lib/azure/cloud-endpoints';
import { withSession } from '@/lib/api/route-toolkit';
import { resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';
import { boundAccountOf, lakehouseStorageWithheldResponse } from '../_lib/item-scope';
import { authorizeItem, withRefusalFields } from '../_lib/refusal-envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Tab = 'object' | 'table' | 'column' | 'row' | 'cls';
function parseTab(v: string | null | undefined): Tab {
  return v === 'table' || v === 'column' || v === 'row' || v === 'cls' ? v : 'object';
}

/** A refusal with the stable `code` and `remediation` fields the lakehouse routes carry. */
function refuse(status: number, error: string, code: string, remediation: string): NextResponse {
  return NextResponse.json({ ok: false, error, code, remediation }, { status });
}

/** The 403 for a container other than the lakehouse's own. */
function containerMismatch(container: string, own: string): NextResponse {
  return refuse(
    403,
    `Container ${container} is not this lakehouse's storage container (${own}). Open the lakehouse that `
    + 'uses it to see or change its role assignments.',
    'outside_item_root',
    'Open the lakehouse that uses this container and manage its permissions from its editor.',
  );
}

/** The 400 for an object-tab request that does not name its lakehouse. */
function itemRequired(verb: 'Listing' | 'Granting' | 'Revoking'): NextResponse {
  const subject = verb === 'Listing' ? 'container role assignments needs the lakehouse they belong to'
    : 'a container role needs the lakehouse it belongs to';
  const action = verb === 'Listing' ? 'listed' : verb === 'Granting' ? 'granted' : 'removed';
  const reach = verb === 'Listing' ? 'reads' : 'acts on';
  return refuse(
    400,
    `${verb} ${subject} (lakehouseId), so Loom ${reach} the storage account that lakehouse is bound to. `
    + `Nothing was ${action}.`,
    'item_required',
    verb === 'Listing'
      ? 'Open the lakehouse and use its Permissions dialog, so the request names the item.'
      : 'Open the lakehouse and use its Permissions dialog or Share, so the request names the item.',
  );
}

/**
 * The error response for a failure inside a handler. A bound storage account
 * that Resource Graph could not place is a 409, and a role-assignment read,
 * create or delete that Azure refused is a 403 (`storage_role_read_denied` /
 * `storage_role_write_denied`); both carry the remediation. The 403 also
 * carries `correlationId`: Azure's own message is logged on the server under
 * that id and is not part of the response. A revoke lists the assignments
 * first, so a refused read there is `storage_role_read_denied`. Anything else
 * keeps its own status (502 when it has none).
 */
function failure(e: any): NextResponse {
  if (e instanceof StorageAccountNotLocatedError) return refuse(409, e.message, e.code, e.remediation);
  if (e instanceof StorageRoleDeniedError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: e.code, remediation: e.remediation, correlationId: e.correlationId },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
}

/**
 * The object tab's container and storage account for one lakehouse: the item
 * is authorized for read (`authorizeItem`: 404 when unreachable), its binding
 * is resolved from server-recorded state, and the account is read from the
 * bound abfss URI. The GET listing, the grant and the revoke all use this, so
 * the three act on the same account. A binding whose account cannot be read is
 * a 409, never the configured account.
 */
async function objectTabBinding(
  session: Parameters<typeof authorizeItem>[0],
  lakehouseId: string,
): Promise<{ container: string; account: string } | NextResponse> {
  const access = await authorizeItem(session, lakehouseId);
  if (access instanceof NextResponse) return access;
  const resolved = await resolveLakehouseStorage(lakehouseId, access.item.workspaceId);
  if (!resolved.ok) {
    const withheld = lakehouseStorageWithheldResponse(resolved.reason);
    if (withheld) return withRefusalFields(withheld);
    return refuse(
      409,
      'Loom has no lakehouse storage binding for this item, so there is no container whose role '
      + 'assignments it could read or change. Re-run the item provision and retry.',
      'no_storage_binding',
      'Re-run the item provision from the lakehouse editor, then retry.',
    );
  }
  const account = boundAccountOf(resolved.bound.abfss);
  if (!account) {
    return refuse(
      409,
      'Loom found a storage binding for this lakehouse, but could not read a storage account from it '
      + `(${JSON.stringify(String(resolved.bound.abfss ?? ''))}), so it did not read or change any role `
      + 'assignment. Re-run the item provision to rewrite the binding.',
      'storage_account_unreadable',
      'Re-run the item provision to rewrite the binding, then retry.',
    );
  }
  return { container: resolved.bound.container, account };
}

/**
 * The one tenant-admin refusal body for the write verbs (POST grants, DELETE
 * revokes). `error` carries the full sentence because every caller renders
 * `error`; `code` and `remediation` let a caller branch or show a next step.
 */
function tenantAdminRequiredBody(verb: 'Granting' | 'Revoking') {
  const action = verb === 'Granting' ? 'grant' : 'remove';
  const message = `${verb} lakehouse permissions requires tenant-admin, so Loom did not ${action} anything.`;
  const remediation =
    `Ask a tenant admin to ${action} the role for you, or ${action} it on the storage container in the Azure portal.`;
  return { ok: false as const, error: message, code: 'admin_only', remediation };
}

/** The 403 for a write verb when the caller is not a tenant admin. */
function tenantAdminRequired(verb: 'Granting' | 'Revoking'): NextResponse {
  return NextResponse.json(tenantAdminRequiredBody(verb), { status: 403 });
}

/** Honest infra-gate when the Synapse Dedicated SQL pool isn't configured. */
function resolveDedicated(): { target: SynapseTarget } | { gate: NextResponse } {
  try {
    return { target: dedicatedTarget() };
  } catch {
    return {
      gate: NextResponse.json(
        {
          ok: false,
          gate: true,
          missing: 'LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL',
          hint: 'Table/Column/Row-level security run on the Azure-native Synapse Dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL on loom-console (already wired in admin-plane/main.bicep) and grant the Console UAMI db_owner on the pool database.',
        },
        { status: 503 },
      ),
    };
  }
}

// ── Microsoft Graph OID → UPN enrichment (opt-in via LOOM_GRAPH_USERS_ENABLED) ─
// ACA-first UAMI chain (see lib/azure/arm-credential.ts — the ACA MI token bug).
const graphCredential = uamiArmCredential();

function graphBase(): string {
  // Graph root + /v1.0 via the one cloud resolver (#3381). The previous body
  // was `LOOM_GRAPH_BASE || 'https://graph.microsoft.com'`, which defaulted to
  // the Commercial host on every boundary that did not carry that variable.
  return cloudGraphBase();
}

async function enrichUpns(
  assignments: ContainerRoleAssignment[],
): Promise<Array<ContainerRoleAssignment & { upn?: string }>> {
  if (process.env.LOOM_GRAPH_USERS_ENABLED !== 'true') return assignments;
  const userIds = Array.from(
    new Set(
      assignments
        .filter((a) => (a.principalType || 'User') === 'User' && a.principalId)
        .map((a) => a.principalId),
    ),
  );
  if (userIds.length === 0) return assignments;
  let token: string;
  try {
    const t = await graphCredential.getToken(getGraphScope());
    if (!t?.token) return assignments;
    token = t.token;
  } catch {
    return assignments; // graceful — UI falls back to OID prefix
  }
  const map = new Map<string, string>();
  await Promise.all(
    userIds.map(async (oid) => {
      try {
        const res = await fetch(`${graphBase()}/users/${encodeURIComponent(oid)}?$select=userPrincipalName`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.ok) {
          const j = await res.json();
          if (j?.userPrincipalName) map.set(oid, String(j.userPrincipalName));
        }
      } catch {
        /* per-principal failure is non-fatal */
      }
    }),
  );
  return assignments.map((a) => (map.has(a.principalId) ? { ...a, upn: map.get(a.principalId) } : a));
}

// ─────────────────────────────────────────────────────────────────────────────
export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const tab = parseTab(sp.get('tab'));

  // Reads are scoped to one lakehouse: `lakehouseId` is authorized for read
  // (404 when the caller cannot reach it, as every other lakehouse route
  // answers). The object tab always needs the item, as the grant and the
  // revoke do, so every row it lists is one a revoke can act on. Without an
  // item only a tenant admin may list the SQL-plane tabs, since the listing is
  // then not tied to anything the caller can open.
  const lakehouseId = (sp.get('lakehouseId') || '').trim();
  if (tab === 'object' && !lakehouseId) return itemRequired('Listing');
  // The object tab's container and the account it is listed on, both from
  // the item's binding.
  let boundContainer = '';
  let listAccount = '';
  if (!lakehouseId) {
    if (!isTenantAdmin(session)) {
      return refuse(
        403,
        'Listing lakehouse permissions needs the lakehouse they belong to (lakehouseId). Open the lakehouse '
        + 'and use its permissions view; listing without a lakehouse is limited to tenant admins.',
        'admin_only',
        'Open the lakehouse and use its Permissions dialog, so the request names the item.',
      );
    }
  } else if (tab === 'object') {
    // Container role assignments are listed only on the item's own container,
    // on the account it is bound to.
    const binding = await objectTabBinding(session, lakehouseId);
    if (binding instanceof NextResponse) return binding;
    boundContainer = binding.container;
    listAccount = binding.account;
  } else {
    const access = await authorizeItem(session, lakehouseId);
    if (access instanceof NextResponse) return access;
  }

  try {
    if (tab === 'object') {
      const container = sp.get('container') || boundContainer;
      if (container !== boundContainer) return containerMismatch(container, boundContainer);
      const raw = await listContainerRoleAssignments(container, listAccount);
      const assignments = await enrichUpns(raw);
      const knownRoles = listKnownBlobDataRoles();
      return NextResponse.json({ ok: true, assignments, knownRoles });
    }

    // SQL-plane tabs — Synapse Dedicated SQL pool.
    const r = resolveDedicated();
    if ('gate' in r) return r.gate;
    const target = r.target;
    const list = sp.get('list');

    if (list === 'tables') {
      const tables = await listSqlTables(target);
      return NextResponse.json({ ok: true, tables });
    }
    if (list === 'columns') {
      const objectId = Number(sp.get('objectId'));
      if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId required' }, { status: 400 });
      const columns = await listSqlColumns(target, objectId);
      return NextResponse.json({ ok: true, columns });
    }

    if (tab === 'row') {
      const policies = await listRlsPolicies(target);
      return NextResponse.json({ ok: true, policies, subjects: RLS_SUBJECTS });
    }
    if (tab === 'cls') {
      // Column-level security: hidden-column DENY entries + (for the conflict
      // detector) the column-level GRANT entries that overlap them.
      const denyGrants = await listColumnDenyGrants(target);
      const grants = (await listTableGrants(target)).filter((g) => g.column != null);
      return NextResponse.json({ ok: true, denyGrants, grants });
    }
    // tab=table | tab=column → object-level + column-level grants
    const grants = await listTableGrants(target);
    return NextResponse.json({ ok: true, grants });
  } catch (e: any) {
    return failure(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  // Granting data-plane access to the SHARED lake is a tenant-admin action.
  // This POST was session-only, so ANY authenticated user could assign
  // themselves a blob data role on any container — and, before the allow-list
  // added to adls-client.grantContainerRole, ANY Azure role at all (the role
  // name fell through as a raw role-definition GUID, and the Console UAMI holds
  // Role Based Access Control Administrator at that scope). Note `principalType`
  // was validated here while `role` and `principalId` were not, which is what
  // made the gap easy to miss on review.
  if (!isTenantAdmin(session)) {
    return NextResponse.json(tenantAdminRequiredBody('Granting'), { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const tab = parseTab(body?.tab ?? req.nextUrl.searchParams.get('tab'));

  try {
    if (tab === 'object') {
      const { container: named, principalId, role, principalType } = body || {};
      const lakehouseId = typeof body?.lakehouseId === 'string' ? body.lakehouseId.trim() : '';
      if (!lakehouseId) return itemRequired('Granting');
      if (!principalId || !role) {
        return NextResponse.json({ ok: false, error: 'principalId, role required' }, { status: 400 });
      }
      // The grant lands on the container and account the listing reads, so it
      // shows in the dialog's next GET.
      const binding = await objectTabBinding(session, lakehouseId);
      if (binding instanceof NextResponse) return binding;
      const container = typeof named === 'string' && named ? named : binding.container;
      if (container !== binding.container) return containerMismatch(container, binding.container);
      const assignment = await grantContainerRole(
        binding.container,
        principalId,
        role,
        principalType && ['User', 'Group', 'ServicePrincipal'].includes(principalType) ? principalType : 'User',
        binding.account,
      );
      return NextResponse.json({ ok: true, assignment });
    }

    const r = resolveDedicated();
    if ('gate' in r) return r.gate;
    const target = r.target;

    if (tab === 'table' || tab === 'column') {
      const upn = String(body?.upn || '').trim();
      const objectId = Number(body?.objectId);
      const columnIds: number[] = Array.isArray(body?.columnIds) ? body.columnIds.map((n: any) => Number(n)) : [];
      if (!upn || !Number.isInteger(objectId)) {
        return NextResponse.json({ ok: false, error: 'upn and objectId required' }, { status: 400 });
      }
      if (tab === 'column' && columnIds.length === 0) {
        return NextResponse.json({ ok: false, error: 'at least one columnId required for a column-level grant' }, { status: 400 });
      }
      const res = await grantTableSelect(target, upn, objectId, tab === 'column' ? columnIds : []);
      return NextResponse.json({ ok: true, ...res });
    }

    if (tab === 'cls') {
      // Hide columns from a principal: table-level GRANT + column-level DENY on
      // the Dedicated pool. Optionally also generate a Serverless masked view.
      const upn = String(body?.upn || '').trim();
      const objectId = Number(body?.objectId);
      const columnIds: number[] = Array.isArray(body?.columnIds) ? body.columnIds.map((n: any) => Number(n)) : [];
      if (!upn || !Number.isInteger(objectId)) {
        return NextResponse.json({ ok: false, error: 'upn and objectId required' }, { status: 400 });
      }
      if (columnIds.length === 0) {
        return NextResponse.json({ ok: false, error: 'at least one columnId required to hide a column' }, { status: 400 });
      }
      const res = await denyColumnSelect(target, upn, objectId, columnIds);
      let maskedView: { viewFqn: string; hiddenColumns: string[] } | undefined;
      if (body?.maskView === true) {
        // Serverless masked view = NULL-projection of the hidden columns. Needs
        // LOOM_SYNAPSE_WORKSPACE; serverlessTarget() throws (caught below) when unset.
        const db = String(body?.serverlessDatabase || 'master');
        const mv = await generateMaskedView(serverlessTarget(db), objectId, columnIds, body?.viewSuffix || upn);
        maskedView = { viewFqn: mv.viewFqn, hiddenColumns: mv.hiddenColumns };
      }
      return NextResponse.json({ ok: true, ...res, maskedView });
    }

    // tab === 'row'
    const objectId = Number(body?.objectId);
    const filterColumnId = Number(body?.filterColumnId);
    if (!Number.isInteger(objectId) || !Number.isInteger(filterColumnId)) {
      return NextResponse.json({ ok: false, error: 'objectId and filterColumnId required' }, { status: 400 });
    }

    // F8 — free-form WHERE-predicate path. When the body carries `whereClause`
    // the policy is built from the custom predicate (validated server-side);
    // otherwise the original fixed-subject path (USER_NAME()/SUSER_SNAME()).
    if (body?.whereClause != null) {
      const whereClause = String(body.whereClause);
      try {
        const res = await createRlsPolicyWithPredicate(target, { objectId, filterColumnId, whereClause });
        return NextResponse.json({ ok: true, ...res });
      } catch (e: any) {
        if (e?.code === 'invalid_where_clause') {
          return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
        }
        throw e;
      }
    }

    const subject = (RLS_SUBJECTS as readonly string[]).includes(body?.subject)
      ? (body.subject as RlsSubject)
      : 'USER_NAME()';
    const res = await createRlsPolicy(target, { objectId, filterColumnId, subject });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return failure(e);
  }
});

export const DELETE = withSession(async (req: NextRequest, { session }) => {
  // Revoking is the mirror of granting: the same tenant-admin rule as POST.
  if (!isTenantAdmin(session)) return tenantAdminRequired('Revoking');
  const sp = req.nextUrl.searchParams;
  const tab = parseTab(sp.get('tab'));

  try {
    if (tab === 'object') {
      const id = (sp.get('id') || '').trim();
      const named = (sp.get('container') || '').trim();
      const lakehouseId = (sp.get('lakehouseId') || '').trim();
      if (!id) {
        return NextResponse.json(
          { ok: false, error: 'id (full ARM role-assignment id on the lakehouse container) required' },
          { status: 400 },
        );
      }
      if (!lakehouseId) return itemRequired('Revoking');
      // The membership check lists the same container on the same account the
      // dialog's GET listed, so an id the dialog shows is found here.
      const binding = await objectTabBinding(session, lakehouseId);
      if (binding instanceof NextResponse) return binding;
      const container = named || binding.container;
      if (container !== binding.container) return containerMismatch(container, binding.container);
      const res = await revokeContainerRoleAssignmentInScope(binding.container, id, binding.account);
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: res.message }, { status: res.reason === 'invalid' ? 400 : 404 });
      }
      return NextResponse.json({ ok: true });
    }

    const r = resolveDedicated();
    if ('gate' in r) return r.gate;
    const target = r.target;

    if (tab === 'table' || tab === 'column') {
      const body = await req.json().catch(() => ({}));
      const upn = String(body?.upn || '').trim();
      const objectId = Number(body?.objectId);
      const columnIds: number[] = Array.isArray(body?.columnIds) ? body.columnIds.map((n: any) => Number(n)) : [];
      if (!upn || !Number.isInteger(objectId)) {
        return NextResponse.json({ ok: false, error: 'upn and objectId required' }, { status: 400 });
      }
      const res = await revokeTableSelect(target, upn, objectId, columnIds);
      return NextResponse.json({ ok: true, ...res });
    }

    if (tab === 'cls') {
      // Un-hide columns: REVOKE the column-level SELECT entry (clears the DENY).
      const body = await req.json().catch(() => ({}));
      const upn = String(body?.upn || '').trim();
      const objectId = Number(body?.objectId);
      const columnIds: number[] = Array.isArray(body?.columnIds) ? body.columnIds.map((n: any) => Number(n)) : [];
      if (!upn || !Number.isInteger(objectId) || columnIds.length === 0) {
        return NextResponse.json({ ok: false, error: 'upn, objectId and at least one columnId required' }, { status: 400 });
      }
      const res = await revokeColumnDeny(target, upn, objectId, columnIds);
      return NextResponse.json({ ok: true, ...res });
    }

    // tab === 'row'
    const policyObjectId = Number(sp.get('policyObjectId'));
    if (!Number.isInteger(policyObjectId)) {
      return NextResponse.json({ ok: false, error: 'policyObjectId required' }, { status: 400 });
    }
    const res = await dropRlsPolicy(target, policyObjectId);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return failure(e);
  }
});

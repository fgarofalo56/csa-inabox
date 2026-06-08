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
 * GET  ?tab=object&container=<c>                 → { assignments, knownRoles }
 * GET  ?tab=table|column&container=<c>           → { grants }
 * GET  ?tab=table|column&list=tables             → { tables }
 * GET  ?tab=column&list=columns&objectId=<n>     → { columns }
 * GET  ?tab=row                                  → { policies }
 * GET  ?tab=row&list=tables | &list=columns&objectId=<n>
 * POST { tab, ... }                              → grant / create
 * DELETE ?tab=object&id=<armId>                  → revoke RBAC
 * DELETE ?tab=table|column body { upn, objectId, columnIds? } → revoke SELECT
 * DELETE ?tab=row&policyObjectId=<n>             → drop security policy
 *
 * Principals: RBAC assignments are enriched OID→UPN via Microsoft Graph when
 * LOOM_GRAPH_USERS_ENABLED=true; SQL-plane principals are already UPNs (the
 * database users are CREATE USER … FROM EXTERNAL PROVIDER).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  revokeContainerRoleAssignment,
  listKnownBlobDataRoles,
  type ContainerRoleAssignment,
} from '@/lib/azure/adls-client';
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
  dropRlsPolicy,
  RLS_SUBJECTS,
  type RlsSubject,
  type SynapseTarget,
} from '@/lib/azure/synapse-permissions-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Tab = 'object' | 'table' | 'column' | 'row' | 'cls';
function parseTab(v: string | null | undefined): Tab {
  return v === 'table' || v === 'column' || v === 'row' || v === 'cls' ? v : 'object';
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
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const graphCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

function graphBase(): string {
  // graph.microsoft.com (commercial) / graph.microsoft.us (Gov) — env-driven.
  return (process.env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/+$/, '') + '/v1.0';
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
    const t = await graphCredential.getToken('https://graph.microsoft.com/.default');
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
export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const tab = parseTab(sp.get('tab'));

  try {
    if (tab === 'object') {
      const container = sp.get('container');
      if (!container) return NextResponse.json({ ok: false, error: 'container query param required' }, { status: 400 });
      const raw = await listContainerRoleAssignments(container);
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
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const tab = parseTab(body?.tab ?? req.nextUrl.searchParams.get('tab'));

  try {
    if (tab === 'object') {
      const { container, principalId, role, principalType } = body || {};
      if (!container || !principalId || !role) {
        return NextResponse.json({ ok: false, error: 'container, principalId, role required' }, { status: 400 });
      }
      const assignment = await grantContainerRole(
        container,
        principalId,
        role,
        principalType && ['User', 'Group', 'ServicePrincipal'].includes(principalType) ? principalType : 'User',
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
    const subject = (RLS_SUBJECTS as readonly string[]).includes(body?.subject)
      ? (body.subject as RlsSubject)
      : 'USER_NAME()';
    if (!Number.isInteger(objectId) || !Number.isInteger(filterColumnId)) {
      return NextResponse.json({ ok: false, error: 'objectId and filterColumnId required' }, { status: 400 });
    }
    const res = await createRlsPolicy(target, { objectId, filterColumnId, subject });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const tab = parseTab(sp.get('tab'));

  try {
    if (tab === 'object') {
      const id = sp.get('id');
      if (!id) return NextResponse.json({ ok: false, error: 'id (full ARM role-assignment id) required' }, { status: 400 });
      await revokeContainerRoleAssignment(id);
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
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

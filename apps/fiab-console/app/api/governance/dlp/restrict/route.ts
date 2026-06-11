/**
 * POST /api/governance/dlp/restrict
 *
 * DLP restrict-access propagation. Revokes REAL data-plane access for a
 * non-exempt principal on a data scope, then records the action in Cosmos.
 *
 * Body:
 *   {
 *     scopeType: 'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database',
 *     scopeRef:  string,                 // container name / kql db / 'warehouse'
 *     subPath?:  string,                 // adls-path: directory/file under the container
 *     schema?:   string,                 // warehouse-schema: SQL schema to DENY SELECT on
 *     principalId: string,               // Entra object id to restrict
 *     principalName?: string,            // UPN / display name (needed for SQL/ADX)
 *     exemptPrincipalIds?: string[]      // never-restrict list
 *   }
 *
 * For adls-container scopes the route:
 *   1. Reads the container's current Storage data-plane role assignments (ARM).
 *   2. Revokes every assignment held by the target principal (real ARM DELETE).
 *   3. Re-reads assignments (ARM) to CONFIRM the principal no longer holds any.
 * For adls-path scopes it removes the principal from the directory/file POSIX
 * ACL (access + default scope) and reads the ACL back to confirm removal.
 * For warehouse-schema scopes it executes `DENY SELECT ON SCHEMA::[s]` against
 * the env-bound Synapse dedicated pool (real TDS).
 * For warehouse / kql-database scopes it replays the inverse data-plane grant
 * via revokeStructuredGrant (real Synapse SQL / ADX command).
 *
 * It then (a) marks any matching governance Access policy as restricted in the
 * `policies:<tenant>` doc and (b) appends a restriction record to the
 * `dlp-meta:<tenant>` doc — the authoritative "item-permissions" change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { listContainerRoleAssignments, revokeContainerRoleAssignment, removePrincipalFromPathAcl } from '@/lib/azure/adls-client';
import { revokeStructuredGrant, denySchemaAccess, type PrincipalType } from '@/lib/azure/access-policy-client';
import { loadDlpMeta, saveDlpMeta, type DlpRestriction } from '../_lib/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ScopeType = 'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database';
const SCOPE_TYPES: ScopeType[] = ['adls-container', 'adls-path', 'warehouse', 'warehouse-schema', 'kql-database'];

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const scopeType = String(body?.scopeType || '') as ScopeType;
  const scopeRef = String(body?.scopeRef || '').trim();
  const subPath = body?.subPath ? String(body.subPath).trim().replace(/^\/+|\/+$/g, '') : '';
  const schema = body?.schema ? String(body.schema).trim() : '';
  const principalId = String(body?.principalId || '').trim();
  const principalName = body?.principalName ? String(body.principalName) : undefined;
  const principalType = (['User', 'Group', 'ServicePrincipal'].includes(body?.principalType)
    ? body.principalType : 'User') as PrincipalType;
  const exemptPrincipalIds: string[] = Array.isArray(body?.exemptPrincipalIds)
    ? body.exemptPrincipalIds.map((x: unknown) => String(x)) : [];

  if (!SCOPE_TYPES.includes(scopeType)) {
    return NextResponse.json({ ok: false, error: `scopeType must be one of ${SCOPE_TYPES.join(' | ')}` }, { status: 400 });
  }
  if (!principalId) return NextResponse.json({ ok: false, error: 'principalId is required' }, { status: 400 });
  // warehouse / warehouse-schema resolve their target from env; others need scopeRef.
  if (scopeType !== 'warehouse' && scopeType !== 'warehouse-schema' && !scopeRef) {
    return NextResponse.json({ ok: false, error: 'scopeRef is required' }, { status: 400 });
  }
  if (scopeType === 'adls-path' && !subPath) {
    return NextResponse.json({ ok: false, error: 'subPath (the directory/file under the container) is required for adls-path scope' }, { status: 400 });
  }
  if (scopeType === 'warehouse-schema' && !schema) {
    return NextResponse.json({ ok: false, error: 'schema is required for warehouse-schema scope' }, { status: 400 });
  }
  if (scopeType === 'warehouse-schema' && !principalName) {
    return NextResponse.json({ ok: false, error: 'principalName (UPN) is required to DENY warehouse schema access' }, { status: 400 });
  }

  // Exempt principals are never restricted — honest no-op (not a silent skip).
  if (exemptPrincipalIds.includes(principalId)) {
    return NextResponse.json({
      ok: true, restricted: false, skippedExempt: true,
      detail: 'Principal is on the exempt list; access left intact.',
    });
  }

  const tenantId = s.claims.oid;
  const revokedRoleAssignmentIds: string[] = [];
  const revokedRoleNames: string[] = [];
  let armConfirmed = false;
  let aclConfirmed: boolean | undefined;
  let executedStatement: string | undefined;
  let note: string | undefined;

  try {
    if (scopeType === 'adls-container') {
      // 1. Read current assignments, 2. revoke this principal's, 3. confirm.
      const before = await listContainerRoleAssignments(scopeRef);
      const mine = before.filter((a) => a.principalId === principalId);
      if (mine.length === 0) {
        return NextResponse.json({
          ok: true, restricted: false,
          detail: `Principal holds no Storage data-plane role on container "${scopeRef}" — nothing to revoke.`,
          armConfirmed: true, revokedRoleNames: [], revokedRoleAssignmentIds: [],
        });
      }
      for (const a of mine) {
        await revokeContainerRoleAssignment(a.id);
        revokedRoleAssignmentIds.push(a.id);
        if (a.roleName) revokedRoleNames.push(a.roleName);
      }
      // ARM read-back confirmation.
      const after = await listContainerRoleAssignments(scopeRef);
      armConfirmed = !after.some((a) => a.principalId === principalId);
    } else if (scopeType === 'adls-path') {
      // Remove the principal from the directory/file POSIX ACL (access+default),
      // then read the ACL back to confirm. Honest note: container-level Storage
      // RBAC is NOT affected by an ACL edit.
      const res = await removePrincipalFromPathAcl(scopeRef, subPath, principalId);
      if (!res.removed) {
        return NextResponse.json({
          ok: true, restricted: false,
          detail: `Principal holds no explicit ACL entry on "${scopeRef}/${subPath}" — nothing to revoke. If the principal can still read it, they hold a container-level Storage RBAC role; restrict at the ADLS container scope instead.`,
          aclConfirmed: true, armConfirmed: false, revokedRoleNames: [], revokedRoleAssignmentIds: [],
        });
      }
      aclConfirmed = res.aclConfirmed;
      revokedRoleNames.push(`acl:${res.scopesRemoved.join('+') || 'access'}`);
      note = 'ACL entry removed. A principal holding container-level Storage RBAC is unaffected by a path ACL change — restrict at the container scope to cover that.';
    } else if (scopeType === 'warehouse-schema') {
      const r = await denySchemaAccess({ principalName: principalName!, schema });
      if (r.status === 'error') {
        return NextResponse.json({ ok: false, error: `Schema DENY failed: ${(r.detail || '').slice(0, 400)}` }, { status: 502 });
      }
      if (r.status === 'pending') {
        return NextResponse.json({ ok: false, error: r.detail || 'Warehouse not configured.', code: 'warehouse_not_configured' }, { status: 503 });
      }
      executedStatement = r.statement;
      revokedRoleNames.push(`DENY SELECT ON SCHEMA::${schema}`);
      armConfirmed = false;
      note = 'DENY applied. DENY does not terminate in-flight sessions — to cut access immediately, kill the principal’s active requests/sessions on the pool.';
    } else {
      // warehouse / kql-database — replay the inverse data-plane grant for each
      // permission level so any prior read/write/admin grant is removed.
      for (const permission of ['read', 'write', 'admin'] as const) {
        await revokeStructuredGrant({
          principalId, principalName, principalType,
          scopeType, scopeRef: scopeRef || 'warehouse', permission,
        });
        revokedRoleNames.push(permission);
      }
      // No ARM read-back for SQL/ADX role membership; the revoke command is real.
      armConfirmed = false;
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Revoke failed: ${(e?.message || String(e)).slice(0, 400)}` },
      { status: 502 },
    );
  }

  // Cosmos item-permissions update (a): mark matching Access policies restricted.
  let policiesUpdated = 0;
  try {
    const c = await tenantSettingsContainer();
    const docId = `policies:${tenantId}`;
    const { resource: pdoc } = await c.item(docId, tenantId).read<any>();
    if (pdoc && Array.isArray(pdoc.items)) {
      for (const p of pdoc.items) {
        if (p.kind === 'Access' && p.principalId === principalId &&
            (p.scopeType === scopeType) &&
            (scopeType === 'warehouse' || p.scopeRef === scopeRef)) {
          p.enabled = false;
          p.dlpRestricted = true;
          p.dlpRestrictedAt = new Date().toISOString();
          if (p.enforcement) p.enforcement = { ...p.enforcement, status: 'pending', detail: 'Revoked by DLP restrict-access.' };
          policiesUpdated++;
        }
      }
      if (policiesUpdated > 0) {
        pdoc.updatedAt = new Date().toISOString();
        await c.item(docId, tenantId).replace(pdoc);
      }
    }
  } catch { /* policy doc update best-effort — meta record below is authoritative */ }

  // Cosmos item-permissions update (b): append the authoritative restriction record.
  const restriction: DlpRestriction = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    by: s.claims.upn || tenantId,
    scopeType, scopeRef: scopeRef || 'warehouse',
    ...(subPath ? { subPath } : {}),
    ...(schema ? { schema } : {}),
    ...(executedStatement ? { statement: executedStatement } : {}),
    principalId, principalName,
    revokedRoleAssignmentIds, revokedRoleNames,
    exemptPrincipalIds, armConfirmed,
    ...(aclConfirmed !== undefined ? { aclConfirmed } : {}),
  };
  try {
    const meta = await loadDlpMeta(tenantId);
    meta.restrictions.unshift(restriction);
    await saveDlpMeta(meta);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Access revoked but recording failed: ${(e?.message || String(e)).slice(0, 200)}`, restriction },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    restricted: true,
    armConfirmed,
    aclConfirmed,
    revokedRoleNames,
    revokedRoleAssignmentIds,
    policiesUpdated,
    note,
    restriction,
  });
}

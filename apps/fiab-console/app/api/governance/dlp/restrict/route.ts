/**
 * POST /api/governance/dlp/restrict
 *
 * DLP restrict-access propagation. Revokes REAL data-plane access for a
 * non-exempt principal on a data scope, then records the action in Cosmos.
 *
 * Body:
 *   {
 *     scopeType: 'adls-container' | 'warehouse' | 'kql-database',
 *     scopeRef:  string,                 // container name / kql db / 'warehouse'
 *     principalId: string,               // Entra object id to restrict
 *     principalName?: string,            // UPN / display name (needed for SQL/ADX)
 *     exemptPrincipalIds?: string[]      // never-restrict list
 *   }
 *
 * For adls-container scopes the route:
 *   1. Reads the container's current Storage data-plane role assignments (ARM).
 *   2. Revokes every assignment held by the target principal (real ARM DELETE).
 *   3. Re-reads assignments (ARM) to CONFIRM the principal no longer holds any.
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
import { listContainerRoleAssignments, revokeContainerRoleAssignment } from '@/lib/azure/adls-client';
import { revokeStructuredGrant, type PrincipalType } from '@/lib/azure/access-policy-client';
import { loadDlpMeta, saveDlpMeta, type DlpRestriction } from '../_lib/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ScopeType = 'adls-container' | 'warehouse' | 'kql-database';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const scopeType = String(body?.scopeType || '') as ScopeType;
  const scopeRef = String(body?.scopeRef || '').trim();
  const principalId = String(body?.principalId || '').trim();
  const principalName = body?.principalName ? String(body.principalName) : undefined;
  const principalType = (['User', 'Group', 'ServicePrincipal'].includes(body?.principalType)
    ? body.principalType : 'User') as PrincipalType;
  const exemptPrincipalIds: string[] = Array.isArray(body?.exemptPrincipalIds)
    ? body.exemptPrincipalIds.map((x: unknown) => String(x)) : [];

  if (!['adls-container', 'warehouse', 'kql-database'].includes(scopeType)) {
    return NextResponse.json({ ok: false, error: 'scopeType must be adls-container | warehouse | kql-database' }, { status: 400 });
  }
  if (!principalId) return NextResponse.json({ ok: false, error: 'principalId is required' }, { status: 400 });
  if (scopeType !== 'warehouse' && !scopeRef) {
    return NextResponse.json({ ok: false, error: 'scopeRef is required' }, { status: 400 });
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
    principalId, principalName,
    revokedRoleAssignmentIds, revokedRoleNames,
    exemptPrincipalIds, armConfirmed,
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
    revokedRoleNames,
    revokedRoleAssignmentIds,
    policiesUpdated,
    restriction,
  });
}

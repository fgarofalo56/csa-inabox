/**
 * POST /api/access-governance/group-sync — reconcile Entra group-targeted access
 * packages (access-governance W4, AG-8/AG-9).
 *
 * For every ENABLED package with `groupTargets`, reads each target group's LIVE
 * transitive members from Microsoft Graph (READ-ONLY — Loom never mutates tenant
 * groups) and reconciles against the `group:<groupId>` rows already in the
 * entitlement ledger, per grant in the package:
 *   • member joined  → enforceAccessGrant + record a `group:<id>` ledger row
 *   • member left    → revokeAssignment (real ARM/data-plane revoke + ledger)
 *
 * OPT-IN (the sole day-one gate the PRP allows): group sync runs only when
 * LOOM_GRAPH_GROUP_SYNC_ENABLED=true AND the Console UAMI has Graph
 * Group.Read.All + GroupMember.Read.All. Absent either, the route returns an
 * honest gate naming the exact flag + grants (registered in the gate registry as
 * `graph-group-sync`); the rest of access-governance stays day-one-ON. Real
 * backends only — no mock members.
 *
 * Auth mirrors the expiry sweep: system token (timer Function) OR tenant admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessPackagesContainer, accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers, getGroupsByIds } from '@/lib/azure/graph-identity-client';
import { enforceAccessGrant, type AccessScopeType, type AccessPermission } from '@/lib/azure/access-policy-client';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { diffGroupMembership, type GroupMember } from '@/lib/access/group-sync';
import type { AccessPackage, PackageGrant } from '@/lib/types/access-package';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { inferScopeType } from '@/lib/types/access-request-workflow';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Opt-in flag for AG-8/AG-9 (default off → honest gate, everything else stays ON). */
export function groupSyncEnabled(): boolean {
  return (process.env.LOOM_GRAPH_GROUP_SYNC_ENABLED || '').trim().toLowerCase() === 'true';
}

const GATE = {
  gate: 'graph-group-sync',
  error: 'graph_group_sync_not_configured',
  remediation:
    'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph ' +
    'Group.Read.All + GroupMember.Read.All (application, admin-consented) via ' +
    'scripts/csa-loom/grant-identity-graph-approles.sh. Until then, group-targeted ' +
    'packages still install and are requestable directly — only the automatic ' +
    'membership→grant reconcile is gated. Bicep: identity-graph-rbac.bicep.',
};

const SCOPE_TYPES = new Set<AccessScopeType>(['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection']);
function toScopeType(rt: string): AccessScopeType {
  return SCOPE_TYPES.has(rt as AccessScopeType) ? (rt as AccessScopeType) : (inferScopeType(rt) as AccessScopeType);
}

export async function POST(req: NextRequest) {
  const sysToken = req.headers.get('x-loom-system-token');
  const sysOk = !!sysToken && !!process.env.LOOM_SWEEPER_TOKEN && sysToken === process.env.LOOM_SWEEPER_TOKEN;
  const session = getSession();
  if (!sysOk) { const gate = requireTenantAdmin(session); if (gate) return gate; }

  if (!groupSyncEnabled()) {
    return NextResponse.json({ ok: false, gated: true, ...GATE }, { status: 200 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const by = sysOk ? 'system:group-sync' : (session?.claims.upn || session?.claims.oid || 'admin');

  try {
    const pkgC = await accessPackagesContainer();
    const { resources: pkgs } = await pkgC.items
      .query<AccessPackage>({ query: 'SELECT * FROM c WHERE c.enabled = true AND IS_DEFINED(c.groupTargets) AND ARRAY_LENGTH(c.groupTargets) > 0' })
      .fetchAll();
    if (!pkgs || pkgs.length === 0) {
      return NextResponse.json({ ok: true, groupTargetedPackages: 0, granted: 0, revoked: 0, note: 'No group-targeted packages to reconcile.' });
    }

    const ledger = await accessAssignmentsContainer();
    const groupNames = new Map<string, string>();
    let granted = 0, revoked = 0; const warnings: string[] = []; const plan: any[] = [];

    for (const pkg of pkgs) {
      for (const groupId of pkg.groupTargets || []) {
        // LIVE group membership (Graph read-only). A Graph failure is an honest
        // gate — surface it rather than silently reconcile against nothing.
        let members: GroupMember[];
        try {
          const hits = await getGroupTransitiveMembers(groupId, 500);
          members = hits.map((m) => ({ id: m.id, upn: m.upn || m.mail || m.displayName, type: m.type === 'group' ? 'Group' : m.type === 'spn' ? 'ServicePrincipal' : 'User' }));
          if (!groupNames.has(groupId)) {
            const g = (await getGroupsByIds([groupId]))[0];
            if (g) groupNames.set(groupId, g.displayName);
          }
        } catch (e: any) {
          if (e?.name === 'GraphIdentityNotConfiguredError') {
            return NextResponse.json({ ok: false, gated: true, ...GATE }, { status: 200 });
          }
          warnings.push(`group ${groupId}: ${e?.message || e}`);
          continue;
        }
        const source = `group:${groupId}` as const;
        for (const grant of pkg.grants as PackageGrant[]) {
          const { resources: existing } = await ledger.items
            .query<AccessAssignment>({
              query: 'SELECT * FROM c WHERE c.source = @s AND c.resourceRef = @r',
              parameters: [{ name: '@s', value: source }, { name: '@r', value: grant.resourceRef }],
            })
            .fetchAll();
          const delta = diffGroupMembership(members, existing || []);
          if (dryRun) {
            plan.push({ packageId: pkg.id, groupId, resourceRef: grant.resourceRef, toGrant: delta.toGrant.length, toRevoke: delta.toRevoke.length });
            continue;
          }
          const scopeType = toScopeType(grant.resourceType);
          const permission = (grant.permission as AccessPermission) || 'read';
          // Joiners → real grant + ledger row.
          for (const m of delta.toGrant) {
            try {
              const res = await enforceAccessGrant({ principalId: m.id, principalName: m.upn, principalType: m.type, scopeType, scopeRef: grant.resourceRef, permission });
              if (res.status === 'active') {
                await recordAssignment({
                  principalId: m.id, principalUpn: m.upn, principalType: m.type,
                  tenantId: pkg.tenantId, resourceType: grant.resourceType, resourceRef: grant.resourceRef, resourceName: grant.resourceName,
                  role: res.roleName || grant.role, permission, source, sourceRef: pkg.id, grantedBy: by, roleAssignmentId: res.roleAssignmentId,
                });
                granted++;
              } else if (res.status === 'error') {
                warnings.push(`grant ${m.id}@${grant.resourceRef}: ${res.detail || 'error'}`);
              }
            } catch (e: any) { warnings.push(`grant ${m.id}@${grant.resourceRef}: ${e?.message || e}`); }
          }
          // Leavers → real revoke.
          for (const a of delta.toRevoke) {
            const r = await revokeAssignment(a, by);
            if (r.revoked) revoked++;
            warnings.push(...r.warnings);
          }
        }
      }
    }

    if (dryRun) return NextResponse.json({ ok: true, dryRun: true, groupTargetedPackages: pkgs.length, plan });

    if (granted || revoked) {
      const al = await auditLogContainer();
      await al.items.create({ id: crypto.randomUUID(), itemId: 'group-sync', itemType: 'access-governance', action: 'group-sync', summary: `Group sync reconciled ${pkgs.length} package(s): ${granted} granted, ${revoked} revoked.`, upn: by, at: new Date().toISOString() });
    }
    return NextResponse.json({ ok: true, groupTargetedPackages: pkgs.length, granted, revoked, ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}), by });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * POST /api/access-governance/backfill — seed the entitlement ledger from the
 * grants that already exist, so the who-has-access report isn't empty on day one
 * (access-governance Wave-1). Tenant-admin only.
 *
 * Sources swept (real data, no mocks):
 *   • F16 `access-request-workflow` — status 'completed' → the provisioned grant
 *   • F15 `access-requests`         — provisionedTargets with status 'active'
 *   • `workspace-roles`             — every workspace ACL assignment
 *
 * Idempotent: recordAssignment upserts a deterministic id, so re-running the
 * backfill converges (no duplicate rows). Returns per-source counts.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  accessRequestWorkflowContainer, accessRequestsContainer, workspaceRolesContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequestDoc } from '@/lib/types/access-request-workflow';
import type { AccessRequest } from '@/lib/types/access-request';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 2000;

export async function POST() {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s!.claims.oid;

  try {
    let f16 = 0, f15 = 0, wsacl = 0;

    // F16 — completed governed-workflow grants.
    const wf = await accessRequestWorkflowContainer();
    const { resources: wfDocs } = await wf.items
      .query<AccessRequestDoc>({ query: `SELECT TOP ${CAP} * FROM c WHERE c.status = 'completed'` })
      .fetchAll();
    for (const d of wfDocs || []) {
      const ok = await recordAssignment({
        principalId: d.requesterId,
        principalUpn: d.requesterUpn,
        principalType: 'User',
        tenantId,
        resourceType: d.scopeType,
        resourceRef: d.scopeRef,
        resourceName: d.assetName,
        role: d.enforcement?.roleName || d.scopeType,
        permission: d.permission,
        source: 'direct',
        sourceRef: d.id,
        grantedBy: d.accessProviderApproval?.by,
        roleAssignmentId: d.enforcement?.roleAssignmentId,
      });
      if (ok) f16++;
    }

    // F15 — provisioned data-product targets.
    const ar = await accessRequestsContainer();
    const { resources: arDocs } = await ar.items
      .query<AccessRequest>({ query: `SELECT TOP ${CAP} * FROM c WHERE c.status = 'completed' OR c.status = 'approved'` })
      .fetchAll();
    for (const d of arDocs || []) {
      for (const t of d.provisionedTargets || []) {
        if (t.status !== 'active') continue;
        const ok = await recordAssignment({
          principalId: d.requesterId,
          principalUpn: d.requesterUpn,
          principalType: 'User',
          tenantId,
          resourceType: t.scopeType,
          resourceRef: t.scopeRef,
          resourceName: d.dataProductName,
          role: t.roleName || t.scopeType,
          source: 'data-product',
          sourceRef: d.id,
          grantedBy: d.reviewedBy,
          roleAssignmentId: t.roleAssignmentId,
        });
        if (ok) f15++;
      }
    }

    // Workspace ACLs — every role assignment.
    const wr = await workspaceRolesContainer();
    const { resources: wrDocs } = await wr.items
      .query<WorkspaceRoleAssignment>({ query: `SELECT TOP ${CAP} * FROM c` })
      .fetchAll();
    for (const w of wrDocs || []) {
      const ok = await recordAssignment({
        principalId: w.principalId,
        principalUpn: (w as any).displayName,
        principalType: w.principalType,
        tenantId,
        resourceType: 'workspace',
        resourceRef: w.workspaceId,
        resourceName: (w as any).displayName,
        role: w.role,
        source: 'workspace-acl',
        sourceRef: w.id,
        grantedBy: w.addedBy,
      });
      if (ok) wsacl++;
    }

    const seeded = f16 + f15 + wsacl;
    return NextResponse.json({
      ok: true,
      seeded,
      bySource: { direct: f16, 'data-product': f15, 'workspace-acl': wsacl },
      message: `Seeded ${seeded} assignment${seeded === 1 ? '' : 's'} into the entitlement ledger.`,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

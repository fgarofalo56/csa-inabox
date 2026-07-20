/**
 * POST /api/access-packages/[id]/request — request an access package (W2).
 *
 * Any authenticated user may request an enabled + requestable package. The route:
 *   1. resolves the governing approval plan (package policy → resource-type →
 *      default → legacy 4-tier), snapshotting it onto each request;
 *   2. evaluates separation-of-duties BIDIRECTIONALLY against the packages the
 *      requester already holds/has in-flight — a 'block' conflict returns 409, a
 *      'warn' conflict proceeds with a warning;
 *   3. creates one F16 `access-request-workflow` doc PER grant, tagged with the
 *      package id and opened at the plan's first stage — so the EXISTING approval
 *      inbox + real-RBAC final grant machinery handles each leg unchanged.
 *
 * Azure-native; no new grant primitive (reuses F16 → enforceAccessGrant).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  accessPackagesContainer, approvalPoliciesContainer, accessRequestWorkflowContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessPackage } from '@/lib/types/access-package';
import type { ApprovalPolicy } from '@/lib/types/approval-policy';
import { inferScopeType, type AccessRequestDoc } from '@/lib/types/access-request-workflow';
import type { AccessScopeType } from '@/lib/azure/access-policy-client';
import { resolveApprovalPlan, effectiveConflicts, evaluateSod } from '@/lib/access/approval-policy';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPE_TYPES = new Set<AccessScopeType>(['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection']);
function toScopeType(resourceType: string): AccessScopeType {
  return SCOPE_TYPES.has(resourceType as AccessScopeType) ? (resourceType as AccessScopeType) : inferScopeType(resourceType);
}

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const requesterId = s.claims.oid;
  const requesterUpn = s.claims.upn || s.claims.email || s.claims.oid;

  try {
    // 1) The package must exist, be enabled + requestable.
    const pkgC = await accessPackagesContainer();
    const { resources: pkgs } = await pkgC.items
      .query<AccessPackage>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
      .fetchAll();
    const pkg = pkgs[0];
    if (!pkg) return NextResponse.json({ ok: false, error: 'package not found' }, { status: 404 });
    if (!pkg.enabled || !pkg.requestable) {
      return NextResponse.json({ ok: false, error: 'this package is not requestable' }, { status: 403 });
    }

    // 2) SoD — packages the requester already holds or has in-flight.
    const wf = await accessRequestWorkflowContainer();
    const { resources: heldDocs } = await wf.items
      .query<{ packageId?: string; status: string }>({
        query: "SELECT c.packageId, c.status FROM c WHERE c.requesterId = @r AND IS_DEFINED(c.packageId) AND (c.status = 'open' OR c.status = 'completed')",
        parameters: [{ name: '@r', value: requesterId }],
      })
      .fetchAll();
    const heldPackageIds = [...new Set((heldDocs || []).map((d) => d.packageId).filter(Boolean) as string[])];
    const { resources: allPkgs } = await pkgC.items
      .query<Pick<AccessPackage, 'id' | 'sodConflictsWith'>>({ query: 'SELECT c.id, c.sodConflictsWith FROM c' })
      .fetchAll();
    const conflictIds = effectiveConflicts(id, pkg.sodConflictsWith, allPkgs || []);
    const sod = evaluateSod(conflictIds, heldPackageIds, pkg.sodMode || 'block');
    if (sod.status === 'block') {
      return NextResponse.json({
        ok: false, error: 'separation-of-duties conflict', sod,
        detail: 'You already hold a package that is incompatible with this one. An administrator can adjust the SoD rule if this is intended.',
      }, { status: 409 });
    }

    // 3) Resolve the approval plan and fan out one workflow doc per grant.
    const { resources: policies } = await approvalPoliciesContainer().then((c) =>
      c.items.query<ApprovalPolicy>({ query: 'SELECT * FROM c' }).fetchAll());
    const plan = resolveApprovalPlan(policies || [], { packageId: id });
    const firstStage = plan.stages[0];
    const now = new Date().toISOString();

    const created: { id: string; resourceRef: string }[] = [];
    for (const g of pkg.grants) {
      const doc: AccessRequestDoc = {
        id: crypto.randomUUID(),
        tenantId: requesterId,
        kind: 'access-request',
        assetId: g.resourceRef,
        assetName: g.resourceName || g.resourceRef,
        itemType: g.resourceType,
        scopeType: toScopeType(g.resourceType),
        scopeRef: g.resourceRef,
        permission: (g.permission as any) || 'read',
        justification: `Access package: ${pkg.name}`,
        requesterId,
        requesterUpn,
        requestedAt: now,
        tier: firstStage,
        status: 'open',
        packageId: pkg.id,
        packageName: pkg.name,
        approvalPolicyId: plan.policyId,
        approvalPlan: plan,
        // W3 — time-bound / PIM snapshot from the package.
        grantLifetimeDays: pkg.defaultLifetimeDays ?? null,
        activationRequired: !!pkg.activationRequired,
        activationWindowHours: pkg.activationWindowHours ?? null,
      };
      const { resource } = await wf.items.create(doc);
      created.push({ id: resource?.id || doc.id, resourceRef: g.resourceRef });
    }

    return NextResponse.json({
      ok: true,
      packageId: id,
      created: created.length,
      requests: created,
      firstStage,
      ...(sod.status === 'warn' ? { warning: 'This package conflicts with one you already hold (SoD warn); the request was allowed.', sod } : {}),
      message: `Requested "${pkg.name}" — ${created.length} approval${created.length === 1 ? '' : 's'} opened at the ${firstStage} stage.`,
    }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * Grants an access request has LANDED, and what happens to them.
 *
 * A request's grant can bind to several scopes (a data product with several
 * output ports). When some of those grants land and others do not — a
 * self-serve request routed for approval after a partial grant, or a final
 * approval that returned a mixed result — the grants that landed are real
 * role assignments. This module keeps them accountable:
 *
 *   - {@link grantResult} tags each outcome with `created`: whether this grant
 *     CREATED the assignment, or found it already in place (the grant clients
 *     say so in their `detail`, "... (idempotent)").
 *   - {@link mergeGrantResults} keeps a created grant's identity when a retry of
 *     the same scope now finds it in place, so a retry cannot erase the record
 *     of what this request created.
 *   - {@link recordLandedGrants} writes every landed grant to the entitlement
 *     ledger with its role-assignment id (`sourceRef` = the request id), so the
 *     who-has-access report shows it.
 *   - {@link revokeLandedGrants} runs on denial: it revokes the grants this
 *     request created — never access the principal already held — and marks
 *     their ledger rows revoked.
 */
import type { SessionPayload } from '@/lib/auth/session';
import type { AccessGrantResult, AccessPermission, AccessScopeType } from '@/lib/azure/access-policy-client';
import { revokeAccessGrant, revokeStructuredGrant } from '@/lib/azure/rbac-client';
import { recordAssignment, revokeAssignmentLedger } from '@/lib/access/assignment-ledger';
import type { AccessRequestGrantResult } from '@/lib/types/access-request-workflow';

/** The ledger `source` for grants made by an access request. */
export const REQUEST_GRANT_SOURCE = 'direct' as const;

/** Tag one grant outcome with its scope and whether it created the assignment. */
export function grantResult(
  r: AccessGrantResult,
  scopeType: AccessScopeType,
  scopeRef: string,
): AccessRequestGrantResult {
  const created = r.status === 'active' && !/idempotent/i.test(r.detail || '');
  return { ...r, scopeType, scopeRef, created };
}

const key = (r: { scopeType: string; scopeRef: string }) => `${r.scopeType}\u0000${r.scopeRef}`;

/**
 * `next`, except that a scope an earlier attempt of this request CREATED keeps that
 * earlier entry when the retry found the assignment already in place.
 */
export function mergeGrantResults(
  prev: AccessRequestGrantResult[] | undefined,
  next: AccessRequestGrantResult[],
): AccessRequestGrantResult[] {
  const earlier = new Map((prev || []).filter((r) => r.created).map((r) => [key(r), r]));
  return next.map((r) => {
    const was = earlier.get(key(r));
    return was && r.status === 'active' && !r.created ? was : r;
  });
}

/** The grants in `results` that are live role assignments. */
export function landedGrants(results: AccessRequestGrantResult[] | undefined): AccessRequestGrantResult[] {
  return (results || []).filter((r) => r.status === 'active');
}

export interface LandedGrantContext {
  requestId: string;
  requesterId: string;
  requesterUpn: string;
  tenantId: string;
  assetName: string;
  permission: AccessPermission;
  grantedBy: string;
  expiresAt?: string | null;
}

/** Record every landed grant in the entitlement ledger. Best-effort, like the ledger itself. */
export async function recordLandedGrants(ctx: LandedGrantContext, results: AccessRequestGrantResult[]): Promise<void> {
  for (const r of landedGrants(results)) {
    await recordAssignment({
      principalId: ctx.requesterId,
      principalUpn: ctx.requesterUpn,
      principalType: 'User',
      tenantId: ctx.tenantId,
      resourceType: r.scopeType,
      resourceRef: r.scopeRef,
      resourceName: ctx.assetName,
      role: r.roleName || r.scopeType,
      permission: ctx.permission,
      source: REQUEST_GRANT_SOURCE,
      sourceRef: ctx.requestId,
      grantedBy: ctx.grantedBy,
      roleAssignmentId: r.roleAssignmentId,
      expiresAt: ctx.expiresAt ?? null,
    });
  }
}

/**
 * Revoke the grants this request CREATED (denial). Access the principal held
 * before the request (`created: false`) is left in place. Returns the revoked
 * entries; each one's ledger row is marked revoked.
 *
 * Per scope: an ADLS grant is removed by its role-assignment id; a warehouse or
 * KQL grant by the inverse data-plane command. A scope with no revoke path (an
 * ADLS grant with no recorded id, or a Loom workspace role) is returned in
 * `kept` so the caller can say so rather than claim a revoke.
 */
export async function revokeLandedGrants(
  ctx: Pick<LandedGrantContext, 'requesterId' | 'requesterUpn' | 'permission'>,
  results: AccessRequestGrantResult[] | undefined,
  session: SessionPayload,
): Promise<{ revoked: AccessRequestGrantResult[]; kept: AccessRequestGrantResult[] }> {
  const revoked: AccessRequestGrantResult[] = [];
  const kept: AccessRequestGrantResult[] = [];
  const by = session.claims.upn || session.claims.oid;
  for (const r of landedGrants(results)) {
    if (!r.created) continue;
    if (r.scopeType === 'adls-container' && r.roleAssignmentId) {
      await revokeAccessGrant(r.roleAssignmentId);
    } else if (r.scopeType === 'warehouse' || r.scopeType === 'kql-database') {
      await revokeStructuredGrant({
        principalId: ctx.requesterId,
        principalName: ctx.requesterUpn,
        principalType: 'User',
        scopeType: r.scopeType,
        scopeRef: r.scopeRef,
        permission: ctx.permission,
      });
    } else {
      kept.push(r);
      continue;
    }
    await revokeAssignmentLedger(ctx.requesterId, r.scopeType, r.scopeRef, REQUEST_GRANT_SOURCE, by);
    revoked.push(r);
  }
  return { revoked, kept };
}

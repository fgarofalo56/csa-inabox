/**
 * Grants an access request has LANDED, and what happens to them.
 *
 * A request's grant can bind to several scopes (a data product with several
 * output ports). When some of those grants land and others do not — a
 * self-serve request routed for approval after a partial grant, or a final
 * approval that returned a mixed result — the grants that landed are real
 * role assignments. This module keeps them accountable:
 *
 *   - {@link grantResult} tags each outcome with `created`: `true` when this
 *     grant created the assignment, `false` when the principal already held it,
 *     absent when that could not be determined. The grant client reports it as
 *     `preexisting` (read from the store before granting, for warehouse and
 *     ADX); an older "(idempotent)" detail is read as `false`.
 *   - {@link mergeGrantResults} keeps a created grant's identity when a retry of
 *     the same scope now finds it in place, so a retry cannot erase the record
 *     of what this request created.
 *   - {@link recordLandedGrants} writes every landed grant to the entitlement
 *     ledger with its role-assignment id (`sourceRef` = the request id), so the
 *     who-has-access report shows it.
 *   - {@link revokeLandedGrants} runs on denial: it revokes only the grants this
 *     request created, never access the principal already held, and reports
 *     every grant it could not revoke (with the reason) instead of claiming it.
 */
import type { SessionPayload } from '@/lib/auth/session';
import type { AccessGrantResult, AccessPermission, AccessScopeType } from '@/lib/azure/access-policy-client';
import { revokeContainerRoleAssignment, revokeStructuredGrant } from '@/lib/azure/rbac-client';
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
  const { preexisting, ...rest } = r;
  let created: boolean | undefined;
  if (r.status !== 'active') created = false;
  else if (preexisting === true) created = false;
  else if (preexisting === false) created = true;
  else if (/idempotent/i.test(r.detail || '')) created = false;
  else created = undefined; // landed, but whether it existed before is unknown
  return { ...rest, scopeType, scopeRef, ...(created === undefined ? {} : { created }) };
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
  const earlier = new Map((prev || []).filter((r) => r.created === true).map((r) => [key(r), r]));
  return next.map((r) => {
    const was = earlier.get(key(r));
    return was && r.status === 'active' && r.created !== true ? was : r;
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

/** A role-assignment DELETE that answered "not found" already has the outcome a revoke wants. */
const ALREADY_GONE = /\b404\b|NotFound|RoleAssignmentNotFound/i;

/**
 * Revoke the grants this request CREATED (denial).
 *
 *   created: true   → revoked (ADLS by role-assignment id, warehouse / KQL by
 *                     the inverse data-plane command); its ledger row is marked
 *                     revoked. A revoke that fails is returned in `kept` with
 *                     the error, and its ledger row is left active.
 *   created: false  → the principal held it before the request: left alone.
 *   created unknown → left in place and returned in `kept`, because revoking
 *                     it could remove access held before the request.
 *
 * A grant with no revoke path is returned in `kept` with that reason, checked
 * before whether it was created: an ADLS grant with no recorded role-assignment
 * id, or a scope this module has no revoke for (a Loom workspace role, an ADLS
 * path). Never throws.
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
    if (r.created === false) continue;
    const noPath = noRevokePath(r);
    if (noPath) {
      kept.push({ ...r, detail: noPath });
      continue;
    }
    if (r.created !== true) {
      kept.push({ ...r, detail: 'Could not determine whether the requester held this role before the request, so it was left in place.' });
      continue;
    }
    let failure: string | undefined;
    if (r.scopeType === 'adls-container') {
      try {
        await revokeContainerRoleAssignment(r.roleAssignmentId!);
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 300);
        if (!ALREADY_GONE.test(msg)) failure = msg;
      }
    } else {
      const out = await revokeStructuredGrant({
        principalId: ctx.requesterId,
        principalName: ctx.requesterUpn,
        principalType: 'User',
        scopeType: r.scopeType,
        scopeRef: r.scopeRef,
        permission: ctx.permission,
      });
      if (out.status !== 'revoked') failure = out.detail || `revoke ${out.status}`;
    }
    if (failure) {
      kept.push({ ...r, detail: `Revoke failed: ${failure}` });
      continue;
    }
    await revokeAssignmentLedger(ctx.requesterId, r.scopeType, r.scopeRef, REQUEST_GRANT_SOURCE, by);
    revoked.push(r);
  }
  return { revoked, kept };
}

/** Why `r` cannot be revoked automatically, or undefined when it can. */
function noRevokePath(r: AccessRequestGrantResult): string | undefined {
  if (r.scopeType === 'adls-container') {
    return r.roleAssignmentId
      ? undefined
      : 'No role-assignment id was recorded for this grant, so it could not be revoked automatically.';
  }
  if (r.scopeType === 'warehouse' || r.scopeType === 'kql-database') return undefined;
  return `No automatic revoke exists for ${r.scopeType} grants, so it was left in place.`;
}

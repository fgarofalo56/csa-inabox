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
 *   - {@link revokeLandedGrants} revokes the grants it is given — on denial,
 *     and when a final approval stops after granting, the created rows of the
 *     request's grant ledger (lib/access/grant-intents.ts): it revokes
 *     only the grants the request created, never access the principal already
 *     held, and reports every grant it could not revoke (with the reason)
 *     instead of claiming it.
 */
import type { SessionPayload } from '@/lib/auth/session';
import type { AccessGrantResult, AccessPermission, AccessScopeType } from '@/lib/azure/access-policy-client';
import { revokeContainerRoleAssignment, revokeStructuredGrant } from '@/lib/azure/rbac-client';
import { assignmentId, recordAssignment, revokeAssignmentLedger } from '@/lib/access/assignment-ledger';
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

/** The entitlement-ledger id of the row a request's grant on `r` is recorded under. */
export function grantLedgerId(requesterId: string, r: { scopeType: string; scopeRef: string }): string {
  return assignmentId(requesterId, r.scopeType, r.scopeRef, REQUEST_GRANT_SOURCE);
}

/** One landed grant and whether its ledger row was written. */
export interface LedgerRecord {
  scopeType: string;
  scopeRef: string;
  ledgerId: string;
  recorded: boolean;
}

/**
 * Record every landed grant in the entitlement ledger. Best-effort, like the
 * ledger itself: a row that could not be written is returned with
 * `recorded: false`, so a caller never says a grant is in the Access report
 * when it is not.
 */
export async function recordLandedGrants(ctx: LandedGrantContext, results: AccessRequestGrantResult[]): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for (const r of landedGrants(results)) {
    const recorded = await recordAssignment({
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
    out.push({ scopeType: r.scopeType, scopeRef: r.scopeRef, ledgerId: grantLedgerId(ctx.requesterId, r), recorded });
  }
  return out;
}

/**
 * A role-assignment DELETE that ARM answered 404 already has the outcome a
 * revoke wants. Classified on the HTTP status `armCall` records, never on the
 * message: ARM's message quotes the scope, so a 403 over a container named
 * `archive-404` must not read as "already gone".
 */
const alreadyGone = (e: any) => e?.status === 404;

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
 *
 * `opts.beforeEach` runs before every revoke attempt after the first (the
 * caller renews its per-request lease there). When it returns false the loop
 * stops: `aborted` is true and the created grants not yet attempted are in
 * `notAttempted` (still live, ledger rows untouched).
 */
export async function revokeLandedGrants(
  ctx: Pick<LandedGrantContext, 'requesterId' | 'requesterUpn' | 'permission'>,
  results: AccessRequestGrantResult[] | undefined,
  session: SessionPayload,
  opts?: { beforeEach?: () => Promise<boolean> },
): Promise<{
  revoked: AccessRequestGrantResult[];
  kept: AccessRequestGrantResult[];
  notAttempted: AccessRequestGrantResult[];
  aborted: boolean;
}> {
  const revoked: AccessRequestGrantResult[] = [];
  const kept: AccessRequestGrantResult[] = [];
  const notAttempted: AccessRequestGrantResult[] = [];
  let aborted = false;
  let attempted = false;
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
    if (!aborted && attempted && opts?.beforeEach && !(await opts.beforeEach())) aborted = true;
    if (aborted) {
      notAttempted.push(r);
      continue;
    }
    attempted = true;
    let failure: string | undefined;
    if (r.scopeType === 'adls-container') {
      try {
        await revokeContainerRoleAssignment(r.roleAssignmentId!);
      } catch (e: any) {
        if (!alreadyGone(e)) failure = (e?.message || String(e)).slice(0, 300);
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
  return { revoked, kept, notAttempted, aborted };
}

const keptList = (kept: AccessRequestGrantResult[]) =>
  kept.map((r) => `${r.scopeType} ${r.scopeRef} (${r.detail || 'no reason recorded'})`).join('; ');

/**
 * What an approver is told about grants left in place. The Access report is
 * named only when every kept grant's ledger row is known to be written (`ledger`
 * given and each row `recorded`), and offered as a place to act only to a
 * tenant admin, who is the one who can open it.
 */
export function keptTail(kept: AccessRequestGrantResult[], admin: boolean, requesterId: string, ledger?: LedgerRecord[]): string {
  if (!kept.length) return '';
  const allRecorded = !!ledger && kept.every((r) => ledger.some((l) => l.ledgerId === grantLedgerId(requesterId, r) && l.recorded));
  const where = allRecorded
    ? (admin ? ' They are recorded in the Access report; review them there.' : ' They are recorded in the Access report; a tenant admin can review and remove the kept grants.')
    : (admin ? ' Review them in the Access report.' : ' A tenant admin can review and remove the kept grants.');
  return ` ${kept.length} grant(s) were not removed and remain in place: ${keptList(kept)}.${where}`;
}

/**
 * The warning a recorded denial carries for grants it did not revoke. The
 * Access report is offered only to a tenant admin, who is the one who can open it.
 */
export function denialKeptWarning(kept: AccessRequestGrantResult[], admin: boolean): string {
  return `${kept.length} grant(s) made for this request were not revoked and remain in place: ${keptList(kept)}`
    + (admin ? '. Review them in the Access report.' : '. A tenant admin can review and remove the kept grants.');
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

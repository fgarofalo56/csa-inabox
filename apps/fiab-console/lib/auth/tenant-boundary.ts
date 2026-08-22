/**
 * THE CROSS-TENANT ("tid boundary") COMPARISON — one implementation.
 *
 * #3843 / #3840 / #3834 — every private copy of this decision that has shipped
 * became a cross-tenant hole, and they all had the SAME shape:
 *
 *     if (callerTid && docTid && docTid !== callerTid) { …refuse… }
 *
 * That is a NON-CONTRADICTION test, not a match: it decides NOTHING when either
 * side is absent and falls through to whatever grant sits below it. Both
 * absences are documented, supported states in this product — a workspace doc
 * created before rel-T11 carries no `tid` (`lib/types/workspace.ts`), and
 * `UserClaims.tid` is optional by design (`lib/auth/msal.ts`, `lib/auth/pat.ts`).
 * So the shape reads as enforced and is not, which is why it produced #3823
 * (the resolver's admin bypass), #3825 (the guards' admin short-circuit),
 * #3840 (`workspace-role.ts`) and #3843 (`items/by-type`).
 *
 * WHAT THIS MODULE IS FOR, AND WHAT IT IS NOT. The canonical answer to "may this
 * caller touch this workspace" is `resolveWorkspaceAccessByOid`
 * (`lib/auth/workspace-access.ts`), and every authorizer delegates to it —
 * that is #3825 and `scripts/ci/check-tid-boundary-chokepoint.mjs` section 8
 * enforces it. This module is one level below that: the tenant COMPARISON
 * itself, for the small number of sites that legitimately hold a caller tid and
 * a resource tid and must decide between them WITHOUT a full access resolution
 * (a batch admin sweep that cannot afford one round-trip per workspace, or a
 * second, older ACL the resolver cannot see).
 *
 * It takes no session, no oid, no document and no workspace id, precisely so it
 * cannot become a fourth place that decides access. It answers one question
 * about two strings.
 *
 * THE DEFAULT IS `unconfirmed`, AND `unconfirmed` IS NOT A GRANT. Callers that
 * are about to make a TENANT-WIDE grant (the admin-open bypass, an admin sweep)
 * must require {@link sameTenantConfirmed} — a POSITIVE match — exactly as the
 * repaired `resolveWorkspaceAccessByOid` step 6 does. An absent tid on either
 * side is then a refusal, never a fall-through.
 *
 * Guarded by `scripts/ci/check-tid-boundary-chokepoint.mjs` section 10, which
 * fails the build on a tid comparison written anywhere else in the console
 * without a pinned, reasoned exemption.
 */

/**
 * The three genuinely-different answers a tenant comparison can produce.
 *
 * Deliberately the same vocabulary as `GraphMembership`
 * (`lib/azure/workspace-roles-client.ts`): a value Loom never established is
 * SAYABLE rather than silently collapsed into a negative — or, far worse here,
 * into a fall-through. Per `deploy-integrity.md` R7 an answer must not state as
 * fact something it did not establish, and "these two tenants do not conflict"
 * is not "these two tenants are the same".
 */
export type TenantMatch =
  /** Both tids are known AND equal. The only value that may support a grant. */
  | 'same-tenant'
  /** Both tids are known AND different. A measured refusal. */
  | 'different-tenant'
  /** At least one side is absent. Loom KNOWS NOTHING — never a grant. */
  | 'unconfirmed';

/** Normalise a tid for comparison: Entra ids are case-insensitive GUIDs. */
function normalizeTid(tid: string | null | undefined): string | null {
  const t = (tid ?? '').trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * Classify a caller tenant against a resource tenant.
 *
 * This is THE comparison. Every other site asks it rather than re-writing it.
 *
 * The two locals are named `*Tid` DELIBERATELY: section 10 of
 * `scripts/ci/check-tid-boundary-chokepoint.mjs` finds tenant comparisons by
 * operand name, so naming them `caller` / `resource` would make the one
 * implementation of this boundary the ONE the guard cannot see — and its
 * deletion a silent green build. They are pinned there by expression text.
 */
export function classifyTenantMatch(
  callerTid: string | null | undefined,
  resourceTid: string | null | undefined,
): TenantMatch {
  const callerNormTid = normalizeTid(callerTid);
  const resourceNormTid = normalizeTid(resourceTid);
  if (callerNormTid === null || resourceNormTid === null) return 'unconfirmed';
  return callerNormTid === resourceNormTid ? 'same-tenant' : 'different-tenant';
}

/**
 * TRUE only when Loom POSITIVELY established that the resource is in the
 * caller's own Entra tenant.
 *
 * FAILS CLOSED on `unconfirmed`. This is the predicate a grant is allowed to
 * depend on; there is deliberately no `notDifferentTenant()` counterpart,
 * because that predicate — the truthiness-guarded shape — is the defect this
 * module exists to delete. A caller that wants the lenient reading has to write
 * `classifyTenantMatch(...) !== 'different-tenant'` in full, which is greppable,
 * is caught by section 10 of the chokepoint guard, and has to be argued for.
 */
export function sameTenantConfirmed(
  callerTid: string | null | undefined,
  resourceTid: string | null | undefined,
): boolean {
  return classifyTenantMatch(callerTid, resourceTid) === 'same-tenant';
}

/**
 * WHY a tenancy could not be confirmed, in terms of what was actually observed —
 * for logs and for honest user-facing refusals (R7). Returns null for
 * `same-tenant` (nothing to explain) and for `different-tenant` (a measured
 * refusal, which the caller reports in its own words rather than leaking which
 * other tenant owns the resource).
 */
export function tenantUnconfirmedCause(
  callerTid: string | null | undefined,
  resourceTid: string | null | undefined,
): string | null {
  if (classifyTenantMatch(callerTid, resourceTid) !== 'unconfirmed') return null;
  const missing: string[] = [];
  if (normalizeTid(callerTid) === null) missing.push('the caller session carries no `tid` claim');
  if (normalizeTid(resourceTid) === null) missing.push('the record does not state which Entra tenant it belongs to');
  return missing.join('; and ');
}

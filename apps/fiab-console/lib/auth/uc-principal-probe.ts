/**
 * LU-4 (remediation) — "is this principal the caller?" for the Unity Catalog
 * access-review query.
 *
 * `GET …/unity-catalog/grants?effective=true&principal=<x>` resolves `<x>`'s
 * transitive Entra group membership through the Console UAMI's Graph app role.
 * Left ungated that is a directory-membership oracle: any signed-in user could
 * ask "which groups is the CFO in?" and get an answer the platform identity was
 * trusted with, not the caller. So the probe is restricted to:
 *
 *   • tenant admins (the access-review audience), or
 *   • the caller asking about ITSELF ("what can *I* do here?"), which reveals
 *     only what that user could already discover about their own account.
 *
 * The comparison is deliberately narrow — `oid`, `upn`, `email` only. NOT
 * `name`: a display name is neither unique nor controlled by the directory
 * boundary, and matching on it would let "Ada Lovelace" probe a *group* called
 * "Ada Lovelace".
 *
 * Pure: no I/O, no env, no Cosmos — so both the allow and the DENY case are
 * cheaply unit-testable.
 */
import type { SessionPayload } from '@/lib/auth/session';

/** Case-insensitive, whitespace-trimmed identity compare. */
function sameIdentity(a: string, b: string): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  return !!x && x === y;
}

/**
 * True when `principal` names the session's own account. Matches the Entra
 * object id, the UPN and the mail claim — the three spellings a Unity Catalog
 * grant can legitimately be keyed on for a *user*.
 */
export function isSelfPrincipal(session: SessionPayload, principal: string): boolean {
  const p = (principal || '').trim();
  if (!p) return false;
  const c = session.claims;
  return sameIdentity(p, c.oid) || sameIdentity(p, c.upn) || sameIdentity(p, c.email || '');
}

export interface PrincipalProbeDecision {
  allowed: boolean;
  /** Why it was allowed — 'self' or 'tenant-admin'. Absent when denied. */
  basis?: 'self' | 'tenant-admin';
  /** Operator-facing denial text (the 403 body). Absent when allowed. */
  reason?: string;
  remediation?: string;
}

/**
 * Decide whether `session` may resolve effective permissions FOR `principal`.
 *
 * @param isAdmin the caller's tenant-admin standing, injected so this module
 *                stays pure (the route passes `isTenantAdmin(session)`).
 */
export function decidePrincipalProbe(
  session: SessionPayload,
  principal: string,
  isAdmin: boolean,
): PrincipalProbeDecision {
  if (isAdmin) return { allowed: true, basis: 'tenant-admin' };
  if (isSelfPrincipal(session, principal)) return { allowed: true, basis: 'self' };
  return {
    allowed: false,
    reason:
      `Resolving effective permissions for "${principal}" reads that principal's transitive Entra ` +
      'group membership using the Console platform identity, so it is restricted to tenant admins. ' +
      'You can still ask what YOU can do here, and you can still list the grants recorded on this ' +
      'securable.',
    remediation:
      'Query your own account (your UPN or object id), or ask a tenant admin to run the review. ' +
      'Tenant admins are LOOM_TENANT_ADMIN_OID / members of LOOM_TENANT_ADMIN_GROUP_ID; access can ' +
      'also be granted at /admin/permissions.',
  };
}

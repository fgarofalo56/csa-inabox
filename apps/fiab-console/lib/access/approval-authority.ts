/**
 * F16 APPROVAL AUTHORITY — who may see, and who may action, the access-request
 * inbox.
 *
 * WHY THIS EXISTS. The `access-request-workflow` container is partitioned by
 * `/tenantId`, and until the tenantScopeId() adoption that field carried the
 * REQUESTER's Entra `oid` while both readers keyed on the SIGNED-IN user's
 * `oid`. The arithmetic consequence: the only rows you could ever read were the
 * ones you had written yourself. That silently did two things —
 *
 *   1. it made cross-user approval IMPOSSIBLE (an approver's inbox was empty and
 *      a decision POST 404'd before any approver logic ran), and
 *   2. it was the ONLY thing standing between an authenticated user and the
 *      approve button, because `actorMayApprove` returns `allowed: true`
 *      whenever the governing plan does not `enforceApprovers` — which is the
 *      default plan.
 *
 * Widening the partition to the tenant fixes (1) and REMOVES the accident that
 * was covering (2). This module supplies the real boundary that has to take its
 * place, so the fix cannot land as a privilege escalation.
 *
 * The boundary, stated plainly:
 *
 *   MAY REVIEW  (see the tenant inbox, and act subject to the checks below)
 *     • a tenant admin, OR
 *     • a holder of the `governance.access-approvals` capability
 *       (Contributor+), delegable at /admin/permissions, OR
 *     • a principal (user, or a group in the caller's token) named as an
 *       approver on any stage of any ENABLED approval policy.
 *
 *   MAY ACT on a specific request — all of the above AND
 *     • the caller is NOT the requester (separation of duties, always), AND
 *     • `actorMayApprove` passes for that request's stage (named-approver
 *       enforcement when the policy asks for it).
 *
 * Everyone else gets a 403 that says which of those it is and how to obtain
 * access — never a silent empty list. Per deploy-integrity R7, when the policy
 * lookup itself fails we deny but say we could NOT DETERMINE authority; we do
 * not claim the caller is not an approver, because we did not establish that.
 */
import type { SessionPayload } from '@/lib/auth/session';
import { NextResponse } from 'next/server';
import { isTenantAdmin, checkCapability } from '@/lib/auth/feature-gate';
import { approvalPoliciesContainer } from '@/lib/azure/cosmos-client';
import { tenantScopeId } from '@/lib/auth/session';
import type { ApprovalPolicy } from '@/lib/types/approval-policy';

/** The delegable capability that grants access-request review rights. */
export const ACCESS_APPROVALS_CAPABILITY = 'governance.access-approvals';

export type AuthorityVia = 'tenant-admin' | 'capability' | 'named-approver';

export interface ApprovalAuthority {
  allowed: boolean;
  via?: AuthorityVia;
  /** Why not — true to what was actually established (R7). */
  reason?: string;
  /** Concrete next action for the caller (R6). */
  remediation?: string;
  /**
   * True when the decision is a DENY we could not fully evaluate (e.g. the
   * approval-policy lookup failed). Callers must not render this as "you are
   * not an approver"; it is "we could not determine".
   */
  indeterminate?: boolean;
}

const REMEDIATION =
  'Ask a tenant admin to grant your account (or a group you belong to) the ' +
  "Contributor role on 'Access approvals' at /admin/permissions, or to name you " +
  'as an approver on an approval-policy stage at /governance/approval-policies.';

/**
 * Is the caller named as an approver on ANY enabled approval policy?
 *
 * Group bindings match against the caller's `groups` claim. This is what lets a
 * delegated approver reach their inbox without also holding a capability grant.
 */
async function isNamedApproverAnywhere(
  session: SessionPayload,
): Promise<{ named: boolean; error?: string }> {
  const principals = new Set<string>([session.claims.oid, ...(session.claims.groups || [])]);
  const tenantId = tenantScopeId(session);
  try {
    const c = await approvalPoliciesContainer();
    const { resources } = await c.items
      .query<ApprovalPolicy>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      })
      .fetchAll();
    for (const p of resources || []) {
      if (!p.enabled) continue;
      for (const st of p.stages || []) {
        for (const a of st.approvers || []) {
          if (principals.has(a.id)) return { named: true };
        }
      }
    }
    return { named: false };
  } catch (e: any) {
    return { named: false, error: e?.message || String(e) };
  }
}

/**
 * May this session READ the tenant-wide access-request inbox (and be considered
 * for acting on rows in it)?
 */
export async function resolveApprovalAuthority(
  session: SessionPayload,
): Promise<ApprovalAuthority> {
  if (isTenantAdmin(session)) return { allowed: true, via: 'tenant-admin' };

  const cap = await checkCapability(session, ACCESS_APPROVALS_CAPABILITY, 'Contributor');
  if (cap.allow) return { allowed: true, via: 'capability' };

  const named = await isNamedApproverAnywhere(session);
  if (named.named) return { allowed: true, via: 'named-approver' };

  if (named.error) {
    // We could not read the policies, so we did NOT establish that the caller
    // is not an approver. Deny (fail closed) but say exactly that.
    return {
      allowed: false,
      indeterminate: true,
      reason:
        'Could not determine your approval authority: the approval-policy lookup ' +
        `failed (${named.error}). Access was denied because this check fails closed, ` +
        'not because you were found to lack authority.',
      remediation:
        'Retry. If this persists the approval-policies Cosmos container is ' +
        'unreachable — check /admin/readiness. ' + REMEDIATION,
    };
  }

  return {
    allowed: false,
    reason:
      'You are not a tenant admin, hold no Access approvals capability grant, and ' +
      'are named as an approver on no enabled approval policy.',
    remediation: REMEDIATION,
  };
}

/**
 * The canonical 403 for a caller without approval authority. Shared by the
 * `withApprovalAuthority` wrapper and the decision route so both emit
 * byte-identical envelopes, and so the UI has one shape to render.
 */
export function approvalAuthorityDenied(authority: ApprovalAuthority): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      code: authority.indeterminate ? 'authority_indeterminate' : 'not_an_approver',
      capability: ACCESS_APPROVALS_CAPABILITY,
      reason: authority.reason,
      remediation: authority.remediation,
    },
    { status: 403 },
  );
}

/**
 * May this session ACT on THIS request? Layered on top of
 * {@link resolveApprovalAuthority}: separation of duties is absolute — a
 * requester never approves their own request, tenant admin included.
 */
export function checkSelfApproval(
  session: SessionPayload,
  doc: { requesterId?: string; requesterUpn?: string },
): ApprovalAuthority {
  const isSelf =
    (!!doc.requesterId && doc.requesterId === session.claims.oid) ||
    (!!doc.requesterUpn && !!session.claims.upn &&
      doc.requesterUpn.toLowerCase() === session.claims.upn.toLowerCase());
  if (!isSelf) return { allowed: true };
  return {
    allowed: false,
    reason: 'You cannot approve or deny your own request (separation of duties).',
    remediation:
      'Another approver — a tenant admin, an Access approvals capability holder, ' +
      'or a named approver on the governing policy — must action this request.',
  };
}

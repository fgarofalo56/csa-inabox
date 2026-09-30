/**
 * POST /api/access-requests/[id]/decision — advance the F16 approval workflow.
 *
 * Body: { decision: 'approved' | 'denied', reason?: string }
 *
 * State machine (tier advances on approval; denial closes at any tier):
 *   open · manager         + approved → privacy        (open)
 *   open · privacy         + approved → approver        (open)
 *   open · approver        + approved → access-provider (open)
 *   open · access-provider + approved → enforceAccessGrant() on every scope:
 *        active  → status: completed, subscribedAt set, requester notified,
 *                  enforcement.roleAssignmentId = REAL ARM role assignment id.
 *        pending → stays at access-provider (honest infra/config gate surfaced).
 *        error   → stays at access-provider, 502 with the grant error.
 *        Every grant that lands is recorded in the entitlement ledger, on a
 *        mixed result too (lib/access/landed-grants.ts).
 *   open · ANY tier        + denied   → status: denied, deniedAt, denialReason;
 *        grants this request created on some of its scopes are revoked.
 *
 * The grant scope is derived at the final tier from the requested asset's own
 * record (lib/access/request-asset.ts) — its bound output ports, the item's
 * own store, or the item itself. If that differs from the scopes recorded when
 * the request was made (what the approvers reviewed), the approval is refused
 * with 409 `targets_changed` and the request stays open.
 * An access-package leg keeps the scope its package defines.
 *
 * Every decision writes an audit-log entry (itemId = requestId). No Fabric
 * dependency: the grant is a real Azure ARM Storage / Synapse SQL / ADX
 * data-plane assignment via lib/azure/rbac-client.
 *
 * PARTITION KEY — read this before changing the point read.
 *
 * `access-request-workflow` is partitioned by `/tenantId`, which carries
 * `tenantScopeId(session)` = `claims.tid || claims.oid` (the Entra TENANT), NOT
 * the caller's `oid`. This route actions a document a DIFFERENT user wrote, so
 * a point read keyed on the approver's `oid` misses the requester's partition
 * and 404s before any approver logic runs — which is exactly what it did until
 * this adoption.
 *
 * AUTHORIZATION — the oid-keyed partition used to confine every caller to their
 * own rows. That accident, not a check, was what stopped one user actioning
 * another's request; it also meant the only person who COULD action a request
 * was its requester (self-approval). Both are now explicit:
 *   1. approval authority   — tenant admin / capability / named approver,
 *      enforced STRUCTURALLY by the `withApprovalAuthority` wrapper so there is
 *      no returned-value gate to drop;
 *   2. separation of duties — a requester never actions their own request
 *      (needs the loaded doc, so it runs right after the point read);
 *   3. `actorMayApprove`    — per-stage named-approver enforcement (unchanged).
 *
 * Route-toolkit: withApprovalAuthority (R3).
 */
import { NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withApprovalAuthority } from '@/lib/api/route-toolkit';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/rbac-client';
import {
  TIER_APPROVAL_KEY, TIER_LABEL,
  type AccessRequestDoc, type AccessRequestEnforcement, type AccessRequestGrantResult,
  type AccessRequestGrantTarget, type ApprovalStep, type ApprovalTier,
} from '@/lib/types/access-request-workflow';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { effectiveStages, nextStage, actorMayApprove } from '@/lib/access/approval-policy';
import { checkSelfApproval } from '@/lib/access/approval-authority';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { computeExpiry } from '@/lib/access/expiry';
import { deriveRequestTargets, loadCatalogItem } from '@/lib/access/request-asset';
import {
  grantResult, mergeGrantResults, recordLandedGrants, revokeLandedGrants,
} from '@/lib/access/landed-grants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * True when the re-derived `current` scopes are the ones the approvers reviewed
 * (order-insensitive, one-to-one). A reviewed scope with an EMPTY scopeRef was
 * a store not yet bound when the request was made; it is satisfied by a current
 * scope of the same type from the same source (the same item, or the same
 * output port), which is that store as Loom has since recorded it. Every other
 * reviewed scope must reappear exactly.
 */
function reviewedMatches(current: AccessRequestGrantTarget[], reviewed: AccessRequestGrantTarget[]): boolean {
  if (current.length !== reviewed.length) return false;
  const open = [...reviewed];
  for (const t of current) {
    let i = open.findIndex((r) => !!r.scopeRef && r.scopeType === t.scopeType && r.scopeRef === t.scopeRef);
    if (i < 0) {
      i = open.findIndex((r) => !r.scopeRef && r.scopeType === t.scopeType && (r.source || '') === (t.source || ''));
    }
    if (i < 0) return false;
    open.splice(i, 1);
  }
  return true;
}

/** One enforcement summary over every per-scope grant: active only when all are. */
function summarizeGrants(results: AccessRequestGrantResult[]): AccessRequestEnforcement {
  if (results.length === 1) {
    const { scopeType: _t, scopeRef: _r, created: _c, ...only } = results[0];
    return only;
  }
  const status = results.some((r) => r.status === 'error') ? 'error'
    : results.some((r) => r.status === 'pending') ? 'pending' : 'active';
  const roles = results.map((r) => r.roleName).filter(Boolean);
  const details = results
    .filter((r) => r.status !== 'active' && r.detail)
    .map((r) => `${r.scopeType} ${r.scopeRef}: ${r.detail}`);
  return {
    status,
    ...(roles.length ? { roleName: Array.from(new Set(roles)).join(', ') } : {}),
    ...(results[0].roleAssignmentId ? { roleAssignmentId: results[0].roleAssignmentId } : {}),
    ...(details.length ? { detail: details.join(' ') } : {}),
  };
}

export const POST = withApprovalAuthority<{ id: string }>(async (req, { session: s, params }) => {
  const { id } = params;
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

  const body = await req.json().catch(() => ({} as any));
  const decision = body?.decision === 'denied' ? 'denied' : body?.decision === 'approved' ? 'approved' : null;
  if (!decision) {
    return NextResponse.json({ ok: false, error: 'decision must be "approved" or "denied"' }, { status: 400 });
  }
  const reason = String(body?.reason || '').trim().slice(0, 500);
  if (decision === 'denied' && !reason) {
    return NextResponse.json({ ok: false, error: 'a reason is required to deny a request' }, { status: 400 });
  }

  const tenantId = tenantScopeId(s);
  const now = new Date().toISOString();

  try {
    const c = await accessRequestWorkflowContainer();
    let doc: AccessRequestDoc;
    try {
      const { resource } = await c.item(id, tenantId).read<AccessRequestDoc>();
      if (!resource) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      doc = resource;
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      throw e;
    }

    if (doc.status !== 'open') {
      return NextResponse.json(
        { ok: false, error: `request is already ${doc.status} and can no longer be actioned` },
        { status: 409 },
      );
    }

    // ── Separation of duties. Absolute — it holds even for a tenant admin, so
    // it is checked here rather than folded into the wrapper's authority test.
    // It needs the loaded document (the requester's identity), which is why it
    // cannot live in `withApprovalAuthority`. Before the partition fix, a
    // self-approval was the ONLY decision that could ever succeed, because the
    // oid-keyed point read could only find the caller's own documents.
    const sod = checkSelfApproval(s, doc);
    if (!sod.allowed) {
      return NextResponse.json(
        { ok: false, error: sod.reason, code: 'self_approval_forbidden', remediation: sod.remediation },
        { status: 403 },
      );
    }

    const currentTier = doc.tier;
    // W2 — configurable approver enforcement. No-op for legacy requests and for
    // policies that don't enforce named approvers; tenant admins always pass.
    const approverCheck = actorMayApprove(doc.approvalPlan, currentTier, s.claims.oid, isTenantAdmin(s));
    if (!approverCheck.allowed) {
      return NextResponse.json({ ok: false, error: approverCheck.reason || 'You are not an approver for this stage.' }, { status: 403 });
    }
    const step: ApprovalStep = {
      decision,
      by: s.claims.upn || s.claims.oid,
      byOid: s.claims.oid,
      at: now,
      ...(reason ? { reason } : {}),
    };
    (doc as any)[TIER_APPROVAL_KEY[currentTier]] = step;

    let httpStatus = 200;
    let ok = true;
    let warning: string | undefined;

    if (decision === 'denied') {
      doc.status = 'denied';
      doc.deniedAt = now;
      doc.denialReason = reason;
      doc.deniedAtTier = currentTier;
      // Grants this request already created on some of its scopes (a partial
      // self-serve grant, or a final approval with a mixed result) are revoked
      // with the denial. Access the requester held beforehand is left alone.
      const { revoked, kept } = await revokeLandedGrants(
        { requesterId: doc.requesterId, requesterUpn: doc.requesterUpn, permission: doc.permission },
        doc.grantResults,
        s,
      );
      if (revoked.length) doc.revokedGrants = revoked;
      if (kept.length) {
        warning = `${kept.length} grant(s) made for this request were not revoked and remain in place: `
          + kept.map((r) => `${r.scopeType} ${r.scopeRef} (${r.detail || 'no reason recorded'})`).join('; ')
          + '. Review them in the Access report.';
      }
    } else {
      // W2 — advance over the request's approval-plan snapshot (an ordered subset
      // of the canonical tiers) when present; legacy requests fall back to the
      // full canonical sequence, so behaviour is identical by default.
      const stages = effectiveStages(doc.approvalPlan);
      const nxt = nextStage(stages, currentTier);
      const isFinal = nxt === null;
      if (!isFinal) {
        doc.tier = nxt;
      } else {
        // FINAL tier — the grant scope comes from the asset, never the body.
        // An access-package leg keeps the scope its package defines; every
        // other request re-derives it from the asset's current record, so the
        // grant follows what the asset is bound to at approval time.
        let targets: AccessRequestGrantTarget[];
        if (doc.packageId) {
          targets = [{ scopeType: doc.scopeType, scopeRef: doc.scopeRef }];
        } else {
          const item = await loadCatalogItem(doc.assetId);
          if (!item) {
            return NextResponse.json(
              { ok: false, error: `"${doc.assetName}" no longer exists, so there is nothing to grant. Deny the request to close it.`, code: 'asset_not_found' },
              { status: 409 },
            );
          }
          targets = (await deriveRequestTargets(item, doc.permission))
            .map((t) => ({ scopeType: t.scopeType, scopeRef: t.scopeRef, source: t.source }));
          // The approvers decided on the scopes recorded when the request was
          // made (`grantTargets`; a request recorded before those existed shows
          // its single `scopeType`/`scopeRef`). If the asset's bindings have
          // changed since, granting now would bind scopes nobody reviewed: the
          // request is refused with 409 and left open, to be denied and
          // requested again against the current bindings. A store that was not
          // bound when the request was made is not a change once it is
          // (`reviewedMatches`), and the resolved scopes are recorded below.
          const reviewed: AccessRequestGrantTarget[] = doc.grantTargets?.length
            ? doc.grantTargets
            : [{ scopeType: doc.scopeType, scopeRef: doc.scopeRef }];
          if (!reviewedMatches(targets, reviewed)) {
            return NextResponse.json(
              {
                ok: false,
                code: 'targets_changed',
                error:
                  `"${doc.assetName}" is now bound to different storage than when this request was made, so `
                  + 'approving it would grant access nobody reviewed. Deny it and ask the requester to request '
                  + 'access again.',
                reviewed: reviewed.map((t) => ({ scopeType: t.scopeType, scopeRef: t.scopeRef })),
                current: targets.map((t) => ({ scopeType: t.scopeType, scopeRef: t.scopeRef })),
              },
              { status: 409 },
            );
          }
          doc.grantTargets = targets;
        }
        doc.scopeType = targets[0].scopeType;
        doc.scopeRef = targets[0].scopeRef;
        if (doc.activationRequired) {
          // W3 (PIM) — final approval yields an ELIGIBLE assignment (no RBAC yet);
          // the requester activates it for a bounded window from the Access report.
          doc.status = 'completed';
          await recordAssignment({
            principalId: doc.requesterId,
            principalUpn: doc.requesterUpn,
            principalType: 'User',
            tenantId,
            resourceType: doc.scopeType,
            resourceRef: doc.scopeRef,
            resourceName: doc.assetName,
            role: doc.scopeType,
            permission: doc.permission,
            source: 'direct',
            sourceRef: doc.id,
            grantedBy: s.claims.upn || s.claims.oid,
            state: 'eligible',
            expiresAt: null,
            activationWindowHours: doc.activationWindowHours ?? null,
          });
          const nc = await notificationsContainer();
          await nc.items.create({
            id: crypto.randomUUID(),
            userId: doc.requesterId,
            title: `Access eligible: ${doc.assetName}`,
            body: `Your access to ${doc.assetName} is approved as ELIGIBLE. Activate it from the Access report to receive a time-bounded grant.`,
            severity: 'info',
            link: '/admin/access-report',
            read: false,
            createdAt: now,
          });
        } else {
        // Provision the REAL Azure RBAC grant on every backing scope.
        const fresh: AccessRequestGrantResult[] = [];
        for (const t of targets) {
          if (!t.scopeRef) {
            // A store not bound yet (an unbound store item, or an output port
            // naming no store of the product's workspace) — nothing to
            // bind to. Pending, never a wider (workspace) grant in its place.
            fresh.push({
              status: 'pending', scopeType: t.scopeType, scopeRef: '', created: false,
              detail: `"${doc.assetName}" has no ${t.scopeType} recorded by Loom for ${t.source || 'it'} yet. Once that storage is bound in its workspace, approve again.`,
            });
            continue;
          }
          const r = await enforceAccessGrant({
            principalId: doc.requesterId,
            principalName: doc.requesterUpn,
            principalType: 'User',
            scopeType: t.scopeType,
            scopeRef: t.scopeRef,
            permission: doc.permission,
          });
          fresh.push(grantResult(r, t.scopeType, t.scopeRef));
        }
        // A retry keeps the record of grants an earlier attempt created.
        const results = mergeGrantResults(doc.grantResults, fresh);
        const grant = summarizeGrants(results);
        doc.enforcement = grant;
        if (targets.length > 1 || doc.grantResults) doc.grantResults = results;
        const grantExpiry = grant.status === 'active'
          ? computeExpiry(new Date(now), { lifetimeDays: doc.grantLifetimeDays })
          : null;
        // Entitlement ledger (access-governance W1): every grant that LANDED is
        // recorded with its role-assignment id — on a mixed result too, so a
        // grant that landed is in the who-has-access report and a later denial
        // revokes it (lib/access/landed-grants.ts). Best-effort.
        await recordLandedGrants({
          requestId: doc.id,
          requesterId: doc.requesterId,
          requesterUpn: doc.requesterUpn,
          tenantId,
          assetName: doc.assetName,
          permission: doc.permission,
          grantedBy: s.claims.upn || s.claims.oid,
          expiresAt: grantExpiry,
        }, results);
        if (grant.status === 'active') {
          doc.status = 'completed';
          doc.subscribedAt = now;
          // Notify the requester they're now a subscriber.
          const nc = await notificationsContainer();
          await nc.items.create({
            id: crypto.randomUUID(),
            userId: doc.requesterId,
            title: `Access granted: ${doc.assetName}`,
            body:
              `Your ${doc.permission} access to ${doc.assetName} is approved and provisioned` +
              (grant.roleName ? ` (${grant.roleName})` : '') +
              (grant.roleAssignmentId ? `. Role assignment: ${grant.roleAssignmentId}` : '') + '.',
            severity: 'success',
            link: doc.itemType ? `/items/${doc.itemType}/${doc.assetId}` : null,
            read: false,
            createdAt: now,
          });
        } else {
          // pending (honest config/infra gate) or error — stay at the final tier
          // so the access provider can fix the scope/infra and retry. The step
          // is recorded but the request is NOT completed (no-vaporware).
          delete (doc as any)[TIER_APPROVAL_KEY[currentTier]];
          ok = grant.status !== 'error';
          httpStatus = grant.status === 'error' ? 502 : 200;
          warning = grant.detail;
        }
        }
      }
    }

    await c.item(id, tenantId).replace(doc);

    // Audit trail — one entry per decision (itemId = requestId).
    const al = await auditLogContainer();
    const verb = decision === 'approved' ? 'approved' : 'denied';
    await al.items.create({
      id: crypto.randomUUID(),
      itemId: id,
      itemType: 'access-request',
      action: `${verb}-by-${currentTier}`,
      summary:
        `${s.claims.upn || s.claims.oid} ${verb} access to "${doc.assetName}" at the ` +
        `${TIER_LABEL[currentTier]} tier${reason ? ` — "${reason}"` : ''}` +
        (doc.status === 'completed' && doc.enforcement?.roleAssignmentId
          ? ` · granted ${doc.enforcement.roleName} (${doc.enforcement.roleAssignmentId})`
          : ''),
      upn: s.claims.upn || s.claims.oid,
      at: now,
    });

    return NextResponse.json(
      { ok, request: doc, enforcement: doc.enforcement, ...(warning ? { warning } : {}) },
      { status: httpStatus },
    );
  } catch (e: any) {
    return apiServerError(e);
  }
});

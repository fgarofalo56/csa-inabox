/**
 * POST /api/access-requests/[id]/decision — advance the F16 approval workflow.
 *
 * Body: { decision: 'approved' | 'denied', reason?: string,
 *         scopeType?, scopeRef? }   (scope overrides only honored at final tier)
 *
 * State machine (tier advances on approval; denial closes at any tier):
 *   open · manager         + approved → privacy        (open)
 *   open · privacy         + approved → approver        (open)
 *   open · approver        + approved → access-provider (open)
 *   open · access-provider + approved → enforceAccessGrant():
 *        active  → status: completed, subscribedAt set, requester notified,
 *                  enforcement.roleAssignmentId = REAL ARM role assignment id.
 *        pending → stays at access-provider (honest infra/config gate surfaced).
 *        error   → stays at access-provider, 502 with the grant error.
 *   open · ANY tier        + denied   → status: denied, deniedAt, denialReason.
 *
 * The access provider may CONFIRM/OVERRIDE the grant scope (scopeType/scopeRef)
 * at the final tier — exactly as a real access provider binds the request to a
 * concrete backing container / database before granting.
 *
 * Every decision writes an audit-log entry (itemId = requestId). No Fabric
 * dependency: the grant is a real Azure ARM Storage / Synapse SQL / ADX
 * data-plane assignment via lib/azure/rbac-client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant, type AccessScopeType } from '@/lib/azure/rbac-client';
import {
  TIER_SEQUENCE, TIER_APPROVAL_KEY, TIER_LABEL,
  type AccessRequestDoc, type ApprovalStep, type ApprovalTier,
} from '@/lib/types/access-request-workflow';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPE_TYPES = new Set<AccessScopeType>(['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
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

  const tenantId = s.claims.oid;
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

    const currentTier = doc.tier;
    const step: ApprovalStep = {
      decision,
      by: s.claims.upn || tenantId,
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
    } else {
      const idx = TIER_SEQUENCE.indexOf(currentTier);
      const isFinal = idx === TIER_SEQUENCE.length - 1;
      if (!isFinal) {
        doc.tier = TIER_SEQUENCE[idx + 1];
      } else {
        // FINAL tier — the access provider may confirm/override the grant scope.
        if (SCOPE_TYPES.has(body?.scopeType)) doc.scopeType = body.scopeType;
        if (typeof body?.scopeRef === 'string' && body.scopeRef.trim()) {
          doc.scopeRef = String(body.scopeRef).trim().slice(0, 200);
        }
        // Provision the REAL Azure RBAC grant on the backing data store.
        const grant = await enforceAccessGrant({
          principalId: doc.requesterId,
          principalName: doc.requesterUpn,
          principalType: 'User',
          scopeType: doc.scopeType,
          scopeRef: doc.scopeRef,
          permission: doc.permission,
        });
        doc.enforcement = grant;
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
        `${s.claims.upn || tenantId} ${verb} access to "${doc.assetName}" at the ` +
        `${TIER_LABEL[currentTier]} tier${reason ? ` — "${reason}"` : ''}` +
        (doc.status === 'completed' && doc.enforcement?.roleAssignmentId
          ? ` · granted ${doc.enforcement.roleName} (${doc.enforcement.roleAssignmentId})`
          : ''),
      upn: s.claims.upn || tenantId,
      at: now,
    });

    return NextResponse.json(
      { ok, request: doc, enforcement: doc.enforcement, ...(warning ? { warning } : {}) },
      { status: httpStatus },
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

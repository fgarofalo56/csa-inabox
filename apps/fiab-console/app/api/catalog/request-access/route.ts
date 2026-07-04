/**
 * POST /api/catalog/request-access — request access to a catalog data asset.
 *
 * Records a REAL, durable access request (no-vaporware) AND a multi-tier
 * approval-workflow row (F16):
 *   1) an audit-log entry on the asset (visible to the owner in item activity),
 *   2) a confirmation notification to the requester,
 *   3) an access-request doc in the `access-request-workflow` container, opened
 *      at the MANAGER tier. Approvers advance it through manager → privacy →
 *      approver → access-provider in the Governance → Access requests inbox; the
 *      final approval provisions a real Azure RBAC grant on the backing store.
 *
 * Body: { assetId, assetName, itemType, ownerUpn?, permission, justification?,
 *         scopeType?, scopeRef? }
 * Returns: { ok, message, requestId } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  auditLogContainer, notificationsContainer, accessRequestWorkflowContainer,
} from '@/lib/azure/cosmos-client';
import { inferScopeType, type AccessRequestDoc } from '@/lib/types/access-request-workflow';
import { enforceAccessGrant, type AccessScopeType } from '@/lib/azure/access-policy-client';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERMS = new Set(['read', 'write', 'admin']);
const SCOPE_TYPES = new Set<AccessScopeType>(['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection']);
// Per-product access model the owner sets at publish time (see PublishTab):
//   governed   — multi-tier approval → real RBAC on final approval (DEFAULT)
//   self-serve — attempt an immediate real RBAC grant; fall back to governed
//   request    — record the request + notify the owner; provisioning is manual
const ACCESS_MODELS = new Set(['governed', 'self-serve', 'request']);

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const assetId = String(body?.assetId || '').trim();
  const assetName = String(body?.assetName || assetId).trim();
  const itemType = String(body?.itemType || '').trim();
  const ownerUpn = body?.ownerUpn ? String(body.ownerUpn).trim() : '';
  const permission = PERMS.has(body?.permission) ? body.permission : 'read';
  const justification = String(body?.justification || '').trim().slice(0, 1000);
  // The grant scope: explicit if the caller supplies it, else inferred from the
  // item type (lakehouse → adls-container, warehouse → Synapse SQL, etc.). The
  // backing container/db (scopeRef) can be supplied here OR confirmed by the
  // access provider at the final approval tier.
  const scopeType: AccessScopeType =
    SCOPE_TYPES.has(body?.scopeType) ? body.scopeType : inferScopeType(itemType);
  const scopeRef = String(body?.scopeRef || '').trim().slice(0, 200);
  const accessModel = ACCESS_MODELS.has(body?.accessModel) ? body.accessModel : 'governed';
  if (!assetId) return NextResponse.json({ ok: false, error: 'assetId is required' }, { status: 400 });

  const requester = s.claims.upn || s.claims.email || s.claims.oid;
  const now = new Date().toISOString();

  // Self-serve: try to provision a REAL RBAC grant immediately. Needs a concrete
  // scopeRef (the backing container/db/pool) — when present and the grant lands
  // 'active' we short-circuit. Anything else (no scopeRef, honest gate, or error)
  // falls through to the governed approval workflow so the request is never lost.
  if (accessModel === 'self-serve' && scopeRef) {
    try {
      const grant = await enforceAccessGrant({
        principalId: s.claims.oid,
        principalName: requester,
        principalType: 'User',
        scopeType,
        scopeRef,
        permission: permission as any,
      });
      if (grant.status === 'active') {
        try {
          const audit = await auditLogContainer();
          await audit.items.create({
            id: crypto.randomUUID(), itemId: assetId, itemType,
            action: 'access-granted',
            summary: `${requester} self-served ${permission} access to ${assetName} (${grant.roleName || scopeType}).`,
            upn: requester, at: now,
          });
        } catch { /* audit best-effort */ }
        return NextResponse.json({
          ok: true,
          granted: true,
          roleAssignmentId: grant.roleAssignmentId,
          message: `Self-serve access to "${assetName}" granted immediately (${grant.roleName || scopeType}).`,
        });
      }
    } catch { /* fall through to governed workflow */ }
  }

  try {
    // 1) Durable audit-log entry on the asset (owner sees it in item activity).
    const audit = await auditLogContainer();
    await audit.items.create({
      id: crypto.randomUUID(),
      itemId: assetId,
      itemType,
      action: 'access-requested',
      summary:
        `${requester} requested ${permission} access` +
        (justification ? ` — "${justification}"` : '') +
        (ownerUpn ? ` (owner: ${ownerUpn})` : ''),
      upn: requester,
      at: now,
    });

    // 2) Confirmation notification to the requester (real, oid-keyed).
    const notifs = await notificationsContainer();
    await notifs.items.create({
      id: crypto.randomUUID(),
      userId: s.claims.oid,
      title: `Access requested: ${assetName}`,
      body:
        `Your request for ${permission} access to ${assetName} was recorded` +
        (ownerUpn ? ` and routed to the owner (${ownerUpn}).` : '.') +
        ' It now awaits manager approval in Governance → Access requests.',
      severity: 'info',
      link: itemType ? `/items/${itemType}/${assetId}` : null,
      read: false,
      createdAt: now,
    });

    // 3) Approval-workflow row — opened at the MANAGER tier — for the GOVERNED
    //    model (default) and for self-serve that fell through (couldn't auto-grant).
    //    The 'request' model is notify-only: the owner provisions manually, so we
    //    deliberately skip the multi-tier workflow row.
    let savedReqId: string | undefined;
    if (accessModel !== 'request') {
      const arContainer = await accessRequestWorkflowContainer();
      const requestDoc: AccessRequestDoc = {
        id: crypto.randomUUID(),
        tenantId: s.claims.oid,
        kind: 'access-request',
        assetId,
        assetName,
        itemType,
        scopeType,
        scopeRef,
        permission,
        justification,
        requesterId: s.claims.oid,
        requesterUpn: requester,
        requestedAt: now,
        tier: 'manager',
        status: 'open',
      };
      const { resource: savedReq } = await arContainer.items.create(requestDoc);
      savedReqId = savedReq?.id;
    }

    return NextResponse.json({
      ok: true,
      requestId: savedReqId,
      message:
        accessModel === 'request'
          ? `Access request for "${assetName}" recorded${ownerUpn ? ` and the owner (${ownerUpn})` : ' and the owner'} was notified. Provisioning is handled manually by the owner.`
          : `Access request for "${assetName}" recorded${ownerUpn ? ` and routed to ${ownerUpn}` : ''}. ` +
            'It now awaits multi-tier approval (manager → privacy → approver → access provider) ' +
            'in Governance → Access requests.',
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

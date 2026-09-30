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
 * The asset is loaded on the server (lib/access/request-asset.ts): an unknown,
 * unpublished or not-visible asset is a 404, the access model is the asset's
 * own, and the grant scope is derived from the asset's bound output. The body
 * names WHICH asset and HOW MUCH access is requested — nothing else about the
 * grant is read from it.
 *
 * Body: { assetId, permission?, justification?, ownerUpn? }
 *   (assetName / itemType / accessModel / scopeType / scopeRef are accepted for
 *    compatibility with older callers and ignored.)
 * Returns: { ok, message, requestId } | { ok, granted:true, … } | { ok:false, error }
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { tenantScopeId } from '@/lib/auth/session';
import { isDeviceCodeSession } from '@/lib/auth/device-code-policy';
import {
  auditLogContainer, notificationsContainer, accessRequestWorkflowContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequestDoc } from '@/lib/types/access-request-workflow';
import { enforceAccessGrant, type AccessPermission } from '@/lib/azure/access-policy-client';
import {
  ASSET_NOT_FOUND, SELF_SERVE_PERMISSION, deriveRequestTargets, resolveRequestableAsset,
} from '@/lib/access/request-asset';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERMS = new Set(['read', 'write', 'admin']);
// Per-product access model the owner sets at publish time (see PublishTab),
// read from the product on the server:
//   governed   — multi-tier approval → real RBAC on final approval (DEFAULT)
//   self-serve — immediate real grant at the product's self-serve role (Read);
//                anything more, or a grant that does not land, is governed
//   request    — record the request + notify the owner; provisioning is manual

export const POST = withSession(async (req, { session: s }) => {

  const body = await req.json().catch(() => ({} as any));
  const assetId = String(body?.assetId || '').trim();
  const ownerUpn = body?.ownerUpn ? String(body.ownerUpn).trim() : '';
  const permission: AccessPermission = PERMS.has(body?.permission) ? body.permission : 'read';
  const justification = String(body?.justification || '').trim().slice(0, 1000);
  if (!assetId) return NextResponse.json({ ok: false, error: 'assetId is required' }, { status: 400 });

  let asset;
  try {
    asset = await resolveRequestableAsset(s, assetId);
  } catch (e: any) {
    return apiServerError(e);
  }
  if (!asset) return NextResponse.json({ ok: false, error: ASSET_NOT_FOUND }, { status: 404 });

  const assetName = asset.name;
  const itemType = asset.item.itemType;
  const targets = deriveRequestTargets(asset.item, permission);
  const { scopeType, scopeRef } = targets[0];
  // Self-serve covers the product's self-serve role only; a request for more
  // than that is decided by the governed workflow.
  const accessModel = asset.accessModel === 'self-serve' && permission !== SELF_SERVE_PERMISSION
    ? 'governed'
    : asset.accessModel;

  const requester = s.claims.upn || s.claims.email || s.claims.oid;
  const now = new Date().toISOString();

  // Self-serve: try to provision a REAL RBAC grant immediately. Needs a concrete
  // scopeRef (the backing container/db/pool) — when present and the grant lands
  // 'active' we short-circuit. Anything else (no scopeRef, honest gate, or error)
  // falls through to the governed approval workflow so the request is never lost.
  // A CLI / VS Code device-code session never self-grants (#4805, operator
  // decision 2026-09-30): its request takes the governed path instead, so an
  // approver decides and nothing outlives the session unreviewed.
  if (accessModel === 'self-serve' && scopeRef && !isDeviceCodeSession(s)) {
    try {
      const grants = [];
      for (const t of targets) {
        grants.push(await enforceAccessGrant({
          principalId: s.claims.oid,
          principalName: requester,
          principalType: 'User',
          scopeType: t.scopeType,
          scopeRef: t.scopeRef,
          permission: SELF_SERVE_PERMISSION,
        }));
      }
      if (grants.every((g) => g.status === 'active')) {
        const roles = grants.map((g, i) => g.roleName || targets[i].scopeType).join(', ');
        try {
          const audit = await auditLogContainer();
          await audit.items.create({
            id: crypto.randomUUID(), itemId: assetId, itemType,
            action: 'access-granted',
            summary: `${requester} self-served ${SELF_SERVE_PERMISSION} access to ${assetName} (${roles}).`,
            upn: requester, at: now,
          });
        } catch { /* audit best-effort */ }
        return NextResponse.json({
          ok: true,
          granted: true,
          permission: SELF_SERVE_PERMISSION,
          roleAssignmentId: grants[0].roleAssignmentId,
          message: `Self-serve ${SELF_SERVE_PERMISSION} access to "${assetName}" granted immediately (${roles}).`,
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
        (accessModel === 'request'
          ? ' The owner provisions access for this asset.'
          : ' It now awaits manager approval in Governance → Access requests.'),
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
        // PARTITION KEY (/tenantId) — the ENTRA TENANT, never the requester's
        // oid. An approver is a DIFFERENT user than the requester, so an
        // oid-keyed partition put every request in a partition no approver
        // could read: the inbox returned zero rows and the decision route 404'd.
        // tenantScopeId() exists precisely so state written by one user resolves
        // for any grantee in the same tenant. The requester stays addressable
        // via `requesterId` below, which is what "my requests" queries on.
        tenantId: tenantScopeId(s),
        kind: 'access-request',
        assetId,
        assetName,
        itemType,
        scopeType,
        scopeRef,
        grantTargets: targets.map((t) => ({ scopeType: t.scopeType, scopeRef: t.scopeRef, source: t.source })),
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
      accessModel,
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
});

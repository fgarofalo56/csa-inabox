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
 * Body: { assetId, permission?, justification? }
 *   (assetName / itemType / accessModel / scopeType / scopeRef / ownerUpn are
 *    accepted for compatibility with older callers and ignored.)
 * Returns: { ok, message, requestId } | { ok, granted:true, … } | { ok:false, error }
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { tenantScopeId } from '@/lib/auth/session';
import { isDeviceCodeSession } from '@/lib/auth/device-code-policy';
import {
  auditLogContainer, notificationsContainer, accessRequestWorkflowContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequestDoc, AccessRequestGrantResult } from '@/lib/types/access-request-workflow';
import { enforceAccessGrant, type AccessPermission } from '@/lib/azure/access-policy-client';
import {
  ASSET_NOT_FOUND, SELF_SERVE_PERMISSION, deriveRequestTargets, ownerOf, resolveRequestableAsset,
} from '@/lib/access/request-asset';
import { grantResult, landedGrants, recordLandedGrants } from '@/lib/access/landed-grants';
import { newAttemptId, settleGrantIntent, writeGrantIntent, type IntentContext } from '@/lib/access/grant-intents';
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
  // The owner NAMED on the item (a data product's `state.owner`), never a body
  // field. It is shown for context only: this route does not message the owner.
  const ownerUpn = ownerOf(asset.item);
  const targets = await deriveRequestTargets(asset.item, permission);
  const { scopeType, scopeRef } = targets[0];
  // Self-serve covers the product's self-serve role only; a request for more
  // than that is decided by the governed workflow.
  const accessModel = asset.accessModel === 'self-serve' && permission !== SELF_SERVE_PERMISSION
    ? 'governed'
    : asset.accessModel;

  const requester = s.claims.upn || s.claims.email || s.claims.oid;
  // The identity a self-serve grant is made for: the session's UPN only, never
  // the email claim. The warehouse grant creates its database user from this
  // name and the ADX grant uses it as the principal, so without a UPN the
  // request takes the governed path instead of being granted on the spot.
  const sessionUpn = (s.claims.upn || '').trim();
  const now = new Date().toISOString();
  // Minted up front so a grant that lands before the request is routed for
  // approval is recorded against the request that will carry it.
  const requestId = crypto.randomUUID();
  /** Per-scope results of a self-serve attempt that landed some grants but not all. */
  let partialResults: AccessRequestGrantResult[] | undefined;

  // Self-serve: try to provision a REAL RBAC grant immediately. Needs a concrete
  // scopeRef (the backing container/db/pool) — when present and the grant lands
  // 'active' we short-circuit. Anything else (no scopeRef, honest gate, or error)
  // falls through to the governed approval workflow so the request is never lost.
  // A CLI / VS Code device-code session never self-grants (#4805, operator
  // decision 2026-09-30): its request takes the governed path instead, so an
  // approver decides and nothing outlives the session unreviewed.
  if (accessModel === 'self-serve' && scopeRef && sessionUpn && !isDeviceCodeSession(s)) {
    const results: AccessRequestGrantResult[] = [];
    // Every grant is written to the request's grant ledger before it is made
    // (lib/access/grant-intents.ts): a denial of the request routed below
    // revokes from the ledger, so a grant that is not in it would outlive it.
    const intentCtx: IntentContext = {
      tenantId: tenantScopeId(s),
      requestId,
      attemptId: newAttemptId(),
      principalId: s.claims.oid,
      principalName: sessionUpn,
      permission: SELF_SERVE_PERMISSION,
      assetName,
      by: requester,
    };
    try {
      const ledger = await accessRequestWorkflowContainer();
      for (const t of targets) {
        if (!t.scopeRef) {
          // Not a store the product's workspace has bound (lib/access/verified-targets.ts):
          // nothing to grant on. The request goes for approval instead.
          results.push({ status: 'pending', scopeType: t.scopeType, scopeRef: '', created: false, detail: 'Not a store bound in this product\'s workspace.' });
          continue;
        }
        // A grant that cannot be recorded first is not made; the loop stops
        // and the remaining scopes go for approval.
        const row = await writeGrantIntent(ledger, intentCtx, { scopeType: t.scopeType, scopeRef: t.scopeRef });
        const r = await enforceAccessGrant({
          principalId: s.claims.oid,
          principalName: sessionUpn,
          principalType: 'User',
          scopeType: t.scopeType,
          scopeRef: t.scopeRef,
          permission: SELF_SERVE_PERMISSION,
        });
        const g = grantResult(r, t.scopeType, t.scopeRef);
        results.push(g);
        // A row that cannot be settled stays `pending`; the next decision on
        // the request resolves it from the store (reconcileGrantIntent).
        await settleGrantIntent(ledger, row, g);
      }
    } catch { /* the grants made so far are handled below; the rest go for approval */ }
    if (results.length === targets.length && results.every((g) => g.status === 'active')) {
      const roles = results.map((g, i) => g.roleName || targets[i].scopeType).join(', ');
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
        accessModel: 'self-serve',
        permission: SELF_SERVE_PERMISSION,
        roleAssignmentId: results[0].roleAssignmentId,
        message: `Self-serve ${SELF_SERVE_PERMISSION} access to "${assetName}" granted immediately (${roles}).`,
      });
    }
    // Some grants may have landed before one did not. They are real role
    // assignments, so each is audited, recorded in the entitlement ledger and
    // carried on the request routed below; its grant-ledger rows (written
    // above) are what a denial of that request revokes from.
    const landed = landedGrants(results);
    if (landed.length) {
      await recordLandedGrants({
        requestId,
        requesterId: s.claims.oid,
        requesterUpn: requester,
        tenantId: tenantScopeId(s),
        assetName,
        permission: SELF_SERVE_PERMISSION,
        grantedBy: requester,
      }, results);
      try {
        const audit = await auditLogContainer();
        for (const g of landed) {
          await audit.items.create({
            id: crypto.randomUUID(), itemId: assetId, itemType,
            action: 'access-granted',
            summary: `${requester} self-served ${SELF_SERVE_PERMISSION} access to ${assetName} on ${g.scopeType} ${g.scopeRef}`
              + `${g.roleName ? ` (${g.roleName})` : ''}; the remaining scopes were routed for approval (request ${requestId}).`,
            upn: requester, at: now,
          });
        }
      } catch { /* audit best-effort */ }
      partialResults = results;
    }
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

    // 2) Confirmation notification to the requester (real, oid-keyed). It says
    //    only what happened: the request is recorded on the item's activity, and
    //    — for the governed path — is in the approval inbox. No one else is
    //    messaged by this route, so the text does not say the owner was.
    const ownerNote = ownerUpn ? ` The item's owner is ${ownerUpn}.` : '';
    const partialNote = partialResults
      ? ` Read access was granted on ${landedGrants(partialResults).length} of ${targets.length} of its storage locations; `
        + 'the rest need approval.'
      : '';
    const notifs = await notificationsContainer();
    await notifs.items.create({
      id: crypto.randomUUID(),
      userId: s.claims.oid,
      title: `Access requested: ${assetName}`,
      body:
        `Your request for ${permission} access to ${assetName} was recorded in the item's activity.` +
        partialNote +
        (accessModel === 'request'
          ? ` Access to this asset is provisioned by its owner.${ownerNote}`
          : ` It now awaits manager approval in Governance → Access requests.${ownerNote}`),
      severity: 'info',
      link: itemType ? `/items/${itemType}/${assetId}` : null,
      read: false,
      createdAt: now,
    });

    // 3) Approval-workflow row — opened at the MANAGER tier — for the GOVERNED
    //    model (default) and for self-serve that fell through (couldn't auto-grant).
    //    The 'request' model is recorded on the item only: the owner provisions
    //    access, so we deliberately skip the multi-tier workflow row.
    let savedReqId: string | undefined;
    if (accessModel !== 'request') {
      const arContainer = await accessRequestWorkflowContainer();
      const requestDoc: AccessRequestDoc = {
        id: requestId,
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
        grantTargets: targets.map((t) => ({
          scopeType: t.scopeType, scopeRef: t.scopeRef, source: t.source,
          ...(t.declaredRef ? { declaredRef: t.declaredRef } : {}),
        })),
        ...(partialResults ? { grantResults: partialResults } : {}),
        ...(ownerUpn ? { ownerUpn } : {}),
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
      ...(partialResults ? { grantResults: partialResults } : {}),
      message:
        accessModel === 'request'
          ? `Access request for "${assetName}" recorded on the item's activity. Access to this asset is provisioned by its owner.${ownerNote}`
          : `Access request for "${assetName}" recorded.${partialNote} ` +
            'It now awaits multi-tier approval (manager → privacy → approver → access provider) ' +
            `in Governance → Access requests.${ownerNote}`,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
});

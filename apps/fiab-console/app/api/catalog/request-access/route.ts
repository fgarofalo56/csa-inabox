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
import type { AccessScopeType } from '@/lib/azure/access-policy-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERMS = new Set(['read', 'write', 'admin']);
const SCOPE_TYPES = new Set<AccessScopeType>(['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection']);

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
  if (!assetId) return NextResponse.json({ ok: false, error: 'assetId is required' }, { status: 400 });

  const requester = s.claims.upn || s.claims.email || s.claims.oid;
  const now = new Date().toISOString();

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

    // 3) Durable approval-workflow row — opened at the MANAGER tier.
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

    return NextResponse.json({
      ok: true,
      requestId: savedReq?.id,
      message:
        `Access request for "${assetName}" recorded${ownerUpn ? ` and routed to ${ownerUpn}` : ''}. ` +
        'It now awaits multi-tier approval (manager → privacy → approver → access provider) ' +
        'in Governance → Access requests.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

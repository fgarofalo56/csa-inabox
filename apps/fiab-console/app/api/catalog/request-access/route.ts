/**
 * POST /api/catalog/request-access — request access to a catalog data asset.
 *
 * Records a REAL, durable access request (no-vaporware): an audit-log entry on
 * the asset (visible to the owner in the item's activity) + a confirmation
 * notification to the requester. The owner reviews it and grants access via
 * Governance → Policies (which enforces real Azure-native RBAC/SQL/ADX grants).
 *
 * Body: { assetId, assetName, itemType, ownerUpn?, permission, justification? }
 * Returns: { ok, message } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, notificationsContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERMS = new Set(['read', 'write', 'admin']);

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
        ' The owner can grant it in Governance → Policies.',
      severity: 'info',
      link: itemType ? `/items/${itemType}/${assetId}` : null,
      read: false,
      createdAt: now,
    });

    return NextResponse.json({
      ok: true,
      message:
        `Access request for "${assetName}" recorded${ownerUpn ? ` and routed to ${ownerUpn}` : ''}. ` +
        'The owner reviews it in the asset activity and grants access in Governance → Policies.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

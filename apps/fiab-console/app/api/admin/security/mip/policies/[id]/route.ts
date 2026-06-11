/**
 * /api/admin/security/mip/policies/[id]
 *
 * PATCH  → edit a label policy (Set-LabelPolicy) via the SCC sidecar.
 *          Body: { comment?, labels?[], exchangeLocation?[], sharePointLocation?[],
 *                  mandatory?, defaultLabelId? }
 * DELETE → remove a label policy (Remove-LabelPolicy) via the SCC sidecar.
 *
 * 503 with code 'mip_admin_not_configured' when the SCC admin sidecar is unwired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateLabelPolicy, deleteLabelPolicy } from '@/lib/azure/scc-labels-client';
import { handleSecurityError } from '../../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  if (!id) return NextResponse.json({ ok: false, error: 'policy id is required' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const patch: Record<string, unknown> = {};
  if (typeof body?.comment === 'string') patch.comment = body.comment.trim();
  if (Array.isArray(body?.labels)) patch.labels = body.labels.filter((x: any) => typeof x === 'string' && x.trim());
  if (Array.isArray(body?.exchangeLocation)) patch.exchangeLocation = body.exchangeLocation;
  if (Array.isArray(body?.sharePointLocation)) patch.sharePointLocation = body.sharePointLocation;
  if (typeof body?.mandatory === 'boolean') patch.mandatory = body.mandatory;
  if (typeof body?.defaultLabelId === 'string') patch.defaultLabelId = body.defaultLabelId.trim();
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'no editable fields supplied' }, { status: 400 });
  }
  try {
    const result = await updateLabelPolicy(id, patch as any);
    return NextResponse.json({ ok: true, policy: result });
  } catch (e) { return handleSecurityError(e); }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  if (!id) return NextResponse.json({ ok: false, error: 'policy id is required' }, { status: 400 });
  try {
    const result = await deleteLabelPolicy(id);
    return NextResponse.json({ ok: true, deleted: result });
  } catch (e) { return handleSecurityError(e); }
}

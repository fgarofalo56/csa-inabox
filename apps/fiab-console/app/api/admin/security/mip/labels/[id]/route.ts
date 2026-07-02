/**
 * /api/admin/security/mip/labels/[id]
 *
 * PATCH  → edit a sensitivity label (Set-Label) via the SCC PowerShell sidecar.
 *          Body: { displayName?, tooltip?, comment?, color?, encryptionEnabled? }
 * DELETE → remove a sensitivity label (Remove-Label) via the SCC sidecar.
 *
 * 503 with code 'mip_admin_not_configured' when the SCC admin sidecar is not
 * wired (LOOM_MIP_ADMIN_ENABLED / LOOM_SCC_LABELS_ENDPOINT / _KEY).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { updateLabel, deleteLabel } from '@/lib/azure/scc-labels-client';
import { handleSecurityError } from '../../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const { id } = await props.params;
  if (!id) return NextResponse.json({ ok: false, error: 'label id is required' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const patch: Record<string, unknown> = {};
  if (typeof body?.displayName === 'string') patch.displayName = body.displayName.trim();
  if (typeof body?.tooltip === 'string') patch.tooltip = body.tooltip.trim();
  if (typeof body?.comment === 'string') patch.comment = body.comment.trim();
  if (typeof body?.color === 'string') patch.color = body.color.trim();
  if (typeof body?.encryptionEnabled === 'boolean') patch.encryptionEnabled = body.encryptionEnabled;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'no editable fields supplied' }, { status: 400 });
  }
  try {
    const result = await updateLabel(id, patch as any);
    return NextResponse.json({ ok: true, label: result });
  } catch (e) { return handleSecurityError(e); }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const { id } = await props.params;
  if (!id) return NextResponse.json({ ok: false, error: 'label id is required' }, { status: 400 });
  try {
    const result = await deleteLabel(id);
    return NextResponse.json({ ok: true, deleted: result });
  } catch (e) { return handleSecurityError(e); }
}

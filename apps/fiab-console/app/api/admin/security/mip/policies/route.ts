/**
 * /api/admin/security/mip/policies
 *
 * GET  → list sensitivity label policies (which labels are published, mandatory
 *        labeling, default label, scoped locations). Backed by the SCC PowerShell
 *        sidecar (Get-LabelPolicy) — Microsoft Graph has no app-only read for
 *        label policies (the old Graph call 400'd). 503 with code
 *        'mip_admin_not_configured' when the sidecar is not wired.
 *
 * POST → create a label policy (New-LabelPolicy) via the SCC sidecar.
 *        Body: { name, comment?, labels[], exchangeLocation?[], sharePointLocation?[],
 *                mandatory?, defaultLabelId? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listLabelPolicies, createLabelPolicy } from '@/lib/azure/scc-labels-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const policies = await listLabelPolicies();
    return NextResponse.json({ ok: true, policies, source: 'scc-powershell' });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const name = (body?.name || '').toString().trim();
  const labels: string[] = Array.isArray(body?.labels) ? body.labels.filter((x: any) => typeof x === 'string' && x.trim()) : [];
  if (!name) return NextResponse.json({ ok: false, error: 'policy name is required' }, { status: 400 });
  if (labels.length === 0) return NextResponse.json({ ok: false, error: 'select at least one label to publish' }, { status: 400 });
  try {
    const result = await createLabelPolicy({
      name,
      comment: body?.comment?.toString().trim() || undefined,
      labels,
      exchangeLocation: Array.isArray(body?.exchangeLocation) ? body.exchangeLocation : undefined,
      sharePointLocation: Array.isArray(body?.sharePointLocation) ? body.sharePointLocation : undefined,
      mandatory: body?.mandatory === true,
      defaultLabelId: body?.defaultLabelId?.toString().trim() || undefined,
    });
    return NextResponse.json({ ok: true, policy: result });
  } catch (e) { return handleSecurityError(e); }
}

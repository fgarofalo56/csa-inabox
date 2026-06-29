/**
 * /api/admin/security/mip/labels
 *
 * GET  → list sensitivity labels (tenant scope). Backed by Microsoft Graph
 *        /beta/security/informationProtection/sensitivityLabels via the Console
 *        UAMI (InformationProtectionPolicy.Read.All). 503 → LOOM_MIP_ENABLED unset.
 *
 * POST → create a sensitivity label (New-Label) via the SCC PowerShell sidecar.
 *        Guided body — never raw JSON to the cmdlet. 503 → SCC admin sidecar
 *        not wired (code 'mip_admin_not_configured').
 *        Body: { displayName, tooltip?, comment?, color?, parentId?, encryptionEnabled? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { listSensitivityLabels } from '@/lib/azure/mip-graph-client';
import { createLabel } from '@/lib/azure/scc-labels-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // PDP gate (default-off / shadow-ready). Admin read of tenant sensitivity labels.
  const blocked = await pdpCheck(s, { level: 'domain', id: s.claims.oid }, 'read');
  if (blocked) return blocked;
  try {
    const labels = await listSensitivityLabels();
    return NextResponse.json({ ok: true, labels, source: 'graph-beta' });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // PDP gate (default-off / shadow-ready). Admin write — create sensitivity label.
  const blocked = await pdpCheck(s, { level: 'domain', id: s.claims.oid }, 'admin');
  if (blocked) return blocked;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const displayName = (body?.displayName || '').toString().trim();
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  try {
    const result = await createLabel({
      displayName,
      tooltip: body?.tooltip?.toString().trim() || undefined,
      comment: body?.comment?.toString().trim() || undefined,
      color: body?.color?.toString().trim() || undefined,
      parentId: body?.parentId?.toString().trim() || undefined,
      encryptionEnabled: body?.encryptionEnabled === true,
    });
    return NextResponse.json({ ok: true, label: result });
  } catch (e) { return handleSecurityError(e); }
}

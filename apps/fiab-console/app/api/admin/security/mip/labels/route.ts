/**
 * /api/admin/security/mip/labels
 *
 * GET → list sensitivity labels (tenant scope).
 *
 * Backed by Microsoft Graph /beta/security/informationProtection/sensitivityLabels.
 * Requires app permission InformationProtectionPolicy.Read.All on the
 * Console UAMI (granted via post-deploy bootstrap).
 *
 * 503 → LOOM_MIP_ENABLED not set. Body carries hint with env var name,
 * Graph AppRoles to grant, and the bootstrap script that grants them.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSensitivityLabels } from '@/lib/azure/mip-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const labels = await listSensitivityLabels();
    return NextResponse.json({ ok: true, labels, source: 'graph-beta' });
  } catch (e) { return handleSecurityError(e); }
}

/**
 * /api/admin/security/mip/policies
 *
 * GET → list sensitivity label policies (which labels are published to
 *       which users/groups/locations, mandatory labeling, default label, etc.).
 *
 * Backed by Microsoft Graph /beta/security/informationProtection/policy/labels.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listLabelPolicies } from '@/lib/azure/mip-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const policies = await listLabelPolicies();
    return NextResponse.json({ ok: true, policies, source: 'graph-beta' });
  } catch (e) { return handleSecurityError(e); }
}

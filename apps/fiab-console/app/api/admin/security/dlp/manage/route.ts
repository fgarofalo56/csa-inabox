/**
 * /api/admin/security/dlp/manage
 *
 * Real DLP policy CRUD via the Security & Compliance PowerShell sidecar
 * (azure-functions/scc-labels → dlp/). Microsoft Graph has no DLP write API,
 * so create/edit/delete run through Get/New/Set/Remove-DlpCompliancePolicy.
 *
 *   GET                  → list DLP compliance policies (+ rules).
 *   GET ?id=<name|guid>  → get a single policy.
 *   POST   { policy }    → create a policy (+ its initial rule).
 *   PATCH  { id, policy }→ edit a policy (+ upsert its named rule).
 *   DELETE ?id=<name|guid> | { id } → delete a policy.
 *
 * Requires LOOM_DLP_ADMIN_ENABLED=true + the SCC sidecar (Exchange.ManageAsApp
 * + Compliance Administrator). When unwired, every verb returns the honest 503
 * dlp_admin_not_configured gate — DLP reads / alerts / Restrict-access keep
 * working. No Microsoft Fabric / Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import {
  listDlpCompliancePolicies,
  getDlpCompliancePolicy,
  createDlpCompliancePolicy,
  updateDlpCompliancePolicy,
  deleteDlpCompliancePolicy,
  type DlpPolicyInput,
} from '@/lib/azure/scc-dlp-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tenant-scoped resource ref for the PDP gate (default-off / shadow-ready). */
const tenantRef = () => ({
  level: 'domain' as const,
  id: process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common',
});

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = await pdpCheck(s, tenantRef(), 'read');
  if (blocked) return blocked;
  const id = req.nextUrl.searchParams.get('id');
  try {
    if (id) {
      const policy = await getDlpCompliancePolicy(id);
      return NextResponse.json({ ok: true, policy });
    }
    const policies = await listDlpCompliancePolicies();
    return NextResponse.json({ ok: true, policies });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = await pdpCheck(s, tenantRef(), 'admin');
  if (blocked) return blocked;
  let body: { policy?: DlpPolicyInput };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  if (!body?.policy) return NextResponse.json({ ok: false, error: 'policy is required' }, { status: 400 });
  try {
    const created = await createDlpCompliancePolicy(body.policy);
    return NextResponse.json({ ok: true, created });
  } catch (e) { return handleSecurityError(e); }
}

export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = await pdpCheck(s, tenantRef(), 'admin');
  if (blocked) return blocked;
  let body: { id?: string; policy?: Partial<DlpPolicyInput> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  if (!body?.id || !body?.policy) return NextResponse.json({ ok: false, error: 'id and policy are required' }, { status: 400 });
  try {
    const updated = await updateDlpCompliancePolicy(body.id, body.policy);
    return NextResponse.json({ ok: true, updated });
  } catch (e) { return handleSecurityError(e); }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = await pdpCheck(s, tenantRef(), 'admin');
  if (blocked) return blocked;
  let id = req.nextUrl.searchParams.get('id') || '';
  if (!id) {
    try { const body = await req.json(); id = body?.id || ''; } catch { /* ignore */ }
  }
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    const deleted = await deleteDlpCompliancePolicy(id);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) { return handleSecurityError(e); }
}

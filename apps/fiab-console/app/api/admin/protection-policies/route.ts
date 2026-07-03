/**
 * Admin protection-policies (EH Phase-1 §2.3) — sovereign-rbac default.
 *
 * GET    /api/admin/protection-policies          — list tenant policies + last receipt
 * POST   /api/admin/protection-policies          — upsert + on-demand reconcile
 * (DELETE lives in [id]/route.ts)
 *
 * Tenant-admin gated. Reconcile is on-demand here; an ACA Job cron for periodic
 * drift re-convergence is DEFERRED (tracked) — not wired in this increment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier, TENANT_ADMIN_TIER_REMEDIATION, TENANT_ADMIN_BOOTSTRAP_ENV } from '@/lib/auth/domain-role';
import {
  listPolicies, upsertPolicy, normalizePolicy, validatePolicy,
} from '@/lib/azure/protection-policy-client';
import { reconcilePolicy } from '@/lib/azure/protection-policy-reconciler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdminTier(s)) return NextResponse.json({ ok: false, error: 'tenant admin required', remediation: TENANT_ADMIN_TIER_REMEDIATION, bootstrapEnv: TENANT_ADMIN_BOOTSTRAP_ENV }, { status: 403 });
  // Policies are a TENANT resource: key the partition by the Entra tenant id so
  // every tenant admin shares one set. (oid is per-user → wrong partitioning.)
  const tenantId = process.env.AZURE_TENANT_ID || s.claims.oid;
  try {
    const policies = await listPolicies(tenantId);
    return NextResponse.json({ ok: true, policies });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdminTier(s)) return NextResponse.json({ ok: false, error: 'tenant admin required', remediation: TENANT_ADMIN_TIER_REMEDIATION, bootstrapEnv: TENANT_ADMIN_BOOTSTRAP_ENV }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const err = validatePolicy(body);
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });
  try {
    // tenantId = Entra tenant (shared); updatedBy = the acting admin's oid.
    const tenantId = process.env.AZURE_TENANT_ID || s.claims.oid;
    const policy = normalizePolicy(body, { tenantId, updatedBy: s.claims.oid });
    const saved = await upsertPolicy(policy);
    const receipt = await reconcilePolicy(saved); // on-demand reconcile
    return NextResponse.json({ ok: true, policy: saved, receipt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

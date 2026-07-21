/**
 * Governance-as-Code BFF — the reconcile loop. This is the route `loom policy
 * apply` calls.
 *
 *   GET  /api/admin/policy-code/reconcile  → a DRY RUN: compiles the stored set,
 *        reads live backend state, and returns the per-backend drift (nothing is
 *        mutated).
 *   POST /api/admin/policy-code/reconcile  → body `{ apply?: boolean }`.
 *        apply:false (default) = dry run; apply:true = converge every configured
 *        backend with REAL calls (self-heals drift), persist the snapshot, audit.
 *
 * Tenant-admin only. Honest-gated per backend (unconfigured backends report a
 * gate, never a silent no-op). OSS-UC path works with no Databricks/Fabric.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { loadPolicySet } from '@/lib/governance/policy-code/store';
import { reconcilePolicyCode } from '@/lib/governance/policy-code/reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantScope(claims: { tid?: string; oid: string }): string {
  return claims.tid || claims.oid;
}

async function run(s: NonNullable<ReturnType<typeof getSession>>, apply: boolean) {
  const tenantId = tenantScope(s.claims);
  const { set, exists } = await loadPolicySet(tenantId);
  if (!exists || set.statements.length === 0) {
    return apiError('no policy set has been authored yet', 409, {
      hint: 'Author or import a policy set on /admin/policy-code first.',
    });
  }
  const receipt = await reconcilePolicyCode(set, {
    apply,
    tenantId,
    updatedBy: s.claims.upn || s.claims.oid,
  });
  return apiOk({ receipt });
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    return await run(s, false);
  } catch (e) {
    return apiServerError(e, 'Reconcile dry run failed');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;
  try {
    return await run(s, apply);
  } catch (e) {
    return apiServerError(e, 'Reconcile failed');
  }
}

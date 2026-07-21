/**
 * Governance-as-Code BFF — the authored policy set + a one-pass compiled preview.
 *
 *   GET  /api/admin/policy-code  → the stored policy set, its per-backend
 *        compiled artifacts (real GRANT/DENY/RLS/KQL/classification/scope
 *        statements), the backends it compiles to, validation, and the last
 *        reconcile receipt (drift status). Never mutates.
 *   PUT  /api/admin/policy-code  → save an authored/imported set; returns the
 *        normalized set + a fresh compiled preview. Does NOT touch any backend
 *        (that is the reconcile route).
 *
 * Tenant-admin only (org-wide governance). No Fabric dependency — the compiled
 * artifacts are Azure-native (Synapse/UC/ADX/Purview) with the OSS-UC path.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { normalizePolicyCodeSet, validatePolicyCodeSet, backendsInSet, toYaml } from '@/lib/governance/policy-code/dsl';
import { compileAll } from '@/lib/governance/policy-code/compile';
import { loadPolicySet, savePolicySet, loadLastReceipt } from '@/lib/governance/policy-code/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantScope(claims: { tid?: string; oid: string }): string {
  return claims.tid || claims.oid;
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tenantId = tenantScope(s.claims);
  try {
    const [{ set, exists }, lastReceipt] = await Promise.all([loadPolicySet(tenantId), loadLastReceipt(tenantId)]);
    const compiled = compileAll(set);
    return apiOk({
      set,
      exists,
      yaml: toYaml(set),
      backends: backendsInSet(set),
      validation: compiled.validation,
      artifacts: compiled.artifacts,
      compiledBackends: compiled.compiledBackends,
      totalOps: compiled.totalOps,
      lastReceipt,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to load policy set');
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tenantId = tenantScope(s.claims);
  const body = await req.json().catch(() => ({}));
  if (!body?.set || typeof body.set !== 'object') return apiError('set required', 400);

  const set = normalizePolicyCodeSet(body.set);
  const validation = validatePolicyCodeSet(set);
  if (!validation.ok) {
    return apiError('policy set has validation errors', 422, { validation });
  }
  try {
    const saved = await savePolicySet(tenantId, set, s.claims.upn || s.claims.oid);
    const compiled = compileAll(saved);
    return apiOk({
      set: saved,
      yaml: toYaml(saved),
      backends: backendsInSet(saved),
      validation: compiled.validation,
      artifacts: compiled.artifacts,
      compiledBackends: compiled.compiledBackends,
      totalOps: compiled.totalOps,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to save policy set');
  }
}

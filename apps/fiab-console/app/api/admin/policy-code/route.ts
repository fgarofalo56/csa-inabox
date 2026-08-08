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
 *
 * Both handlers run through `withTenantAdmin`, so the 401/403 envelopes are
 * byte-identical to every other admin surface and cannot drift (the copy-paste
 * divergence `check-route-guards` exists for). The wrapper is also the
 * non-discardable shape: with the hand-rolled prologue, deleting the two
 * `if (denied) return denied;` lines silently removes authorization while the
 * guard stays green — with the wrapper there is no line to delete.
 */

import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { normalizePolicyCodeSet, validatePolicyCodeSet, backendsInSet, toYaml } from '@/lib/governance/policy-code/dsl';
import { compileAll } from '@/lib/governance/policy-code/compile';
import { resolveCompileOptions } from '@/lib/governance/policy-code/compile-options';
import { loadPolicySet, savePolicySet, loadLastReceipt } from '@/lib/governance/policy-code/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantScope(claims: { tid?: string; oid: string }): string {
  return claims.tid || claims.oid;
}

export const GET = withTenantAdmin(async (_req, { session }) => {
  const tenantId = tenantScope(session.claims);
  try {
    const [{ set, exists }, lastReceipt] = await Promise.all([loadPolicySet(tenantId), loadLastReceipt(tenantId)]);
    // The artifact an operator READS must be compiled with the same options the
    // publish and serve paths use. Compiling with none meant this preview
    // resolved 2-part refs against the hardcoded `iceberg` default instead of
    // LOOM_TRINO_ICEBERG_CATALOG, and warned that every group-keyed rule "will
    // not match" even when a group file was published — so the surface an admin
    // trusts to tell them what is enforced was the least accurate of the three.
    const compiled = compileAll(set, await resolveCompileOptions(tenantId));
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
});

export const PUT = withTenantAdmin(async (req: NextRequest, { session }) => {
  const tenantId = tenantScope(session.claims);
  const body = await req.json().catch(() => ({}));
  if (!body?.set || typeof body.set !== 'object') return apiError('set required', 400);

  const set = normalizePolicyCodeSet(body.set);
  const validation = validatePolicyCodeSet(set);
  if (!validation.ok) {
    return apiError('policy set has validation errors', 422, { validation });
  }
  try {
    const saved = await savePolicySet(tenantId, set, session.claims.upn || session.claims.oid);
    const compiled = compileAll(saved, await resolveCompileOptions(tenantId));
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
});

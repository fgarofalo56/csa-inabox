/**
 * Workspace outbound access protection (rel-T89) — per-policy operations.
 *
 * GET    /api/governance/workspace-egress/[id]?workspaceId=... — fetch + a
 *        SIDE-EFFECT-FREE compile preview (the exact rules that WOULD be written)
 * DELETE /api/governance/workspace-egress/[id]?workspaceId=... — revoke every
 *        loom-egress NSG rule for the workspace, then delete the policy doc
 *
 * Tenant-admin gated (shared-tenant network policy). GET never mutates the NSG —
 * it returns a pure compileEgressRules() plan so prefetch/bots cannot rewrite the
 * firewall. Convergence happens only on POST /api/governance/workspace-egress.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiNotFound, apiServerError } from '@/lib/api/respond';
import {
  getEgressPolicy, deleteEgressPolicyDoc, revokeAllEgressRules, compileEgressRules,
} from '@/lib/clients/workspace-egress-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId query param required', 400);
  try {
    const policy = await getEgressPolicy(params.id, workspaceId);
    if (!policy) return apiNotFound();
    const preview = compileEgressRules(policy); // pure — no NSG write
    return apiOk({ policy, preview, dryRun: true });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId query param required', 400);
  try {
    const policy = await getEgressPolicy(params.id, workspaceId);
    let revoked = 0;
    let revokeGate: string | undefined;
    if (policy) {
      // Best-effort revoke of the real NSG rules; a permission gap still lets the
      // policy doc be deleted, with an honest note the rules linger until granted.
      try { revoked = await revokeAllEgressRules(policy); }
      catch (e: any) { revokeGate = `Policy deleted, but NSG rules could not be revoked (grant Network Contributor on the NSG's RG): ${String(e?.message || e).slice(0, 140)}`; }
    }
    await deleteEgressPolicyDoc(params.id, workspaceId);
    return apiOk({ deleted: true, rulesRevoked: revoked, revokeGate });
  } catch (e) {
    return apiServerError(e);
  }
}

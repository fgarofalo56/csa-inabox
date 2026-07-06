/**
 * Workspace outbound access protection (rel-T89) — governance surface.
 *
 * GET  /api/governance/workspace-egress   — list tenant egress policies +
 *                                            candidate NSGs + service-tag vocab
 * POST /api/governance/workspace-egress   — upsert a policy + reconcile it onto
 *                                            the chosen NSG (real ARM securityRules)
 * (GET one / DELETE live in [id]/route.ts)
 *
 * Tenant-admin gated: egress protection administers shared-tenant network policy
 * on the workspace compute subnet's NSG via the Console UAMI's Network
 * Contributor — a session-only check would let any signed-in user rewrite the
 * estate's egress firewall. No Fabric/Power BI dependency (no-fabric-dependency).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  listEgressPolicies, upsertEgressPolicy, normalizeEgressPolicy, validateEgressPolicy,
  reconcileEgressPolicy, listEgressCandidateNsgs, AZURE_SERVICE_TAGS,
} from '@/lib/clients/workspace-egress-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const tenantId = process.env.AZURE_TENANT_ID || session!.claims.oid;
  try {
    const policies = await listEgressPolicies(tenantId);
    // NSG discovery is best-effort — a Reader gap must not blank the list; the
    // dialog still opens (with an honest empty NSG picker) and reconcile surfaces
    // the precise role gate.
    let nsgs: Awaited<ReturnType<typeof listEgressCandidateNsgs>> = [];
    let nsgGate: string | undefined;
    try { nsgs = await listEgressCandidateNsgs(); }
    catch (e: any) { nsgGate = `Could not enumerate NSGs (grant the Console identity Reader on the networking subscription): ${String(e?.message || e).slice(0, 160)}`; }
    return apiOk({ policies, nsgs, serviceTags: AZURE_SERVICE_TAGS, nsgGate });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const err = validateEgressPolicy(body);
  if (err) return apiError(err, 400);
  try {
    const tenantId = process.env.AZURE_TENANT_ID || session!.claims.oid;
    const policy = normalizeEgressPolicy(body, { tenantId, updatedBy: session!.claims.oid });
    const saved = await upsertEgressPolicy(policy);
    const receipt = await reconcileEgressPolicy(saved); // real NSG converge
    return apiOk({ policy: saved, receipt });
  } catch (e) {
    return apiServerError(e);
  }
}

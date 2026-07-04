/**
 * POST /api/governance/domains/[domainId]/assignWorkspaces
 * body: { workspaceIds: string[] }
 *
 * DEFAULT (Cosmos): patches each workspace doc → domain = domainId.
 * OPT-IN (Fabric):  POST /v1/admin/domains/{id}/assignWorkspaces
 *                   body: { workspacesIds: string[] }
 *                   (Fabric spelling: "workspacesIds" with extra s)
 * Works with NO Fabric workspace on the default path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDomainsStore, DomainsBackendGateError } from '@/lib/azure/domains-client';
import { writeDomainAudit } from '@/lib/governance/domain-audit';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ domainId: string }> },
) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || tenantId;
  const { domainId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const workspaceIds: string[] = Array.isArray(body?.workspaceIds) ? body.workspaceIds : [];
  if (!workspaceIds.length)
    return NextResponse.json({ ok: false, error: 'workspaceIds (array) is required' }, { status: 400 });
  try {
    const result = await getDomainsStore().assignWorkspaces(tenantId, domainId, workspaceIds);
    await writeDomainAudit(tenantId, who, 'assignWorkspaces', { domainId, workspaceIds });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, assigned: result.assigned });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    return apiServerError(e);
  }
}

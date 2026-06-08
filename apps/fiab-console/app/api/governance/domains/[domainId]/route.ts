/**
 * PATCH  /api/governance/domains/[domainId] — update name/description/color/image
 * DELETE /api/governance/domains/[domainId] — delete domain + Purview mirror
 *
 * DEFAULT (Cosmos): persists to governance-domains, mirrors to a Purview
 * classic collection when configured. Works with NO Fabric workspace.
 * OPT-IN (Fabric):  PATCH/DELETE /v1/admin/domains/{id}.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDomainsStore, DomainsBackendGateError } from '@/lib/azure/domains-client';
import { writeDomainAudit } from '@/lib/governance/domain-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ domainId: string }> },
) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || tenantId;
  const { domainId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    const domain = await getDomainsStore().updateDomain(
      tenantId,
      domainId,
      {
        name: body.name,
        description: body.description,
        color: body.color,
        imageUrl: body.imageUrl,
        owners: Array.isArray(body.owners) ? body.owners : undefined,
        contributors: Array.isArray(body.contributors) ? body.contributors : undefined,
      },
      who,
    );
    await writeDomainAudit(tenantId, who, 'update', { domainId, patch: body });
    return NextResponse.json({ ok: true, domain });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    const status = typeof e?.status === 'number' ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ domainId: string }> },
) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || tenantId;
  const { domainId } = await ctx.params;
  try {
    await getDomainsStore().deleteDomain(tenantId, domainId);
    await writeDomainAudit(tenantId, who, 'delete', { domainId });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    const status = typeof e?.status === 'number' ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

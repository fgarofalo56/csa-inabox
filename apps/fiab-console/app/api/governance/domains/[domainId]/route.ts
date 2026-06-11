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
import { isDomainTenantAdmin } from '@/lib/azure/domain-hierarchy';
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
    // MOVE (reparent) — when the body carries `parentDomainId` (string to nest
    // under a parent, null/'' to move to root). Cosmos reparents + mirrors the
    // Purview collection; the Fabric backend honestly 501s (no move endpoint).
    if (body.parentDomainId !== undefined) {
      // Reparenting is a tenant-admin-only action (mirrors Fabric role rules and
      // PATCH /api/admin/domains, which rejects `parentId` from non-tenant-admins).
      if (!isDomainTenantAdmin(s.claims.oid)) {
        return NextResponse.json(
          { ok: false, error: 'Only a tenant admin may move (reparent) a domain.' },
          { status: 403 },
        );
      }
      const newParentId =
        body.parentDomainId === null || String(body.parentDomainId).trim() === ''
          ? undefined
          : String(body.parentDomainId).trim();
      const moved = await getDomainsStore().moveDomain(tenantId, domainId, newParentId, who);
      await writeDomainAudit(tenantId, who, 'update', { domainId, move: { parentDomainId: newParentId } });
      return NextResponse.json({ ok: true, domain: moved, moved: true });
    }
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

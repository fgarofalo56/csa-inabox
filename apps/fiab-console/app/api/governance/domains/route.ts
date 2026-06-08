/**
 * GET  /api/governance/domains — list domains for the tenant
 * POST /api/governance/domains — create a domain
 *
 * DEFAULT:  Cosmos governance-domains + best-effort Purview classic-collection
 *           mirror. Works with NO Fabric workspace and NO Purview account.
 * OPT-IN:   Fabric Admin /v1/admin/domains (LOOM_DOMAINS_BACKEND=fabric).
 * Audit:    every mutation → Cosmos audit-log (kind: governance-domain.*),
 *           surfaced in the existing Admin → Audit Logs reader.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDomainsStore, DomainsBackendGateError } from '@/lib/azure/domains-client';
import { writeDomainAudit } from '@/lib/governance/domain-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const domains = await getDomainsStore().listDomains(tenantId);
    return NextResponse.json({ ok: true, domains });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || tenantId;
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = (body?.name || '').toString().trim();
  if (!id || !name)
    return NextResponse.json({ ok: false, error: 'id and name are required' }, { status: 400 });
  try {
    const domain = await getDomainsStore().createDomain(
      tenantId,
      {
        id,
        name,
        description: body.description,
        color: body.color,
        imageUrl: body.imageUrl,
        owners: Array.isArray(body.owners) ? body.owners : undefined,
        contributors: Array.isArray(body.contributors) ? body.contributors : undefined,
        parentDomainId: body.parentDomainId,
      },
      who,
    );
    await writeDomainAudit(tenantId, who, 'create', { domainId: domain.id, name });
    return NextResponse.json({ ok: true, domain }, { status: 201 });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

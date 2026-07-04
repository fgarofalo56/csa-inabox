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
import { governanceDomainsContainer } from '@/lib/azure/cosmos-client';
import { writeDomainAudit } from '@/lib/governance/domain-audit';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Deploy-readiness (#229): copy the GLOBAL default domain taxonomy (seeded at
 * deploy time by scripts/csa-loom/seed-governance.sh) into a brand-new tenant's
 * partition so the surface is POPULATED on first login. A one-time marker doc
 * (`__seeded__`) guards re-seeding, so a user who deletes the default domains is
 * NOT re-seeded on the next list. Best-effort + non-fatal: any failure leaves
 * the tenant with its real (possibly empty) domain list and the page renders its
 * honest empty state. Cosmos-native; no Fabric/Purview dependency.
 */
async function copyGlobalDomainDefaults(tenantId: string): Promise<void> {
  if (tenantId === 'GLOBAL') return;
  try {
    const c = await governanceDomainsContainer();
    const marker = '__seeded__';
    try {
      const { resource } = await c.item(marker, tenantId).read<any>();
      if (resource) return; // already seeded (or intentionally cleared) — never re-seed
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    const { resources: globals } = await c.items
      .query<any>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: 'GLOBAL' }],
      })
      .fetchAll();
    const now = new Date().toISOString();
    for (const g of globals) {
      if (g.id === marker) continue;
      const { _rid, _self, _etag, _attachments, _ts, ...rest } = g;
      await c.items
        .create({
          ...rest,
          id: g.id,
          tenantId,
          createdBy: 'csa-loom-default',
          createdAt: now,
          updatedAt: now,
        })
        .catch(() => {});
    }
    await c.items
      .create({ id: marker, tenantId, kind: 'domains-seed-marker', seededAt: now })
      .catch(() => {});
  } catch {
    // non-fatal — never block the list
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    let domains = await getDomainsStore().listDomains(tenantId);
    // Populate day-one defaults from GLOBAL the first time a tenant has none.
    if (domains.length === 0) {
      await copyGlobalDomainDefaults(tenantId);
      domains = await getDomainsStore().listDomains(tenantId);
    }
    // Hide the internal seed-marker doc from the API response.
    domains = domains.filter(
      (d: any) => d?.id !== '__seeded__' && d?.kind !== 'domains-seed-marker',
    );
    return NextResponse.json({ ok: true, domains });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    return apiServerError(e);
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
  // Domain-aware routing registry (item-create topology). subscriptionIds[0] is
  // the primary DLZ sub; sanitize to trimmed, non-empty GUIDs/strings.
  const subscriptionIds = Array.isArray(body.subscriptionIds)
    ? body.subscriptionIds.map((x: unknown) => String(x).trim()).filter((x: string) => x.length > 0)
    : undefined;
  const dlzResourceGroup =
    typeof body.dlzResourceGroup === 'string' && body.dlzResourceGroup.trim()
      ? body.dlzResourceGroup.trim()
      : undefined;
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
        subscriptionIds,
        dlzResourceGroup,
      },
      who,
    );
    await writeDomainAudit(tenantId, who, 'create', { domainId: domain.id, name });
    return NextResponse.json({ ok: true, domain }, { status: 201 });
  } catch (e: any) {
    if (e instanceof DomainsBackendGateError)
      return NextResponse.json({ ok: false, error: e.message, gate: e.backend }, { status: 501 });
    return apiServerError(e);
  }
}

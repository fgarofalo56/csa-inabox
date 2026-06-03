/**
 * What a "domain" is in Loom
 * --------------------------
 * A domain is a governance-scoped, labeled grouping of data products and
 * workspaces (Finance, Operations, Mission-Ops…). It carries owners, a
 * description, and a color, and is the unit Loom uses to organize the
 * tenant's data estate — the same concept Microsoft Purview calls a
 * "business domain" and Fabric calls a "domain". Adding a domain here
 * creates that grouping in the Loom Cosmos store immediately; workspaces
 * tag themselves to it via their `domain` field, and the governance layer
 * (Purview) can mirror it as a business domain when Purview is provisioned.
 *
 * GET  /api/admin/domains — list tenant domains (+ Purview link status when configured)
 * POST /api/admin/domains   body: { id, name, description?, color?, owners? }
 * DELETE /api/admin/domains?id=...
 *
 * Backed by Cosmos tenant-settings container under id="domains:<tenantId>"
 * to avoid spinning up a new container for a low-cardinality list. The
 * Purview business-domain mirror is honest-gated: when LOOM_PURVIEW_ACCOUNT
 * is unset we still return the Cosmos domains and a `purview.gated` flag
 * explaining the one-time provisioning step.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { listBusinessDomains, PurviewNotConfiguredError } from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DomainItem {
  id: string;
  name: string;
  description?: string;
  color?: string;
  owners?: string[];
  purviewDomainId?: string;
  createdAt: string;
  createdBy: string;
}

interface DomainsDoc {
  id: string;
  tenantId: string;
  kind: 'domains';
  items: DomainItem[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string, _who: string): Promise<DomainsDoc> {
  const c = await tenantSettingsContainer();
  const docId = `domains:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DomainsDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: DomainsDoc = {
    id: docId, tenantId, kind: 'domains', items: [],
    updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

/**
 * Resolve the Purview business-domain mirror state. Returns either the list
 * of Purview business-domain names (so the UI can show which Cosmos domains
 * are also governed in Purview) or an honest gate describing the one-time
 * provisioning step. Never throws — Purview is optional.
 */
async function purviewStatus(): Promise<
  | { configured: true; domains: Array<{ id?: string; name: string }> }
  | { configured: false; gated: true; hint: string }
> {
  try {
    const domains = await listBusinessDomains();
    return {
      configured: true,
      domains: (domains || []).map((d: any) => ({ id: d.id, name: d.name || d.displayName })),
    };
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return {
        configured: false,
        gated: true,
        hint:
          'Microsoft Purview is not provisioned in this deployment. Domains created here live in the Loom Cosmos store and organize workspaces today. To also govern them, set LOOM_PURVIEW_ACCOUNT (admin-plane/main.bicep apps[] env) and deploy with purviewEnabled=true — the account is provisioned by platform/fiab/bicep/modules/admin-plane/catalog.bicep, and the Console UAMI is granted the Purview Data Map data-plane roles automatically by the csa-loom-post-deploy-bootstrap workflow. NOTE: classic Purview Data Map (what Loom uses) has no "business domains" — that is a NEW unified-catalog concept and is not ARM-provisionable; Loom maps domains to Atlas collections/assets instead.',
      };
    }
    // Any other Purview error (auth, transient) is still non-fatal here.
    return {
      configured: false,
      gated: true,
      hint: `Purview business domains unavailable: ${e?.message || String(e)}`,
    };
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const purview = await purviewStatus();
    return NextResponse.json({ ok: true, domains: doc.items, updatedAt: doc.updatedAt, purview });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

function normalizeOwners(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const out = raw.map((o) => String(o).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  if (typeof raw === 'string') {
    const out = raw.split(/[,;\n]/).map((o) => o.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = (body?.name || '').toString().trim();
  if (!id || !name) return NextResponse.json({ ok: false, error: 'id and name required' }, { status: 400 });
  try {
    const c = await tenantSettingsContainer();
    const docId = `domains:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    if (doc.items.some((d) => d.id === id)) {
      return NextResponse.json({ ok: false, error: `domain '${id}' already exists` }, { status: 409 });
    }
    doc.items.push({
      id, name,
      description: body?.description || undefined,
      color: body?.color || undefined,
      owners: normalizeOwners(body?.owners),
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domain: doc.items[doc.items.length - 1], domains: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });
  try {
    const c = await tenantSettingsContainer();
    const docId = `domains:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.items.length;
    doc.items = doc.items.filter((d) => d.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domains: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

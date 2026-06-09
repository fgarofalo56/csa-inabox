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
 * GET  /api/admin/domains — list tenant domains (+ per-domain workspace count +
 *                            Purview link status when configured)
 * POST /api/admin/domains   body: { id, name, description?, color?, owners?, admins?, parentId? }
 * PATCH /api/admin/domains?id=...  body: subset of mutable fields (settings side-pane)
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
import { tenantSettingsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  listBusinessDomains,
  createBusinessDomain,
  updateBusinessDomain,
  deleteBusinessDomain,
  domainCollectionName,
  isPurviewConfigured,
  PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DomainContributors {
  scope: 'AllTenant' | 'AdminsOnly' | 'SpecificUsersAndGroups';
  users?: string[];
}

interface DomainDelegatedSettings {
  defaultSensitivityLabelId?: string;
  defaultSensitivityLabelName?: string;
  /** Whether the label id refers to a Loom-native label (vs an M365/MIP label). */
  defaultSensitivityLabelSource?: 'mip' | 'loom';
  certificationEnabled?: boolean;
  certificationUrl?: string;
  certifiers?: string[];
}

interface DomainItem {
  id: string;
  name: string;
  description?: string;
  color?: string;
  owners?: string[];
  /** Domain admins (UPNs / group names) — can change domain settings. */
  admins?: string[];
  /** Who may assign workspaces to this domain. */
  contributors?: DomainContributors;
  /** Users/groups for default-domain auto-assign. */
  defaultDomainUsers?: string[];
  /** Tenant-setting overrides delegated to the domain level. */
  delegatedSettings?: DomainDelegatedSettings;
  /** Image picker selection: "color::#0078d4" | "icon::finance" | "blob::<name>". */
  imageKey?: string;
  /** Parent domain id when this is a subdomain. */
  parentId?: string;
  purviewDomainId?: string;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
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
  | { configured: false; gated: false; hint: string }
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
        gated: false,
        hint:
          "Purview mirror inactive — domains live in Loom's Cosmos store and fully work. To also mirror them in Purview, set LOOM_PURVIEW_ACCOUNT (admin-plane/main.bicep apps[] env) and deploy with purviewEnabled=true. NOTE: classic Purview Data Map has no \"business domains\"; Loom maps domains to Atlas collections/assets instead.",
      };
    }
    // Any other Purview error (auth, transient) is still non-fatal here.
    return {
      configured: false,
      gated: false,
      hint: `Purview mirror unavailable: ${e?.message || String(e)}. Domains are stored in Loom and work offline.`,
    };
  }
}

/**
 * Workspace counts per domain — a Cosmos GROUP BY over the workspaces
 * container's `domain` field, scoped to the tenant partition. Returns an
 * empty map (never throws) when the workspaces container is unreachable so
 * the domain list still renders. Matches the count Fabric shows beside each
 * domain on the Domains tab.
 */
async function workspaceCounts(tenantId: string): Promise<Record<string, number>> {
  try {
    const wsC = await workspacesContainer();
    const { resources } = await wsC.items.query<{ domain?: string; n: number }>({
      query: 'SELECT c.domain AS domain, COUNT(1) AS n FROM c WHERE c.tenantId = @t GROUP BY c.domain',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const out: Record<string, number> = {};
    for (const r of resources) if (r.domain) out[r.domain] = r.n;
    return out;
  } catch {
    return {};
  }
}

/**
 * Is the caller a Fabric/tenant-level admin (vs a domain-scoped admin)?
 * Tenant admins may change a domain's name and admin list; domain admins
 * may not (mirrors Fabric's role rules). When neither LOOM_TENANT_ADMIN_OID
 * nor LOOM_TENANT_ADMIN_GROUP_ID is configured, the whole console is already
 * admin-gated, so every authenticated session is treated as a tenant admin.
 */
function isTenantAdmin(oid: string): boolean {
  const adminOids = (process.env.LOOM_TENANT_ADMIN_OID || '')
    .split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const adminGroup = (process.env.LOOM_TENANT_ADMIN_GROUP_ID || '').trim();
  if (adminOids.length === 0 && !adminGroup) return true;
  return adminOids.includes((oid || '').toLowerCase());
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const [purview, counts] = await Promise.all([purviewStatus(), workspaceCounts(tenantId)]);
    const domains = doc.items.map((d) => ({ ...d, workspaceCount: counts[d.id] || 0 }));
    return NextResponse.json({
      ok: true, domains, updatedAt: doc.updatedAt, purview,
      isTenantAdmin: isTenantAdmin(s.claims.oid),
      imageStorageConfigured: !!process.env.LOOM_DOMAIN_IMAGE_STORAGE,
    });
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
    const newItem: DomainItem = {
      id, name,
      description: body?.description || undefined,
      color: body?.color || undefined,
      owners: normalizeOwners(body?.owners),
      admins: normalizeOwners(body?.admins),
      parentId: body?.parentId ? String(body.parentId).trim() : undefined,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    };
    // A subdomain must reference an existing parent (Fabric parity: subdomains
    // hang off a domain). Reject a dangling parentId rather than silently
    // creating an orphan.
    if (newItem.parentId && !doc.items.some((d) => d.id === newItem.parentId)) {
      return NextResponse.json({ ok: false, error: `parent domain '${newItem.parentId}' not found` }, { status: 400 });
    }
    // Best-effort Purview mirror: a Loom domain ⇄ a Purview collection on the
    // classic Data Map account. Never blocks the Cosmos write (Purview is
    // optional); a grant/auth error is surfaced in `purviewMirror` for the UI.
    let purviewMirror: { ok: boolean; id?: string; error?: string } | undefined;
    if (isPurviewConfigured()) {
      try {
        // A subdomain mirrors as a CHILD collection under its parent's
        // collection (Fabric/Purview parity). The parent's ≤36-char collection
        // referenceName is derived deterministically from the parent's Loom id,
        // so it resolves even if the parent was mirrored in an earlier request.
        const mirrored = await createBusinessDomain({
          id, name, description: newItem.description,
          parentId: newItem.parentId ? domainCollectionName(newItem.parentId) : undefined,
        });
        newItem.purviewDomainId = mirrored.id;
        purviewMirror = { ok: true, id: mirrored.id };
      } catch (e: any) {
        purviewMirror = { ok: false, error: e?.message || String(e) };
      }
    }
    doc.items.push(newItem);
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domain: newItem, domains: doc.items, purviewMirror });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/domains?id=...
 *
 * Settings side-pane writer. Body carries any subset of the mutable fields:
 *   { name?, description?, color?, imageKey?, admins?, owners?,
 *     contributors?: { scope, users? },
 *     defaultDomainUsers?: string[],
 *     delegatedSettings?: { defaultSensitivityLabelId?, defaultSensitivityLabelName?,
 *                           defaultSensitivityLabelSource?, certificationEnabled?,
 *                           certificationUrl?, certifiers? } }
 *
 * Authorization (mirrors Fabric role rules):
 *   - Tenant/Fabric admin -> may change anything, including `name` and `admins`.
 *   - Domain admin (UPN in domain.admins) -> may change everything EXCEPT `name`
 *     and `admins` (Fabric: domain admins can't rename or change admin list).
 *   - Anyone else -> 403.
 */
export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const c = await tenantSettingsContainer();
    const docId = `domains:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const idx = doc.items.findIndex((d) => d.id === id);
    if (idx < 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const domain = doc.items[idx];

    const upn = (s.claims.upn || '').toLowerCase();
    const tenantAdmin = isTenantAdmin(s.claims.oid);
    const domainAdmin = (domain.admins || []).some((a) => a.toLowerCase() === upn);
    if (!tenantAdmin && !domainAdmin) {
      return NextResponse.json(
        { ok: false, error: 'Only a tenant admin or an admin of this domain may change its settings.' },
        { status: 403 },
      );
    }
    // Fields only a tenant admin may change.
    if (!tenantAdmin && (body?.name !== undefined || body?.admins !== undefined)) {
      return NextResponse.json(
        { ok: false, error: "Domain admins can't change the domain name or admin list - that requires a tenant admin." },
        { status: 403 },
      );
    }

    // Merge only the provided fields.
    if (typeof body?.name === 'string' && body.name.trim()) domain.name = body.name.trim();
    if (body?.description !== undefined) domain.description = String(body.description || '').trim() || undefined;
    if (body?.color !== undefined) domain.color = String(body.color || '').trim() || undefined;
    if (body?.imageKey !== undefined) domain.imageKey = String(body.imageKey || '').trim() || undefined;
    if (body?.admins !== undefined) domain.admins = normalizeOwners(body.admins);
    if (body?.owners !== undefined) domain.owners = normalizeOwners(body.owners);
    if (body?.defaultDomainUsers !== undefined) domain.defaultDomainUsers = normalizeOwners(body.defaultDomainUsers);
    if (body?.contributors !== undefined) {
      const scope = body.contributors?.scope;
      const allowed = ['AllTenant', 'AdminsOnly', 'SpecificUsersAndGroups'];
      if (!allowed.includes(scope)) {
        return NextResponse.json({ ok: false, error: `contributors.scope must be one of ${allowed.join(', ')}` }, { status: 400 });
      }
      domain.contributors = {
        scope,
        users: scope === 'SpecificUsersAndGroups' ? normalizeOwners(body.contributors?.users) : undefined,
      };
    }
    if (body?.delegatedSettings !== undefined) {
      const ds = body.delegatedSettings || {};
      const cur = domain.delegatedSettings || {};
      domain.delegatedSettings = {
        ...cur,
        ...(ds.defaultSensitivityLabelId !== undefined ? { defaultSensitivityLabelId: String(ds.defaultSensitivityLabelId || '').trim() || undefined } : {}),
        ...(ds.defaultSensitivityLabelName !== undefined ? { defaultSensitivityLabelName: String(ds.defaultSensitivityLabelName || '').trim() || undefined } : {}),
        ...(ds.defaultSensitivityLabelSource !== undefined ? { defaultSensitivityLabelSource: ds.defaultSensitivityLabelSource === 'loom' ? 'loom' : 'mip' } : {}),
        ...(ds.certificationEnabled !== undefined ? { certificationEnabled: !!ds.certificationEnabled } : {}),
        ...(ds.certificationUrl !== undefined ? { certificationUrl: String(ds.certificationUrl || '').trim() || undefined } : {}),
        ...(ds.certifiers !== undefined ? { certifiers: normalizeOwners(ds.certifiers) } : {}),
      };
    }

    domain.updatedAt = new Date().toISOString();
    domain.updatedBy = s.claims.upn || tenantId;
    doc.items[idx] = domain;
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    // Best-effort: mirror name/description edits to the Purview classic
    // collection (PUT /collections is an idempotent create-or-update — there is
    // no PATCH for collections). Re-asserts the parent so a subdomain's mirror
    // keeps its place in the collection hierarchy. Never blocks the Cosmos write
    // (Purview is optional); a grant/auth error surfaces in `purviewMirror`.
    let purviewMirror: { ok: boolean; error?: string } | undefined;
    if (
      isPurviewConfigured() && domain.purviewDomainId &&
      (body?.name !== undefined || body?.description !== undefined)
    ) {
      try {
        await updateBusinessDomain(domain.id, {
          name: domain.name,
          description: domain.description,
          parentId: domain.parentId ? domainCollectionName(domain.parentId) : undefined,
        });
        purviewMirror = { ok: true };
      } catch (e: any) {
        purviewMirror = { ok: false, error: e?.message || String(e) };
      }
    }
    return NextResponse.json({ ok: true, domain, purviewMirror });
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
    const removed = doc.items.find((d) => d.id === id);
    doc.items = doc.items.filter((d) => d.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Best-effort: remove the mirrored Purview collection too. Non-fatal.
    let purviewMirror: { ok: boolean; error?: string } | undefined;
    if (isPurviewConfigured() && removed?.purviewDomainId) {
      try { await deleteBusinessDomain(removed.purviewDomainId); purviewMirror = { ok: true }; }
      catch (e: any) { purviewMirror = { ok: false, error: e?.message || String(e) }; }
    }
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domains: doc.items, purviewMirror });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

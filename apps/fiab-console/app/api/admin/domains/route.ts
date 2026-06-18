/**
 * What a "domain" is in Loom
 * --------------------------
 * A domain is a governance-scoped, labeled grouping of data products and
 * workspaces (Finance, Operations, Mission-Ops…). It carries owners, a
 * description, and a color, and is the unit Loom uses to organize the
 * tenant's data estate — the same concept Microsoft Purview calls a
 * "business domain" and Fabric calls a "domain".
 *
 * UNIFIED MAPPING (this route): a Loom domain is written through to BOTH
 * governance back-ends in parallel by lib/azure/unified-domain-mapper:
 *   • Microsoft Purview classic Data Map — domain ⇄ COLLECTION, subdomain ⇄
 *     child collection. Create / rename / re-describe / MOVE / delete.
 *   • Databricks Unity Catalog — root domain ⇄ CATALOG, subdomain ⇄ SCHEMA
 *     under the parent's catalog. Create / re-comment / delete (UC has no
 *     reparent — surfaced honestly).
 * Cosmos (`tenant-settings` doc `domains:<tenant>`) stays AUTHORITATIVE; both
 * mirrors are best-effort and never block the write. NO Fabric dependency —
 * both back-ends are Azure-native and independently optional.
 *
 * GET   /api/admin/domains — list tenant domains (+ workspace count + Purview &
 *                            Unity Catalog link status when configured)
 * POST  /api/admin/domains   body: { id, name, description?, color?, owners?, admins?, parentId? }
 * PATCH /api/admin/domains?id=...  body: subset of mutable fields, incl. `parentId` (MOVE)
 * DELETE /api/admin/domains?id=...
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  listBusinessDomains,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import {
  mirrorDomainUpsert,
  mirrorDomainMove,
  mirrorDomainDelete,
  unityLinkStatus,
  unityName,
  type UnifiedMirrorResult,
  type UnityLinkStatus,
} from '@/lib/azure/unified-domain-mapper';
import { validateDomainMove } from '@/lib/azure/domain-hierarchy';
import {
  type DomainItem,
  type DomainsDoc,
  loadOrSeedDomains,
  parseTopologyPatch,
  domainChargebackTag,
} from '@/lib/azure/domain-registry';
import {
  resolveDomainTier,
  isTenantAdminTier,
  type DomainTier,
  type DomainTierDomain,
} from '@/lib/auth/domain-role';
import {
  provisionDomainGroups,
  domainGroupProvisioningEnabled,
  DomainGroupError,
} from '@/lib/azure/domain-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadOrSeed(tenantId: string, who: string): Promise<DomainsDoc> {
  return loadOrSeedDomains(tenantId, who);
}

/**
 * Resolve the Purview business-domain mirror state. Returns either the list
 * of Purview business-domain names (so the UI can show which Cosmos domains
 * are also governed in Purview) or an honest gate describing the one-time
 * provisioning step. Never throws — Purview is optional.
 */
async function purviewStatus(): Promise<
  | { configured: true; domains: Array<{ id?: string; name: string }> }
  | { configured: false; gated: boolean; hint: string }
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
    // 401/403 from the Data Map data-plane = the account is reachable but the
    // Console UAMI lacks a Data Map data-plane role on the root collection
    // (classic metadata-policy, NOT ARM RBAC) — the "Not authorized to access
    // account" 403. Surface it as an HONEST GATE naming the exact role to grant
    // so the page never shows a raw error; domains still render from Loom.
    if (e instanceof PurviewError && (e.status === 401 || e.status === 403)) {
      return {
        configured: false,
        gated: true,
        hint:
          'Purview is provisioned, but the Loom Console managed identity lacks a Microsoft Purview Data Map ' +
          'data-plane role on the root collection (it answered ' + e.status + ', "Not authorized to access account"). ' +
          'Grant the Console UAMI Data Curator (read/write) — or at minimum Data Reader (read-only) — on the ROOT ' +
          'collection via scripts/csa-loom/grant-purview-datamap-role.sh (run by the csa-loom-post-deploy-bootstrap ' +
          'workflow), then refresh. Classic Data Map roles are collection metadata-policy, NOT ARM RBAC, so they ' +
          'cannot be set in bicep. Domains continue to work from Loom’s Cosmos store in the meantime.',
      };
    }
    // Any other Purview error (transient, DNS, token) is still non-fatal here.
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

/** Is a given Loom domain mirrored into the Unity Catalog metastore? */
function unityLinkedFor(d: DomainItem, unity: UnityLinkStatus): boolean {
  if (!unity.configured) return false;
  if (d.parentId) {
    const cat = unityName(d.parentId);
    return (unity.schemasByCatalog[cat] || []).includes(unityName(d.id));
  }
  return unity.catalogs.includes(unityName(d.id));
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    // Catalog names this tenant's domains actually map to (root → its own
    // catalog; subdomain → its parent's catalog). Passed to unityLinkStatus so
    // it only fans out schema-list calls for domain-derived catalogs instead of
    // every catalog in the metastore (avoids a per-load N+1 against Databricks).
    const domainCatalogs = Array.from(
      new Set(doc.items.map((d) => (d.parentId ? unityName(d.parentId) : unityName(d.id)))),
    );
    const [purview, counts, unity] = await Promise.all([
      purviewStatus(), workspaceCounts(tenantId), unityLinkStatus(domainCatalogs),
    ]);
    const purviewNames = new Set(
      purview.configured ? purview.domains.map((d) => (d.name || '').toLowerCase()) : [],
    );
    // D2 tier per domain for the calling session: tenant-admin / domain-admin /
    // domain-contributor / null. Drives the tier badge on /admin/permissions and
    // the domain-picker filtering on /workspaces. The Graph fallback inside
    // resolveDomainTier only fires for the >200-group claim-overage case, so for
    // the common (claim-present) caller this is a pure in-memory pass.
    const tiers = await Promise.all(
      doc.items.map((d) => resolveDomainTier(s, d as DomainTierDomain)),
    );
    const domains = doc.items.map((d, i) => ({
      ...d,
      workspaceCount: counts[d.id] || 0,
      purviewLinked: purviewNames.has((d.name || '').toLowerCase()),
      unityLinked: unityLinkedFor(d, unity),
      callerTier: tiers[i] as DomainTier,
    }));
    return NextResponse.json({
      ok: true, domains, updatedAt: doc.updatedAt, purview, unity,
      isTenantAdmin: isTenantAdminTier(s),
      domainGroupProvisioning: domainGroupProvisioningEnabled(),
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

/** Apply the mirror ids returned by the unified mapper onto the stored item. */
function applyMirrorIds(item: DomainItem, mirror: UnifiedMirrorResult): void {
  if (mirror.purview.ok && !mirror.purview.skipped) {
    item.purviewDomainId = item.purviewDomainId || item.id;
  }
  if (mirror.unity.ok && !mirror.unity.skipped) {
    if (mirror.unity.catalog) item.unityCatalogName = mirror.unity.catalog;
    if (mirror.unity.schema) item.unitySchemaName = mirror.unity.schema;
  }
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
    const parentId = body?.parentId ? String(body.parentId).trim() : undefined;
    // A subdomain must reference an existing parent (Fabric parity). Reject a
    // dangling parentId rather than silently creating an orphan, and forbid
    // nesting under a subdomain (domains are at most two levels: domain →
    // subdomain — matches UC catalog→schema and Fabric "subdomains only").
    if (parentId) {
      const parent = doc.items.find((d) => d.id === parentId);
      if (!parent) {
        return NextResponse.json({ ok: false, error: `parent domain '${parentId}' not found` }, { status: 400 });
      }
      if (parent.parentId) {
        return NextResponse.json(
          { ok: false, error: 'A subdomain cannot itself contain subdomains — domains are at most two levels (domain → subdomain).' },
          { status: 400 },
        );
      }
    }
    const newItem: DomainItem = {
      id, name,
      description: body?.description || undefined,
      color: body?.color || undefined,
      owners: normalizeOwners(body?.owners),
      admins: normalizeOwners(body?.admins),
      adminGroupId: typeof body?.adminGroupId === 'string' && body.adminGroupId.trim() ? body.adminGroupId.trim() : undefined,
      memberGroupId: typeof body?.memberGroupId === 'string' && body.memberGroupId.trim() ? body.memberGroupId.trim() : undefined,
      parentId,
      status: 'registered',
      chargebackTag: domainChargebackTag(id),
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    };
    // DLZ binding / topology fields are tenant-admin-only (they bind real Azure
    // subscriptions + Entra groups). A non-tenant-admin creating a domain simply
    // omits them; the domain is still created in `registered` status.
    if (isTenantAdminTier(s)) {
      const topo = parseTopologyPatch(body);
      if ('error' in topo) {
        return NextResponse.json({ ok: false, error: topo.error }, { status: 400 });
      }
      Object.assign(newItem, topo.patch);
    }

    // Optional: auto-provision the per-domain Entra security-group pair (admins +
    // contributors) when the caller asks AND the deployment has the Graph
    // Group.ReadWrite.All grant (LOOM_DOMAIN_GROUP_PROVISIONING=true). Honest gate:
    // a missing grant returns 503 with the exact remediation rather than a silent
    // skip — but only when the caller explicitly requested provisioning. Tenant
    // admins only (domains-tier changes are tenant-admin-only, Fabric parity).
    let groupProvisioning: { ok: boolean; detail?: string } | undefined;
    if (body?.provisionGroups === true) {
      if (!isTenantAdminTier(s)) {
        return NextResponse.json(
          { ok: false, error: 'Only a tenant admin may provision domain Entra groups.' },
          { status: 403 },
        );
      }
      try {
        const pair = await provisionDomainGroups({ domainId: id, domainName: name, ownerObjectId: s.claims.oid });
        newItem.adminGroupId = pair.adminGroupId;
        newItem.memberGroupId = pair.contributorGroupId;
        groupProvisioning = { ok: true, detail: 'Provisioned admin + contributor Entra security groups.' };
      } catch (e: any) {
        if (e instanceof DomainGroupError) {
          // Honest gate: surface remediation but STILL create the domain (it works
          // without backing groups via the legacy admins[]/contributors model).
          groupProvisioning = { ok: false, detail: e.remediation || e.message };
        } else {
          groupProvisioning = { ok: false, detail: e?.message || String(e) };
        }
      }
    }
    // Unified write-through to Purview + Unity Catalog (best-effort; neither
    // blocks the Cosmos write — both are independently optional, no Fabric dep).
    const mirror = await mirrorDomainUpsert(
      { id, name, description: newItem.description, parentId }, 'create',
    );
    applyMirrorIds(newItem, mirror);
    doc.items.push(newItem);
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domain: newItem, domains: doc.items, mirror, groupProvisioning });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/domains?id=...
 *
 * Settings side-pane writer + MOVE. Body carries any subset of the mutable
 * fields, plus the move verb:
 *   { name?, description?, color?, imageKey?, admins?, owners?,
 *     contributors?: { scope, users? }, defaultDomainUsers?: string[],
 *     delegatedSettings?: {...},
 *     parentId?: string | null   ← MOVE: reparent the domain (null/'' → root) }
 *
 * Authorization (mirrors Fabric role rules):
 *   - Tenant/Fabric admin -> may change anything, including `name`, `admins`,
 *     and `parentId` (move).
 *   - Domain admin (UPN in domain.admins) -> may change everything EXCEPT
 *     `name`, `admins`, and `parentId`.
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

    const tenantAdmin = isTenantAdminTier(s);
    // D2 tier resolution (Entra group + legacy UPN list, cached on the session
    // claim with a Graph fallback for group-overage). Replaces the prior
    // UPN-only `domain.admins[]` match so domain admins identified by their
    // Entra `adminGroupId` are recognized too.
    const tier = await resolveDomainTier(s, domain as DomainTierDomain);
    const domainAdmin = tier === 'domain-admin';
    if (!tenantAdmin && !domainAdmin) {
      return NextResponse.json(
        { ok: false, error: 'Only a tenant admin or an admin of this domain may change its settings.' },
        { status: 403 },
      );
    }
    // Fields only a tenant admin may change. The DLZ-binding/topology fields
    // (subscriptionIds, dlzRg, location, capacitySku, admin/memberGroupId,
    // costCenter, chargebackTag, status) bind real Azure subscriptions + Entra
    // groups, so they are tenant-admin-only alongside name/admins/parentId.
    const TOPOLOGY_KEYS = [
      'subscriptionIds', 'dlzRg', 'location', 'capacitySku',
      'adminGroupId', 'memberGroupId', 'costCenter', 'chargebackTag', 'status',
    ];
    const touchesTopology = TOPOLOGY_KEYS.some((k) => body?.[k] !== undefined);
    if (!tenantAdmin && (body?.name !== undefined || body?.admins !== undefined || body?.parentId !== undefined || touchesTopology)) {
      return NextResponse.json(
        { ok: false, error: "Domain admins can't rename, change the admin list, move the domain, or change its Data Landing Zone binding - that requires a tenant admin." },
        { status: 403 },
      );
    }

    // --- MOVE (reparent) validation ------------------------------------------
    let moved = false;
    let newParentId: string | undefined = domain.parentId;
    if (body?.parentId !== undefined) {
      newParentId = body.parentId === null || String(body.parentId).trim() === ''
        ? undefined : String(body.parentId).trim();
      if (newParentId !== domain.parentId) {
        // Shared two-level hierarchy invariants (self-parent, missing target,
        // cycle, two-level cap) — identical to PATCH /api/governance/domains.
        const moveErr = validateDomainMove(doc.items, id, newParentId);
        if (moveErr) {
          return NextResponse.json({ ok: false, error: moveErr.message }, { status: moveErr.status });
        }
        moved = true;
      }
    }

    // Merge only the provided fields.
    if (typeof body?.name === 'string' && body.name.trim()) domain.name = body.name.trim();
    if (body?.description !== undefined) domain.description = String(body.description || '').trim() || undefined;
    if (body?.color !== undefined) domain.color = String(body.color || '').trim() || undefined;
    if (body?.imageKey !== undefined) domain.imageKey = String(body.imageKey || '').trim() || undefined;
    if (body?.admins !== undefined) domain.admins = normalizeOwners(body.admins);
    if (body?.owners !== undefined) domain.owners = normalizeOwners(body.owners);
    if (body?.defaultDomainUsers !== undefined) domain.defaultDomainUsers = normalizeOwners(body.defaultDomainUsers);
    // DLZ binding / topology fields (tenant-admin-only; gated above). The Entra
    // admin/member group bindings (adminGroupId/memberGroupId) flow through
    // parseTopologyPatch alongside the DLZ subscription/region/SKU fields.
    if (touchesTopology) {
      const topo = parseTopologyPatch(body);
      if ('error' in topo) {
        return NextResponse.json({ ok: false, error: topo.error }, { status: 400 });
      }
      Object.assign(domain, topo.patch);
      // Keep the chargeback tag canonical when a sub is bound and none was set.
      if (domain.subscriptionIds && domain.subscriptionIds.length && !domain.chargebackTag) {
        domain.chargebackTag = domainChargebackTag(domain.id);
      }
    }
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
    if (moved) domain.parentId = newParentId;

    domain.updatedAt = new Date().toISOString();
    domain.updatedBy = s.claims.upn || tenantId;
    doc.items[idx] = domain;
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    // Unified mirror: a MOVE reparents the Purview collection (UC has no move →
    // honest note); any other edit re-asserts name/description on both back-ends.
    let mirror: UnifiedMirrorResult | undefined;
    const spec = { id: domain.id, name: domain.name, description: domain.description, parentId: domain.parentId };
    if (moved) {
      mirror = await mirrorDomainMove({ ...spec, parentId: undefined }, newParentId);
    } else if (body?.name !== undefined || body?.description !== undefined) {
      mirror = await mirrorDomainUpsert(spec, 'update');
    }
    if (mirror) applyMirrorIds(domain, mirror);
    return NextResponse.json({ ok: true, domain, mirror, moved });
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
    const removed = doc.items.find((d) => d.id === id);
    if (!removed) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Block deleting a parent that still has subdomains (would orphan them).
    if (doc.items.some((d) => d.parentId === id)) {
      return NextResponse.json(
        { ok: false, error: 'Delete or move this domain’s subdomains first.' },
        { status: 409 },
      );
    }
    doc.items = doc.items.filter((d) => d.id !== id);
    // Unified mirror cleanup (best-effort, never throws).
    const mirror = await mirrorDomainDelete({
      id: removed.id, name: removed.name, description: removed.description, parentId: removed.parentId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domains: doc.items, mirror });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

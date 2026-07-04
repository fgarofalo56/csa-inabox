/**
 * GET /api/onelake/catalog
 *
 * Serves the OneLake catalog **Explore** tab: a tenant-scoped workspace tree,
 * a paginated/filtered data-asset list, real facet counts, and the domain list
 * for the domain selector. This replaces the hardcoded ITEMS/DOMAINS constants
 * that used to live in lib/panes/onelake-catalog.tsx.
 *
 * Azure-native is the DEFAULT (per .claude/rules/no-fabric-dependency.md). The
 * route never touches a Fabric / OneLake REST host on its default path:
 *
 *   Path A — AI Search (default when LOOM_AI_SEARCH_SERVICE is set):
 *            queries the `loom-governance-items` index via
 *            searchGovernanceCatalog() — real facets + discoverability filter.
 *            The workspace tree + domain list come from Cosmos (sovereign-safe).
 *
 *   Path B — Cosmos-only fallback (LOOM_AI_SEARCH_SERVICE unset):
 *            queries itemsContainer() directly (same query the governance route
 *            uses), filters to catalog data types, and computes facets locally.
 *            Returns `searchGate` naming LOOM_AI_SEARCH_SERVICE + ai-search.bicep
 *            so the UI can render an honest Fluent MessageBar (no-vaporware).
 *
 *   Path C — Fabric REST (OPT-IN only, LOOM_CATALOG_BACKEND=fabric):
 *            calls listOneLakeWorkspaces() + listAllOneLakeItems(). Gated by
 *            assertFabricFamilyAvailable('fabric') so GCC-High/IL5/DoD get an
 *            honest, actionable error instead of a silent 401 against a
 *            Commercial host. This is NEVER the default.
 *
 * No mocks, no return [] placeholders — every path hits a real backend or
 * returns an honest gate. No new lib files; every backing symbol already exists.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  workspacesContainer,
  itemsContainer,
} from '@/lib/azure/cosmos-client';
import {
  isGovernanceCatalogSearchConfigured,
  searchGovernanceCatalog,
  isCatalogDataType,
  type GovernanceCatalogHit,
  type FacetBucket,
} from '@/lib/azure/governance-catalog-index';
import {
  listOneLakeWorkspaces,
  listAllOneLakeItems,
  type OneLakeItem,
} from '@/lib/azure/onelake-catalog-client';
import { assertFabricFamilyAvailable } from '@/lib/azure/cloud-endpoints';
import { getDomainsStore } from '@/lib/azure/domains-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A catalog item shaped for the Explore table (cloud/backend-invariant). */
interface CatalogItemOut {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  itemType: string;
  displayName: string;
  owner?: string;
  updatedAt?: string;
  endorsement?: string;
  sensitivity?: string;
  domainId?: string;
  isDiscoverable?: boolean;
}

interface WorkspaceNodeOut {
  id: string;
  name: string;
  domain?: string;
  /** Workspace owner (UPN of the principal who created/registered it). */
  owner?: string;
}

interface CatalogFacetsOut {
  itemType?: FacetBucket[];
  endorsement?: FacetBucket[];
  sensitivity?: FacetBucket[];
  domainId?: FacetBucket[];
}

/** Honest infra-gate hint surfaced when AI Search isn't deployed. */
function cosmosSearchGate() {
  return {
    missingEnvVar: 'LOOM_AI_SEARCH_SERVICE',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/ai-search.bicep',
    followUp:
      'Catalog items + workspace tree are served from Azure-native Cosmos without ' +
      'AI Search. To enable full-text search and real facet counts, deploy ' +
      'ai-search.bicep, set LOOM_AI_SEARCH_SERVICE in admin-plane/main.bicep ' +
      "apps[] env list, then run /api/admin/governance-catalog/reindex once.",
  };
}

function shapeSearchHit(h: GovernanceCatalogHit): CatalogItemOut {
  return {
    id: h.id,
    workspaceId: h.workspaceId,
    workspaceName: h.workspaceName,
    itemType: h.itemType,
    displayName: h.displayName,
    owner: h.ownerUpn || h.owner,
    updatedAt: h.updatedAt,
    endorsement: h.endorsement,
    sensitivity: h.sensitivity,
    domainId: h.domainId,
    isDiscoverable: h.isDiscoverable,
  };
}

function shapeCosmosItem(
  i: any,
  wsMap: Map<string, { id: string; name: string; domain?: string; owner?: string }>,
): CatalogItemOut {
  const st = i.state || {};
  const endorsement = (st.endorsement || (st.certified ? 'Certified' : undefined)) as string | undefined;
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    workspaceName: wsMap.get(i.workspaceId)?.name,
    itemType: i.itemType,
    displayName: i.displayName,
    owner: st.ownerUpn || st.contact || st.steward || i.createdBy || undefined,
    updatedAt: i.updatedAt || i.createdAt,
    endorsement,
    sensitivity: st.sensitivityLabel || undefined,
    domainId: st.domainId || wsMap.get(i.workspaceId)?.domain || undefined,
    isDiscoverable: st.discoverable === true || !!endorsement,
  };
}

function shapeOneLakeItem(i: OneLakeItem): CatalogItemOut {
  // Fabric REST does not return endorsement / sensitivity / domain — those are
  // Loom/Azure-native governance overlays. Left undefined (the UI renders a dash).
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    workspaceName: i.workspaceName,
    itemType: i.type || 'Item',
    displayName: i.displayName,
    owner: i.createdBy || undefined,
    updatedAt: i.updatedAt,
  };
}

/** O(n) local facet count over a Cosmos item slice (Path B — no AI Search). */
function buildCosmosLocalFacets(items: CatalogItemOut[]): CatalogFacetsOut {
  const count = (sel: (i: CatalogItemOut) => string | undefined): FacetBucket[] => {
    const m = new Map<string, number>();
    for (const it of items) {
      const v = sel(it);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([value, c]) => ({ value, count: c }))
      .sort((a, b) => b.count - a.count);
  };
  return {
    itemType: count((i) => i.itemType),
    endorsement: count((i) => i.endorsement),
    sensitivity: count((i) => i.sensitivity),
    domainId: count((i) => i.domainId),
  };
}

export async function GET(request: Request) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || '';
  const domainId = searchParams.get('domainId') || undefined;
  const itemType = searchParams.get('itemType') || undefined;
  const endorsement = searchParams.get('endorsement') || undefined;
  const sensitivity = searchParams.get('sensitivity') || undefined;
  const skip = Math.max(0, Number(searchParams.get('skip') || 0) || 0);
  const top = Math.min(Math.max(1, Number(searchParams.get('top') || 100) || 100), 200);

  const backend = (process.env.LOOM_CATALOG_BACKEND || 'azure').toLowerCase();

  try {
    // ── Domain list (Cosmos via DomainStore — sovereign-safe, no Fabric REST) ──
    let domains: Array<{ id: string; name: string }> = [];
    try {
      const raw = await getDomainsStore().listDomains(s.claims.oid);
      domains = raw.map((d) => ({ id: d.id, name: d.name }));
    } catch {
      // A missing domains store must not break the catalog list — domains are
      // an optional facet, not a hard dependency.
      domains = [];
    }

    // ── Path C: Fabric REST (OPT-IN only) ────────────────────────────────────
    if (backend === 'fabric') {
      // Throws an honest, actionable error in GCC-High/IL5/DoD (never a silent
      // 401 against a Commercial host).
      assertFabricFamilyAvailable('fabric');
      const ws = await listOneLakeWorkspaces();
      const allItems = await listAllOneLakeItems(ws);
      const ql = q.toLowerCase();
      const filtered = allItems.filter((i) => {
        if (ql &&
            !i.displayName.toLowerCase().includes(ql) &&
            !(i.type || '').toLowerCase().includes(ql)) return false;
        if (itemType && i.type !== itemType) return false;
        return true;
      });
      const items = filtered.map(shapeOneLakeItem);
      return NextResponse.json({
        ok: true,
        backend: 'fabric',
        workspaces: ws.map<WorkspaceNodeOut>((w) => ({
          id: w.id,
          name: w.displayName,
          domain: w.capacityId,
        })),
        items: items.slice(skip, skip + top),
        total: items.length,
        facets: buildCosmosLocalFacets(items),
        domains,
        searchConfigured: false,
      });
    }

    // ── Workspace tree (always Cosmos on the Azure-native default path) ───────
    // Single-partition read: the workspaces container is partitioned by
    // /tenantId, so scoping the query with partitionKey: s.claims.oid keeps this
    // off the cross-partition fan-out path. `c.createdBy` projects the real
    // workspace owner into the tree (Fabric parity — the catalog sidebar shows
    // who administers each workspace).
    const wsC = await workspacesContainer();
    const { resources: workspaces } = await wsC.items
      .query(
        {
          query: 'SELECT c.id, c.name, c.domain, c.createdBy FROM c WHERE c.tenantId = @t',
          parameters: [{ name: '@t', value: s.claims.oid }],
        },
        { partitionKey: s.claims.oid },
      )
      .fetchAll();

    const wsMap = new Map<string, { id: string; name: string; domain?: string; owner?: string }>(
      workspaces.map((w: any) => [w.id, { id: w.id, name: w.name, domain: w.domain, owner: w.createdBy }]),
    );
    const callerWorkspaceIds = Array.from(wsMap.keys());
    const workspaceNodes = workspaces.map<WorkspaceNodeOut>((w: any) => ({
      id: w.id,
      name: w.name,
      domain: w.domain,
      owner: w.createdBy,
    }));

    // ── Path A: AI Search (Azure-native DEFAULT) ─────────────────────────────
    if (isGovernanceCatalogSearchConfigured()) {
      const result = await searchGovernanceCatalog({
        q,
        tenantId: s.claims.oid,
        callerWorkspaceIds,
        callerHasAllAccess: false,
        domainId,
        itemType,
        endorsement,
        sensitivity,
        top,
        skip,
      });
      // searchGovernanceCatalog only returns null when AI Search is unconfigured,
      // which the guard above already excludes — but stay defensive.
      if (result) {
        return NextResponse.json({
          ok: true,
          backend: 'aisearch',
          workspaces: workspaceNodes,
          items: result.hits.map(shapeSearchHit),
          total: result.total,
          facets: {
            itemType: result.facets.itemType,
            endorsement: result.facets.endorsement,
            sensitivity: result.facets.sensitivity,
            domainId: result.facets.domainId,
          },
          domains,
          searchConfigured: true,
        });
      }
    }

    // ── Path B: Cosmos-only fallback (AI Search not deployed) ─────────────────
    if (callerWorkspaceIds.length === 0) {
      return NextResponse.json({
        ok: true,
        backend: 'cosmos',
        workspaces: [],
        items: [],
        total: 0,
        facets: {},
        domains,
        searchConfigured: false,
        searchGate: cosmosSearchGate(),
      });
    }

    // Partition-safe fan-out: the items container is partitioned by
    // /workspaceId, so issue ONE single-partition read per workspace (scoped by
    // partitionKey) in parallel rather than a single cross-partition
    // ARRAY_CONTAINS scan that fans across every physical partition. This keeps
    // RU cost flat as the tenant's workspace/item count grows. Per-workspace
    // failures are isolated (a workspace the UAMI can't read never aborts the
    // whole catalog).
    const itC = await itemsContainer();
    const perWorkspace = await Promise.all(
      callerWorkspaceIds.map(async (wsId) => {
        try {
          const { resources } = await itC.items
            .query(
              {
                query:
                  'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.createdBy, c.updatedAt, c.createdAt, c.state FROM c WHERE c.workspaceId = @ws',
                parameters: [{ name: '@ws', value: wsId }],
              },
              { partitionKey: wsId },
            )
            .fetchAll();
          return resources;
        } catch {
          return [] as any[];
        }
      }),
    );
    const rawItems = perWorkspace.flat();

    const ql = q.toLowerCase();
    const shaped = rawItems
      .filter((i: any) => isCatalogDataType(i.itemType))
      .map((i: any) => shapeCosmosItem(i, wsMap))
      .filter((i) => !ql || i.displayName.toLowerCase().includes(ql) || i.itemType.toLowerCase().includes(ql))
      .filter((i) => !domainId || i.domainId === domainId)
      .filter((i) => !itemType || i.itemType === itemType)
      .filter((i) => !endorsement || i.endorsement === endorsement)
      .filter((i) => !sensitivity || i.sensitivity === sensitivity)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return NextResponse.json({
      ok: true,
      backend: 'cosmos',
      workspaces: workspaceNodes,
      items: shaped.slice(skip, skip + top),
      total: shaped.length,
      facets: buildCosmosLocalFacets(shaped),
      domains,
      searchConfigured: false,
      searchGate: cosmosSearchGate(),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

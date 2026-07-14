/**
 * domain-mesh — the READ side of the federated data-mesh (issue #1483 Wave 4).
 *
 * The per-domain mirror (unified-domain-mapper) and the whole-tree reconciler
 * (domain-sync) are the mesh's WRITE side — they propagate a Loom domain out to
 * Purview collections + Unity Catalog. THIS module is the read/aggregation side:
 * given the tenant's authoritative Loom domain hierarchy, it computes each
 * domain's FEDERATED FOOTPRINT across every governance surface, rolled up over
 * the domain's whole subtree (a parent domain owns everything under it):
 *
 *   • Catalog       — workspaces tagged to the domain (or a descendant) + the
 *                     data items inside them (Cosmos `workspaces.domain` +
 *                     `items.workspaceId`).
 *   • Purview       — the classic Data Map collection the domain mirrors to
 *                     (configured / honest-gate).
 *   • Unity Catalog — the UC catalog (root) / schema (descendant) the domain
 *                     mirrors to, and whether it is present in the metastore.
 *   • Lineage       — whether the domain's assets can be traced end-to-end: a
 *                     lineage source (Purview Data Map and/or Unity Catalog) is
 *                     configured AND the domain has catalog assets to trace.
 *                     Lineage graphs are computed per-asset (unified-lineage);
 *                     this reports the domain-scoped CAPABILITY, honestly, not a
 *                     fabricated edge count.
 *   • Landing zone  — the bound DLZ subscription(s) + status from the registry.
 *
 * Every surface is honest-gated (no-vaporware.md): an unconfigured back-end
 * reports `configured:false` + the exact remediation, never a fake number. No
 * Fabric dependency — every surface is Azure-native and independently optional.
 *
 * Loom (Cosmos) stays authoritative; this module only READS and never mutates.
 */
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOrSeedDomains, type DomainItem } from '@/lib/azure/domain-registry';
import { rootAncestorId } from '@/lib/azure/domain-hierarchy';
import { unityName, unityLinkStatus } from '@/lib/azure/unified-domain-mapper';
import { isPurviewConfigured, domainCollectionName } from '@/lib/azure/purview-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One governance surface's presence for a domain. */
export interface MeshSurface {
  /** Is the backing service configured/reachable at all? */
  configured: boolean;
  /** Is THIS domain actually present in the surface right now? */
  present: boolean;
  /** The remote identifier the domain maps to (collection / catalog[.schema]). */
  target?: string;
  /** Honest remediation when unconfigured / not present. */
  hint?: string;
}

export interface DomainMeshRow {
  id: string;
  name: string;
  parentId?: string;
  depth: number;
  /** Workspaces tagged directly to this domain. */
  directWorkspaces: number;
  /** Workspaces tagged to this domain OR any descendant (subtree rollup). */
  rolledWorkspaces: number;
  /** Catalog items inside the rolled-up workspaces. */
  rolledItems: number;
  purview: MeshSurface;
  unity: MeshSurface;
  /** Domain-scoped lineage capability (a source is configured + assets exist). */
  lineage: MeshSurface;
  /** DLZ binding status from the registry. */
  landingZone: { status: string; subscriptions: number };
}

export interface DomainMeshResult {
  ranAt: string;
  domainCount: number;
  /** Fabric-wide surface configuration (drives the top-level honest gates). */
  surfaces: {
    catalog: { configured: boolean; workspaces: number; items: number; hint?: string };
    purview: { configured: boolean; hint?: string };
    unity: { configured: boolean; hint?: string };
    lineage: { configured: boolean; sources: string[]; hint?: string };
  };
  rows: DomainMeshRow[];
}

// ---------------------------------------------------------------------------
// Cosmos probes (best-effort — never throw)
// ---------------------------------------------------------------------------

/** workspaceId → domain id, plus a per-domain direct workspace count. */
async function readWorkspaceTags(
  tenantId: string,
): Promise<{ configured: boolean; wsToDomain: Map<string, string>; total: number; hint?: string }> {
  try {
    const c = await workspacesContainer();
    const { resources } = await c.items
      .query<{ id: string; domain?: string }>(
        {
          query: 'SELECT c.id, c.domain FROM c WHERE c.tenantId = @t',
          parameters: [{ name: '@t', value: tenantId }],
        },
        { partitionKey: tenantId },
      )
      .fetchAll();
    const wsToDomain = new Map<string, string>();
    for (const w of resources) if (w.id && w.domain) wsToDomain.set(w.id, w.domain);
    return { configured: true, wsToDomain, total: resources.length };
  } catch (e: any) {
    return { configured: false, wsToDomain: new Map(), total: 0, hint: `Workspace store unreachable: ${e?.message || String(e)}.` };
  }
}

/** workspaceId → item count (cross-partition GROUP BY; best-effort). */
async function readItemCounts(): Promise<Map<string, number>> {
  try {
    const c = await itemsContainer();
    const { resources } = await c.items
      .query<{ w?: string; n: number }>({
        query: 'SELECT c.workspaceId AS w, COUNT(1) AS n FROM c GROUP BY c.workspaceId',
      })
      .fetchAll();
    const m = new Map<string, number>();
    for (const r of resources) if (r.w) m.set(r.w, r.n);
    return m;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Descendant-inclusive subtree ids for every domain (id → set incl. self). */
function subtrees(items: DomainItem[]): Map<string, Set<string>> {
  const childrenOf = new Map<string, string[]>();
  for (const d of items) if (d.parentId) {
    const arr = childrenOf.get(d.parentId) || [];
    arr.push(d.id);
    childrenOf.set(d.parentId, arr);
  }
  const out = new Map<string, Set<string>>();
  for (const d of items) {
    const set = new Set<string>([d.id]);
    const stack = [d.id];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const k of childrenOf.get(cur) || []) if (!set.has(k)) { set.add(k); stack.push(k); }
    }
    out.set(d.id, set);
  }
  return out;
}

function depthOf(items: DomainItem[], id: string): number {
  const byId = new Map(items.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let n = 1;
  let cur = byId.get(id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
    if (!cur) break;
    n += 1;
  }
  return n;
}

/**
 * Compute the federated mesh footprint for every Loom domain in the tenant.
 * Reads only (never mutates). Each surface degrades to an honest gate when its
 * back-end is unconfigured.
 */
export async function getDomainMesh(tenantId: string, who: string): Promise<DomainMeshResult> {
  const doc = await loadOrSeedDomains(tenantId, who);
  const items = doc.items;

  const [wsTags, itemCounts, unity] = await Promise.all([
    readWorkspaceTags(tenantId),
    readItemCounts(),
    unityLinkStatus(Array.from(new Set(items.map((d) => unityName(rootAncestorId(items, d.id)))))),
  ]);

  const purviewConfigured = isPurviewConfigured();
  const purviewHint = purviewConfigured
    ? undefined
    : 'Purview mirror inactive — set LOOM_PURVIEW_ACCOUNT and deploy with purviewEnabled=true to mirror domains as Data Map collections.';
  const unityHint = unity.configured ? undefined : unity.hint;

  // Lineage is derived from the SAME sources (Purview Data Map + Unity Catalog).
  // A domain's lineage is traceable when at least one source is configured.
  const lineageSources: string[] = [];
  if (purviewConfigured) lineageSources.push('Purview Data Map');
  if (unity.configured) lineageSources.push('Unity Catalog');
  const lineageConfigured = lineageSources.length > 0;
  const lineageHint = lineageConfigured
    ? undefined
    : 'No lineage source configured — set LOOM_PURVIEW_ACCOUNT (Data Map lineage) and/or LOOM_DATABRICKS_HOSTNAME (Unity Catalog lineage) to trace a domain’s assets end-to-end.';

  // Direct-domain workspace counts + items per domain (before rollup).
  const directWsByDomain = new Map<string, number>();
  const directItemsByDomain = new Map<string, number>();
  for (const [wsId, domainId] of wsTags.wsToDomain) {
    directWsByDomain.set(domainId, (directWsByDomain.get(domainId) || 0) + 1);
    directItemsByDomain.set(domainId, (directItemsByDomain.get(domainId) || 0) + (itemCounts.get(wsId) || 0));
  }

  const subs = subtrees(items);
  const rows: DomainMeshRow[] = items.map((d) => {
    const subtree = subs.get(d.id) || new Set([d.id]);
    let rolledWs = 0;
    let rolledItems = 0;
    for (const sub of subtree) {
      rolledWs += directWsByDomain.get(sub) || 0;
      rolledItems += directItemsByDomain.get(sub) || 0;
    }
    const isSub = !!d.parentId;
    const catalog = unityName(rootAncestorId(items, d.id));
    const schema = isSub ? unityName(d.id) : undefined;
    const ucTarget = isSub ? `${catalog}.${schema}` : catalog;
    const ucPresent = unity.configured
      ? isSub
        ? (unity.schemasByCatalog[catalog] || []).includes(schema as string)
        : unity.catalogs.includes(catalog)
      : false;
    const collName = domainCollectionName(d.id);

    return {
      id: d.id,
      name: d.name,
      parentId: d.parentId,
      depth: depthOf(items, d.id),
      directWorkspaces: directWsByDomain.get(d.id) || 0,
      rolledWorkspaces: rolledWs,
      rolledItems,
      purview: {
        configured: purviewConfigured,
        present: purviewConfigured, // classic Data Map: the collection is asserted by the mirror
        target: purviewConfigured ? collName : undefined,
        hint: purviewHint,
      },
      unity: {
        configured: unity.configured,
        present: ucPresent,
        target: unity.configured ? ucTarget : undefined,
        hint: unity.configured
          ? ucPresent
            ? undefined
            : 'Not yet mirrored — run Governance sync to create the UC catalog/schema.'
          : unityHint,
      },
      lineage: {
        configured: lineageConfigured,
        // Traceable when a source is configured AND the domain has assets to trace.
        present: lineageConfigured && rolledItems > 0,
        target: lineageConfigured ? lineageSources.join(' + ') : undefined,
        hint: !lineageConfigured
          ? lineageHint
          : rolledItems === 0
            ? 'No catalog assets in this domain yet — lineage appears once workspaces/items are assigned.'
            : undefined,
      },
      landingZone: { status: d.status || 'registered', subscriptions: d.subscriptionIds?.length || 0 },
    };
  });

  return {
    ranAt: new Date().toISOString(),
    domainCount: items.length,
    surfaces: {
      catalog: {
        configured: wsTags.configured,
        workspaces: wsTags.total,
        items: Array.from(itemCounts.values()).reduce((a, b) => a + b, 0),
        hint: wsTags.hint,
      },
      purview: { configured: purviewConfigured, hint: purviewHint },
      unity: { configured: unity.configured, hint: unityHint },
      lineage: { configured: lineageConfigured, sources: lineageSources, hint: lineageHint },
    },
    rows,
  };
}

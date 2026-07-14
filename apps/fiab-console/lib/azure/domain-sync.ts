/**
 * domain-sync — the whole-hierarchy Purview ↔ Loom ↔ Unity Catalog reconciler.
 *
 * The per-domain mirror (lib/azure/unified-domain-mapper) already writes a
 * single create/update/move/delete through to Purview + UC as the admin edits a
 * domain. THIS module is the sweep: given the tenant's ENTIRE Loom domain
 * hierarchy (the authoritative Cosmos `domains:<tenantId>` doc), it reconciles
 * every domain to BOTH governance back-ends in one pass and reports per-target
 * status + drift — so an admin who provisioned Purview/UC after creating domains
 * (or whose earlier per-edit mirror was skipped because a back-end was
 * unconfigured) can bring everything into line with one button.
 *
 * Loom is AUTHORITATIVE. Reconcile is one-directional (Loom → targets) and
 * ADDITIVE:
 *   • `apply:false` (default) → a DRY RUN: read remote state, compute what would
 *     change, mutate nothing.
 *   • `apply:true` → upsert each Loom domain into each configured target
 *     (idempotent: Purview collection PUT, UC catalog/schema create-or-present),
 *     roots before subdomains so parents exist first.
 *
 * NEVER destructive: a target entity that exists remotely but no longer maps to
 * a Loom domain (an orphan / hand-created collection or schema) is REPORTED as
 * drift and LEFT UNTOUCHED — this reconciler never deletes remote governance
 * objects. Deletes only happen through the explicit per-domain delete path.
 *
 * No Fabric dependency: both targets are Azure-native (Purview Data Map + Azure
 * Databricks Unity Catalog) and each is independently optional. An unconfigured
 * target yields an honest hint, never an error, and the sweep still runs against
 * whichever target IS configured.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { loadOrSeedDomains, type DomainItem } from '@/lib/azure/domain-registry';
import { rootAncestorId } from '@/lib/azure/domain-hierarchy';
import {
  mirrorDomainUpsert,
  unityName,
  type UnifiedDomainSpec,
} from '@/lib/azure/unified-domain-mapper';
import {
  listCollections,
  domainCollectionName,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import {
  databricksConfigGate,
  listUcCatalogs,
  listUcSchemas,
} from '@/lib/azure/databricks-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of reconciling one domain against one target. */
export type DomainTargetState =
  | 'mirrored' // already present remotely (dry-run) — nothing to do
  | 'created' // created/asserted this run (apply)
  | 'missing' // absent remotely (dry-run) — would be created on apply
  | 'error' // the upsert or probe failed
  | 'skipped'; // target unconfigured

export interface DomainTargetResult {
  state: DomainTargetState;
  /** The remote identifier this domain maps to (collection / catalog[.schema]). */
  target?: string;
  detail?: string;
  error?: string;
}

export interface DomainSyncRow {
  id: string;
  name: string;
  parentId?: string;
  purview: DomainTargetResult;
  unity: DomainTargetResult;
}

/** A remote governance object with no matching Loom domain — reported, never deleted. */
export interface DriftEntry {
  target: 'purview' | 'unity';
  /** 'collection' | 'catalog' | 'schema'. */
  kind: string;
  name: string;
  note: string;
}

export interface TargetSummary {
  configured: boolean;
  /** True when the account is provisioned but the Console identity lacks a role. */
  gated?: boolean;
  hint?: string;
  mirrored: number;
  created: number;
  missing: number;
  errors: number;
}

export interface DomainSyncResult {
  /** Whether this run mutated the targets (apply) or was a dry run. */
  applied: boolean;
  ranAt: string;
  ranBy: string;
  domainCount: number;
  purview: TargetSummary;
  unity: TargetSummary;
  rows: DomainSyncRow[];
  /** Remote objects with no Loom owner — surfaced, never deleted. */
  drift: DriftEntry[];
}

// ---------------------------------------------------------------------------
// Remote-state probes (best-effort — never throw)
// ---------------------------------------------------------------------------

interface PurviewState {
  configured: boolean;
  gated?: boolean;
  hint?: string;
  /** Lower-cased Purview collection referenceNames present (excluding the root). */
  collections: Set<string>;
  /** The root collection referenceName (never treated as a Loom domain). */
  rootName?: string;
}

async function probePurview(): Promise<PurviewState> {
  if (!isPurviewConfigured()) {
    return {
      configured: false,
      collections: new Set(),
      hint:
        "Purview mirror inactive — domains live in Loom's Cosmos store and fully work. To also mirror " +
        'them as Purview Data Map collections, set LOOM_PURVIEW_ACCOUNT (admin-plane/main.bicep apps[] env) ' +
        'and deploy with purviewEnabled=true.',
    };
  }
  try {
    const cols = await listCollections();
    const root = cols.find((c) => !c.parentCollection);
    const nonRoot = cols.filter((c) => c.parentCollection && c.name);
    return {
      configured: true,
      rootName: root?.name?.toLowerCase(),
      collections: new Set(nonRoot.map((c) => (c.name || '').toLowerCase())),
    };
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return { configured: false, collections: new Set(), hint: e.message };
    }
    if (e instanceof PurviewError && (e.status === 401 || e.status === 403)) {
      return {
        configured: false,
        gated: true,
        collections: new Set(),
        hint:
          'Purview is provisioned, but the Loom Console managed identity lacks a Purview Data Map data-plane ' +
          'role on the root collection (it answered ' + e.status + '). Grant the Console UAMI Data Curator on ' +
          'the ROOT collection via scripts/csa-loom/grant-purview-datamap-role.sh, then re-run the sync. ' +
          'Classic Data Map roles are collection metadata-policy, NOT ARM RBAC.',
      };
    }
    return {
      configured: false,
      collections: new Set(),
      hint: `Purview unreachable: ${e?.message || String(e)}. Domains keep working from Loom's Cosmos store.`,
    };
  }
}

interface UnityState {
  configured: boolean;
  hint?: string;
  /** Lower-cased UC catalog names present in the metastore. */
  catalogs: Set<string>;
  /** catalog → set of schema names present (lower-cased). */
  schemasByCatalog: Map<string, Set<string>>;
}

async function probeUnity(catalogAllow: string[]): Promise<UnityState> {
  if (databricksConfigGate() !== null) {
    return {
      configured: false,
      catalogs: new Set(),
      schemasByCatalog: new Map(),
      hint:
        'Unity Catalog mirror inactive — set LOOM_DATABRICKS_HOSTNAME (admin-plane/main.bicep apps[] env) and ' +
        'grant the Console UAMI CREATE CATALOG on the metastore to mirror domains as UC catalogs/schemas.',
    };
  }
  try {
    const catalogs = await listUcCatalogs();
    const names = new Set(catalogs.map((c) => (c.name || '').toLowerCase()).filter(Boolean));
    const schemasByCatalog = new Map<string, Set<string>>();
    // Only inspect schemas for catalogs the tenant's domains actually map to —
    // listing schemas for every catalog in the metastore is wasted round-trips.
    const allow = new Set(catalogAllow.map((n) => n.toLowerCase()).filter(Boolean));
    const toInspect = [...names].filter((n) => allow.has(n));
    await Promise.all(
      toInspect.map(async (cat) => {
        try {
          const schemas = await listUcSchemas(cat);
          schemasByCatalog.set(
            cat,
            new Set(
              schemas
                .map((s) => (s.name || '').toLowerCase())
                .filter((n) => n && n !== 'information_schema' && n !== 'default'),
            ),
          );
        } catch {
          schemasByCatalog.set(cat, new Set());
        }
      }),
    );
    return { configured: true, catalogs: names, schemasByCatalog };
  } catch (e: any) {
    return {
      configured: false,
      catalogs: new Set(),
      schemasByCatalog: new Map(),
      hint: `Unity Catalog unreachable: ${e?.message || String(e)}. Domains keep working from Loom's Cosmos store.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Shallowest first (roots, then their children, then grandchildren …) so a
 * parent collection/catalog always exists before its child is upserted. Deep
 * trees (#1483 Wave 2) need a true depth sort, not just root-vs-subdomain.
 */
function orderRootsFirst(items: DomainItem[]): DomainItem[] {
  const byId = new Map(items.map((d) => [d.id, d]));
  const depth = (d: DomainItem): number => {
    const seen = new Set<string>();
    let n = 1;
    let cur: DomainItem | undefined = d;
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId);
      if (!cur) break;
      n += 1;
    }
    return n;
  };
  return [...items].sort((a, b) => depth(a) - depth(b));
}

function emptySummary(configured: boolean, gated: boolean | undefined, hint?: string): TargetSummary {
  return { configured, gated, hint, mirrored: 0, created: 0, missing: 0, errors: 0 };
}

/**
 * Run the reconciler over the tenant's full domain hierarchy.
 * `apply:false` (default) is a non-mutating dry run.
 */
export async function runDomainSync(
  tenantId: string,
  who: string,
  opts: { apply?: boolean } = {},
): Promise<DomainSyncResult> {
  const apply = !!opts.apply;
  const doc = await loadOrSeedDomains(tenantId, who);
  const items = doc.items;
  const ordered = orderRootsFirst(items);

  // Catalogs the tenant's domains map to (every domain → its ROOT ancestor's
  // catalog), so the UC schema probe only fans out over relevant catalogs.
  const catalogAllow = Array.from(
    new Set(items.map((d) => unityName(rootAncestorId(items, d.id)))),
  );

  const [pv, uc] = await Promise.all([probePurview(), probeUnity(catalogAllow)]);

  const purview = emptySummary(pv.configured, pv.gated, pv.hint);
  const unity = emptySummary(uc.configured, undefined, uc.hint);
  const rows: DomainSyncRow[] = [];

  // Track which remote entities are claimed by a Loom domain, to compute drift.
  const claimedCollections = new Set<string>();
  const claimedSchemas = new Set<string>(); // `${catalog}.${schema}`
  const claimedCatalogs = new Set<string>();

  for (const d of ordered) {
    const isSub = !!d.parentId;
    // Root ancestor id backs the UC catalog for this domain's whole subtree
    // (deep trees flatten onto UC as root → catalog, descendants → schemas).
    const ucCatalogId = rootAncestorId(items, d.id);
    const spec: UnifiedDomainSpec = { id: d.id, name: d.name, description: d.description, parentId: d.parentId, ucCatalogId };

    // Expected remote identifiers (derived deterministically from the id).
    const collName = domainCollectionName(d.id).toLowerCase();
    claimedCollections.add(collName);
    const catalog = (isSub ? unityName(ucCatalogId) : unityName(d.id)).toLowerCase();
    const schema = isSub ? unityName(d.id).toLowerCase() : undefined;
    claimedCatalogs.add(catalog);
    if (schema) claimedSchemas.add(`${catalog}.${schema}`);

    let purviewRes: DomainTargetResult;
    let unityRes: DomainTargetResult;

    if (apply && (pv.configured || uc.configured)) {
      // Idempotent upsert into whichever target is configured.
      const mirror = await mirrorDomainUpsert(spec, 'create');
      purviewRes = pv.configured
        ? mirror.purview.ok
          ? { state: 'created', target: mirror.purview.purviewId || collName, detail: mirror.purview.detail }
          : { state: 'error', target: collName, error: mirror.purview.error }
        : { state: 'skipped', detail: pv.hint };
      unityRes = uc.configured
        ? mirror.unity.ok
          ? {
              state: 'created',
              target: mirror.unity.schema ? `${mirror.unity.catalog}.${mirror.unity.schema}` : mirror.unity.catalog,
              detail: mirror.unity.detail,
            }
          : { state: 'error', target: schema ? `${catalog}.${schema}` : catalog, error: mirror.unity.error }
        : { state: 'skipped', detail: uc.hint };
    } else {
      // Dry run: compare against the probed remote state.
      purviewRes = !pv.configured
        ? { state: 'skipped', detail: pv.hint }
        : pv.collections.has(collName)
          ? { state: 'mirrored', target: collName }
          : { state: 'missing', target: collName, detail: 'Not yet a Purview collection — sync will create it.' };

      if (!uc.configured) {
        unityRes = { state: 'skipped', detail: uc.hint };
      } else if (isSub) {
        const present = uc.schemasByCatalog.get(catalog)?.has(schema as string) ?? false;
        unityRes = present
          ? { state: 'mirrored', target: `${catalog}.${schema}` }
          : { state: 'missing', target: `${catalog}.${schema}`, detail: 'Not yet a UC schema — sync will create it.' };
      } else {
        const present = uc.catalogs.has(catalog);
        unityRes = present
          ? { state: 'mirrored', target: catalog }
          : { state: 'missing', target: catalog, detail: 'Not yet a UC catalog — sync will create it.' };
      }
    }

    tally(purview, purviewRes);
    tally(unity, unityRes);
    rows.push({ id: d.id, name: d.name, parentId: d.parentId, purview: purviewRes, unity: unityRes });
  }

  // ---- Drift: remote objects with no Loom owner (reported, NEVER deleted) ----
  const drift: DriftEntry[] = [];
  if (pv.configured) {
    for (const name of pv.collections) {
      if (name === pv.rootName) continue;
      if (!claimedCollections.has(name)) {
        drift.push({
          target: 'purview',
          kind: 'collection',
          name,
          note: 'Purview collection with no matching Loom domain — left untouched (this reconciler never deletes remote governance objects).',
        });
      }
    }
  }
  if (uc.configured) {
    // Only report extras UNDER Loom-managed catalogs (a catalog that maps to a
    // Loom root domain). Unrelated metastore catalogs are not Loom's to judge.
    for (const [cat, schemas] of uc.schemasByCatalog) {
      if (!claimedCatalogs.has(cat)) continue;
      for (const sc of schemas) {
        if (!claimedSchemas.has(`${cat}.${sc}`)) {
          drift.push({
            target: 'unity',
            kind: 'schema',
            name: `${cat}.${sc}`,
            note: 'UC schema under a Loom-managed catalog with no matching Loom subdomain — left untouched (reconciler never drops UC securables).',
          });
        }
      }
    }
  }

  return {
    applied: apply,
    ranAt: new Date().toISOString(),
    ranBy: who,
    domainCount: items.length,
    purview,
    unity,
    rows,
    drift,
  };
}

function tally(sum: TargetSummary, r: DomainTargetResult): void {
  switch (r.state) {
    case 'mirrored': sum.mirrored++; break;
    case 'created': sum.created++; break;
    case 'missing': sum.missing++; break;
    case 'error': sum.errors++; break;
    // 'skipped' is not counted — the target summary already carries configured:false.
  }
}

// ---------------------------------------------------------------------------
// Last-status persistence (Cosmos tenant-settings sidecar)
// ---------------------------------------------------------------------------

interface DomainSyncStatusDoc {
  id: string;
  tenantId: string;
  kind: 'domain-sync-status';
  result: DomainSyncResult;
  updatedAt: string;
}

function statusDocId(tenantId: string): string {
  return `domain-sync-status:${tenantId}`;
}

/** Persist the most recent reconcile result so the Domains page can show it on load. */
export async function saveDomainSyncStatus(tenantId: string, result: DomainSyncResult): Promise<void> {
  const c = await tenantSettingsContainer();
  const doc: DomainSyncStatusDoc = {
    id: statusDocId(tenantId),
    tenantId,
    kind: 'domain-sync-status',
    result,
    updatedAt: new Date().toISOString(),
  };
  await c.items.upsert(doc);
}

/** Read the last persisted reconcile result, or null when none has run. */
export async function loadDomainSyncStatus(tenantId: string): Promise<DomainSyncResult | null> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(statusDocId(tenantId), tenantId).read<DomainSyncStatusDoc>();
    return resource?.result ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

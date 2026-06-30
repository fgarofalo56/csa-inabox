/**
 * Purview auto-onboarding — every Loom item, when created, is best-effort
 * registered as a Microsoft Purview catalog asset (Atlas entity) so owners and
 * stewards see it in Governance + Catalog with lineage, ownership, and (after a
 * scan) classifications — without anyone manually registering it.
 *
 * Best-effort + non-blocking (called as `void autoOnboardToPurview(...)`, mirror
 * of the AI-Search `upsertLoomDoc` hook): a missing Purview account or a 403
 * never blocks or fails item creation. When `LOOM_PURVIEW_ACCOUNT` is unset the
 * call is a cheap no-op (no network).
 *
 * The Atlas entity uses a richer typeName per item type (see
 * `loomTypeToAtlasTypeName`) with `DataSet` as the universal fallback so every
 * item always registers successfully even when no specialised Atlas typedef
 * matches. Scan-based classification/tagging is a deeper follow-up; this
 * establishes the asset + ownership so it surfaces immediately.
 */
import {
  registerAtlasEntity,
  ensureClassificationDefs,
  deleteAtlasEntityByQualifiedName,
  registerDataSource,
  registerDatabricksUnityCatalogSource,
  upsertScan,
  triggerScanRun,
  deleteDataSource,
} from './purview-client';
import { scanRulesetName } from './purview-classification-sync';
import { dfsSuffix } from './cloud-endpoints';
import type { WorkspaceItem } from '@/lib/types/workspace';

/**
 * Stable `loom://` qualifiedName for an item's Purview Atlas entity. The same
 * value is used on onboard (create) and offboard (delete) so the two operate
 * on exactly one entity (Atlas dedupes on qualifiedName).
 */
function itemQualifiedName(item: WorkspaceItem, tenantId: string): string {
  return `loom://${tenantId}/${item.workspaceId}/${item.itemType}/${item.id}`;
}

/**
 * Map a Loom item type to the most specific Atlas typeName present on a
 * classic Microsoft Purview Data Map account.
 *
 * Rules:
 *   - Only use typeNames documented as built-in Atlas types on classic Data
 *     Map (no-vaporware: a fake typename creates the entity but breaks
 *     lineage-graph rendering).
 *   - `DataSet` is the Atlas base-type fallback — always present, always safe.
 *   - Fabric-specific typeNames (`fabric_*`) are included because the classic
 *     Data Map scanner ships them as built-in types even without a Fabric
 *     tenant being connected.
 *   - Non-data item types (notebooks, pipelines, reports, apps) fall through
 *     to `DataSet`; a `Process` entity is the correct Atlas type for pipelines
 *     at runtime but `DataSet` is fine for catalog registration.
 *
 * @see https://learn.microsoft.com/purview/concept-supported-data-stores
 */
export function loomTypeToAtlasTypeName(itemType: string): string {
  switch (itemType) {
    // ── Storage / lake ──────────────────────────────────────────────────────
    case 'lakehouse':          return 'fabric_lakehouse';
    case 'dataset':            return 'DataSet';
    case 'geo-dataset':        return 'DataSet';

    // ── Analytical stores ────────────────────────────────────────────────────
    case 'warehouse':          return 'fabric_warehouse';
    case 'kql-database':       return 'azure_data_explorer_database';
    case 'eventhouse':         return 'azure_data_explorer_database';
    case 'mirrored-database':  return 'DataSet';       // no dedicated built-in type

    // ── Relational / graph / vector ─────────────────────────────────────────
    case 'azure-sql-database': return 'azure_sql_db';
    case 'cosmos-gremlin-graph':return 'azure_cosmos_db';
    case 'cypher-graph':       return 'azure_cosmos_db';
    case 'gql-graph':          return 'azure_data_explorer_database'; // ADX-native
    case 'vector-store':       return 'azure_cognitive_search';

    // ── Semantic / reporting ─────────────────────────────────────────────────
    case 'semantic-model':     return 'DataSet';       // no built-in Atlas type
    case 'report':             return 'DataSet';

    // ── Data products ────────────────────────────────────────────────────────
    case 'data-product':       return 'DataSet';
    case 'data-product-instance': return 'DataSet';
    case 'data-product-template': return 'DataSet';

    // ── Everything else (pipelines, notebooks, apps, etc.) ──────────────────
    default:                   return 'DataSet';
  }
}

// ============================================================================
// Scan-source registration — so built-in classifications auto-detect.
//
// Registering the Atlas entity (above) surfaces the item in the catalog, but
// classifications (SSN / credit-card / address) only land once Purview *scans*
// the backing store. The block below additionally registers the item's real
// backing store (ADLS Gen2 / Azure SQL / Databricks Unity Catalog) as a Purview
// SCAN source, defines a scan bound to the tenant's custom ruleset (so system +
// Loom-custom classifications both apply), and — only when LOOM_PURVIEW_AUTOSCAN
// is enabled — triggers a run. Everything is best-effort and never blocks
// item creation.
// ============================================================================

/** A Purview scan-source mapping derived from a Loom item's backing store. */
export interface LoomScanSource {
  /** Stable, Loom-owned Purview data-source name (so offboard deletes only ours). */
  name: string;
  /** Purview connector kind. */
  kind: 'AdlsGen2' | 'AzureSqlDatabase' | 'AzureDatabricksUnityCatalog';
  /** Source `properties` (endpoint / serverEndpoint / metastoreId). */
  properties: Record<string, unknown>;
}

/** Sanitised, stable Purview data-source name Loom owns for an item. */
function loomSourceName(item: WorkspaceItem): string {
  const base = `loom-${item.itemType}-${item.id}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `loom-${item.id}`.slice(0, 60);
}

/**
 * Build an ADLS Gen2 source endpoint (`https://<account>.dfs.<suffix>/`) from
 * an `abfss://…` URI or any `<account>.dfs.<suffix>` host string. Returns
 * undefined when no `<account>.dfs.…` host can be parsed.
 */
function adlsEndpointFrom(s: string): string | undefined {
  const m = s.match(/([a-z0-9]+)\.(dfs\.[a-z0-9.]+?)(?:[/:?]|$)/i);
  if (!m) return undefined;
  return `https://${m[1].toLowerCase()}.${m[2].replace(/\.$/, '')}/`;
}

/**
 * Map a Loom item to its Purview scan source, or null for item types with no
 * scannable backing (notebooks, pipelines, reports, apps, …) — caller skips
 * those silently. Detection is value-driven (not a type allowlist), reading the
 * endpoints the provisioners stamp into item state / `provisioning.secondaryIds`:
 *   • an `abfss://` URI or `<account>.dfs.<suffix>` host → AdlsGen2
 *   • a UC `metastoreId`                                 → AzureDatabricksUnityCatalog
 *   • a `<server>.database.<suffix>` FQDN                → AzureSqlDatabase
 */
export function loomItemToScanSource(item: WorkspaceItem): LoomScanSource | null {
  const state = (item.state || {}) as Record<string, any>;
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, any>;
  const name = loomSourceName(item);

  // Candidate strings where backing endpoints are stamped (state + secondaryIds).
  const candidates: string[] = [];
  for (const v of Object.values(state)) if (typeof v === 'string') candidates.push(v);
  for (const v of Object.values(sec)) if (typeof v === 'string') candidates.push(v);

  // 1. ADLS Gen2 — an abfss:// URI or a *.dfs.<suffix> host.
  const adlsHint = candidates.find((s) => /^abfss:\/\//i.test(s) || /\.dfs\.[a-z0-9.]+/i.test(s));
  if (adlsHint) {
    const endpoint = adlsEndpointFrom(adlsHint);
    if (endpoint) return { name, kind: 'AdlsGen2', properties: { endpoint } };
  }
  // 1b. Lakehouse bound to an explicit external storage account name.
  if (typeof state.storageAccount === 'string' && state.storageAccount.trim()) {
    const acct = state.storageAccount.trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (acct) return { name, kind: 'AdlsGen2', properties: { endpoint: `https://${acct}.${dfsSuffix()}/` } };
  }

  // 2. Azure Databricks Unity Catalog — a metastore id.
  const metastoreId =
    (typeof state.metastoreId === 'string' && state.metastoreId.trim()) ||
    (typeof sec.metastoreId === 'string' && sec.metastoreId.trim()) ||
    '';
  if (metastoreId) {
    return { name, kind: 'AzureDatabricksUnityCatalog', properties: { metastoreId } };
  }

  // 3. Azure SQL Database — a *.database.<suffix> FQDN.
  const sqlFqdn = candidates
    .map((s) => s.match(/([a-z0-9-]+\.database\.(?:windows\.net|usgovcloudapi\.net))/i)?.[1])
    .find(Boolean);
  if (sqlFqdn) {
    return { name, kind: 'AzureSqlDatabase', properties: { endpoint: sqlFqdn, serverEndpoint: sqlFqdn } };
  }

  return null; // no scannable backing — skip silently
}

/** LOOM_PURVIEW_AUTOSCAN gate — default OFF (scan-cost control). */
function autoscanEnabled(): boolean {
  const v = (process.env.LOOM_PURVIEW_AUTOSCAN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Best-effort read→merge→replace of extra `state.*` keys onto the just-created
 * Cosmos item (mirror of the GUID write-back). Re-reads current state so it
 * preserves `purviewGuid` written moments earlier. Never throws.
 */
async function stampItemState(item: WorkspaceItem, patch: Record<string, unknown>): Promise<void> {
  if (!item.id || !item.workspaceId) return;
  try {
    const { itemsContainer } = await import('@/lib/azure/cosmos-client');
    const container = await itemsContainer();
    const { resource: current } = await container.item(item.id, item.workspaceId).read<WorkspaceItem>();
    if (!current) return;
    const next: WorkspaceItem = {
      ...current,
      state: { ...(current.state || {}), ...patch },
      updatedAt: new Date().toISOString(),
    };
    await container.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  } catch {
    /* best-effort state stamp — never block or surface an error */
  }
}

/**
 * Register the item's backing store as a Purview scan source + define a scan so
 * built-in + Loom-custom classifications auto-detect. Best-effort + non-blocking
 * (own try/catch — never throws into the create path). The scan trigger is gated
 * on LOOM_PURVIEW_AUTOSCAN (default OFF); when off the source is registered and
 * the scan defined, but no run is started.
 */
async function registerLoomItemAsScanSource(item: WorkspaceItem, tenantId: string): Promise<void> {
  try {
    const src = loomItemToScanSource(item);
    if (!src) return; // no scannable backing — silent skip

    // 1. Register the source (UC uses the dedicated helper; others the generic PUT).
    if (src.kind === 'AzureDatabricksUnityCatalog') {
      await registerDatabricksUnityCatalogSource({ name: src.name, metastoreId: String(src.properties.metastoreId) });
    } else {
      await registerDataSource({ name: src.name, kind: src.kind, properties: src.properties });
    }

    // Accumulate state stamps (source name always; scan name once defined) and
    // write them in a single read→merge→replace at the end.
    const patch: Record<string, unknown> = { purviewSourceName: src.name };

    // 2. Define + optionally trigger a scan. Only ruleset-driven kinds (ADLS
    //    Gen2 / Azure SQL) take the generic upsertScan — a UC scan additionally
    //    needs a SQL Warehouse HTTP path that can't be inferred at create time
    //    (the catalog/metastores flow owns UC scan-define), so UC registers the
    //    source only here.
    if (src.kind === 'AdlsGen2' || src.kind === 'AzureSqlDatabase') {
      const scanName = `${src.name}-scan`;
      const scanKind = `${src.kind}Msi`; // AdlsGen2Msi / AzureSqlDatabaseMsi (MI-first)
      let defined = false;
      try {
        // Bind the tenant's custom ruleset so Loom-custom + system classifications
        // both apply.
        await upsertScan({
          sourceName: src.name,
          scanName,
          kind: scanKind,
          scanRulesetName: scanRulesetName(tenantId, src.kind),
          scanRulesetType: 'Custom',
        });
        defined = true;
      } catch {
        // No tenant-custom ruleset synced yet → fall back to the built-in System
        // ruleset so the ~200 system classifications (SSN/credit-card/address)
        // still apply.
        try {
          await upsertScan({
            sourceName: src.name,
            scanName,
            kind: scanKind,
            scanRulesetName: src.kind,
            scanRulesetType: 'System',
          });
          defined = true;
        } catch {
          /* scan-define best-effort */
        }
      }
      if (defined) {
        patch.purviewScanName = scanName;
        // 3. Trigger only when autoscan is explicitly enabled (cost control).
        if (autoscanEnabled()) {
          try {
            // Scale the shared Purview SHIR VMSS up first if the scan runs on a
            // SelfHosted IR (no-op otherwise — prewarm guards internally).
            const { prewarmPurviewShirForScan } = await import('./shir-autoscale');
            await prewarmPurviewShirForScan(src.name, scanName);
            await triggerScanRun(src.name, scanName);
          } catch {
            /* scan-trigger best-effort */
          }
        }
      }
    }

    // 4. Persist the Loom-owned source (+ scan) name so offboard deletes only
    //    sources we registered.
    await stampItemState(item, patch);
  } catch {
    /* best-effort scan-source registration — never block or fail item creation */
  }
}

export async function autoOnboardToPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
    const state = (item.state || {}) as Record<string, unknown>;
    const raw = [
      ...(Array.isArray(state.classifications) ? (state.classifications as unknown[]) : []),
      ...(typeof state.sensitivityLabel === 'string' && state.sensitivityLabel ? [state.sensitivityLabel] : []),
    ].map((c) => String(c).trim()).filter(Boolean);
    const classifications = [...new Set(raw)];
    let withClass = classifications.length > 0;
    if (withClass) {
      // If the defs can't be created, still onboard the asset WITHOUT tags
      // rather than fail the whole registration.
      try { await ensureClassificationDefs(classifications); }
      catch { withClass = false; }
    }

    const typeName = loomTypeToAtlasTypeName(item.itemType);

    const upsertResult = await registerAtlasEntity({
      typeName,
      qualifiedName: itemQualifiedName(item, tenantId),
      displayName: item.displayName,
      owner: item.createdBy,
      comment: `Loom ${item.itemType}${item.description ? ` — ${item.description}` : ''}`,
      classifications: withClass ? classifications : undefined,
    });

    // Best-effort GUID write-back: stamp the Atlas GUID onto the Cosmos item's
    // state so the lineage drawer (guidFromItem) and edge-emit code can resolve
    // it without a separate Purview lookup. Isolated try/catch — a patch
    // failure MUST NOT undo the Atlas registration or surface an error.
    const guid = upsertResult.primaryGuid;
    if (guid && item.id && item.workspaceId) {
      try {
        const { itemsContainer } = await import('@/lib/azure/cosmos-client');
        const container = await itemsContainer();
        // Read → merge → replace (Cosmos SDK doesn't expose sparse PATCH for
        // nested paths in all versions; a full replace on the just-created item
        // is safe and avoids a separate PatchOperation dependency).
        const { resource: current } = await container
          .item(item.id, item.workspaceId)
          .read<WorkspaceItem>();
        if (current) {
          const next: WorkspaceItem = {
            ...current,
            state: { ...(current.state || {}), purviewGuid: guid },
            updatedAt: new Date().toISOString(),
          };
          await container.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
        }
      } catch {
        /* GUID write-back is best-effort — never block or surface an error */
      }
    }

    // Register the item's backing store as a Purview scan source + define a scan
    // so built-in classifications (SSN/credit-card/address) auto-detect. Best-
    // effort + non-blocking; the scan trigger is gated on LOOM_PURVIEW_AUTOSCAN.
    await registerLoomItemAsScanSource(item, tenantId);
  } catch {
    /* best-effort auto-onboard — never block or fail item creation */
  }
}

/**
 * Symmetric offboard hook — when a Loom item is deleted (hard-delete or
 * recycle-bin purge), best-effort soft-delete its Purview Atlas entity so the
 * external catalog graph reconciles in lock-step with Loom's own Weave edges
 * (`reconcileThreadEdgesOnDelete`). Mirror of `autoOnboardToPurview`:
 *
 *   • Cheap no-op when `LOOM_PURVIEW_ACCOUNT` is unset (no network).
 *   • Called as `void offboardFromPurview(...)` — a missing account, a 403, or
 *     a "not found" never blocks or fails the delete.
 *   • Uses the same stable `loom://` qualifiedName so exactly the entity that
 *     was onboarded is the one retired. Atlas flips status → DELETED and
 *     RETAINS the entity (not a purge), preserving lineage history — the
 *     faithful 1:1 of the portal "Delete asset" action.
 *   • The typeName used for delete must match the one used on registration;
 *     `loomTypeToAtlasTypeName` guarantees both use the same mapping.
 */
export async function offboardFromPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
    const typeName = loomTypeToAtlasTypeName(item.itemType);
    await deleteAtlasEntityByQualifiedName(typeName, itemQualifiedName(item, tenantId));
  } catch {
    /* best-effort offboard — never block or fail item deletion */
  }
  // Also retire the Loom-owned Purview scan source, if we registered one on
  // create (state.purviewSourceName stamped by registerLoomItemAsScanSource).
  // Separate try/catch so an Atlas-delete failure never skips the source delete.
  try {
    const state = (item.state || {}) as Record<string, unknown>;
    const sourceName = typeof state.purviewSourceName === 'string' ? state.purviewSourceName.trim() : '';
    if (sourceName) await deleteDataSource(sourceName);
  } catch {
    /* best-effort source delete — never block or fail item deletion */
  }
}

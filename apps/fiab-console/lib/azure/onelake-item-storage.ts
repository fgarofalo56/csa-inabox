/**
 * onelake-item-storage — resolve a Loom item's ADLS Gen2 location so the
 * OneLake item-size report can aggregate its blob bytes.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Fabric's "OneLake — Workspace storage" report attributes consumed bytes to
 * each item. Loom is Azure-native (no-fabric-dependency.md): item data lives in
 * the DLZ medallion ADLS Gen2 containers, not OneLake. Only items whose backend
 * is ADLS consume OneLake-equivalent storage:
 *
 *   - lakehouse        → <container>/lakehouses/<safeName>         (Delta + files)
 *   - mirrored-database→ bronze/mirrors/<workspaceId>/<itemId>     (ADF-CDC landing)
 *
 * warehouse (Synapse dedicated pool), kql-database / eventhouse (ADX), and
 * sql-database (Synapse) are NOT ADLS-backed — their storage is billed by the
 * compute service, so the report marks them `backend !== 'adls'` rather than
 * inventing a fake byte count.
 *
 * Resolution precedence (most-precise first):
 *   1. state.provisioning.secondaryIds.{container,rootPath}  (stamped at install)
 *   2. state.provisioning.resourceId  =  "<container>/<rootPath>"
 *   3. state.provisioning.secondaryIds.adlsRoot  (abfss://<c>@<acct>/<root>)
 *   4. Convention: lakehouses/<safeName(displayName)> across known containers,
 *      mirrors/<workspaceId>/<itemId> in bronze.
 *
 * The route then calls aggregatePrefixSize() against the resolved location.
 */

// The DLZ medallion containers, in the order the lakehouse provisioner prefers
// (landing → bronze first). Mirrors adls-client.KNOWN_CONTAINERS but inlined so
// this pure resolver carries no @azure/* import (keeps it unit-testable without
// the Azure SDK in the vitest harness).
const DLZ_CONTAINERS = ['landing', 'bronze', 'silver', 'gold', 'csv-imports'] as const;
type DlzContainer = (typeof DLZ_CONTAINERS)[number];

/** Item shape this module reads (a subset of the Cosmos item doc). */
export interface StorageItemLike {
  id: string;
  itemType: string;
  displayName: string;
  workspaceId: string;
  state?: Record<string, unknown> | null;
}

/** A resolved ADLS location for an item, or a reason it isn't ADLS-backed. */
export interface ItemAdlsLocation {
  /** 'adls' when the item stores bytes in the DLZ; otherwise the compute backend that bills its storage. */
  backend: 'adls' | 'synapse' | 'adx' | 'unknown';
  /** Container + prefix when backend === 'adls'. */
  container?: string;
  prefix?: string;
  /** Whether the prefix came from the stamped provisioning record (precise) or a naming convention (best-effort). */
  source: 'provisioning' | 'convention' | 'none';
}

/** Sanitise a display name to the same safe ADLS segment the lakehouse provisioner uses. */
export function safeAdlsSegment(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** Which item types store bytes in ADLS Gen2 (the rest are compute-backed). */
function backendFor(itemType: string): ItemAdlsLocation['backend'] {
  switch (itemType) {
    case 'lakehouse':
    case 'mirrored-database':
    case 'mirrored-databricks':
      return 'adls';
    case 'warehouse':
    case 'sql-database':
      return 'synapse';
    case 'kql-database':
    case 'eventhouse':
      return 'adx';
    default:
      return 'unknown';
  }
}

/** Parse an abfss://<container>@<account>.<host>/<root> URI into {container, prefix}. */
function parseAbfss(uri: string): { container: string; prefix: string } | null {
  const m = String(uri).match(/^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i);
  if (!m) return null;
  return { container: m[1], prefix: (m[2] || '').replace(/^\/+|\/+$/g, '') };
}

/**
 * Resolve an item's ADLS {container, prefix} for the storage report. Pure —
 * no network calls. Reads the stamped provisioning record first, then falls
 * back to the provisioner naming conventions.
 */
export function resolveItemAdlsLocation(item: StorageItemLike): ItemAdlsLocation {
  const backend = backendFor(item.itemType);
  if (backend !== 'adls') {
    return { backend, source: 'none' };
  }

  const state = (item.state || {}) as Record<string, any>;
  const prov = (state.provisioning || {}) as Record<string, any>;
  const sec = (prov.secondaryIds || {}) as Record<string, any>;

  // 1. Precise: stamped container + rootPath.
  if (typeof sec.container === 'string' && typeof sec.rootPath === 'string' && sec.rootPath) {
    return {
      backend: 'adls',
      container: sec.container,
      prefix: String(sec.rootPath).replace(/^\/+|\/+$/g, ''),
      source: 'provisioning',
    };
  }

  // 2. resourceId = "<container>/<rootPath…>"
  if (typeof prov.resourceId === 'string' && prov.resourceId.includes('/')) {
    const idx = prov.resourceId.indexOf('/');
    const container = prov.resourceId.slice(0, idx);
    const prefix = prov.resourceId.slice(idx + 1).replace(/^\/+|\/+$/g, '');
    if (container && prefix) {
      return { backend: 'adls', container, prefix, source: 'provisioning' };
    }
  }

  // 3. abfss adlsRoot (mirror + some lakehouse records).
  if (typeof sec.adlsRoot === 'string') {
    const parsed = parseAbfss(sec.adlsRoot);
    if (parsed?.container && parsed.prefix) {
      return { backend: 'adls', container: parsed.container, prefix: parsed.prefix, source: 'provisioning' };
    }
  }

  // 4. Convention fall-back (best-effort) — used when the install predates the
  //    provisioning stamp or the item was created out-of-band. The route probes
  //    these candidate {container, prefix} pairs and keeps the first that exists.
  return { backend: 'adls', source: 'convention' };
}

/**
 * Candidate {container, prefix} pairs to probe when no precise provisioning
 * record exists. The route tries each and keeps the first that materialises
 * (aggregatePrefixSize().exists === true).
 */
export function conventionCandidates(item: StorageItemLike): Array<{ container: string; prefix: string }> {
  const out: Array<{ container: string; prefix: string }> = [];
  if (item.itemType === 'mirrored-database' || item.itemType === 'mirrored-databricks') {
    out.push({ container: 'bronze', prefix: `mirrors/${item.workspaceId}/${item.id}` });
    return out;
  }
  if (item.itemType === 'lakehouse') {
    const safe = safeAdlsSegment(item.displayName) || item.id;
    // Provisioner prefers landing → bronze; DLZ_CONTAINERS is already in that order.
    for (const c of DLZ_CONTAINERS as readonly DlzContainer[]) {
      out.push({ container: c, prefix: `lakehouses/${safe}` });
    }
  }
  return out;
}

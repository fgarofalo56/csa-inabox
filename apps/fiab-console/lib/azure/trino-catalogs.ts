/**
 * LU-11 — FOREIGN CATALOGS: the external sources reachable through the
 * federation layer, as one governed inventory.
 *
 * ## What a "foreign catalog" is here
 *
 * Databricks Unity Catalog calls a registered external database a *foreign
 * catalog* (a connection + a catalog projected over it, queryable in the same
 * three-part namespace as a managed table). Loom's Azure-native equivalent is a
 * Trino catalog over the same source: `apps/loom-trino/docker-entrypoint.sh`
 * renders one catalog per `LOOM_TRINO_CATALOG_<NAME>` env var, and
 * `admin-plane/main.bicep` threads those declaratively through
 * `loomBackends.trinoCatalogs` / `trinoCatalogSecrets` — so a Postgres / MySQL /
 * SQL Server / Kafka / MongoDB source becomes queryable through IaC, with its
 * password on a Key Vault secretRef, and NEVER through an out-of-band
 * `az containerapp update --set-env-vars` the next deploy would revert.
 *
 * That plumbing already existed. What did not was any way to SEE it: nothing in
 * the product ever asked the engine what it had. This module closes that.
 *
 * ## The engine is the source of truth, never a guess
 *
 * The inventory comes from the coordinator itself —
 * `system.metadata.catalogs`, which reports every catalog the engine actually
 * mounted AND its connector name. Not from the env bag (which describes intent,
 * not outcome: a catalog whose Postgres is unreachable still has an env var),
 * and not from a hard-coded list. If the engine is unreachable or sealed, this
 * says so rather than returning a plausible-looking empty inventory
 * (`no-vaporware.md`: an honest gate, never a fabricated result).
 *
 * ## Classification
 *
 *   `builtin`  — `system` / `jmx` / `memory`: in-process, no network, no
 *                credentials. Present in an air-gapped enclave.
 *   `lake`     — the Loom lake catalog over the N1 Iceberg REST Catalog. Your
 *                own data; querying it is not a privilege escalation.
 *   `foreign`  — everything else: data OUTSIDE the lake. Deny-by-default at the
 *                BFF (`trino-authz.ts`) and, since LU-7, governed at the ENGINE
 *                by the compiled rules document.
 *
 * ## Registerable sources
 *
 * A Loom Connection (Linked Service) of a federatable type is a source that
 * COULD be a foreign catalog but is not mounted yet. Listing those next to the
 * live catalogs is what makes the tab actionable instead of a read-only table —
 * and the connector mapping is what turns "I have a Postgres connection" into
 * the exact catalog properties the engine needs.
 *
 * PURE module for the classification/mapping half (unit-tested, no imports);
 * the live read is a thin wrapper over the existing Trino client.
 */

import type { ConnectionType, LoomConnectionView } from '@/lib/azure/connections-store';

export type TrinoCatalogKind = 'builtin' | 'lake' | 'foreign';

export interface TrinoCatalogEntry {
  /** Catalog name as the engine reports it (lower-cased — Trino folds them). */
  name: string;
  /** Trino connector backing it (`postgresql`, `iceberg`, `kafka`, `memory`, …). */
  connector: string;
  kind: TrinoCatalogKind;
  /** True when THIS caller may query it (BFF catalog authorization). */
  allowed: boolean;
  /**
   * Why a caller cannot reach it — surfaced verbatim so the answer is never a
   * bare disabled row. Only present when `allowed` is false.
   */
  deniedReason?: string;
}

/** In-process catalogs Trino always has; no network, no credentials. */
export const BUILTIN_CATALOGS = new Set(['system', 'jmx', 'memory']);

/**
 * Classify one catalog. `lakeCatalog` is the deployment's Iceberg catalog name
 * (`LOOM_TRINO_ICEBERG_CATALOG`, default `iceberg`) — configurable, so it is
 * passed in rather than assumed.
 */
export function classifyCatalog(name: string, lakeCatalog: string): TrinoCatalogKind {
  const n = name.trim().toLowerCase();
  if (BUILTIN_CATALOGS.has(n)) return 'builtin';
  if (n === (lakeCatalog || 'iceberg').trim().toLowerCase()) return 'lake';
  return 'foreign';
}

/**
 * Trino connector for a Loom connection type — the mapping that makes a
 * registered Linked Service mountable as a foreign catalog. `null` means the
 * source has no Trino connector and is NOT offered (a fabricated "register"
 * button that could not work is worse than an absent one).
 *
 * `synapse-serverless` / `synapse-dedicated` / `azure-sql` all speak TDS, which
 * Trino reaches with its `sqlserver` connector. `storage-adls` is deliberately
 * absent: the lake is already federated through the Iceberg catalog, and
 * mounting it twice would give one dataset two governance identities.
 */
export function trinoConnectorFor(type: ConnectionType): string | null {
  switch (type) {
    case 'postgres': return 'postgresql';
    case 'azure-sql':
    case 'synapse-dedicated':
    case 'synapse-serverless': return 'sqlserver';
    case 'generic-sql': return 'sqlserver';
    case 'databricks-sql': return 'delta_lake';
    case 'cosmos': return 'mongodb';
    case 'event-hub': return 'kafka';
    case 'adx':
    case 'service-bus':
    case 'key-vault':
    case 'storage-adls':
    default:
      return null;
  }
}

/** Why a source cannot be mounted — stated, never silently omitted. */
export function unmountableReason(type: ConnectionType): string | null {
  if (trinoConnectorFor(type)) return null;
  switch (type) {
    case 'adx':
      return 'Azure Data Explorer is queried natively through the Loom KQL surfaces (kusto-client), which is richer than a JDBC projection would be — it is not mounted as a Trino catalog.';
    case 'storage-adls':
      return 'The lake is already federated through the Iceberg REST Catalog, so mounting the storage account again would give one dataset two governance identities.';
    case 'key-vault':
      return 'Key Vault holds secrets, not queryable tables.';
    case 'service-bus':
      return 'Service Bus is a message broker with no table surface; use Event Hubs (Kafka protocol) for a streaming catalog.';
    default:
      return 'No Trino connector maps to this source type in this deployment.';
  }
}

export interface RegisterableSource {
  connectionId: string;
  name: string;
  type: ConnectionType;
  /** The Trino connector that would back it — null when it cannot be mounted. */
  connector: string | null;
  host?: string;
  database?: string;
  /** True when this connection is ALREADY mounted as a live catalog. */
  mounted: boolean;
  /** The live catalog name it maps to, when mounted. */
  mountedAs?: string;
  /** Present only when `connector` is null — the honest reason. */
  unmountableReason?: string;
  /**
   * Present when the source CAN be mounted but is not yet — the catalog name it
   * would take, so the row is never a dead end.
   *
   * RC-10: without this, a source with a working connector came back
   * `mounted:false` with NO `unmountableReason` (that field is only populated
   * when `connector` is null) and no route — i.e. "not mounted", full stop.
   * Measured live on `cosmos-csa-inabox-copilot-fg`, caught by the F1 browser
   * receipt. `auto-bind-by-default.md` forbids exactly that shape: an unmounted
   * thing with no reason and no action.
   *
   * NOTE this is the MINIMUM fix, not full compliance. §5 of that rule says the
   * platform should MOUNT it rather than describe how — a one-click action or an
   * automatic bind. Naming the target catalog removes the dead end; it does not
   * discharge the rule. Tracked in docs/fiab/parity/external-engine-federation.md.
   */
  mountableVia?: string;
}

/**
 * The catalog name a connection would be mounted as. Deterministic and
 * inspectable (`auto-bind-by-default` §2: the backing object carries the SAME
 * name, sanitized only where the service's rules force it). Trino catalog names
 * are lower-case and may not contain a `.`; the entrypoint additionally maps
 * `_` → `-` when deriving a name from the env var.
 */
export function catalogNameFor(connectionName: string): string {
  return (connectionName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/_/g, '-')
    .slice(0, 60);
}

/**
 * Join the live catalogs with the registered connections: which sources are
 * already federated, which could be, and which cannot (with the reason).
 */
export function buildRegisterableSources(
  connections: LoomConnectionView[],
  liveCatalogs: TrinoCatalogEntry[],
): RegisterableSource[] {
  const live = new Set(liveCatalogs.map((c) => c.name));
  return connections.map((c) => {
    const connector = trinoConnectorFor(c.type);
    const candidate = catalogNameFor(c.name);
    const mounted = live.has(candidate);
    return {
      connectionId: c.id,
      name: c.name,
      type: c.type,
      connector,
      ...(c.host ? { host: c.host } : {}),
      ...(c.database ? { database: c.database } : {}),
      mounted,
      ...(mounted ? { mountedAs: candidate } : {}),
      ...(connector ? {} : { unmountableReason: unmountableReason(c.type) || undefined }),
      // Mountable but not yet mounted => say HOW, never leave it bare (RC-10).
      ...(connector && !mounted ? { mountableVia: candidate } : {}),
    };
  });
}

/**
 * The `loomBackends.trinoCatalogs` entry that mounts a connection — the exact
 * IaC value an operator commits, rendered from the connection's real
 * coordinates. This is what makes the tab actionable without ever asking anyone
 * to hand-write connector properties.
 *
 * A password NEVER appears here: for a connection that needs one the value is
 * emitted with the Key Vault secret reference the sibling
 * `trinoCatalogSecrets` bag resolves, matching what the module documents.
 */
export function renderCatalogProperties(src: {
  connector: string;
  host?: string;
  database?: string;
  username?: string;
  secretRef?: string;
}): string {
  const lines: string[] = [`connector.name=${src.connector}`];
  const host = (src.host || '').trim();
  const db = (src.database || '').trim();
  switch (src.connector) {
    case 'postgresql':
      lines.push(`connection-url=jdbc:postgresql://${host || '<host>'}:5432/${db || '<database>'}`);
      break;
    case 'sqlserver':
      lines.push(`connection-url=jdbc:sqlserver://${host || '<host>'}:1433;databaseName=${db || '<database>'};encrypt=true`);
      break;
    case 'mongodb':
      lines.push(`mongodb.connection-url=mongodb://${host || '<host>'}:27017`);
      break;
    case 'kafka':
      lines.push(`kafka.nodes=${host || '<bootstrap-host>'}:9093`);
      lines.push('kafka.hide-internal-columns=false');
      break;
    case 'delta_lake':
      lines.push('hive.metastore=thrift');
      lines.push(`hive.metastore.uri=thrift://${host || '<metastore-host>'}:9083`);
      break;
    default:
      break;
  }
  if (src.username && (src.connector === 'postgresql' || src.connector === 'sqlserver')) {
    lines.push(`connection-user=${src.username}`);
    lines.push(
      src.secretRef
        ? `# connection-password rides loomBackends.trinoCatalogSecrets → the Key Vault secret "${src.secretRef}" (never a literal here)`
        : '# connection-password: add the Key Vault secret URI to loomBackends.trinoCatalogSecrets (never a literal here)',
    );
  }
  return lines.join('\n');
}

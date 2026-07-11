/**
 * pbi-source-resolver — the Connection-Coordinate Resolver for the Weave →
 * Power BI edge (`analyze-in-powerbi`).
 *
 * Given ANY Loom item that can be a Power BI source (lakehouse, warehouse,
 * eventhouse / kql-database, mirrored-database, dataset, semantic-model,
 * data-product, + the paired serverless / dedicated SQL-pool items), this
 * returns a NORMALIZED `PbiSourceBinding` describing the Azure-native backend
 * the item actually sits on — the SQL FQDN / ADX cluster URI, database, and a
 * best-effort default table — PLUS a `loomNativeDataSource` seed the
 * `analyze-in-powerbi` route stamps onto the created Power BI item so it opens
 * pre-wired (no manual data-source / auth / connection config).
 *
 * Per .claude/rules:
 *  - no-fabric-dependency: every coordinate resolves to an Azure-native backend
 *    (Synapse serverless / dedicated over ADLS + Delta, or ADX). NO
 *    api.fabric.microsoft.com / api.powerbi.com / onelake host is ever touched.
 *  - no-vaporware: coordinates are read from the item's REAL provisioned state
 *    (`state.provisioning.secondaryIds`, `state.content`) or reconstructed from
 *    the deployment's env (`LOOM_SYNAPSE_WORKSPACE`, `LOOM_KUSTO_CLUSTER_URI`).
 *    When neither is available the resolver returns an HONEST `{ gate }` naming
 *    the exact remediation — it NEVER fabricates a server / cluster / database.
 *  - loom-no-freeform-config: the resolver produces structured coordinates; the
 *    only SQL it emits is a canned `SELECT TOP … FROM [schema].[table]` over a
 *    catalog-derived table name (bracket-quoted), never user free text.
 *
 * PURE + side-effect-free (no network) EXCEPT the optional `data-product` path,
 * which — only when the caller supplies a `loadItem` loader — resolves the
 * product's referenced lakehouse / warehouse item and recurses into it. That
 * keeps the resolver unit-testable with mocked item state + env (no Azure).
 */

import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  serverlessTarget,
  dedicatedTarget,
  getSynapseSqlSuffix,
} from '@/lib/azure/synapse-sql-client';
import { clusterUri as kustoClusterUri, defaultDatabase as kustoDefaultDatabase } from '@/lib/azure/kusto-client';
import type { ReportDataSource } from '@/lib/editors/report/report-data-source';

/** The Azure-native backend family the source item sits on. */
export type PbiConnector = 'synapse-sql' | 'adx' | 'adls' | 'azure-sql';

/**
 * A normalized, ready-to-bind description of a Loom item's Azure-native
 * backend, produced by {@link resolvePbiSource}.
 */
export interface PbiSourceBinding {
  connector: PbiConnector;
  /** SQL FQDN (Synapse serverless `<ws>-ondemand.…`, dedicated `<ws>.…`, Azure SQL). */
  server?: string;
  /** ADX cluster URI (connector = 'adx'). */
  clusterUri?: string;
  /** Database / pool / ADX database the source's objects live in. */
  database: string;
  /** Best-effort default table (schema-qualified where known) to seed a visual over. */
  defaultTable?: string;
  /** True when the backend is only reachable over a private endpoint (needs a gateway on the real-PBI path). */
  behindPrivateEndpoint: boolean;
  /** The source Loom item id this binding was resolved from. */
  sourceItemId: string;
  /** The seed stamped onto a Loom-native Power BI item's `state.dataSource`. */
  loomNativeDataSource: ReportDataSource;
}

/** Honest, unresolvable outcome — surfaced verbatim to the user (no fabricated coords). */
export interface PbiSourceGate {
  gate: string;
}

export interface ResolvePbiSourceOpts {
  /**
   * Loader used ONLY by the `data-product` path to resolve its referenced
   * lakehouse / warehouse item. The route supplies a real Cosmos-backed loader
   * (loadOwnedItem); tests may omit it (a data-product then honest-gates) or
   * mock it.
   */
  loadItem?: (itemId: string) => Promise<WorkspaceItem | null>;
}

/** Type guard: the resolver returned an honest gate rather than a binding. */
export function isPbiSourceGate(x: PbiSourceBinding | PbiSourceGate): x is PbiSourceGate {
  return !!x && typeof (x as PbiSourceGate).gate === 'string';
}

/** Item types the Weave → Power BI edge can source from (mirrors PBI_SOURCEABLE). */
export const PBI_RESOLVABLE_TYPES = [
  'lakehouse', 'warehouse', 'eventhouse', 'kql-database', 'mirrored-database',
  'dataset', 'semantic-model', 'data-product',
  'synapse-serverless-sql-pool', 'synapse-dedicated-sql-pool',
] as const;

// ───────────────────────────────────────────────────────────────────────────
// small pure helpers
// ───────────────────────────────────────────────────────────────────────────

function state(item: WorkspaceItem): Record<string, unknown> {
  return (item.state ?? {}) as Record<string, unknown>;
}
function content(item: WorkspaceItem): Record<string, unknown> {
  const c = state(item).content;
  return c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
}
function secondaryIds(item: WorkspaceItem): Record<string, unknown> {
  const prov = state(item).provisioning as Record<string, unknown> | undefined;
  const sec = prov?.secondaryIds;
  return sec && typeof sec === 'object' ? (sec as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Bracket-quote a T-SQL identifier (double any `]`). */
function brk(name: string): string {
  return `[${String(name).replace(/]/g, ']]')}]`;
}
/** `[schema].[table]` (schema defaults to dbo). */
function qualified(schema: string, table: string): string {
  return `${brk(schema || 'dbo')}.${brk(table)}`;
}
/** Canned, read-only preview SELECT over a catalog-derived table (no free text). */
function previewSelect(schema: string, table: string): string {
  return `SELECT TOP 1000 * FROM ${qualified(schema, table)}`;
}

/** Reconstruct the Synapse serverless FQDN, or null when LOOM_SYNAPSE_WORKSPACE is unset. */
function serverlessServer(): string | null {
  try {
    return serverlessTarget().server;
  } catch {
    return null;
  }
}
/** Reconstruct the Synapse dedicated {server, pool}, or null when its env is unset. */
function dedicated(): { server: string; database: string } | null {
  try {
    const t = dedicatedTarget();
    return { server: t.server, database: t.database };
  } catch {
    return null;
  }
}
/** The lakehouse's shared serverless user database (mirror of the pairing rule). */
function lakehouseDb(): string {
  return (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
}
/** The per-mirror serverless user database (mirror of ITEM_PAIRING_RULES['mirrored-database']). */
function mirrorDb(displayName: string): string {
  const sanitized =
    String(displayName || 'mirror').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'mirror';
  return `loom_mirror_${sanitized}`.slice(0, 128);
}

/** A direct-query seed carries an optional serverless `database` the report resolver reads. */
type DirectQuerySeed = { kind: 'direct-query'; target: 'warehouse' | 'lakehouse'; sql: string; database?: string };

/** Build a synapse-sql binding, filling the loom-native direct-query seed. */
function synapseBinding(args: {
  sourceItemId: string;
  server: string;
  database: string;
  target: 'warehouse' | 'lakehouse';
  schema?: string;
  table?: string;
}): PbiSourceBinding {
  const { sourceItemId, server, database, target, schema, table } = args;
  const defaultTable = table ? `${schema || 'dbo'}.${table}` : undefined;
  const seed: DirectQuerySeed = {
    kind: 'direct-query',
    target,
    sql: table ? previewSelect(schema || 'dbo', table) : '',
    ...(target === 'lakehouse' ? { database } : {}),
  };
  return {
    connector: 'synapse-sql',
    server,
    database,
    defaultTable,
    behindPrivateEndpoint: true,
    sourceItemId,
    loomNativeDataSource: seed as ReportDataSource,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// per-item-type resolution
// ───────────────────────────────────────────────────────────────────────────

/** lakehouse → Synapse serverless over the shared `loom_lakehouse` DB. */
function resolveLakehouse(item: WorkspaceItem): PbiSourceBinding | PbiSourceGate {
  const server = serverlessServer();
  if (!server) {
    return {
      gate:
        'No Synapse serverless workspace is configured for this deployment. Set LOOM_SYNAPSE_WORKSPACE ' +
        '(deployed by platform/fiab/bicep/modules/landing-zone) so the lakehouse SQL analytics endpoint resolves.',
    };
  }
  const deltas = content(item).deltaTables;
  const first = Array.isArray(deltas) && deltas.length ? (deltas[0] as Record<string, unknown>) : null;
  return synapseBinding({
    sourceItemId: item.id,
    server,
    database: lakehouseDb(),
    target: 'lakehouse',
    schema: first ? str(first.schema) || 'dbo' : undefined,
    table: first ? str(first.name) : undefined,
  });
}

/** warehouse / synapse-dedicated-sql-pool → Synapse dedicated pool. */
function resolveWarehouse(item: WorkspaceItem): PbiSourceBinding | PbiSourceGate {
  // Prefer the server FQDN embedded in `state.provisioning.resourceId`
  // (`<server>/<db>/<name>`); else reconstruct from the deployment env.
  const prov = state(item).provisioning as Record<string, unknown> | undefined;
  const resourceId = str(prov?.resourceId);
  const embeddedServer = resourceId.includes('/') ? resourceId.split('/')[0] : '';
  const recon = dedicated();
  const server = /\.sql\.azuresynapse\./i.test(embeddedServer) ? embeddedServer : recon?.server || '';
  const database = str(secondaryIds(item).database) || recon?.database || '';
  if (!server || !database) {
    return {
      gate:
        'No Synapse dedicated SQL pool is configured for this deployment. Set LOOM_SYNAPSE_WORKSPACE and ' +
        'LOOM_SYNAPSE_DEDICATED_POOL (deployed by platform/fiab/bicep/modules/landing-zone) so the warehouse endpoint resolves.',
    };
  }
  // Best-effort default table from the warehouse's starter content.
  const c = content(item);
  const sampleRows = Array.isArray(c.sampleRows) ? (c.sampleRows as Array<Record<string, unknown>>) : [];
  const dbtModels = Array.isArray(c.dbtModels) ? (c.dbtModels as Array<Record<string, unknown>>) : [];
  let schema = 'dbo';
  let table = str(sampleRows[0]?.table) || str(dbtModels[0]?.name);
  if (!table) {
    // Parse the first `CREATE TABLE [schema].[name]` (or `schema.name`) out of the DDL.
    const m = /CREATE\s+TABLE\s+(?:\[?([A-Za-z0-9_]+)\]?\.)?\[?([A-Za-z0-9_]+)\]?/i.exec(str(c.ddl));
    if (m) {
      schema = m[1] || 'dbo';
      table = m[2] || '';
    }
  } else if (table.includes('.')) {
    const parts = table.split('.');
    table = parts.pop() as string;
    schema = parts.pop() || 'dbo';
  }
  return synapseBinding({
    sourceItemId: item.id,
    server,
    database,
    target: 'warehouse',
    schema,
    table: table || undefined,
  });
}

/** eventhouse / kql-database → Azure Data Explorer (ADX). */
function resolveAdx(item: WorkspaceItem): PbiSourceBinding | PbiSourceGate {
  const sec = secondaryIds(item);
  const st = state(item);
  const cluster = str(sec.cluster) || str(process.env.LOOM_KUSTO_CLUSTER_URI) || kustoClusterUri();
  const database = str(sec.database) || str(st.databaseName) || str((st.provisioning as any)?.resourceId) || kustoDefaultDatabase();
  if (!cluster) {
    return {
      gate:
        'No Azure Data Explorer cluster is configured for this deployment. Set LOOM_KUSTO_CLUSTER_URI to the ADX ' +
        'cluster URI (deployed by platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep) so the eventhouse endpoint resolves.',
    };
  }
  const tables = content(item).tables;
  const first = Array.isArray(tables) && tables.length ? (tables[0] as Record<string, unknown>) : null;
  const table = first ? str(first.name) : '';
  // ADX has no bindable LoomConnection in Wave 1 (adx is forward-compat in
  // report-data-source), so the loom-native REPORT seed is an unbound `adx`
  // connection — the report honest-gates. The DASHBOARD target (kusto tile) is
  // the working ADX surface; the route seeds it directly from this binding.
  const seed: ReportDataSource = {
    kind: 'connection',
    connectionId: '',
    connType: 'adx',
    objectRef: table ? { mode: 'table', table } : { mode: 'kql', kql: '' },
  };
  return {
    connector: 'adx',
    clusterUri: cluster,
    database,
    defaultTable: table || undefined,
    behindPrivateEndpoint: false, // ADX is public by default (no gateway unless PE'd)
    sourceItemId: item.id,
    loomNativeDataSource: seed,
  };
}

/** mirrored-database → the paired Synapse serverless per-mirror database. */
function resolveMirror(item: WorkspaceItem): PbiSourceBinding | PbiSourceGate {
  const server = serverlessServer();
  if (!server) {
    return {
      gate:
        'No Synapse serverless workspace is configured for this deployment. Set LOOM_SYNAPSE_WORKSPACE so the ' +
        "mirror's SQL analytics endpoint (loom_mirror_<name>) resolves.",
    };
  }
  // Mirror table list: content.source.tables ('schema.table' | {schema,table}).
  const src = (content(item).source ?? {}) as Record<string, unknown>;
  const raw = (Array.isArray(src.tables) ? src.tables : Array.isArray(content(item).tables) ? (content(item).tables as unknown[]) : []) as unknown[];
  let schema = 'dbo';
  let table = '';
  for (const t of raw) {
    if (typeof t === 'string' && t) {
      const parts = t.split('.');
      table = parts.pop() as string;
      schema = parts.pop() || 'dbo';
      break;
    }
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>;
      if (str(o.table)) {
        table = str(o.table);
        schema = str(o.schema) || 'dbo';
        break;
      }
    }
  }
  return synapseBinding({
    sourceItemId: item.id,
    server,
    database: mirrorDb(item.displayName),
    target: 'lakehouse', // serverless (OPENROWSET views) — same TDS path as a lakehouse
    schema,
    table: table && !table.endsWith('*') ? table : undefined,
  });
}

/** semantic-model → bind a report directly to the model item (no server coords needed). */
function resolveSemanticModel(item: WorkspaceItem): PbiSourceBinding {
  const st = state(item);
  const tables = content(item).tables;
  const first = Array.isArray(tables) && tables.length ? (tables[0] as Record<string, unknown>) : null;
  return {
    connector: 'synapse-sql',
    server: undefined,
    database: str(st.sourceDatabase),
    defaultTable: first ? str(first.name) || undefined : undefined,
    behindPrivateEndpoint: true,
    sourceItemId: item.id,
    loomNativeDataSource: { kind: 'semantic-model', itemId: item.id },
  };
}

/** dataset (Foundry) → best-effort ADLS resolution, else honest gate. */
function resolveDataset(item: WorkspaceItem): PbiSourceBinding | PbiSourceGate {
  // Scan the item state for an abfss:// / *.dfs.<suffix> path the dataset points at.
  const candidates: string[] = [];
  for (const v of Object.values(state(item))) if (typeof v === 'string') candidates.push(v);
  for (const v of Object.values(secondaryIds(item))) if (typeof v === 'string') candidates.push(v);
  const c = content(item);
  for (const v of Object.values(c)) if (typeof v === 'string') candidates.push(v);
  const abfss = candidates.find((s) => /^abfss:\/\//i.test(s) || /\.dfs\.[a-z0-9.]+/i.test(s));
  if (!abfss) {
    return {
      gate:
        'This dataset has no Power BI-queryable storage path. Publish it to a lakehouse, warehouse, or KQL database, ' +
        'then use “Analyze in Power BI” from there.',
    };
  }
  // abfss://<container>@<acct>.dfs…/<path>
  const m = /^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i.exec(abfss);
  const container = m ? m[1] : 'landing';
  const path = m ? m[2].replace(/\/+$/, '') : '';
  const format = /\.parquet$/i.test(path) ? 'parquet' : /\.csv$/i.test(path) ? 'csv' : /\.json$/i.test(path) ? 'json' : 'delta';
  return {
    connector: 'adls',
    database: container,
    defaultTable: path ? path.split('/').filter(Boolean).pop() : undefined,
    behindPrivateEndpoint: true,
    sourceItemId: item.id,
    loomNativeDataSource: { kind: 'adls-file', container, path, format },
  };
}

/** data-product → resolve its referenced lakehouse / warehouse and recurse. */
async function resolveDataProduct(
  item: WorkspaceItem,
  opts: ResolvePbiSourceOpts,
): Promise<PbiSourceBinding | PbiSourceGate> {
  const st = state(item);
  // A referenced item id can live on a typed ref or inside a published dataset.
  const refIds = new Set<string>();
  for (const k of ['sourceItemId', 'lakehouseId', 'warehouseId', 'kqlDatabaseId']) {
    const v = str(st[k]);
    if (v) refIds.add(v);
  }
  const datasets = content(item).datasets ?? st.datasets;
  if (Array.isArray(datasets)) {
    for (const d of datasets) {
      const o = (d ?? {}) as Record<string, unknown>;
      const v = str(o.itemId) || str(o.sourceItemId) || str(o.id);
      if (v) refIds.add(v);
    }
  }
  if (!opts.loadItem || refIds.size === 0) {
    return {
      gate:
        'This data product does not reference a Power BI-queryable lakehouse or warehouse. Open it and add a dataset ' +
        'backed by a lakehouse, warehouse, or KQL database, then use “Analyze in Power BI”.',
    };
  }
  for (const id of refIds) {
    const ref = await opts.loadItem(id).catch(() => null);
    if (ref && PBI_RESOLVABLE_TYPES.includes(ref.itemType as (typeof PBI_RESOLVABLE_TYPES)[number]) && ref.itemType !== 'data-product') {
      const resolved = await resolvePbiSource(ref, opts);
      // Re-stamp sourceItemId to the data-product so lineage/edges point at IT.
      if (!isPbiSourceGate(resolved)) return { ...resolved, sourceItemId: item.id };
    }
  }
  return {
    gate:
      "This data product's referenced items could not be resolved to a queryable backend. Confirm the referenced " +
      'lakehouse / warehouse is provisioned, then retry.',
  };
}

/**
 * Resolve a Loom item to its Azure-native Power BI source binding, or an honest
 * gate when unresolvable. See the module doc for the resolution order per type.
 */
export async function resolvePbiSource(
  item: WorkspaceItem,
  opts: ResolvePbiSourceOpts = {},
): Promise<PbiSourceBinding | PbiSourceGate> {
  switch (item.itemType) {
    case 'lakehouse':
      return resolveLakehouse(item);
    case 'warehouse':
    case 'synapse-dedicated-sql-pool':
      return resolveWarehouse(item);
    case 'synapse-serverless-sql-pool': {
      // Serverless pool carries its own endpoint + database in secondaryIds.
      const sec = secondaryIds(item);
      const server = str(sec.endpoint) || serverlessServer();
      const database = str(sec.database) || lakehouseDb();
      if (!server) {
        return {
          gate:
            'This serverless SQL pool has no resolved endpoint. Set LOOM_SYNAPSE_WORKSPACE (or re-provision it) so its ' +
            'SQL analytics endpoint resolves.',
        };
      }
      return synapseBinding({ sourceItemId: item.id, server, database, target: 'lakehouse' });
    }
    case 'eventhouse':
    case 'kql-database':
      return resolveAdx(item);
    case 'mirrored-database':
      return resolveMirror(item);
    case 'semantic-model':
      return resolveSemanticModel(item);
    case 'dataset':
      return resolveDataset(item);
    case 'data-product':
      return resolveDataProduct(item, opts);
    default:
      return {
        gate:
          `“${item.itemType}” is not a supported Power BI source. Use a lakehouse, warehouse, eventhouse / KQL database, ` +
          'mirrored database, semantic model, or data product.',
      };
  }
}

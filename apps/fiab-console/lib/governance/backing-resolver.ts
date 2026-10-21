/**
 * backing-resolver - where, in a Loom item, the id of its backing store lives.
 *
 * SOURCE OF TRUTH: PRPs/active/governance-autopilot/W0-RECEIPT.md section 2a
 * (the per-item-type table, each key cited there to the provisioner / provider
 * that writes it). There is NO single key: the id lives in up to four places
 * (install receipt `state.provisioning.{resourceId,secondaryIds}`, flat
 * auto-bind keys, editor-written keys, `purviewSourceName`). This table lists,
 * per type, the documented key paths in priority order. It is deliberately a
 * TABLE of cited keys and not a heuristic: a type with no documented key
 * resolves to `no-backing-key` so W2 can fix it, never to a guess.
 *
 * Paths are relative to the item's `state`. `provisioning.*` paths are the
 * install receipt (`app/api/apps/[id]/install/route.ts:371-382`).
 *
 * The value found is whatever the writer stored. It is an ARM id only for a few
 * types; for most it is a database name, hub name, abfss root or pipeline name.
 * `backingIdKind` says which, so a consumer (W2) never mistakes a name for a
 * resource id.
 */

export type ResolverStatus = 'resolved' | 'no-backing-key' | 'not-applicable';
export type BackingIdKind = 'arm-id' | 'url' | 'name-or-path';
export type NoKeyReason = 'type-has-no-documented-key' | 'key-absent-on-item';

export interface BackingSpec {
  /** Backing Azure service named by the PRP coverage table / W0 receipt. */
  readonly service: string;
  /** state-relative key paths, highest priority first (W0 receipt section 2a). */
  readonly keys: readonly string[];
}

const SEC = 'provisioning.secondaryIds';

export const BACKING_KEYS: Readonly<Record<string, BackingSpec>> = {
  // lakehouse: install writes secondaryIds.{container,rootPath,adlsRoot} (lakehouse.ts:909-915);
  // a hand-created lakehouse carries adlsContainer/lakehouseRoot (auto-bind-providers.ts:621-624);
  // an external one carries storageAccount (lakehouse-abfss.ts, purview-autoonboard.ts:182).
  lakehouse: { service: 'ADLS Gen2', keys: [`${SEC}.adlsRoot`, `${SEC}.container`, 'adlsContainer', 'lakehouseRoot', 'storageAccount'] },
  // warehouse.ts:570-571; synapse-item-scope.ts reads database/databaseName.
  warehouse: { service: 'Synapse dedicated SQL pool', keys: [`${SEC}.database`, 'database', 'databaseName'] },
  // kql-db.ts:254-258 (resourceId = database name); auto-bind-providers.ts:509-512 (kqlDatabase).
  'kql-database': { service: 'Azure Data Explorer', keys: ['provisioning.resourceId', `${SEC}.database`, 'database', 'kqlDatabase'] },
  eventhouse: { service: 'Azure Data Explorer', keys: ['provisioning.resourceId', `${SEC}.database`, 'database', 'kqlDatabase'] },
  // kql-dashboard.ts:340,417,451.
  'kql-dashboard': { service: 'Azure Data Explorer', keys: [`${SEC}.clusterUri`, `${SEC}.database`] },
  // eventstream.ts:107-114,195-204.
  eventstream: { service: 'Azure Event Hubs', keys: ['ehId', 'transportHub'] },
  // auto-bind-providers.ts:286-291 (ADF), :372-375 (Synapse); adf-pipeline.ts:139; synapse-pipeline.ts:142.
  'data-pipeline': { service: 'Azure Data Factory or Synapse pipeline', keys: ['pipelineName'] },
  'adf-pipeline': { service: 'Azure Data Factory', keys: ['pipelineName'] },
  'synapse-pipeline': { service: 'Synapse pipeline', keys: ['pipelineName'] },
  // mirrored-database.ts:568-586.
  'mirrored-database': { service: 'ADF CDC to ADLS Bronze', keys: [`${SEC}.adlsRoot`, `${SEC}.bronze`, `${SEC}.pipeline`] },
  // mirrored-databricks.ts:140-148.
  'mirrored-databricks': { service: 'Databricks Unity Catalog', keys: [`${SEC}.catalogName`] },
  // materialized-lake-view.ts:75-90.
  'materialized-lake-view': { service: 'ADLS Gen2 Delta', keys: [`${SEC}.deltaUrl`, `${SEC}.fqn`, `${SEC}.container`] },
  // synapse-serverless-sql-pool.ts:389-399.
  'synapse-serverless-sql-pool': { service: 'Synapse serverless SQL', keys: [`${SEC}.endpoint`, `${SEC}.database`, `${SEC}.adlsRoot`] },
  // search-binding.ts:93-94.
  'ai-search-index': { service: 'Azure AI Search', keys: ['indexName'] },
  // model-binding.ts:96-98 (read side; install writes only notebookPath/runId, ml-model.ts:309).
  'ml-model': { service: 'Azure ML / Databricks MLflow', keys: ['modelName'] },
  // notebook.ts:366,426.
  notebook: { service: 'Synapse or Databricks notebook', keys: [`${SEC}.synapseNotebook`, `${SEC}.databricksPath`] },
  // databricks-job.ts:329, databricks-notebook.ts:92, databricks-sql-warehouse/[id]/create/route.ts:82.
  'databricks-job': { service: 'Databricks', keys: [`${SEC}.jobId`] },
  'databricks-notebook': { service: 'Databricks', keys: [`${SEC}.notebookPath`] },
  'databricks-sql-warehouse': { service: 'Databricks', keys: [`${SEC}.warehouseId`] },
  // install route.ts:404-405.
  'logic-app': { service: 'Azure Logic Apps', keys: ['logicAppName'] },
  // stream-analytics-job.ts:132,264 (resourceId is an ARM id).
  'stream-analytics-job': { service: 'Azure Stream Analytics', keys: ['provisioning.resourceId', `${SEC}.jobName`] },
  // data-product.ts:396-401.
  'data-product': { service: 'Purview Unified Catalog', keys: [`${SEC}.dataProductIds`, `${SEC}.governanceDomainId`] },
  // activator.ts:411-453 (resourceId = last rule name).
  activator: { service: 'Azure Monitor alert', keys: ['provisioning.resourceId'] },
};

/**
 * Item types that DO have a backing store (PRP section 3.3 / 5.4, W0 receipt
 * "Gaps for W2") but for which W0 documents NO key to read it from. They
 * resolve to `no-backing-key` with reason `type-has-no-documented-key`; W2
 * adds the key (the `backingStore` field on the item catalog).
 */
export const BACKED_WITHOUT_DOCUMENTED_KEY: Readonly<Record<string, { service: string }>> = {
  // Loom-native over the warehouse/lakehouse; model lives in state.content (semantic-model.ts:592-598, report.ts:264-265).
  'semantic-model': { service: 'Loom-native tabular layer over the warehouse' },
  report: { service: 'Loom-native report over the semantic model' },
  // AI Foundry (AML data plane): no key in the W0 table.
  'prompt-flow': { service: 'Azure AI Foundry' },
  evaluation: { service: 'Azure AI Foundry' },
  // Synapse Spark: no key in the W0 table.
  'spark-job-definition': { service: 'Synapse Spark' },
  'spark-environment': { service: 'Synapse Spark' },
  // ADX database per the PRP coverage table; not in the W0 key table.
  'kql-queryset': { service: 'Azure Data Explorer' },
  'workspace-monitor': { service: 'Azure Data Explorer' },
};

/** Every state-relative path the resolver may read, de-duplicated, stable order. */
export function allKeyPaths(): string[] {
  const seen = new Set<string>();
  for (const spec of Object.values(BACKING_KEYS)) for (const k of spec.keys) seen.add(k);
  return [...seen];
}

export interface BackingResolution {
  resolverStatus: ResolverStatus;
  backingService: string | null;
  backingResourceId: string | null;
  backingIdKind: BackingIdKind | null;
  /** Full item-doc path of the key that supplied the value, e.g. `state.ehId`. */
  backingKeyPath: string | null;
  reason: NoKeyReason | null;
}

const MAX_ID_CHARS = 300;

export function classifyBackingId(value: string): BackingIdKind {
  if (/^\/subscriptions\//i.test(value)) return 'arm-id';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return 'url';
  return 'name-or-path';
}

/** Values that look like a credential or connection string are never surfaced. */
const SECRET_LIKE_RE = /AccountKey=|SharedAccessSignature|sig=|Password=|;Key=/i;
/** abfs-family URLs carry the FILESYSTEM name as userinfo (`container@host`); that is not a credential. */
const FILESYSTEM_USERINFO_SCHEMES = new Set(['abfss:', 'abfs:', 'wasbs:', 'wasb:']);

/**
 * Make a stored backing value safe to show a model. Returns null when the value
 * must be dropped. URL-kind values lose userinfo (password always; username too
 * except the filesystem name of abfs-family URLs), the whole query string and
 * the fragment; scheme, host, port and path are kept. Anything that looks like
 * a connection string / SAS is dropped outright, as is a URL that cannot be
 * parsed (a value we cannot sanitize is a value we do not surface).
 */
export function sanitizeBackingValue(value: string): string | null {
  // Non-URL values are checked as stored; URL values are stripped FIRST (a SAS
  // `sig=` lives in the query string we are about to remove) and the rebuilt
  // URL is checked after.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return SECRET_LIKE_RE.test(value) ? null : value;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const user = FILESYSTEM_USERINFO_SCHEMES.has(u.protocol) && !u.password ? u.username : '';
  const out = `${u.protocol}//${user ? `${user}@` : ''}${u.host}${u.pathname}`;
  return SECRET_LIKE_RE.test(out) ? null : out;
}

/**
 * Resolve the backing store of one item. `values` maps state-relative key
 * paths to what the item holds there (only the paths in {@link allKeyPaths}
 * are ever consulted). Only a non-empty string counts as a value.
 */
export function resolveBacking(itemType: string, values: Readonly<Record<string, unknown>>): BackingResolution {
  const spec = BACKING_KEYS[itemType];
  if (spec) {
    for (const path of spec.keys) {
      const v = values[path];
      const safe = typeof v === 'string' && v.trim() ? sanitizeBackingValue(v.trim()) : null;
      if (safe) {
        const trimmed = safe;
        return {
          resolverStatus: 'resolved',
          backingService: spec.service,
          backingResourceId: trimmed.length > MAX_ID_CHARS ? `${trimmed.slice(0, MAX_ID_CHARS)}...` : trimmed,
          backingIdKind: classifyBackingId(trimmed),
          backingKeyPath: `state.${path}`,
          reason: null,
        };
      }
    }
    return {
      resolverStatus: 'no-backing-key',
      backingService: spec.service,
      backingResourceId: null,
      backingIdKind: null,
      backingKeyPath: null,
      reason: 'key-absent-on-item',
    };
  }
  const gap = BACKED_WITHOUT_DOCUMENTED_KEY[itemType];
  if (gap) {
    return {
      resolverStatus: 'no-backing-key',
      backingService: gap.service,
      backingResourceId: null,
      backingIdKind: null,
      backingKeyPath: null,
      reason: 'type-has-no-documented-key',
    };
  }
  return {
    resolverStatus: 'not-applicable',
    backingService: null,
    backingResourceId: null,
    backingIdKind: null,
    backingKeyPath: null,
    reason: null,
  };
}

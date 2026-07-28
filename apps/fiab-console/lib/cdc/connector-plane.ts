/**
 * N7b — Debezium CDC control-plane core (PURE, unit-testable).
 *
 * Loom already ships an Azure-native mirroring engine (lib/azure/mirror-engine.ts)
 * that consumes a flat source config (`sourceType` + `server`/`database` +
 * `tables` + `syncMode`) and replicates it into ADLS Bronze — no Microsoft
 * Fabric. This module is the CONTROL PLANE over that engine: it models the
 * Debezium-style source connectors (SQL Server / PostgreSQL / MySQL / MongoDB /
 * Oracle), turns a **dropdown-only wizard** selection into the exact config the
 * engine already consumes, and derives the live connector health (initial
 * snapshot % → streaming lag) + schema-change feed from the engine's real
 * persisted run state.
 *
 * Everything here is PURE (no Azure / native imports) so it runs in node-env
 * vitest without the mssql/identity chain — the side-effecting halves are the
 * thin `schema-capture.ts` (source-schema read) and `dead-letter.ts` (ADLS read)
 * server modules, and the mirror engine itself.
 *
 * Design rules honoured:
 *   • no-fabric-dependency — every source maps to an Azure-native engine backend;
 *     Postgres / SQL Server replicate E2E via the built-in engine, the rest are
 *     honest Azure-copy gates (never a Fabric requirement).
 *   • loom_no_freeform_config — the source, sync mode, and every credential is a
 *     dropdown / reference; the ONLY free text is the connector name, the
 *     server/database identifiers, and the Key Vault secret REFERENCE (never an
 *     inline secret value — {@link validateConnectorWizard} rejects one).
 *   • IL5 / sovereign — nothing here reaches a cloud endpoint; the engine it
 *     feeds runs fully in-boundary against self-hosted sources.
 */

/** The five Debezium source families the control-plane wizard offers. */
export type CdcSourceKind = 'sqlserver' | 'postgres' | 'mysql' | 'mongodb' | 'oracle';

/** Ongoing-replication cadence (fixed allowlist — carried to the engine's syncMode). */
export type CdcSyncMode = 'snapshot' | 'incremental' | 'continuous';

/** A source-family definition — one row of the wizard's source dropdown. */
export interface CdcSourceDef {
  kind: CdcSourceKind;
  /** Human label for the dropdown. */
  label: string;
  /**
   * The mirror-engine `sourceType` this maps to — i.e. the config the engine
   * ALREADY consumes. Postgres/SQL-Server land on the built-in snapshot engine;
   * MySQL/MongoDB/Oracle land on values the engine honest-gates to an ADF-copy
   * runtime (never a Fabric requirement).
   */
  engineSourceType: string;
  /** The Debezium connector class this family corresponds to (parity/provenance). */
  connectorClass: string;
  /** Default source port (pre-fills the wizard; still overridable via the server field). */
  defaultPort: number;
  /**
   * True when Loom's built-in Azure-native engine replicates this source
   * end-to-end today (real snapshot → Bronze). False → the connector is created
   * and validated, but Start returns an honest Azure-copy gate (no silent stub).
   */
  builtIn: boolean;
  /** Whether table specs carry a schema segment (Mongo collections have none). */
  schemaScoped: boolean;
  /** One-line teaching hint shown under the source card. */
  hint: string;
}

/**
 * THE registry. Order = wizard display order. Postgres first because it is the
 * fully-wired acceptance path (add a Postgres source → snapshot → streaming →
 * Bronze). Every `engineSourceType` is a value `mirror-engine.runMirrorSnapshot`
 * already switches on.
 */
export const CDC_SOURCES: readonly CdcSourceDef[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    engineSourceType: 'AzurePostgreSql',
    connectorClass: 'io.debezium.connector.postgresql.PostgresConnector',
    defaultPort: 5432,
    builtIn: true,
    schemaScoped: true,
    hint: 'Logical-replication CDC. Loom replicates it now via the built-in watermark-incremental engine → ADLS Bronze (Entra token auth; no inline secret).',
  },
  {
    kind: 'sqlserver',
    label: 'SQL Server',
    engineSourceType: 'SqlServer2025',
    connectorClass: 'io.debezium.connector.sqlserver.SqlServerConnector',
    defaultPort: 1433,
    builtIn: true,
    schemaScoped: true,
    hint: 'Change-tracking CDC. Loom replicates it now via the built-in TDS snapshot + CHANGETABLE delta engine → ADLS Bronze.',
  },
  {
    kind: 'mysql',
    label: 'MySQL',
    engineSourceType: 'MySql',
    connectorClass: 'io.debezium.connector.mysql.MySqlConnector',
    defaultPort: 3306,
    builtIn: false,
    schemaScoped: true,
    hint: 'binlog CDC. Replicates via the Azure-native ADF copy runtime (MySQL connector → ADLS Bronze); configure the ADF linked service to Start. No Microsoft Fabric.',
  },
  {
    kind: 'mongodb',
    label: 'MongoDB',
    engineSourceType: 'MongoDb',
    connectorClass: 'io.debezium.connector.mongodb.MongoDbConnector',
    defaultPort: 27017,
    builtIn: false,
    schemaScoped: false,
    hint: 'change-stream CDC. Replicates via the Azure-native ADF copy runtime (MongoDB connector → ADLS Bronze). No Microsoft Fabric.',
  },
  {
    kind: 'oracle',
    label: 'Oracle',
    engineSourceType: 'Oracle',
    connectorClass: 'io.debezium.connector.oracle.OracleConnector',
    defaultPort: 1521,
    builtIn: false,
    schemaScoped: true,
    hint: 'LogMiner CDC. Replicates via the Azure-native ADF copy runtime (Oracle connector through the on-prem data gateway → ADLS Bronze). No Microsoft Fabric.',
  },
];

/** Look up a source definition by kind (undefined for an unknown kind). */
export function cdcSource(kind: string): CdcSourceDef | undefined {
  return CDC_SOURCES.find((s) => s.kind === kind);
}

/** One selected source table/collection to replicate. */
export interface CdcTableSpec {
  /** Schema/owner/database segment; '' for schema-less sources (Mongo). */
  schema: string;
  /** Table / collection name. */
  table: string;
}

/** The wizard's collected input (all dropdown / identifier / reference fields). */
export interface CdcConnectorWizardInput {
  displayName?: string;
  workspaceId?: string;
  kind?: string;
  /** Source host/FQDN (identifier, not a secret). */
  server?: string;
  /** Source database / service name. */
  database?: string;
  /** Explicit table subset; empty = replicate everything the engine discovers. */
  tables?: CdcTableSpec[];
  syncMode?: string;
  /**
   * Key Vault secret REFERENCE for the source credential (a secret name or a
   * `https://<vault>.vault.azure.net/secrets/<name>` URI) — NEVER an inline
   * secret value. Optional for Entra-token sources (Postgres/SQL Server).
   */
  secretRef?: string;
}

/** The engine-consumable source config (structurally a `MirrorSource`). */
export interface EngineSourceConfig {
  sourceType: string;
  server: string;
  database: string;
  tables: CdcTableSpec[];
  syncMode?: CdcSyncMode;
}

/** The connector document's `state` bag — what we persist on the Cosmos item. */
export interface CdcConnectorState extends EngineSourceConfig {
  /** Marks the item as a Debezium CDC control-plane connector. */
  cdcConnector: true;
  kind: CdcSourceKind;
  connectorClass: string;
  /** KV reference only (validated); absent for Entra-token sources. */
  secretRef?: string;
  /** Engine replication status, updated by the state route. */
  mirroringStatus?: string;
  [k: string]: unknown;
}

const KV_URI_RE = /^https:\/\/[a-z0-9-]{3,24}\.vault(\.azure\.net|\.usgovcloudapi\.net|\.microsoftazure\.de|\.azure\.cn)\/secrets\/[A-Za-z0-9-]{1,127}(\/[0-9a-f]{32})?$/i;
const KV_NAME_RE = /^[A-Za-z0-9-]{1,127}$/;
const IDENT_RE = /^[A-Za-z0-9_.\-:@/\\]{1,255}$/;

/**
 * A Key Vault secret REFERENCE — a bare secret name or a vault-secret URI — is
 * allowed; anything else (an inline secret value, which almost always carries a
 * symbol outside the KV-name charset) is rejected. This is the guard that keeps
 * a raw password from ever being persisted (secrets via Key Vault reference,
 * never inline).
 */
export function isKeyVaultReference(v: string): boolean {
  const s = (v || '').trim();
  if (!s) return false;
  return KV_URI_RE.test(s) || KV_NAME_RE.test(s);
}

export interface CdcValidation {
  ok: boolean;
  errors: string[];
  /** Present only when ok. */
  state?: CdcConnectorState;
}

/**
 * Validate a wizard submission and, when valid, produce the engine-consumable
 * connector state. Dropdown-only: `kind` and `syncMode` must be allowlist
 * members; the credential must be a Key Vault reference, never inline.
 */
export function validateConnectorWizard(input: CdcConnectorWizardInput): CdcValidation {
  const errors: string[] = [];
  const displayName = String(input.displayName || '').trim();
  if (!displayName) errors.push('A connector name is required.');

  const def = cdcSource(String(input.kind || ''));
  if (!def) errors.push('Choose a source type from the list.');

  const server = String(input.server || '').trim();
  const database = String(input.database || '').trim();
  // Mongo authenticates to a database/cluster; every family needs a database.
  if (!database) errors.push('A source database is required.');
  if (def && !server) errors.push(`A source host is required for ${def.label}.`);
  if (server && !IDENT_RE.test(server)) errors.push('The source host contains invalid characters.');
  if (database && !IDENT_RE.test(database)) errors.push('The source database contains invalid characters.');

  const syncModeRaw = String(input.syncMode || 'incremental');
  const syncMode: CdcSyncMode = (['snapshot', 'incremental', 'continuous'] as const).includes(syncModeRaw as CdcSyncMode)
    ? (syncModeRaw as CdcSyncMode)
    : 'incremental';

  const secretRefRaw = String(input.secretRef || '').trim();
  if (secretRefRaw && !isKeyVaultReference(secretRefRaw)) {
    errors.push('The credential must be a Key Vault secret reference (a secret name or vault-secret URI) — never an inline password.');
  }

  const tables: CdcTableSpec[] = Array.isArray(input.tables)
    ? input.tables
        .filter((t) => t && (t.table != null))
        .map((t) => ({ schema: String(t.schema || (def?.schemaScoped ? '' : '')).trim(), table: String(t.table).trim() }))
        .filter((t) => t.table.length > 0)
    : [];

  if (errors.length || !def) return { ok: false, errors };

  const state: CdcConnectorState = {
    cdcConnector: true,
    kind: def.kind,
    connectorClass: def.connectorClass,
    sourceType: def.engineSourceType,
    server,
    database,
    tables,
    syncMode,
    ...(secretRefRaw ? { secretRef: secretRefRaw } : {}),
    mirroringStatus: 'NotStarted',
  };
  return { ok: true, errors: [], state };
}

/**
 * Map a persisted connector state → the flat source config the mirror engine
 * consumes. Structural (no engine import) so this module stays vitest-pure; the
 * route hands the result straight to `runMirrorSnapshot`.
 */
export function connectorToEngineSource(state: Partial<CdcConnectorState> | undefined): EngineSourceConfig {
  const tables = Array.isArray(state?.tables)
    ? state!.tables!.filter((t) => t && t.table).map((t) => ({ schema: String(t.schema || ''), table: String(t.table) }))
    : [];
  return {
    sourceType: String(state?.sourceType || ''),
    server: String(state?.server || ''),
    database: String(state?.database || ''),
    tables,
    syncMode: (state?.syncMode as CdcSyncMode) || undefined,
  };
}

// ── Live connector health (initial snapshot % → streaming lag) ───────────────

export type CdcPhase = 'not-started' | 'snapshotting' | 'streaming' | 'stopped' | 'error';

/** A per-table status row as the engine persists it (subset of MirrorTableResult). */
export interface CdcTableStatusLike {
  schema?: string;
  table?: string;
  status?: string;
  mode?: string;
  lastSync?: string;
  rows?: number;
  error?: string;
  note?: string;
}

export interface ConnectorHealth {
  phase: CdcPhase;
  /** 0..100 — initial-load completion across the connector's tables. */
  snapshotPercent: number;
  /** Streaming lag in whole seconds (now − most-recent successful sync); null unless streaming. */
  streamingLagSeconds: number | null;
  tablesTotal: number;
  tablesReplicated: number;
  tablesErrored: number;
  tablesStreaming: number;
  lastSyncAt: string | null;
  /** Human, honest one-liner for the status bar. */
  message: string;
}

/**
 * Derive the Debezium-style connector health from the engine's REAL persisted
 * run state — the same `mirroringStatus` + `tablesStatus[]` the mirror engine
 * writes after every Start. Nothing is fabricated: snapshot % is replicated /
 * selected tables, and streaming lag is measured from the newest table's
 * `lastSync`.
 */
export function deriveConnectorHealth(input: {
  mirroringStatus?: string;
  selectedTables?: number;
  tablesStatus?: CdcTableStatusLike[];
  now?: number;
}): ConnectorHealth {
  const now = input.now ?? Date.now();
  const rows = Array.isArray(input.tablesStatus) ? input.tablesStatus : [];
  const tablesReplicated = rows.filter((r) => r.status === 'replicated').length;
  const tablesErrored = rows.filter((r) => r.status === 'error').length;
  const tablesStreaming = rows.filter((r) => r.status === 'replicated' && r.mode === 'incremental').length;
  // Total = the explicit selection when larger than what has run so far (so a
  // 3-of-10 initial load reads 30 %, not 100 %); else what the run enumerated.
  const total = Math.max(input.selectedTables || 0, rows.length);

  let lastSyncMs = 0;
  let lastSyncAt: string | null = null;
  for (const r of rows) {
    if (!r.lastSync) continue;
    const t = Date.parse(r.lastSync);
    if (Number.isFinite(t) && t > lastSyncMs) { lastSyncMs = t; lastSyncAt = r.lastSync!; }
  }

  const snapshotPercent = total > 0 ? Math.min(100, Math.round((tablesReplicated / total) * 100)) : 0;
  const status = String(input.mirroringStatus || '');

  let phase: CdcPhase;
  let streamingLagSeconds: number | null = null;
  let message: string;

  if (status === 'Stopped') {
    phase = 'stopped';
    message = 'Connector stopped. Landed data and change-tracking watermarks remain; Start to resume streaming.';
  } else if (status === 'Error' || (tablesErrored > 0 && tablesReplicated === 0)) {
    phase = 'error';
    const firstErr = rows.find((r) => r.error)?.error;
    message = firstErr ? `Connector error: ${firstErr}` : 'Connector failed on its last run — see the per-table errors.';
  } else if (status === 'Running' || tablesReplicated > 0) {
    if (total > 0 && tablesReplicated < total) {
      phase = 'snapshotting';
      message = `Initial snapshot in progress — ${tablesReplicated}/${total} tables loaded (${snapshotPercent}%).`;
    } else {
      phase = 'streaming';
      streamingLagSeconds = lastSyncMs ? Math.max(0, Math.floor((now - lastSyncMs) / 1000)) : null;
      const lagTxt = streamingLagSeconds == null ? 'awaiting first change' : `${streamingLagSeconds}s behind source`;
      message = `Streaming changes — initial snapshot complete, ${lagTxt}.`;
    }
  } else {
    phase = 'not-started';
    message = 'Connector not started. Start it to run the initial snapshot, then continuous change capture.';
  }

  return {
    phase,
    snapshotPercent,
    streamingLagSeconds,
    tablesTotal: total,
    tablesReplicated,
    tablesErrored,
    tablesStreaming,
    lastSyncAt,
    message,
  };
}

// ── Schema-change feed (source DDL drift) ────────────────────────────────────

export type SchemaChangeKind = 'table-added' | 'table-removed' | 'column-added' | 'column-removed';

export interface SchemaChangeEvent {
  at: string;
  kind: SchemaChangeKind;
  /** `schema.table` (or just table for schema-less sources). */
  dataset: string;
  /** Column name for column-level events; undefined for table-level events. */
  column?: string;
  detail: string;
}

/** A per-dataset column map — the fingerprint we persist to diff the next run. */
export type SchemaMap = Record<string, string[]>;

/** Normalize a column list: trimmed, de-duped, sorted (order-independent diff). */
function normCols(cols: string[]): string[] {
  return Array.from(new Set((cols || []).map((c) => String(c).trim()).filter(Boolean))).sort();
}

/**
 * Diff two source-schema snapshots into an ordered change feed. A table present
 * in `next` but not `prev` is `table-added`; the reverse is `table-removed`;
 * a shared table whose column set changed yields per-column added/removed
 * events. On the FIRST capture (`prev` empty) tables are recorded WITHOUT
 * emitting table-added noise — the baseline is silent, subsequent drift is loud.
 */
export function diffSchemas(prev: SchemaMap, next: SchemaMap, at: string): SchemaChangeEvent[] {
  const events: SchemaChangeEvent[] = [];
  const prevKeys = Object.keys(prev || {});
  const firstCapture = prevKeys.length === 0;

  const allKeys = new Set([...prevKeys, ...Object.keys(next || {})]);
  for (const ds of Array.from(allKeys).sort()) {
    const inPrev = Object.prototype.hasOwnProperty.call(prev || {}, ds);
    const inNext = Object.prototype.hasOwnProperty.call(next || {}, ds);
    if (inNext && !inPrev) {
      if (!firstCapture) events.push({ at, kind: 'table-added', dataset: ds, detail: `Table ${ds} added to the connector.` });
      continue;
    }
    if (inPrev && !inNext) {
      events.push({ at, kind: 'table-removed', dataset: ds, detail: `Table ${ds} removed from the connector.` });
      continue;
    }
    const p = normCols(prev[ds]);
    const n = normCols(next[ds]);
    const pSet = new Set(p);
    const nSet = new Set(n);
    for (const c of n) if (!pSet.has(c)) events.push({ at, kind: 'column-added', dataset: ds, column: c, detail: `Column ${c} added to ${ds}.` });
    for (const c of p) if (!nSet.has(c)) events.push({ at, kind: 'column-removed', dataset: ds, column: c, detail: `Column ${c} removed from ${ds}.` });
  }
  return events;
}

/** Persisted schema-tracking bag on the connector state. */
export interface CdcSchemaTracking {
  tables: SchemaMap;
  log: SchemaChangeEvent[];
  updatedAt?: string;
}

/** Cap the retained schema-change log so the Cosmos doc can't grow unbounded. */
export const SCHEMA_LOG_CAP = 200;

/**
 * Fold a freshly-captured source schema into the persisted tracking bag:
 * compute the drift vs the last snapshot, prepend it to the (capped) log, and
 * store the new fingerprint. Pure — the caller persists the returned bag.
 */
export function foldSchemaCapture(prev: CdcSchemaTracking | undefined, next: SchemaMap, at: string): CdcSchemaTracking {
  const prevMap = prev?.tables || {};
  const events = diffSchemas(prevMap, next, at);
  const log = [...events, ...(prev?.log || [])].slice(0, SCHEMA_LOG_CAP);
  return { tables: next, log, updatedAt: at };
}

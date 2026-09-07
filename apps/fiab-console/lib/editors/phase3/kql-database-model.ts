/**
 * KQL database editor — types, constants, and pure helpers.
 *
 * Pure model, no React and no IO, in the same shape as the other phase3 model
 * modules (`kql-pin-model.ts`, `dashboard-tile-state.ts`, `powerbi-embed-plan.ts`,
 * `kql-ingestion-mappings.ts`). Extracted from `kql-database-editor.tsx` for the
 * reason `check-file-size.mjs` exists: the editor is a ratchet-frozen monolith,
 * and shape declarations plus string parsing are not part of its render.
 */

import type { ColumnDef } from '@/lib/components/adx/column-grid-designer';

/** GET /api/items/kql-database/[id] — the editor's whole read model. */
export interface KqlDbInfo {
  ok: boolean;
  cluster?: string;
  database?: string;
  details?: Record<string, unknown> | null;
  tables?: Array<{ name: string; fromContent?: boolean }>;
  tableCount?: number;
  functions?: Array<{ name: string; parameters?: string; fromContent?: boolean }>;
  functionCount?: number;
  materializedViews?: Array<{ name: string; sourceTable?: string }>;
  materializedViewCount?: number;
  // Content-derived projections surfaced when the live ADX object is absent
  // (bundle-installed KQL database not yet provisioned to the cluster). Lets
  // the editor open FULLY BUILT-OUT — schema + starter queries.
  schema?: Array<{ name: string; columns: Array<{ name: string; type: string }>; sample?: unknown[][]; live?: boolean }>;
  starterQueries?: Array<{ name: string; kql: string }>;
  contentFallback?: boolean;
  // Follower (database-shortcut) state — read-only replica of a leader cluster.
  isFollower?: boolean;
  followerLeaderCluster?: string | null;
  followerConfigName?: string | null;
  followerDatabaseName?: string | null;
  error?: string;
}

export const SAMPLE_KQL_DB = `// Welcome to KQL. Try a sample:
print smoke = "ok", server_time = now(), current_user = current_principal()`;

// Functions are authored through the structured stored-function editor
// (params grid + KQL body), so 'function' is intentionally NOT a generic
// wizard kind — it has its own dialog (openFnEditor / submitFnEditor).
export type KqlWizardKind = 'table' | 'mv' | 'update-policy' | 'ingest' | 'data-connection' | 'alter-table' | 'drop-table' | 'follower';

export const DEFAULT_TABLE_COLUMNS: ColumnDef[] = [
  { name: 'ts', type: 'datetime' },
  { name: 'tenant', type: 'string' },
  { name: 'value', type: 'long' },
];

/** A row from /api/azure/resources (IoT Hub / Event Hub namespace picker). */
export interface DcSourceRow { id: string; name: string; resourceGroup?: string; subscriptionId?: string; location?: string }
/** A row from GET /api/items/kql-database/[id]/data-connections. */
export interface DcConnectionRow { name?: string; kind?: string; tableName?: string; consumerGroup?: string; dataFormat?: string; provisioningState?: string; source?: string }

// ADX-supported data formats offered by the wizard. RAW is intentionally
// excluded — IoT Hub data connections do not support it (per ADX docs).
export const DC_FORMATS = ['MULTIJSON', 'JSON', 'CSV', 'TSV', 'PSV', 'SCSV', 'SOHSV', 'TXT', 'TSVE', 'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'W3CLOGFILE'];

/**
 * Scalar parameter data types accepted in a KQL stored-function signature
 * (`paramName:paramType`). Mirrors the scalar types valid in `let` / function
 * signatures per the .create-or-alter function reference. Surfaced as a real
 * dropdown so the params grid never relies on free-typed type strings.
 */
export const FN_PARAM_TYPES = [
  'string', 'long', 'int', 'real', 'double', 'decimal',
  'bool', 'datetime', 'timespan', 'dynamic', 'guid',
] as const;

export type FnParam = { name: string; type: string };

/**
 * Parse a KQL function parameters string as returned by `.show functions`
 * (e.g. "(days:int, tenant:string)") into structured rows for the params grid.
 * A no-arg signature ("" or "()") yields [].
 */
export function parseFnParams(raw: string | undefined): FnParam[] {
  if (!raw) return [];
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((p) => {
      const [n, t] = p.split(':');
      return { name: (n || '').trim(), type: (t || 'string').trim() };
    })
    .filter((p) => p.name);
}

/** Serialize the params grid back into the `name:type, …` argument list. */
export function serializeFnParams(params: FnParam[]): string {
  return params
    .filter((p) => p.name.trim())
    .map((p) => `${p.name.trim()}:${p.type || 'string'}`)
    .join(', ');
}

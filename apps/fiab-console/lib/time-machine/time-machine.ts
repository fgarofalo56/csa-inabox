/**
 * Time-Machine (WS-10.3 / BTB-10) — the temporal coordinator.
 *
 * ONE `asOf` param, resolved to each Azure-native backend's NATIVE time-travel
 * clause. This is the un-copyable "query everything as of timestamp T" spine:
 * the ontology, a report, and a pipeline's output all read AS OF the same T by
 * threading a single {@link AsOfSpec} through their query paths, and this module
 * turns that one spec into the exact clause each backend understands.
 *
 * Per-backend native time-travel (grounded, sovereign — no Fabric, no OneLake):
 *   • Delta Lake (Databricks SQL / Spark SQL over Delta)
 *       `SELECT … FROM t TIMESTAMP AS OF '<iso>'` / `VERSION AS OF <n>`
 *       https://learn.microsoft.com/azure/databricks/delta/history
 *   • Azure Data Explorer (ADX / KQL)
 *       `T | where ingestion_time() <= datetime(<iso>)` — the ingestion-time
 *       system column is the native point-in-time filter.
 *       https://learn.microsoft.com/azure/data-explorer/kusto/query/ingestiontimefunction
 *   • Synapse Dedicated SQL — system-versioned temporal table
 *       `SELECT … FROM t FOR SYSTEM_TIME AS OF '<iso>'`
 *       https://learn.microsoft.com/sql/relational-databases/tables/temporal-tables
 *
 * Backends WITHOUT inline time-travel are HONEST-GATED (no-vaporware.md): the
 * Synapse Serverless OPENROWSET path reads the CURRENT Delta snapshot only, and
 * the semantic/DAX layer has no native time-travel — both return a structured
 * gate naming the backend that DOES resolve as-of (never silently-live data
 * dressed up as "as of T").
 *
 * This file is PURE (no React, no Node I/O) so the resolver service, the BFF
 * routes, and the client time-bar all import it and it is fully vitest-coverable.
 */

// ── The one param ────────────────────────────────────────────────────────────

/**
 * A single point-in-time selector, resolved by every backend. `live` is the
 * default (no time-travel — read the current state). `timestamp` addresses by
 * wall-clock (the common case: "as of yesterday 5pm"); `version` addresses a
 * Delta commit version directly (exact reproducibility of a specific commit).
 */
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export type AsOfSpec =
  | { kind: 'live' }
  | { kind: 'timestamp'; iso: string }
  | { kind: 'version'; version: number };

/** The canonical live (no time-travel) spec. */
export const LIVE: AsOfSpec = { kind: 'live' };

export class TimeMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeMachineError';
  }
}

/** True when the spec is the live/no-time-travel default. */
export function isLive(spec: AsOfSpec | null | undefined): boolean {
  return !spec || spec.kind === 'live';
}

// Accept a full ISO-8601 instant OR a bare calendar date (normalized to UTC
// midnight). Rejects anything Date can't parse (avoids `new Date('garbage')`
// → Invalid Date silently flowing into a query clause).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
const VERSION_RE = /^(?:v|version)[:=]?\s*(\d{1,15})$/i;

/**
 * Parse a raw `asOf` value (query param / body field / persisted branch pin)
 * into an {@link AsOfSpec}. Empty / `live` / `now` → live. `v:<n>` / `version=<n>`
 * / `v12` → a Delta version. Otherwise an ISO timestamp (bare date → UTC
 * midnight). THROWS {@link TimeMachineError} on a malformed non-empty value so a
 * route can return a precise 400 rather than silently reading live data.
 */
export function parseAsOf(raw: string | number | null | undefined): AsOfSpec {
  if (raw === null || raw === undefined) return LIVE;
  if (typeof raw === 'number') {
    if (Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0) return { kind: 'version', version: raw };
    throw new TimeMachineError(`Invalid asOf version '${raw}'.`);
  }
  const s = raw.trim();
  if (!s || /^(live|now|latest)$/i.test(s)) return LIVE;

  const vm = VERSION_RE.exec(s);
  if (vm) {
    const version = Number(vm[1]);
    if (Number.isSafeInteger(version) && version >= 0) return { kind: 'version', version };
    throw new TimeMachineError(`Invalid asOf version '${s}'.`);
  }

  if (ISO_DATE_RE.test(s) || ISO_DATETIME_RE.test(s)) {
    const d = new Date(ISO_DATE_RE.test(s) ? `${s}T00:00:00Z` : s);
    if (!Number.isNaN(d.getTime())) return { kind: 'timestamp', iso: d.toISOString() };
  }
  throw new TimeMachineError(
    `Invalid asOf '${s}'. Use an ISO-8601 timestamp (2026-07-01T17:00:00Z), a bare date (2026-07-01), or a Delta version (v:42).`,
  );
}

/** Lenient parse: like {@link parseAsOf} but returns {@link LIVE} on any bad input. */
export function parseAsOfLenient(raw: string | number | null | undefined): AsOfSpec {
  try {
    return parseAsOf(raw);
  } catch {
    return LIVE;
  }
}

/** A short human label for the time-bar / provenance ("Live", "as of …", "@v42"). */
export function asOfLabel(spec: AsOfSpec): string {
  switch (spec.kind) {
    case 'live': return 'Live';
    case 'timestamp': return `as of ${spec.iso}`;
    case 'version': return `as of v${spec.version}`;
  }
}

/** Serialize a spec back to a wire value (query param / persisted pin). Live → ''. */
export function serializeAsOf(spec: AsOfSpec): string {
  switch (spec.kind) {
    case 'live': return '';
    case 'timestamp': return spec.iso;
    case 'version': return `v:${spec.version}`;
  }
}

/** A stable cache-key fragment for a spec (folds asOf into a per-T result cache). */
export function asOfCacheToken(spec: AsOfSpec | null | undefined): string {
  if (!spec || spec.kind === 'live') return 'live';
  return spec.kind === 'version' ? `v:${spec.version}` : `t:${spec.iso}`;
}

/**
 * Append the session `asOf` to a request URL as `?asOf=<wire>` (client fetch
 * helper). A live spec is a no-op — the URL is returned unchanged so live reads
 * stay byte-identical. Preserves any existing query string.
 */
export function withAsOfParam(url: string, spec: AsOfSpec | null | undefined): string {
  if (!spec || spec.kind === 'live') return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}asOf=${encodeURIComponent(serializeAsOf(spec))}`;
}

// ── Backends ─────────────────────────────────────────────────────────────────

/**
 * The Azure-native backends the coordinator resolves. Each maps a spec to its
 * native clause — or an honest gate when the backend can't time-travel inline.
 */
export type TimeTravelBackend =
  | 'delta'                      // Databricks SQL / Spark SQL over Delta — TIMESTAMP/VERSION AS OF
  | 'synapse-serverless-delta'   // Synapse Serverless OPENROWSET over Delta — current snapshot only
  | 'synapse-temporal'           // Synapse Dedicated SQL system-versioned temporal — FOR SYSTEM_TIME AS OF
  | 'adx'                        // Azure Data Explorer — ingestion_time() filter
  | 'dax';                       // Semantic / DAX layer — no native time-travel (inherits source)

/** A resolved, applicable time-travel clause for one backend. */
export interface TimeTravelClause {
  supported: true;
  backend: TimeTravelBackend;
  spec: AsOfSpec;
  /** True when the spec is live — the clauses are empty and the query is unchanged. */
  noop: boolean;
  /** SQL table-ref suffix (e.g. ` TIMESTAMP AS OF '…'`), '' when noop. */
  sqlTableSuffix: string;
  /** KQL filter pipe segment (e.g. `| where ingestion_time() <= datetime(…)`), '' when noop. */
  kqlFilter: string;
  /** Human label. */
  label: string;
}

/** An honest gate — the backend cannot honor this asOf inline (named remediation). */
export interface TimeTravelGate {
  supported: false;
  backend: TimeTravelBackend;
  spec: AsOfSpec;
  code: string;
  reason: string;
}

export type TimeTravelResolution = TimeTravelClause | TimeTravelGate;

function clause(
  backend: TimeTravelBackend,
  spec: AsOfSpec,
  parts: { sqlTableSuffix?: string; kqlFilter?: string },
): TimeTravelClause {
  return {
    supported: true,
    backend,
    spec,
    noop: spec.kind === 'live',
    sqlTableSuffix: parts.sqlTableSuffix ?? '',
    kqlFilter: parts.kqlFilter ?? '',
    label: asOfLabel(spec),
  };
}

function gate(backend: TimeTravelBackend, spec: AsOfSpec, code: string, reason: string): TimeTravelGate {
  return { supported: false, backend, spec, code, reason };
}

/**
 * SQL string literal for an ISO timestamp — single-quote-escaped. The value is
 * ALWAYS a coordinator-normalized ISO string (from `new Date().toISOString()`),
 * never raw user text, so this only defends in depth.
 */
function sqlTsLiteral(iso: string): string {
  return `'${escapeSqlLiteral(iso)}'`;
}

/**
 * Resolve ONE `asOf` spec to ONE backend's native time-travel. `live` is always
 * a supported no-op (empty clauses) so callers thread it unconditionally and get
 * byte-identical queries when no time-travel is requested.
 */
export function resolveTimeTravel(backend: TimeTravelBackend, spec: AsOfSpec): TimeTravelResolution {
  if (spec.kind === 'live') return clause(backend, spec, {});

  switch (backend) {
    case 'delta': {
      // Databricks SQL / Spark SQL over Delta — both forms are native.
      if (spec.kind === 'version') return clause(backend, spec, { sqlTableSuffix: ` VERSION AS OF ${spec.version}` });
      return clause(backend, spec, { sqlTableSuffix: ` TIMESTAMP AS OF ${sqlTsLiteral(spec.iso)}` });
    }

    case 'synapse-temporal': {
      // System-versioned temporal tables address by wall-clock time only.
      if (spec.kind === 'version') {
        return gate(backend, spec, 'temporal_needs_timestamp',
          'A Synapse Dedicated SQL temporal table addresses history by time, not by Delta version — provide a timestamp asOf (a date/instant) instead of a version.');
      }
      return clause(backend, spec, { sqlTableSuffix: ` FOR SYSTEM_TIME AS OF ${sqlTsLiteral(spec.iso)}` });
    }

    case 'adx': {
      if (spec.kind === 'version') {
        return gate(backend, spec, 'adx_needs_timestamp',
          'Azure Data Explorer addresses history by time, not by Delta version — provide a timestamp asOf instead of a version.');
      }
      return clause(backend, spec, { kqlFilter: `| where ingestion_time() <= datetime(${spec.iso})` });
    }

    case 'synapse-serverless-delta':
      // OPENROWSET(FORMAT='DELTA') reads the current snapshot; there is no inline
      // AS OF on the Serverless engine. Name the backends that DO resolve as-of.
      return gate(backend, spec, 'serverless_delta_no_time_travel',
        'The Synapse Serverless engine reads the current Delta snapshot and has no inline time-travel. ' +
        'Query this data as of T through a Delta (Databricks SQL) source, an ADX/KQL stream, or a Synapse Dedicated temporal table — those resolve the same asOf natively.');

    case 'dax':
      return gate(backend, spec, 'dax_no_time_travel',
        'The semantic / DAX layer has no native time-travel — it always evaluates over the current model. ' +
        'Time-travel the bound lakehouse (Delta) or warehouse (temporal) source instead, then re-query the model.');

    default:
      return gate(backend, spec, 'unknown_backend', `Unknown time-travel backend '${backend as string}'.`);
  }
}

// ── Ontology source-kind → backend map ───────────────────────────────────────

/**
 * Map an ontology binding source kind (WS-6) to its time-travel backend so the
 * ontology resolver threads the SAME asOf to whichever engine each bound source
 * reads from. Keeps the source-kind knowledge in the ontology layer and the
 * time-travel knowledge here.
 */
export function backendForOntologySourceKind(kind: string): TimeTravelBackend {
  switch (kind) {
    case 'lakehouse-table': return 'synapse-serverless-delta'; // resolver reads via Serverless
    case 'shortcut': return 'synapse-serverless-delta';
    case 'warehouse-table': return 'synapse-temporal';         // Dedicated SQL temporal
    case 'kql': return 'adx';
    case 'semantic-measure': return 'dax';
    case 'azure-sql': return 'synapse-temporal';               // SQL temporal (unwired kind)
    default: return 'synapse-serverless-delta';
  }
}

// ── Clause application helpers ───────────────────────────────────────────────

/**
 * Append a resolved SQL table suffix to a bare table reference. A no-op / empty
 * suffix returns the ref unchanged. Callers pass a SUPPORTED clause (the resolver
 * honest-gates unsupported backends before building the query).
 */
export function applySqlTableSuffix(tableRef: string, resolution: TimeTravelResolution | null | undefined): string {
  if (!resolution || !resolution.supported || !resolution.sqlTableSuffix) return tableRef;
  return `${tableRef}${resolution.sqlTableSuffix}`;
}

/**
 * Insert a resolved KQL time-filter immediately after the table/stream name and
 * before the rest of the pipe. `<table> | where ingestion_time() <= datetime(…) | take n`.
 */
export function applyKqlFilter(tableRef: string, rest: string, resolution: TimeTravelResolution | null | undefined): string {
  const tail = rest.trim();
  if (!resolution || !resolution.supported || !resolution.kqlFilter) {
    return tail ? `${tableRef} ${tail}` : tableRef;
  }
  return `${tableRef} ${resolution.kqlFilter}${tail ? ` ${tail}` : ''}`;
}

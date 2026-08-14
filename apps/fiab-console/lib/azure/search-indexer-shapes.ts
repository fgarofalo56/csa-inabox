/**
 * Server-free shaping for the AI Search indexer FIELD-MAPPINGS builder + the
 * execution-history reader (AIF-10). Kept out of the data-plane client so the
 * `'use client'` editor and the server route agree on the exact wire shape a
 * PUT /indexers/{name} field-mapping payload takes, and so the shaping is unit
 * testable without a network.
 *
 * Grounded in Microsoft Learn:
 *   - Field mappings + mapping functions:
 *     https://learn.microsoft.com/azure/search/search-indexer-field-mappings
 *   - Indexer execution status (`executionHistory[]`):
 *     https://learn.microsoft.com/rest/api/searchservice/get-indexer-status
 */

/**
 * The built-in field-mapping functions AI Search exposes. `''` = a straight
 * source→target mapping with no function. Only functions with parameters take
 * extra inputs in the builder (extractTokenAtPosition; the base64 pair's
 * optional UTF-8 flag).
 */
export const MAPPING_FUNCTIONS = [
  '',
  'base64Encode',
  'base64Decode',
  'extractTokenAtPosition',
  'jsonArrayToStringCollection',
  'urlEncode',
  'urlDecode',
  'fixedLengthEncode',
] as const;

export type MappingFunctionName = (typeof MAPPING_FUNCTIONS)[number];

/** Human labels for the mapping-function dropdown. */
export const MAPPING_FUNCTION_LABELS: Record<string, string> = {
  '': '(none — direct)',
  base64Encode: 'base64Encode',
  base64Decode: 'base64Decode',
  extractTokenAtPosition: 'extractTokenAtPosition',
  jsonArrayToStringCollection: 'jsonArrayToStringCollection',
  urlEncode: 'urlEncode',
  urlDecode: 'urlDecode',
  fixedLengthEncode: 'fixedLengthEncode',
};

/** One row in the field-mappings / output-field-mappings builder. */
export interface FieldMappingRow {
  sourceFieldName: string;
  targetFieldName: string;
  /** Mapping-function name, or '' for a direct mapping. */
  functionName: MappingFunctionName;
  // extractTokenAtPosition parameters
  delimiter?: string;
  position?: number;
  // base64Encode / base64Decode parameter
  useHttpServerUtf8Encoding?: boolean;
}

/** A blank builder row (direct mapping). */
export function emptyFieldMappingRow(): FieldMappingRow {
  return { sourceFieldName: '', targetFieldName: '', functionName: '' };
}

/** True when this function carries editable parameters. */
export function functionHasParameters(fn: MappingFunctionName): boolean {
  return fn === 'extractTokenAtPosition' || fn === 'base64Encode' || fn === 'base64Decode';
}

/** Build a single AI Search field-mapping wire object from a builder row. */
export function buildFieldMapping(row: FieldMappingRow): any | null {
  const source = (row.sourceFieldName || '').trim();
  const target = (row.targetFieldName || '').trim();
  if (!source || !target) return null;
  const out: any = { sourceFieldName: source, targetFieldName: target };
  if (row.functionName) {
    const fn: any = { name: row.functionName };
    if (row.functionName === 'extractTokenAtPosition') {
      fn.parameters = {
        delimiter: row.delimiter ?? ' ',
        position: typeof row.position === 'number' && !Number.isNaN(row.position) ? row.position : 0,
      };
    } else if (row.functionName === 'base64Encode' || row.functionName === 'base64Decode') {
      if (row.useHttpServerUtf8Encoding) fn.parameters = { useHttpServerUtf8Encoding: true };
    }
    out.mappingFunction = fn;
  }
  return out;
}

/** Build the full `fieldMappings[]` wire array from builder rows (skips incomplete rows). */
export function buildFieldMappings(rows: FieldMappingRow[]): any[] {
  return (rows || []).map(buildFieldMapping).filter((m): m is any => m != null);
}

/** Parse one AI Search field-mapping wire object into an editable builder row. */
export function parseFieldMapping(m: any): FieldMappingRow {
  const fn = m?.mappingFunction;
  const name: MappingFunctionName = (MAPPING_FUNCTIONS as readonly string[]).includes(fn?.name)
    ? (fn.name as MappingFunctionName)
    : '';
  const row: FieldMappingRow = {
    sourceFieldName: m?.sourceFieldName ?? '',
    targetFieldName: m?.targetFieldName ?? '',
    functionName: name,
  };
  if (name === 'extractTokenAtPosition') {
    row.delimiter = fn?.parameters?.delimiter ?? ' ';
    row.position = typeof fn?.parameters?.position === 'number' ? fn.parameters.position : 0;
  } else if (name === 'base64Encode' || name === 'base64Decode') {
    row.useHttpServerUtf8Encoding = !!fn?.parameters?.useHttpServerUtf8Encoding;
  }
  return row;
}

/** Parse an indexer definition's field + output-field mappings into builder rows. */
export function parseIndexerMappings(indexer: any): {
  fieldMappings: FieldMappingRow[];
  outputFieldMappings: FieldMappingRow[];
} {
  const fm = Array.isArray(indexer?.fieldMappings) ? indexer.fieldMappings.map(parseFieldMapping) : [];
  const ofm = Array.isArray(indexer?.outputFieldMappings) ? indexer.outputFieldMappings.map(parseFieldMapping) : [];
  return { fieldMappings: fm, outputFieldMappings: ofm };
}

// ----------------------------------------------------------------------------
// Execution history (GET /indexers/{name}/status → executionHistory[]).
// ----------------------------------------------------------------------------

/** One normalized indexer execution-history run. */
export interface IndexerRun {
  status: string;
  startTime?: string;
  endTime?: string;
  itemsProcessed: number;
  itemsFailed: number;
  errorMessage?: string;
  errors: Array<{ key?: string; name?: string; errorMessage: string; details?: string }>;
  warnings: Array<{ key?: string; name?: string; message: string }>;
  finalTrackingState?: string;
}

/** Normalize a raw `/status` response into `{ lastResult, executionHistory[] }`. */
export function parseExecutionHistory(status: any): {
  overallStatus?: string;
  lastResult?: IndexerRun;
  executionHistory: IndexerRun[];
} {
  const mapRun = (r: any): IndexerRun => ({
    status: r?.status ?? 'unknown',
    startTime: r?.startTime,
    endTime: r?.endTime,
    itemsProcessed: typeof r?.itemsProcessed === 'number' ? r.itemsProcessed : 0,
    itemsFailed: typeof r?.itemsFailed === 'number' ? r.itemsFailed : 0,
    errorMessage: r?.errorMessage || undefined,
    errors: Array.isArray(r?.errors)
      ? r.errors.map((e: any) => ({ key: e?.key, name: e?.name, errorMessage: e?.errorMessage ?? String(e), details: e?.details }))
      : [],
    warnings: Array.isArray(r?.warnings)
      ? r.warnings.map((w: any) => ({ key: w?.key, name: w?.name, message: w?.message ?? String(w) }))
      : [],
    finalTrackingState: r?.finalTrackingState,
  });
  const history = Array.isArray(status?.executionHistory) ? status.executionHistory.map(mapRun) : [];
  return {
    overallStatus: status?.status,
    lastResult: status?.lastResult ? mapRun(status.lastResult) : undefined,
    executionHistory: history,
  };
}

// ----------------------------------------------------------------------------
// Resync (POST /indexers/{name}/resync, preview) — partial reindex of only the
// selected options. Currently the sole supported option is `permissions`
// (re-ingest ADLS Gen2 ACL / RBAC scope whose last-modified time didn't change,
// so ordinary change-tracking misses it). After a resync call the indexer must
// be RUN to apply it. Grounded in Learn:
//   https://learn.microsoft.com/azure/search/search-howto-run-reset-indexers#how-to-resync-indexers-preview
// ----------------------------------------------------------------------------

/** The resync options AI Search currently supports (preview). */
export const RESYNC_OPTIONS = ['permissions'] as const;
export type ResyncOption = (typeof RESYNC_OPTIONS)[number];

/** Human labels for the resync-options checkboxes. */
export const RESYNC_OPTION_LABELS: Record<string, string> = {
  permissions: 'Permissions (ADLS Gen2 ACL / RBAC scope)',
};

/**
 * Normalize a user-selected resync-options list to the wire array: de-duplicate,
 * trim, and drop anything outside the supported set. An empty/invalid selection
 * falls back to `['permissions']` (the only supported option today) so the
 * resync call is always well-formed. Kept server-free + unit-testable.
 */
export function normalizeResyncOptions(sel: string[] | undefined): string[] {
  const allowed = new Set<string>(RESYNC_OPTIONS as readonly string[]);
  const out = Array.from(
    new Set((sel || []).map((s) => String(s).trim()).filter(Boolean)),
  ).filter((s) => allowed.has(s));
  return out.length ? out : ['permissions'];
}

// ----------------------------------------------------------------------------
// Indexer HEALTH — the verdict every surface must render (#3384).
//
// WHY THIS EXISTS (measured 2026-08-13, re-verified 2026-08-14)
// ------------------------------------------------------------
// GET /indexers/research-knowledge-indexer/status on dlz-aisearch-dev-eastus2
// returned, verbatim:
//
//     "status": "running"                        <-- the TOP-LEVEL field
//     lastResult.status: "transientFailure"
//     lastResult.errorMessage:
//       "Could not connect to Annotation Cache Index Storage Acount."
//     executionHistory: 50 runs, {'transientFailure': 50}
//     itemsProcessed: 0 on every one of them
//
// Fifty consecutive failures, an index holding zero documents, a live daily
// schedule — and the field most consumers read said `running`.
//
// That is not a bug in Azure. Per Learn (Get Indexer Status) the top-level
// `status` is `running | error` and describes the INDEXER OBJECT — "the indexer
// is enabled and the service can execute it". It says NOTHING about whether any
// execution succeeded. Treating it as health is the repo's dominant defect
// class: a green dashboard over a dead pipeline.
//
// So health is derived HERE, once, from what was actually observed, and every
// surface renders THIS verdict rather than picking a field. The contract:
//
//   * the top-level `status` is REPORTED (`indexerServiceStatus`) and NEVER
//     used to reach 'healthy';
//   * an unreadable / absent / empty payload is 'unknown', never 'healthy' —
//     fail closed (deploy-integrity R6);
//   * `observed` states what was actually seen and nothing more (R7);
//   * a non-healthy verdict always carries a concrete `remediation` (R6).
//
// Grounded in Learn:
//   - Get Indexer Status (status vs lastResult vs executionHistory):
//     https://learn.microsoft.com/rest/api/searchservice/get-indexer-status
//   - Indexer troubleshooting (connection / RBAC / firewall classes):
//     https://learn.microsoft.com/azure/search/search-indexer-troubleshooting
//   - Enrichment cache anatomy — a blob container `ms-az-search-indexercache-*`
//     AND tables `MsAzSearchIndexerCacheIndex*` in YOUR storage account:
//     https://learn.microsoft.com/azure/search/enrichment-cache-how-to-configure
// ----------------------------------------------------------------------------

/**
 * The health verdict for one indexer.
 *
 * `pending` and `unknown` are deliberately distinct and NEITHER is healthy:
 * `pending` = "the service returned a status and it holds no terminal run yet";
 * `unknown` = "nothing usable was observed" (no payload, unreadable payload).
 */
export type IndexerHealthVerdict =
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'pending'
  | 'disabled'
  | 'unknown';

export interface IndexerHealth {
  verdict: IndexerHealthVerdict;
  /** True only for `healthy`. The single boolean a caller may branch on. */
  healthy: boolean;
  /** What was ACTUALLY observed — never an inference (deploy-integrity R7). */
  observed: string;
  /** Consecutive terminal failures at the head of the history (newest first). */
  consecutiveFailures: number;
  /** Terminal runs examined (executionHistory + lastResult, de-duplicated). */
  runsExamined: number;
  /**
   * The raw top-level `status` field. REPORTED so it is inspectable; it can
   * never on its own produce a 'healthy' verdict.
   */
  indexerServiceStatus?: string;
  lastRunStatus?: string;
  lastRunStartTime?: string;
  /** Verbatim service error from the newest failing run, if any. */
  errorMessage?: string;
  /** Items processed by the newest terminal run. */
  itemsProcessed?: number;
  /** Documents currently in the target index, when the caller supplied it. */
  documentCount?: number;
  /** Concrete, actionable remediation. Always present when !healthy. */
  remediation?: string;
}

export interface IndexerHealthOptions {
  /** `disabled` from the indexer definition — an intentionally-off indexer. */
  disabled?: boolean;
  /** True when the indexer definition carries a `schedule`. */
  scheduled?: boolean;
  /** `documentCount` from GET /indexes/{n}/stats, when the caller has it. */
  documentCount?: number;
  /** Consecutive failures at which 'degraded' becomes 'failed'. Default 3. */
  failThreshold?: number;
  /** Free-text reason the status could not be read at all (fetch threw). */
  unreadableReason?: string;
}

/** Terminal run statuses AI Search reports (Learn: Get Indexer Status). */
const FAILURE_RUN_STATUSES = new Set(['transientFailure', 'persistentFailure', 'error', 'failed']);
const IN_FLIGHT_RUN_STATUSES = new Set(['inProgress', 'reset', 'resetDocs']);

/**
 * Remediation for a quoted indexer error, classified by shape
 * (deploy-integrity R6 — classify, then name the exact fix).
 *
 * Deliberately ordered most-specific first: the enrichment/annotation cache
 * failure is checked BEFORE the generic "could not connect", because the two
 * have different fixes and the generic one sent the 2026-08-13 investigation at
 * the data source (which was fine) instead of at the cache.
 */
export function indexerErrorRemediation(errorMessage?: string): string | undefined {
  const msg = String(errorMessage || '');
  if (!msg.trim()) return undefined;

  // Azure's own message carries the typo "Acount" — match both spellings so a
  // service-side correction cannot silently un-match this branch.
  if (/annotation cache|indexercache|enrichment cache/i.test(msg) || /cache index storage ac+ount/i.test(msg)) {
    return (
      'The enrichment (annotation) cache could not be reached, so the skillset never ran — every run fails ' +
      'before a single document is enriched. The cache lives in YOUR storage account as BOTH a blob container ' +
      '(ms-az-search-indexercache-*) AND tables (MsAzSearchIndexerCacheIndex*), so a blob-only grant leaves the ' +
      'table half unreachable. Check, in order: (1) the search service identity holds "Storage Blob Data ' +
      'Contributor" AND "Storage Table Data Contributor" on that storage account — the control-plane ' +
      '"Contributor" role grants NEITHER data plane; (2) the account still permits the auth mode the connection ' +
      'uses (allowSharedKeyAccess for a key connection string); (3) the account firewall allows the search ' +
      'service (defaultAction Allow, or a resource-access rule / shared private link); (4) the account and its ' +
      'cache container still exist. Then reset + run the indexer to reseed the cache.'
    );
  }
  if (/403|forbidden|unauthoriz|not authorized|access denied|credentials/i.test(msg)) {
    return (
      'The indexer was denied by the source or a dependency. Grant the search service identity the data-plane ' +
      'role for that resource (e.g. "Storage Blob Data Reader" on the source account) — a control-plane role ' +
      'such as Contributor does not grant data-plane access — then run the indexer.'
    );
  }
  if (/could not connect|network|timeout|timed out|unreachable|host|dns|firewall/i.test(msg)) {
    return (
      'The indexer could not reach a dependency. Verify the resource still exists, that its firewall admits the ' +
      'search service (IP rule, trusted-service bypass, or a shared private link for a private endpoint), and ' +
      'that any stored connection string still resolves. See ' +
      'https://learn.microsoft.com/azure/search/search-indexer-troubleshooting'
    );
  }
  return (
    `Indexer run failed: "${msg.slice(0, 240)}". Open the run in the indexer's execution history for the full ` +
    'error, then see https://learn.microsoft.com/azure/search/cognitive-search-common-errors-warnings'
  );
}

/**
 * Classify one indexer's health from its raw `GET /indexers/{n}/status` payload.
 *
 * `status` may be the raw service payload OR `null`/`undefined` when the caller
 * could not read it at all — the latter yields 'unknown' plus the caller's
 * `unreadableReason`, never a pass.
 */
export function classifyIndexerHealth(status: any, opts: IndexerHealthOptions = {}): IndexerHealth {
  const failThreshold = Number.isFinite(opts.failThreshold) ? Number(opts.failThreshold) : 3;
  const serviceStatus = typeof status?.status === 'string' ? status.status : undefined;

  const unknown = (observed: string, remediation: string): IndexerHealth => ({
    verdict: 'unknown',
    healthy: false,
    observed,
    consecutiveFailures: 0,
    runsExamined: 0,
    indexerServiceStatus: serviceStatus,
    documentCount: opts.documentCount,
    remediation,
  });

  if (!status || typeof status !== 'object') {
    return unknown(
      opts.unreadableReason
        ? `The indexer status could not be read: ${String(opts.unreadableReason).slice(0, 200)}`
        : 'No indexer status payload was returned, so nothing was observed about this pipeline.',
      'Re-read GET /indexers/{name}/status. Until it answers, this pipeline is UNVERIFIED — it is not being ' +
        'reported healthy on the strength of a read that did not happen.',
    );
  }

  const parsed = parseExecutionHistory(status);
  // lastResult is normally executionHistory[0]; de-duplicate on startTime so a
  // service that omits one or the other still yields one ordered list.
  const runs: IndexerRun[] = [...parsed.executionHistory];
  if (parsed.lastResult && !runs.some((r) => r.startTime && r.startTime === parsed.lastResult!.startTime)) {
    runs.unshift(parsed.lastResult);
  }
  const terminal = runs.filter((r) => !IN_FLIGHT_RUN_STATUSES.has(r.status));
  const head = terminal[0];

  let consecutiveFailures = 0;
  for (const r of terminal) {
    if (FAILURE_RUN_STATUSES.has(r.status)) consecutiveFailures += 1;
    else break;
  }
  const allFailed = terminal.length > 0 && consecutiveFailures === terminal.length;

  const base = {
    healthy: false,
    consecutiveFailures,
    runsExamined: terminal.length,
    indexerServiceStatus: serviceStatus,
    lastRunStatus: head?.status,
    lastRunStartTime: head?.startTime,
    errorMessage: head && FAILURE_RUN_STATUSES.has(head.status) ? head.errorMessage : undefined,
    itemsProcessed: head?.itemsProcessed,
    documentCount: opts.documentCount,
  };
  const svc = serviceStatus ? ` (the service reports indexer status "${serviceStatus}", which means the indexer is ENABLED — not that any run succeeded)` : '';

  if (opts.disabled === true) {
    return {
      ...base,
      verdict: 'disabled',
      observed: `The indexer is disabled; ${terminal.length} retained run(s) examined${svc}.`,
      remediation: 'This indexer is disabled, so it will never run. Enable it, or delete it if it is abandoned.',
    };
  }

  if (terminal.length === 0) {
    // A run may be in flight — say so, but do not call it healthy.
    const inFlight = runs.find((r) => IN_FLIGHT_RUN_STATUSES.has(r.status));
    return {
      ...base,
      verdict: 'pending',
      observed: inFlight
        ? `A run is in flight (${inFlight.status}); no terminal run has been recorded yet${svc}.`
        : `No run has been recorded yet, so nothing has been proven about this pipeline${svc}.`,
      remediation:
        'Run the indexer and re-read its status. Until a terminal run is recorded this pipeline is unproven — ' +
        'it is deliberately NOT reported healthy.',
    };
  }

  if (consecutiveFailures > 0) {
    const quoted = head?.errorMessage ? ` Last error: "${head.errorMessage}".` : '';
    const failed = allFailed || consecutiveFailures >= failThreshold;
    return {
      ...base,
      verdict: failed ? 'failed' : 'degraded',
      observed:
        `${consecutiveFailures} of the ${terminal.length} retained run(s) failed consecutively` +
        `${allFailed ? ' — EVERY retained run failed' : ''}; the newest is "${head?.status}" with ` +
        `${head?.itemsProcessed ?? 0} item(s) processed${svc}.${quoted}`,
      remediation: indexerErrorRemediation(head?.errorMessage),
    };
  }

  // Head run succeeded. A success is still not health if it moved nothing and
  // the index is empty — "a run that succeeds with 0 items is not a fix" (#3384).
  const emptyIndex = opts.documentCount === 0;
  const movedNothing = terminal.every((r) => (r.itemsProcessed ?? 0) === 0);
  if (emptyIndex || (movedNothing && opts.scheduled)) {
    return {
      ...base,
      verdict: 'degraded',
      observed:
        `The newest run reports "${head?.status}", but ` +
        (emptyIndex
          ? 'the target index holds 0 documents'
          : `no retained run has processed a single item (${terminal.length} run(s) examined)`) +
        `${opts.scheduled ? ' while the indexer is on a schedule' : ''}${svc}.`,
      remediation:
        'A succeeding indexer over an empty index means the source is empty, the source path/prefix is wrong, ' +
        'or change-tracking believes there is nothing new. Verify the data source container + query prefix, then ' +
        'reset and run the indexer to force a full re-crawl.',
    };
  }

  return {
    ...base,
    healthy: true,
    verdict: 'healthy',
    observed:
      `The newest of ${terminal.length} retained run(s) succeeded at ${head?.startTime || 'an unrecorded time'} ` +
      `with ${head?.itemsProcessed ?? 0} item(s) processed and ${head?.itemsFailed ?? 0} failed` +
      (Number.isFinite(opts.documentCount) ? `; the target index holds ${opts.documentCount} document(s)` : '') +
      `${svc}.`,
  };
}

/** Fluent Badge colour for a health verdict. Only 'healthy' is green. */
export function indexerHealthColor(verdict: IndexerHealthVerdict): 'success' | 'warning' | 'danger' | 'informative' {
  if (verdict === 'healthy') return 'success';
  if (verdict === 'failed') return 'danger';
  if (verdict === 'degraded') return 'warning';
  return 'informative';
}

/** One-line summary for a log / probe detail line. */
export function formatIndexerHealth(name: string, h: IndexerHealth): string {
  return `${name}: ${h.verdict.toUpperCase()} — ${h.observed}`;
}

/** Format an ISO datetime range into a short "duration" string for the history grid. */
export function runDuration(run: Pick<IndexerRun, 'startTime' | 'endTime'>): string {
  if (!run.startTime) return '—';
  const start = Date.parse(run.startTime);
  const end = run.endTime ? Date.parse(run.endTime) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

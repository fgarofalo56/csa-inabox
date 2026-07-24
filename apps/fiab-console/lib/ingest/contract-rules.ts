/**
 * N6 — the PURE ODCS contract-enforcement decision engine.
 *
 * This module holds the whole "conform → land / violate → quarantine" decision
 * with ZERO side effects and ZERO Azure imports, so the decision matrix is unit
 * testable exactly as the ingestion paths execute it. The side-effecting half
 * (dead-letter write to ADLS Bronze, O1 alert, run history) lives in
 * `./contract-enforcement.ts` and calls straight into these functions.
 *
 * THE DEFAULT (operator-CONFIRMED, asserted in the unit tests): enforcement is
 * default-ON in **`warn-quarantine`** mode — violating rows divert to the
 * Bronze `_rejected` dead-letter path and an alert fires, but the conforming
 * remainder of the batch STILL LANDS. A newly authored contract can therefore
 * never silently drop a production load on day one. `hard-reject` (fail the
 * whole batch, land nothing) is a per-contract OPT-IN.
 *
 * Severity model:
 *   • An expectation's own `severity` decides whether a violated row is
 *     REJECTED (`error`) or merely FLAGGED (`warning` / `info`). A row with
 *     only warnings still lands in BOTH modes — warnings are observations.
 *   • Type / required violations default to `error` unless the contract's own
 *     rule says otherwise.
 *   • Undeclared extra columns are a `warning` (schema drift you want to see,
 *     not a reason to drop a row); a declared column missing from the batch
 *     header is an `error` (the contract's shape is not being met).
 *
 * Per-cloud: pure computation — identical Commercial / GCC-High / IL5.
 * **IL5**: no network, no service dependency; runs inside the enclave.
 */

import {
  DEFAULT_ENFORCEMENT_MODE,
  type EnforcementDecisionKind,
  type EnforcementMode,
  type OdcsContract,
  type OdcsProperty,
  type OdcsQualityRule,
  type OdcsSchemaObject,
} from '@/lib/azure/data-contract-model';

export { DEFAULT_ENFORCEMENT_MODE };

/** Severity of ONE violation. Only `error` diverts a row. */
export type ViolationSeverity = 'error' | 'warning' | 'info';

export interface RowViolation {
  /** The property that failed; absent for row/table-scoped failures. */
  column?: string;
  /** Stable machine rule id (`nullValues`, `invalidType`, `regex`, …). */
  rule: string;
  severity: ViolationSeverity;
  /** Human, actionable — this is what lands in the dead-letter record. */
  detail: string;
}

export interface RejectedRow {
  /** 0-based index within the evaluated batch. */
  index: number;
  row: Record<string, unknown>;
  violations: RowViolation[];
}

export interface BatchEvaluation {
  mode: EnforcementMode;
  evaluated: number;
  /** Rows that LAND. Empty in `hard-reject` when anything failed. */
  accepted: Record<string, unknown>[];
  /** Rows diverted to the dead-letter path. */
  rejected: RejectedRow[];
  /** Rows that landed but carry non-blocking warnings. */
  warned: RejectedRow[];
  decision: EnforcementDecisionKind;
  /** True when the O1 alert must fire for this batch. */
  alert: boolean;
  /** P1 for a blocked batch, P2 for quarantine, P3 for warnings only. */
  alertSeverity: 'P1' | 'P2' | 'P3';
  topViolations: Array<{ rule: string; column?: string; count: number }>;
  /** Honest one-liner the caller surfaces in its receipt / note field. */
  note: string;
}

/** Bound the work one batch evaluation can do (defensive, not user-facing). */
const MAX_ROWS = 200_000;
/** Regex patterns longer than this are refused rather than compiled (ReDoS). */
const MAX_PATTERN_LEN = 200;

/** The schema object a contract governs (Loom authors a single object). */
export function contractObject(odcs: OdcsContract | null | undefined): OdcsSchemaObject | null {
  const objs = odcs && Array.isArray(odcs.schema) ? odcs.schema : [];
  return objs.length ? objs[0] : null;
}

/**
 * Compile a user-authored pattern defensively. Refuses over-long patterns and
 * the classic catastrophic-backtracking shape (a quantified group that is
 * itself quantified, e.g. `(a+)+`), returning null so the caller records an
 * honest "pattern refused" violation instead of hanging the ingestion thread.
 */
export function safePattern(pattern: string): RegExp | null {
  const p = String(pattern || '');
  if (!p || p.length > MAX_PATTERN_LEN) return null;
  if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(p)) return null; // nested quantifier
  try {
    return new RegExp(p);
  } catch {
    return null;
  }
}

/** Read a `customProperties` entry off an ODCS quality rule. */
function cp(rule: OdcsQualityRule, key: string): string | undefined {
  const hit = (rule.customProperties || []).find((c) => c && c.property === key);
  return hit && hit.value != null ? String(hit.value) : undefined;
}

/** Normalize an ODCS rule severity to the enforcement severity model. */
function severityOf(rule: OdcsQualityRule, fallback: ViolationSeverity = 'error'): ViolationSeverity {
  const s = String(rule.severity || '').toLowerCase();
  if (s === 'error' || s === 'warning' || s === 'info') return s;
  return fallback;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Does `value` conform to an ODCS logical type? Ingestion values arrive from
 * CSV / JSON / event payloads, so a numeric string IS a valid integer — the
 * check is "can this be read as the declared type", not "is it that JS type".
 */
export function conformsToLogicalType(value: unknown, logicalType: string): boolean {
  if (isBlank(value)) return true; // nullness is the `required` rule's job
  switch (logicalType) {
    case 'integer': {
      const n = Number(value);
      return Number.isFinite(n) && Number.isInteger(n);
    }
    case 'number':
      return Number.isFinite(Number(value));
    case 'boolean': {
      if (typeof value === 'boolean') return true;
      const s = String(value).trim().toLowerCase();
      return ['true', 'false', '0', '1', 'yes', 'no'].includes(s);
    }
    case 'date': {
      if (value instanceof Date) return !Number.isNaN(value.getTime());
      return Number.isFinite(Date.parse(String(value)));
    }
    case 'array':
      return Array.isArray(value) || /^\s*\[/.test(String(value));
    case 'object':
      return (typeof value === 'object' && value !== null) || /^\s*\{/.test(String(value));
    case 'string':
    default:
      return true;
  }
}

/** Evaluate the Loom rules an ODCS quality entry carries against ONE value. */
function evaluateQualityRule(
  rule: OdcsQualityRule, column: string, value: unknown,
): RowViolation | null {
  const loomRule = cp(rule, 'loomRule');
  const loomValue = cp(rule, 'loomValue');
  const severity = severityOf(rule);

  // ── ODCS library primitives ──
  if (rule.type === 'library') {
    if (rule.rule === 'nullValues' && isBlank(value)) {
      return { column, rule: 'nullValues', severity, detail: `'${column}' is null but the contract requires a value.` };
    }
    if (rule.rule === 'invalidValues' && Array.isArray(rule.validValues) && !isBlank(value)) {
      const allowed = rule.validValues.map((v) => String(v));
      if (!allowed.includes(String(value))) {
        return {
          column, rule: 'invalidValues', severity,
          detail: `'${column}' = ${JSON.stringify(value)} is not one of the accepted values [${allowed.join(', ')}].`,
        };
      }
    }
    // duplicateValues / rowCount are batch-scoped — handled in evaluateBatch.
    return null;
  }

  // ── Loom custom rules (min / max / range / regex / freshness) ──
  if (!loomRule || isBlank(value)) return null;
  if (loomRule === 'min' || loomRule === 'max') {
    const bound = Number(loomValue);
    const n = Number(value);
    if (!Number.isFinite(bound)) return null;
    if (!Number.isFinite(n)) {
      return { column, rule: loomRule, severity, detail: `'${column}' = ${JSON.stringify(value)} is not numeric, so the ${loomRule} bound ${bound} cannot be met.` };
    }
    if (loomRule === 'min' && n < bound) {
      return { column, rule: 'min', severity, detail: `'${column}' = ${n} is below the contract minimum ${bound}.` };
    }
    if (loomRule === 'max' && n > bound) {
      return { column, rule: 'max', severity, detail: `'${column}' = ${n} is above the contract maximum ${bound}.` };
    }
    return null;
  }
  if (loomRule === 'range') {
    const [lo, hi] = String(loomValue || '').split('..').map((s) => Number(s.trim()));
    const n = Number(value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      return { column, rule: 'range', severity, detail: `'${column}' = ${JSON.stringify(value)} is outside the contract range ${lo}..${hi}.` };
    }
    return null;
  }
  if (loomRule === 'regex') {
    const re = safePattern(String(loomValue || ''));
    if (!re) {
      return { column, rule: 'regex', severity: 'warning', detail: `The regex expectation on '${column}' was refused (empty, over-long, or catastrophic-backtracking pattern) and was not evaluated.` };
    }
    if (!re.test(String(value))) {
      return { column, rule: 'regex', severity, detail: `'${column}' = ${JSON.stringify(value)} does not match the contract pattern /${loomValue}/.` };
    }
    return null;
  }
  if (loomRule === 'freshness') {
    const maxAgeMs = parseDuration(String(loomValue || ''));
    if (maxAgeMs == null) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(t)) {
      return { column, rule: 'freshness', severity, detail: `'${column}' = ${JSON.stringify(value)} is not a timestamp, so freshness cannot be evaluated.` };
    }
    const age = Date.now() - t;
    if (age > maxAgeMs) {
      return { column, rule: 'freshness', severity, detail: `'${column}' is ${Math.round(age / 60000)} minutes old, past the contract's ${loomValue} freshness commitment.` };
    }
  }
  return null;
}

/** `24h` / `30m` / `7d` / `90s` → milliseconds; null when unparseable. */
export function parseDuration(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(String(v || ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Number.isFinite(n) ? n * mult[unit] : null;
}

/** Evaluate ONE row against the contract's schema object. */
export function evaluateRow(
  object: OdcsSchemaObject | null, row: Record<string, unknown>,
): RowViolation[] {
  const out: RowViolation[] = [];
  if (!object) return out;
  const props: OdcsProperty[] = Array.isArray(object.properties) ? object.properties : [];
  const declared = new Set(props.map((p) => p.name));

  for (const p of props) {
    const value = row[p.name];
    if (p.required === true && isBlank(value)) {
      out.push({ column: p.name, rule: 'required', severity: 'error', detail: `'${p.name}' is required by the contract but the row has no value.` });
      continue; // a missing required value can't also fail type/range checks
    }
    if (!conformsToLogicalType(value, p.logicalType)) {
      out.push({
        column: p.name, rule: 'invalidType', severity: 'error',
        detail: `'${p.name}' = ${JSON.stringify(value)} is not a valid ${p.logicalType}${p.physicalType ? ` (${p.physicalType})` : ''}.`,
      });
      continue;
    }
    for (const rule of p.quality || []) {
      const v = evaluateQualityRule(rule, p.name, value);
      if (v) out.push(v);
    }
  }

  // Schema drift — extra, undeclared columns are observed, never dropped.
  for (const key of Object.keys(row)) {
    if (!declared.has(key)) {
      out.push({ column: key, rule: 'undeclaredColumn', severity: 'warning', detail: `'${key}' is present in the batch but not declared by the contract (schema drift).` });
    }
  }
  return out;
}

export interface EvaluateBatchInput {
  odcs: OdcsContract | null | undefined;
  rows: Record<string, unknown>[];
  /** Ordered batch header; when provided, missing declared columns are errors. */
  columns?: string[];
  /** Defaults to DEFAULT_ENFORCEMENT_MODE — warn + quarantine, never reject. */
  mode?: EnforcementMode;
}

/**
 * THE decision matrix. Pure: no I/O, no clock beyond freshness evaluation.
 *
 *   conforming row              → lands
 *   row with only warnings      → lands (and is reported)
 *   row with an error violation → quarantined  (warn-quarantine, the DEFAULT)
 *                               → whole batch rejected (hard-reject, opt-in)
 */
export function evaluateBatch(input: EvaluateBatchInput): BatchEvaluation {
  const mode: EnforcementMode = input.mode || DEFAULT_ENFORCEMENT_MODE;
  const object = contractObject(input.odcs);
  const rows = (input.rows || []).slice(0, MAX_ROWS);

  const accepted: Record<string, unknown>[] = [];
  const rejected: RejectedRow[] = [];
  const warned: RejectedRow[] = [];
  const counts = new Map<string, { rule: string; column?: string; count: number }>();

  const bump = (v: RowViolation) => {
    const key = `${v.rule}|${v.column || ''}`;
    const hit = counts.get(key);
    if (hit) hit.count++;
    else counts.set(key, { rule: v.rule, column: v.column, count: 1 });
  };

  // Batch-scoped header check: a declared column absent from the header means
  // the producer's shape no longer meets the contract at all.
  const headerViolations: RowViolation[] = [];
  if (object && Array.isArray(input.columns) && input.columns.length) {
    const present = new Set(input.columns.map((c) => String(c)));
    for (const p of object.properties || []) {
      if (!present.has(p.name)) {
        headerViolations.push({ column: p.name, rule: 'missingColumn', severity: 'error', detail: `The contract declares '${p.name}' but the incoming batch has no such column.` });
      }
    }
  }

  // Batch-scoped uniqueness (ODCS `duplicateValues` / property.unique).
  const uniqueProps = (object?.properties || []).filter(
    (p) => p.unique === true || p.primaryKey === true ||
      (p.quality || []).some((q) => q.type === 'library' && q.rule === 'duplicateValues'),
  );
  const seen = new Map<string, Set<string>>();
  for (const p of uniqueProps) seen.set(p.name, new Set<string>());

  rows.forEach((row, index) => {
    const violations = [...headerViolations, ...evaluateRow(object, row)];
    for (const p of uniqueProps) {
      const v = row[p.name];
      if (isBlank(v)) continue;
      const set = seen.get(p.name)!;
      const k = String(v);
      if (set.has(k)) {
        violations.push({ column: p.name, rule: 'duplicateValues', severity: 'error', detail: `'${p.name}' = ${JSON.stringify(v)} appears more than once, but the contract declares it unique.` });
      } else {
        set.add(k);
      }
    }
    for (const v of violations) bump(v);
    const blocking = violations.filter((v) => v.severity === 'error');
    if (blocking.length) rejected.push({ index, row, violations });
    else {
      accepted.push(row);
      if (violations.length) warned.push({ index, row, violations });
    }
  });

  const topViolations = Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 10);

  let decision: EnforcementDecisionKind;
  let alert = false;
  let alertSeverity: 'P1' | 'P2' | 'P3' = 'P3';
  let note: string;

  if (rejected.length === 0) {
    decision = 'landed';
    note = warned.length
      ? `All ${rows.length} rows conform; ${warned.length} carry non-blocking warnings (schema drift or warning-severity expectations).`
      : `All ${rows.length} rows conform to the contract.`;
    if (warned.length) { alert = true; alertSeverity = 'P3'; }
  } else if (mode === 'hard-reject') {
    // OPT-IN: nothing lands. Every row goes to the dead-letter path so the
    // batch is fully recoverable after the contract or producer is fixed.
    decision = 'rejected-batch';
    alert = true;
    alertSeverity = 'P1';
    note = `hard-reject: ${rejected.length} of ${rows.length} rows violate the contract, so the ENTIRE batch was blocked and written to the dead-letter path.`;
    accepted.length = 0;
    const already = new Set(rejected.map((r) => r.index));
    rows.forEach((row, index) => {
      if (!already.has(index)) rejected.push({ index, row, violations: [{ rule: 'batchRejected', severity: 'error', detail: 'This row conforms, but the batch was blocked because sibling rows violated the contract (hard-reject mode).' }] });
    });
    rejected.sort((a, b) => a.index - b.index);
  } else {
    decision = 'landed-with-quarantine';
    alert = true;
    alertSeverity = 'P2';
    note = `warn-quarantine (default): ${accepted.length} of ${rows.length} rows landed; ${rejected.length} were quarantined to the dead-letter path. The load was NOT dropped.`;
  }

  return {
    mode,
    evaluated: rows.length,
    accepted,
    rejected,
    warned,
    decision,
    alert,
    alertSeverity,
    topViolations,
    note,
  };
}

// ── Schema-level conformance (pipeline sinks) ──────────────────────────────

export interface SchemaConformance {
  ok: boolean;
  violations: RowViolation[];
  /** True when the caller must BLOCK the run (hard-reject + an error found). */
  blocked: boolean;
  alert: boolean;
  alertSeverity: 'P1' | 'P2' | 'P3';
  note: string;
}

/**
 * The pipeline-sink pre-flight: a pipeline's rows are moved by Azure Data
 * Factory server-side, so Loom never holds them in process. What Loom CAN
 * enforce — honestly, with a real backend read — is the SINK's SHAPE: it
 * introspects the sink table's live column list (real `sys.columns` /
 * `.show table schema` read) and checks it against the contract before the run
 * is dispatched.
 *
 *   • a declared column missing from the sink            → error
 *   • a declared type the sink cannot hold               → error (caller-supplied)
 *   • an undeclared extra column in the sink             → warning (drift)
 *
 * Default `warn-quarantine` mode NEVER blocks the run — it records the
 * violation and alerts, exactly like a quarantined row. `hard-reject` blocks
 * the dispatch so no non-conforming load starts at all.
 */
export function evaluateSchemaConformance(
  odcs: OdcsContract | null | undefined,
  sinkColumns: Array<{ name: string; type?: string }>,
  mode: EnforcementMode = DEFAULT_ENFORCEMENT_MODE,
): SchemaConformance {
  const object = contractObject(odcs);
  const violations: RowViolation[] = [];
  if (!object) {
    return { ok: true, violations, blocked: false, alert: false, alertSeverity: 'P3', note: 'The bound contract declares no schema object, so there is nothing to check against the sink.' };
  }
  const declared = object.properties || [];
  const present = new Map(sinkColumns.map((c) => [String(c.name).toLowerCase(), c]));
  for (const p of declared) {
    if (!present.has(p.name.toLowerCase())) {
      violations.push({ column: p.name, rule: 'missingColumn', severity: 'error', detail: `The contract declares '${p.name}' but the sink has no such column.` });
    }
  }
  const declaredNames = new Set(declared.map((p) => p.name.toLowerCase()));
  for (const c of sinkColumns) {
    if (!declaredNames.has(String(c.name).toLowerCase())) {
      violations.push({ column: c.name, rule: 'undeclaredColumn', severity: 'warning', detail: `The sink has '${c.name}', which the contract does not declare (schema drift).` });
    }
  }
  const errors = violations.filter((v) => v.severity === 'error');
  const blocked = mode === 'hard-reject' && errors.length > 0;
  const note = errors.length
    ? blocked
      ? `hard-reject: the sink is missing ${errors.length} contracted column(s), so the run was blocked before any data moved.`
      : `warn-quarantine (default): the sink is missing ${errors.length} contracted column(s). The run was allowed to proceed and an alert was raised — the load was NOT dropped.`
    : violations.length
      ? `The sink conforms to the contract; ${violations.length} drift warning(s) recorded.`
      : 'The sink conforms to the contract.';
  return {
    ok: errors.length === 0,
    violations,
    blocked,
    alert: violations.length > 0,
    alertSeverity: blocked ? 'P1' : errors.length ? 'P2' : 'P3',
    note,
  };
}

// ── Dead-letter path construction ──────────────────────────────────────────

/** Path-safe a dataset name (`dbo.Orders` → `dbo.Orders`, `../x` → `x`). */
export function safeDatasetSegment(dataset: string): string {
  const s = String(dataset || '').trim().replace(/[\\/]+/g, '_').replace(/\.\.+/g, '.');
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '');
  return cleaned || 'dataset';
}

/**
 * The Bronze dead-letter path for one quarantined batch:
 *
 *   `<basePath>/_rejected/<dataset>/rejected-<utc-compact>.jsonl`
 *
 * `_rejected` sits BESIDE the landed data under the same mirror/pipeline base
 * path, so a quarantined batch is discoverable from the exact place its clean
 * siblings landed, and Synapse Serverless' folder-scoped `OPENROWSET` over
 * `<basePath>/<dataset>/` never picks it up (different folder).
 */
export function deadLetterPath(basePath: string, dataset: string, at: Date | string = new Date()): string {
  const base = String(basePath || '').replace(/^\/+|\/+$/g, '');
  const ts = (at instanceof Date ? at : new Date(at)).toISOString().replace(/[:.]/g, '-');
  const prefix = base ? `${base}/` : '';
  return `${prefix}_rejected/${safeDatasetSegment(dataset)}/rejected-${ts}.jsonl`;
}

/**
 * The dead-letter record body — newline-delimited JSON, one object per
 * quarantined row, each carrying the original row PLUS why it was rejected.
 * JSONL (not CSV) so heterogeneous / drifted rows survive verbatim and are
 * replayable after the contract or the producer is fixed.
 */
export function deadLetterBody(
  rejected: RejectedRow[],
  meta: { contractId: string; contractVersion: string; dataset: string; source: string; mode: EnforcementMode; at?: string },
): string {
  const at = meta.at || new Date().toISOString();
  return rejected
    .map((r) => JSON.stringify({
      _rejectedAt: at,
      _contractId: meta.contractId,
      _contractVersion: meta.contractVersion,
      _dataset: meta.dataset,
      _source: meta.source,
      _mode: meta.mode,
      _rowIndex: r.index,
      _violations: r.violations,
      row: r.row,
    }))
    .join('\n');
}

/**
 * N7d — compile rule-builder data-quality checks into files the **N4 transform
 * runner** executes, and parse the runner's per-test results back out. PURE
 * (string-building + parsing only, no Azure) so the BFF, the store, and the
 * vitest suite share one source of truth.
 *
 * ## Why the transform runner (and not a second engine)
 *
 * N7d does NOT stand up a new checker. It reuses the on-main N4 runner: a DQ
 * check compiles to a **dbt data test** (a singular test whose SQL returns the
 * offending rows — dbt fails the test when any row comes back). We build a tiny
 * dbt project (an ephemeral pass-through model per table + one singular test per
 * check) and hand it to `runnerRun({ backend:'dbt', commands:['dbt test'] })`.
 * The runner already returns `results: [{ name, status, message }]` — exactly
 * dbt's test output — so parsing is a name→check join. This is the same engine,
 * the same auth, the same VNet trust as every other N4 call.
 *
 * The rule VOCABULARY is N6's contract vocabulary ({@link QualityExpectation} /
 * `QUALITY_RULES`) — we do not invent a second rule language.
 *
 * ## Dialect
 *
 * Tests are generated for the project's engine dialect (synapse → T-SQL,
 * databricks → Spark SQL, duckdb → ANSI/DuckDB). Identifiers are quoted per
 * dialect and every literal is escaped — a check body is server-built from a
 * vetted rule + a column/table name, never raw client SQL.
 *
 * Azure-native / no-Fabric: the runner targets Synapse / Databricks SQL / DuckDB
 * by default; Fabric is a selectable engine only. IL5: DuckDB-over-ADLS is the
 * disconnected path, so checks run fully in an air-gapped enclave.
 */

import { bracket } from '@/lib/sql/quoting';
import { escapeSqlLiteral } from '@/lib/sql/quoting';
import type { GeneratedFile } from '@/lib/transform/transform-codegen';
import { generateTransformProject } from '@/lib/transform/transform-codegen';
import {
  emptyTransformProject,
  type TransformEngine,
  type TransformModel,
  type TransformProject,
  type TransformSource,
} from '@/lib/transform/transform-project-model';
import { QUALITY_RULE_VALUES, type QualitySeverity } from '@/lib/dataproducts/contract';

/**
 * One rule-builder check. This IS N6's {@link QualityExpectation} plus the table
 * it targets — same rule vocabulary, no second language.
 */
export interface DqCheck {
  /** Stable check id (kebab/uuid) — the join key back to the runner result. */
  id: string;
  /** The logical table the check runs against. */
  table: string;
  /** Column-scoped rules need this; table-level rules (row_count) may omit it. */
  column?: string;
  /** One of QUALITY_RULE_VALUES (not_null / unique / accepted_values / …). */
  rule: string;
  /** Rule argument (accepted-values list, min/max, range "a..b", regex, freshness "24h", row_count). */
  value?: string;
  severity: QualitySeverity;
}

/** The engine coordinates the generated dbt project targets (a subset of TransformTarget). */
export interface DqCheckTarget {
  engine: TransformEngine;
  synapseServer?: string;
  databricksHost?: string;
  databricksHttpPath?: string;
  catalog?: string;
  database?: string;
  duckdbPath?: string;
  fabricEndpoint?: string;
  /** The schema the source tables live in. */
  schema?: string;
}

/** SQL dialect family per engine — drives the generated test SQL. */
export type CheckDialect = 'tsql' | 'spark' | 'duckdb';

export function dialectForEngine(engine: TransformEngine): CheckDialect {
  if (engine === 'databricks') return 'spark';
  if (engine === 'duckdb') return 'duckdb';
  return 'tsql'; // synapse + fabric are T-SQL family
}

/** Reject anything that isn't a plain identifier segment (defense in depth). */
function assertIdent(seg: string, what: string): string {
  const s = String(seg || '').trim();
  if (!/^[A-Za-z0-9_ $-]+$/.test(s)) {
    throw new Error(`Unsafe ${what} in DQ check: "${seg}"`);
  }
  return s;
}

function quoteIdentFor(dialect: CheckDialect, name: string): string {
  const s = assertIdent(name, 'identifier');
  if (dialect === 'spark') return '`' + s.replace(/`/g, '``') + '`';
  if (dialect === 'duckdb') return `"${s.replace(/"/g, '""')}"`;
  return bracket(s); // tsql — central `[...]` identifier quoting (sql-quoting guard RULE B)
}

/** dbt singular-test file basename → the check id (the parse join key). */
export function checkTestName(checkId: string): string {
  return `dqchk_${String(checkId || '').replace(/[^A-Za-z0-9_]+/g, '_')}`.slice(0, 120);
}

/** A valid freshness timespan → its unit/amount, else null. */
function parseTimespan(v: string): { amount: number; unit: 's' | 'm' | 'h' | 'd' } | null {
  const m = /^(\d+)\s*([smhd])$/.exec(String(v || '').trim().toLowerCase());
  if (!m) return null;
  return { amount: Number(m[1]), unit: m[2] as 's' | 'm' | 'h' | 'd' };
}

function timespanToDialect(dialect: CheckDialect, ts: { amount: number; unit: string }): string {
  // A "current - N units" boundary expression per dialect.
  const days = ts.unit === 'd' ? ts.amount : ts.unit === 'h' ? ts.amount / 24 : ts.unit === 'm' ? ts.amount / 1440 : ts.amount / 86400;
  if (dialect === 'spark') {
    const unitWord = ts.unit === 'd' ? 'DAYS' : ts.unit === 'h' ? 'HOURS' : ts.unit === 'm' ? 'MINUTES' : 'SECONDS';
    return `current_timestamp() - INTERVAL ${ts.amount} ${unitWord}`;
  }
  if (dialect === 'duckdb') {
    const unitWord = ts.unit === 'd' ? 'days' : ts.unit === 'h' ? 'hours' : ts.unit === 'm' ? 'minutes' : 'seconds';
    return `now() - INTERVAL ${ts.amount} ${unitWord}`;
  }
  // tsql — use DATEADD on days (fractional collapses to whole days minimally 1).
  const wholeDays = Math.max(1, Math.ceil(days));
  return `DATEADD(DAY, -${wholeDays}, SYSUTCDATETIME())`;
}

/**
 * Build the SELECT that returns the VIOLATING rows for one check (dbt singular
 * test: any returned row = failure). `ref` is the compiled reference to the
 * pass-through model (dbt substitutes `{{ ref('dq_<table>') }}`). Returns null
 * when the check is malformed for its rule (missing column / bad value) — the
 * caller records that as a skipped check rather than a fake pass.
 */
export function buildCheckSql(dialect: CheckDialect, check: DqCheck, ref: string): { sql: string } | { skip: string } {
  const rule = check.rule;
  const needsColumn = rule !== 'row_count';
  const col = (check.column || '').trim();
  if (needsColumn && !col) return { skip: `${rule} needs a column scope` };
  const C = col ? quoteIdentFor(dialect, col) : '';
  const val = (check.value || '').trim();

  switch (rule) {
    case 'not_null':
      return { sql: `SELECT * FROM ${ref} WHERE ${C} IS NULL` };
    case 'unique':
      return { sql: `SELECT ${C} FROM ${ref} GROUP BY ${C} HAVING COUNT(*) > 1` };
    case 'primary_key':
      // Violations = null keys OR duplicate keys (union of the two singular tests).
      return {
        sql:
          `SELECT ${C} AS k FROM ${ref} WHERE ${C} IS NULL\n`
          + `UNION ALL\n`
          + `SELECT ${C} AS k FROM ${ref} GROUP BY ${C} HAVING COUNT(*) > 1`,
      };
    case 'accepted_values': {
      const values = val.split(',').map((v) => v.trim()).filter(Boolean);
      if (!values.length) return { skip: 'accepted_values needs a comma-separated list' };
      const list = values.map((v) => `'${escapeSqlLiteral(v)}'`).join(', ');
      const cast = dialect === 'spark' ? `CAST(${C} AS STRING)` : dialect === 'duckdb' ? `CAST(${C} AS VARCHAR)` : `CAST(${C} AS NVARCHAR(4000))`;
      return { sql: `SELECT * FROM ${ref} WHERE ${C} IS NOT NULL AND ${cast} NOT IN (${list})` };
    }
    case 'min': {
      const n = Number(val);
      if (!Number.isFinite(n)) return { skip: 'min needs a numeric value' };
      return { sql: `SELECT * FROM ${ref} WHERE ${C} < ${n}` };
    }
    case 'max': {
      const n = Number(val);
      if (!Number.isFinite(n)) return { skip: 'max needs a numeric value' };
      return { sql: `SELECT * FROM ${ref} WHERE ${C} > ${n}` };
    }
    case 'range': {
      const parts = val.split('..').map((v) => v.trim());
      const lo = Number(parts[0]);
      const hi = Number(parts[1]);
      if (parts.length !== 2 || !Number.isFinite(lo) || !Number.isFinite(hi)) return { skip: 'range needs "min..max"' };
      return { sql: `SELECT * FROM ${ref} WHERE ${C} < ${lo} OR ${C} > ${hi}` };
    }
    case 'regex': {
      if (!val) return { skip: 'regex needs a pattern' };
      const pat = `'${escapeSqlLiteral(val)}'`;
      if (dialect === 'spark') return { sql: `SELECT * FROM ${ref} WHERE ${C} IS NOT NULL AND NOT (CAST(${C} AS STRING) RLIKE ${pat})` };
      if (dialect === 'duckdb') return { sql: `SELECT * FROM ${ref} WHERE ${C} IS NOT NULL AND NOT regexp_matches(CAST(${C} AS VARCHAR), ${pat})` };
      return { skip: 'regex is unsupported on the Synapse/T-SQL engine — run these checks on Databricks or DuckDB' };
    }
    case 'freshness': {
      const ts = parseTimespan(val);
      if (!ts) return { skip: 'freshness needs a max-age like 24h or 7d' };
      const boundary = timespanToDialect(dialect, ts);
      // Violates when the newest row is OLDER than the boundary → HAVING on max().
      return { sql: `SELECT MAX(${C}) AS latest FROM ${ref} HAVING MAX(${C}) < ${boundary}` };
    }
    case 'row_count': {
      const minRows = Number(val);
      if (!Number.isFinite(minRows)) return { skip: 'row_count needs a numeric minimum' };
      const floor = Math.floor(minRows);
      return { sql: `SELECT COUNT(*) AS n FROM ${ref} HAVING COUNT(*) < ${floor}` };
    }
    default:
      return { skip: `unknown rule "${rule}"` };
  }
}

/** A check that could not be compiled (recorded, never faked as a pass). */
export interface SkippedCheck {
  id: string;
  reason: string;
}

export interface CompiledChecks {
  files: GeneratedFile[];
  /** The dbt commands the runner should execute. */
  commands: string[];
  /** Checks that produced a test file (id → test name). */
  compiled: Array<{ id: string; testName: string; table: string }>;
  skipped: SkippedCheck[];
}

/**
 * Compile a set of checks against one engine target into a runnable dbt project.
 * Reuses {@link generateTransformProject} for the project scaffold (dbt_project /
 * profiles / the ephemeral pass-through models), then appends one singular test
 * per compilable check under `tests/`.
 */
export function compileChecks(checks: DqCheck[], target: DqCheckTarget): CompiledChecks {
  const schema = (target.schema || 'analytics').trim() || 'analytics';
  const rulesOk = (checks || []).filter((c) => QUALITY_RULE_VALUES.includes(c.rule));
  const tables = Array.from(new Set(rulesOk.map((c) => (c.table || '').trim()).filter(Boolean)));

  const sources: TransformSource[] = tables.map((t) => ({ name: 'loom_dq', schema, table: t }));
  const models: TransformModel[] = tables.map((t): TransformModel => ({
    name: modelNameForTable(t),
    layer: 'bronze',
    materialized: 'ephemeral',
    sql: `SELECT * FROM {{ source('loom_dq', '${escapeSqlLiteral(t)}') }}`,
    sources: [`loom_dq.${t}`],
  }));

  const base = emptyTransformProject('loom_dq_checks');
  const project: TransformProject = {
    ...base,
    backend: 'dbt',
    projectName: 'loom_dq_checks',
    profileName: 'loom_dq_checks',
    sources,
    models,
    target: {
      engine: target.engine,
      synapseServer: target.synapseServer,
      databricksHost: target.databricksHost,
      databricksHttpPath: target.databricksHttpPath,
      catalog: target.catalog,
      database: target.database,
      duckdbPath: target.duckdbPath,
      fabricEndpoint: target.fabricEndpoint,
      schema,
      threads: 4,
    },
  };

  // generateTransformProject requires ≥1 model — guaranteed above when tables>0.
  const files: GeneratedFile[] = tables.length ? generateTransformProject(project) : [];
  const dialect = dialectForEngine(target.engine);
  const compiled: CompiledChecks['compiled'] = [];
  const skipped: SkippedCheck[] = [];

  for (const check of rulesOk) {
    const table = (check.table || '').trim();
    if (!table) { skipped.push({ id: check.id, reason: 'no table' }); continue; }
    const ref = `{{ ref('${escapeSqlLiteral(modelNameForTable(table))}') }}`;
    let built: ReturnType<typeof buildCheckSql>;
    try {
      built = buildCheckSql(dialect, check, ref);
    } catch (e) {
      skipped.push({ id: check.id, reason: (e as Error)?.message || 'unsafe check' });
      continue;
    }
    if ('skip' in built) { skipped.push({ id: check.id, reason: built.skip }); continue; }
    const testName = checkTestName(check.id);
    files.push({
      path: `tests/${testName}.sql`,
      content: `-- N7d data-quality check ${check.id} (${check.rule} on ${table}${check.column ? `.${check.column}` : ''})\n${built.sql}\n`,
    });
    compiled.push({ id: check.id, testName, table });
  }

  return { files, commands: ['dbt deps', 'dbt test'], compiled, skipped };
}

function modelNameForTable(table: string): string {
  return `dq_${String(table).replace(/[^A-Za-z0-9_]+/g, '_')}`.slice(0, 120);
}

// ── result parsing ───────────────────────────────────────────────────────────

/** The runner's per-test result item (a subset of RunnerResponse.results[]). */
export interface RunnerTestResult {
  name: string;
  status: string;
  message?: string;
}

/** The parsed outcome of one check after a runner run. */
export interface CheckOutcome {
  checkId: string;
  table: string;
  /** pass = test succeeded; fail = violations found; error = runner/compile error; skipped = not compiled. */
  status: 'pass' | 'fail' | 'error' | 'skipped';
  /** Number of violating rows when the runner reported it, else null. */
  violations: number | null;
  message: string;
}

/**
 * Extract a violation-row count from a dbt test message. dbt prints e.g.
 * "Got 7 results, configured to fail if != 0" / "FAIL 7". We take the first
 * integer, which is the failing-row count. Returns null when none is present.
 */
export function parseViolationCount(message: string | undefined): number | null {
  if (!message) return null;
  const m = /(?:got\s+)?(\d+)\s*(?:results?|rows?|failures?)?/i.exec(message);
  if (!m) {
    const bare = /(\d+)/.exec(message);
    return bare ? Number(bare[1]) : null;
  }
  return Number(m[1]);
}

/** Normalize a dbt/runner status string to our four states. */
function normalizeStatus(raw: string): 'pass' | 'fail' | 'error' {
  const s = String(raw || '').toLowerCase();
  if (s === 'pass' || s === 'success' || s === 'ok') return 'pass';
  if (s === 'error' || s === 'runtime error' || s === 'skipped') return 'error';
  return 'fail'; // fail / warn / anything else that isn't a clean pass
}

/**
 * Join runner test results back to the compiled checks. A compiled check with a
 * matching result gets that result's status/violations; one WITHOUT a matching
 * result (the runner never ran it) is an honest 'error' (not a silent pass).
 * Skipped-at-compile checks stay 'skipped'.
 */
export function parseCheckOutcomes(
  compiled: CompiledChecks,
  results: RunnerTestResult[] | undefined,
): CheckOutcome[] {
  const byName = new Map<string, RunnerTestResult>();
  for (const r of results || []) {
    // dbt names singular tests by file basename; match on the testName substring.
    const name = String(r.name || '').toLowerCase();
    for (const c of compiled.compiled) {
      if (name === c.testName.toLowerCase() || name.includes(c.testName.toLowerCase())) {
        if (!byName.has(c.testName)) byName.set(c.testName, r);
      }
    }
  }

  const outcomes: CheckOutcome[] = [];
  for (const c of compiled.compiled) {
    const r = byName.get(c.testName);
    if (!r) {
      outcomes.push({ checkId: c.id, table: c.table, status: 'error', violations: null, message: 'no result returned by the transform runner for this check' });
      continue;
    }
    const status = normalizeStatus(r.status);
    const violations = status === 'pass' ? 0 : parseViolationCount(r.message);
    outcomes.push({
      checkId: c.id,
      table: c.table,
      status,
      violations,
      message: r.message || status,
    });
  }
  for (const s of compiled.skipped) {
    outcomes.push({ checkId: s.id, table: '', status: 'skipped', violations: null, message: s.reason });
  }
  return outcomes;
}

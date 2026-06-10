/**
 * Materialized Lake View (MLV) — shared model, codegen, and lineage helpers.
 *
 * A materialized lake view is a persisted, auto-refreshed Delta table whose
 * contents are defined by a Spark SQL `SELECT` (or a PySpark DataFrame
 * function) over one or more source tables. In CSA Loom the MLV is 100%
 * Azure-native (no Microsoft Fabric required, per
 * .claude/rules/no-fabric-dependency.md):
 *
 *   - Storage   → ADLS Gen2 Delta table under a medallion container
 *                 (Tables/<schema>/<view>/ in the lake), the same lake every
 *                 lakehouse / serverless-SQL editor reads.
 *   - Compute   → a Synapse Spark batch (Livy) runs a generated PySpark driver
 *                 that executes the definition, enforces the data-quality
 *                 constraints, and writes the result as a managed Delta table.
 *   - Refresh   → an Azure Data Factory "Refresh materialized lake view"
 *                 pipeline orchestrates scheduled / on-demand refreshes by
 *                 invoking the same Spark batch.
 *   - Lineage   → source-table → MLV and MLV → MLV dependency edges are derived
 *                 from the definition and persisted as cross-workspace lineage
 *                 in Loom's own Cosmos `thread-edges` store.
 *
 * This module has NO Azure SDK imports so it is safe to use from both the BFF
 * routes (node runtime) and the client editor (for the live PySpark preview).
 *
 * Grounded in Microsoft Learn:
 *   - Overview / lifecycle (create → refresh → query → monitor):
 *     https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/overview-materialized-lake-view
 *   - Spark SQL reference (CREATE MATERIALIZED LAKE VIEW, constraints):
 *     https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/create-materialized-lake-view
 *   - PySpark reference (@fmlv decorator, full refresh):
 *     https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/create-materialized-lake-view-pyspark
 *   - Data quality constraints (CHECK … ON MISMATCH FAIL|DROP):
 *     https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/data-quality
 */

/** Authoring language for the MLV definition. */
export type MlvLanguage = 'sql' | 'pyspark';

/** Refresh strategy. PySpark MLVs only support full refresh (Learn). */
export type MlvRefreshMode = 'full' | 'incremental';

/** A medallion container the materialized Delta table is written to. */
export const MLV_CONTAINERS = ['bronze', 'silver', 'gold', 'landing'] as const;
export type MlvContainer = (typeof MLV_CONTAINERS)[number];

/** A data-quality constraint enforced on every refresh. */
export interface MlvConstraint {
  /** Constraint name (identifier). */
  name: string;
  /** Boolean Spark SQL expression every row must satisfy. */
  expression: string;
  /** FAIL stops the refresh at first violation; DROP removes violating rows. */
  onViolation: 'FAIL' | 'DROP';
}

/** The persisted MLV spec (stored on the Cosmos item's `state.spec`). */
export interface MlvSpec {
  language: MlvLanguage;
  /** Target medallion container for the materialized Delta table. */
  container: MlvContainer;
  /** Schema namespace (e.g. silver / gold). */
  schema: string;
  /** Materialized view (table) name. */
  viewName: string;
  /** Spark SQL SELECT body (when language === 'sql'). */
  sql?: string;
  /** PySpark function body returning a DataFrame (when language === 'pyspark'). */
  pyspark?: string;
  /** Partition columns for the output Delta table. */
  partitionCols?: string[];
  /** Delta table properties (key → value). */
  tableProperties?: Record<string, string>;
  /** Data-quality constraints. */
  constraints?: MlvConstraint[];
  refreshMode?: MlvRefreshMode;
  /** Optional comment / description. */
  comment?: string;
}

/** Validate an identifier (schema / view / partition / constraint name). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidIdentifier(s: string): boolean {
  return IDENT_RE.test(s.trim());
}

/** Sanitize a fragment for use as an ADLS path segment. */
export function safeSegment(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'mlv';
}

/** The fully-qualified view name `schema.view` used in lineage + SQL. */
export function mlvFqn(spec: Pick<MlvSpec, 'schema' | 'viewName'>): string {
  return `${spec.schema}.${spec.viewName}`;
}

/** The relative ADLS Delta path the MLV materializes to (under its container). */
export function mlvDeltaPath(spec: Pick<MlvSpec, 'schema' | 'viewName'>): string {
  return `Tables/${safeSegment(spec.schema)}/${safeSegment(spec.viewName)}`;
}

/**
 * Build a `CREATE MATERIALIZED LAKE VIEW` statement from the spec — the same
 * syntax the Fabric lakehouse SQL editor accepts. Used for the SQL preview pane
 * and stored as the canonical DDL. Constraints are emitted in the column-list
 * position (CONSTRAINT <name> CHECK (<expr>) ON MISMATCH <action>).
 */
export function buildCreateMlvSql(spec: MlvSpec): string {
  const fqn = mlvFqn(spec);
  const lines: string[] = [];
  const constraintClause = (spec.constraints || [])
    .filter((c) => c.name.trim() && c.expression.trim())
    .map(
      (c) =>
        `  CONSTRAINT ${c.name.trim()} CHECK (${c.expression.trim()}) ON MISMATCH ${c.onViolation}`,
    );
  const head =
    constraintClause.length > 0
      ? `CREATE MATERIALIZED LAKE VIEW IF NOT EXISTS ${fqn} (\n${constraintClause.join(',\n')}\n)`
      : `CREATE MATERIALIZED LAKE VIEW IF NOT EXISTS ${fqn}`;
  lines.push(head);

  const opts: string[] = [];
  if (spec.comment?.trim()) opts.push(`COMMENT '${spec.comment.trim().replace(/'/g, "''")}'`);
  if (spec.partitionCols?.length) opts.push(`PARTITIONED BY (${spec.partitionCols.join(', ')})`);
  if (spec.tableProperties && Object.keys(spec.tableProperties).length) {
    const tp = Object.entries(spec.tableProperties)
      .map(([k, v]) => `'${k}' = '${String(v).replace(/'/g, "''")}'`)
      .join(', ');
    opts.push(`TBLPROPERTIES (${tp})`);
  }
  lines.push(...opts);
  lines.push(`AS\n${(spec.sql || '').trim()}`);
  return lines.join('\n');
}

/**
 * Heuristic source-table extraction from a Spark SQL SELECT. Picks the
 * identifiers following FROM / JOIN that look like `[schema.]table` references
 * (skips subqueries, CTE aliases, and table-valued functions). Used to derive
 * lineage edges — best-effort, never throws.
 */
export function extractSqlSources(sql: string): string[] {
  if (!sql) return [];
  // Strip block + line comments and string literals so keywords inside them
  // don't produce phantom sources.
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ");

  // Collect CTE names (WITH <name> AS ( … )) so we exclude self-references.
  const cteNames = new Set<string>();
  const cteRe = /\bwith\b([\s\S]*?)\bselect\b/i;
  const cteMatch = cteRe.exec(cleaned);
  if (cteMatch) {
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cteMatch[1])) !== null) cteNames.add(m[1].toLowerCase());
  }

  const sources = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const ref = m[1].replace(/[`"\[\]]/g, '');
    // Skip table-valued functions (followed by `(`) and CTE references.
    const after = cleaned.slice(re.lastIndex).trimStart();
    if (after.startsWith('(')) continue;
    if (cteNames.has(ref.toLowerCase())) continue;
    sources.add(ref);
  }
  return [...sources];
}

/**
 * Heuristic source extraction from PySpark — picks `spark.read.table("…")`,
 * `spark.table("…")`, and `spark.read.format("delta").load("…")` references.
 */
export function extractPySparkSources(py: string): string[] {
  if (!py) return [];
  const sources = new Set<string>();
  const tableRe = /spark\.(?:read\.)?table\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(py)) !== null) sources.add(m[1]);
  const loadRe = /\.load\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = loadRe.exec(py)) !== null) sources.add(m[1]);
  return [...sources];
}

/** Derive the source dependencies for an MLV from whichever language it uses. */
export function deriveSources(spec: MlvSpec): string[] {
  return spec.language === 'sql'
    ? extractSqlSources(spec.sql || '')
    : extractPySparkSources(spec.pyspark || '');
}

/**
 * Generate the PySpark driver script that materializes the MLV as a Delta
 * table. This is what the Synapse Spark batch executes on refresh:
 *
 *   - SQL MLVs: run `spark.sql(<SELECT>)` to get the DataFrame.
 *   - PySpark MLVs: exec the user function body (must return `df`).
 *   - Apply each DROP constraint as a `.filter()`; FAIL constraints raise if
 *     any row violates (mirrors Fabric MLV ON MISMATCH FAIL|DROP semantics).
 *   - Write the result to the MLV's abfss Delta path (mode=overwrite),
 *     partitioned + with table properties when configured.
 *
 * The driver is fully self-contained and parameter-free (Livy batch args are
 * not needed) so it can be uploaded once and re-run by both the Spark batch and
 * the ADF refresh pipeline.
 */
export function buildRefreshPySpark(spec: MlvSpec, deltaAbfssUrl: string): string {
  const pyStr = (s: string) => JSON.stringify(s);
  const constraints = spec.constraints || [];
  const dropChecks = constraints.filter((c) => c.onViolation === 'DROP');
  const failChecks = constraints.filter((c) => c.onViolation === 'FAIL');
  const partition = spec.partitionCols?.length
    ? `.partitionBy(${spec.partitionCols.map((c) => pyStr(c)).join(', ')})`
    : '';
  const props = spec.tableProperties || {};

  const lines: string[] = [];
  lines.push('# Auto-generated by CSA Loom — Refresh Materialized Lake View driver');
  lines.push(`# View: ${mlvFqn(spec)}  →  ${deltaAbfssUrl}`);
  lines.push('from pyspark.sql import SparkSession, functions as F');
  lines.push('spark = SparkSession.builder.getOrCreate()');
  lines.push('');

  if (spec.language === 'sql') {
    lines.push('# --- definition (Spark SQL) ---');
    lines.push(`__mlv_sql = ${pyStr((spec.sql || '').trim())}`);
    lines.push('df = spark.sql(__mlv_sql)');
  } else {
    lines.push('# --- definition (PySpark) ---');
    lines.push('def __mlv_define():');
    const body = (spec.pyspark || 'return spark.createDataFrame([], "id int")').trim();
    for (const ln of body.split('\n')) lines.push(`    ${ln}`);
    lines.push('df = __mlv_define()');
  }
  lines.push('');

  if (failChecks.length) {
    lines.push('# --- data-quality constraints: FAIL on violation ---');
    for (const c of failChecks) {
      lines.push(`__bad = df.filter(~(${c.expression})).limit(1).count()`);
      lines.push('if __bad > 0:');
      lines.push(
        `    raise Exception(${pyStr(`MLV constraint '${c.name}' (FAIL) violated by at least one row.`)})`,
      );
    }
    lines.push('');
  }
  if (dropChecks.length) {
    lines.push('# --- data-quality constraints: DROP violating rows ---');
    for (const c of dropChecks) {
      lines.push(`df = df.filter(${c.expression})`);
    }
    lines.push('');
  }

  lines.push('# --- materialize as managed Delta table ---');
  lines.push('(');
  lines.push('    df.write.format("delta").mode("overwrite")');
  lines.push('      .option("overwriteSchema", "true")');
  for (const [k, v] of Object.entries(props)) {
    lines.push(`      .option(${pyStr(`delta.${k}`.replace(/^delta\.delta\./, 'delta.'))}, ${pyStr(String(v))})`);
  }
  lines.push(`${partition ? `      ${partition}` : ''}`.trimEnd() || '');
  lines.push(`      .save(${pyStr(deltaAbfssUrl)})`);
  lines.push(')');
  lines.push('print("Materialized lake view refresh complete: " + ' + pyStr(mlvFqn(spec)) + ')');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/**
 * Build the ADF pipeline `properties` for a "Refresh materialized lake view"
 * pipeline. The single activity is a Spark-on-Synapse refresh expressed as a
 * Web activity that triggers the same Livy batch the Loom BFF submits, with the
 * MLV identity carried as activity userProperties so it is visible in the ADF
 * monitoring + lineage. We keep the activity declarative (no inline secrets):
 * the actual Spark submit is performed by Loom's refresh route, and this
 * pipeline shape is what an operator schedules in ADF for recurring refresh.
 */
export function buildRefreshAdfPipeline(params: {
  refreshUrl: string;
  fqn: string;
  deltaUrl: string;
}): { name: string; properties: Record<string, unknown> } {
  return {
    name: '',
    properties: {
      description: `Refresh the '${params.fqn}' materialized lake view (Delta → ${params.deltaUrl}).`,
      activities: [
        {
          name: 'RefreshMaterializedLakeView',
          type: 'WebActivity',
          dependsOn: [],
          policy: { timeout: '0.02:00:00', retry: 1, retryIntervalInSeconds: 60, secureOutput: false },
          userProperties: [
            { name: 'mlv', value: params.fqn },
            { name: 'deltaPath', value: params.deltaUrl },
          ],
          typeProperties: {
            url: params.refreshUrl,
            method: 'POST',
            body: { trigger: 'adf-pipeline', fqn: params.fqn },
            // The Console authenticates the callback via its managed identity.
            authentication: { type: 'MSI', resource: params.refreshUrl },
          },
        },
      ],
      annotations: ['loom:materialized-lake-view'],
    },
  };
}

/** Validate a spec; returns an array of human-readable problems (empty = ok). */
export function validateMlvSpec(spec: Partial<MlvSpec>): string[] {
  const errs: string[] = [];
  if (!spec.schema || !isValidIdentifier(spec.schema)) errs.push('Schema must be a valid identifier (letters, digits, underscore).');
  if (!spec.viewName || !isValidIdentifier(spec.viewName)) errs.push('View name must be a valid identifier.');
  if (!spec.container || !(MLV_CONTAINERS as readonly string[]).includes(spec.container)) {
    errs.push(`Container must be one of: ${MLV_CONTAINERS.join(', ')}.`);
  }
  if (spec.language === 'sql') {
    if (!spec.sql || !spec.sql.trim()) errs.push('SQL definition (the SELECT body) is required.');
  } else if (spec.language === 'pyspark') {
    if (!spec.pyspark || !spec.pyspark.trim()) errs.push('PySpark definition is required.');
    else if (!/return\b/.test(spec.pyspark)) errs.push('PySpark definition must `return` a DataFrame.');
  } else {
    errs.push('Language must be "sql" or "pyspark".');
  }
  for (const c of spec.constraints || []) {
    if (c.name && !isValidIdentifier(c.name)) errs.push(`Constraint name "${c.name}" is not a valid identifier.`);
    if (c.name && !c.expression?.trim()) errs.push(`Constraint "${c.name}" needs a CHECK expression.`);
  }
  for (const p of spec.partitionCols || []) {
    if (p && !isValidIdentifier(p)) errs.push(`Partition column "${p}" is not a valid identifier.`);
  }
  return errs;
}

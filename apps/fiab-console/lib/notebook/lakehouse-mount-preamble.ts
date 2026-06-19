/**
 * Build the one-time auto-mount preamble injected into a NEW notebook Spark
 * session so each attached lakehouse is a ready-to-use abfss path — the user can
 *
 *   spark.read.format('delta').load(loom_lakehouses['sales'] + '/Tables/orders')
 *
 * immediately, without typing storage paths (issue #655). The preamble defines a
 * `loom_lakehouses` dict keyed by the lakehouse display name. Paths are REAL,
 * resolved abfss roots from resolveLakehouseAbfss() — unresolvable sources are
 * skipped upstream (no guessed paths, no-vaporware.md).
 *
 * For a SQL/Spark-SQL session a Python dict can't be referenced, so the SQL
 * variant emits comment-only guidance (the path is still surfaced in the editor
 * chip). PySpark sessions host python + spark + sql statements, so the python
 * dict is the default and serves Spark SQL cells via the editor's copy path.
 */

export interface ResolvedAttachedLakehouse {
  /** Lakehouse display name — becomes the dict key the user references. */
  displayName: string;
  /** Canonical abfss://<container>@<account>.dfs.<suffix>/<root> URI. */
  abfss: string;
}

/** Escape a string for safe embedding inside a Python single-quoted literal. */
function pyStr(s: string): string {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Generate the pyspark preamble source. Returns '' when there are no resolvable
 * lakehouses (caller then injects nothing — no empty cell).
 *
 * The preamble is idempotent and side-effect-free beyond defining the dict +
 * a Spark conf marker, so prepending it to a cell's source (or running it as a
 * session statement) is safe.
 */
export function buildLakehouseMountPreamble(sources: ResolvedAttachedLakehouse[]): string {
  const entries = (sources || []).filter((s) => s && s.abfss && s.displayName);
  if (entries.length === 0) return '';
  const lines = entries.map((s) => `    ${pyStr(s.displayName)}: ${pyStr(s.abfss)},`);
  return [
    '# --- CSA Loom: attached lakehouses auto-mounted (issue #655) ---',
    '# Each entry maps an attached lakehouse name to its ADLS Gen2 root (abfss).',
    "# Example: spark.read.format('delta').load(loom_lakehouses['<name>'] + '/Tables/<table>')",
    'loom_lakehouses = {',
    ...lines,
    '}',
    'try:',
    "    spark.conf.set('loom.lakehouses.mounted', ','.join(loom_lakehouses.keys()))",
    'except Exception:',
    '    pass',
    '# --- end CSA Loom auto-mount ---',
  ].join('\n');
}

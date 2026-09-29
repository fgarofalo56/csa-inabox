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

/** One entry of a notebook's `state.attachedSources`. */
export interface AttachedSourceRef {
  kind?: string;
  id?: string;
  displayName?: string;
}

/**
 * Resolve every attached lakehouse to its abfss root, CONCURRENTLY, and return
 * them in ATTACHMENT order.
 *
 * Concurrent because a resolve can reach storage (#4759: the resolver's step 3
 * probes each configured container, each probe bounded at 6 s), so resolving N
 * lakehouses one after another would add up to N × that before the Spark
 * statement is submitted. Resolved in parallel the added latency is that of the
 * slowest single resolve.
 *
 * Attachment order, not completion order, so the emitted dict is the same on
 * every run whichever resolve answers first.
 *
 * A source that resolves to null or throws is skipped (no guessed path,
 * no-vaporware.md), and never takes its siblings down with it.
 *
 * `resolve` is injected so this module stays dependency-free and testable; the
 * run route passes `resolveLakehouseAbfss`.
 */
export async function resolveAttachedLakehouses(
  attached: readonly AttachedSourceRef[] | null | undefined,
  resolve: (lakehouseId: string) => Promise<{ abfss: string } | null>,
): Promise<ResolvedAttachedLakehouse[]> {
  const lakehouses = (attached || []).filter((a) => a && a.kind === 'lakehouse' && a.id);
  const settled = await Promise.all(
    lakehouses.map(async (lh): Promise<ResolvedAttachedLakehouse | null> => {
      try {
        const r = await resolve(lh.id as string);
        return r ? { displayName: lh.displayName || lh.id || 'lakehouse', abfss: r.abfss } : null;
      } catch {
        return null; // skip this source — honest, don't break the session
      }
    }),
  );
  return settled.filter((x): x is ResolvedAttachedLakehouse => x !== null);
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

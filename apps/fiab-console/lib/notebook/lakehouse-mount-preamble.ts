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
  /**
   * Canonical abfss://<container>@<account>.dfs.<suffix>/<root> URI. Empty when
   * the lakehouse was not opened ({@link withheld} says why).
   */
  abfss: string;
  /**
   * Why Loom did not open this lakehouse, in the user-facing wording the
   * resolver gives. The preamble makes `loom_lakehouses['<name>']` raise with
   * this text, so the reason reaches the notebook instead of the name simply
   * being absent.
   */
  withheld?: string;
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
 * no-vaporware.md), and never takes its siblings down with it. A source the
 * resolver declined to open, with a reason (`{ withheld }`), is returned with
 * that reason and no path, so the preamble can say why.
 *
 * `resolve` is injected so this module stays dependency-free and testable; the
 * run route passes a wrapper over `resolveLakehouseStorage`.
 */
export async function resolveAttachedLakehouses(
  attached: readonly AttachedSourceRef[] | null | undefined,
  resolve: (lakehouseId: string) => Promise<{ abfss: string } | { withheld: string } | null>,
): Promise<ResolvedAttachedLakehouse[]> {
  const lakehouses = (attached || []).filter((a) => a && a.kind === 'lakehouse' && a.id);
  const settled = await Promise.all(
    lakehouses.map(async (lh): Promise<ResolvedAttachedLakehouse | null> => {
      try {
        const r = await resolve(lh.id as string);
        const displayName = lh.displayName || lh.id || 'lakehouse';
        if (r && 'withheld' in r) return { displayName, abfss: '', withheld: r.withheld };
        return r ? { displayName, abfss: r.abfss } : null;
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
  const entries = (sources || []).filter((s) => s && s.abfss && s.displayName && !s.withheld);
  const withheld = (sources || []).filter((s) => s && s.withheld && s.displayName);
  if (entries.length === 0 && withheld.length === 0) return '';
  const lines = entries.map((s) => `    ${pyStr(s.displayName)}: ${pyStr(s.abfss)},`);
  // With nothing withheld the dict is a plain dict, exactly as before. With a
  // withheld lakehouse, looking its name up raises with the reason, and the
  // reason is also printed once where the run shows output.
  const open = withheld.length === 0
    ? ['loom_lakehouses = {', ...lines, '}']
    : [
      'class _LoomLakehouses(dict):',
      '    _withheld = {',
      ...withheld.map((s) => `        ${pyStr(s.displayName)}: ${pyStr(s.withheld as string)},`),
      '    }',
      '    def __missing__(self, key):',
      '        if key in self._withheld:',
      "            raise KeyError(str(key) + ': ' + self._withheld[key])",
      '        raise KeyError(key)',
      'loom_lakehouses = _LoomLakehouses({',
      ...lines,
      '})',
      ...withheld.map((s) => `print(${pyStr(`Lakehouse ${s.displayName} was not mounted: ${s.withheld}`)})`),
    ];
  return [
    '# --- CSA Loom: attached lakehouses auto-mounted (issue #655) ---',
    '# Each entry maps an attached lakehouse name to its ADLS Gen2 root (abfss).',
    "# Example: spark.read.format('delta').load(loom_lakehouses['<name>'] + '/Tables/<table>')",
    ...open,
    'try:',
    "    spark.conf.set('loom.lakehouses.mounted', ','.join(loom_lakehouses.keys()))",
    'except Exception:',
    '    pass',
    '# --- end CSA Loom auto-mount ---',
  ].join('\n');
}

/**
 * Split a Spark-SQL cell into individual statements.
 *
 * Livy's statement API (kind:'sql') executes exactly ONE statement per submit —
 * a cell containing multiple `;`-separated statements (e.g. three
 * `CREATE DATABASE …;`) fails with `[PARSE_SYNTAX_ERROR] extra input 'CREATE'`.
 * Notebook kernels split such cells on statement boundaries before running each
 * one; this helper reproduces that so a whole-notebook "Run all" (and a per-cell
 * SQL run) executes every statement instead of erroring on the second.
 *
 * The split is delimiter-aware, NOT a naive `.split(';')`:
 *  - `;` inside single/double-quoted string literals is not a boundary
 *    (quotes escaped by doubling — `''` / `""` — stay inside the literal).
 *  - `--` line comments and `/* … *\/` block comments are ignored for boundary
 *    detection and stripped from each emitted statement (a trailing
 *    comment-only fragment would otherwise be submitted as an empty statement).
 *  - Backtick-quoted identifiers are respected (a `;` inside is not a boundary).
 *
 * Returns the list of non-empty statements (comments/whitespace removed). A
 * single-statement cell returns one entry; a cell that is only comments returns
 * [].
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  // quote state: '\'' | '"' | '`' | null
  let quote: string | null = null;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (quote) {
      buf += ch;
      if (ch === quote) {
        // doubled quote = escaped literal quote, stays inside
        if (next === quote) { buf += next; i += 2; continue; }
        quote = null;
      }
      i += 1;
      continue;
    }

    // line comment — drop to end of line (keep the newline for readability)
    if (ch === '-' && next === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n') j += 1;
      buf += '\n';
      i = j;
      continue;
    }
    // block comment — drop through the closing */
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j += 1;
      i = j + 2;
      continue;
    }
    // enter a quoted region
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    // statement boundary
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Expand one notebook code cell into the list of Livy statements to submit for
 * it. Non-SQL cells (pyspark/spark/sparkr) run as a single statement — the
 * language runtime handles its own multi-line/multi-statement source. Only
 * `sql`-kind cells are split, because Livy's `sql` statement kind is
 * single-statement. A SQL cell that splits to zero (comments only) yields no
 * statements (nothing to run).
 */
export function cellToStatements(
  source: string,
  lang: 'pyspark' | 'spark' | 'sql' | 'sparkr',
): Array<{ source: string; lang: 'pyspark' | 'spark' | 'sql' | 'sparkr' }> {
  if (lang !== 'sql') return source.trim() ? [{ source, lang }] : [];
  return splitSqlStatements(source).map((s) => ({ source: s, lang: 'sql' as const }));
}

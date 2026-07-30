/**
 * sql-strip — single-pass removal of comments and string literals from a
 * SQL/KQL statement.
 *
 * WHY A SCANNER AND NOT A REGEX (CodeQL js/polynomial-redos): every regex
 * spelling of "a block comment" backtracks on an UNTERMINATED comment. The
 * lazy form `/\/\*[\s\S]*?\*\//` re-expands from every `/*`; even the classic
 * "linear" form `/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//` backtracks out of its
 * nested group on the pump `'/*' + 'a/*'.repeat(n)` — measured 14.7s at
 * n=60_000. A hand-written index scan is O(n) with no backtracking at all, and
 * it is the same class of fix as the FOCUS fingerprinter's negated-class
 * rewrite: make the ambiguity impossible to express rather than bounding the
 * input.
 *
 * Used by any code that must reason about the SHAPE of a user-supplied
 * statement (fingerprinting, source extraction) — never for producing SQL.
 */

export interface StripSqlOptions {
  /** Treat `//` as a line comment too (KQL/Trino). Default false. */
  doubleSlashLineComments?: boolean;
  /** Replacement for a stripped single-quoted literal. Default `" '' "`. */
  stringPlaceholder?: string;
  /** Replacement for a stripped double-quoted literal; omit to leave them. */
  doubleQuotePlaceholder?: string;
}

/**
 * Replace `/* … *​/` block comments, `-- …` (and optionally `// …`) line
 * comments, and single-quoted literals with spaces / placeholders.
 * Unterminated constructs consume to end-of-input (fail-closed: the tail can
 * never leak back into the analysed text).
 */
export function stripSqlCommentsAndLiterals(sql: string, opts: StripSqlOptions = {}): string {
  const strPlaceholder = opts.stringPlaceholder ?? " '' ";
  const dqPlaceholder = opts.doubleQuotePlaceholder;
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    // /* block comment */ — scan forward to the first '*/' (or EOF).
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out.push(' ');
      continue;
    }
    // -- line comment  (and // when enabled)
    if ((c === '-' && next === '-') || (opts.doubleSlashLineComments && c === '/' && next === '/')) {
      let end = i + 2;
      while (end < n && sql[end] !== '\n' && sql[end] !== '\r') end++;
      i = end;
      out.push(' ');
      continue;
    }
    // 'single-quoted literal' — '' is an embedded quote; \' an escape.
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      i = j;
      out.push(strPlaceholder);
      continue;
    }
    // "double-quoted literal" — only when the caller asked for it.
    if (c === '"' && dqPlaceholder !== undefined) {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      i = j;
      out.push(dqPlaceholder);
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

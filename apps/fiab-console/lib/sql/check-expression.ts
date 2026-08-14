/**
 * lib/sql/check-expression.ts — containment scan for a T-SQL CHECK-constraint
 * expression, the one SQL fragment Loom accepts as free text.
 *
 * WHY THIS FILE EXISTS (security — CodeQL js/sql-injection #789):
 *   `sql-objects-client.addConstraint` builds
 *     ALTER TABLE [s].[t] WITH CHECK ADD CONSTRAINT [c] CHECK (<expr>);
 *   and `<expr>` comes from `POST /api/sqldb/constraints`. Every other fragment
 *   of that statement is defended: table/column names are resolved from the
 *   catalog by integer object_id/column_id and bracket-quoted through
 *   `./quoting`, and the constraint name is validated. The CHECK expression
 *   cannot use either defence — it can be neither bound as a parameter nor
 *   quoted, because it IS SQL by definition (`[Total] > 0`). So containment is
 *   STRUCTURAL, the closed-grammar-or-refuse shape `lib/azure/copy-job-sql.ts`
 *   uses. Before this existed the expression reached `request.query()` verbatim
 *   and "it is placed only inside CHECK(…)" was treated as the defence.
 *   Placement is not a defence; the operand can leave the clause on its own.
 *
 *   This lives in `lib/sql/` beside `quoting.ts` because it is a SQL-GRAMMAR
 *   concern, not an Azure-client one — the same place the escaping primitives
 *   and their adversarial tests already live.
 *
 * Grounded in the source grammar:
 *   T-SQL delimited identifiers — https://learn.microsoft.com/sql/relational-databases/databases/database-identifiers
 *   T-SQL string literals       — https://learn.microsoft.com/sql/t-sql/data-types/constants-transact-sql
 *   CHECK constraints           — https://learn.microsoft.com/sql/t-sql/statements/alter-table-transact-sql
 */

/**
 * Consume a quoted region of `expr` opening at `start`, honouring the
 * doubled-delimiter escape (`''` / `]]` / `""`). Returns the index of the
 * closing delimiter, or -1 when the region is never closed.
 *
 * Jumping the caller's cursor straight to the close keeps the whole scan O(n):
 * each character is visited once, either by the outer loop or by exactly one
 * region consumption.
 *
 * @internal Exported only so the adversarial tests can exercise it directly;
 * {@link validCheckExpression} is the supported entry point. No other module
 * imports it, and none should — the preconditions below are unchecked.
 *
 * @param expr  The full expression being scanned.
 * @param start Index of the OPENING delimiter — not the first character inside
 *              the region. Scanning begins at `start + 1`, so passing the inner
 *              index would miss a region whose first character is the close
 *              (`''`, the empty literal) and mis-report it as unterminated.
 * @param close The closing delimiter as a SINGLE character (`'`, `]`, or `"`).
 *              The scan compares one character at a time, so a multi-character
 *              `close` can never match: the function would silently return -1
 *              for every input. A caller that read that as "no region here"
 *              rather than "unterminated" would scan on through text the engine
 *              treats as opaque — which is exactly the desync this module
 *              exists to prevent.
 * @returns Index of the closing delimiter, or -1 if the region is unterminated.
 */
export function consumeQuoted(expr: string, start: number, close: string): number {
  for (let j = start + 1; j < expr.length; j++) {
    if (expr[j] !== close) continue;
    if (expr[j + 1] === close) { j++; continue; } // '' / ]] / "" escape
    return j;
  }
  return -1;
}

/**
 * Validate that a CHECK expression can only ever be the OPERAND of the
 * `CHECK (…)` clause it is spliced into. Returns an error string, or null when
 * the expression is proven contained.
 *
 * The emitted statement is
 *   ALTER TABLE [s].[t] WITH CHECK ADD CONSTRAINT [c] CHECK (<expr>);
 * so `<expr>` escapes its clause in exactly four ways, all refused here:
 *   1. a `)` that closes CHECK(…) early — i.e. one that drives paren depth
 *      negative — after which the rest of the input is STATEMENT position
 *      (`1=1); DROP TABLE Orders; --`);
 *   2. a `;` outside a quoted region, chaining a second statement;
 *   3. a line (`--`) or block comment introducer outside a quoted region, which
 *      comments out the trailing `);` so an unbalanced payload still parses;
 *   4. an unterminated quoted region (or unbalanced `(`), which swallows the
 *      trailing `);` and leaves the tail as code.
 *
 * THREE QUOTED REGIONS, NOT ONE — this is where the first version was wrong.
 *   The scan must model every region T-SQL reads as opaque text, or an attacker
 *   can desynchronise it from the parser. An earlier revision tracked ONLY `'…'`
 *   string literals, so an apostrophe inside a DELIMITED IDENTIFIER toggled its
 *   literal state across a span the engine executes as code, and a real
 *   clause-closing `)` sailed past the depth check:
 *
 *     [c'] OR 1=1) DROP TABLE Orders --'      <- was ACCEPTED
 *     [a'] ) DROP TABLE Orders [b']           <- was ACCEPTED
 *
 *   The same bug rejected ordinary names, blaming a string the user never wrote
 *   (`[Owner's Name] <> ''` → "unterminated string literal"). One cause, both
 *   symptoms. So all three regions are consumed to their close, as opaque text:
 *
 *     '…'   string literal          — `''` is an escaped quote, not a close
 *     […]   delimited identifier    — `]]` is an escaped bracket
 *     "…"   delimited identifier    — `""` is an escaped quote
 *
 *   Inside any of them a `'`, `;`, `)`, or `--` is DATA and is ignored; none of
 *   them may be left unterminated.
 *
 *   `"…"` is consumed rather than rejected because that reading is safe under
 *   BOTH `QUOTED_IDENTIFIER` settings, and — importantly — the argument does not
 *   rest on the `""` doubling premise. ON, `"…"` is a delimited identifier; OFF,
 *   it is a string literal. Either way the region is opaque to the parser, and
 *   either way a `""` pair consumes two quote characters and leaves the scan in
 *   the same in/out state as the engine. So the scan cannot desynchronise even
 *   if the doubling reading is wrong for a given setting. (In practice OFF is
 *   theoretical here: tedious sets `enableQuotedIdentifier: true` by default and
 *   the pool config does not override it.)
 *
 * WHAT THIS GUARANTEES, PRECISELY. What survives is ONE expression in which the
 * parentheses balance, every quoted region is closed, and no statement
 * terminator or comment introducer appears outside a quoted region — so it
 * cannot close `CHECK(` and cannot reach statement position. That is the whole
 * claim; it is deliberately narrower than "a safe expression".
 *
 * NOT claimed: that the expression cannot read beyond the row. T-SQL restricts a
 * CHECK constraint to a scalar expression (no subqueries, no EXEC), but it MAY
 * call a scalar UDF — `dbo.Fn([col]) = 1` is accepted here and by the engine —
 * and a UDF body can read other tables. That is engine-permitted by design and
 * is reachable only by a caller who already holds constraint-DDL rights on the
 * table, so it is a threat-model note, not a bypass of this scan.
 *
 * KNOWN, ACCEPTED EDGE: an unmatched `]` outside any bracket (`Col] > 0`) is
 * accepted here and fails downstream as a TDS syntax error rather than a 400.
 * Containment still holds — a stray `]` cannot close `CHECK(` — and tightening
 * it risks new false positives on legitimate names, so it is left alone.
 */
export function validCheckExpression(expr: string): string | null {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];

    // Delimited IDENTIFIER — [name] / "name". Every character inside is part of
    // the NAME to T-SQL, including ' ; ) and --, so none of them may steer this
    // scan. Consumed whole.
    if (ch === '[' || ch === '"') {
      const end = consumeQuoted(expr, i, ch === '[' ? ']' : '"');
      if (end < 0) {
        return ch === '['
          ? 'CHECK expression has an unterminated "[" delimited identifier'
          : 'CHECK expression has an unterminated \'"\' delimited identifier';
      }
      i = end;
      continue;
    }

    // String literal — '…', where '' is an escaped quote.
    if (ch === "'") {
      const end = consumeQuoted(expr, i, "'");
      if (end < 0) return 'CHECK expression has an unterminated string literal';
      i = end;
      continue;
    }

    const next = expr[i + 1];
    if (ch === ';') return 'CHECK expression cannot contain ";" (statement terminator)';
    if (ch === '-' && next === '-') return 'CHECK expression cannot contain a line comment ("--")';
    if (ch === '/' && next === '*') return 'CHECK expression cannot contain a block comment';
    if (ch === '*' && next === '/') return 'CHECK expression cannot contain a block comment';
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      depth--;
      // Negative depth means this ")" would have closed the CHECK( we are inside.
      if (depth < 0) return 'CHECK expression has unbalanced parentheses — it cannot close the CHECK(…) clause';
    }
  }
  if (depth !== 0) return 'CHECK expression has unbalanced parentheses';
  return null;
}

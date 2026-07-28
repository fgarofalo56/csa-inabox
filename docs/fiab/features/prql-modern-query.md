# PRQL modern-query mode (Preview)

> **Surface:** SQL Lab editor (`/items/sql-lab/<id>`) — the modern-query language toggle
> **Backend:** none of its own. PRQL is transpiled to SQL in the console and runs on the **same DuckDB engine** SQL Lab already uses (with the honest Synapse Serverless fallback).
> **Kill-switch flag:** `n8-modern-query-prql` (default ON)
> **Honest gate:** none — but an unsupported construct is an honest error, never a guessed query

**Preview.** Write [PRQL](https://prql-lang.org/) (Pipelined Relational Query
Language, Apache-2.0) instead of SQL and have it run unchanged on Loom's default
query tier. PRQL reads top-to-bottom as a pipeline, which makes long analytical
transformations far easier to read and diff than a deeply nested SELECT.

## Why it exists

This is one of the openness labs: a low-cost bet that a meaningful slice of
analysts prefer a pipelined query language, shipped honestly as Preview rather
than announced as a strategy. It adds no infrastructure, no new engine, and no
new cost — the transpiler is a pure function in the console and the query runs
on the tier that was already there.

## The honesty contract

The reference PRQL transpiler is a Rust/WASM package. Bundling a WASM blob into
the server for a Preview lab is a heavier commitment than the lab warrants, and
it cannot produce errors at the granularity Loom wants. So Loom transpiles a
**documented, tested subset in pure TypeScript** and — the load-bearing part —
**throws on any construct it does not fully understand rather than emitting a
guessed SQL string**. The editor surfaces that error verbatim. Loom never
silently runs SQL you did not intend.

### Supported subset

| PRQL | Translates to |
|---|---|
| `from <table>` — also `from alias = table` and a backtick-quoted `schema.table` | the FROM clause |
| `filter <bool-expr>` | `WHERE (… AND …)` — before any aggregate only |
| `derive <name = expr>` or `derive {a = x, …}` | projected `expr AS name` |
| `select <col>` or `select {a, b = x, …}` | the projection (derived names fold in) |
| `group {cols} (aggregate {…})` | `GROUP BY` plus the aggregate projection |
| `aggregate {name = sum col, …}` | `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` / `STDDEV` |
| `sort <col>` or `sort {-a, +b, c}` | `ORDER BY` (`-` descending, `+` ascending) |
| `take <n>` or `take <m..n>` | `LIMIT` with optional `OFFSET` |

Operators inside an expression translate one-to-one to their SQL form (`==` to
`=`, `&&` to `AND`, `||` to `OR`); anything else passes through unchanged.
Aggregate-column alias references resolve on DuckDB's lateral-alias support, so
`derive` plus `select` fold into a single SELECT list without a subquery.

**Anything outside this grammar throws** — s-strings, f-strings, window
functions, joins, `loop`, double-quoted strings, HAVING-style post-aggregate
filters, and nested pipelines. SQL Lab then shows the honest "unsupported PRQL"
surface naming the offending construct.

## How to use it end to end

1. Open a **SQL Lab** item.
2. Switch the **language toggle** from SQL to PRQL.
3. Write a pipeline, for example:

   ```elm
   from orders
   filter status == "shipped"
   derive {margin = revenue - cost}
   group {region} (aggregate {total = sum margin, n = count region})
   sort {-total}
   take 20
   ```

4. **Run it.** Loom transpiles, then executes the resulting SQL on the DuckDB
   tier exactly as if you had typed the SQL yourself. The engine and timing
   status bar reads the same.
5. **If a construct is unsupported**, the editor shows the honest error with the
   offending fragment. Rewrite that step, or switch the toggle back to SQL for
   the whole query.

## Honest gates

None of its own. PRQL inherits the SQL Lab tier's posture: with
`LOOM_DUCKDB_URL` unset, SQL Lab honest-gates to the Synapse Serverless fallback
and PRQL rides that same path.

## Kill-switch

`n8-modern-query-prql` — default ON. Flipping it OFF hides the language toggle
and reverts SQL Lab to SQL-only on the next render. The DuckDB tier, the
`/api/duckdb/**` routes, and every other tab are unaffected.

## Related

- [Trino federation (opt-in)](trino-federation.md) — the other SQL Lab engine option
- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md)
- [Iceberg REST catalog and interop](iceberg-interop.md)

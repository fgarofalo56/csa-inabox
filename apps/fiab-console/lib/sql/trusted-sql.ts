/**
 * lib/sql/trusted-sql.ts — the type that makes the Azure SQL TDS statement
 * argument safe BY CONSTRUCTION.
 *
 * WHY THIS FILE EXISTS (security — CodeQL js/sql-injection #789):
 *
 *   `azure-sql-client.executeParameterized` ends in `request.query(sqlText)`, so
 *   it executes whatever statement a caller hands it. `params` bind as `@p0`,
 *   `@p1`, … and are genuinely safe — a bound VALUE can never be re-parsed as
 *   SQL — but that guarantee has NEVER covered `sqlText` itself. An earlier
 *   revision of the client's comment asserted that "no string-injection path
 *   exists" and that the function was "used only by the sql-objects navigator".
 *   Both were false, and read as a whole-function guarantee they are exactly how
 *   a caller-supplied CHECK expression reached `.query()` verbatim:
 *   `1=1); DROP TABLE Orders; --` returned HTTP 200.
 *
 *   #3489 fixed that ONE caller (the grammar scan in `./check-expression`). It
 *   did not change the SHAPE that produced it: six modules reach the sink, one
 *   of them was defended, and a seventh could be added tomorrow with nothing
 *   structurally stopping it — which is precisely how the defect arrived.
 *
 *   So the statement parameter is no longer `string`. It is {@link TrustedSql},
 *   a branded type that ONLY the constructors below can produce. A caller that
 *   hands the sink a raw string now fails to compile, and the review question
 *   moves from "did every one of ~40 call sites do the right thing?" to "is each
 *   of these seven constructors sound?".
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *
 *   There is no general `unsafeCast(s: string): TrustedSql`. One would reproduce
 *   today's situation with extra steps and be strictly worse than doing nothing,
 *   because every call site would then LOOK defended. The single non-containing
 *   constructor — {@link sqlWithNoContainmentGuarantee} — is named for what it
 *   is, states in its own name that it proves nothing, and is keyed to a CLOSED
 *   union of surfaces, so adding a caller means editing this file under review.
 *
 * WHAT A BRAND DOES AND DOES NOT BUY
 *
 *   `TrustedSql` is erased at runtime (it IS a string). It buys a compile-time
 *   proof that the statement was assembled by one of these constructors; it does
 *   not re-validate anything at runtime, and it is not a claim that CodeQL's
 *   dataflow will stop reporting the sink — CodeQL does not model this repo's
 *   quoting helpers as barriers (see `./quoting`), so a value that flows through
 *   `bracket()` is still tracked. The value here is structural: the defect class
 *   cannot be reintroduced by a new caller without deliberately defeating a type.
 */

import { bracket } from './quoting';
import { validCheckExpression } from './check-expression';

declare const TrustedSqlBrand: unique symbol;
declare const SqlFragmentBrand: unique symbol;

/**
 * A complete SQL statement (or batch) that may be handed to the TDS executor.
 * Producible only by {@link tsql} and {@link sqlWithNoContainmentGuarantee}.
 */
export type TrustedSql = string & { readonly [TrustedSqlBrand]: true };

/**
 * A SQL SPAN that is safe to splice into a statement: an identifier token, an
 * integer literal, a keyword, or a composition of those. Producible only by the
 * constructors in this module.
 *
 * A fragment is NOT a statement — it carries no claim about what it means, only
 * that it cannot END the syntactic position it is spliced into and reach
 * statement position.
 */
export type SqlFragment = string & { readonly [SqlFragmentBrand]: true };

/**
 * COMPILE-TIME REGRESSION PIN. If either brand is ever deleted, widened, or made
 * optional, the branded type collapses back to `string`, every call site keeps
 * compiling, and the whole defence evaporates SILENTLY — the loudest possible
 * version of a gate that measures nothing.
 *
 * These two aliases fail `tsc` the moment that happens (a plain `string` would
 * become assignable, so `Assert<false>` would be handed `true`). They are
 * type-only and erase completely; the merge-gate build check is what enforces
 * them. There is no runtime cost and nothing to remember to run.
 */
type Assert<T extends false> = T;
type _TrustedSqlIsNotJustString = Assert<string extends TrustedSql ? true : false>;
type _SqlFragmentIsNotJustString = Assert<string extends SqlFragment ? true : false>;

/** Thrown when a constructor is handed a value it cannot prove safe. */
export class UntrustedSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedSqlError';
  }
}

function weave(strings: TemplateStringsArray, fragments: readonly SqlFragment[]): string {
  let out = strings[0];
  for (let i = 0; i < fragments.length; i++) out += fragments[i] + strings[i + 1];
  return out;
}

/**
 * The statement constructor: a tagged template whose LITERAL spans are written
 * in the calling module and whose INTERPOLATED spans must each already be a
 * {@link SqlFragment}.
 *
 * INVARIANT: every character of the result is either (a) source text the author
 * of the calling module typed, or (b) a fragment one of the constructors below
 * proved cannot escape its syntactic position. No caller argument, request body,
 * or database value can appear except through a fragment constructor — a raw
 * `string` interpolation is a compile error, which is the whole point.
 *
 *   tsql`SELECT name FROM sys.schemas WHERE schema_id = @p0;`
 *   tsql`DROP TABLE ${quotedName(schema, table)};`
 *
 * `@pN` markers are the preferred way to carry VALUES — they bind, and a bound
 * value can never be re-parsed as SQL. Reach for a fragment only where binding
 * is impossible (identifiers and DDL keywords, which T-SQL will not bind).
 */
export function tsql(strings: TemplateStringsArray, ...fragments: SqlFragment[]): TrustedSql {
  return weave(strings, fragments) as TrustedSql;
}

/**
 * The fragment constructor — same rule as {@link tsql}, but the result is a span
 * rather than a statement, so it can be composed into a larger fragment or into
 * a statement.
 *
 * With NO interpolation it is the "this span is a module literal" constructor:
 *
 *   const clustered = spec.clustered ? sqlFragment`CLUSTERED` : sqlFragment`NONCLUSTERED`;
 *
 * which is how a keyword chosen by a boolean or a closed union is proven safe:
 * every possible value is source text in this repository.
 */
export function sqlFragment(strings: TemplateStringsArray, ...fragments: SqlFragment[]): SqlFragment {
  return weave(strings, fragments) as SqlFragment;
}

/**
 * A single delimited (bracket-quoted) T-SQL identifier.
 *
 * INVARIANT: `bracket()` from `./quoting` doubles every embedded `]`, so the
 * result is exactly ONE `[…]` identifier token for ANY input string. A `]`, `;`,
 * `)` or `--` inside `name` is part of the NAME to the engine and cannot end the
 * token, so the fragment cannot reach statement position. This is a TOTAL
 * function — containment does not depend on the caller having validated `name`.
 *
 * Provenance is a SEPARATE, caller-level concern that containment does not
 * cover: a catalog-resolved name (read back from `sys.*` by integer id) and a
 * user-supplied new-object name are equally CONTAINED here, but only the caller
 * knows whether naming that object is authorised. Call sites document which they
 * are passing.
 */
export function quotedIdentifier(name: string): SqlFragment {
  return bracket(name) as SqlFragment;
}

/**
 * A dot-qualified identifier path — `[schema].[object]`, `[db].[schema].[table]`
 * — each part bracket-quoted by {@link quotedIdentifier}. The dots are source
 * text here, so no caller string can introduce one.
 */
export function quotedName(...parts: string[]): SqlFragment {
  if (parts.length === 0) throw new UntrustedSqlError('quotedName() needs at least one identifier part');
  return parts.map((p) => bracket(p)).join('.') as SqlFragment;
}

/**
 * An integer literal.
 *
 * INVARIANT: the value is proven to be an exact integer, and the decimal
 * rendering of an integer contains only `-` and `0`-`9` — no quote, no
 * delimiter, no statement terminator, nothing the parser can be steered with.
 * A non-integer, non-finite, or precision-lossy value throws rather than being
 * rendered (`1e21`, `NaN` and `Infinity` all stringify to text that is not a
 * numeric literal, so silently emitting them would be the bug this prevents).
 *
 * This constructor makes no claim about MAGNITUDE. A `TOP (n)` or retention
 * window still needs its own clamp for resource reasons; that is a capacity
 * concern, not an injection one, and it stays at the call site where the
 * meaningful bounds are known.
 */
export function integerLiteral(value: number | bigint): SqlFragment {
  if (typeof value === 'bigint') return value.toString() as SqlFragment;
  if (!Number.isSafeInteger(value)) {
    throw new UntrustedSqlError(`integerLiteral() requires an exact integer, got ${String(value)}`);
  }
  return String(value) as SqlFragment;
}

/**
 * A T-SQL CHECK-constraint expression, proven by `./check-expression` to be
 * containable inside the `CHECK (…)` clause it is spliced into.
 *
 * This is the ONE SQL fragment Loom accepts as free text, because it can be
 * neither bound (it is not a value) nor quoted (it IS SQL by definition —
 * `[Total] > 0`). {@link validCheckExpression} is the closed-grammar scan that
 * refuses anything which could close the clause and reach statement position;
 * read its docstring for exactly what is and is not claimed.
 *
 * It THROWS on a rejected expression. A caller that owes the user an HTTP 400
 * (rather than a 502) must run `validCheckExpression` itself first and return
 * its message — `sql-objects-client.addConstraint` does exactly that, and this
 * call is then the type-level backstop that cannot be forgotten.
 */
export function containedCheckExpression(expression: string): SqlFragment {
  const err = validCheckExpression(expression);
  if (err) throw new UntrustedSqlError(err);
  return expression as SqlFragment;
}

/**
 * Join fragments with a separator that is itself a fragment (so the separator
 * cannot be caller text either).
 */
export function joinFragments(fragments: readonly SqlFragment[], separator: SqlFragment): SqlFragment {
  return fragments.join(separator) as SqlFragment;
}

/** `a, b, c` — the separator every column/key list in this codebase uses. */
export function commaSeparated(fragments: readonly SqlFragment[]): SqlFragment {
  return joinFragments(fragments, sqlFragment`, `);
}

/**
 * Surfaces whose PRODUCT CONTRACT is "execute the SQL the signed-in author
 * wrote". This union is deliberately closed: adding a member is an edit to this
 * security module, under review, and not something a new call site can do on its
 * own.
 *
 *   report-visual-compiler — `lib/azure/wells-to-sql.buildSqlFromVisual` compiles
 *     a report visual into T-SQL whose identifiers are resolver-whitelisted and
 *     whose values bind as `@p<n>`. It may nonetheless WRAP the report data
 *     source's own custom `SELECT` (`ReportObjectRef.mode === 'query'`), which
 *     the report designer exposes on purpose — the same arbitrary-SQL surface as
 *     the query editor, reached only by a user who can already author a report
 *     against that connection.
 */
export type UncontainedSqlSurface = 'report-visual-compiler';

/**
 * NOT A SAFETY CLAIM — read the name.
 *
 * This mints {@link TrustedSql} from a plain string for the handful of surfaces
 * whose entire purpose is to run operator-authored SQL. It proves NOTHING about
 * the statement; it records that a human decided this surface executes what the
 * author wrote, and names which surface.
 *
 * If you are reaching for this to get a statement past the compiler, you want a
 * fragment constructor instead. Adding a member to {@link UncontainedSqlSurface}
 * to use it here is a security review, not a refactor.
 */
export function sqlWithNoContainmentGuarantee(
  statement: string,
  surface: UncontainedSqlSurface,
): TrustedSql {
  if (!surface) throw new UntrustedSqlError('a surface must be named');
  return statement as TrustedSql;
}

/**
 * kql-escape — the single sanctioned way to place a runtime string inside a
 * KQL / ARG / App-Insights query or a Kusto management command.
 *
 * THE CLASS THIS CLOSES (CodeQL js/incomplete-sanitization, 35+ instances):
 * `.replace(/"/g, '\\"')` alone is NOT a safe double-quoted-literal escape —
 * an input ending in a backslash (`evil\`) renders as `"evil\\"` where the
 * doubled backslash swallows the escape and the closing quote goes LIVE,
 * breaking out of the literal into raw KQL. The backslash must be escaped
 * FIRST, then the quote. Raw CR/LF also terminate a KQL literal (literals are
 * single-line), so they are encoded too.
 *
 * VERBATIM literals (`@"…"`, `h@'…'`) are DIFFERENT: backslash is a plain
 * character there and the only escape is doubling the quote character
 * (Learn: kusto/query/scalar-data-types/string). Writing `\"` inside a
 * verbatim string leaves the backslash literal and the quote TERMINATES the
 * string — that was a live breakout in data-quality-client (`@"${pat}"`) and
 * kusto-client (`h@'${uri}'`) before this module existed.
 *
 * Zero runtime dependencies beyond the audited `lib/sql/quoting` doubler, so
 * the "dependency-free" modules (kusto-purge-predicate, kusto-mv-command,
 * editors/_family-utils) can import it without pulling in an SDK.
 */
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/** Escape for a double-quoted KQL string literal: `"…"` or `h"…"`. */
export function kqlEscapeDouble(s: string): string {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** Escape for a single-quoted KQL string literal: `'…'` or `h'…'`. */
export function kqlEscapeSingle(s: string): string {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Escape for a VERBATIM single-quoted literal (`@'…'` / `h@'…'`): the quote is
 * doubled; backslash is a plain character. CR/LF cannot be represented inside
 * a verbatim literal at all (they end the line, i.e. the literal), so they are
 * stripped — fail-closed rather than command-splitting.
 */
export function kqlVerbatimSingle(s: string): string {
  // Delegates the doubling to the ONE audited quoter (lib/sql/quoting.ts) per
  // check-sql-quoting.mjs — this module adds only the CR/LF strip on top.
  return escapeSqlLiteral(String(s)).replace(/[\r\n]/g, '');
}

/** Escape for a VERBATIM double-quoted literal (`@"…"` / `h@"…"`). */
export function kqlVerbatimDouble(s: string): string {
  return String(s).replace(/"/g, '""').replace(/[\r\n]/g, '');
}

/** Bracket-quoted KQL entity name: `Raw Events` → `["Raw Events"]`. */
export function kqlIdent(name: string): string {
  return `["${kqlEscapeDouble(name)}"]`;
}

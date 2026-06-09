/**
 * Pure DAX→T-SQL probe helpers for the DAX Copilot. Deliberately dependency-free
 * (no Azure SDK / Cosmos imports) so the translation logic is unit-testable in a
 * plain node environment and reusable from both dax-tools.ts and the BFF.
 */

/** Strip ```dax / ``` fences a model sometimes wraps an expression in. */
export function stripFence(s: string): string {
  return s
    .replace(/^```[a-zA-Z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Best-effort DAX->T-SQL probe. Recognizes the simple single-column aggregates
 * (SUM, AVERAGE, COUNT, COUNTA, COUNTROWS, MIN, MAX) and turns them into a real
 * T-SQL aggregate against the Synapse Dedicated pool so we can confirm the
 * referenced column exists and the aggregate computes. Anything more complex
 * (CALCULATE, VAR, SAMEPERIODLASTYEAR, DIVIDE of sub-expressions) is returned as
 * a structural no-row probe with canEval=false — we validate the structure
 * exists, but do not pretend to evaluate DAX semantics (that needs a real
 * DAX/XMLA engine, out of scope per no-fabric-dependency.md).
 */
export function buildTSqlProbe(daxExpr: string, tableName?: string): { sql: string; canEval: boolean } {
  const expr = (daxExpr || '').trim();
  const ident = `['"]?([\\w][\\w ]*?)['"]?\\s*\\[\\s*([\\w][\\w ]*?)\\s*\\]`;

  const sum = expr.match(new RegExp(`^SUM\\s*\\(\\s*${ident}\\s*\\)$`, 'i'));
  if (sum) return { sql: `SELECT SUM([${sum[2]}]) AS probe_value FROM [${sum[1]}]`, canEval: true };

  const avg = expr.match(new RegExp(`^(?:AVERAGE|AVG)\\s*\\(\\s*${ident}\\s*\\)$`, 'i'));
  if (avg) return { sql: `SELECT AVG(CAST([${avg[2]}] AS FLOAT)) AS probe_value FROM [${avg[1]}]`, canEval: true };

  const minmax = expr.match(new RegExp(`^(MIN|MAX)\\s*\\(\\s*${ident}\\s*\\)$`, 'i'));
  if (minmax) return { sql: `SELECT ${minmax[1].toUpperCase()}([${minmax[3]}]) AS probe_value FROM [${minmax[2]}]`, canEval: true };

  const countCol = expr.match(new RegExp(`^(?:COUNT|COUNTA)\\s*\\(\\s*${ident}\\s*\\)$`, 'i'));
  if (countCol) return { sql: `SELECT COUNT([${countCol[2]}]) AS probe_value FROM [${countCol[1]}]`, canEval: true };

  const countRows = expr.match(/^COUNTROWS\s*\(\s*['"]?([\w][\w ]*?)['"]?\s*\)$/i);
  if (countRows) return { sql: `SELECT COUNT(*) AS probe_value FROM [${countRows[1]}]`, canEval: true };

  // Complex expression — structural no-row probe against a real table when we
  // know one, else sys.objects (always present on Synapse). canEval=false so
  // the caller reports confidence:'unvalidated' honestly.
  const fallbackTable = (tableName || '').trim() || 'sys.objects';
  return { sql: `SELECT 1 AS probe_value FROM [${fallbackTable.replace(/[[\]]/g, '')}] WHERE 1=0`, canEval: false };
}

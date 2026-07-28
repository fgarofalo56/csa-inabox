/**
 * M3 — SQL transpile module (Snowflake / T-SQL → Loom SQL), HONEST + best-effort.
 *
 * "Loom SQL" is the bracket-quoted Synapse-serverless T-SQL dialect the Loom
 * warehouse / lakehouse SQL endpoints speak (the same dialect wells-to-sql.ts
 * and the A2 DAX fold engine emit). This module transpiles the source-view /
 * stored-routine SQL rows M1's ReadinessReport flags as translatable source.
 *
 * DIE-HARD HONESTY (mirrors A1's unsupportedDaxError): a construct this module
 * cannot translate with confidence is FLAGGED `needs-review` with the EXACT
 * reason and the source is preserved VERBATIM — a `needs-review` statement's
 * `loomSql` is `null`; it NEVER emits a fabricated / guessed translation. Only a
 * statement whose every construct is a confident, purely-mechanical rewrite
 * (identifier requoting + an exact-1:1 function rename + a view-header rename)
 * yields a translated `loomSql`.
 *
 * PURE + dependency-light: string/regex only, plus the shared bracket-quoter
 * (@/lib/sql/quoting — never inline identifier quoting per the sql-quoting rule).
 * No Azure / Cosmos / React imports, so it unit-tests in isolation and runs in
 * the client editor's live diff and the server route with zero drift.
 */
import { bracket } from '@/lib/sql/quoting';

/** The two inbound SQL dialects M3 transpiles from. */
export type SqlSourceDialect = 'snowflake' | 'tsql';

/** One construct the transpiler recognized in a statement. `supported` rewrites
 * were applied verbatim; an unsupported construct blocks a confident translation
 * and carries the exact human reason a reviewer needs. */
export interface SqlConstructFlag {
  /** Short construct label (e.g. `QUALIFY`, `LATERAL FLATTEN`, `NVL→ISNULL`). */
  construct: string;
  supported: boolean;
  reason: string;
}

/** Per-statement transpile result. `loomSql` is non-null ONLY when the whole
 * statement was confidently, mechanically translated; a `needs-review`
 * statement keeps `loomSql: null` and its `source` verbatim (never fabricated). */
export interface SqlStatementResult {
  /** The source statement verbatim (comments + strings preserved). */
  source: string;
  supported: boolean;
  loomSql: string | null;
  flags: SqlConstructFlag[];
}

/** Whole-input transpile result across every statement in the source. */
export interface SqlTranspileResult {
  dialect: SqlSourceDialect;
  statements: SqlStatementResult[];
  /** True when EVERY statement was confidently translated. */
  supported: boolean;
  needsReviewCount: number;
  /** The joined Loom SQL when `supported`; `null` when any statement needs review. */
  loomSql: string | null;
}

// ── Literal / comment masking (so detection never fires inside a string) ──────

/** Opaque placeholder sentinel — a control char that never appears in SQL. */
const MASK = String.fromCharCode(1);

interface Masked {
  masked: string;
  spans: string[];
}

/** Replace every single-quoted string, `--` line comment, and block comment
 * with an opaque placeholder so keyword/construct detection and rewrites only
 * ever touch real SQL code, never text inside a literal or comment. */
function maskLiterals(sql: string): Masked {
  const spans: string[] = [];
  let out = '';
  let i = 0;
  const n = sql.length;
  const push = (text: string) => {
    const idx = spans.length;
    spans.push(text);
    out += `${MASK}${idx}${MASK}`;
  };
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      push(sql.slice(i, j));
      i = j;
    } else if (ch === '-' && nx === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n') j += 1;
      push(sql.slice(i, j));
      i = j;
    } else if (ch === '/' && nx === '*') {
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      push(sql.slice(i, j));
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return { masked: out, spans };
}

function unmask(masked: string, spans: string[]): string {
  return masked.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_, d) => spans[Number(d)] ?? '');
}

/** Strip placeholders to plain spaces (for leading-keyword detection). */
function codeOnly(masked: string): string {
  return masked.replace(new RegExp(`${MASK}\\d+${MASK}`, 'g'), ' ');
}

// ── Construct catalogs (the honest boundary of what we translate) ─────────────

/** Exact-1:1 function renames (semantics identical Snowflake→T-SQL). */
const SNOWFLAKE_RENAMES: Array<{ re: RegExp; to: string; label: string }> = [
  { re: /\bNVL\s*\(/gi, to: 'ISNULL(', label: 'NVL→ISNULL' },
  { re: /\bIFNULL\s*\(/gi, to: 'ISNULL(', label: 'IFNULL→ISNULL' },
  { re: /\bIFF\s*\(/gi, to: 'IIF(', label: 'IFF→IIF' },
  { re: /\bLENGTH\s*\(/gi, to: 'LEN(', label: 'LENGTH→LEN' },
];

/** Constructs with NO confident mechanical translation → needs-review + reason. */
const SNOWFLAKE_UNSUPPORTED: Array<{ re: RegExp; construct: string; reason: string }> = [
  { re: /\bLATERAL\b|\bFLATTEN\s*\(/i, construct: 'LATERAL FLATTEN', reason: 'Snowflake LATERAL FLATTEN over a VARIANT has no direct Synapse T-SQL equivalent — re-express with OPENJSON + CROSS APPLY by hand.' },
  { re: /\bQUALIFY\b/i, construct: 'QUALIFY', reason: 'The QUALIFY clause has no T-SQL equivalent — wrap the window function in a subquery/CTE and filter it in a WHERE.' },
  { re: /::/, construct: ':: cast', reason: 'Snowflake `::` cast shorthand — rewrite each occurrence as CAST(expr AS type); the target type mapping needs review.' },
  { re: /\bPARSE_JSON\s*\(|\bOBJECT_CONSTRUCT\s*\(|\bARRAY_CONSTRUCT\s*\(|\bVARIANT\b|\bGET_PATH\s*\(/i, construct: 'semi-structured/VARIANT', reason: 'Semi-structured JSON/VARIANT construction or access — map to OPENJSON / JSON_VALUE / JSON_QUERY manually.' },
  { re: /\bLISTAGG\s*\(/i, construct: 'LISTAGG', reason: 'LISTAGG differs from T-SQL STRING_AGG (WITHIN GROUP ordering + delimiter placement) — translate by hand and verify ordering.' },
  { re: /\bTO_VARCHAR\s*\(|\bTO_TIMESTAMP\s*\(|\bTO_NUMBER\s*\(|\bTO_DATE\s*\(/i, construct: 'TO_* conversion', reason: 'Snowflake TO_* conversion with a format model — map to CAST / CONVERT / FORMAT with an explicit style code; the format string needs review.' },
  { re: /\bDATE_TRUNC\s*\(/i, construct: 'DATE_TRUNC', reason: 'DATE_TRUNC — use DATETRUNC (verify the grain literal) or a DATEADD/DATEDIFF rewrite; needs review.' },
  { re: /\bMERGE\b/i, construct: 'MERGE', reason: 'A MERGE statement is data-modifying — a Loom SQL view is read-only; re-express as a lakehouse pipeline / dataflow.' },
  { re: /\bPIVOT\b|\bUNPIVOT\b/i, construct: 'PIVOT/UNPIVOT', reason: 'PIVOT/UNPIVOT syntax differs between Snowflake and T-SQL — translate and verify the aggregate + value list manually.' },
  { re: /\bSAMPLE\b|\bTABLESAMPLE\b/i, construct: 'SAMPLE', reason: 'Row-sampling syntax differs — re-express with T-SQL TABLESAMPLE and verify the sampling semantics.' },
  { re: /\bGENERATOR\s*\(|\bSEQ[1248]\s*\(/i, construct: 'GENERATOR', reason: 'Snowflake table generators have no T-SQL equivalent — use a numbers table / recursive CTE.' },
  { re: /\bCONNECT\s+BY\b|\bSTART\s+WITH\b/i, construct: 'CONNECT BY', reason: 'Hierarchical CONNECT BY — re-express with a recursive CTE (WITH … UNION ALL).' },
];

/** Constructs unsupported when landing T-SQL on Synapse-serverless Loom SQL. */
const TSQL_UNSUPPORTED: Array<{ re: RegExp; construct: string; reason: string }> = [
  { re: /#[A-Za-z_]/, construct: 'temp table', reason: 'A #temp table is not supported on the Synapse-serverless Loom SQL endpoint — materialize to a lakehouse Delta table (CETAS) instead.' },
  { re: /@[A-Za-z_]\w*\s+TABLE\b/i, construct: 'table variable', reason: 'A TABLE variable is not supported on Synapse-serverless — restructure into a CTE or a lakehouse table.' },
  { re: /\bMERGE\b/i, construct: 'MERGE', reason: 'MERGE is not supported on the Synapse-serverless Loom SQL endpoint — re-express as an INSERT/UPDATE pipeline over the lakehouse.' },
  { re: /\bSELECT\b[\s\S]*\bINTO\b\s+(?!@)/i, construct: 'SELECT … INTO', reason: 'SELECT … INTO is not supported on Synapse-serverless — use CETAS (CREATE EXTERNAL TABLE AS SELECT) into the lakehouse.' },
  { re: /\bCURSOR\b|\bWHILE\b|\bFETCH\b/i, construct: 'procedural loop', reason: 'Cursor / WHILE procedural loops have no place in a read-only Loom SQL view — re-implement as a notebook or user-data-function.' },
  { re: /\bIDENTITY\s*\(/i, construct: 'IDENTITY', reason: 'IDENTITY columns are not supported on Synapse-serverless — assign keys in the ingesting pipeline.' },
];

interface LeadClass {
  kind: 'query' | 'view' | 'unsupported';
  construct?: string;
  reason?: string;
}

/** Classify a statement by its leading keyword (masked code, placeholders removed). */
function classifyLead(code: string): LeadClass {
  const c = code.trim();
  const word = (c.match(/^([A-Za-z_]+)/)?.[1] || '').toUpperCase();
  if (word === 'SELECT' || word === 'WITH') return { kind: 'query' };
  if (word === 'CREATE') {
    if (/^CREATE\s+(OR\s+REPLACE\s+)?SECURE\s+VIEW\b/i.test(c)) {
      return { kind: 'unsupported', construct: 'SECURE VIEW', reason: 'A Snowflake SECURE VIEW hides its definition and enforces row/column security — re-express the access policy through Loom governance; the view body still needs review.' };
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW\b/i.test(c)) {
      return { kind: 'unsupported', construct: 'MATERIALIZED VIEW', reason: 'A materialized view maps to a scheduled Loom pipeline that writes a lakehouse Delta table — not a plain SQL view; needs review.' };
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+|OR\s+ALTER\s+)?VIEW\b/i.test(c)) return { kind: 'view' };
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+|TRANSIENT\s+)?(PROCEDURE|FUNCTION)\b/i.test(c)) {
      return { kind: 'unsupported', construct: 'stored routine', reason: 'A stored procedure / UDF has no 1:1 Loom item — re-implement it as a Loom user-data-function or notebook (mirrors M1 stored-routine → needs-review).' };
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(TASK|STREAM|STAGE|PIPE|SEQUENCE|WAREHOUSE|DATABASE|SCHEMA)\b/i.test(c)) {
      return { kind: 'unsupported', construct: 'Snowflake object DDL', reason: 'This Snowflake object (task / stream / stage / pipe / sequence / warehouse) has a distinct Loom analog (pipeline / eventstream / linked service) — provision it there, not as SQL.' };
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+|TRANSIENT\s+)?TABLE\b/i.test(c)) {
      return { kind: 'unsupported', construct: 'CREATE TABLE', reason: 'A source table lands as a lakehouse Delta table via a data-copy pass (M1/M2), not by executing DDL on the Loom SQL endpoint; needs review.' };
    }
    return { kind: 'unsupported', construct: 'DDL', reason: 'Unrecognized CREATE/DDL statement — provision the target through the matching Loom item type, not raw SQL; needs review.' };
  }
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE', 'USE', 'SET', 'BEGIN', 'DECLARE'].includes(word)) {
    return { kind: 'unsupported', construct: word, reason: `A ${word} statement is not a translatable read-only artifact — a Loom SQL view is SELECT-only; move this logic into a pipeline / function.` };
  }
  if (word === '') return { kind: 'unsupported', construct: 'empty', reason: 'Empty statement — nothing to translate.' };
  return { kind: 'unsupported', construct: word, reason: `Unrecognized leading keyword "${word}" — cannot classify this statement; needs review.` };
}

// ── Per-dialect statement transpile ───────────────────────────────────────────

/** Requote Snowflake double-quoted identifiers as Loom bracket identifiers. */
function requoteIdentifiers(masked: string): string {
  return masked.replace(/"([^"]*)"/g, (_, inner) => bracket(String(inner)));
}

function transpileStatement(rawMasked: string, spans: string[], dialect: SqlSourceDialect): SqlStatementResult {
  const source = unmask(rawMasked, spans).trim();
  const code = codeOnly(rawMasked);
  const flags: SqlConstructFlag[] = [];

  const lead = classifyLead(code);
  if (lead.kind === 'unsupported') {
    flags.push({ construct: lead.construct || 'unsupported', supported: false, reason: lead.reason || 'Needs review.' });
    return { source, supported: false, loomSql: null, flags };
  }

  // Collect every unsupported construct present (report them ALL in one pass).
  const unsupported = dialect === 'snowflake' ? SNOWFLAKE_UNSUPPORTED : TSQL_UNSUPPORTED;
  for (const u of unsupported) {
    if (u.re.test(code)) flags.push({ construct: u.construct, supported: false, reason: u.reason });
  }
  if (flags.some((f) => !f.supported)) {
    return { source, supported: false, loomSql: null, flags };
  }

  // Confident mechanical translation only.
  let out = rawMasked;
  if (dialect === 'snowflake') {
    const hadQuotedIdents = /"[^"]*"/.test(code);
    out = requoteIdentifiers(out);
    for (const r of SNOWFLAKE_RENAMES) {
      if (r.re.test(out)) {
        out = out.replace(r.re, r.to);
        flags.push({ construct: r.label, supported: true, reason: 'Exact 1:1 function rename to the Loom SQL (T-SQL) equivalent.' });
      }
    }
    if (lead.kind === 'view' && /\bCREATE\s+OR\s+REPLACE\s+VIEW\b/i.test(codeOnly(out))) {
      out = out.replace(/\bCREATE\s+OR\s+REPLACE\s+VIEW\b/i, 'CREATE OR ALTER VIEW');
      flags.push({ construct: 'OR REPLACE→OR ALTER', supported: true, reason: 'Snowflake CREATE OR REPLACE VIEW → Synapse CREATE OR ALTER VIEW (idempotent redefine).' });
    }
    if (hadQuotedIdents) {
      flags.push({ construct: 'identifiers', supported: true, reason: 'Double-quoted identifiers requoted as Loom bracket identifiers.' });
    }
  } else {
    // T-SQL → Loom SQL: dialect-compatible; passes through verbatim.
    flags.push({ construct: 'passthrough', supported: true, reason: 'T-SQL is dialect-compatible with the Synapse-serverless Loom SQL endpoint — carried over verbatim.' });
  }

  const loomSql = unmask(out, spans).trim();
  return { source, supported: true, loomSql, flags };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transpile a Snowflake / T-SQL source (one or many `;`-separated statements)
 * into Loom SQL. Every statement is classified independently; a statement with
 * any unsupported construct is flagged `needs-review` with the exact reason and
 * its `loomSql` stays `null` — never a fabricated translation.
 */
export function transpileSql(sql: string, dialect: SqlSourceDialect): SqlTranspileResult {
  const { masked, spans } = maskLiterals(String(sql ?? ''));
  const parts = masked.split(';').map((p) => p.trim()).filter((p) => p !== '');
  const statements: SqlStatementResult[] = parts.map((p) => transpileStatement(p, spans, dialect));
  const needsReviewCount = statements.filter((s) => !s.supported).length;
  const supported = statements.length > 0 && needsReviewCount === 0;
  const loomSql = supported ? statements.map((s) => s.loomSql).join(';\n\n') : null;
  return { dialect, statements, supported, needsReviewCount, loomSql };
}

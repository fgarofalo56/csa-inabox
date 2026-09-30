#!/usr/bin/env node
/**
 * GUARDRAIL: sql-literal-dialect  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE: a string literal is escaped by the rules of the engine that parses it.
 *
 *   T-SQL (Synapse, SQL Server), OData, DAX, Postgres, Trino, DuckDB, and KQL
 *   VERBATIM literals (`@'…'`) escape a quote by DOUBLING it — escapeSqlLiteral
 *   in apps/fiab-console/lib/sql/quoting.ts.
 *
 *   Spark / Databricks SQL and KQL REGULAR literals use BACKSLASH escapes: the
 *   backslash is escaped first, then the quote (`\\`, `\'`) — escapeSparkSqlLiteral
 *   and escapeKqlLiteral in the same module. Doubling is the wrong rule there:
 *   it leaves a backslash unescaped, so the engine reads a different value than
 *   the one intended, or rejects the statement.
 *
 * check-sql-quoting.mjs makes every literal go through lib/sql/quoting.ts. This
 * guard covers the question that one cannot see: whether the helper a file calls
 * is the right one FOR ITS ENGINE.
 *
 * HOW IT DECIDES
 *   scripts/ci/sql-literal-dialect-sites.json lists every console source file
 *   that builds Spark/Databricks SQL or KQL literals, each with an EXACT
 *   `tsqlEscapeAllowance`: the number of T-SQL-rule escapes the file may hold,
 *   with the engine each one feeds named in `reason`.
 *
 *   T-SQL-rule escapes counted (on code only — comments are masked by the shared
 *   lexer in ./_code-only.mjs, so prose cannot move a count):
 *     escapeSqlLiteral(…)
 *     .replace(/'/g, "''")                   inline doubling
 *     quoteLiteral(x) / escapeLiteralFor(x)  ONE simple argument, i.e. no
 *                                            dialect, which means T-SQL
 *
 *   It FAILS when:
 *     - a listed file is missing (a renamed file would otherwise drop out
 *       silently and the guard would watch nothing for it);
 *     - a listed file no longer references a helper for its engine (a file
 *       reverted wholesale to escapeSqlLiteral);
 *     - a listed file's count is ABOVE its allowance (a new doubling site in a
 *       Spark/KQL file) or BELOW it (stale headroom that would absorb the next
 *       regression — lower the allowance);
 *     - a file that references escapeSparkSqlLiteral / escapeKqlLiteral /
 *       escapeLiteralFor is not listed (the list must track the population,
 *       not a snapshot of it);
 *     - a file that references any other dialect-aware literal helper (the
 *       lib/azure/kql-escape module) holds a T-SQL-rule escape and is not
 *       listed;
 *     - the list is empty or an entry is malformed / duplicated.
 *
 * WHAT IT DOES NOT SEE (stated so a green run is not read as more):
 *   - a file that builds Spark/KQL text and has NEVER referenced a Spark/KQL
 *     helper. Population membership comes from the helper reference; such a
 *     file is found by triage, then listed. The list's floor is enforced (a
 *     listed file cannot leave), its ceiling is not.
 *   - which engine a given escapeSqlLiteral call FEEDS. Within a listed file the
 *     count is exact, so a site moved from a T-SQL branch to a Spark branch at
 *     an unchanged count is invisible; the per-site statement-text tests under
 *     apps/fiab-console/**\/__tests__ are what pin each site's output.
 *   - a dialect-less quoteLiteral/escapeLiteralFor whose single argument itself
 *     contains a call or comma (`quoteLiteral(a.trim())`). The one-argument
 *     shape is matched textually.
 *
 * SCOPE: apps/fiab-console/lib and apps/fiab-console/app, .ts and .tsx, tests
 * excluded; lib/sql/quoting.ts (the definitions) excluded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeOnly } from './_code-only.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const LIST_PATH = path.join(__dirname, 'sql-literal-dialect-sites.json');
const CONSOLE_REL = 'apps/fiab-console';
const SCAN_ROOTS = ['lib', 'app'];
export const DEFINITION_FILE = 'apps/fiab-console/lib/sql/quoting.ts';

export const ENGINES = ['spark', 'kql', 'mixed'];

/** T-SQL-rule escape shapes, applied to comment-masked source. */
export const TSQL_ESCAPE_SHAPES = [
  { name: 'escapeSqlLiteral(', re: /(?<![\w$.])escapeSqlLiteral\s*\(/g },
  { name: "inline .replace(/'/g, \"''\")", re: /\.replace\(\s*\/'\/g\s*,\s*(?:"''"|`''`)\s*\)/g },
  { name: 'quoteLiteral(x) without a dialect', re: /(?<![\w$.])quoteLiteral\s*\(\s*[^,()]*\)/g },
  { name: 'escapeLiteralFor(x) without a dialect', re: /(?<![\w$.])escapeLiteralFor\s*\(\s*[^,()]*\)/g },
];

/**
 * A reference that makes a file part of the must-be-listed population.
 * escapeLiteralFor is included because it is the dialect switch that reaches
 * the Spark rule (`'databricks-sql'`); without it, a file that only routes
 * through the switch could leave the list unnoticed.
 */
export const SPARK_KQL_HELPER_RE = /(?<![\w$])(?:escapeSparkSqlLiteral|escapeKqlLiteral|escapeLiteralFor)(?![\w$])/;
/** A reference that makes a file dialect-aware (listed if it also holds a T-SQL escape). */
export const DIALECT_AWARE_RE =
  /(?<![\w$])(?:escapeSparkSqlLiteral|escapeKqlLiteral|escapeLiteralFor|kqlEscapeSingle|kqlEscapeDouble|kqlVerbatimSingle|kqlVerbatimDouble)(?![\w$])|['"]@\/lib\/azure\/kql-escape['"]/;

/** Per engine: the helper reference a listed file must keep. */
export const ENGINE_HELPER_RE = {
  spark: /(?<![\w$])(?:escapeSparkSqlLiteral|escapeLiteralFor)(?![\w$])/,
  kql: /(?<![\w$])(?:escapeKqlLiteral|kqlEscapeSingle|kqlEscapeDouble|kqlVerbatimSingle|kqlVerbatimDouble)(?![\w$])/,
  mixed: /(?<![\w$])(?:escapeSparkSqlLiteral|escapeLiteralFor|escapeKqlLiteral|kqlEscapeSingle|kqlEscapeDouble|kqlVerbatimSingle|kqlVerbatimDouble)(?![\w$])/,
};

/** Count T-SQL-rule escapes in executable code (comments masked). */
export function countTsqlEscapes(src) {
  const code = codeOnly(src);
  const byShape = {};
  let total = 0;
  for (const s of TSQL_ESCAPE_SHAPES) {
    const n = (code.match(s.re) || []).length;
    if (n) byShape[s.name] = n;
    total += n;
  }
  return { total, byShape };
}

function validEntry(e) {
  return e && typeof e.path === 'string' && e.path.length > 0
    && ENGINES.includes(e.engine)
    && Number.isInteger(e.tsqlEscapeAllowance) && e.tsqlEscapeAllowance >= 0
    && typeof e.reason === 'string' && e.reason.trim().length > 0;
}

/**
 * Pure evaluation.
 * @param {{ sites: Array<{path:string,engine:string,tsqlEscapeAllowance:number,reason:string}> }} list
 * @param {Map<string,string>} files repo-relative POSIX path -> source, for every
 *   scanned file (the definition file and tests already excluded).
 * @returns {Array<{kind:string,path:string,detail:string}>}
 */
export function evaluate(list, files) {
  const v = [];
  const sites = Array.isArray(list?.sites) ? list.sites : [];
  if (sites.length === 0) {
    v.push({ kind: 'empty-list', path: 'scripts/ci/sql-literal-dialect-sites.json', detail: 'no sites listed — the guard would watch nothing' });
  }
  const listed = new Map();
  for (const e of sites) {
    if (!validEntry(e)) {
      v.push({ kind: 'bad-entry', path: String(e?.path ?? '?'), detail: 'needs path, engine (spark|kql|mixed), integer tsqlEscapeAllowance >= 0, and a reason' });
      continue;
    }
    if (listed.has(e.path)) {
      v.push({ kind: 'duplicate-entry', path: e.path, detail: 'listed more than once' });
      continue;
    }
    listed.set(e.path, e);
  }

  for (const [p, e] of listed) {
    const src = files.get(p);
    if (src === undefined) {
      v.push({ kind: 'missing-file', path: p, detail: 'listed but not found in the scanned tree (renamed? update the list)' });
      continue;
    }
    const code = codeOnly(src);
    if (!ENGINE_HELPER_RE[e.engine].test(code)) {
      v.push({ kind: 'no-dialect-helper', path: p, detail: `engine=${e.engine} but no ${e.engine === 'kql' ? 'KQL' : e.engine === 'spark' ? 'Spark SQL' : 'Spark SQL or KQL'} literal helper is referenced` });
    }
    const { total, byShape } = countTsqlEscapes(src);
    if (total > e.tsqlEscapeAllowance) {
      v.push({ kind: 'over-allowance', path: p, detail: `${total} T-SQL-rule escapes, allowance ${e.tsqlEscapeAllowance} ${JSON.stringify(byShape)} — use escapeSparkSqlLiteral / escapeKqlLiteral for a Spark or KQL literal, or raise the allowance with the T-SQL engine named in reason` });
    } else if (total < e.tsqlEscapeAllowance) {
      v.push({ kind: 'under-allowance', path: p, detail: `${total} T-SQL-rule escapes, allowance ${e.tsqlEscapeAllowance} — lower the allowance to ${total}` });
    }
  }

  for (const [p, src] of files) {
    if (listed.has(p)) continue;
    const code = codeOnly(src);
    if (SPARK_KQL_HELPER_RE.test(code)) {
      v.push({ kind: 'unlisted-spark-kql', path: p, detail: 'references escapeSparkSqlLiteral / escapeKqlLiteral / escapeLiteralFor but is not listed' });
      continue;
    }
    if (DIALECT_AWARE_RE.test(code)) {
      const { total, byShape } = countTsqlEscapes(src);
      if (total > 0) {
        v.push({ kind: 'unlisted-tsql-escape', path: p, detail: `dialect-aware file with ${total} T-SQL-rule escapes ${JSON.stringify(byShape)} and no list entry` });
      }
    }
  }
  return v;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Read every in-scope file under `repoRoot` into a path -> source map. */
export function loadFiles(repoRoot = REPO_ROOT) {
  const files = new Map();
  for (const r of SCAN_ROOTS) {
    for (const f of walk(path.join(repoRoot, CONSOLE_REL, r), [])) {
      const rel = path.relative(repoRoot, f).split(path.sep).join('/');
      if (rel === DEFINITION_FILE) continue;
      files.set(rel, fs.readFileSync(f, 'utf8'));
    }
  }
  return files;
}

function main() {
  // `--list <path>` reads an alternate list (used to run the unmodified guard
  // against a sandbox copy of the list); the default is the committed file.
  const at = process.argv.indexOf('--list');
  const listPath = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : LIST_PATH;
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const files = loadFiles();
  const violations = evaluate(list, files);
  const sites = Array.isArray(list.sites) ? list.sites : [];
  const allowanceSum = sites.reduce((n, e) => n + (Number.isInteger(e?.tsqlEscapeAllowance) ? e.tsqlEscapeAllowance : 0), 0);
  console.log(`[sql-literal-dialect] scanned ${files.size} console .ts/.tsx files; ${sites.length} listed Spark/KQL sites; T-SQL-rule allowance total ${allowanceSum}`);
  if (files.size === 0) {
    console.error('[sql-literal-dialect] FAIL — scanned 0 files; the scan roots moved or the checkout is incomplete.');
    process.exit(1);
  }
  if (violations.length) {
    console.error('\n[sql-literal-dialect] FAIL — literal escaping does not match the engine:');
    for (const x of violations) console.error(`  - [${x.kind}] ${x.path}: ${x.detail}`);
    console.error('\nSpark / Databricks SQL and KQL regular literals use backslash escapes');
    console.error('(escapeSparkSqlLiteral / escapeKqlLiteral in apps/fiab-console/lib/sql/quoting.ts);');
    console.error('quote doubling (escapeSqlLiteral) is the T-SQL rule. See the header of');
    console.error('scripts/ci/check-sql-literal-dialect.mjs and scripts/ci/sql-literal-dialect-sites.json.');
    process.exit(1);
  }
  console.log('[sql-literal-dialect] OK — every listed Spark/KQL file holds exactly its allowed T-SQL-rule escapes.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

#!/usr/bin/env node
/**
 * GUARDRAIL: sql-quoting  (merge-blocker)  — rel-T65
 * ------------------------------------------------------------------------
 * RULE (security-adjacent — SQL-injection surface):
 *   SQL identifier bracketing and string-literal single-quote doubling are
 *   the codebase's defence against SQL/KQL/DAX/OData injection. They were
 *   copy-pasted ~100 times (private `quoteIdent`/`bracket` variants + inline
 *   `x.replace(/'/g, "''")`). Every copy is a place the rule can silently
 *   diverge, so the escaping now lives in ONE audited module:
 *     apps/fiab-console/lib/sql/quoting.ts
 *       - escapeSqlLiteral(v)      — doubles `'` (SQL/KQL/DAX/OData literals)
 *       - quoteLiteral(v, dialect) — wraps + doubles
 *       - quoteIdent(name, dialect)/bracket(name) — per-dialect identifier quote
 *
 *   This guard forbids NEW inline copies of the two rules that were fully
 *   centralised (single-quote literal doubling + T-SQL `]`-bracket identifier
 *   doubling) anywhere under the server tree, so the surface can only shrink.
 *
 * SCOPE (server-side): every .ts under apps/fiab-console/lib and app/api
 *   EXCLUDES the client dirs (lib/editors, lib/panes, lib/components) — those
 *   are the sibling client sweep's domain — and .tsx files.
 *
 * WHAT IT FORBIDS:
 *   A) `.replace(/'/g, "''")`      — inline SQL string-literal doubling.
 *      Fix: import { escapeSqlLiteral } from '@/lib/sql/quoting' and call it
 *      (keep any surrounding `'…'` / `N'…'` wrap), or use quoteLiteral().
 *   B) `.replace(/]/g, ']]')`      — inline T-SQL bracket-identifier doubling.
 *      Fix: import { bracket } (or quoteIdent) from '@/lib/sql/quoting'.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY (ratchet):
 *   Only if a call site genuinely cannot delegate (e.g. a validating quoter
 *   that must throw its own errors before quoting, or a bare `]`-doubler whose
 *   caller supplies the brackets), add its repo-relative POSIX path to the
 *   matching ALLOWLIST_* map with a one-line reason. Prefer delegating to
 *   lib/sql/quoting.ts over allowlisting. NEVER allowlist a NEW `''` literal
 *   copy — that is the exact injection-surface regression this guard exists to
 *   stop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const SCAN_ROOTS = [path.join(CONSOLE_ROOT, 'lib'), path.join(CONSOLE_ROOT, 'app', 'api')];

// Client-owned dirs (sibling sweep) — POSIX, repo-relative prefixes.
const EXCLUDE_DIR_PREFIXES = [
  'apps/fiab-console/lib/editors/',
  'apps/fiab-console/lib/panes/',
  'apps/fiab-console/lib/components/',
];

// The module that DEFINES the helpers legitimately contains the raw rules.
const DEFINITION_FILE = 'apps/fiab-console/lib/sql/quoting.ts';

// RULE A — single-quote literal doubling. NO allowlist: every server copy was
// migrated; a new one is an injection-surface regression.
const LITERAL_RE = /\.replace\(\/'\/g,\s*"''"\)/g;
const ALLOWLIST_LITERAL = new Map([]);

// RULE B — T-SQL bracket identifier doubling.
const BRACKET_RE = /\.replace\(\/\]\/g,\s*'\]\]'\)/g;
const ALLOWLIST_BRACKET = new Map([
  // Validating bracket() that length/NUL/empty-checks then doubles — its throw
  // contract lives with the doubling; central bracket() does not validate.
  ['apps/fiab-console/lib/sql/tsql-builders.ts', 'validating bracket() — throws before quoting; central quoteIdent does not validate'],
  // Bare `]`-doubler: caller supplies the surrounding [ ] itself, so this is
  // not a full bracket() and cannot delegate 1:1.
  ['apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/clone/route.ts', 'bare "]"-doubler; caller adds the brackets'],
  ['apps/fiab-console/app/api/items/warehouse/[id]/query-acceleration/route.ts', 'bare "]"-doubler; caller adds the brackets'],
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(full, out);
    } else if (e.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(root, files);

  const violations = [];
  let scanned = 0;

  for (const f of files) {
    const r = rel(f);
    if (r === DEFINITION_FILE) continue;
    if (EXCLUDE_DIR_PREFIXES.some((p) => r.startsWith(p))) continue;
    scanned++;
    const src = fs.readFileSync(f, 'utf8');

    if (!ALLOWLIST_LITERAL.has(r)) {
      LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = LITERAL_RE.exec(src)) !== null) {
        violations.push({ file: r, line: lineOf(src, m.index), rule: "A: inline '' literal doubling", fix: "import { escapeSqlLiteral } from '@/lib/sql/quoting'" });
      }
    }
    if (!ALLOWLIST_BRACKET.has(r)) {
      BRACKET_RE.lastIndex = 0;
      let m;
      while ((m = BRACKET_RE.exec(src)) !== null) {
        violations.push({ file: r, line: lineOf(src, m.index), rule: "B: inline ']]' bracket-ident doubling", fix: "import { bracket } from '@/lib/sql/quoting'" });
      }
    }
  }

  console.log(`[sql-quoting] scanned ${scanned} server .ts files under lib/ + app/api/`);
  console.log(`[sql-quoting] allowlisted: literal=${ALLOWLIST_LITERAL.size}, bracket=${ALLOWLIST_BRACKET.size}`);
  if (violations.length) {
    console.error('\n[sql-quoting] FAIL — inline SQL quoting found (centralise in lib/sql/quoting.ts):');
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  [${v.rule}]  → ${v.fix}`);
    console.error('\nWhy: identifier/literal quoting is the SQL-injection defence and must live in');
    console.error('ONE audited place (apps/fiab-console/lib/sql/quoting.ts). Delegate to it. If a');
    console.error('site genuinely cannot (validating quoter / bare doubler), add it to the matching');
    console.error('ALLOWLIST in scripts/ci/check-sql-quoting.mjs with a reason — but NEVER a new "" copy.');
    process.exit(1);
  }
  console.log('[sql-quoting] OK — no new inline SQL quoting outside lib/sql/quoting.ts.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

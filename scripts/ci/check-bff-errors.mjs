#!/usr/bin/env node
/**
 * GUARDRAIL: bff-errors  (merge-blocker)  — rel-T66
 * ------------------------------------------------------------------------
 * RULE (security posture — do NOT leak exception text on 500):
 *   BFF 500 responses must not echo raw exception text (e.message / String(e)
 *   / (e as Error).message / a template embedding them) to the client — that
 *   can surface stack traces, SQL, connection strings, and internal paths.
 *   Internal errors go through the shared `apiServerError(err[, publicMessage
 *   [, code]])` from lib/api/respond.ts, which logs the detail server-side
 *   (console.error) and returns a SAFE generic message + stable code.
 *
 *   The BFF error ENVELOPE is likewise unified: routes use the shared
 *   `apiError` / `apiServerError` (or a thin helper that delegates to them),
 *   never a hand-rolled `function err/jerr(...) { return NextResponse.json({
 *   ok: false, ... }) }` that can drift from the shared shape.
 *
 * SCOPE: every .ts under apps/fiab-console/app/api  (RULES 1-2)
 *        every source file of a STANDALONE HTTP-server app under apps/*  (RULE 3)
 *
 * WHAT IT FORBIDS:
 *   RULE 1  Raw exception text in a LITERAL-500 response:
 *             NextResponse.json({ ... error: <exc>.message|String(<exc>)|
 *               (<exc> as Error).message ... }, { status: 500 })
 *             apiError(<exc-text>, 500) / err(<exc-text>, 500) / jerr(<exc-text>, 500)
 *           Fix: return apiServerError(<exc>[, 'public message'[, 'code']]);
 *           (upstream 4xx/502 passthroughs and dynamic `e?.status || 5xx`
 *            statuses are out of scope — only the literal-500 internal case.)
 *   RULE 2  A NEW local raw-envelope helper:
 *             function err|jerr(error: string, ...) { ... NextResponse.json({ ok: false, ... }) }
 *           Fix: delete it and use apiError from '@/lib/api/respond' (a thin
 *           delegating shim that CALLS apiError is fine — this only bans bodies
 *           that build the envelope with NextResponse.json directly).
 *   RULE 3  Exception text stringified inside an error handler in a STANDALONE
 *           HTTP-server app (apps/copilot-maf, apps/fiab-mcp-bridge,
 *           apps/loom-onelake, and any future sibling — discovered, not listed):
 *             catch (e) { ... e.message / e?.message / e.stack / String(e) /
 *                             `${e}` / e.toString() ... }
 *             .catch((e) => { ... same ... })
 *           Fix: `publicErrorMessage(e, '<literal public message>')` from the
 *           app's own src/safe-error.{ts,mjs} — it logs the detail server-side
 *           against a correlation ref and returns the LITERAL you passed.
 *
 * WHY RULE 3 EXISTS AND WHY IT IS SCOPED THE WAY IT IS
 *   RULES 1-2 were correct and enforced — and they only ever looked at
 *   apps/fiab-console/app/api. `apiServerError` (lib/api/respond.ts) is
 *   Next-only (it imports `next/server`), so the three sibling apps that also
 *   answer HTTP requests could not adopt it and nothing checked them. CodeQL
 *   js/stack-trace-exposure #591 + #505 found two of them; a third
 *   (loom-onelake `registry lookup failed: ${e.message}`, a Cosmos exception
 *   carrying the account endpoint + RBAC diagnostic + activity id) it never
 *   flagged at all. That is the recurring shape in this repo: a correct guard
 *   that never looked at the siblings. RULE 3 makes the SHAPE fail CI in every
 *   standalone HTTP app, discovered automatically, so a new one is covered on
 *   the day it is added rather than on the day a scanner happens to model it.
 *
 *   RULE 3 has NO allowlist by design. The sanitizer module itself
 *   (src/safe-error.{ts,mjs}) is the single exempt file — it is where reading
 *   `err.stack` is the whole point. Anything else that "needs" the raw text
 *   needs it in a log line, and the log line lives in the sanitizer.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY (ratchet):
 *   RULE 1 has NO allowlist — a new raw-500 leak is exactly the regression this
 *   guards. For RULE 2, a genuinely bespoke multi-field helper that cannot yet
 *   delegate may be added to ALLOWLIST_HELPERS with a reason — but prefer
 *   migrating it to apiError. RULE 3 has NO allowlist (see above).
 *
 * HONEST-GATE PASSTHROUGH (not a leak): some thrown errors are documented,
 *   user-actionable honest gates that no-vaporware.md REQUIRES surfacing
 *   verbatim — a permission message ("caller lacks Log Analytics Reader"), a
 *   cloud-availability gate ("Microsoft Fabric has no GCC-High endpoint"), a
 *   *NotConfiguredError. Route these through `apiHonestError(err, status)` from
 *   lib/api/respond.ts (only for errors your OWN code throws as honest gates —
 *   typed gate/permission classes, assertFabricFamilyAvailable — never raw
 *   driver exceptions). This guard does NOT flag apiHonestError: it is the
 *   sanctioned, reviewed passthrough. Raw `.message` on a literal-500 is still
 *   forbidden (RULE 1) — the distinction is intent + the deliberate helper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console', 'app', 'api');
const APPS_ROOT = path.join(REPO_ROOT, 'apps');

// RULE 3 — apps whose HTTP surface is Next.js (covered by RULES 1-2 instead).
const RULE3_SKIP_APPS = new Set(['fiab-console']);
// RULE 3 — the sanitizer module is the ONE place reading err.stack is correct.
const RULE3_SANITIZER = /(?:^|\/)safe-error\.(?:ts|mjs|js)$/;
// RULE 3 — a file that stands up an HTTP listener marks its app as in-scope.
const HTTP_SERVER_RE = /\bcreateServer\s*\(|\.listen\s*\(/;
const RULE3_EXT = /\.(?:ts|mts|cts|mjs|cjs|js)$/;
const RULE3_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'tests', '__tests__', 'e2e', 'test']);

// Exception-bearing error text (a caught var's message / String / cast).
const EXC = String.raw`(?:\b(?:e|err|error|ex)\)?\??\.message\b|String\(\s*(?:e|err|error|ex)\s*\)|\(\s*(?:e|err|error|ex)\s+as\s+\w+\s*\)\s*\??\.message)`;
// A `return <stmt>;` that produces a literal-500 response (NextResponse or call form).
const RET_500 = /return\s+(NextResponse\.json\([^\n]*?\{\s*status:\s*500\s*\}\)|(?:apiError|err|jerr)\([^\n]*?,\s*500\));/g;
const EXC_RE = new RegExp(EXC);

// RULE 2 allowlist — bespoke multi-field envelope helpers not yet migrated.
const ALLOWLIST_HELPERS = new Map([
  ['apps/fiab-console/app/api/items/[type]/[id]/business-metadata/route.ts', 'code + extra spread'],
  ['apps/fiab-console/app/api/items/[type]/[id]/classifications/route.ts', 'code + extra spread'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sensitivity-label/route.ts', 'code + extra spread'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sensitivity/route.ts', 'code + extra spread'],
  ['apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts', 'error + hint field'],
  ['apps/fiab-console/app/api/items/notebook/[id]/run/route.ts', 'error + hint field'],
  ['apps/fiab-console/app/api/items/ontology-sdk/[id]/publish/route.ts', 'error + code + gate spread'],
  ['apps/fiab-console/app/api/items/ontology/[id]/links/route.ts', 'error + code + gate spread'],
  ['apps/fiab-console/app/api/items/ontology/[id]/objects/route.ts', 'error + code + gate spread'],
  ['apps/fiab-console/app/api/items/ontology/[id]/run-action/route.ts', 'error + code + gate spread'],
  ['apps/fiab-console/app/api/items/ontology/[id]/sync/route.ts', 'error + code + gate spread'],
  ['apps/fiab-console/app/api/items/workshop-app/[id]/run-action/route.ts', 'error + code + gate spread'],
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

// Brace-balanced body extractor (string-aware) for RULE 2.
function matchBrace(s, i) {
  let d = 0;
  let q = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && s[i - 1] !== '\\') q = null;
    } else if (c === '"' || c === "'" || c === '`') {
      q = c;
    } else if (c === '{') {
      d++;
    } else if (c === '}') {
      if (--d === 0) return i + 1;
    }
  }
  return -1;
}

const HELPER_RE = /(?:export\s+)?function\s+(err|jerr)\s*\(\s*error\s*:\s*string/g;

// ─────────────────────────── RULE 3 ────────────────────────────────────────

/**
 * Replace comment bodies and '…' / "…" string contents with spaces, preserving
 * every character position (so line numbers and brace math stay aligned).
 * Template literals are LEFT INTACT: `${e.message}` is a violation we must be
 * able to see, and their `${}` braces are balanced so brace counting survives.
 */
export function maskNonCode(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? src.length : j + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Every error-handler block in `masked`, as { binding, start, end } index
 * ranges. Covers the two shapes these apps use:
 *   catch (e) { … }            / catch (e: any) { … }
 *   .catch((e) => { … })       / .catch(e => { … })
 * A `catch { … }` with no binding is not a handler we can check (there is no
 * error value in scope to leak) and is skipped.
 */
export function errorHandlerBlocks(masked) {
  const blocks = [];
  const re = /\bcatch\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)=]+)?\)?\s*(?:=>)?/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const brace = masked.indexOf('{', m.index + m[0].length);
    if (brace < 0) continue;
    // Guard against latching onto a `{` far away (an arrow with an expression
    // body, e.g. `.catch(() => null)`): the block must open on the same or the
    // next few characters, allowing only whitespace / `)` / `=>` between.
    if (/[^\s)=>]/.test(masked.slice(m.index + m[0].length, brace))) continue;
    const end = matchBrace(masked, brace);
    if (end < 0) continue;
    blocks.push({ binding: m[1], start: brace, end });
  }
  return blocks;
}

/** The forbidden string-extraction shapes for a catch binding named `id`. */
function extractionPatterns(id) {
  // FULL regex escape, not just `$`. `id` comes from a JS-identifier capture so
  // today it can only be [A-Za-z_$][\w$]*, but a partial escape is the shape
  // CodeQL js/incomplete-sanitization flags and the shape that breaks the day
  // the capture is widened — escape every metacharacter, backslash included.
  const X = id.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  return [
    [new RegExp(String.raw`\b${X}\s*(?:\?\.|\.)\s*(?:message|stack)\b`, 'g'), `${id}.message / ${id}.stack`],
    [new RegExp(String.raw`\(\s*${X}\s+as\s+\w+\s*\)\s*\??\.\s*(?:message|stack)\b`, 'g'), `(${id} as Error).message`],
    [new RegExp(String.raw`\bString\s*\(\s*${X}\s*\)`, 'g'), `String(${id})`],
    [new RegExp(String.raw`\bJSON\.stringify\s*\(\s*${X}\s*[,)]`, 'g'), `JSON.stringify(${id})`],
    [new RegExp(String.raw`\$\{\s*${X}\s*\}`, 'g'), '`${' + id + '}`'],
    [new RegExp(String.raw`\b${X}\s*(?:\?\.|\.)\s*toString\s*\(`, 'g'), `${id}.toString()`],
  ];
}

/** Apps under apps/* that stand up their own (non-Next) HTTP listener. */
export function standaloneHttpApps(appsRoot = APPS_ROOT) {
  const apps = [];
  let entries;
  try {
    entries = fs.readdirSync(appsRoot, { withFileTypes: true });
  } catch {
    return apps;
  }
  for (const e of entries) {
    if (!e.isDirectory() || RULE3_SKIP_APPS.has(e.name)) continue;
    const dir = path.join(appsRoot, e.name);
    const files = walkSource(dir);
    if (!files.length) continue;
    const hasServer = files.some((f) => {
      try {
        return HTTP_SERVER_RE.test(fs.readFileSync(f, 'utf8'));
      } catch {
        return false;
      }
    });
    if (hasServer) apps.push({ name: e.name, dir, files });
  }
  return apps;
}

function walkSource(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (RULE3_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkSource(full, out);
    } else if (RULE3_EXT.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name) && !/\.test\.[cm]?[jt]s$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * RULE 3 violations in one source file. Exported so the self-test can drive it
 * on fixtures instead of on the real tree.
 */
export function rule3Violations(relPath, src) {
  if (RULE3_SANITIZER.test(relPath)) return [];
  const masked = maskNonCode(src);
  const found = [];
  for (const block of errorHandlerBlocks(masked)) {
    const body = masked.slice(block.start, block.end);
    for (const [re, label] of extractionPatterns(block.binding)) {
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(body)) !== null) {
        found.push({ line: lineOf(src, block.start + hit.index), shape: label });
      }
    }
  }
  return found;
}

function main() {
  const files = walk(API_ROOT);
  const violations = [];
  for (const f of files) {
    const r = rel(f);
    const src = fs.readFileSync(f, 'utf8');

    // RULE 1 — raw exception text in a literal-500 return.
    RET_500.lastIndex = 0;
    let m;
    while ((m = RET_500.exec(src)) !== null) {
      if (EXC_RE.test(m[1])) {
        violations.push({ file: r, line: lineOf(src, m.index), rule: 'R1 raw exception text on 500', fix: 'return apiServerError(e[, publicMessage[, code]])' });
      }
    }

    // RULE 2 — new raw-envelope err/jerr helper (unless allowlisted).
    if (!ALLOWLIST_HELPERS.has(r)) {
      HELPER_RE.lastIndex = 0;
      let h;
      while ((h = HELPER_RE.exec(src)) !== null) {
        const brace = src.indexOf('{', h.index + h[0].length);
        if (brace < 0) continue;
        const end = matchBrace(src, brace);
        if (end < 0) continue;
        const body = src.slice(brace, end);
        if (/NextResponse\.json\(\s*\{\s*ok:\s*false/.test(body)) {
          violations.push({ file: r, line: lineOf(src, h.index), rule: `R2 raw-envelope ${h[1]}() helper`, fix: "delegate to apiError from '@/lib/api/respond'" });
        }
      }
    }
  }

  // RULE 3 — standalone (non-Next) HTTP-server apps: no exception text in an
  // error handler. These cannot import lib/api/respond.ts (it is Next-only),
  // so each carries its own src/safe-error.{ts,mjs} with the same contract.
  const apps = standaloneHttpApps();
  let r3Files = 0;
  for (const app of apps) {
    for (const f of app.files) {
      r3Files++;
      const r = rel(f);
      const hits = rule3Violations(r, fs.readFileSync(f, 'utf8'));
      for (const h of hits) {
        violations.push({
          file: r,
          line: h.line,
          rule: `R3 exception text in an error handler (${h.shape})`,
          fix: `publicErrorMessage(<err>, '<literal public message>') from apps/${app.name}/src/safe-error`,
        });
      }
    }
  }

  console.log(`[bff-errors] scanned ${files.length} .ts files under app/api/`);
  console.log(`[bff-errors] allowlisted raw-envelope helpers: ${ALLOWLIST_HELPERS.size}`);
  console.log(`[bff-errors] R3 standalone HTTP apps: ${apps.map((a) => a.name).join(', ') || '(none)'} (${r3Files} source files)`);
  if (violations.length) {
    console.error('\n[bff-errors] FAIL:');
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  [${v.rule}]  → ${v.fix}`);
    console.error('\nWhy: 500s must not leak exception text (stack/SQL/conn-strings), and the BFF');
    console.error('error envelope is unified on apiError/apiServerError (lib/api/respond.ts).');
    console.error('R1 and R3 have no allowlist. For a truly bespoke R2 helper, add it to');
    console.error('ALLOWLIST_HELPERS in scripts/ci/check-bff-errors.mjs with a reason — but');
    console.error('prefer delegating to apiError.');
    process.exit(1);
  }
  console.log('[bff-errors] OK — no raw-500 leaks; no new raw-envelope helpers; no standalone-app exception leaks.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

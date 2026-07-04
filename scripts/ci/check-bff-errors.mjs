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
 * SCOPE: every .ts under apps/fiab-console/app/api
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
 *
 * HOW TO ADD AN ALLOWLIST ENTRY (ratchet):
 *   RULE 1 has NO allowlist — a new raw-500 leak is exactly the regression this
 *   guards. For RULE 2, a genuinely bespoke multi-field helper that cannot yet
 *   delegate may be added to ALLOWLIST_HELPERS with a reason — but prefer
 *   migrating it to apiError.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console', 'app', 'api');

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

  console.log(`[bff-errors] scanned ${walk(API_ROOT).length} .ts files under app/api/`);
  console.log(`[bff-errors] allowlisted raw-envelope helpers: ${ALLOWLIST_HELPERS.size}`);
  if (violations.length) {
    console.error('\n[bff-errors] FAIL:');
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  [${v.rule}]  → ${v.fix}`);
    console.error('\nWhy: 500s must not leak exception text (stack/SQL/conn-strings), and the BFF');
    console.error('error envelope is unified on apiError/apiServerError (lib/api/respond.ts).');
    console.error('R1 has no allowlist. For a truly bespoke R2 helper, add it to ALLOWLIST_HELPERS');
    console.error('in scripts/ci/check-bff-errors.mjs with a reason — but prefer delegating to apiError.');
    process.exit(1);
  }
  console.log('[bff-errors] OK — no raw-500 leaks; no new raw-envelope helpers.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

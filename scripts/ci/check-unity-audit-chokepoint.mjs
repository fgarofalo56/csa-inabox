#!/usr/bin/env node
/**
 * GUARDRAIL: unity-audit-chokepoint  (merge-blocker — loom-apex LU-3)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   EVERY Unity Catalog REST call the Console BFF makes must go through an
 *   AUDITED transport whose `finally` writes the WHO / WHAT / WHEN / OUTCOME
 *   (including DENIALS) row to the Cosmos `_auditLog` trail and the
 *   `LoomAudit_CL` SIEM stream. There are exactly TWO such transports:
 *
 *     apps/fiab-console/lib/azure/unity-catalog-client.ts  →  ucFetch
 *         the backend-agnostic client (Loom Unity / OSS UC in Gov, Databricks
 *         UC in Commercial). Records via `recordUnityAccess(...)`.
 *     apps/fiab-console/lib/azure/databricks-client.ts     →  dbxFetch
 *         the Databricks workspace client. The Commercial DEFAULT routes call
 *         it DIRECTLY for catalog owner change (patchUcCatalog), catalog delete
 *         (deleteUcCatalog) and grant mutation (updateUcPermissions —
 *         `PATCH /api/2.1/unity-catalog/permissions/...`). Records via
 *         `recordDatabricksUnityAccess(...)`, which filters to catalog paths.
 *
 * WHY A GUARD AND NOT JUST A COMMENT:
 *   An audit choke point is only a choke point if bypassing it is HARD. A
 *   convention ("please call ucFetch") silently degrades the first time someone
 *   adds `fetch(process.env.LOOM_UNITY_URL + '/api/2.1/...')` to a new route —
 *   and an audit trail with a hole in it is worse than none, because it is
 *   trusted. This guard turns that mistake into a red build.
 *
 * ## HISTORY — why this file was rewritten (2026-07-28 adversarial review)
 *
 * The first version of this guard PASSED three demonstrated bypasses, which is
 * worse than having no guard because the docs asserted coverage:
 *
 *   1. Its "recordUnityAccess is inside the ucFetch finally" check was
 *      `src.indexOf('} finally {')` followed by `src.slice(idx).includes(...)`
 *      — a substring test over the remaining ~2600 lines of the file. Gutting
 *      the real finally and leaving one decoy `recordUnityAccess({} as never)`
 *      500 lines below passed. FIXED: the check now brace-matches the named
 *      function body, then brace-matches each `finally` block INSIDE it, and
 *      requires the recorder call to be inside one of those blocks (comments and
 *      string literals masked first, so a mention in a doc comment cannot
 *      satisfy it).
 *   2. Its bypass scan only recognised OSS addresses
 *      (`/LOOM_UNITY_URL|ossUcBase\(/`), so an unaudited
 *      `PATCH /api/2.1/unity-catalog/permissions/... {add:['ALL_PRIVILEGES']}`
 *      appended to databricks-client.ts — a privilege grant on the backend
 *      ~every Commercial estate runs — exited 0. FIXED: `UNITY_ADDRESS_RE` now
 *      also matches a Unity Catalog REST path literal, so a Databricks-side
 *      bypass trips the same wire.
 *   3. It said nothing about the ~25 `executeStatement(` exits in
 *      unity-catalog-client.ts (Databricks SQL Statement Execution — a
 *      DIFFERENT API from UC REST, including governance DDL:
 *      createUcPolicy/dropUcPolicy/mutateUcGovernedTag/setUcTags). Those are
 *      genuinely NOT covered by this trail. They are now RATCHETED: the count
 *      may go DOWN (each one routed through an audited path) but never UP.
 *
 * THE CHECKS
 *   1. INTEGRITY (ucFetch)   — `recordUnityAccess(` inside a `finally` block of
 *      `ucFetch`, and the import from lib/azure/unity-audit is present.
 *   2. SINGLE EXIT           — `unity-catalog-client.ts` may contain at most ONE
 *      outbound call. A second one is a second, un-audited door out.
 *   3. INTEGRITY (dbxFetch)  — `recordDatabricksUnityAccess(` inside a `finally`
 *      block of `dbxFetch`.
 *   4. NO BYPASS             — no file outside the ALLOWLIST may combine a Loom
 *      Unity address OR a Unity Catalog REST path with outbound-request code.
 *      Reading those for a GATE/CAPABILITY check is fine; issuing a REQUEST is not.
 *   5. ALLOWLISTED CALLERS MUST AUDIT.
 *   6. SINK REACHABILITY     — `unity-audit.ts` writes both sinks and still
 *      classifies denials.
 *   7. SQL-EXIT RATCHET      — `executeStatement(` count in
 *      unity-catalog-client.ts must not grow (see history #3).
 *
 * ALLOWLIST — a file that legitimately needs the catalog address AND makes
 *   requests must be added to CHOKEPOINT_FILES below WITH a justification, and
 *   must itself audit. Adding an entry is a security review, not a formality.
 *
 * MODE:
 *   node scripts/ci/check-unity-audit-chokepoint.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** The backend-agnostic catalog client — its ucFetch is the primary choke point. */
export const CHOKEPOINT = 'lib/azure/unity-catalog-client.ts';
/** The Databricks workspace client — its dbxFetch audits the UC REST subset. */
export const DBX_CHOKEPOINT = 'lib/azure/databricks-client.ts';
/** The recorder both choke points delegate to. */
export const RECORDER = 'lib/azure/unity-audit.ts';

/**
 * `executeStatement(` occurrences allowed in unity-catalog-client.ts.
 *
 * These are Databricks **SQL Statement Execution** calls, not UC REST, so they
 * do NOT produce a row in this trail — they are covered by Databricks'
 * `system.access.audit` instead. The count is frozen so a NEW un-audited SQL
 * exit fails the build. Lowering it (by routing a call through an audited path)
 * is always welcome; raising it requires a security review and a note here.
 * Tracked: audit the governance DDL half (createUcPolicy / dropUcPolicy /
 * mutateUcGovernedTag / setUcTags).
 */
export const SQL_EXIT_BASELINE = 25;

/**
 * Outbound calls allowed in databricks-client.ts.
 *
 * dbxFetch (the audited transport) + writeUcVolumesFile + deleteUcVolumesFile
 * (raw-body Files-API writes to `/api/2.0/fs/files`, NOT catalog calls). Frozen
 * so that appending a raw `fetch(https://host/api/2.1/unity-catalog/permissions/...)`
 * to this file — the exact bypass demonstrated against the first version of this
 * guard — fails the build. The file IS allowlisted from the no-bypass scan
 * (it must be: it holds dbxFetch), so this counter is what protects it.
 */
export const DBX_OUTBOUND_BASELINE = 3;

/**
 * Files permitted to reference a catalog address / UC REST path alongside
 * request-shaped code. Each entry needs a reason; each must remain audited.
 */
export const CHOKEPOINT_FILES = new Map([
  [CHOKEPOINT, 'THE choke point — its single fetchWithTimeout is wrapped by recordUnityAccess in a finally block.'],
  [DBX_CHOKEPOINT, 'The Databricks workspace client. Its dbxFetch finally calls recordDatabricksUnityAccess, which audits the /api/2.x/unity-catalog/** subset (catalog owner change, catalog delete, grant mutation).'],
  [RECORDER, 'The recorder. Writes the audit sinks; issues no catalog requests.'],
  ['lib/azure/uc-backend.ts', 'Resolves the backend + base URL + credential. Builds no request of its own.'],
  [
    'lib/admin/health-probes.ts',
    'probe-loom-unity-authz (LU-2) sends ONE deliberately UNAUTHENTICATED read to prove the catalog rejects '
    + 'anonymous callers — routing it through the credentialed ucFetch would defeat the test. It records its own '
    + 'audit row via recordUnityAuthzProbe(), which is asserted below.',
  ],
  [
    'lib/azure/dq-monitor-client.ts',
    'Lakehouse Monitoring keeps its own Databricks transport (it predates the shared one). Two of its calls are '
    + 'UC REST reads (tables/schemas get) used to resolve a monitored table; its dbxFetch finally now records them '
    + 'via recordDatabricksUnityAccess, which ignores the quality-monitor paths.',
  ],
  [
    'lib/azure/iceberg-catalog-client.ts',
    'listNamespaceGrants issues a REAL UC grant read (GET /api/2.1/unity-catalog/permissions/schema/{full}) against '
    + 'the IRC server with the Iceberg auth header — it cannot use the Databricks-credentialed ucFetch. It records '
    + 'its own row via recordDatabricksUnityAccess on both the success and the unreachable path.',
  ],
]);

/**
 * Files in CHOKEPOINT_FILES that call the catalog (rather than merely resolving
 * its address) must still produce an audit row. Symbol each one must contain.
 */
export const MUST_AUDIT = new Map([
  ['lib/admin/health-probes.ts', 'recordUnityAccess'],
  [DBX_CHOKEPOINT, 'recordDatabricksUnityAccess'],
  ['lib/azure/dq-monitor-client.ts', 'recordDatabricksUnityAccess'],
  ['lib/azure/iceberg-catalog-client.ts', 'recordDatabricksUnityAccess'],
]);

/**
 * KNOWN, DECLARED GAPS — files that reach Unity Catalog outside an audited
 * transport and are NOT yet fixed. This list exists so the hole is LOUD instead
 * of invisible: the guard prints every entry on a passing run, and FAILS if a
 * file joins the list without being declared here (the ratchet). It is not an
 * excuse list — every entry names the issue tracking its removal.
 *
 * An entry here is strictly worse than an entry in CHOKEPOINT_FILES. Removing
 * one (by adding the recorder) is always in scope.
 */
export const KNOWN_UNAUDITED = new Map([
  [
    'lib/azure/shortcut-credentials.ts',
    'Its own private ucFetch issues storage-credential + external-location CREATE/DELETE '
    + '(POST/DELETE /api/2.1/unity-catalog/storage-credentials|external-locations) with NO audit row. '
    + 'Found by this guard on 2026-07-28; the file sits under a repo-level credential-path write deny, '
    + 'so the recorder has to be added by someone with write access to it. TRACKED: issue #2622.',
  ],
]);

/** Directories scanned for bypasses. */
const SCAN_DIRS = [
  path.join(APP_ROOT, 'lib'),
  path.join(APP_ROOT, 'app'),
  path.join(APP_ROOT, 'scripts'),
];

/**
 * A catalog address appearing in a file — the OSS / Loom Unity address. Applies
 * to EVERY scanned file.
 */
export const UNITY_ADDRESS_RE = /\bLOOM_UNITY_URL\b|\bossUcBase\s*\(/;
/**
 * A Unity Catalog REST path literal — the Databricks side. Without this arm, a
 * hand-rolled `PATCH /api/2.1/unity-catalog/permissions/...` granting
 * ALL_PRIVILEGES on the Commercial default backend was invisible to the guard.
 *
 * Applies to SERVER modules only (`.ts` / `.mjs`). A `.tsx` component cannot
 * issue a catalog call — it holds no Databricks/Entra credential and its
 * `fetch` goes to the Loom BFF (governed by check-no-bare-client-fetch) — but
 * it legitimately PRINTS these paths as documentation (the UC dialogs tell the
 * operator which REST call each action makes, and which privilege it needs).
 */
export const UNITY_REST_PATH_RE = /\/api\/2\.\d+\/unity-catalog\/|\/api\/2\.\d+\/lineage-tracking\//;
/** Request-shaped code. */
export const REQUEST_RE = /\bfetchWithTimeout\s*\(|(?<![.\w])fetch\s*\(|\baxios\b|\bhttps?\.request\s*\(/;

/** True when the file names the catalog in a way that could address a request. */
export function referencesCatalogAddress(rel, src) {
  if (UNITY_ADDRESS_RE.test(src)) return true;
  return !/\.tsx$/.test(rel) && UNITY_REST_PATH_RE.test(src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Source analysis — brace-accurate, comment/string aware. Exported so the guard
// itself is unit-testable against synthetic bypasses (see
// apps/fiab-console/lib/azure/__tests__/unity-audit-guard.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace every comment and string/template literal with spaces of the SAME
 * length, so brace matching cannot be fooled by a `{` in a doc comment or a
 * template string, while every index still maps 1:1 onto the original source.
 */
export function maskCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of the `}` matching the `{` at `open` in `masked`. -1 when unbalanced. */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `{ start, end }` of the body of `function <name>` — or null when absent. */
export function functionBodyRange(masked, name) {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*[<(]`);
  const m = re.exec(masked);
  if (!m) return null;
  // Skip PAST the parameter list before looking for the body brace: a parameter
  // typed with an inline object literal (`init?: { method?: 'GET' }`) would
  // otherwise be mistaken for the function body.
  let i = m.index;
  let depth = 0;
  let seenParen = false;
  for (; i < masked.length; i++) {
    if (masked[i] === '(') { depth++; seenParen = true; }
    else if (masked[i] === ')') { depth--; if (seenParen && depth === 0) { i++; break; } }
  }
  const open = masked.indexOf('{', i);
  if (open < 0) return null;
  const close = matchBrace(masked, open);
  if (close < 0) return null;
  return { start: open, end: close };
}

/**
 * TRUE when `symbol(` is CALLED from inside a `finally { … }` block belonging to
 * `fnName`. This is the check the original guard only approximated with a
 * substring scan — the approximation passed a gutted finally with a decoy call
 * elsewhere in the file.
 */
export function callsSymbolInFinallyOf(src, fnName, symbol) {
  const masked = maskCommentsAndStrings(src);
  const body = functionBodyRange(masked, fnName);
  if (!body) return false;
  const region = masked.slice(body.start, body.end + 1);
  const finallyRe = /\bfinally\s*\{/g;
  const callRe = new RegExp(`\\b${symbol}\\s*\\(`);
  let m;
  while ((m = finallyRe.exec(region))) {
    const open = region.indexOf('{', m.index);
    const close = matchBrace(region, open);
    if (close < 0) continue;
    // Test against the MASKED text: a mention inside a comment or string is not
    // a call. Whitespace is preserved by the mask, so `foo (` still matches.
    if (callRe.test(region.slice(open, close + 1))) return true;
  }
  return false;
}

/** Count occurrences of `symbol(` in real code (comments/strings masked out). */
export function countCalls(src, symbol) {
  const masked = maskCommentsAndStrings(src);
  return (masked.match(new RegExp(`\\b${symbol}\\s*\\(`, 'g')) || []).length;
}

/**
 * The whole rule set, as a pure function over `{ relPath -> source }`.
 * Returns an array of failure strings (empty === pass).
 */
export function analyzeUnityChokepoint(sources, opts = {}) {
  const sqlBaseline = opts.sqlExitBaseline ?? SQL_EXIT_BASELINE;
  const failures = [];

  // ── 1 + 2 + 7. The ucFetch choke point ────────────────────────────────────
  const chokeSrc = sources.get(CHOKEPOINT);
  if (chokeSrc == null) {
    failures.push(`MISSING CHOKE POINT: ${CHOKEPOINT} does not exist. Every Unity Catalog call must funnel through its ucFetch.`);
  } else {
    if (!/from\s+['"]@\/lib\/azure\/unity-audit['"]/.test(chokeSrc)) {
      failures.push(`${CHOKEPOINT}: does not import from @/lib/azure/unity-audit — the audit choke point has been disconnected.`);
    }
    if (!callsSymbolInFinallyOf(chokeSrc, 'ucFetch', 'recordUnityAccess')) {
      failures.push(
        `${CHOKEPOINT}: recordUnityAccess( is not called from inside a \`finally\` block of ucFetch. ` +
        `Recording only on the success path drops every DENIED call — the highest-value audit row. ` +
        `(A call elsewhere in the file does NOT satisfy this check.)`,
      );
    }
    const masked = maskCommentsAndStrings(chokeSrc);
    const outbound = (masked.match(/\bfetchWithTimeout\s*\(/g) || []).length
      + (masked.match(/(?<![.\w])fetch\s*\(/g) || []).length;
    if (outbound > 1) {
      failures.push(
        `${CHOKEPOINT}: ${outbound} outbound calls found (expected exactly 1, inside ucFetch). ` +
        `A second exit is an un-audited door to the catalog — route it through ucFetch.`,
      );
    }
    const sqlExits = countCalls(chokeSrc, 'executeStatement');
    if (sqlExits > sqlBaseline) {
      failures.push(
        `${CHOKEPOINT}: ${sqlExits} executeStatement( exits (ratchet: ${sqlBaseline}). These reach the catalog over the ` +
        `Databricks SQL Statement Execution API and produce NO row in the Loom Unity audit trail. Route the new call ` +
        `through an audited path, or — if it genuinely must be raw SQL — raise SQL_EXIT_BASELINE in this guard with a ` +
        `security-review note. The count may go DOWN freely.`,
      );
    }
  }

  // ── 3. The dbxFetch choke point (the Commercial DEFAULT backend) ───────────
  const dbxSrc = sources.get(DBX_CHOKEPOINT);
  if (dbxSrc == null) {
    failures.push(`MISSING CHOKE POINT: ${DBX_CHOKEPOINT} does not exist.`);
  } else {
    if (!callsSymbolInFinallyOf(dbxSrc, 'dbxFetch', 'recordDatabricksUnityAccess')) {
      failures.push(
        `${DBX_CHOKEPOINT}: recordDatabricksUnityAccess( is not called from inside a \`finally\` block of dbxFetch. ` +
        `Catalog OWNER CHANGE (patchUcCatalog), catalog DELETE (deleteUcCatalog) and GRANT MUTATION (updateUcPermissions) ` +
        `issue from this client on the Commercial default backend — without this they reach Unity Catalog UNAUDITED.`,
      );
    }
    const dbxMasked = maskCommentsAndStrings(dbxSrc);
    const dbxOutbound = (dbxMasked.match(/\bfetchWithTimeout\s*\(/g) || []).length
      + (dbxMasked.match(/(?<![.\w])fetch\s*\(/g) || []).length;
    const dbxBaseline = opts.dbxOutboundBaseline ?? DBX_OUTBOUND_BASELINE;
    if (dbxOutbound > dbxBaseline) {
      failures.push(
        `${DBX_CHOKEPOINT}: ${dbxOutbound} outbound calls (ratchet: ${dbxBaseline}). This file is allowlisted from the ` +
        `no-bypass scan because it HOLDS dbxFetch, so a new raw fetch here is an un-audited door to Unity Catalog — ` +
        `exactly the bypass this ratchet exists to catch. Route it through dbxFetch.`,
      );
    }
  }

  // ── 4. NO BYPASS ──────────────────────────────────────────────────────────
  for (const [r, src] of sources) {
    if (CHOKEPOINT_FILES.has(r)) continue;
    if (isTestFile(r)) continue; // specs legitimately stub URLs + fetch
    if (!referencesCatalogAddress(r, src)) continue;
    if (!REQUEST_RE.test(src)) continue; // env read for a gate/capability check — fine
    if (KNOWN_UNAUDITED.has(r)) continue; // declared gap — reported, not silent
    failures.push(
      `${r}: references a Unity Catalog address or REST path (LOOM_UNITY_URL / ossUcBase() / /api/2.x/unity-catalog/) ` +
      `AND issues outbound requests. Every catalog call must go through ucFetch (${CHOKEPOINT}) or dbxFetch ` +
      `(${DBX_CHOKEPOINT}) so it lands in _auditLog + LoomAudit_CL. If this file genuinely must call the catalog, add ` +
      `it to CHOKEPOINT_FILES in this guard with a justification AND make it record an audit row.`,
    );
  }

  // ── 4b. DECLARED GAPS MUST STILL EXIST ────────────────────────────────────
  // A stale entry would silently re-open the allowlist for a file that has since
  // been fixed or deleted, so the list is kept exact in both directions.
  for (const [file] of KNOWN_UNAUDITED) {
    if (!sources.has(file)) {
      failures.push(`${file}: listed in KNOWN_UNAUDITED but not present — remove the entry (the gap is closed).`);
    }
  }

  // ── 5. ALLOWLISTED CALLERS MUST STILL AUDIT ───────────────────────────────
  for (const [file, symbol] of MUST_AUDIT) {
    const src = sources.get(file);
    if (src == null) {
      failures.push(`${file}: allowlisted in CHOKEPOINT_FILES but missing — drop the entry or restore the file.`);
      continue;
    }
    if (!countCalls(src, symbol)) {
      failures.push(
        `${file}: allowlisted to call the catalog outside ucFetch but no longer calls ${symbol}( — ` +
        `its catalog access would be UNAUDITED. Restore the audit call or remove the allowlist entry.`,
      );
    }
  }

  // ── 6. SINK REACHABILITY ──────────────────────────────────────────────────
  const recSrc = sources.get(RECORDER);
  if (recSrc == null) {
    failures.push(`MISSING RECORDER: ${RECORDER} does not exist.`);
  } else {
    for (const [symbol, label] of [
      ['auditLogContainer', 'the Cosmos `_auditLog` trail'],
      ['emitAuditEvent', 'the `LoomAudit_CL` SIEM stream'],
    ]) {
      if (!recSrc.includes(symbol)) {
        failures.push(`${RECORDER}: no ${symbol} usage — ${label} is no longer written. LU-3 requires BOTH sinks.`);
      }
    }
    if (!/'denied'/.test(recSrc)) {
      failures.push(`${RECORDER}: the 'denied' outcome is gone. A denied access attempt is the single most valuable audit row.`);
    }
  }

  return failures;
}

export function isTestFile(rel) {
  return /(^|[\\/])__tests__[\\/]/.test(rel) || /\.(test|spec)\.(ts|tsx)$/.test(rel);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function isSourceFile(f) {
  if (!/\.(ts|tsx|mjs)$/.test(f)) return false;
  if (/\.d\.ts$/.test(f)) return false;
  return true;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (isSourceFile(e.name)) out.push(full);
  }
  return out;
}

function readSources() {
  const rel = (abs) => path.relative(APP_ROOT, abs).split(path.sep).join('/');
  const sources = new Map();
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(dir)) sources.set(rel(abs), fs.readFileSync(abs, 'utf8'));
  }
  return sources;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const failures = analyzeUnityChokepoint(readSources());
  if (failures.length) {
    console.error('\n✗ unity-audit-chokepoint FAILED\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nWhy this rule: an audit trail with a hole in it is worse than no trail, because it is trusted.\n' +
      'See apps/fiab-console/lib/azure/unity-audit.ts and PRPs/active/loom-apex/research/loom-unity.md (LU-3).\n',
    );
    process.exit(1);
  }
  console.log('✓ unity-audit-chokepoint: ucFetch + dbxFetch both record, no bypass, sinks reachable, SQL exits ratcheted.');
  if (KNOWN_UNAUDITED.size) {
    console.log(`\n  ! ${KNOWN_UNAUDITED.size} DECLARED, UN-AUDITED catalog path(s) remain — the trail is NOT complete:`);
    for (const [file, why] of KNOWN_UNAUDITED) console.log(`      - ${file}: ${why}`);
    console.log('    These are ratcheted: a NEW un-audited path fails the build.\n');
  }
}

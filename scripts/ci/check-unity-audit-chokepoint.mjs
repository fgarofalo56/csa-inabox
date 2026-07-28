#!/usr/bin/env node
/**
 * GUARDRAIL: unity-audit-chokepoint  (merge-blocker — loom-apex LU-3)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   EVERY Unity Catalog / Loom Unity call the Console BFF makes must go through
 *   the ONE audited choke point — `ucFetch` in
 *     apps/fiab-console/lib/azure/unity-catalog-client.ts
 *   whose `finally` block calls `recordUnityAccess(...)`
 *     (apps/fiab-console/lib/azure/unity-audit.ts)
 *   writing WHO / WHAT / WHEN / OUTCOME (including DENIALS) to the Cosmos
 *   `_auditLog` trail and the `LoomAudit_CL` SIEM stream.
 *
 * WHY A GUARD AND NOT JUST A COMMENT:
 *   An audit choke point is only a choke point if bypassing it is HARD. A
 *   convention ("please call ucFetch") silently degrades the first time someone
 *   adds `fetch(process.env.LOOM_UNITY_URL + '/api/2.1/...')` to a new route —
 *   and an audit trail with a hole in it is worse than none, because it is
 *   trusted. This guard turns that mistake into a red build.
 *
 * THE FOUR CHECKS
 *   1. INTEGRITY — the choke point still records. `unity-catalog-client.ts`
 *      must contain `recordUnityAccess(` inside a `finally` block, and must
 *      import it from lib/azure/unity-audit.
 *   2. SINGLE EXIT — `unity-catalog-client.ts` may contain at most ONE outbound
 *      call (`fetchWithTimeout(` / `fetch(`). A second one is a second, silently
 *      un-audited door out of the client.
 *   3. NO BYPASS — no file outside the ALLOWLIST may combine a Loom Unity
 *      address (`LOOM_UNITY_URL`, `ossUcBase(`, `LOOM_UC_BACKEND` URL building)
 *      with an outbound call. Reading those env vars for a GATE/CAPABILITY check
 *      is fine — issuing a REQUEST with them is not.
 *   4. SINK REACHABILITY — `unity-audit.ts` must actually write both sinks
 *      (`auditLogContainer` for Cosmos `_auditLog`, `emitAuditEvent` for
 *      `LoomAudit_CL`) and must classify denials (`'denied'`). A recorder that
 *      stopped writing a sink would otherwise pass checks 1-3 while producing
 *      nothing.
 *
 * ALLOWLIST — a file that legitimately needs the Loom Unity address AND makes
 *   requests must be added to CHOKEPOINT_FILES below WITH a justification, and
 *   must itself audit. Adding an entry is a security review, not a formality.
 *
 * NOT A RATCHET: there is no baseline to grow into. Zero bypasses, always.
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

/** The choke point itself — the only file allowed to issue a Loom Unity request. */
const CHOKEPOINT = 'lib/azure/unity-catalog-client.ts';
/** The recorder the choke point delegates to. */
const RECORDER = 'lib/azure/unity-audit.ts';

/**
 * Files permitted to reference a Loom Unity address alongside request-shaped
 * code. Each entry needs a reason; each must remain audited.
 */
const CHOKEPOINT_FILES = new Map([
  [CHOKEPOINT, 'THE choke point — its single fetchWithTimeout is wrapped by recordUnityAccess in a finally block.'],
  [RECORDER, 'The recorder. Writes the audit sinks; issues no catalog requests.'],
  ['lib/azure/uc-backend.ts', 'Resolves the backend + base URL + credential. Builds no request of its own.'],
  [
    'lib/admin/health-probes.ts',
    'probe-loom-unity-authz (LU-2) sends ONE deliberately UNAUTHENTICATED read to prove the catalog rejects '
    + 'anonymous callers — routing it through the credentialed ucFetch would defeat the test. It records its own '
    + 'audit row via recordUnityAuthzProbe(), which is asserted below.',
  ],
]);

/**
 * Files in CHOKEPOINT_FILES that call the catalog (rather than merely resolving
 * its address) must still produce an audit row. Symbol each one must contain.
 */
const MUST_AUDIT = new Map([
  ['lib/admin/health-probes.ts', 'recordUnityAccess'],
]);

/** Directories scanned for bypasses. */
const SCAN_DIRS = [
  path.join(APP_ROOT, 'lib'),
  path.join(APP_ROOT, 'app'),
  path.join(APP_ROOT, 'scripts'),
];

/** A Loom Unity address appearing in a file. */
const UNITY_ADDRESS_RE = /\bLOOM_UNITY_URL\b|\bossUcBase\s*\(/;
/** Request-shaped code. */
const REQUEST_RE = /\bfetchWithTimeout\s*\(|(?<![.\w])fetch\s*\(|\baxios\b|\bhttps?\.request\s*\(/;

function isSourceFile(f) {
  if (!/\.(ts|tsx|mjs)$/.test(f)) return false;
  if (/\.d\.ts$/.test(f)) return false;
  return true;
}

function isTestFile(rel) {
  return /(^|[\\/])__tests__[\\/]/.test(rel) || /\.(test|spec)\.(ts|tsx)$/.test(rel);
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

const failures = [];
const rel = (abs) => path.relative(APP_ROOT, abs).split(path.sep).join('/');

// ── 1. INTEGRITY — the choke point still records ────────────────────────────
const chokeAbs = path.join(APP_ROOT, CHOKEPOINT);
let chokeSrc = '';
if (!fs.existsSync(chokeAbs)) {
  failures.push(`MISSING CHOKE POINT: ${CHOKEPOINT} does not exist. Every Unity Catalog call must funnel through its ucFetch.`);
} else {
  chokeSrc = fs.readFileSync(chokeAbs, 'utf8');
  if (!/from\s+['"]@\/lib\/azure\/unity-audit['"]/.test(chokeSrc)) {
    failures.push(`${CHOKEPOINT}: does not import from @/lib/azure/unity-audit — the audit choke point has been disconnected.`);
  }
  if (!/recordUnityAccess\s*\(/.test(chokeSrc)) {
    failures.push(`${CHOKEPOINT}: no recordUnityAccess( call. Unity Catalog calls would reach the catalog UNAUDITED. Restore the finally block in ucFetch.`);
  } else {
    // The record must be in a `finally` — a success-path-only emitter silently
    // drops every DENIAL, which is the row this whole item exists to capture.
    const finallyIdx = chokeSrc.indexOf('} finally {');
    const inFinally = finallyIdx >= 0 && chokeSrc.slice(finallyIdx).includes('recordUnityAccess(');
    if (!inFinally) {
      failures.push(
        `${CHOKEPOINT}: recordUnityAccess( is not inside the ucFetch \`finally\` block. ` +
        `Recording only on the success path drops every DENIED call — the highest-value audit row.`,
      );
    }
  }

  // ── 2. SINGLE EXIT ────────────────────────────────────────────────────────
  const outbound = (chokeSrc.match(/\bfetchWithTimeout\s*\(/g) || []).length
    + (chokeSrc.match(/(?<![.\w])fetch\s*\(/g) || []).length;
  if (outbound > 1) {
    failures.push(
      `${CHOKEPOINT}: ${outbound} outbound calls found (expected exactly 1, inside ucFetch). ` +
      `A second exit is an un-audited door to the catalog — route it through ucFetch.`,
    );
  }
}

// ── 3. NO BYPASS ────────────────────────────────────────────────────────────
for (const dir of SCAN_DIRS) {
  for (const abs of walk(dir)) {
    const r = rel(abs);
    if (CHOKEPOINT_FILES.has(r)) continue;
    if (isTestFile(r)) continue; // specs legitimately stub URLs + fetch
    const src = fs.readFileSync(abs, 'utf8');
    if (!UNITY_ADDRESS_RE.test(src)) continue;
    if (!REQUEST_RE.test(src)) continue; // env read for a gate/capability check — fine
    failures.push(
      `${r}: references a Loom Unity address (LOOM_UNITY_URL / ossUcBase()) AND issues outbound requests. ` +
      `Every catalog call must go through ucFetch in ${CHOKEPOINT} so it lands in _auditLog + LoomAudit_CL. ` +
      `If this file genuinely must call the catalog, add it to CHOKEPOINT_FILES in this guard with a justification ` +
      `AND make it call recordUnityAccess().`,
    );
  }
}

// ── 3b. ALLOWLISTED CALLERS MUST STILL AUDIT ────────────────────────────────
for (const [file, symbol] of MUST_AUDIT) {
  const abs = path.join(APP_ROOT, file);
  if (!fs.existsSync(abs)) {
    failures.push(`${file}: allowlisted in CHOKEPOINT_FILES but missing — drop the entry or restore the file.`);
    continue;
  }
  if (!fs.readFileSync(abs, 'utf8').includes(symbol)) {
    failures.push(
      `${file}: allowlisted to call the catalog outside ucFetch but no longer contains ${symbol}( — ` +
      `its catalog access would be UNAUDITED. Restore the audit call or remove the allowlist entry.`,
    );
  }
}

// ── 4. SINK REACHABILITY ────────────────────────────────────────────────────
const recAbs = path.join(APP_ROOT, RECORDER);
if (!fs.existsSync(recAbs)) {
  failures.push(`MISSING RECORDER: ${RECORDER} does not exist.`);
} else {
  const recSrc = fs.readFileSync(recAbs, 'utf8');
  const sinks = [
    ['auditLogContainer', 'the Cosmos `_auditLog` trail'],
    ['emitAuditEvent', 'the `LoomAudit_CL` SIEM stream'],
  ];
  for (const [symbol, label] of sinks) {
    if (!recSrc.includes(symbol)) {
      failures.push(`${RECORDER}: no ${symbol} usage — ${label} is no longer written. LU-3 requires BOTH sinks.`);
    }
  }
  if (!/'denied'/.test(recSrc)) {
    failures.push(`${RECORDER}: the 'denied' outcome is gone. A denied access attempt is the single most valuable audit row.`);
  }
}

if (failures.length) {
  console.error('\n✗ unity-audit-chokepoint FAILED\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this rule: an audit trail with a hole in it is worse than no trail, because it is trusted.\n' +
    'See apps/fiab-console/lib/azure/unity-audit.ts and PRPs/active/loom-apex/research/loom-unity.md (LU-3).\n',
  );
  process.exit(1);
}

console.log('✓ unity-audit-chokepoint: every Unity Catalog call routes through the audited ucFetch choke point.');

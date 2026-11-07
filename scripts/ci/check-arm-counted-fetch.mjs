#!/usr/bin/env node
/**
 * GUARDRAIL: arm-counted-fetch  (merge-blocker, shrink-only allowlist)
 * ---------------------------------------------------------------------------
 * RULE: a console source file that builds ARM URLs must not call a RAW
 * `fetch(` / `fetchWithTimeout(`. ARM reads go through the counted path so the
 * per-minute `[arm-reads]` line (apps/fiab-console/lib/azure/arm-read-gate.ts)
 * can attribute a quota burst (429 SubscriptionRequestsThrottled) to a caller:
 *
 *   - `armCountedFetch` (lib/azure/arm-counted-fetch.ts) for per-service clients, or
 *   - the shared transports `arm-client.armFetch` / `monitor-arm.armGet`.
 *
 * A file is "ARM-marked" when its code (comments stripped) contains `armBase(`,
 * `armHost(` or a management-host literal. A file that itself calls
 * `beginArmRead(` IS a counted transport and is exempt (that is how the counted
 * path counts). Anything else with a raw fetch needs an entry in
 * arm-counted-fetch-allowlist.json with a WHY.
 *
 * RATCHET: an allowlist entry whose file no longer violates is an error too, so
 * the list can only shrink. Scope: apps/fiab-console/{lib,app}, non-test .ts/.tsx.
 *
 * LIMITS (read before trusting a green): static and file-level. It cannot see a
 * raw fetch to an ARM URL built in a file with no ARM marker (e.g. a URL passed
 * in as a parameter), nor an `fetch` aliased to another name. It watches the
 * known shape; it is a regression guard, not a discovery instrument.
 *
 * Usage: node scripts/ci/check-arm-counted-fetch.mjs [repoRoot]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCOPE_DIRS = ['apps/fiab-console/lib', 'apps/fiab-console/app'];
export const ARM_MARKER = /\barmBase\s*\(|\barmHost\s*\(|management\.azure\.com|management\.usgovcloudapi\.net|management\.azure\.us/;
export const RAW_FETCH = /(?<![\w.$])(?:fetchWithTimeout|fetch)\s*\(/;
export const COUNTED_TRANSPORT = /\bbeginArmRead\s*\(/;

/** Drop block comments and whole-line / trailing `//` comments (not `://`). */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\w'"`])\/\/[^\n]*/g, '$1');
}

/** Classify one file's source. Returns 'ok' | 'counted-transport' | 'violation'. */
export function classify(src) {
  const code = stripComments(src);
  if (!ARM_MARKER.test(code)) return 'ok';
  if (COUNTED_TRANSPORT.test(code)) return 'counted-transport';
  return RAW_FETCH.test(code) ? 'violation' : 'ok';
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.next', '__tests__', '__fixtures__'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
}

/** Scan a repo root; returns { violations: string[], stale: string[], scanned: number }. */
export function scanRoot(root, allowlist) {
  const files = [];
  for (const d of SCOPE_DIRS) walk(path.join(root, d), files);
  const violating = new Set();
  for (const f of files) {
    if (classify(fs.readFileSync(f, 'utf8')) === 'violation') {
      violating.add(path.relative(root, f).split(path.sep).join('/'));
    }
  }
  const violations = [...violating].filter((f) => !(f in allowlist)).sort();
  const stale = Object.keys(allowlist).filter((f) => !violating.has(f)).sort();
  return { violations, stale, scanned: files.length, violating: [...violating].sort() };
}

export function loadAllowlist(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(j.allow ?? {})) {
    if (typeof v !== 'string' || v.trim().length < 20) {
      throw new Error(`allowlist entry ${k} needs a WHY of at least 20 characters`);
    }
    out[k] = v;
  }
  return out;
}

function main(root) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const allowlist = loadAllowlist(path.join(here, 'arm-counted-fetch-allowlist.json'));
  const r = scanRoot(root, allowlist);
  if (r.scanned < 100) {
    console.error(`arm-counted-fetch: scanned only ${r.scanned} files under ${SCOPE_DIRS.join(', ')} — scope is wrong, refusing a vacuous pass`);
    process.exit(1);
  }
  let bad = false;
  for (const f of r.violations) {
    bad = true;
    console.error(`VIOLATION ${f}: builds ARM URLs but calls raw fetch/fetchWithTimeout. Use armCountedFetch (lib/azure/arm-counted-fetch.ts) so the read is counted in [arm-reads], or add an allowlist entry with a WHY.`);
  }
  for (const f of r.stale) {
    bad = true;
    console.error(`STALE ALLOWLIST ${f}: no longer violates — delete the entry (ratchet is shrink-only).`);
  }
  if (bad) process.exit(1);
  console.log(`arm-counted-fetch: OK (${r.scanned} files scanned, ${Object.keys(allowlist).length} allowlisted)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

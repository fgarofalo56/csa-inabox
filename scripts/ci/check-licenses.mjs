#!/usr/bin/env node
/**
 * GUARDRAIL: license-scan  (merge-blocker for the console app deps)
 * ------------------------------------------------------------------------
 * RULE (rel-T78): the shipped CSA Loom Console (root LICENSE = MIT) must never
 *   take on a *viral copyleft* transitive dependency (GPL / AGPL) that would
 *   contaminate the distribution. This gate runs `license-checker` over the
 *   PRODUCTION dependency tree and FAILS if any package's license is outside an
 *   explicit ALLOWLIST — so a future GPL/AGPL transitive addition breaks the PR.
 *
 *   The allowlist deliberately INCLUDES the weak/file-level copyleft licenses
 *   already present and compatible with an MIT distribution when used as
 *   unmodified libraries (LGPL-3.0 via sharp's deps, EPL via elkjs, MPL-2.0,
 *   CC-BY-4.0 for data/font assets). It does NOT include GPL or AGPL, and it
 *   fails "UNKNOWN"/"Custom" licenses so they get a human review.
 *
 * WHAT IT DOES:
 *   1. Runs `npx license-checker --production --json` against the console app.
 *   2. Normalizes each package's SPDX expression (handles `(A OR B)`, `A AND B`,
 *      trailing `*` guesses, arrays) and checks it against ALLOWLIST.
 *   3. Prints a grouped summary; exits 1 with the offending packages if any
 *      license is not allowlisted.
 *   4. With `--write [file]`, also (re)generates a THIRD-PARTY-NOTICES.md
 *      attribution file grouped by license.
 *
 * REQUIRES node_modules to be installed (CI installs first). Run locally with a
 * checkout that has `pnpm install`-ed apps/fiab-console. When node_modules is
 * absent it SKIPS (exit 0) with a notice rather than false-failing.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   - A new PERMISSIVE / weak-copyleft license the project accepts → add its
 *     SPDX id to ALLOWLIST with a comment.
 *   - A single package whose SPDX string is odd but vetted → add "name@version"
 *     (or bare "name") to PACKAGE_OVERRIDES with a one-line reason.
 *   - A GPL/AGPL dependency is NEVER allowlisted — replace it, do not exempt it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console');

// --- Allowlist: permissive + weak/file-level copyleft compatible with an MIT
//     distribution used as unmodified libraries. NO GPL-*, NO AGPL-*. ---------
const ALLOWLIST = new Set([
  // Permissive
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause',
  'BSD-3-Clause-Clear', '0BSD', 'Zlib', 'Unlicense', 'WTFPL', 'CC0-1.0',
  'Python-2.0', 'BlueOak-1.0.0', 'Artistic-2.0', 'Apache*', 'PostgreSQL',
  'Zlib-acknowledgement', 'MIT*', 'Beerware',
  // Weak / file-level copyleft (OK for unmodified library use in an MIT dist)
  'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL-2.1',
  'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'MPL-2.0', 'MPL-2.0-no-copyleft-exception',
  'EPL-1.0', 'EPL-2.0',
  // Content / font / data assets shipped by some deps
  'CC-BY-4.0', 'CC-BY-3.0', 'OFL-1.1', 'Unicode-DFS-2016', 'Unicode-3.0',
]);

// Licenses that are EXPLICITLY blocked even if someone widens the allowlist by
// mistake — viral copyleft that would contaminate the MIT distribution.
const HARD_BLOCK = [/\bA?GPL-/i];

// Per-package vetted exceptions. Key = "name@version" or bare "name".
// Example: 'some-pkg@1.2.3': 'dual-licensed; upstream SPDX string is malformed'.
const PACKAGE_OVERRIDES = {
  // (none yet — add with a one-line justification)
};

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write(msg + '\n'); }

/** Split an SPDX expression into { op, tokens }. Handles (A OR B), A AND B. */
function parseExpr(raw) {
  const s = String(raw).trim().replace(/^\(+|\)+$/g, '');
  if (/\bOR\b/i.test(s)) return { op: 'OR', tokens: s.split(/\bOR\b/i).map((t) => clean(t)) };
  if (/\bAND\b/i.test(s)) return { op: 'AND', tokens: s.split(/\bAND\b/i).map((t) => clean(t)) };
  return { op: 'SINGLE', tokens: [clean(s)] };
}
function clean(t) { return String(t).trim().replace(/^\(+|\)+$/g, '').replace(/\s+/g, ''); }

/** A raw license value from license-checker: string | string[] | 'A OR B'. */
function isAllowed(rawLicense) {
  // Normalize array → OR expression (license-checker uses arrays for OR).
  const raw = Array.isArray(rawLicense) ? rawLicense.join(' OR ') : String(rawLicense || '');
  if (!raw || /^unknown$/i.test(raw) || /^custom/i.test(raw)) return false;
  if (HARD_BLOCK.some((re) => re.test(raw))) return false;
  const { op, tokens } = parseExpr(raw);
  const ok = (tok) => ALLOWLIST.has(tok) || ALLOWLIST.has(tok.replace(/\*$/, ''));
  return op === 'AND' ? tokens.every(ok) : tokens.some(ok);
}

function runLicenseChecker() {
  // Requires node_modules present. Uses npx so the checker need not be a dep.
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', 'license-checker@0.6.3', '--production', '--json', '--start', APP_DIR],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function generateNotices(pkgs, outFile) {
  const byLicense = new Map();
  for (const [id, info] of Object.entries(pkgs)) {
    const lic = Array.isArray(info.licenses) ? info.licenses.join(' OR ') : (info.licenses || 'UNKNOWN');
    if (!byLicense.has(lic)) byLicense.set(lic, []);
    byLicense.get(lic).push({ id, repo: info.repository || '', publisher: info.publisher || '' });
  }
  const lines = [
    '# Third-party notices',
    '',
    '> Generated by `scripts/ci/check-licenses.mjs --write` over the CSA Loom',
    '> Console PRODUCTION dependency tree. The CSA Loom Console itself is MIT',
    '> (see root `LICENSE`). The packages below are its bundled dependencies,',
    '> grouped by declared license. Regenerate on dependency changes; the',
    '> `license-scan` CI job fails the PR if any license falls outside the',
    '> reviewed allowlist in `scripts/ci/check-licenses.mjs`.',
    '',
    `_Packages: ${Object.keys(pkgs).length}. Generated: ${new Date().toISOString()}._`,
    '',
  ];
  for (const lic of [...byLicense.keys()].sort()) {
    const rows = byLicense.get(lic).sort((a, b) => a.id.localeCompare(b.id));
    lines.push(`## ${lic}  (${rows.length})`, '');
    for (const r of rows) {
      lines.push(`- \`${r.id}\`${r.repo ? ` — ${r.repo}` : ''}`);
    }
    lines.push('');
  }
  fs.writeFileSync(outFile, lines.join('\n'));
  log(`Wrote ${outFile} (${Object.keys(pkgs).length} packages).`);
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const writeIdx = args.indexOf('--write');
  const outFile = write && args[writeIdx + 1] && !args[writeIdx + 1].startsWith('--')
    ? path.resolve(process.cwd(), args[writeIdx + 1])
    : path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md');

  if (!fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
    log('license-scan: apps/fiab-console/node_modules not found — SKIP (run after pnpm install).');
    process.exit(0);
  }

  let pkgs;
  try {
    pkgs = runLicenseChecker();
  } catch (e) {
    fail('license-scan: could not run license-checker: ' + (e.message || e));
    process.exit(1);
  }

  const violations = [];
  for (const [id, info] of Object.entries(pkgs)) {
    const name = id.replace(/@[^@]+$/, '');
    if (PACKAGE_OVERRIDES[id] || PACKAGE_OVERRIDES[name]) continue;
    if (!isAllowed(info.licenses)) {
      violations.push({ id, license: Array.isArray(info.licenses) ? info.licenses.join(' OR ') : info.licenses });
    }
  }

  log(`license-scan: inspected ${Object.keys(pkgs).length} production packages.`);

  if (write) generateNotices(pkgs, outFile);

  if (violations.length > 0) {
    fail('\nlicense-scan FAILED — the following packages have a license outside the reviewed allowlist:');
    for (const v of violations) fail(`  ✗ ${v.id}  →  ${v.license}`);
    fail('\nGPL/AGPL and unknown/custom licenses are blocked (they would contaminate the MIT distribution).');
    fail('If a license is a false positive or a vetted exception, update ALLOWLIST or PACKAGE_OVERRIDES');
    fail('in scripts/ci/check-licenses.mjs WITH a justification. Never allowlist GPL/AGPL — replace the dep.');
    process.exit(1);
  }

  log('license-scan: OK — every production dependency is within the allowlist.');
  process.exit(0);
}

main();

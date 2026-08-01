#!/usr/bin/env node
/**
 * GUARDRAIL: pnpm overrides must be declared in BOTH homes, identically.
 *
 * WHY THIS EXISTS. PR #2729 floored six runtime CVEs with pnpm `overrides` and
 * declared them in `apps/fiab-console/pnpm-workspace.yaml` — correct for pnpm
 * 10+, which is what the author's machine ran. But the thing that BUILDS the
 * shipped image is pnpm 9:
 *
 *   apps/fiab-console/Dockerfile:  npm install -g pnpm@9 && pnpm install --no-frozen-lockfile
 *   .github/workflows/fiab-console-ci.yml:  npm install -g pnpm@9
 *
 * and **pnpm 9 does not read pnpm-workspace.yaml overrides at all.** Verified by
 * experiment, not by reading docs: a scratch project declaring an override ONLY
 * in pnpm-workspace.yaml, installed with pnpm 9, produces a lockfile with **zero**
 * `overrides:` entries. The Dockerfile did not even COPY the file.
 *
 * So the security fix merged, CI went green, the PR body carried a correct table
 * of advisories — and the floors did not apply to the shipped image. The exact
 * recurring shape: a control that exists, reads green, and is not executing.
 *
 * It also broke `loom-ui-verify` (the browser E2E gate), which pins pnpm 9 and
 * uses `--frozen-lockfile`: pnpm 9 saw no overrides in package.json, the lockfile
 * declared six, and every run died at install with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
 *
 * THE RULE. Both files declare the overrides, identically:
 *   - package.json `pnpm.overrides`   → read by pnpm 9  (today's builder)
 *   - pnpm-workspace.yaml `overrides` → read by pnpm 10+ (tomorrow's)
 * Declaring in one alone makes the floors inert under the other major, silently.
 * pnpm 10+ warns that the package.json field is ignored; that warning is
 * expected and harmless — the file is there for pnpm 9.
 *
 * Usage: node scripts/ci/check-pnpm-overrides.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROJECTS = ['apps/fiab-console'];

/** Minimal reader for the flat `overrides:` map in pnpm-workspace.yaml. */
function parseWorkspaceOverrides(text) {
  const out = {};
  const lines = text.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^overrides:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      // Any non-indented, non-blank, non-comment line ends the block.
      if (/^\S/.test(line)) break;
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s+(?:'([^']+)'|"([^"]+)"|([^:\s]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/);
      if (m) out[m[1] || m[2] || m[3]] = m[4] ?? m[5] ?? m[6];
    }
  }
  return out;
}

const problems = [];

for (const proj of PROJECTS) {
  const pkgPath = join(ROOT, proj, 'package.json');
  const wsPath = join(ROOT, proj, 'pnpm-workspace.yaml');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const fromPkg = (pkg.pnpm && pkg.pnpm.overrides) || {};
  const fromWs = existsSync(wsPath) ? parseWorkspaceOverrides(readFileSync(wsPath, 'utf8')) : {};

  const pkgKeys = Object.keys(fromPkg);
  const wsKeys = Object.keys(fromWs);
  if (pkgKeys.length === 0 && wsKeys.length === 0) continue; // no overrides at all — fine

  if (pkgKeys.length === 0) {
    problems.push(`${proj}: overrides exist in pnpm-workspace.yaml but NOT in package.json — pnpm 9 (the image builder) will ignore them entirely.`);
    continue;
  }
  if (wsKeys.length === 0) {
    problems.push(`${proj}: overrides exist in package.json but NOT in pnpm-workspace.yaml — a pnpm 10+ build would drop them.`);
    continue;
  }

  for (const k of new Set([...pkgKeys, ...wsKeys])) {
    if (!(k in fromPkg)) problems.push(`${proj}: "${k}" is in pnpm-workspace.yaml but missing from package.json.pnpm.overrides`);
    else if (!(k in fromWs)) problems.push(`${proj}: "${k}" is in package.json.pnpm.overrides but missing from pnpm-workspace.yaml`);
    else if (fromPkg[k] !== fromWs[k]) problems.push(`${proj}: "${k}" disagrees — package.json says "${fromPkg[k]}", pnpm-workspace.yaml says "${fromWs[k]}"`);
  }

  // The declaration is worthless if the builder never sees the file.
  const dockerfile = join(ROOT, proj, 'Dockerfile');
  if (existsSync(dockerfile)) {
    const df = readFileSync(dockerfile, 'utf8');
    const copiesWorkspace = /^COPY\s+[^\n]*pnpm-workspace\.yaml/m.test(df);
    if (!copiesWorkspace) {
      problems.push(`${proj}: Dockerfile never COPYs pnpm-workspace.yaml, so a pnpm 10+ build would resolve without the floors.`);
    }
  }
}

if (problems.length === 0) {
  console.log('[pnpm-overrides] OK — override declarations agree across package.json, pnpm-workspace.yaml, and the Dockerfile copy list.');
  process.exit(0);
}

console.error(`\n[pnpm-overrides] FAIL — ${problems.length} problem(s):\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error('\n  pnpm 9 reads ONLY package.json `pnpm.overrides`; pnpm 10+ reads ONLY');
console.error('  pnpm-workspace.yaml. The image is built with pnpm 9 today. Declaring a');
console.error('  CVE floor in one place alone makes it inert under the other major —');
console.error('  silently, with CI green. Keep both in sync.\n');
process.exit(1);

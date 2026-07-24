#!/usr/bin/env node
/**
 * GUARDRAIL: license-inventory (LIC0)  — merge-blocker
 * ------------------------------------------------------------------------
 * RULE (loom-next-level LIC0): the DISTRIBUTED OSS set (bundled into a container
 *   image, a wasm asset, or a deployed sidecar) must carry NO viral/commercial
 *   copyleft license — no AGPL, GPL, BSL (Business Source License), or SSPL
 *   (Server Side Public License). The Apache/MIT/BSD core set is accepted; Trino
 *   (N7e) is the single opt-in Apache-2.0 carve-out; MinIO (AGPL) is dropped and
 *   Univer is review-gated — neither may appear.
 *
 * WHY A SECOND GUARD: `check-licenses.mjs` gates the npm production tree of
 *   apps/fiab-console. It CANNOT see the non-npm shipped OSS — the Python sidecar
 *   services (apps/loom-duckdb, apps/loom-transform-runner) and the
 *   container-baked engines. This guard covers exactly that gap and enforces the
 *   THIRD_PARTY_LICENSES.md NOTICE manifest.
 *
 * WHAT IT DOES:
 *   1. Parses every apps/<name>/requirements.txt for pinned Python packages.
 *   2. Resolves each against REVIEWED_PY (package -> SPDX license). A package NOT
 *      in the allowlist FAILS (forces a human license review of any new embed —
 *      the ratchet). A package whose license matches the copyleft denylist FAILS.
 *   3. Verifies THIRD_PARTY_LICENSES.md exists and names every apps/ sidecar dir.
 *   4. Scans requirements + the manifest for the explicitly-forbidden libs
 *      (minio, univer) that policy says must not ship.
 *
 * ESCAPE HATCH: a genuinely-new permissive embed = add it to REVIEWED_PY below
 *   with its SPDX id (that IS the review record) AND a row in
 *   THIRD_PARTY_LICENSES.md. A copyleft dep is NEVER allowlisted — replace it.
 *
 * Owner: loom-next-level WS-N / LIC0 — compliance/distribution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = 'THIRD_PARTY_LICENSES.md';

/** Copyleft / commercial-source licenses that may NEVER ship. */
const FORBIDDEN_LICENSE_RE = /\b(A?GPL(-|\b)|BSL|Business Source|SSPL|Server Side Public|EUPL|CC-BY-NC)/i;
/** Libraries policy says must not appear in any shipped dependency list. */
const FORBIDDEN_PKG_RE = /^(minio|univer(\b|@|-))/i;

/**
 * REVIEWED Python embeds → SPDX license (the human review record). Every pinned
 * package in an apps/<name>/requirements.txt must appear here. Add a new permissive
 * embed with its real SPDX id + a THIRD_PARTY_LICENSES.md row. NEVER add a
 * copyleft license here — it will be hard-blocked anyway.
 */
const REVIEWED_PY = {
  fastapi: 'MIT',
  uvicorn: 'BSD-3-Clause',
  pydantic: 'MIT',
  duckdb: 'MIT',
  pyarrow: 'Apache-2.0',
  'azure-identity': 'MIT',
  'dbt-core': 'Apache-2.0',
  'dbt-synapse': 'Apache-2.0',
  'dbt-databricks': 'Apache-2.0',
  'dbt-duckdb': 'Apache-2.0',
  'dbt-fabric': 'Apache-2.0',
  sqlmesh: 'Apache-2.0',
  // pre-existing sidecars (fiab-prpt-renderer / fiab-wrangler-host / fiab-dbt-runner)
  flask: 'BSD-3-Clause',
  gunicorn: 'MIT',
  reportlab: 'BSD-3-Clause',
  openpyxl: 'MIT',
  'python-docx': 'MIT',
  pandas: 'BSD-3-Clause',
  numpy: 'BSD-3-Clause',
};

/** Strip a requirements.txt line to its base package name (drops extras/pins/markers). */
function pkgName(line) {
  const noComment = line.replace(/#.*$/, '').trim();
  if (!noComment) return null;
  // package[extra]==x.y ; marker  ->  package
  const m = noComment.match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function listRequirements() {
  const out = execSync('git ls-files "apps/*/requirements.txt" "apps/*/*/requirements.txt"', { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const wantList = process.argv.includes('--list');
  const errors = [];
  const reqFiles = listRequirements();
  const sidecarDirs = new Set();
  const seen = new Set();

  for (const rel of reqFiles) {
    sidecarDirs.add(rel.split('/').slice(0, 2).join('/')); // apps/<name>
    const abs = path.join(REPO_ROOT, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const raw of src.split('\n')) {
      const name = pkgName(raw);
      if (!name) continue;
      if (FORBIDDEN_PKG_RE.test(name)) {
        errors.push(`${rel}: FORBIDDEN package "${name}" — policy says it must not ship (MinIO dropped / Univer review-gated).`);
        continue;
      }
      const lic = REVIEWED_PY[name];
      if (!lic) {
        errors.push(`${rel}: Python embed "${name}" is NOT in REVIEWED_PY (scripts/ci/check-license-inventory.mjs). ` +
          `Add it with its SPDX license + a THIRD_PARTY_LICENSES.md row (that is the review), or remove it. ` +
          `A copyleft (A?GPL/BSL/SSPL) embed is never allowlisted.`);
        continue;
      }
      if (FORBIDDEN_LICENSE_RE.test(lic)) {
        errors.push(`${rel}: "${name}" is ${lic} — a copyleft/commercial-source license that may NEVER ship. Replace it.`);
        continue;
      }
      seen.add(`${name}@${lic}`);
      if (wantList) console.log(`  ${name.padEnd(24)} ${lic}`);
    }
  }

  // Manifest must exist and name every sidecar dir + must not mention a forbidden lib as shipped.
  const manifestAbs = path.join(REPO_ROOT, MANIFEST);
  if (!fs.existsSync(manifestAbs)) {
    errors.push(`${MANIFEST} is missing — the LIC0 NOTICE manifest must exist and list the shipped OSS.`);
  } else {
    const manifest = fs.readFileSync(manifestAbs, 'utf8');
    for (const dir of sidecarDirs) {
      if (!manifest.includes(dir)) {
        errors.push(`${MANIFEST} does not mention "${dir}" — every apps/ sidecar with a requirements.txt needs a NOTICE section.`);
      }
    }
  }

  if (wantList) {
    console.log(`[license-inventory] ${seen.size} reviewed Python embeds across ${reqFiles.length} requirements files.`);
  }

  if (errors.length) {
    console.error('[license-inventory] FAIL — LIC0 distribution-license gate:');
    for (const e of errors) console.error('   - ' + e);
    console.error('\nFix: add a reviewed permissive embed to REVIEWED_PY + THIRD_PARTY_LICENSES.md, or remove a ' +
      'copyleft/forbidden dependency. No A?GPL / BSL / SSPL in the distributed set.');
    process.exit(1);
  }
  console.log(`[license-inventory] OK — ${seen.size} shipped Python embeds reviewed (all permissive); ` +
    `${MANIFEST} present and covers ${sidecarDirs.size} sidecar(s); no MinIO/Univer/copyleft in the distributed set.`);
}

main();

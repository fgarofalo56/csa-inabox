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
 *   5. (round-3/4, PR #2640) Scans platform/fiab/bicep/** for UPSTREAM CONTAINER
 *      IMAGES pinned on a deploy path. Each must be in REVIEWED_BICEP_IMAGES with a
 *      permissive SPDX id AND named in THIRD_PARTY_LICENSES.md. TWO ref shapes
 *      are recognised, because both appear in this tree:
 *        a. registry-qualified — docker.io / ghcr.io / quay.io / registry.k8s.io /
 *           public.ecr.aws / gcr.io;
 *        b. BARE Docker Hub — `apache/airflow:2.10.5-python3.12`, the ordinary
 *           way a Docker Hub image is written. Docker resolves it against
 *           docker.io, so it is exactly as much of an internet pull as (a).
 *      `mcr.microsoft.com` is EXEMPT and documented as such: it is the
 *      Microsoft-published first-party registry, reachable in every sovereign
 *      cloud, and those artifacts are covered by Microsoft product terms rather
 *      than third-party OSS redistribution. Nothing else is exempt.
 *
 * WHY 5 EXISTS. The guard used to read ONLY requirements.txt files, so a
 *   third-party image deployed by default was covered by a hand-written markdown
 *   row and NOTHING enforced it. A markdown row nobody checks is exactly the
 *   "gate that measures nothing" class this repo has already been burned by. The
 *   copyleft risk is real and specific: the obvious alternative for the N8 S3
 *   lab (MinIO's S3 gateway) is AGPL-v3, and swapping an image string would have
 *   shipped it with a green LIC0.
 *
 * WHY 5b EXISTS (round 4). Shipped as (a)-only, this scan matched exactly ONE
 *   image — the one the PR that added the scan introduced — and was blind to the
 *   third-party Docker Hub pulls the tree ALREADY deploys, because they are
 *   written bare: `apache/airflow:2.10.5-python3.12` (admin-plane/airflow.bicep,
 *   default-ON wherever postgresQuotaAvailable is true) and
 *   `curlimages/curl:8.10.1` (compute/loom-memory-consolidate-job.bicep). A gate
 *   whose regex cannot match the ordinary spelling of the thing it polices is a
 *   gate that measures nothing. `assertObservesSomething()` below now also fails
 *   when the scan finds ZERO images, so the scan cannot silently go hollow again.
 *
 * ESCAPE HATCH: a genuinely-new permissive embed = add it to REVIEWED_PY /
 *   REVIEWED_IMAGES (Dockerfile-baked) or REVIEWED_BICEP_IMAGES (bicep-pinned)
 *   below with its SPDX id (that IS the review record) AND a row
 *   in THIRD_PARTY_LICENSES.md. A copyleft dep is NEVER allowlisted — replace it.
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

/**
 * REVIEWED third-party OSS *application* images that Loom DEPLOYS, keyed by the
 * image repository as it appears in an `apps/<name>/Dockerfile` FROM line
 * (registry + repo, tag stripped) → SPDX license (the human review record).
 *
 * WHY (LU-9): the Python-requirements scan above cannot see an engine that
 * ships as a whole container — the OSS Unity Catalog server, RisingWave,
 * Debezium, the tile server, and (new) the Delta Sharing reference server all
 * enter the distribution through a `FROM`. Those are exactly the embeds a
 * license review must cover, and until now nothing forced them into the NOTICE
 * manifest. A FROM that is not listed here FAILS, which is the ratchet: a new
 * container-baked engine cannot ship without a recorded license decision.
 *
 * Add a genuinely-new permissive embed with its real SPDX id + a
 * THIRD_PARTY_LICENSES.md row. A copyleft image is NEVER allowlisted.
 */
const REVIEWED_IMAGES = {
  // github.com/unitycatalog/unitycatalog — Apache-2.0 (LU-1/LU-2 metastore).
  'unitycatalog/unitycatalog': 'Apache-2.0',
  // github.com/risingwavelabs/risingwave — Apache-2.0 (N7a streaming tier).
  'risingwavelabs/risingwave': 'Apache-2.0',
  // github.com/debezium/debezium — Apache-2.0 (CDC connect runtime).
  'quay.io/debezium/connect': 'Apache-2.0',
  // github.com/maptiler/tileserver-gl — BSD-2-Clause (sovereign OSS maps tier).
  'maptiler/tileserver-gl': 'BSD-2-Clause',
  // github.com/delta-io/delta-sharing — Apache-2.0 (LU-9 loom-sharing). The
  // image is published by the upstream build itself (build.sbt dockerUsername
  // = "deltaio"), so it is the same Apache-2.0 codebase, not a third-party
  // redistribution under different terms.
  'deltaio/delta-sharing-server': 'Apache-2.0',
};

/**
 * Language/OS BASE images — the runtime a Loom-authored app is compiled onto,
 * not an OSS product Loom ships. These carry their vendors' own composite
 * licensing (a JDK base is GPLv2+CE, a debian base is a whole distribution) and
 * are governed by the base-image CVE gate, not by this manifest. Matching is by
 * prefix so tag/variant churn does not need a guard edit.
 */
const BASE_IMAGE_PREFIXES = [
  'node', 'python', 'debian', 'ubuntu', 'alpine', 'golang', 'rust',
  'amazoncorretto', 'eclipse-temurin', 'openjdk', 'busybox', 'scratch',
  'mcr.microsoft.com/', 'gcr.io/distroless/',
];

/** Strip the tag/digest and any `AS stage` suffix off a FROM line's image ref. */
function imageRepo(fromLine) {
  const raw = fromLine.replace(/^FROM\s+/i, '').trim().split(/\s+/)[0];
  const noPlatform = raw.replace(/^--platform=\S+\s+/, '');
  return noPlatform.split('@')[0].replace(/:[^/:]+$/, '');
}

function isBaseImage(repo) {
  return BASE_IMAGE_PREFIXES.some((p) => (p.endsWith('/') ? repo.startsWith(p) : repo === p || repo.startsWith(`${p}/`)));
}

/**
 * Yield only the REAL Dockerfile instructions - never a line inside a RUN
 * heredoc, a shell continuation, or a comment.
 *
 * A naive per-line `/^\s*FROM\s+/i` is wrong, and wrong in a way that fails the
 * build for an unrelated app: apps/loom-transform-runner/Dockerfile embeds a
 * Python snippet containing `from importlib.metadata import version`, which the
 * naive scan read as `FROM importlib.metadata` and reported as an unreviewed
 * container-baked OSS image. A license gate that invents dependencies is worse
 * than no gate, because the fix people reach for is to allowlist the phantom.
 *
 * Also drops build-stage aliases (`FROM x AS builder` then `FROM builder`):
 * a stage is internal plumbing, not a third-party image to license.
 */
function* dockerfileInstructions(src) {
  const lines = src.split('\n');
  const stages = new Set();
  let heredocEnd = null;      // terminator we are waiting for, if inside a heredoc
  let continuing = false;     // previous instruction line ended with a backslash
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const wasContinuing = continuing;
    // A trailing backslash continues the CURRENT instruction into the next line.
    continuing = /\\\s*$/.test(line);
    // `<<EOF` / `<<-'EOF'` opens a heredoc whose body is shell input, not Dockerfile.
    const here = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (here && !continuing) heredocEnd = here[1];
    if (wasContinuing) continue;                    // body of a multi-line instruction
    if (/^\s*(#|$)/.test(line)) continue;           // comment / blank
    const alias = line.match(/^\s*FROM\s+.*?\sAS\s+(\S+)\s*$/i);
    if (alias) stages.add(alias[1].toLowerCase());
    const ref = line.match(/^\s*FROM\s+(\S+)/i);
    if (ref && stages.has(ref[1].toLowerCase())) continue;
    yield { line, lineNo: i + 1 };
  }
}

function listAppDockerfiles() {
  const out = execSync('git ls-files "apps/*/Dockerfile" "apps/*/*/Dockerfile"', { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * ---------------------------------------------------------------------------
 * TWO image maps, deliberately. They cover DIFFERENT distribution paths and a
 * single map cannot do both jobs:
 *
 *   REVIEWED_IMAGES        keyed by an `apps/<app>/Dockerfile` FROM repo. Covers
 *                          engines Loom BAKES into its own images (LU-9
 *                          delta-sharing, Unity Catalog, RisingWave, Debezium,
 *                          tileserver-gl). Consumed by the Dockerfile walk.
 *
 *   REVIEWED_BICEP_IMAGES  keyed by a REGISTRY-QUALIFIED ref pinned in
 *                          platform/fiab/bicep. Covers upstream images Loom
 *                          DEPLOYS unmodified and never builds (N8 s3proxy).
 *                          Consumed by scanUpstreamImages().
 *
 * s3proxy is the worked example of why merging them would be wrong: it has no
 * Dockerfile FROM line at all, so the Dockerfile walk can never reach it — only
 * the bicep scan can. Conversely a baked engine never appears as a pinned bicep
 * image ref. Collapsing the two would silently drop one path, which is the
 * "gate that measures nothing" failure this guard exists to prevent.
 */

/**
 * REVIEWED upstream CONTAINER IMAGES pinned on a bicep deploy path → SPDX license
 * (the human review record), keyed by the registry-qualified repo WITHOUT the tag.
 * `notice` is the evidence the reviewer checked, and `manifestKey` is the string
 * THIRD_PARTY_LICENSES.md must contain so the markdown record cannot silently rot.
 *
 * Adding a row here is a LICENSE REVIEW. Do it from the upstream LICENSE file,
 * not from a README badge and not from the image description.
 */
const REVIEWED_BICEP_IMAGES = {
  'apache/airflow': {
    license: 'Apache-2.0',
    manifestKey: 'apache/airflow',
    // Apache Airflow is an Apache Software Foundation project distributed under
    // the Apache License 2.0 (LICENSE at github.com/apache/airflow), and the
    // `apache/airflow` Docker Hub image is the ASF's own publication of that
    // tree. Deployed by admin-plane/airflow.bicep as the OSS Airflow host
    // (no-fabric-dependency: the Azure-native alternative to a Fabric/ADF WOM
    // environment). Pulled unmodified — a NOTICE row, not a redistribution.
    notice: 'github.com/apache/airflow LICENSE = Apache License, Version 2.0',
  },
  'curlimages/curl': {
    license: 'curl',
    manifestKey: 'curlimages/curl',
    // curl ships under the "curl" license (an MIT/X11 derivative — permissive,
    // no copyleft obligation): curl.se/docs/copyright.html. Used as the HTTP
    // client for the compute/loom-memory-consolidate-job scheduled job. Pulled
    // unmodified.
    notice: 'curl.se/docs/copyright.html = curl license (MIT/X derivative)',
  },
};

/**
 * Registries whose artifacts are NOT third-party OSS redistribution for LIC0
 * purposes: Microsoft's own first-party registry, reachable in every sovereign
 * cloud and covered by Microsoft product terms. Deliberately narrow — this is
 * the ONLY exemption, and it is stated here rather than hidden in a regex.
 */
const EXEMPT_REGISTRY_RE = /^mcr\.microsoft\.com\//;

/** Registry-qualified upstream image refs pinned anywhere under platform/fiab/bicep. */
const UPSTREAM_IMAGE_RE =
  /\b((?:docker\.io|index\.docker\.io|ghcr\.io|quay\.io|registry\.k8s\.io|public\.ecr\.aws|gcr\.io)\/[A-Za-z0-9._/-]+):([A-Za-z0-9._-]+)/g;

/**
 * BARE Docker Hub refs written as a quoted bicep literal: `'<ns>/<name>:<tag>'`.
 * Anchored on the quotes so it cannot match a URL path or a resource id, and the
 * namespace must contain no `.` or `:` (that would be a registry host, handled by
 * UPSTREAM_IMAGE_RE / the MCR exemption). Literals containing a bicep
 * interpolation (`${…}`) are skipped by the caller: those resolve to the
 * deployment's OWN ACR, which is not an upstream pull.
 */
const BARE_DOCKERHUB_IMAGE_RE =
  /'([A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9._-]+)'/g;

/** Reviewed image refs actually found on a deploy path (reporting only). */
const IMAGE_RESULTS = [];

/**
 * Scan the deployable bicep tree for pinned upstream images. Lines that are pure
 * comments or `@description(...)` prose are skipped — those are documentation of
 * a parameter's shape, not a deployed image.
 */
function scanUpstreamImages(errors) {
  let files = [];
  try {
    files = execSync('git ls-files "platform/fiab/bicep/**/*.bicep" "platform/fiab/bicep/*.bicep"', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }

  const found = new Map(); // "repo:tag" -> [file:line, ...]
  for (const rel of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    src.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || line.includes('@description(')) return;
      const record = (repo, tag) => {
        if (EXEMPT_REGISTRY_RE.test(`${repo}/`)) return; // MCR first-party — see EXEMPT_REGISTRY_RE
        const key = `${repo}:${tag}`;
        if (!found.has(key)) found.set(key, []);
        found.get(key).push(`${rel}:${i + 1}`);
      };
      UPSTREAM_IMAGE_RE.lastIndex = 0;
      let m;
      while ((m = UPSTREAM_IMAGE_RE.exec(line)) !== null) record(m[1], m[2]);
      // Bare Docker Hub form (`'apache/airflow:2.10.5-python3.12'`). Skipped when
      // the literal is a bicep interpolation — `'${acr}/loom-duckdb:v0.1'` is the
      // deployment's own ACR, not an upstream pull.
      BARE_DOCKERHUB_IMAGE_RE.lastIndex = 0;
      while ((m = BARE_DOCKERHUB_IMAGE_RE.exec(line)) !== null) {
        if (m[0].includes('${')) continue;
        record(m[1], m[2]);
      }
    });
  }

  const manifestAbs = path.join(REPO_ROOT, MANIFEST);
  const manifest = fs.existsSync(manifestAbs) ? fs.readFileSync(manifestAbs, 'utf8') : '';

  for (const [ref, locations] of found) {
    const repo = ref.slice(0, ref.lastIndexOf(':'));
    const tag = ref.slice(ref.lastIndexOf(':') + 1);
    const reviewed = REVIEWED_BICEP_IMAGES[repo];
    if (!reviewed) {
      errors.push(
        `${locations[0]}: upstream container image "${ref}" is deployed by bicep but is NOT in REVIEWED_BICEP_IMAGES ` +
          `(scripts/ci/check-license-inventory.mjs). Read its upstream LICENSE, add it there with its SPDX id, ` +
          `and add a row to ${MANIFEST}. A copyleft (A?GPL/BSL/SSPL) image is never allowlisted.`,
      );
      continue;
    }
    if (FORBIDDEN_LICENSE_RE.test(reviewed.license)) {
      errors.push(`${locations[0]}: "${ref}" is ${reviewed.license} — may NEVER ship. Replace it.`);
      continue;
    }
    if (FORBIDDEN_PKG_RE.test(repo.split('/').pop())) {
      errors.push(`${locations[0]}: "${ref}" is on the forbidden-package list (MinIO dropped / Univer review-gated).`);
      continue;
    }
    if (tag === 'latest') {
      errors.push(
        `${locations[0]}: "${ref}" pins the FLOATING tag ":latest". A deployed upstream image must be pinned to an ` +
          `immutable version tag so the reviewed license and the running bits are the same artifact.`,
      );
      continue;
    }
    if (reviewed.manifestKey && !manifest.includes(reviewed.manifestKey)) {
      errors.push(
        `${MANIFEST} does not mention "${reviewed.manifestKey}" — every reviewed upstream image needs a NOTICE row.`,
      );
      continue;
    }
    IMAGE_RESULTS.push(`${ref} → ${reviewed.license} (${locations.length} ref(s))`);
  }

  // ANTI-HOLLOW RATCHET. This tree deploys upstream container images today
  // (apache/airflow, curlimages/curl). If the scan suddenly matches NONE, the far
  // likelier cause is that the ref spelling drifted out of the regex than that
  // every third-party image was removed — which is precisely how the round-3
  // version of this scan passed while observing nothing. Fail instead of
  // reporting a green "0 reviewed".
  if (found.size === 0) {
    errors.push(
      'LIC0 upstream-image scan matched ZERO images under platform/fiab/bicep. Either the ref-matching ' +
        'regexes in scripts/ci/check-license-inventory.mjs no longer recognise how images are written in ' +
        'this tree (the likely cause — fix the regex), or the tree genuinely deploys no third-party image ' +
        'any more (then delete this assertion in the same commit, deliberately). A scan that observes ' +
        'nothing must never report success.',
    );
  }
  return IMAGE_RESULTS;
}

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
  const seenImages = new Set();

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

  // ── Container-baked OSS engines (LU-9) ────────────────────────────────────
  // Every third-party APPLICATION image an apps/ Dockerfile builds FROM must
  // carry a recorded license AND a NOTICE row. Language/OS bases are excluded
  // (see BASE_IMAGE_PREFIXES) — they are the runtime, not a shipped product.
  const shippedImages = new Map(); // repo -> Set(dockerfile)
  for (const rel of listAppDockerfiles()) {
    let src;
    try { src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
    for (const { line } of dockerfileInstructions(src)) {
      if (!/^\s*FROM\s+/i.test(line)) continue;
      const repo = imageRepo(line.trim());
      if (!repo || isBaseImage(repo)) continue;
      if (!shippedImages.has(repo)) shippedImages.set(repo, new Set());
      shippedImages.get(repo).add(rel);
    }
  }
  for (const [repo, files] of shippedImages) {
    const where = [...files].join(', ');
    if (FORBIDDEN_PKG_RE.test(repo.split('/').pop() || repo)) {
      errors.push(`${where}: FORBIDDEN image "${repo}" — policy says it must not ship (MinIO dropped / Univer review-gated).`);
      continue;
    }
    const lic = REVIEWED_IMAGES[repo];
    if (!lic) {
      errors.push(`${where}: container-baked OSS image "${repo}" is NOT in REVIEWED_IMAGES (scripts/ci/check-license-inventory.mjs). ` +
        `Add it with its SPDX license + a THIRD_PARTY_LICENSES.md row (that is the review), or build on a reviewed base. ` +
        `A copyleft (A?GPL/BSL/SSPL) image is never allowlisted.`);
      continue;
    }
    if (FORBIDDEN_LICENSE_RE.test(lic)) {
      errors.push(`${where}: "${repo}" is ${lic} — a copyleft/commercial-source license that may NEVER ship. Replace it.`);
      continue;
    }
    seenImages.add(`${repo}@${lic}`);
    if (wantList) console.log(`  ${repo.padEnd(36)} ${lic}`);
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
    for (const repo of shippedImages.keys()) {
      if (!manifest.includes(repo)) {
        errors.push(`${MANIFEST} does not mention the container-baked image "${repo}" — every deployed third-party OSS image needs a NOTICE row (the "Container-baked engines" table).`);
      }
    }
  }

  if (wantList) {
    console.log(`[license-inventory] ${seenImages.size} reviewed container-baked OSS images across ${shippedImages.size} image repo(s).`);
  }

  // Upstream container images pinned on a bicep deploy path (round-3, PR #2640).
  const images = scanUpstreamImages(errors);
  if (wantList) {
    for (const line of images) console.log(`  ${line}`);
    console.log(`[license-inventory] ${seen.size} reviewed Python embeds across ${reqFiles.length} requirements files.`);
  }

  if (errors.length) {
    console.error('[license-inventory] FAIL — LIC0 distribution-license gate:');
    for (const e of errors) console.error('   - ' + e);
    console.error('\nFix: add a reviewed permissive embed to REVIEWED_PY + THIRD_PARTY_LICENSES.md, or remove a ' +
      'copyleft/forbidden dependency. No A?GPL / BSL / SSPL in the distributed set.');
    process.exit(1);
  }
  console.log(`[license-inventory] OK — ${seen.size} shipped Python embeds + ${seenImages.size} container-baked OSS image(s) reviewed (all permissive); ` +
    `${images.length} upstream container image(s) pinned in platform/fiab/bicep reviewed (${images.join('; ') || 'none'}); ` +
    `${MANIFEST} present and covers ${sidecarDirs.size} sidecar(s); no MinIO/Univer/copyleft in the distributed set.`);
}

main();

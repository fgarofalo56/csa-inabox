#!/usr/bin/env node
/**
 * GUARDRAIL: upstream-image-mirror (MIR0) — merge-blocker
 * ---------------------------------------------------------------------------
 * RULE (issue #2682 / FINISHLINE D14): every third-party container image a Loom
 *   DEPLOY PATH pulls must be mirrored into the estate's own ACR, BY DIGEST, from
 *   a single manifest, by a single shared script that BOTH cloud lanes call.
 *
 * WHAT IT ENFORCES
 *   1. Every upstream image ref pinned under platform/fiab/bicep/** has an entry
 *      in platform/fiab/images/upstream-images.json with the SAME repo:tag.
 *      (The consuming module composes `${acrLoginServer}/${repo}:${tag}`, so a
 *      bicep bump with no manifest bump means ACR never receives that tag and the
 *      Container App cannot activate a revision.)
 *   2. Every manifest entry carries a real `sha256:<64hex>` manifest digest, so
 *      the import is pinned and a mutable upstream tag cannot swap the bits under
 *      a reviewed licence + a passed CVE scan.
 *   3. No manifest entry floats `:latest`.
 *   4. BOTH cloud image lanes invoke scripts/ci/mirror-upstream-images.sh — i.e.
 *      the mirror cannot regress to a hard-coded per-workflow array, which is how
 *      the three-copies-of-one-fact drift arose in the first place.
 *   5. No bicep deploy path composes an image ref from a public registry host.
 *   6. ANTI-HOLLOW: the bicep scan must observe at least one image and the
 *      manifest must be non-empty. A scan that matches nothing must never report
 *      success (the failure mode LIC0 was burned by in its round-3 form).
 *
 * WHY A SECOND GUARD ALONGSIDE LIC0. check-license-inventory.mjs polices
 *   LICENSING — is this image's SPDX id permissive and recorded in the NOTICE
 *   manifest. It is completely satisfied by an image pulled anonymously from
 *   docker.io at runtime. This guard polices EGRESS AND PROVENANCE — is that same
 *   image mirrored into our registry, pinned to a digest, and actually imported by
 *   the lane that deploys it. Neither implies the other.
 *
 * MUTATION PROOF (how to confirm this guard is not hollow):
 *   - change the tag in admin-plane/airflow.bicep      -> FAILS (rule 1)
 *   - blank a `digest` in upstream-images.json         -> FAILS (rule 2)
 *   - delete the mirror step from either workflow      -> FAILS (rule 4)
 *   - restore each                                     -> passes
 *
 * Owner: FINISHLINE D14 / issue #2682 — supply chain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_REL = 'platform/fiab/images/upstream-images.json';
const MIRROR_SCRIPT_REL = 'scripts/ci/mirror-upstream-images.sh';

/**
 * The workflows that own an ACR image lane — one per cloud. Each MUST call the
 * shared mirror script. Listed explicitly (not discovered) so deleting a lane is
 * a deliberate edit here, not a silent loss of coverage.
 */
const IMAGE_LANE_WORKFLOWS = [
  '.github/workflows/full-app-deploy-commercial.yml',
  '.github/workflows/gov-provision-dataplane-images.yml',
];

/** Public registry hosts. mcr.microsoft.com is Microsoft first-party (see LIC0). */
const PUBLIC_REGISTRY_RE =
  /\b((?:docker\.io|index\.docker\.io|ghcr\.io|quay\.io|registry\.k8s\.io|public\.ecr\.aws|gcr\.io)\/[A-Za-z0-9._/-]+):([A-Za-z0-9._-]+)/g;

/**
 * BARE Docker Hub refs as a quoted bicep literal (`'apache/airflow:2.10.5'`) —
 * the ordinary spelling of a Docker Hub image, and exactly as much of an internet
 * pull as a qualified one. Namespace must contain no `.`/`:` (that would be a
 * registry host, handled above). Interpolated literals (`'${acr}/loom-x:v1'`) are
 * the deployment's OWN registry and are skipped by the caller.
 */
const BARE_DOCKERHUB_RE =
  /'([A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9._-]+)'/g;

/**
 * A repo with NO namespace (`'s3proxy:3.3.0'`) — how an ACR-side mirror target is
 * written when the upstream namespace is dropped (andrewgaul/s3proxy -> s3proxy).
 * Matched separately because it cannot be distinguished from an ordinary string by
 * shape alone, so it is only considered on lines that look like an image pin.
 */
const BARE_SINGLE_REPO_RE = /'([a-z0-9][a-z0-9._-]*):([A-Za-z0-9._-]+)'/g;
/** Only treat a single-token ref as an image when the line is an image pin. */
const IMAGE_PIN_LINE_RE = /\b(image|Image)\b/;

function listBicepFiles() {
  try {
    return execSync('git ls-files "platform/fiab/bicep/**/*.bicep" "platform/fiab/bicep/*.bicep"', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Skip comments and @description() prose — documentation is not a deployed image. */
function isProse(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('#') || line.includes('@description(');
}

function main() {
  const errors = [];
  const wantList = process.argv.includes('--list');

  // ── Load the manifest ─────────────────────────────────────────────────────
  const manifestAbs = path.join(REPO_ROOT, MANIFEST_REL);
  if (!fs.existsSync(manifestAbs)) {
    console.error(`[upstream-image-mirror] FAIL — ${MANIFEST_REL} is missing. It is the single source of truth for every deploy-path upstream image (issue #2682).`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  } catch (e) {
    console.error(`[upstream-image-mirror] FAIL — ${MANIFEST_REL} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const images = Array.isArray(manifest.images) ? manifest.images : [];

  // rule 6a — the manifest must not be empty.
  if (images.length === 0) {
    errors.push(
      `${MANIFEST_REL} lists ZERO images. This tree deploys third-party images today; an empty manifest means ` +
        `the mirror covers nothing. If the tree genuinely stopped deploying every upstream image, delete this ` +
        `assertion in the same commit, deliberately.`,
    );
  }

  // rule 2/3 — digest present + well-formed; no floating tag.
  const byRef = new Map(); // "repo:tag" -> entry
  for (const img of images) {
    const where = `${MANIFEST_REL} entry "${img.acrRepo ?? '?'}"`;
    for (const k of ['acrRepo', 'tag', 'sourceRegistry', 'sourceRepo', 'digest', 'spdx']) {
      if (!img[k]) errors.push(`${where}: missing required field "${k}".`);
    }
    if (img.digest && !/^sha256:[0-9a-f]{64}$/.test(img.digest)) {
      errors.push(
        `${where}: digest "${img.digest}" is not a sha256 manifest digest. The import must be pinned — a mutable ` +
          `upstream tag can swap the bits under a reviewed licence and a passed CVE scan. Resolve it with ` +
          `scripts/ci/resolve-upstream-digest.sh ${img.sourceRepo ?? '<repo>'} ${img.tag ?? '<tag>'}.`,
      );
    }
    if (img.tag === 'latest') {
      errors.push(`${where}: pins the FLOATING tag ":latest". Pin an immutable version tag.`);
    }
    if (img.acrRepo && img.tag) byRef.set(`${img.acrRepo}:${img.tag}`, img);
  }

  // ── rule 1/5/6b — scan the bicep tree for pinned upstream refs ─────────────
  const bicepRefs = new Map(); // "repo:tag" -> [file:line]
  const publicRefs = [];       // registry-qualified refs on a deploy path
  for (const rel of listBicepFiles()) {
    let src;
    try { src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
    // PHYSICAL-LINES-OK: the corpus here is `.bicep`, which has no backslash line
    // continuation (#3420).
    src.split('\n').forEach((line, i) => {
      if (isProse(line)) return;
      const at = `${rel}:${i + 1}`;

      PUBLIC_REGISTRY_RE.lastIndex = 0;
      let m;
      while ((m = PUBLIC_REGISTRY_RE.exec(line)) !== null) {
        if (/^mcr\.microsoft\.com\//.test(`${m[1]}/`)) continue;
        publicRefs.push({ at, ref: `${m[1]}:${m[2]}` });
      }

      BARE_DOCKERHUB_RE.lastIndex = 0;
      while ((m = BARE_DOCKERHUB_RE.exec(line)) !== null) {
        if (m[0].includes('${')) continue; // the deployment's OWN ACR
        const key = `${m[1]}:${m[2]}`;
        if (!bicepRefs.has(key)) bicepRefs.set(key, []);
        bicepRefs.get(key).push(at);
      }

      if (IMAGE_PIN_LINE_RE.test(line)) {
        BARE_SINGLE_REPO_RE.lastIndex = 0;
        while ((m = BARE_SINGLE_REPO_RE.exec(line)) !== null) {
          if (m[0].includes('${')) continue;
          const key = `${m[1]}:${m[2]}`;
          // Only report a single-token ref when the manifest knows it — otherwise
          // an ordinary quoted 'key:value' string would masquerade as an image and
          // the guard would invent a dependency (the LIC0 phantom-import lesson).
          if (!byRef.has(key)) continue;
          if (!bicepRefs.has(key)) bicepRefs.set(key, []);
          bicepRefs.get(key).push(at);
        }
      }
    });
  }

  // rule 6b — the bicep scan must observe something.
  if (bicepRefs.size === 0 && publicRefs.length === 0) {
    errors.push(
      `the bicep upstream-image scan matched ZERO refs under platform/fiab/bicep. The far likelier cause is that ` +
        `the ref-matching regexes in ${path.relative(REPO_ROOT, __filename).replace(/\\/g, '/')} no longer recognise ` +
        `how images are written in this tree than that every third-party image was removed. A scan that observes ` +
        `nothing must never report success.`,
    );
  }

  // rule 5 — no public-registry host composed on a deploy path.
  for (const { at, ref } of publicRefs) {
    errors.push(
      `${at}: bicep pins the PUBLIC-REGISTRY ref "${ref}" on a deploy path. Every deploy-path image must be pulled ` +
        `from the estate ACR: record the upstream coordinate in ${MANIFEST_REL} and have the module compose ` +
        `\`\${acrLoginServer}/<repo>:<tag>\` (issue #2682). A runtime pull from a public registry gets no firewall ` +
        `lease, no Trivy scan, no cosign verification, and is unreachable in an air-gapped enclave.`,
    );
  }

  // rule 1 — every bicep-pinned ref must be in the manifest.
  for (const [ref, locations] of bicepRefs) {
    if (byRef.has(ref)) continue;
    errors.push(
      `${locations[0]}: bicep pins the upstream image "${ref}" but ${MANIFEST_REL} has no entry with that ` +
        `acrRepo:tag. The module composes \`\${acrLoginServer}/${ref}\`, so nothing imports that tag into the ` +
        `estate ACR and the Container App cannot activate a revision. Add the entry (with its resolved digest) ` +
        `in the same commit as the bicep bump.`,
    );
  }

  // ── rule 4 — both cloud lanes must call the shared mirror script ───────────
  const mirrorScriptAbs = path.join(REPO_ROOT, MIRROR_SCRIPT_REL);
  if (!fs.existsSync(mirrorScriptAbs)) {
    errors.push(`${MIRROR_SCRIPT_REL} is missing — it is the ONE mirror implementation both cloud lanes call.`);
  }
  for (const wf of IMAGE_LANE_WORKFLOWS) {
    const abs = path.join(REPO_ROOT, wf);
    if (!fs.existsSync(abs)) {
      errors.push(`${wf} is missing — it owns an ACR image lane and must mirror the upstream images into that cloud's registry.`);
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    // MATCH THE INVOCATION, NOT THE MENTION. A first cut of this check used
    // `src.includes(MIRROR_SCRIPT_REL)`, which the surrounding EXPLANATORY COMMENT
    // satisfied — deleting the actual `run:` line left the guard green. That is the
    // prose-matching blindness this repo has been burned by before: a guard whose
    // verdict does not CHANGE when you break the subject is not watching it. So:
    // drop every YAML comment line first, then require a real shell invocation.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const INVOKES_MIRROR = new RegExp(
      `(?:^|[\\s;&|])(?:bash|sh)\\s+${MIRROR_SCRIPT_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'm',
    );
    if (!INVOKES_MIRROR.test(code)) {
      errors.push(
        `${wf} does not INVOKE ${MIRROR_SCRIPT_REL} (a mention in a comment does not count — the check strips ` +
          `comments and looks for a real \`bash ${MIRROR_SCRIPT_REL}\` run step). Every cloud's image lane mirrors ` +
          `from the SAME manifest with the SAME digest-pinned implementation — a per-workflow hard-coded array is ` +
          `exactly the drift this guard exists to stop (the bicep ref, the Commercial array and the Gov array were ` +
          `three copies of one fact).`,
      );
    }
  }

  if (wantList) {
    for (const img of images) {
      console.log(`  ${`${img.acrRepo}:${img.tag}`.padEnd(38)} ${img.digest}  ${img.spdx}`);
      for (const c of img.consumers ?? []) console.log(`      <- ${c}`);
    }
  }

  if (errors.length) {
    console.error('[upstream-image-mirror] FAIL — MIR0 supply-chain gate (issue #2682):');
    for (const e of errors) console.error('   - ' + e);
    process.exit(1);
  }
  console.log(
    `[upstream-image-mirror] OK — ${images.length} upstream image(s) digest-pinned in ${MANIFEST_REL}; ` +
      `${bicepRefs.size} bicep-pinned ref(s) all covered; 0 public-registry refs on a deploy path; ` +
      `${IMAGE_LANE_WORKFLOWS.length} cloud lane(s) call ${MIRROR_SCRIPT_REL}.`,
  );
}

// Run as a script, not as an import side effect (#3436). Without this,
// `import`ing this module to unit-test its helpers runs the WHOLE scan and can
// process.exit() inside the test runner — which surfaces as a runner that dies
// with no failed assertion, the same non-diagnostic shape as a `set -u` abort.
if (process.argv[1] && process.argv[1].endsWith('check-upstream-image-mirror.mjs')) {
  main();
}

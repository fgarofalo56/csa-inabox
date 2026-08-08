#!/usr/bin/env node
/**
 * GUARDRAIL: mcr-image-pins (MCR0) — merge-blocker
 * ---------------------------------------------------------------------------
 * RULE (FINISHLINE C18): every mcr.microsoft.com image a Loom DEPLOY PATH pulls
 *   must resolve to IMMUTABLE bits. Two deploys of the same commit must produce
 *   the same running software, or the build-marker SHA does not identify what is
 *   running and deploy-integrity.md R2/R3 are unenforceable.
 *
 * WHY A SECOND GUARD ALONGSIDE MIR0. check-upstream-image-mirror.mjs polices
 *   THIRD-PARTY registries (docker.io / ghcr.io / quay.io …) and requires them to
 *   be mirrored into the estate ACR. It skips mcr.microsoft.com on purpose — MCR
 *   is Microsoft first-party and is reachable from every boundary Loom deploys
 *   into, so the mirror requirement does not apply. But the skip was TOTAL:
 *   `if (/^mcr\.microsoft\.com\//…) continue;` meant no MCR ref was looked at at
 *   all. Four floated `:latest`, one on a default-ON path, and every one of them
 *   was baked into the shipped ARM artifact deploy-templates/main.json.
 *
 * WHAT IT ENFORCES
 *   1. Every MCR ref on a deploy path has an entry in
 *      platform/fiab/images/mcr-images.json.
 *   2. Every entry carries a real `sha256:<64hex>` manifest digest.
 *   3. Where `inlineDigest !== false`, the bicep/ARM ref must CARRY that digest
 *      inline (`repo:tag@sha256:…` or `repo@sha256:…`) and it must match the
 *      manifest byte-for-byte.
 *   4. Where `inlineDigest === false`, a written `inlineDigestBlockedBy` reason is
 *      required, and the ref must still carry a specific tag — never `latest`,
 *      never bare.
 *   5. ANTI-HOLLOW: the scan must observe at least `minObservedRefs` refs and the
 *      manifest must be non-empty. A scan that matches nothing must never report
 *      success — that is the failure mode this repo has been burned by most.
 *
 * KEYED ON THE *SAFE* PATTERN, NOT THE UNSAFE ONE. The obvious implementation is
 *   `grep ':latest'`. It is worthless: the moment someone adopts the fix and
 *   writes `:2.0.9`, the token the rule matched is gone and the guard goes quiet
 *   on exactly the files it just policed — while `:2.0.9` with no digest is still
 *   mutable, because MCR republishes rolling tags (`2.0`, `4-python3.11`) in
 *   place. So the rule is "a digest is PRESENT and matches the registry of
 *   record", which stays true of every ref forever and cannot be satisfied by
 *   deleting a substring. (memory: csa_loom_guard_keyed_to_the_unsafe_pattern.)
 *
 * MUTATION PROOF (how to confirm this guard is not hollow):
 *   - drop `@sha256:…` from any bicep ref              -> FAILS (rule 3)
 *   - write `:latest` on any ref                       -> FAILS (rule 1 or 4)
 *   - add a NEW `mcr.microsoft.com/foo/bar:1.0` ref    -> FAILS (rule 1)
 *   - corrupt a digest in the manifest                 -> FAILS (rule 2 or 3)
 *   - blank `inlineDigestBlockedBy` on the AML entry   -> FAILS (rule 4)
 *   - point the scan at a directory with no bicep      -> FAILS (rule 5)
 *   - restore each                                     -> passes
 *   scripts/ci/test-check-mcr-image-pins.sh runs every one of those.
 *
 * Owner: FINISHLINE C18 — supply chain / deploy determinism.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_REL = 'platform/fiab/images/mcr-images.json';

/**
 * The trees a deploy reads from. `platform/fiab/bicep` is the orchestrator;
 * `deploy/bicep` holds the DLZ/tutorial modules docs tell an operator to
 * `az deployment group create` by hand (docs/tutorials/11-data-api-builder), which
 * is a customer-followed deploy path even though CI never runs it; and
 * `apps/fiab-console/deploy-templates/main.json` is THE SHIPPED ARM ARTIFACT — the
 * literal bytes a from-scratch deploy submits. Scanning the compiled artifact as
 * well as its source means a hand-edit to main.json cannot slip a floating ref
 * past the guard even though check-deploy-template-sync.mjs would also catch it.
 */
const SCAN_GLOBS = [
  'platform/fiab/bicep/**/*.bicep',
  'platform/fiab/bicep/*.bicep',
  'deploy/bicep/**/*.bicep',
  'apps/fiab-console/deploy-templates/*.json',
];

/**
 * repo  = everything after the host up to `:` / `@` / the closing quote
 * tag   = optional `:<tag>`
 * digest= optional `@sha256:<64hex>`
 */
const MCR_REF_RE =
  /mcr\.microsoft\.com\/([A-Za-z0-9][A-Za-z0-9._/-]*?)(?::([A-Za-z0-9][A-Za-z0-9._-]*))?(?:@(sha256:[0-9a-f]{64}))?(?=['"\s,}\\)]|$)/g;

/** Skip comments and @description() prose — documentation is not a deployed image. */
function isProse(line) {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('#') ||
    line.includes('@description(') ||
    // JSON manifest/ARM metadata prose blocks
    /"\$comment"|"description"\s*:/.test(line)
  );
}

function listFiles(root) {
  try {
    const args = SCAN_GLOBS.map((g) => `"${g}"`).join(' ');
    return execSync(`git ls-files ${args}`, { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function scan(root) {
  /** @type {{at:string, repo:string, tag:string|null, digest:string|null, raw:string}[]} */
  const refs = [];
  for (const rel of listFiles(root)) {
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    src.split('\n').forEach((line, i) => {
      if (isProse(line)) return;
      MCR_REF_RE.lastIndex = 0;
      let m;
      while ((m = MCR_REF_RE.exec(line)) !== null) {
        const [raw, repo, tag, digest] = m;
        // A trailing `/` with nothing after it is prose that escaped isProse.
        if (!repo || repo.endsWith('/')) continue;
        refs.push({ at: `${rel}:${i + 1}`, repo, tag: tag ?? null, digest: digest ?? null, raw });
      }
    });
  }
  return refs;
}

export function evaluate({ root, manifest, refs }) {
  const errors = [];
  const images = Array.isArray(manifest?.images) ? manifest.images : [];
  const minObserved = Number.isInteger(manifest?.minObservedRefs) ? manifest.minObservedRefs : 1;

  if (images.length === 0) {
    errors.push(
      `${MANIFEST_REL} lists ZERO images. This tree deploys MCR images today; an empty registry means the guard ` +
        `covers nothing. If the tree genuinely stopped deploying every MCR image, delete this assertion in the ` +
        `same commit, deliberately.`,
    );
  }

  // rule 2 / 4 — the manifest itself must be well-formed.
  const byRepo = new Map();
  for (const img of images) {
    const where = `${MANIFEST_REL} entry "${img.repo ?? '?'}"`;
    if (!img.repo) {
      errors.push(`${where}: missing required field "repo".`);
      continue;
    }
    if (!img.digest || !/^sha256:[0-9a-f]{64}$/.test(img.digest)) {
      errors.push(
        `${where}: digest "${img.digest ?? '(none)'}" is not a sha256 manifest digest. Resolve it with ` +
          `\`bash scripts/ci/resolve-mcr-digest.sh ${img.repo} ${img.tag ?? '<tag>'}\`.`,
      );
    }
    if (img.tag === 'latest') {
      errors.push(
        `${where}: records the FLOATING tag ":latest". Record the specific version tag the digest belongs to, ` +
          `or null when upstream publishes no version tag (then the ref is digest-only).`,
      );
    }
    if (img.inlineDigest === false) {
      if (!img.inlineDigestBlockedBy || String(img.inlineDigestBlockedBy).trim().length < 40) {
        errors.push(
          `${where}: sets inlineDigest:false — the only escape hatch from a digest pin — but gives no written ` +
            `"inlineDigestBlockedBy" reason (or one too short to be a reason). State which ARM resource type ` +
            `cannot take a digest and why that is not merely untested.`,
        );
      }
      if (!img.tag) {
        errors.push(
          `${where}: sets inlineDigest:false, so the ref falls back to a TAG — but no tag is recorded. An entry ` +
            `with neither an inline digest nor a tag pins nothing.`,
        );
      }
    }
    byRepo.set(img.repo, img);
  }

  // rule 5 — anti-hollow. Do this BEFORE the per-ref rules so a broken regex
  // reports as a broken regex rather than as a clean tree.
  if (refs.length < minObserved) {
    errors.push(
      `the MCR ref scan observed ${refs.length} ref(s) across ${SCAN_GLOBS.join(', ')}, below the floor of ` +
        `${minObserved} recorded in ${MANIFEST_REL}. The far likelier cause is that the ref regex or the scan ` +
        `globs no longer match how images are written in this tree than that ${minObserved - refs.length} MCR ` +
        `image(s) were removed. A scan that observes nothing must never report success. If the removal is real, ` +
        `lower "minObservedRefs" in the same commit, deliberately.`,
    );
  }

  // rule 1 / 3 / 4 — per-ref.
  for (const ref of refs) {
    const img = byRepo.get(ref.repo);
    if (!img) {
      errors.push(
        `${ref.at}: deploy path pulls "mcr.microsoft.com/${ref.repo}${ref.tag ? `:${ref.tag}` : ''}" but ` +
          `${MANIFEST_REL} has no entry for repo "${ref.repo}". Every MCR image a deploy path pulls is pinned ` +
          `there with its resolved digest. Add the entry (resolve-mcr-digest.sh) in the same commit as the ref.`,
      );
      continue;
    }

    if (img.inlineDigest === false) {
      // Tag-only fallback: the tag must be present, specific, and match the record.
      if (!ref.digest && ref.tag !== img.tag) {
        errors.push(
          `${ref.at}: ref tag "${ref.tag ?? '(none)'}" does not match ${MANIFEST_REL} tag "${img.tag}" for ` +
            `"${ref.repo}". This entry is on the inlineDigest:false fallback, so the TAG is the whole pin — it ` +
            `has to be the tag whose digest was recorded, or the record proves nothing.`,
        );
      }
      continue;
    }

    if (!ref.digest) {
      errors.push(
        `${ref.at}: "mcr.microsoft.com/${ref.repo}${ref.tag ? `:${ref.tag}` : ''}" carries NO @sha256 digest, so ` +
          `the running bytes are whatever the tag points at on the day of the deploy. Two deploys of the same ` +
          `commit can then produce different software. Write it as ` +
          `\`mcr.microsoft.com/${ref.repo}${img.tag ? `:${img.tag}` : ''}@${img.digest}\`. ` +
          `(A version tag alone is NOT enough: MCR republishes rolling tags like "2.0" and "4-python3.11" in place.)`,
      );
      continue;
    }
    if (ref.digest !== img.digest) {
      errors.push(
        `${ref.at}: pins digest "${ref.digest}" but ${MANIFEST_REL} records "${img.digest}" for "${ref.repo}". ` +
          `The bicep ref and the registry of record must move together — bump both in one commit.`,
      );
    }
    if (ref.tag && img.tag && ref.tag !== img.tag) {
      errors.push(
        `${ref.at}: ref tag "${ref.tag}" does not match ${MANIFEST_REL} tag "${img.tag}" for "${ref.repo}". The ` +
          `digest decides what runs, so a stale tag beside it is a lie to the next reader — the exact class of ` +
          `false statement deploy-integrity.md R7 forbids.`,
      );
    }
    if (ref.tag === 'latest') {
      errors.push(
        `${ref.at}: writes ":latest" beside the digest. The digest wins at runtime, but the text tells the next ` +
          `reader this ref floats. Use the version tag the digest belongs to (or no tag at all).`,
      );
    }
  }

  // Dead entries rot into false assurance — a reviewer reads the manifest as the
  // inventory of what deploys. Report, don't merely tidy.
  const seenRepos = new Set(refs.map((r) => r.repo));
  for (const img of images) {
    if (img.repo && !seenRepos.has(img.repo)) {
      errors.push(
        `${MANIFEST_REL} entry "${img.repo}" is not pulled by any scanned deploy path. Either the ref was removed ` +
          `(drop the entry) or the scan no longer sees it (fix the scan) — a registry that lists images nothing ` +
          `deploys reads as coverage it does not have.`,
      );
    }
  }

  return errors;
}

function main() {
  const root = process.env.MCR_PINS_ROOT ? path.resolve(process.env.MCR_PINS_ROOT) : REPO_ROOT;
  const manifestAbs = path.join(root, MANIFEST_REL);

  if (!fs.existsSync(manifestAbs)) {
    console.error(
      `[mcr-image-pins] FAIL — ${MANIFEST_REL} is missing. It is the registry of record for every MCR image a ` +
        `deploy path pulls (FINISHLINE C18).`,
    );
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  } catch (e) {
    console.error(`[mcr-image-pins] FAIL — ${MANIFEST_REL} is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const refs = scan(root);
  const errors = evaluate({ root, manifest, refs });

  if (process.argv.includes('--list')) {
    for (const r of refs.sort((a, b) => a.at.localeCompare(b.at))) {
      console.log(
        `  ${r.at.padEnd(64)} ${r.repo}${r.tag ? `:${r.tag}` : ''}${r.digest ? `@${r.digest}` : '  <-- NO DIGEST'}`,
      );
    }
  }

  if (errors.length) {
    console.error('[mcr-image-pins] FAIL — MCR0 deploy-determinism gate (FINISHLINE C18):');
    for (const e of errors) console.error('   - ' + e);
    process.exit(1);
  }

  const pinned = refs.filter((r) => r.digest).length;
  console.log(
    `[mcr-image-pins] OK — ${refs.length} MCR ref(s) on deploy paths; ${pinned} carry an inline @sha256 digest; ` +
      `${refs.length - pinned} on the documented inlineDigest:false tag fallback; ` +
      `${(manifest.images ?? []).length} entr(ies) in ${MANIFEST_REL}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

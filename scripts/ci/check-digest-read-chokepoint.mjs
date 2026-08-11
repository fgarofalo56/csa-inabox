#!/usr/bin/env node
/**
 * check-digest-read-chokepoint.mjs
 *
 * RULE. Reading an image's manifest DIGEST from ACR goes through
 * scripts/ci/resolve-acr-digest.sh. A raw `az acr repository show … --query
 * digest` (or `az acr manifest show-metadata … --query digest`) anywhere else is
 * a violation.
 *
 * WHY (#3166, and the ratchet trap it names).
 *
 * resolve-acr-digest.sh keeps three states apart that a single-shot read cannot:
 *
 *     exit 0  digest on stdout
 *     exit 3  the registry ANSWERED and the tag is genuinely absent
 *     exit 4  the registry could not be READ — NOT proof the tag is missing
 *
 * That distinction is the whole #2980/#2982 defect class: a locked firewall or a
 * throttled read rendered as "the tag does not exist", which refuses a deploy and
 * sends the operator to rebuild images that were fine.
 *
 * #3166's sharpest observation is not that fourteen call sites bypassed the
 * resolver — it is that NOTHING COULD TELL:
 *
 *     loom-guardrails.yml ran exactly one thing:
 *       - name: acr-digest resolver self-test (fails closed — #2980)
 *         run: bash scripts/ci/test-resolve-acr-digest.sh
 *
 *     "That proves the resolver WORKS. Nothing anywhere proves the resolver is
 *      USED. All 14 bypassing call sites sail through guardrails green, forever."
 *
 * This rule is the missing half. Measured 2026-08-11 after #3215: adoption went
 * from 2 workflows to 7, and raw digest reads from 14 to 0.
 *
 * NOT A DIGEST READ, and deliberately not matched:
 *   * `az acr repository show-tags` — lists tags for a diagnostic message. A
 *     different operation; the resolver cannot express it. scripts/csa-loom/
 *     preflight-image-tags.sh uses it ONLY after the resolver has already
 *     answered ABSENT, and captures its own read.
 *   * `az acr repository show` without `--query digest` — existence/metadata.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds no reference to
 * the resolver at all — this repo's roll and preflight paths depend on it, so
 * zero means the matcher drifted off the code.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RESOLVER = 'resolve-acr-digest.sh';

/** Population = what git tracks, never a filesystem walk (scratch worktrees). */
function tracked() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', '*.yml', '*.yaml', '*.sh', '*.mjs'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error(
      `::error::digest-read-chokepoint: could not ask git for the tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// The resolver itself, its self-test, and anything under __tests__ are exempt:
// they ARE the implementation and its proof.
const EXEMPT = /(^|\/)(scripts\/ci\/resolve-acr-digest\.sh|scripts\/ci\/test-resolve-acr-digest\.sh)$|__tests__|\/tests\//;

// A DIGEST read: the az command AND a digest projection on the same command.
const DIGEST_CMD = /az\s+acr\s+(?:repository\s+show|manifest\s+show-metadata)\b/;
const DIGEST_QUERY = /--query\s+["']?(?:\.)?digest["']?|\.digest\b|"digest"/;

const files = tracked();
const violations = [];
let resolverRefs = 0;

for (const rel of files) {
  if (EXEMPT.test(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes(RESOLVER)) resolverRefs++;
  if (!DIGEST_CMD.test(text)) continue;

  text.split(/\r?\n/).forEach((raw, i) => {
    // Prose about the rule is not the rule. Comment markers for yml/sh (#) and
    // js (// or *) — only when they LEAD the line, so an inline `#` in a string
    // is never mistaken for a comment.
    if (/^\s*(#|\/\/|\*)/.test(raw)) return;
    if (!DIGEST_CMD.test(raw)) return;
    if (!DIGEST_QUERY.test(raw)) return; // existence/metadata read, not a digest
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 150) });
  });
}

if (files.length === 0) {
  console.error('::error::digest-read-chokepoint: scanned ZERO tracked files. Refusing to report a pass.');
  process.exit(1);
}
if (resolverRefs === 0) {
  console.error(
    `::error::digest-read-chokepoint: found ZERO references to ${RESOLVER} in ${files.length} tracked files. ` +
      "This repo's roll and image-preflight paths depend on it, so zero means the matcher has drifted off the " +
      'code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

// ── RATCHET, not a cliff ───────────────────────────────────────────────────
//
// Nine sites predate this rule and they are NOT all naive. Three shapes exist:
//
//   * genuinely single-shot   e.g. build-fiab-images-acr-tasks.yml:474
//   * captures RC but collapses unreadable -> "" (the #2980 class)
//                             e.g. deploy-loom-sharing.yml:254
//   * captures RC AND calls deploy-classify.mjs — already correct by hand
//                             e.g. gov-build-images.yml:378
//
// Failing all nine today would make guardrails red for everyone and would say
// the third group is wrong when it is not. A per-file baseline that can only
// SHRINK is the repo's established answer (workflow-actionlint-baseline.json):
// new bypasses are blocked, existing debt is recorded where it can be seen, and
// converting one is a one-line baseline edit.
const BASELINE_FILE = new URL('./digest-read-baseline.json', import.meta.url);
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).entries || {};
} catch {
  console.error(
    '::error::digest-read-chokepoint: could not read digest-read-baseline.json. Refusing to run without the ' +
      'recorded debt — without it every pre-existing site reads as a new violation and the rule is unusable.',
  );
  process.exit(1);
}

const byFile = {};
for (const v of violations) byFile[v.file] = (byFile[v.file] || 0) + 1;

const grew = [];
const shrank = [];
for (const [file, n] of Object.entries(byFile)) {
  const allowed = baseline[file] || 0;
  if (n > allowed) grew.push({ file, n, allowed });
}
for (const [file, allowed] of Object.entries(baseline)) {
  const n = byFile[file] || 0;
  if (n < allowed) shrank.push({ file, n, allowed });
}

if (shrank.length > 0) {
  console.error(
    '::error::digest-read-chokepoint: the baseline is STALE (it must only shrink). Sites were converted to the ' +
      'resolver without updating digest-read-baseline.json, so the recorded debt now overstates reality and would ' +
      'tolerate a NEW bypass in its place.',
  );
  for (const s of shrank) console.error(`   - ${s.file}: baseline records ${s.allowed}, only ${s.n} remain`);
  process.exit(1);
}

if (grew.length > 0) {
  console.error(
    `::error::digest-read-chokepoint: ${grew.reduce((a, g) => a + (g.n - g.allowed), 0)} NEW raw manifest-digest read(s) bypass ${RESOLVER}. ` +
      'A single-shot read cannot tell "the registry ANSWERED and the tag is absent" from "the registry could not ' +
      'be READ" — and rendering the second as the first refuses a deploy and sends the operator to rebuild images ' +
      'that were fine (#2980/#2982). Use the resolver: exit 0 = digest, 3 = absent, 4 = unknown.',
  );
  for (const g of grew) {
    console.error(`::error file=${g.file}::${g.n} digest read(s) here, baseline allows ${g.allowed}`);
    for (const v of violations.filter((x) => x.file === g.file)) {
      console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
    }
  }
  process.exit(1);
}

console.log(
  `digest-read-chokepoint OK — ${files.length} tracked file(s) scanned, ${resolverRefs} reference ${RESOLVER}; ` +
    `${violations.length} recorded pre-existing bypass(es), 0 new.`,
);

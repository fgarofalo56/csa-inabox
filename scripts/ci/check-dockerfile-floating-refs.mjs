#!/usr/bin/env node
/**
 * check-dockerfile-floating-refs.mjs
 *
 * RULE. A Dockerfile that fetches THIRD-PARTY SOURCE at build time must not
 * default its ref to a moving branch (`main`, `master`, `latest`, `HEAD`,
 * `develop`, `trunk`).
 *
 * WHY. Measured 2026-08-11 — apps/fiab-mcp-config/Dockerfile:
 *
 *     # Pinned to a known-good tag — bump explicitly with security review.
 *     ARG MS_MCP_REF=main
 *     RUN git clone --depth 1 --branch ${MS_MCP_REF} https://github.com/microsoft/mcp.git
 *
 * The comment says PINNED. The value is a branch. Every build pulled whatever
 * upstream's `main` happened to be at that moment, and the "security review"
 * the comment promises had nothing fixed to review.
 *
 * It broke the image producer: build-fiab-images-acr-tasks failed on loom-mcp
 * across ~40 projects with
 *
 *     error NU1103: Unable to find a stable package Microsoft.NET.ILLink.Tasks
 *       with version (>= 10.0.11)
 *       - Found 100 version(s) [ Nearest version: 11.0.0-preview.1.26104.118 ]
 *
 * — an upstream dependency move that arrived without a single commit in this
 * repo. The previous run of the same workflow had passed. Reproducibility was
 * lost too: the last green build cannot be reconstructed, because the ref it
 * built is not recorded anywhere.
 *
 * THIS IS THE COMMENT-VS-REALITY CLASS. A comment asserting a property the code
 * does not have is worse than no comment: it is the thing a reviewer reads
 * INSTEAD of the value. Same shape as an error message asserting a cause the
 * code never established (deploy-integrity R7).
 *
 * NARROW BY DESIGN. Only Dockerfiles that actually FETCH third-party source
 * (`git clone`, or curl/wget from a code-hosting domain) are judged. A base
 * image tag is covered by other rules, and an ARG that is not used to fetch
 * source is not this bug.
 *
 * SELF-DEFENCE. Fails if it scans no Dockerfiles at all.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

function trackedDockerfiles() {
  try {
    return execFileSync('git', ['ls-files', '--', '*Dockerfile', '*Dockerfile.*', '*/Dockerfile'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::dockerfile-floating-refs: could not ask git for tracked Dockerfiles (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

const EXEMPT = new Set(['scripts/ci/check-dockerfile-floating-refs.mjs']);

/** Does this Dockerfile fetch third-party SOURCE at build time? */
/**
 * MUST match `git fetch` / `git remote add`, not just `git clone`.
 *
 * The first version matched only `clone` - and the very first fix this guard
 * motivated replaced `git clone --branch` with `git init` + `git remote add` +
 * `git fetch` (because `--branch` cannot take a SHA). That silently dropped the
 * file out of the guard's population, and reverting the pin to `main` afterwards
 * produced exit 0.
 *
 * The guard went blind on exactly the file it was written for, by way of its own
 * fix. Keying a rule to the shape of the CURRENT code rather than to the PROPERTY
 * being enforced is how that happens every time.
 *
 * And then it happened AGAIN one step later: `git\s+(?:clone|fetch)` still
 * required adjacency, while the real line reads `git -C ms-mcp fetch`. Hence
 * `git` … `clone|fetch` anywhere on the line - matching the PROPERTY (this
 * Dockerfile pulls source over git) rather than a spelling of it.
 */
const FETCHES_SOURCE = /\bgit\b[^\n]*\b(?:clone|fetch)\b|\bgit\b[^\n]*\bremote\s+add\b|\b(?:curl|wget)\b[^\n]*\b(?:github\.com|gitlab\.com|codeload\.github\.com)\b/;

/** An ARG naming a ref, defaulting to something that MOVES. */
const FLOATING_ARG = /^\s*ARG\s+([A-Za-z0-9_]*(?:REF|VERSION|TAG|BRANCH|COMMIT|SHA))\s*=\s*["']?(main|master|latest|HEAD|develop|trunk)["']?\s*$/i;

const files = trackedDockerfiles();
if (files.length === 0) {
  console.error(
    '::error::dockerfile-floating-refs: git tracks ZERO Dockerfiles. This repo ships many, so the matcher has ' +
      'drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

const violations = [];
let fetchers = 0;

for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (!FETCHES_SOURCE.test(text)) continue;
  fetchers++;

  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const m = FLOATING_ARG.exec(raw);
    if (!m) return;
    violations.push({ file: rel, line: i + 1, arg: m[1], value: m[2], text: raw.trim().slice(0, 120) });
  });
}

// ── RATCHET, not a cliff ────────────────────────────────────────────────────
//
// apps/fiab-mcp-config/Dockerfile is CURRENTLY failing because of this defect,
// and the correct pin could not be determined from here: the GitHub tags API for
// microsoft/mcp is blocked by that org's SAML enforcement, and the last GREEN
// upstream ref is unrecoverable — precisely BECAUSE it was floating, nothing
// recorded what each build cloned. `git ls-remote` resolves today's main
// (10b11ea0), but that is the ref the failing build already used, so pinning to
// it would freeze the breakage rather than fix it.
//
// Recording it here rather than hard-failing keeps guardrails usable while
// making the debt visible on every run, and blocks a SECOND floating ref. It is
// a shrink-only baseline: fixing this site without updating the file fails.
// Tracked in #3258.
// EMPTY, and it must stay that way. The single recorded site
// (apps/fiab-mcp-config/Dockerfile, ARG MS_MCP_REF=main) was pinned to a
// verified commit SHA in the same change that emptied this. Any entry added
// back is new debt and needs its own justification.
const BASELINE = {};

const byFile = {};
for (const v of violations) byFile[v.file] = (byFile[v.file] || 0) + 1;

const shrank = Object.entries(BASELINE).filter(([f, n]) => (byFile[f] || 0) < n);
if (shrank.length > 0) {
  console.error(
    '::error::dockerfile-floating-refs: the baseline is STALE (it must only shrink). A site was pinned without ' +
      'updating BASELINE in this file, so the recorded debt overstates reality and would tolerate a NEW floating ' +
      'ref in its place.',
  );
  for (const [f, n] of shrank) console.error(`   - ${f}: baseline records ${n}, only ${byFile[f] || 0} remain`);
  process.exit(1);
}

const newOnes = violations.filter((v) => (byFile[v.file] || 0) > (BASELINE[v.file] || 0) || !(v.file in BASELINE));

if (newOnes.length > 0) {
  console.error(
    `::error::dockerfile-floating-refs: ${violations.length} Dockerfile ARG(s) default a third-party source ref to a ` +
      'MOVING branch. Every build then pulls whatever upstream happens to be at that moment: the image is not ' +
      'reproducible, an upstream change breaks the build with no commit in this repo, and a "bump explicitly with ' +
      'security review" comment has nothing fixed to review. Measured on loom-mcp (NU1103 across ~40 projects, ' +
      'from an upstream dependency move). Pin to a TAG or a COMMIT SHA.',
  );
  for (const v of newOnes) {
    console.error(`::error file=${v.file},line=${v.line}::${v.arg} defaults to '${v.value}' — pin to a tag or SHA`);
  }
  process.exit(1);
}

console.log(
  `dockerfile-floating-refs OK — ${files.length} tracked Dockerfile(s) scanned, ${fetchers} fetch third-party source; ` +
    `${violations.length} recorded pre-existing floating ref(s) (#3258), 0 new.`,
);

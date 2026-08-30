#!/usr/bin/env node
/**
 * check-cosign-install-retry-adoption.mjs
 *
 * RULE. A workflow that installs cosign goes through
 * scripts/ci/cosign-install-retry.sh — never a bare `sigstore/cosign-installer`
 * step.
 *
 * WHY (loom-roll-and-validate run 33138606218, 2026-08-28).
 *
 *   INFO: Downloading bootstrap version 'v3.0.6' of cosign to verify version …
 *   curl: (35) Recv failure: Connection reset by peer
 *   ##[error]Process completed with exit code 35.
 *
 * Those are the only two `##[error]` lines in that entire run. The roll never
 * reached a gate and a HEALTHY image was reverted, because a binary download from
 * github.com got a TCP reset. The action is a bare invocation whose only failure
 * mode is to fail the job, and it was used at SEVEN sites across SIX workflows —
 * three of them sovereign — with no retry at any of them (#4156).
 *
 * EVERY BOUNDARY (cloud-parity.md). The sites were the Commercial producer,
 * full-app-deploy-commercial (twice), loom-roll-and-validate, gov-build-images,
 * gov-console-roll and gov-provision-trino. This is the same distribution the
 * cosign-SIGN retry work already found, and that guard's docblock says why fixing
 * only Commercial is not a fix: it leaves the sovereign estates carrying exactly
 * the failure being removed.
 *
 * KEYED TO THE UNSAFE PATTERN. Counts `sigstore/cosign-installer` uses — never
 * "the absence of the helper". Adopting the helper REMOVES the action token, so a
 * presence-keyed rule would go quiet on precisely the files it had just fixed
 * (`guard_keyed_to_the_unsafe_pattern`, and the sibling guard's §KEYED TO THE
 * MISMATCH).
 *
 * NOT MATCHED, deliberately: `cosign verify` and `cosign sign`. Those are other
 * guards' subjects (check-cosign-sign-retry-adoption.mjs) and have different
 * failure modes. This one is only about getting the binary onto the runner.
 *
 * SELF-DEFENCE. Fails on an empty tracked-file list AND on a zero cosign-install
 * population. If no workflow installs cosign at all, this matcher has drifted off
 * the code — every image producer in this repo signs, so they all need the binary.
 * A guard reporting a pass over nothing is the failure this repo has measured
 * most often.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const HELPER = 'cosign-install-retry.sh';
const ACTION = 'sigstore/cosign-installer';

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::cosign-install-retry-adoption: could not ask git for tracked workflows (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

const files = tracked();
if (files.length === 0) {
  console.error('::error::cosign-install-retry-adoption: scanned ZERO tracked workflows. Refusing to report a pass.');
  process.exit(1);
}

const violations = [];
let helperRefs = 0;
let installPopulation = 0;

for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }

  const usesHelper = text.includes(HELPER);
  const usesAction = text.includes(ACTION);
  if (usesHelper) helperRefs++;
  if (usesHelper || usesAction) installPopulation++;
  if (!usesAction) continue;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const at = raw.indexOf(ACTION);
    if (at < 0) continue;
    // A comment or a prose mention is not an invocation. Positional, so an
    // explanation written AFTER the token on a `uses:` line still counts as the
    // invocation it is — the same reasoning the sibling applies to annotations.
    const before = raw.slice(0, at);
    if (/^\s*#/.test(raw)) continue;
    if (!/\buses\s*:/.test(before)) continue;
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 140) });
  }
}

if (installPopulation === 0) {
  console.error(
    `::error::cosign-install-retry-adoption: found ZERO workflows that install cosign across ${files.length} tracked workflow(s). ` +
      'Every image producer in this repo signs keylessly and therefore needs the binary, so zero means this matcher has ' +
      'drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::cosign-install-retry-adoption: ${violations.length} bare \`${ACTION}\` step(s) bypass ${HELPER}. ` +
      'That action is a single-attempt binary download from github.com: on 2026-08-28 a TCP reset during it ' +
      'reverted a HEALTHY image on a P0 roll (run 33138606218), and the run never reached a gate. ' +
      'Note this is NOT a signature finding — when the installer fails, nothing was verified either way. Use: ' +
      'run: bash scripts/ci/cosign-install-retry.sh --version v2.6.1',
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `cosign-install-retry-adoption OK — ${files.length} tracked workflow(s) scanned, ` +
    `${installPopulation} install cosign, ${helperRefs} reference ${HELPER}, 0 bare \`${ACTION}\`.`,
);

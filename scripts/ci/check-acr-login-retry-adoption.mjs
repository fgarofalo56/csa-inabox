#!/usr/bin/env node
/**
 * check-acr-login-retry-adoption.mjs
 *
 * RULE. `az acr login` in a workflow or script goes through
 * scripts/ci/acr-login-retry.sh. A bare invocation is a violation.
 *
 * WHY. The AAD→ACR token exchange has its OWN propagation window, separate from
 * the firewall's. Opening the registry and confirming the data plane answers
 * does NOT mean a token can be minted yet. Measured on roll 31494527960, whose
 * cosign gate failed ~2s after its own probe reported the network open:
 *
 *   [acr-dataplane-ready] READY after 1 attempt(s) — HTTP 401 from …azurecr.io
 *   WARNING: Unable to get AAD authorization tokens … CONNECTIVITY_REFRESH_TOKEN_ERROR
 *   Access to registry '…azurecr.io' was denied. Response code: 403.
 *   ERROR: Unable to authenticate using AAD or admin login credentials.
 *
 * That is a P0 by deploy-integrity.md R1 — the roll is a deploy path — and it
 * is a TRANSIENT dressed as a credential failure, which is the worst kind to
 * read cold.
 *
 * THE ADOPTION GAP THIS EXISTS TO CLOSE. acr-login-retry.sh was written for
 * exactly this failure (#3230) and wired into ONE call site. Thirteen workflows
 * adopted it; three kept a bare `az acr login`, including the roll's cosign gate
 * — so the fix was in the repo, and the failure it prevents happened anyway.
 * This is the `guard_adoption_gap` shape: the correct helper exists, the
 * siblings never adopt it, and nothing notices because the helper's own
 * self-test passes.
 *
 * KEYED TO THE MISMATCH, NOT THE UNSAFE STRING. The rule counts `az acr login`
 * invocations that are NOT on a line invoking the helper. It deliberately does
 * not match "the absence of acr-login-retry.sh", because adopting the helper
 * REMOVES the `az acr login` token — a rule keyed that way would go quiet on
 * exactly the files that were fixed (`guard_keyed_to_the_unsafe_pattern`).
 * Mutation: reinstate a bare `az acr login` anywhere and this fails.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds NO reference
 * to the helper at all — this repo's build and roll paths depend on it, so zero
 * means the matcher drifted off the code rather than that the repo is clean.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const HELPER = 'acr-login-retry.sh';

/** Population = what git tracks, never a filesystem walk (scratch worktrees). */
function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '*.yml', '*.yaml', '*.sh'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::acr-login-retry-adoption: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

// The helper IS the implementation; its self-test and the guard that reads for
// the string are its proof. All three legitimately contain `az acr login`.
const EXEMPT = new Set([
  'scripts/ci/acr-login-retry.sh',
  'scripts/ci/test-acr-login-retry.sh',
  'scripts/ci/check-acr-login-retry-adoption.mjs',
  'scripts/ci/check-acr-reachability-oracle.mjs',
]);

const files = tracked();
const violations = [];
let helperRefs = 0;

for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes(HELPER)) helperRefs++;
  if (!text.includes('az acr login')) continue;

  text.split(/\r?\n/).forEach((raw, i) => {
    // PROSE ABOUT THE RULE IS NOT THE RULE. Three shapes, each of which the
    // first version of this guard flagged — it reported loom-guardrails.yml's
    //   - name: 'acr-reachability-oracle (az acr login is a credential, not a probe)'
    // as a bare login, which is a step TITLE describing this very class of bug.
    // A guard that cries wolf about its own documentation gets skimmed, and a
    // skimmed guard is the one whose real finding is missed.
    if (/^\s*#/.test(raw)) return; // leading comment (never an inline `#`)
    if (/^\s*-?\s*(name|description|title|summary):/.test(raw)) return; // YAML key
    if (/^\s*echo\b/.test(raw)) return; // a message, not an invocation
    if (/::(error|warning|notice)::/.test(raw)) return; // an annotation string
    if (!/\baz\s+acr\s+login\b/.test(raw)) return;
    // A line that invokes the helper is the adoption, not a bypass.
    if (raw.includes(HELPER)) return;
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 140) });
  });
}

if (files.length === 0) {
  console.error('::error::acr-login-retry-adoption: scanned ZERO tracked files. Refusing to report a pass.');
  process.exit(1);
}
if (helperRefs === 0) {
  console.error(
    `::error::acr-login-retry-adoption: found ZERO references to ${HELPER} in ${files.length} tracked files. ` +
      "This repo's build and roll paths depend on it, so zero means the matcher has drifted off the code. " +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::acr-login-retry-adoption: ${violations.length} bare \`az acr login\` invocation(s) bypass ${HELPER}. ` +
      'The AAD→ACR token exchange has its own propagation window AFTER the firewall opens — a confirmed-reachable ' +
      'data plane does not mean a token can be minted yet. Run 31494527960 failed a roll this way ~2s after its ' +
      'own probe reported READY, with CONNECTIVITY_REFRESH_TOKEN_ERROR / 403. Use: ' +
      'bash scripts/ci/acr-login-retry.sh --acr "$ACR_NAME"',
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `acr-login-retry-adoption OK — ${files.length} tracked file(s) scanned, ${helperRefs} reference ${HELPER}, ` +
    '0 bare `az acr login`.',
);

#!/usr/bin/env node
/**
 * A lane that produces a REQUIRED status check must render a verdict for
 * EVERY commit on main. (refs #3426, #3423, #3368)
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ────────────────────────────────────────
 * `concurrency: { group: <workflow>-${{ github.ref }}, cancel-in-progress:
 * true }` looks like ordinary CI hygiene. On a PR it is: a new push supersedes
 * the old run and cancelling it saves minutes. On `main` it is a hole, because
 * every push to main shares `refs/heads/main` — so each merge CANCELS the
 * previous commit's run and that commit lands with no verdict at all.
 *
 * A cancelled run is not a pass and not a failure. It is an ABSENCE, and it
 * renders in `gh run list` as an unremarkable grey row that reads like
 * "superseded by a newer push" (the exact misreading #3368 and #3418 were
 * filed for). Measured on 2026-08-14, last 30 main runs per lane:
 *   test.yml 11 cancelled, loom-guardrails.yml 7, validate.yml 4.
 * Between them those three publish 12 of the 14 required contexts.
 *
 * #3423 was the same defect on trivy.yml and #3424 fixed that ONE lane without
 * a ratchet. The identical hole was sitting on the required lanes at the time.
 * Hence this guard.
 *
 * ── WHY IT KEYS ON release-please.yml ──────────────────────────────────────
 * Branch protection is the real source of truth, but reading it needs an admin
 * token this workflow does not have — and a guard that cannot reach its
 * evidence has verified nothing. `release-please.yml` already carries a
 * committed `REQUIRED` manifest of `"<context>|<producer>.yml"` pairs, kept in
 * sync because the release path DISPATCHES those producers. Keying on it means
 * a newly-added required context is covered automatically, with no allowlist
 * to go stale.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * For each producer workflow, at least one must hold:
 *   (a) no top-level `concurrency:` block  — nothing can cancel anything, or
 *   (b) `cancel-in-progress: false` literally, or
 *   (c) the `group:` expression contains `github.sha`.
 *
 * (c) is the one real lanes want, because (b) alone is NOT sufficient: GitHub
 * keeps only one PENDING run per concurrency group and cancels any other
 * pending run in it, so two quick merges can still lose a run. The sha has to
 * be in the group.
 *
 * Run: node scripts/ci/check-required-lane-concurrency.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const MANIFEST = path.join(WORKFLOWS, 'release-please.yml');

/** YAML comment stripping. A `#` starts a comment at line start or after whitespace. */
export function stripComments(line) {
  return String(line).replace(/(^|\s)#.*$/, '$1').trimEnd();
}

/**
 * The `"<context>|<producer>.yml"` pairs from release-please.yml's REQUIRED array.
 * @param {string} src
 * @returns {{context:string, workflow:string}[]}
 */
export function parseRequiredManifest(src) {
  const out = [];
  for (const raw of String(src).split(/\r?\n/)) {
    const line = stripComments(raw);
    const m = line.match(/^\s*"([^"|]+)\|([A-Za-z0-9._-]+\.ya?ml)"\s*$/);
    if (m) out.push({ context: m[1], workflow: m[2] });
  }
  return out;
}

/**
 * The top-level `concurrency:` block of a workflow, comments removed.
 * @param {string} src
 * @returns {{present:boolean, group:string|null, cancelInProgress:string|null}}
 */
export function parseConcurrency(src) {
  const lines = String(src).split(/\r?\n/);
  const at = lines.findIndex((l) => /^concurrency:\s*$/.test(stripComments(l)));
  if (at < 0) return { present: false, group: null, cancelInProgress: null };
  let group = null;
  let cancelInProgress = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = stripComments(lines[i]);
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break; // dedented back to a top-level key
    const g = line.match(/^\s+group:\s*(.+)$/);
    if (g) group = g[1].trim();
    const c = line.match(/^\s+cancel-in-progress:\s*(.+)$/);
    if (c) cancelInProgress = c[1].trim();
  }
  return { present: true, group, cancelInProgress };
}

/**
 * @param {{present:boolean, group:string|null, cancelInProgress:string|null}} c
 * @returns {{ok:boolean, why:string}}
 */
export function judge(c) {
  if (!c.present) return { ok: true, why: 'no concurrency block — nothing can cancel a run' };
  if (c.cancelInProgress === null || c.cancelInProgress === 'false')
    return { ok: true, why: 'cancel-in-progress is literally false' };
  if (c.group && c.group.includes('github.sha'))
    return { ok: true, why: 'group is per-SHA, so a later push cannot share it' };
  return {
    ok: false,
    why:
      `group ${JSON.stringify(c.group)} is not per-SHA and cancel-in-progress is ` +
      `${JSON.stringify(c.cancelInProgress)}, so a later push to the same ref CANCELS this commit's run`,
  };
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`::error::required-lane-concurrency: ${path.relative(REPO_ROOT, MANIFEST)} is missing — the required-context manifest cannot be read, so this guard has verified NOTHING.`);
    process.exit(1);
  }
  const manifest = parseRequiredManifest(readFileSync(MANIFEST, 'utf8'));

  // EMBEDDED CONTROL. A parser that silently matched zero rows would make this
  // guard pass forever while measuring nothing — the exact shape this repo has
  // been bitten by. 14 contexts are declared today; fewer means the manifest
  // moved or the parser broke, and either way the guard is not to be trusted.
  if (manifest.length < 14) {
    console.error(`::error::required-lane-concurrency: parsed only ${manifest.length} required contexts from release-please.yml (expected >= 14). The manifest format changed or the parser broke — FAILING rather than reporting a clean scan of nothing.`);
    process.exit(1);
  }

  const producers = [...new Set(manifest.map((m) => m.workflow))].sort();
  const contextsBy = (wf) => manifest.filter((m) => m.workflow === wf).map((m) => m.context);

  let failed = 0;
  for (const wf of producers) {
    const p = path.join(WORKFLOWS, wf);
    if (!existsSync(p)) {
      console.error(`::error::required-lane-concurrency: ${wf} is named in the REQUIRED manifest but does not exist. Its contexts (${contextsBy(wf).join(', ')}) have no producer.`);
      failed++;
      continue;
    }
    const c = parseConcurrency(readFileSync(p, 'utf8'));
    const v = judge(c);
    if (v.ok) {
      console.log(`  ok   ${wf} — ${v.why}`);
      continue;
    }
    failed++;
    console.error(`::error file=.github/workflows/${wf}::required-lane-concurrency: ${wf} publishes REQUIRED context(s) ${contextsBy(wf).join(', ')} but ${v.why}. Every merge to main would then cancel the previous commit's run, and that commit lands with NO verdict from a mandatory check — an absence, not a pass (#3426). Fix: put github.sha in the group for push/dispatch and cancel only on pull_request, e.g.\n  group: \${{ github.workflow }}-\${{ github.ref }}-\${{ github.event_name == 'pull_request' && 'pr' || github.sha }}\n  cancel-in-progress: \${{ github.event_name == 'pull_request' }}`);
  }

  console.log(`\nrequired contexts: ${manifest.length} across ${producers.length} producer workflow(s)`);
  if (failed) {
    console.error(`::error::required-lane-concurrency: ${failed} required-context lane(s) can cancel their own main-branch runs.`);
    process.exit(1);
  }
  console.log('required-lane-concurrency: every required-context lane renders a verdict per commit.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-required-lane-concurrency.mjs')) {
  main();
}

#!/usr/bin/env node
/**
 * reconcile-resolve.mjs — thin I/O shell around ./reconcile-policy.mjs.
 *
 * Every decision lives in reconcile-policy.mjs and is unit-tested in
 * scripts/ci/__tests__/reconcile-policy.test.mjs. This file only does I/O, in
 * the same shape as deploy-fiab-guard.mjs:
 *
 *   1. READ-ONLY: which region is the estate in?   (az group list)
 *   2. READ-ONLY: what images are actually running? (az containerapp list)
 *   3. Hand both to the pure functions.
 *   4. Write $GITHUB_ENV / $GITHUB_OUTPUT.
 *
 * It performs NO Azure writes. `az group list` and `az containerapp list` are
 * the only calls it makes.
 *
 * WHAT IT MAKES POSSIBLE
 * ----------------------
 * `deployAppsEnabled=true` is the flag that has to be set for
 * app-deployments.bicep to run and therefore for ANY LOOM_* env var to reach
 * the running Console. It was pinned false because turning it on would also
 * rewrite the Console image to `appImageTags.console`, whose default is 'v0.1'
 * in both bicep files, while production runs a commit-SHA tag.
 *
 * By exporting LOOM_<APP>_TAG for every RUNNING image, the
 * `readEnvironmentVariable(...)` calls this PR adds to commercial.bicepparam
 * resolve to exactly the tags already deployed, so the ARM PUT is a no-op for
 * every image and applies everything else. Only then is deployAppsEnabled
 * upgraded to true, and only on a schedule (a dispatch keeps whatever the
 * operator typed).
 *
 * Emitted outputs:
 *   region                the region to deploy into — MEASURED from the estate
 *                         or matched against it, never defaulted (refs #3029)
 *   region_source         'adopted' (from the estate) | 'input' (explicit, matched)
 *   deploy_apps_enabled   the FINAL value the az commands must use
 *   pinned_count / absent_count / unknown_count   for the step summary
 *
 * Emitted env (consumed by params/commercial.bicepparam at bicep-compile time):
 *   AZURE_LOCATION, LOOM_CONSOLE_TAG, LOOM_MCP_TAG, … (one per RUNNING image)
 *
 * Env in: GITHUB_EVENT_NAME, INPUT_REGION,
 *         CSA_LOOM_TOPOLOGY, CSA_LOOM_TARGET_SUBSCRIPTION,
 *         DEPLOY_SUB, BASE_DEPLOY_APPS_ENABLED
 *
 * Usage: node scripts/ci/reconcile-resolve.mjs
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  resolveRunningImageTags,
  resolveReconcileRegion,
  decideDeployApps,
  tagEnvLines,
  APP_IMAGE_TAGS,
} from './reconcile-policy.mjs';

const env = process.env;
const eventName = env.GITHUB_EVENT_NAME || '';
const topology = env.CSA_LOOM_TOPOLOGY || '';
const deploySub = env.DEPLOY_SUB || '';
// NO FALLBACK REGION (refs #3029). resolveReconcileRegion either measures the
// region from the estate, accepts an explicit input that matches it, or
// refuses. A default here is the whole defect: it is what let a "reconcile"
// aim at eastus2 while the estate was in centralus.
const requestedRegion = env.INPUT_REGION || '';

/**
 * The Azure CLI binary. #3704.
 *
 * WHAT THIS USED TO BE, and why it mattered. `const AZ = 'az'` with no override.
 * On Windows `az` is a `.cmd` shim that Node will not spawn without a shell, so
 * both reads below failed closed to `null` on a workstation — and this script is
 * the one that decides the estate's REGION and whether `deploy_apps_enabled`
 * upgrades from the safe `false` to `true`. Measured 2026-08-18, verifying
 * whether the 06:00 nightly would repair the estate after #3701:
 *
 *     $ GITHUB_EVENT_NAME=schedule DEPLOY_SUB=… node scripts/ci/reconcile-resolve.mjs
 *     ::warning::admin-RG list failed: spawnSync az ENOENT
 *     ::error::REGION REFUSED — could not list rg-csa-loom-admin-* resource groups
 *
 * …with `az account show` working in the same shell. The answer had to be
 * reconstructed by hand instead. A decision procedure that can only run inside
 * the job it gates can only ever be verified after the fact from logs, which is
 * how #3701 stayed invisible for three nightlies (deploy-integrity.md R4).
 *
 * Ten sibling scripts already carried this resolver; these two reads did not.
 * Verbatim the shape from `scripts/csa-loom/resolve-dlz-coordinates.mjs`.
 *
 * NO PRODUCTION CHANGE. On the ubuntu-latest runner `process.platform` is
 * `linux` and `LOOM_AZ_BIN` is unset, so this returns `'az'` exactly as before
 * and the shell branch below is not taken.
 *
 * NOT EXPORTED, for the reason `deploy-fiab-guard.mjs` records against its own
 * copy: this file runs its whole resolution at module scope (no
 * `invokedDirectly` fence — one that mis-resolved `process.argv[1]` would turn
 * the deploy's most consequential decision into a silent no-op), so importing it
 * to unit-test a one-line resolver would EXECUTE the resolution. The control in
 * `scripts/ci/__tests__/reconcile-resolve-az-bin.test.mjs` therefore SPAWNS this
 * script with `LOOM_AZ_BIN` pointed at a stub and reads which binary actually
 * ran — which proves the override reaches the spawn, not merely that a function
 * returns a string. A resolver nothing consults is the same defect in a hat.
 *
 * @returns {string} the executable name/path to spawn
 */
function azBinary() {
  if (env.LOOM_AZ_BIN) return env.LOOM_AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

/**
 * Run `az <args>` and parse its stdout as JSON.
 *
 * `shell` is enabled ONLY for a `.cmd`/`.bat` binary — the sibling's exact
 * condition, and the reason it exists (Node 20+ refuses to spawn a `.cmd`
 * without one). It is safe for these two calls specifically: neither `--query`
 * carries a shell metacharacter — no `|`, `>`, `&`, `$` — which is what forced
 * `deploy-fiab-guard.mjs` to keep `shell:false` and `resolve-dlz-coordinates.mjs`
 * to load its KQL from an `@file`. A JMESPath here that grows a `|` (a JMESPath
 * PIPE is legal syntax) would be mangled by cmd.exe into a shell pipe, so adopt
 * the `@file` pattern before adding one rather than relying on this note.
 *
 * `spawnSync` rather than `execFileSync` so a spawn failure (ENOENT) is a
 * returned `error` this function can report in the CLI's own terms, instead of a
 * throw whose message names node's internals.
 */
function azJson(args) {
  const bin = azBinary();
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: /\.(cmd|bat)$/i.test(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  // stderr is CARRIED, never discarded: "I could not reach it" must not become
  // "it is not there" (deploy-integrity.md R7).
  if (res.error) throw new Error(`${bin}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${bin} exited ${res.status}: ${String(res.stderr || '').slice(0, 300)}`);
  }
  return JSON.parse(res.stdout);
}

/** rg-csa-loom-admin-* names in scope. null on ANY failure = UNKNOWN, not empty. */
function listAdminRgs() {
  const args = ['group', 'list', '--query', "[?starts_with(name,'rg-csa-loom-admin-')].name", '-o', 'json'];
  if (deploySub) args.push('--subscription', deploySub);
  try {
    const v = azJson(args);
    return Array.isArray(v) ? v.map(String) : null;
  } catch (e) {
    console.log(`::warning::admin-RG list failed: ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
    return null;
  }
}

/**
 * The image every Container App in the admin RG is running.
 * null on ANY failure = UNKNOWN, kept distinct from "the estate has no apps".
 */
function listRunningContainers(rg) {
  const args = [
    'containerapp', 'list', '-g', rg,
    '--query', '[].{name:name, image:properties.template.containers[0].image}',
    '-o', 'json',
  ];
  if (deploySub) args.push('--subscription', deploySub);
  try {
    const v = azJson(args);
    return Array.isArray(v) ? v : null;
  } catch (e) {
    console.log(`::warning::container-app list failed: ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
    return null;
  }
}

function setOutput(key, value) {
  const file = env.GITHUB_OUTPUT;
  if (!file) { console.log(`[dry] out ${key}=${value}`); return; }
  appendFileSync(file, `${key}=${value}\n`);
}

function setEnv(line) {
  const file = env.GITHUB_ENV;
  if (!file) { console.log(`[dry] env ${line}`); return; }
  appendFileSync(file, `${line}\n`);
}

// ---- 1. region ------------------------------------------------------------
// dlz-attach targets an explicit new subscription and never reconciles a hub,
// so it keeps the workflow's own region handling untouched.
const adminRgs = topology === 'dlz-attach' ? [] : listAdminRgs();

const regionVerdict = resolveReconcileRegion({
  eventName,
  requestedRegion,
  adminRgNames: adminRgs,
});

if (regionVerdict.decision === 'refuse') {
  console.log(`::error::REGION REFUSED — ${regionVerdict.reason}`);
  process.exit(1);
}
const region = regionVerdict.region;
// Loud, before anything is submitted (refs #3029 fix 4): the region that was
// resolved, where it came from, and which resource group it therefore names.
console.log(
  `::notice::REGION = ${region} (source: ${regionVerdict.source}) — ${regionVerdict.reason} ` +
  `Every name this deploy derives follows from it: rg-csa-loom-admin-${region}, ` +
  `vnet-csa-loom-hub-${region}, uami-loom-console-${region}.`,
);
console.log(`[reconcile] region=${region} source=${regionVerdict.source} — ${regionVerdict.reason}`);
setOutput('region', region);
setOutput('region_source', regionVerdict.source);
setEnv(`AZURE_LOCATION=${region}`);

// ---- 2. running images ----------------------------------------------------
const adminRg = `rg-csa-loom-admin-${region}`;
const hubPresent = (adminRgs || []).includes(adminRg);

// Probe only when the RG is actually there. A first-run install has no estate
// to preserve, and calling `containerapp list` on a nonexistent RG would fail
// and be indistinguishable from a broken probe.
const containers = hubPresent ? listRunningContainers(adminRg) : [];
const resolution = resolveRunningImageTags(containers);

console.log(`[reconcile] hub RG ${adminRg} ${hubPresent ? 'present' : 'absent (first-run install)'}`);
setOutput('hub_present', String(hubPresent));
for (const entry of APP_IMAGE_TAGS) {
  const tag = resolution.pinned[entry.key];
  // Print repo:tag only. The registry host is a live-estate identifier and this
  // repository is public (docs-hygiene).
  if (tag) console.log(`[reconcile]   PIN   ${entry.key.padEnd(18)} ${entry.repo}:${tag}`);
}
if (resolution.absent.length) {
  console.log(
    `[reconcile]   not deployed (bicepparam default applies, an apps-enabled run CREATES them): ${resolution.absent.join(', ')}`,
  );
}
for (const u of resolution.unknown) {
  console.log(`::warning::[reconcile] UNKNOWN ${u.key}: ${u.why}`);
}
// #4240 — THE SURFACE THE TITLE IS ABOUT. A shared-repo follower that is not on
// its canonical's tag does NOT freeze this reconcile: the key still pins from
// the canonical app, `unknown` stays empty, and `deployAppsEnabled` is
// unaffected. That is the correct behaviour and it is why the old prose here
// was wrong. But it is also exactly why the divergence has to be PRINTED: a
// benign ~25s mid-roll straddle and a follower stuck for a week on a failing
// roll produce a byte-identical summary otherwise, and this — the estate-wide
// reconcile at deploy-fiab-commercial.yml — is the surface an operator reads.
// `pin-refresh` logging it is not enough; the two lanes report on different
// runs. An observation, never a verdict: nothing below reads `notes`.
for (const n of resolution.notes) {
  console.log(`::notice::[reconcile] FOLLOWER ${n.note}`);
}

const lines = tagEnvLines(resolution.pinned);
for (const line of lines) setEnv(line);

// ---- 3. deployAppsEnabled -------------------------------------------------
const decision = decideDeployApps({
  eventName,
  baseValue: env.BASE_DEPLOY_APPS_ENABLED,
  resolution,
});

console.log(`[reconcile] deployAppsEnabled=${decision.value} — ${decision.reason}`);
if (eventName === 'schedule' && decision.value === 'false') {
  console.log(
    '::warning::Scheduled reconcile stays infra-only: app-deployments.bicep is skipped, so ' +
    'loom-console env vars are NOT applied on this run.',
  );
}

setOutput('deploy_apps_enabled', decision.value);
setOutput('pinned_count', String(Object.keys(resolution.pinned).length));
setOutput('absent_count', String(resolution.absent.length));
setOutput('unknown_count', String(resolution.unknown.length));
// The KEYS, not just the count. An UNKNOWN key exports no pin, so an
// apps-enabled OPERATOR DISPATCH (which decideDeployApps deliberately does not
// override) would deploy it at the bicepparam default over whatever is running.
// deploy-input-safety.mjs refuses on exactly this and needs the names to say
// which apps are at risk.
setOutput('unknown_keys', resolution.unknown.map((u) => u.key).join(','));
// Parity with unknown_count (#4240): a follower divergence is not a refusal and
// must never become one, but a count of zero versus non-zero is the difference
// between "the estate agrees with itself" and "it does not", which no other
// output carries.
setOutput('follower_count', String(resolution.notes.length));
setOutput('follower_keys', resolution.notes.map((n) => n.key).join(','));

if (env.GITHUB_STEP_SUMMARY) {
  const rows = [
    '### Scheduled reconcile — image immutability',
    '',
    `- region: \`${region}\` (source: ${regionVerdict.source}) — ${regionVerdict.reason}`,
    `- images pinned to their RUNNING tag: **${lines.length}**`,
    `- not deployed (would be created): ${resolution.absent.join(', ') || '(none)'}`,
    `- UNKNOWN: ${resolution.unknown.map((u) => u.key).join(', ') || '(none)'}`,
    `- shared-repo followers not on their canonical's tag: ${
      resolution.notes.map((n) => n.note).join(' — ') || '(none)'
    }`,
    `- \`deployAppsEnabled\` = **${decision.value}** — ${decision.reason}`,
    '',
  ].join('\n');
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${rows}\n`);
}

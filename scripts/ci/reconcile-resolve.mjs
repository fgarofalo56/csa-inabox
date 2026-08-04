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
 *   region                the region to deploy into (schedule: derived from the
 *                         existing hub, NOT the 'eastus2' workflow default)
 *   deploy_apps_enabled   the FINAL value the az commands must use
 *   pinned_count / absent_count / unknown_count   for the step summary
 *
 * Emitted env (consumed by params/commercial.bicepparam at bicep-compile time):
 *   AZURE_LOCATION, LOOM_CONSOLE_TAG, LOOM_MCP_TAG, … (one per RUNNING image)
 *
 * Env in: GITHUB_EVENT_NAME, AZURE_LOCATION, INPUT_REGION,
 *         CSA_LOOM_TOPOLOGY, CSA_LOOM_TARGET_SUBSCRIPTION,
 *         DEPLOY_SUB, BASE_DEPLOY_APPS_ENABLED
 *
 * Usage: node scripts/ci/reconcile-resolve.mjs
 */
import { execFileSync } from 'node:child_process';
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
const fallbackRegion = env.AZURE_LOCATION || 'eastus2';
const requestedRegion = env.INPUT_REGION || '';

/**
 * The Azure CLI, invoked WITHOUT a shell for the same reason
 * deploy-fiab-guard.mjs does: arguments come from workflow inputs.
 *
 * Same consequence, written down again so nobody re-discovers it: on Windows
 * `az` is a .cmd shim and Node refuses to execFileSync it without a shell, so
 * these two functions fail closed to null on a workstation. That is the correct
 * behaviour but is NOT a measurement — CI is ubuntu-latest, where `az` is a real
 * executable. The pure functions they feed are covered on every platform.
 */
const AZ = 'az';

function azJson(args) {
  const out = execFileSync(AZ, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
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
  fallback: fallbackRegion,
});

if (regionVerdict.decision === 'refuse') {
  console.log(`::error::${regionVerdict.reason}`);
  process.exit(1);
}
const region = regionVerdict.region;
console.log(`[reconcile] region=${region} — ${regionVerdict.reason}`);
setOutput('region', region);
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

if (env.GITHUB_STEP_SUMMARY) {
  const rows = [
    '### Scheduled reconcile — image immutability',
    '',
    `- region: \`${region}\` (${regionVerdict.reason})`,
    `- images pinned to their RUNNING tag: **${lines.length}**`,
    `- not deployed (would be created): ${resolution.absent.join(', ') || '(none)'}`,
    `- UNKNOWN: ${resolution.unknown.map((u) => u.key).join(', ') || '(none)'}`,
    `- \`deployAppsEnabled\` = **${decision.value}** — ${decision.reason}`,
    '',
  ].join('\n');
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${rows}\n`);
}

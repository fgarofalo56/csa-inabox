#!/usr/bin/env node
/**
 * deploy-fiab-guard.mjs — thin I/O shell around ./deploy-trigger-policy.mjs.
 *
 * All the decisions live in deploy-trigger-policy.mjs and are unit-tested in
 * scripts/ci/__tests__/deploy-trigger-policy.test.mjs. This file only does I/O:
 * it asks Resource Graph how many hubs are in the target subscription, hands
 * that to the pure functions, and writes the result to $GITHUB_OUTPUT.
 *
 * It replaces an inline `run:` block in deploy-fiab-commercial.yml that could
 * not be tested and had two bugs (refs #2775):
 *   1. it read `inputs.allow_existing_hub` to decide something about the
 *      TRIGGER, so every scheduled reconcile refused itself; and
 *   2. `... 2>/dev/null || echo "0"` turned a FAILED hub-count query into
 *      "no hub here", making the guard's failure mode permissive.
 *
 * Emitted outputs:
 *   deploy_sub            subscription the deploy targets ('' = the login sub)
 *   purview_enabled, azure_maps_enabled, firewall_enabled,
 *   deploy_apps_enabled, skip_role_grants, front_door_enabled
 *                         resolved bicep bools -- NEVER the empty string, which
 *                         is what the schedule path used to pass to az.
 *
 * Env in:
 *   GITHUB_EVENT_NAME, CSA_LOOM_TOPOLOGY, CSA_LOOM_TARGET_SUBSCRIPTION,
 *   CSA_LOOM_SUBSCRIPTION_OVERRIDE, INPUT_ALLOW_EXISTING_HUB,
 *   INPUT_PURVIEW_ENABLED, INPUT_AZURE_MAPS_ENABLED, INPUT_FIREWALL_ENABLED,
 *   INPUT_DEPLOY_APPS_ENABLED, INPUT_SKIP_ROLE_GRANTS, INPUT_FRONT_DOOR_ENABLED
 *
 * Usage: node scripts/ci/deploy-fiab-guard.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  resolveTopologyGuard,
  resolveFeatureFlags,
  parseHubCount,
  FLAG_INPUT_NAMES,
} from './deploy-trigger-policy.mjs';

const env = process.env;
const eventName = env.GITHUB_EVENT_NAME || '';
const topology = env.CSA_LOOM_TOPOLOGY || '';
const targetSubscription = env.CSA_LOOM_TARGET_SUBSCRIPTION || '';
const subscriptionOverride = env.CSA_LOOM_SUBSCRIPTION_OVERRIDE || '';

const GRAPH_QUERY =
  "ResourceContainers | where type == 'microsoft.resources/subscriptions/resourcegroups' " +
  "| where name startswith 'rg-csa-loom-admin-' | project name";

/**
 * The Azure CLI executable.
 *
 * Deliberately invoked WITHOUT a shell: the KQL below contains quotes, and the
 * scope subscription comes from a workflow input, so handing either to a shell
 * would be an injection surface for no benefit.
 *
 * A consequence worth writing down: on Windows `az` is a .cmd shim, and Node
 * refuses to execFileSync a .cmd without a shell (EINVAL, post-CVE-2024-27980).
 * So this ONE function cannot be exercised on a Windows workstation -- it fails
 * closed to UNKNOWN there, which is the correct behaviour but is not a real
 * measurement. CI is ubuntu-latest, where `az` is a real executable. To exercise
 * it locally, run under WSL/Linux. The pure decision functions it feeds, and the
 * parsing of az's output (parseHubCount), are covered by the unit tests on every
 * platform.
 */
const AZ = 'az';

/**
 * Count rg-csa-loom-admin-* RGs in scope.
 * Returns null on ANY failure -- the caller treats null as UNKNOWN, not zero.
 * stderr is surfaced, never swallowed: a guard that cannot say why it could not
 * measure is the thing this file exists to stop.
 */
function countExistingHubs(scopeSub) {
  const args = ['graph', 'query'];
  if (scopeSub) args.push('--subscriptions', scopeSub);
  args.push('-q', GRAPH_QUERY, '--query', 'data | length(@)', '-o', 'tsv');
  try {
    const out = execFileSync(AZ, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return parseHubCount(out);
  } catch (e) {
    const detail = String(e?.stderr || e?.message || e).slice(0, 300);
    console.log(`::warning::hub-count query failed: ${detail}`);
    return null;
  }
}

function setOutput(key, value) {
  const file = env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`[dry] ${key}=${value}`);
    return;
  }
  appendFileSync(file, `${key}=${value}\n`);
}

// ---- feature flags --------------------------------------------------------
// Resolve these FIRST: an out-of-range value is a hard error and should stop
// the run before it spends a Resource Graph call.
const inputs = {
  [FLAG_INPUT_NAMES.purviewEnabled]: env.INPUT_PURVIEW_ENABLED,
  [FLAG_INPUT_NAMES.azureMapsEnabled]: env.INPUT_AZURE_MAPS_ENABLED,
  [FLAG_INPUT_NAMES.hubFirewallEnabled]: env.INPUT_FIREWALL_ENABLED,
  [FLAG_INPUT_NAMES.deployAppsEnabled]: env.INPUT_DEPLOY_APPS_ENABLED,
  [FLAG_INPUT_NAMES.skipRoleGrants]: env.INPUT_SKIP_ROLE_GRANTS,
  [FLAG_INPUT_NAMES.frontDoorEnabled]: env.INPUT_FRONT_DOOR_ENABLED,
};

let flagResult;
try {
  flagResult = resolveFeatureFlags({ eventName, inputs });
} catch (e) {
  console.log(`::error::${e.message}`);
  process.exit(1);
}

const { flags, source, defaulted } = flagResult;
console.log(`[deploy-guard] event=${eventName} topology=${topology || 'tenant'} flag-source=${source}`);
if (defaulted.length) {
  console.log(
    `[deploy-guard] defaulted (no input on this trigger): ${defaulted.join(', ')} ` +
    '-- these previously expanded to the EMPTY STRING and were passed to az as `param=`.',
  );
}
for (const [param, value] of Object.entries(flags)) {
  console.log(`[deploy-guard]   ${param}=${value}`);
  setOutput(FLAG_INPUT_NAMES[param], value);
}

if (flags.deployAppsEnabled === 'false' && eventName === 'schedule') {
  // Say the limitation out loud in the log of the very run that has it, so a
  // green reconcile is not mistaken for "the Console config was applied".
  console.log(
    '::notice::Scheduled reconcile runs with deployAppsEnabled=false, so ' +
    'app-deployments.bicep is skipped and loom-console env vars are NOT applied. ' +
    'Applying them needs an operator dispatch that also pins appImageTags to the ' +
    'RUNNING image tags (the bicep default is v0.1).',
  );
}

// ---- topology guard -------------------------------------------------------
const scopeSub = topology === 'dlz-attach' ? '' : subscriptionOverride;
const existingHubCount = topology === 'dlz-attach' ? 0 : countExistingHubs(scopeSub);

const verdict = resolveTopologyGuard({
  eventName,
  topology,
  targetSubscription,
  subscriptionOverride,
  allowExistingHub: env.INPUT_ALLOW_EXISTING_HUB,
  existingHubCount,
});

if (verdict.warning) console.log(`::warning::${verdict.warning}`);

if (verdict.decision === 'refuse') {
  console.log(`::error::${verdict.reason}`);
  process.exit(1);
}

console.log(`[deploy-guard] PROCEED -- ${verdict.reason}`);
setOutput('deploy_sub', verdict.deploySub || '');

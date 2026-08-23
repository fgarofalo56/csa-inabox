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
 *   LOOM_AZ_BIN         OPTIONAL. The Azure CLI to spawn (refs #3704). Default
 *                       `az` (`az.cmd` on win32). Same name the sibling
 *                       resolvers read — see {@link azBinary}.
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
 * WHY THIS IS RESOLVED AND NOT THE LITERAL `'az'` (#3704). This function decides
 * `deploy_apps_enabled` and `deploy_sub` — the deploy's two most consequential
 * outputs — and it decided them on a hardcoded assumption about the CLI on PATH.
 * A boundary where the Azure CLI is installed under a different name, wrapped, or
 * pinned to a specific build has no way to say so, and the failure is not loud:
 * a spawn that cannot find the binary lands in countExistingHubs's catch, which
 * returns null, and null is UNKNOWN. Fail-closed is the correct behaviour for an
 * unknown hub count — but "the CLI is not where I assumed" and "Resource Graph
 * refused me" then produce the same verdict from different causes, which is the
 * R7 shape this repo keeps paying for.
 *
 * `LOOM_AZ_BIN` is the convention already in this tree, not a new one: it is what
 * scripts/csa-loom/resolve-dlz-coordinates.mjs, preflight-private-dns-links.mjs,
 * preflight-brownfield-adopt.mjs, preflight-policy-restrictions.mjs,
 * migrate-private-dns-zone-owner.mjs, scripts/ci/deploy-arm-errors.mjs and
 * scripts/ci/resolve-acr-digest.sh all read. Default unchanged: plain `az`.
 *
 * A consequence worth writing down: on Windows `az` is a .cmd shim, and Node
 * refuses to execFileSync a .cmd without a shell (EINVAL, post-CVE-2024-27980).
 * The `az.cmd` default there matches the siblings above, but this ONE function
 * still cannot be exercised on a Windows workstation without a shell -- it fails
 * closed to UNKNOWN, which is the correct behaviour but is not a real
 * measurement. CI is ubuntu-latest, where `az` is a real executable. To exercise
 * it locally, run under WSL/Linux. The pure decision functions it feeds, and the
 * parsing of az's output (parseHubCount), are covered by the unit tests on every
 * platform.
 *
 * NOT EXPORTED, and the test does not import it. This file runs its whole guard
 * at module scope (there is no `invokedDirectly` fence, deliberately — a fence
 * that mis-resolves `process.argv[1]` would turn the deploy's most consequential
 * decision into a silent no-op), so importing it to unit-test a one-line resolver
 * would execute the guard. scripts/ci/__tests__/deploy-fiab-guard.test.mjs
 * therefore SPAWNS this script with LOOM_AZ_BIN pointed at a stub and reads which
 * binary actually ran — which proves the override reaches the spawn, not merely
 * that a function returns a string. A resolver nothing consults is the same
 * defect wearing a different hat.
 *
 * @returns {string} the executable name/path to spawn
 */
function azBinary() {
  if (env.LOOM_AZ_BIN) return env.LOOM_AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

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
  const bin = azBinary();
  try {
    // STILL NO SHELL, and that is not an oversight (#3704). The obvious rider on
    // "resolve the binary" is `shell: /\.(cmd|bat)$/i.test(bin)`, so a Windows
    // az.cmd can be spawned at all. Measured while writing this: with the shell
    // branch on, cmd.exe reads the `|` in GRAPH_QUERY's KQL pipeline as a SHELL
    // pipe and the query dies with "'project' is not recognized as an internal or
    // external command" — the same trap preflight-private-dns-links.mjs and
    // resolve-dlz-coordinates.mjs document and solve with `@file` argument
    // loading. Adding a shell here would trade a documented fail-closed EINVAL
    // for a MANGLED query, which is strictly worse. The scope subscription also
    // comes from a workflow input, so a shell is an injection surface for no
    // benefit. If this ever needs to run under Windows for real, adopt the
    // siblings' `@file` KQL loading first — do not just turn the shell on.
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return parseHubCount(out);
  } catch (e) {
    const detail = String(e?.stderr || e?.message || e).slice(0, 300);
    // Name the binary that was actually attempted (R7). Without it, "the CLI is
    // not on PATH under the name I assumed" and "Resource Graph refused me" read
    // identically, and both land on the same UNKNOWN verdict.
    console.log(`::warning::hub-count query failed (az binary: ${bin}): ${detail}`);
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
  // This is the fail-safe BASE, not the final answer (refs #2775). The
  // `Resolve reconcile target` step runs next and may upgrade it to 'true'
  // once it has pinned appImageTags to the tags every app is actually running.
  // Said out loud here so a reader of this step's log does not conclude the
  // Console env was applied — or that it was not — before that step reports.
  console.log(
    '::notice::Scheduled reconcile starts at deployAppsEnabled=false (fail-safe base). ' +
    'scripts/ci/reconcile-resolve.mjs decides the final value: it upgrades to true only ' +
    'after reading the RUNNING image tag of every Container App and pinning appImageTags ' +
    'to them, so the ARM PUT cannot re-image the estate. If it stays false, ' +
    'app-deployments.bicep is skipped and loom-console env vars are NOT applied.',
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

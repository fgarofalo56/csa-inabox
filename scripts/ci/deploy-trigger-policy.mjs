/**
 * deploy-trigger-policy.mjs — pure decision logic for deploy-fiab-commercial.yml.
 *
 * WHY THIS EXISTS (refs #2775, refs #2860)
 * ---------------------------------------
 * deploy-fiab-commercial.yml is the ONLY workflow that runs
 * `az deployment sub create -f platform/fiab/bicep/main.bicep`, so it is the
 * only path that can apply Console configuration (env vars, role grants, module
 * wiring) to a running estate. full-app-deploy-commercial.yml says in-line that
 * it deliberately does not run the bicep; console-bluegreen-roll.yml only
 * swaps `--image`.
 *
 * It has a daily `cron: '0 6 * * *'` whose evident purpose is to reconcile the
 * estate. That schedule has NEVER succeeded. Every scheduled run since the
 * workflow was created failed in the topology guard, in ~30-80 seconds, because
 * the guard read an INPUT to decide something about the TRIGGER:
 *
 *     if [ "$EXISTING" != "0" ] && [ "${{ inputs.allow_existing_hub }}" != "true" ]
 *
 * On a `schedule` event there are no inputs, so `inputs.allow_existing_hub` is
 * the empty string, `"" != "true"` is always true, and the guard refused every
 * night against the hub it was scheduled to reconcile. The last actual
 * application of the admin-plane template was 2026-07-23, and that one Failed.
 *
 * This is the repo's dominant defect class one rung along: not a control that
 * runs and measures nothing, but a control that runs, measures the wrong thing,
 * and reports its refusal as a job failure nobody reads because it looks like
 * the same red X as yesterday.
 *
 * WHAT THE GUARD IS FOR (preserved exactly)
 * ----------------------------------------
 * The guard exists to stop a second Console being stamped into a subscription
 * that already holds one (audit-t156/t157). That intent is legitimate and is
 * NOT relaxed here. What changes is only that the decision now keys on the
 * TRIGGER: an operator-initiated dispatch against an existing hub still has to
 * say `allow_existing_hub=true`, while the nightly reconcile -- whose entire
 * purpose is to run against an existing hub -- proceeds.
 *
 * FAIL-CLOSED ON UNKNOWN
 * ----------------------
 * The bash this replaces ended its hub-count query with
 *
 *     ... -o tsv 2>/dev/null || echo "0"
 *
 * so an az/Graph/auth failure was indistinguishable from "no hub here", and the
 * guard PASSED. A control whose failure mode is permissive is the same defect in
 * miniature. `existingHubCount: null` means UNKNOWN and is kept distinct from 0:
 * a dispatch on UNKNOWN refuses, because the risk it guards (double-stamping)
 * cannot be ruled out. A schedule on UNKNOWN still proceeds -- an incremental
 * reconcile is the same safe action whether or not the hub is there.
 *
 * Run: node --test scripts/ci/__tests__/deploy-trigger-policy.test.mjs
 */

/**
 * Feature-flag defaults for a run that carries NO inputs (a `schedule` event).
 *
 * These mirror the `default:` of each corresponding workflow_dispatch input,
 * one-for-one; deploy-trigger-policy.test.mjs parses the workflow YAML and
 * fails if the two ever drift. They are duplicated here rather than read at
 * runtime because a scheduled run has no inputs context to read them from --
 * that absence is the whole bug.
 *
 * On the schedule path these previously expanded to the EMPTY STRING and were
 * passed straight to `az deployment sub create` as `purviewEnabled=` etc.
 * `purviewEnabled` is declared `param purviewEnabled bool` with NO default in
 * platform/fiab/bicep/main.bicep, so it is required; an empty string is not a
 * bool and ARM rejects the template. The CLI-level `--parameters k=` also
 * OVERRIDES the value the commercial.bicepparam file sets, so the bicepparam
 * defaults could not rescue it.
 *
 * deployAppsEnabled STAYS FALSE, deliberately. See the note on
 * SCHEDULED_RECONCILE_DOES_NOT_APPLY_APP_ENV below -- flipping it here would
 * roll production onto a non-existent image tag.
 */
export const SCHEDULE_FLAG_DEFAULTS = Object.freeze({
  purviewEnabled: 'true',
  azureMapsEnabled: 'true',
  hubFirewallEnabled: 'true',
  deployAppsEnabled: 'false',
  skipRoleGrants: 'false',
  // TRUE, matching the workflow_dispatch default. The Commercial estate has an
  // ACTIVE Front Door profile, and because this value reaches ARM as a CLI
  // `--parameters frontDoorEnabled=…` it OVERRIDES whatever
  // commercial.bicepparam says (see the note above) — so a 'false' here did not
  // merely fail to enable Front Door, it actively disabled it on every
  // SCHEDULED reconcile, which is the run that executes daily.
  //
  // What that cost: `fdOn` gates six ACA jobs' loomUrl
  // (fdOn ? frontDoorPublicUrl : 'http://loom-console'), the Front Door hostname
  // in effectiveMsalConsoleHosts, and the vanity* outputs. The http fallback is
  // what broke the J3 synthetic journey for three days — a `Secure` session
  // cookie is never sent over http, so the UAT browser context was
  // unauthenticated and every client call 401'd (#3181, #3193).
  frontDoorEnabled: 'true',
});

/**
 * The workflow_dispatch input name behind each bicep parameter, so the drift
 * test can line them up against the YAML.
 */
export const FLAG_INPUT_NAMES = Object.freeze({
  purviewEnabled: 'purview_enabled',
  azureMapsEnabled: 'azure_maps_enabled',
  hubFirewallEnabled: 'firewall_enabled',
  deployAppsEnabled: 'deploy_apps_enabled',
  skipRoleGrants: 'skip_role_grants',
  frontDoorEnabled: 'front_door_enabled',
});

/**
 * WHY THE SCHEDULED VALUE RESOLVED *HERE* IS STILL FALSE (refs #2775).
 *
 * The Container Apps (and therefore every LOOM_* env var on loom-console) are
 * created by `module appDeployments 'app-deployments.bicep' = if
 * (containerPlatform == 'containerApps' && deployAppsEnabled)` in
 * modules/admin-plane/main.bicep. With deployAppsEnabled=false that module does
 * not run, so a green scheduled reconcile applies infrastructure and leaves the
 * Console env exactly as it is. That is what "185 of 192 configured" on
 * /admin/env-config was measuring: LOOM_RISINGWAVE_URL and
 * LOOM_DUCKLAKE_CATALOG_URL are emitted by admin-plane/main.bicep behind
 * `deployAppsEnabled`, so they had never been applied to anything.
 *
 * Simply setting it true here would be worse than leaving it false.
 * `appImageTags` defaults to `console: 'v0.1'` in BOTH
 * platform/fiab/bicep/main.bicep and modules/admin-plane/main.bicep, while
 * production runs a commit-SHA tag. An unattended nightly job that rewrites the
 * Console image to `loom-console:v0.1` is an outage, not a reconcile.
 *
 * The day-one-config work under #2775 closed that gap the correct way round.
 * The value resolved here stays the
 * SAFE base; `scripts/ci/reconcile-policy.mjs` `decideDeployApps` may upgrade it
 * to 'true' — but only after `scripts/ci/reconcile-resolve.mjs` has read the tag
 * every running Container App is on and exported it as LOOM_<APP>_TAG, which
 * params/commercial.bicepparam now resolves through readEnvironmentVariable(),
 * making the ARM PUT a no-op for every image. Default deny; upgrade on evidence.
 *
 * The constant is retained under its old name so nothing that imports it
 * breaks, and because the statement it makes is still true OF THIS FILE: this
 * module never enables app deployment. Only the step that measures may.
 */
export const SCHEDULED_RECONCILE_DOES_NOT_APPLY_APP_ENV = true;

/** Values a bicep `bool` parameter may be given on the command line. */
const BOOL_VALUES = new Set(['true', 'false']);

/**
 * Resolve the six feature-flag bicep parameters for a run.
 *
 * @param {object}  a
 * @param {string}  a.eventName  github.event_name
 * @param {object} [a.inputs]    the `inputs` context (absent/empty on schedule)
 * @returns {{flags: Record<string,string>, source: 'inputs'|'schedule-defaults', defaulted: string[]}}
 * @throws  if an input is present but is not a bicep bool -- passing it through
 *          would hand ARM a value it cannot coerce, which is how this broke.
 */
export function resolveFeatureFlags({ eventName, inputs = {} } = {}) {
  const flags = {};
  const defaulted = [];

  for (const [param, inputName] of Object.entries(FLAG_INPUT_NAMES)) {
    const raw = inputs?.[inputName];
    // A boolean workflow input arrives as a real boolean or as "true"/"false";
    // an ABSENT one (every schedule run) arrives as undefined or "".
    const value = typeof raw === 'boolean' ? String(raw) : String(raw ?? '').trim();

    if (value === '') {
      flags[param] = SCHEDULE_FLAG_DEFAULTS[param];
      defaulted.push(param);
      continue;
    }
    if (!BOOL_VALUES.has(value)) {
      throw new Error(
        `input ${inputName} is "${value}", which is not a bicep bool. ` +
        `Passing it to az as ${param}=${value} would fail template validation ` +
        `(or, worse, be coerced). Refusing to emit it.`,
      );
    }
    flags[param] = value;
  }

  return {
    flags,
    source: defaulted.length === Object.keys(FLAG_INPUT_NAMES).length ? 'schedule-defaults' : 'inputs',
    defaulted,
    eventName,
  };
}

/**
 * Decide whether the deploy may proceed, and against which subscription.
 *
 * @param {object}       a
 * @param {string}       a.eventName            github.event_name
 * @param {string}      [a.topology]            'tenant' | 'single-sub' | 'dlz-attach' | ''
 * @param {string}      [a.targetSubscription]  dlz-attach target sub id
 * @param {string}      [a.subscriptionOverride] hub/deploy sub id
 * @param {boolean|string} [a.allowExistingHub] the allow_existing_hub input
 * @param {number|null} [a.existingHubCount]    count of rg-csa-loom-admin-* RGs;
 *                                              null = the query FAILED (unknown)
 * @returns {{decision:'proceed'|'refuse', reason:string, deploySub?:string, warning?:string}}
 */
export function resolveTopologyGuard({
  eventName,
  topology,
  targetSubscription = '',
  subscriptionOverride = '',
  allowExistingHub = false,
  existingHubCount = 0,
} = {}) {
  const effectiveTopology = (topology || 'tenant').trim() || 'tenant';
  const allow = allowExistingHub === true || String(allowExistingHub).trim() === 'true';
  const isSchedule = eventName === 'schedule';

  if (effectiveTopology === 'dlz-attach') {
    if (!String(targetSubscription).trim()) {
      return {
        decision: 'refuse',
        reason: 'dlz-attach requires target_subscription (the new DLZ subscription).',
      };
    }
    return {
      decision: 'proceed',
      reason: 'dlz-attach into an explicit target subscription.',
      deploySub: String(targetSubscription).trim(),
    };
  }

  // topology=tenant / single-sub -- the double-stamp guard.
  const deploySub = String(subscriptionOverride).trim();
  const unknown = existingHubCount === null || existingHubCount === undefined;

  if (!unknown && Number(existingHubCount) === 0) {
    return { decision: 'proceed', reason: 'no existing hub in the target subscription.', deploySub };
  }

  // From here the sub either HAS a hub, or we could not find out.
  if (isSchedule) {
    // The nightly reconcile exists precisely to run against the existing hub.
    // Incremental mode; no second Console is stamped (the Console is created by
    // app-deployments.bicep, which the schedule leaves disabled anyway).
    return {
      decision: 'proceed',
      reason: unknown
        ? 'scheduled reconcile; hub count UNKNOWN (query failed) but an incremental reconcile is safe either way.'
        : `scheduled reconcile against the existing hub (${existingHubCount} rg-csa-loom-admin-* RG).`,
      deploySub,
      warning: unknown
        ? 'hub-count query failed; proceeding because this is the scheduled reconcile, not a first-run install.'
        : 'reconciling an existing hub (scheduled run) -- incremental deploy, no second Console.',
    };
  }

  if (unknown) {
    // Fail CLOSED. The old bash turned this into "0" and let the deploy run.
    return {
      decision: 'refuse',
      reason:
        'could not determine whether a CSA Loom hub already exists in the target subscription ' +
        '(the Resource Graph query failed). This is UNKNOWN, not absent -- refusing rather than ' +
        'risking a second Console. Re-run once the query works, or pass allow_existing_hub=true ' +
        'if you have confirmed the topology by hand.',
    };
  }

  if (!allow) {
    return {
      decision: 'refuse',
      reason:
        `A CSA Loom hub already exists in the target subscription (found ${existingHubCount} ` +
        'rg-csa-loom-admin-* RG). A second Console cannot be stamped into the same sub -- use ' +
        'topology=dlz-attach with target_subscription to add a DLZ, or target a fresh ' +
        'subscription. To idempotently reconcile/retry a partially-deployed hub in this sub, ' +
        're-run with allow_existing_hub=true.',
    };
  }

  return {
    decision: 'proceed',
    reason: `reconciling the existing hub (allow_existing_hub=true, ${existingHubCount} RG).`,
    deploySub,
    warning: 'Reconciling existing hub in target sub (allow_existing_hub=true) -- incremental deploy, no second Console.',
  };
}

/**
 * Parse the `az graph query ... --query "data | length(@)" -o tsv` result.
 * Returns null (UNKNOWN) for anything that is not a clean non-negative integer,
 * including the empty string an errored az call leaves behind.
 */
export function parseHubCount(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

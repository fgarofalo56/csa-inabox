#!/usr/bin/env node
/**
 * deploy-input-safety.mjs — REFUSE a deploy whose INPUTS would tear down or
 * mis-target the estate, before any ARM write is submitted.
 *
 * WHY THIS EXISTS (refs #3028, #3029)
 * -----------------------------------
 * `deploy-fiab-commercial.yml` had two inputs whose DEFAULT was the destructive
 * choice, and neither said so:
 *
 *   #3028  `keep_resources` defaulted to FALSE, and the Teardown step fires on
 *          `run_mode == 'full' && !inputs.keep_resources`. So an operator who
 *          selected `full` and changed nothing else — the single most natural
 *          action on this workflow — provisioned the estate, smoked it, and
 *          then ran `.github/scripts/fiab-teardown.sh`, which does not delete
 *          only RG_NAME: it enumerates `rg-csa-loom-*` across the WHOLE
 *          subscription and deletes every match, purging Key Vaults and
 *          Cognitive Services accounts on the way. Destruction of production,
 *          reachable by accepting every default.
 *
 *          The help text made it worse: the "USE WITH CAUTION" warning was
 *          attached to `true` — the SAFE value — and warned about spend. It
 *          told you the cost of not destroying your estate and said nothing
 *          about what leaving it false does.
 *
 *   #3029  `region` had no default on the input and `|| 'eastus2'` in `env:`,
 *          so an omitted region silently targeted eastus2 while the estate is
 *          in centralus. Handled in reconcile-policy.mjs `resolveReconcileRegion`
 *          (adopt-or-refuse); re-asserted here so that a future edit which
 *          reintroduces a silent default is caught by a SECOND control that
 *          does not share its code.
 *
 * WHAT THIS FILE DOES THAT THE `if:` CONDITION CANNOT
 * ---------------------------------------------------
 * Skipping the teardown step is not enough. A run that would have torn the
 * estate down must not silently become a run that quietly does not — the
 * operator asked for something dangerous and is owed the refusal, and they are
 * owed it BEFORE ninety minutes of provisioning, not after. So this runs as its
 * own step, immediately after the region is resolved and before any provider
 * registration / what-if / apply, and exits non-zero.
 *
 * THE POLARITY FIX
 * ----------------
 * A double-negative (`!keep_resources`) guarding a destructive step is exactly
 * how this hid. Teardown now requires the operator to TYPE THE THING BEING
 * DESTROYED: `confirm_teardown_rg` must exactly equal the resource group the
 * run resolved. An ephemeral CI subscription supplies it trivially. A human on
 * production cannot produce it by accident.
 *
 * Env in:
 *   GITHUB_EVENT_NAME
 *   INPUT_RUN_MODE            'whatif-only' | 'full' | '' (schedule)
 *   INPUT_KEEP_RESOURCES      'true' | 'false' | '' (schedule)
 *   INPUT_CONFIRM_TEARDOWN_RG the RG the operator typed to authorise teardown
 *   INPUT_REGION              the `region` input as supplied ('' on schedule)
 *   RESOLVED_REGION           reconcile-resolve.mjs's measured verdict
 *   RESOLVED_REGION_SOURCE    'adopted' | 'input'
 *   DEPLOY_APPS_ENABLED       the resolver's final value
 *   UNKNOWN_IMAGE_KEYS        appImageTags keys whose RUNNING tag could not be
 *                             determined (comma-separated; from the resolver)
 *   HUB_PRESENT               'true' | 'false' — is rg-csa-loom-admin-<region> there
 *
 * Usage: node scripts/ci/deploy-input-safety.mjs
 * Tests: node --test scripts/ci/__tests__/deploy-input-safety.test.mjs
 */
import { appendFileSync } from 'node:fs';

/** `rg-csa-loom-admin-<region>` — the RG fiab-teardown.sh is pointed at. */
export const adminRgFor = (region) => `rg-csa-loom-admin-${String(region || '').trim()}`;

/** A workflow boolean input arrives as a real bool, "true"/"false", or '' (schedule). */
const asBool = (v) => (typeof v === 'boolean' ? v : String(v ?? '').trim() === 'true');

/**
 * Decide whether this run's inputs are safe to submit.
 *
 * Returns EVERY violation, not the first: an operator who got two inputs wrong
 * should learn both in one run rather than one per ninety-minute attempt.
 *
 * @param {object} a
 * @param {string} a.eventName
 * @param {string} [a.runMode]
 * @param {boolean|string} [a.keepResources]
 * @param {string} [a.confirmTeardownRg]
 * @param {string} [a.requestedRegion]
 * @param {string} [a.resolvedRegion]
 * @param {string} [a.resolvedRegionSource]
 * @param {boolean|string} [a.deployAppsEnabled]
 * @param {string|string[]} [a.unknownImageKeys]
 * @param {boolean|string} [a.hubPresent]
 * @returns {{decision:'proceed'|'refuse', violations:string[], notes:string[], teardownArmed:boolean}}
 */
export function resolveInputSafety({
  eventName = '',
  runMode = '',
  keepResources = '',
  confirmTeardownRg = '',
  requestedRegion = '',
  resolvedRegion = '',
  resolvedRegionSource = '',
  deployAppsEnabled = '',
  unknownImageKeys = '',
  hubPresent = '',
} = {}) {
  const violations = [];
  const notes = [];

  const isSchedule = eventName === 'schedule';
  const mode = String(runMode || '').trim();
  const keep = asBool(keepResources);
  const confirm = String(confirmTeardownRg || '').trim();
  const requested = String(requestedRegion || '').trim();
  const resolved = String(resolvedRegion || '').trim();
  const targetRg = adminRgFor(resolved);
  const appsOn = asBool(deployAppsEnabled);
  const hub = asBool(hubPresent);

  // ---- region ------------------------------------------------------------
  // reconcile-resolve.mjs has already refused anything unsafe. These are the
  // second pair of eyes: a resolver that starts silently defaulting again, or
  // one that quietly overrides the operator, is caught HERE and not in a
  // post-mortem (#3029).
  if (!resolved) {
    violations.push(
      'the deploy region resolved to the EMPTY STRING. Every resource name this deploy derives ' +
      '(rg-csa-loom-admin-<region>, vnet-csa-loom-hub-<region>, uami-loom-console-<region>) would be ' +
      'malformed, and `az deployment sub create --location ""` targets nothing. Refusing.',
    );
  } else if (requested && requested !== resolved) {
    violations.push(
      `region=${requested} was supplied but the run resolved ${resolved}. An input the platform ` +
      'silently overrides is worse than no input: the operator would read the dispatch form and ' +
      'believe one region while another was deployed. Refusing.',
    );
  } else if (resolvedRegionSource === 'adopted') {
    notes.push(
      `region ADOPTED from the estate: ${resolved} (no region input was supplied; ${targetRg} is the ` +
      'hub that exists). Nothing was assumed.',
    );
  } else {
    notes.push(`region ${resolved} (from the explicit input) → ${targetRg}.`);
  }

  // ---- teardown ----------------------------------------------------------
  // The schedule can never reach the teardown step (check-reconcile-safety I1
  // holds the literal `github.event_name != 'schedule'` in its `if:`), so a
  // scheduled run has no teardown decision to make.
  let teardownArmed = false;
  if (isSchedule) {
    notes.push(
      'scheduled reconcile — the teardown step carries `github.event_name != \'schedule\'` and is ' +
      'unreachable on this trigger (check-reconcile-safety I1).',
    );
    if (confirm) {
      violations.push(
        'a scheduled run cannot tear anything down, yet confirm_teardown_rg is set. That combination ' +
        'means something upstream is passing inputs to a schedule, which is not a thing that happens. ' +
        'Refusing rather than guessing which half is wrong.',
      );
    }
  } else if (mode !== 'full') {
    notes.push(`run_mode=${mode || '(none)'} — nothing is applied and nothing can be torn down.`);
    if (confirm) {
      violations.push(
        `confirm_teardown_rg=${confirm} was supplied on a ${mode || '(none)'} run, which applies ` +
        'nothing. Either you meant run_mode=full, or you meant to leave the teardown confirmation ' +
        'empty. Refusing rather than picking one.',
      );
    }
  } else if (keep) {
    notes.push(
      `run_mode=full with keep_resources=true — the estate STAYS UP after the deploy. ` +
      `Tear it down deliberately later with RG_NAME=${targetRg} bash .github/scripts/fiab-teardown.sh.`,
    );
    if (confirm) {
      violations.push(
        `keep_resources=true and confirm_teardown_rg=${confirm} are contradictory: one says keep the ` +
        'estate, the other authorises deleting it. Refusing rather than resolving the contradiction ' +
        'on your behalf. Clear confirm_teardown_rg to keep, or set keep_resources=false to destroy.',
      );
    }
  } else if (confirm !== targetRg) {
    // THE #3028 CASE. run_mode=full + keep_resources=false without the typed
    // confirmation is the accept-every-default path that deletes production.
    violations.push(
      `run_mode=full with keep_resources=false is a TEARDOWN run: after provisioning and smoking, ` +
      '`.github/scripts/fiab-teardown.sh` deletes EVERY `rg-csa-loom-*` resource group in this ' +
      `subscription (not just ${targetRg}), purging its Key Vaults and Cognitive Services accounts ` +
      'so the names are released. ' +
      (confirm
        ? `confirm_teardown_rg=${confirm} does not match the resource group this run resolved ` +
          `(${targetRg}), so the confirmation does not authorise this destruction.`
        : 'No confirmation was supplied.') +
      ` If you meant to KEEP the estate — which is what a real install wants — set keep_resources=true. ` +
      `If you genuinely meant to destroy it, set confirm_teardown_rg=${targetRg} exactly.`,
    );
  } else {
    teardownArmed = true;
    notes.push(
      `TEARDOWN ARMED and confirmed for ${targetRg}. Every rg-csa-loom-* resource group in this ` +
      'subscription will be deleted after the smoke test.',
    );
    if (hub) {
      notes.push(
        `NOTE: ${targetRg} ALREADY EXISTS — this is a confirmed teardown of an estate that is already ` +
        'there, not of a throwaway one this run created.',
      );
    }
  }

  // ---- apps-enabled: an UNKNOWN running tag is a silent image rewrite ----
  //
  // MEASURED ON THE LIVE COMMERCIAL ESTATE, 2026-08-06: `iceberg-catalog` and
  // `loom-unity` are two Container Apps running the SAME repository
  // (loom-unity) at DIFFERENT tags — v0.1 and 089fb622. admin-plane/main.bicep
  // renders both from one key (`appImageTags.?unity`), so the resolver reports
  // that key UNKNOWN: no single value can preserve both.
  //
  // decideDeployApps already protects the SCHEDULE from this (UNKNOWN keeps
  // deployAppsEnabled false). An operator DISPATCH had no such protection —
  // `deploy_apps_enabled=true` is passed through verbatim, no pin is exported
  // for the UNKNOWN key, and commercial.bicepparam's
  // readEnvironmentVariable('LOOM_UNITY_TAG','v0.1') therefore resolves to
  // v0.1, silently rolling loom-unity BACK from 089fb622. The deploy would
  // report success having downgraded the working catalog.
  //
  // So the dispatch refuses, and names a remediation the operator can perform
  // in one command without any code change.
  const unknownKeys = (Array.isArray(unknownImageKeys)
    ? unknownImageKeys
    : String(unknownImageKeys || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (appsOn) {
    notes.push(
      'deployAppsEnabled=true — app-deployments.bicep runs, so every LOOM_* env var on loom-console ' +
      'is re-rendered from the template on this run.',
    );
    if (unknownKeys.length) {
      violations.push(
        `deployAppsEnabled=true, but the RUNNING image tag of ${unknownKeys.length} appImageTags key(s) ` +
        `could not be determined: ${unknownKeys.join(', ')}. An UNKNOWN key exports no pin, so ` +
        "commercial.bicepparam falls back to its default ('v0.1') and the deploy REWRITES whatever " +
        'those apps are running — reporting success while rolling them backwards. Refusing. ' +
        'Remediation, no code change required: bring the colliding Container Apps onto a single tag ' +
        '(`az containerapp update -n <app> -g <rg> --image <acr>/<repo>:<tag>`) so the running tag is ' +
        'unambiguous, then re-dispatch — the pin becomes a no-op and the rest of the deploy applies. ' +
        'The durable fix is a separate appImageTags key per app, as was done for dbtRunner.',
      );
    }
  } else {
    notes.push(
      'deployAppsEnabled=false — app-deployments.bicep is SKIPPED, so no LOOM_* env var reaches ' +
      'loom-console on this run. Infrastructure only.',
    );
    if (unknownKeys.length) {
      notes.push(
        `${unknownKeys.length} appImageTags key(s) have an UNKNOWN running tag (${unknownKeys.join(', ')}), ` +
        'but nothing is re-imaged on an infra-only run, so no running image is at risk.',
      );
    }
  }

  return {
    decision: violations.length ? 'refuse' : 'proceed',
    violations,
    notes,
    teardownArmed,
  };
}

/** Human-readable block for the job log + step summary. */
export function formatSafetyReport(verdict, ctx = {}) {
  const lines = [
    '### Deploy input safety',
    '',
    `- trigger: \`${ctx.eventName || '(unknown)'}\``,
    `- run_mode: \`${ctx.runMode || '(none)'}\``,
    `- region: \`${ctx.resolvedRegion || '(unresolved)'}\` (source: ${ctx.resolvedRegionSource || 'n/a'})`,
    `- target resource group: \`${adminRgFor(ctx.resolvedRegion)}\``,
    `- teardown: **${verdict.teardownArmed ? 'ARMED (confirmed)' : 'NOT armed'}**`,
    '',
  ];
  for (const n of verdict.notes) lines.push(`- ${n}`);
  if (verdict.violations.length) {
    lines.push('', '#### REFUSED', '');
    for (const v of verdict.violations) lines.push(`- ${v}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('deploy-input-safety.mjs');
if (invokedDirectly) {
  const env = process.env;
  const ctx = {
    eventName: env.GITHUB_EVENT_NAME || '',
    runMode: env.INPUT_RUN_MODE || '',
    keepResources: env.INPUT_KEEP_RESOURCES || '',
    confirmTeardownRg: env.INPUT_CONFIRM_TEARDOWN_RG || '',
    requestedRegion: env.INPUT_REGION || '',
    resolvedRegion: env.RESOLVED_REGION || '',
    resolvedRegionSource: env.RESOLVED_REGION_SOURCE || '',
    deployAppsEnabled: env.DEPLOY_APPS_ENABLED || '',
    unknownImageKeys: env.UNKNOWN_IMAGE_KEYS || '',
    hubPresent: env.HUB_PRESENT || '',
  };
  const verdict = resolveInputSafety(ctx);
  const report = formatSafetyReport(verdict, ctx);
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report}\n`);

  for (const n of verdict.notes) console.log(`::notice::${n}`);
  if (verdict.decision === 'refuse') {
    for (const v of verdict.violations) console.log(`::error::${v}`);
    console.error(
      `\n[deploy-input-safety] REFUSED — ${verdict.violations.length} unsafe input(s). ` +
      'Nothing has been submitted to ARM. See scripts/ci/deploy-input-safety.mjs.',
    );
    process.exit(1);
  }
  console.log('[deploy-input-safety] OK — the inputs cannot tear down or mis-target the estate.');
}

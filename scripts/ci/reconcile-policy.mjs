/**
 * reconcile-policy.mjs — pure decision logic for the SCHEDULED reconcile of
 * deploy-fiab-commercial.yml.
 *
 * WHY THIS EXISTS (refs #2775, refs #2860)
 * ---------------------------------------------------
 * deploy-fiab-commercial.yml is the ONLY workflow that runs
 * `az deployment sub create -f platform/fiab/bicep/main.bicep`, so it is the
 * only path that can apply Console configuration (LOOM_* env vars, role grants,
 * module wiring) to a running estate. #2881 fixed the topology guard that had
 * refused every scheduled run since the workflow was created.
 *
 * That unblocked the path — and the path, as it stood, had THREE ways to
 * destroy or duplicate the production estate the moment it first succeeded.
 * All three are the same defect class the repo keeps finding: a control that
 * was verified in isolation and never walked end to end.
 *
 *   1. TEARDOWN. The `Teardown` step's condition is
 *        always() && steps.provision.outcome == 'success'
 *        && (github.event_name == 'schedule' || ...)
 *      so a SUCCESSFUL scheduled run runs `.github/scripts/fiab-teardown.sh`,
 *      which deletes RG_NAME *and every other* `rg-csa-loom-*` resource group
 *      in the subscription. The nightly "reconcile" was a nightly `rm -rf` that
 *      had never reached its own last step. Fixed in the workflow; invariant I1
 *      in check-reconcile-safety.mjs keeps it fixed.
 *
 *   2. REGION. `AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}`. A schedule
 *      carries no inputs, so the nightly reconcile targeted **eastus2** while
 *      the live estate is **centralus**. It would not have reconciled anything;
 *      it would have stamped a second estate in another region — and then torn
 *      both down, because (1) sweeps the whole subscription by prefix.
 *      resolveReconcileRegion() below derives the region from the hub that is
 *      actually there.
 *
 *   3. IMAGES. `appImageTags.console` defaults to 'v0.1' in BOTH bicep files
 *      and `commercial.bicepparam` never set it, while production runs a
 *      commit-SHA tag. So `deployAppsEnabled=true` — the flag that has to be
 *      true for Console env vars to apply at all — would have rewritten the
 *      running Console image to a tag that does not exist. That is why it was
 *      left false, and why the estate has been unable to receive configuration.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 * --------------------------------------
 *   A scheduled reconcile must never change a RUNNING image.
 *
 * It is held by measurement, not by hope: the workflow reads the tag each
 * Container App is actually running (read-only `az containerapp list`), and
 * pins `appImageTags` to exactly those values via the `readEnvironmentVariable`
 * mechanism `gcc-high.bicepparam` / `commercial-full.bicepparam` already use.
 * The resulting ARM PUT is a no-op for the image and applies everything else.
 *
 * FAIL-CLOSED, AND NOT THE SAME WAY THE OLD BASH FAILED
 * -----------------------------------------------------
 * `deployAppsEnabled` starts at the SAFE value ('false', from
 * SCHEDULE_FLAG_DEFAULTS in deploy-trigger-policy.mjs) and is upgraded to
 * 'true' only when every running image has been positively identified. An
 * unreadable estate, a digest-pinned container, or two containers running the
 * same repo at different tags all resolve to UNKNOWN, and UNKNOWN keeps the old
 * (safe, infra-only) behaviour instead of guessing. UNKNOWN is never collapsed
 * into "absent" — that collapse is the exact bug #2881 removed from the hub
 * count, and the exact class recorded in the repo's own notes as "UNKNOWN
 * reported as NEGATIVE".
 *
 * Run: node --test scripts/ci/__tests__/reconcile-policy.test.mjs
 */

/**
 * Every `appImageTags` key, the container-image REPOSITORY it names, and the
 * environment variable `commercial.bicepparam` reads it from.
 *
 * The repo column is the load-bearing one: it is what lets a running container
 * be matched back to the key that would rewrite it. check-reconcile-safety.mjs
 * re-derives this mapping from the bicep on every CI run and fails if the two
 * disagree, so this table cannot silently drift away from what ARM would do.
 *
 * The env-var names match gcc-high.bicepparam / commercial-full.bicepparam
 * one-for-one where those files already name one; the three that no boundary
 * param file had yet (dbtRunner, transformRunner, mapsTiles) follow the same
 * LOOM_<APP>_TAG convention.
 */
export const APP_IMAGE_TAGS = Object.freeze([
  { key: 'console', repo: 'loom-console', envVar: 'LOOM_CONSOLE_TAG' },
  { key: 'mcp', repo: 'loom-mcp', envVar: 'LOOM_MCP_TAG' },
  { key: 'mcpBridge', repo: 'loom-mcp-bridge', envVar: 'LOOM_MCP_BRIDGE_TAG' },
  { key: 'orchestrator', repo: 'loom-orchestrator', envVar: 'LOOM_ORCHESTRATOR_TAG' },
  { key: 'activator', repo: 'loom-activator', envVar: 'LOOM_ACTIVATOR_TAG' },
  { key: 'mirroring', repo: 'loom-mirroring', envVar: 'LOOM_MIRRORING_TAG' },
  { key: 'directLake', repo: 'loom-direct-lake-shim', envVar: 'LOOM_DIRECTLAKE_TAG' },
  { key: 'maf', repo: 'loom-copilot-maf', envVar: 'LOOM_MAF_TAG' },
  { key: 'setupOrchestrator', repo: 'loom-setup-orchestrator', envVar: 'LOOM_SETUP_ORCHESTRATOR_TAG' },
  { key: 'scriptRunner', repo: 'loom-script-runner', envVar: 'LOOM_SCRIPT_RUNNER_TAG' },
  { key: 'wrangler', repo: 'loom-wrangler-host', envVar: 'LOOM_WRANGLER_TAG' },
  // dbtRunner is NEW (refs #2775). admin-plane/main.bicep passed
  // `imageTag: appImageTags.console` to integration/dbt-runner.bicep, which
  // builds `${acr}/loom-dbt-runner:${imageTag}` — so ONE key drove TWO
  // different repositories, running at two different tags in production
  // (loom-console at a commit SHA, loom-dbt-runner at v0.1). Pinning the key to
  // either running tag necessarily rewrites the other. It is also live already:
  // commercial-full.bicepparam pins `console: 'v2.1'`, which asks ACR for a
  // `loom-dbt-runner:v2.1` that no producer has ever pushed. Split into its own
  // key, read optionally so no existing param bag needs updating.
  { key: 'dbtRunner', repo: 'loom-dbt-runner', envVar: 'LOOM_DBT_RUNNER_TAG' },
  { key: 'transformRunner', repo: 'loom-transform-runner', envVar: 'LOOM_TRANSFORM_RUNNER_TAG' },
  { key: 'mapsTiles', repo: 'loom-maps-tileserver', envVar: 'LOOM_MAPS_TILES_TAG' },
  { key: 'duckdb', repo: 'loom-duckdb', envVar: 'LOOM_DUCKDB_TAG' },
  { key: 'loomMigrate', repo: 'loom-migrate', envVar: 'LOOM_MIGRATE_TAG' },
  { key: 'risingwave', repo: 'loom-risingwave', envVar: 'LOOM_RISINGWAVE_TAG' },
  // loom-unity (#2681). admin-plane/main.bicep now deploys the Unity-Catalog-
  // compatible OSS metastore DEFAULT-ON on every boundary and binds
  // LOOM_UNITY_URL, so its image became a hard prerequisite of the apps phase in
  // the same change. Before that it was produced only by gov-build-images.yml
  // and consumed only by a manual gov-uc-purview-wire.yml dispatch, so no
  // preflight covered it; now the Commercial lane's resolver picks it up
  // automatically from this table.
  { key: 'unity', repo: 'loom-unity', envVar: 'LOOM_UNITY_TAG' },
  // loom-trino (#2678). The N7e Federated SQL engine is now DEFAULT-ON as a
  // scale-to-zero Container App (data-plane/loom-trino-aca.bicep) wired straight
  // from admin-plane/main.bicep, so `appImageTags.trino` is read on every
  // boundary and its image is a prerequisite of the apps phase. Without an entry
  // here a scheduled reconcile would redeploy it at the BICEP DEFAULT rather than
  // the tag actually running — the exact drift this table exists to prevent.
  { key: 'trino', repo: 'loom-trino', envVar: 'LOOM_TRINO_TAG' },
  // loom-directlake (#3291). The HYP-5 Direct Lake columnar scan/frame service
  // is now DEFAULT-ON via compute/loom-directlake-app.bicep, wired from
  // admin-plane/main.bicep, so `appImageTags.directLakeSvc` is read on every
  // boundary and its image is a prerequisite of the apps phase.
  //
  // NOTE THE KEY. `directLake` (above) pins loom-direct-lake-shim — a DIFFERENT
  // app in a DIFFERENT repo (apps/fiab-direct-lake-shim, C#/TOM). Reusing that
  // key here would have recreated the exact one-key-two-repos defect the
  // dbtRunner split was opened to fix (#2775), where pinning the key to either
  // running tag necessarily rewrote the other.
  { key: 'directLakeSvc', repo: 'loom-directlake', envVar: 'LOOM_DIRECTLAKE_SVC_TAG' },
]);

/** key -> entry, for callers that have a key in hand. */
export const APP_IMAGE_TAG_BY_KEY = Object.freeze(
  Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.key, e])),
);

/**
 * Parse a container image reference into its parts.
 *
 * Handles every shape that appears in this estate:
 *   acrxxxx.azurecr.io/loom-console:5f9edba7…   registry + repo + tag
 *   mcr.microsoft.com/azure-functions/python:4  multi-segment repo
 *   loom-console:v0.1                           registry-less (bicep-local)
 *   acr.azurecr.io/loom-console@sha256:…        digest pin (NOT a tag)
 *
 * @param {string} image
 * @returns {{registry:string, repo:string, tag:string|null, digest:string|null}|null}
 *          null when the reference cannot be parsed at all.
 */
export function parseImageRef(image) {
  const s = String(image ?? '').trim();
  if (!s) return null;

  // Split off a digest first: it is unambiguous and may coexist with a tag.
  let digest = null;
  let rest = s;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
    if (!digest) return null;
  }

  // A registry is the first path segment ONLY when it looks like a host
  // (contains a dot or a port). `loom-console:v1` has no registry.
  const segments = rest.split('/');
  let registry = '';
  if (segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':'))) {
    registry = segments.shift();
  }
  const pathPart = segments.join('/');
  if (!pathPart) return null;

  // The tag is after the LAST colon, and only if that colon is in the final
  // path segment (a registry port colon has already been removed above).
  let repo = pathPart;
  let tag = null;
  const colon = pathPart.lastIndexOf(':');
  if (colon !== -1) {
    repo = pathPart.slice(0, colon);
    tag = pathPart.slice(colon + 1) || null;
    if (!repo || !tag) return null;
  }
  return { registry, repo, tag, digest };
}

/**
 * Match every running container back to the `appImageTags` key that governs it,
 * and decide, per key, whether the running tag is KNOWN.
 *
 * @param {Array<{name?:string, image?:string}>|null} containers
 *        `az containerapp list` projection. null = the query FAILED (UNKNOWN),
 *        which is deliberately NOT the same as an empty estate.
 * @returns {{
 *   probed: boolean,
 *   pinned: Record<string,string>,
 *   absent: string[],
 *   unknown: Array<{key:string, why:string}>,
 * }}
 */
export function resolveRunningImageTags(containers) {
  if (containers === null || containers === undefined) {
    return {
      probed: false,
      pinned: {},
      absent: [],
      unknown: APP_IMAGE_TAGS.map((e) => ({
        key: e.key,
        why: 'the container-app query failed, so no running tag could be read',
      })),
    };
  }

  // repo -> observed refs
  /** @type {Map<string, Array<{name:string, ref:ReturnType<typeof parseImageRef>, raw:string}>>} */
  const byRepo = new Map();
  for (const c of containers) {
    const raw = String(c?.image ?? '');
    const ref = parseImageRef(raw);
    if (!ref) continue;
    const list = byRepo.get(ref.repo) || [];
    list.push({ name: String(c?.name ?? ''), ref, raw });
    byRepo.set(ref.repo, list);
  }

  const pinned = {};
  const absent = [];
  const unknown = [];

  for (const entry of APP_IMAGE_TAGS) {
    const hits = byRepo.get(entry.repo) || [];
    if (hits.length === 0) {
      // Nothing is running this repository. Deploying it CREATES an app; it
      // cannot change a running image, so the invariant is untouched.
      absent.push(entry.key);
      continue;
    }
    const digestPinned = hits.filter((h) => h.ref.digest);
    if (digestPinned.length) {
      unknown.push({
        key: entry.key,
        why: `running by digest (${digestPinned.map((h) => h.name).join(', ')}); a tag cannot be derived from a digest without resolving it in ACR`,
      });
      continue;
    }
    const tags = [...new Set(hits.map((h) => h.ref.tag).filter(Boolean))];
    if (tags.length !== 1) {
      unknown.push({
        key: entry.key,
        why: `${hits.length} container(s) run ${entry.repo} at ${tags.length} different tags (${tags.join(', ') || 'none'}); one appImageTags key cannot preserve both`,
      });
      continue;
    }
    pinned[entry.key] = tags[0];
  }

  return { probed: true, pinned, absent, unknown };
}

/**
 * Decide the FINAL `deployAppsEnabled` for a run.
 *
 * Composition, deliberately: `baseValue` is whatever deploy-trigger-policy.mjs
 * already resolved (an operator's input on a dispatch, SCHEDULE_FLAG_DEFAULTS'
 * safe 'false' on a schedule). This function may only ever UPGRADE the
 * scheduled value to 'true', and only on positive evidence. It never touches an
 * operator's explicit dispatch choice — a human who typed `deploy_apps_enabled`
 * has taken responsibility for the image tags they are deploying.
 *
 * @param {object} a
 * @param {string} a.eventName
 * @param {string} a.baseValue              'true' | 'false' from the trigger policy
 * @param {ReturnType<typeof resolveRunningImageTags>} a.resolution
 * @returns {{value:'true'|'false', reason:string, upgraded:boolean}}
 */
export function decideDeployApps({ eventName, baseValue, resolution } = {}) {
  const base = String(baseValue) === 'true' ? 'true' : 'false';

  if (eventName !== 'schedule') {
    return {
      value: base,
      upgraded: false,
      reason: `operator dispatch — deploy_apps_enabled stays as supplied (${base}).`,
    };
  }
  if (base === 'true') {
    return { value: 'true', upgraded: false, reason: 'already enabled upstream.' };
  }
  if (!resolution || resolution.probed !== true) {
    return {
      value: 'false',
      upgraded: false,
      reason:
        'the running container images could not be read, so pinning appImageTags to them is impossible. ' +
        'Staying infra-only rather than deploying the bicep default (v0.1) over a running estate.',
    };
  }
  if (resolution.unknown.length) {
    return {
      value: 'false',
      upgraded: false,
      reason:
        'these image tags are UNKNOWN, not absent: ' +
        resolution.unknown.map((u) => `${u.key} (${u.why})`).join('; ') +
        '. Staying infra-only.',
    };
  }
  if (!resolution.pinned.console) {
    return {
      value: 'false',
      upgraded: false,
      reason:
        'no running loom-console image was found, so this is not a reconcile of a live Console. ' +
        'Bringing one up is an operator dispatch (run_mode=full), not an unattended job.',
    };
  }
  return {
    value: 'true',
    upgraded: true,
    reason:
      `every running image is pinned to its CURRENT tag (${Object.keys(resolution.pinned).length} resolved, ` +
      `${resolution.absent.length} not deployed), so app-deployments.bicep re-applies Console env with a ` +
      'no-op image. This is what makes a scheduled reconcile able to configure the estate.',
  };
}

/** `rg-csa-loom-admin-<region>` — the name admin-plane deploys under. */
const ADMIN_RG_RE = /^rg-csa-loom-admin-([a-z0-9]+)$/;

/**
 * Work out which region a run must target — ADOPT the estate, or REFUSE.
 *
 * The bug this replaces (refs #3029): `AZURE_LOCATION: ${{ inputs.region ||
 * 'eastus2' }}`, plus a resolver that honoured that default on every dispatch.
 * A schedule carries no inputs and a dispatch that leaves the blank field blank
 * carries none either, so BOTH aimed at eastus2 while the estate lives in
 * centralus. Run 31065425280 is the receipt: the guard printed
 * `PROCEED -- reconciling the existing hub` and the resolver then reported all
 * 18 apps "not deployed", because it was looking at the wrong region. A
 * `run_mode=full` on those inputs would have stamped a complete SECOND estate
 * and left the real one untouched.
 *
 * The region is not a tag: `rg-csa-loom-admin-<region>`, `vnet-csa-loom-hub-
 * <region>` and `uami-loom-console-<region>` are all derived from it, so a wrong
 * region does not fail — it SUCCEEDS against a different, empty estate.
 *
 * THERE IS THEREFORE NO DEFAULT REGION. Every outcome is one of:
 *   - adopt   the region of the single hub that exists (loudly stated), or
 *   - accept  an explicit input that MATCHES the estate, or
 *   - accept  an explicit input when the subscription provably holds no hub
 *             (a genuine first-run install), or
 *   - REFUSE.
 *
 * A mismatch between an explicit `region` and the hub that exists is a hard
 * refusal on every trigger. It cannot be overridden here: a second Console in
 * the same subscription is already forbidden by resolveTopologyGuard, so
 * "deploy to a different region of this sub" has no legitimate caller. A second
 * estate goes in a different subscription.
 *
 * @param {object} a
 * @param {string} a.eventName
 * @param {string} [a.requestedRegion]  the `region` input
 * @param {string[]|null} [a.adminRgNames] rg-csa-loom-admin-* names in the sub;
 *                                         null = the query FAILED (UNKNOWN)
 * @returns {{decision:'use'|'refuse', region?:string, source?:'input'|'adopted', reason:string}}
 */
export function resolveReconcileRegion({
  eventName,
  requestedRegion = '',
  adminRgNames = null,
} = {}) {
  const requested = String(requestedRegion || '').trim();
  const dispatchHint =
    'Dispatch with an explicit `region` input naming the region you mean (the workflow declares it required).';

  // UNKNOWN is not "no hub". A read that failed establishes nothing about the
  // estate, and "I could not look" must never be spent as "there is nothing
  // there" (deploy-integrity R7).
  if (adminRgNames === null || adminRgNames === undefined) {
    return {
      decision: 'refuse',
      reason:
        'could not list rg-csa-loom-admin-* resource groups, so it is UNKNOWN which region this ' +
        'subscription\'s estate is in — and therefore UNKNOWN whether ' +
        `${requested ? `the requested region (${requested})` : 'any region'} would reconcile it or ` +
        'build a second one beside it. Refusing. Re-run once `az group list` works.',
    };
  }

  const regions = [...new Set(
    adminRgNames
      .map((n) => ADMIN_RG_RE.exec(String(n).trim()))
      .filter(Boolean)
      .map((m) => m[1]),
  )];

  // ---- no hub in this subscription: a genuine first-run install -----------
  if (regions.length === 0) {
    if (requested) {
      return {
        decision: 'use',
        region: requested,
        source: 'input',
        reason:
          `no rg-csa-loom-admin-* exists in this subscription, so this is a first-run install at the ` +
          `region you named (${requested}). Nothing is being reconciled.`,
      };
    }
    return {
      decision: 'refuse',
      reason:
        'this subscription holds no CSA Loom hub, so there is no estate to derive a region from, and ' +
        'no region may be assumed — assuming one is exactly how a "reconcile" became a second estate ' +
        `in another region (#3029). ${dispatchHint}`,
    };
  }

  // ---- hubs exist: the estate decides, or an explicit input must match ----
  if (regions.length > 1) {
    if (requested && regions.includes(requested)) {
      return {
        decision: 'use',
        region: requested,
        source: 'input',
        reason:
          `this subscription holds hubs in ${regions.length} regions (${regions.join(', ')}); the ` +
          `explicit region input selects ${requested}, which is one of them.`,
      };
    }
    return {
      decision: 'refuse',
      reason:
        `this subscription holds hubs in ${regions.length} regions (${regions.join(', ')})` +
        (requested
          ? `, and the requested region (${requested}) is not one of them. Deploying there would build ` +
            'a THIRD estate rather than reconciling either existing one.'
          : ', and no region input was supplied to choose between them. ' + dispatchHint),
    };
  }

  const [only] = regions;
  if (!requested) {
    return {
      decision: 'use',
      region: only,
      source: 'adopted',
      reason:
        `no region input was supplied; ADOPTED ${only}, the region of the only CSA Loom hub in this ` +
        `subscription (rg-csa-loom-admin-${only}). No region was assumed — this one was measured.`,
    };
  }
  if (requested !== only) {
    return {
      decision: 'refuse',
      reason:
        `region=${requested} was requested, but the only CSA Loom hub in this subscription is in ` +
        `${only} (rg-csa-loom-admin-${only}). Deploying to ${requested} would NOT reconcile that hub — ` +
        `it would stand up a second, empty estate in ${requested} at full cost and leave the real one ` +
        `untouched, while every log line claimed a reconcile (#3029). Re-dispatch with ` +
        `region=${only}. If a second estate is genuinely intended it belongs in a different ` +
        'subscription (a second Console in this one is refused by the topology guard regardless).',
    };
  }
  return {
    decision: 'use',
    region: only,
    source: 'input',
    reason: `region=${only} matches the CSA Loom hub in this subscription (rg-csa-loom-admin-${only}).`,
  };
}

/**
 * The `NAME=value` lines to append to $GITHUB_ENV so `commercial.bicepparam`'s
 * `readEnvironmentVariable('LOOM_<APP>_TAG', 'v0.1')` calls resolve to the tags
 * that are actually running.
 *
 * Only PINNED keys are emitted. An absent key is left to the param file's
 * default on purpose: there is no running image to preserve, and inventing one
 * would be a guess.
 *
 * @param {Record<string,string>} pinned
 * @returns {string[]}
 */
export function tagEnvLines(pinned = {}) {
  const lines = [];
  for (const entry of APP_IMAGE_TAGS) {
    const tag = pinned?.[entry.key];
    if (!tag) continue;
    lines.push(`${entry.envVar}=${tag}`);
  }
  return lines;
}

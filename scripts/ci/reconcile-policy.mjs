/**
 * reconcile-policy.mjs — decision logic for the SCHEDULED reconcile of
 * deploy-fiab-commercial.yml, plus a FILE-FED CLI the workflow calls.
 *
 * Everything above the `CLI` banner at the bottom is pure: no Azure calls, no
 * network, no clock. The CLI reads files and argv that the workflow's own
 * `run:` blocks produced (they own the `az` / `gh` I/O and its exit codes) and
 * turns them into a verdict, so the decisions stay unit-testable end to end.
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
 * …AND THE WAY THAT MEASUREMENT WENT STALE (#3676, measured 2026-08-17)
 * --------------------------------------------------------------------
 * The measurement was correct. It was just taken SIXTEEN MINUTES before it was
 * used, and the roll lane writes the same field.
 *
 *   07:03:06  deploy-fiab-commercial starts (schedule)
 *   07:03:40  [reconcile] PIN console loom-console:587ac3b8…   <- true then
 *   07:04:36  loom-roll-and-validate starts for b9ca620b
 *   07:10:56  revision 0000755 — loom-console:b9ca620b…        <- the roll lands
 *   07:19:48  revision 0000756 — loom-console:587ac3b8…        <- the APPLY, stale
 *   07:27:26  deploy-fiab-commercial: success
 *
 * Both lanes reported success. Nothing anywhere compared the estate AFTER the
 * apply with what the roll had established, so a nine-minute-old security fix
 * (PR #3665, GHSA-v2g8-gp3r-rg4r) was reverted off production in silence.
 *
 * It had happened before. The 2026-08-15 scheduled run (31870181337) pinned
 * `8f8e569a` at 06:44:38, roll 31870718201 moved the console to `2dda97b4`
 * between 06:57 and 07:10, and the deploy's own outputs at 07:26:33 record
 * `"console": "8f8e569a…"` — the same revert, two days earlier, equally silent.
 *
 * SO THIS FILE NOW HOLDS TWO MORE INVARIANTS:
 *
 *   I-FRESH   The pin that is APPLIED was measured immediately before the
 *             apply, not at the top of the job. decidePinRefresh() re-reads and
 *             RE-PINS to whatever is running now; it refuses only when the
 *             estate could not be read at all, or when a key that was pinned
 *             has become UNKNOWN. Re-pinning (rather than refusing) is
 *             deliberate: a roll lands inside a scheduled deploy's window
 *             roughly one night in three, and a guard that refuses one night in
 *             three is a guard that gets switched off. Re-pinning to the tag
 *             that is RUNNING is also strictly safer than the tag that was
 *             running — a running image is a proven-pullable image.
 *
 *   I-BEHIND  After the apply, the console must be running what the most recent
 *             EFFECTIVE roll put there. decideEstateRegression() fails the run
 *             loudly when it is not, and fails CLOSED when either side of that
 *             comparison cannot be established. This is the half that matters:
 *             I-FRESH narrows the window, it does not close it (a roll can land
 *             while ARM is mid-apply), so something has to NOTICE.
 *
 * …AND THE WAY I-BEHIND FAILED TO NOTICE (#3676 REOPENED, 2026-08-19)
 * -------------------------------------------------------------------
 * I-BEHIND shipped, ran on the very next revert, and reported OK.
 *
 *   06:57:53  [repin] measured + pinned console 83e7cab6…
 *   07:04:56  revision 0000782 — loom-console:150d2937…   <- roll 32225337320
 *   07:10:19  revision 0000783 — loom-console:83e7cab6…   <- the apply, stale
 *   07:11:02  roll 32225337320 completes, SUCCESS
 *   07:14:52  [estate-vs-roll] "0 run(s) completed in that window"  -> OK
 *   07:14:18  deploy-fiab-commercial: SUCCESS
 *
 * The decision logic was correct; its POPULATION was empty. The gate built that
 * population from the GitHub Actions API, and at 07:14:52 that API's filtered
 * listing did not contain a run that had completed at 07:11:02. Replaying the
 * gate's exact query today returns that run and drives the same code straight
 * to `regression`, so nothing about the comparison needed fixing.
 *
 * WHY the API omitted it is NOT established and is not asserted anywhere in
 * this file. What IS established is the design error: the gate asked a
 * third-party, eventually-consistent index a question about OUR estate, while
 * the estate held a timestamped, lag-free answer the whole time.
 *
 *   I-ESTATE  The window is read from the Container App's OWN revision history
 *             (selectRevisionOverwrite), which needs no token, no Actions API
 *             and no consistency window. A revision exists the moment ARM
 *             creates it. It is consulted FIRST and is strictly additive — it
 *             can turn an OK into a regression, never a regression into an OK.
 *
 * …AND THE TWO WAYS I-ESTATE COULD STILL HAVE READ THE WRONG THING (2026-08-21)
 * ----------------------------------------------------------------------------
 * Both found in independent review of the change above (#3797, #3798), and both
 * are about which FACT the comparison rests on rather than about the comparison.
 *
 *   I-SERVING  "The live image" is the revision TAKING TRAFFIC, not the newest
 *              one. selectRevisionOverwrite read recency, which is true on this
 *              estate only because app-deployments.bicep pins
 *              `latestRevision: true` on an app running in Multiple mode
 *              expressly so traffic CAN be split (console-bluegreen-roll.yml).
 *              A roll landing at weight 0 while the deploy's revision keeps
 *              100% would have read as `ahead` — a false green in the exact
 *              class this gate exists to catch. selectServingRevision reads
 *              `properties.trafficWeight`, which the platform computes from
 *              whichever split is configured, and a payload that carries no
 *              weights at all is UNKNOWN rather than a quiet fall back to
 *              recency (#3798).
 *
 *   I-BLAME    'overwritten' is an ATTRIBUTION and is claimed ONLY when THIS
 *              apply's revision came AFTER the competing one. The first draft
 *              of I-SERVING dropped that precondition and accused this apply of
 *              overwriting revisions that landed after it — including, exactly,
 *              a blue-green green revision deployed at weight 0 and still being
 *              health-gated. With an auto-dispatch wired to that verdict the
 *              gate would have promoted an image another lane was validating.
 *              Later-than-ours is 'drifted': loud, exit 1, no direction, no
 *              roll-forward target (deploy-integrity R7).
 *
 *   I-DEFINITE An unreadable SECOND source must not discard a definite FIRST
 *              one. `revisionSelection === 'unknown'` used to return before the
 *              Actions-API comparison was consulted, throwing away an
 *              ESTABLISHED regression — and with it the roll-forward SHA — on
 *              the one run where a source that HAD answered could say what to
 *              do next. Only `regression` survives that path; an `ok` never
 *              does, so an unreadable estate still cannot be laundered green
 *              (#3797).
 *
 * AND DETECTION IS NOT RECOVERY (#3799)
 * -------------------------------------
 * On a definite `regression` carrying a 40-hex SHA the CLI writes that SHA to
 * the file named by `--heal-request`, and the deploy's auto-heal step dispatches
 * loom-roll-and-validate at it, then re-reads the estate to see whether the
 * image actually came back. The run still fails: healing must not convert a
 * detected regression into a green build, or this class goes invisible again.
 * Nothing is dispatched for `unknown` (nothing established) or `drifted` (no
 * direction claimed — rolling to a guessed SHA could move a HEALTHY estate
 * backwards).
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
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

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

// ===========================================================================
// I-FRESH — the pin that is APPLIED must have been measured just now (#3676)
// ===========================================================================

/** envVar -> appImageTags key, for reading pins back out of the environment. */
export const KEY_BY_TAG_ENV_VAR = Object.freeze(
  Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.envVar, e.key])),
);

/**
 * The pins a previous step exported, read back out of an environment bag.
 *
 * `reconcile-resolve.mjs` writes `LOOM_<APP>_TAG=<tag>` to $GITHUB_ENV, which
 * GitHub then injects into every later step. That environment IS the record of
 * what the apply will write, because `commercial.bicepparam` resolves
 * `readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v0.1')` at bicep-compile time —
 * i.e. inside `az deployment sub create`, not when the args file was composed.
 * (That is also what makes re-pinning possible at all: a later $GITHUB_ENV
 * write reaches the apply without touching the sha256-locked args file.)
 *
 * @param {Record<string,string|undefined>} env
 * @returns {Record<string,string>} key -> tag
 */
export function pinsFromEnv(env = {}) {
  const out = {};
  for (const entry of APP_IMAGE_TAGS) {
    const v = env?.[entry.envVar];
    if (typeof v === 'string' && v.trim()) out[entry.key] = v.trim();
  }
  return out;
}

/**
 * Compare the pins already exported with a FRESH read of the estate.
 *
 * Four classes, deliberately kept apart:
 *   moved     pinned to X, now running Y — the roll race. RE-PIN to Y.
 *   appeared  not pinned, now running Y — an app came up under us and the
 *             param-file default would be written over it. RE-PIN to Y.
 *   vanished  pinned to X, no longer running anything. Not a revert (writing X
 *             CREATES the app), so it is reported, not refused.
 *   unknown   pinned to X, and the fresh read cannot say what it runs.
 *
 * @param {Record<string,string>} previous  key -> tag, from pinsFromEnv()
 * @param {ReturnType<typeof resolveRunningImageTags>} resolution fresh read
 */
export function comparePins(previous = {}, resolution = null) {
  const moved = [];
  const appeared = [];
  const vanished = [];
  const unknown = [];
  if (!resolution || resolution.probed !== true) {
    return { probed: false, moved, appeared, vanished, unknown };
  }
  const unknownWhy = new Map((resolution.unknown || []).map((u) => [u.key, u.why]));
  const absent = new Set(resolution.absent || []);
  for (const entry of APP_IMAGE_TAGS) {
    const was = previous?.[entry.key];
    const now = resolution.pinned?.[entry.key];
    if (was && unknownWhy.has(entry.key)) {
      unknown.push({ key: entry.key, repo: entry.repo, was, why: unknownWhy.get(entry.key) });
      continue;
    }
    if (was && absent.has(entry.key)) {
      vanished.push({ key: entry.key, repo: entry.repo, was });
      continue;
    }
    if (was && now && was !== now) {
      moved.push({ key: entry.key, repo: entry.repo, was, now });
      continue;
    }
    if (!was && now) {
      appeared.push({ key: entry.key, repo: entry.repo, now });
    }
  }
  return { probed: true, moved, appeared, vanished, unknown };
}

/**
 * Decide what to do immediately before the apply.
 *
 * @param {object} a
 * @param {string} a.deployAppsEnabled  the FINAL value the az command carries
 * @param {Record<string,string>} a.previous  pins already exported
 * @param {ReturnType<typeof resolveRunningImageTags>|null} a.resolution fresh read
 * @param {string} [a.readError]  why the fresh read failed, when it did
 * @returns {{decision:'proceed'|'refuse', repin:Record<string,string>,
 *            comparison:ReturnType<typeof comparePins>, reason:string}}
 */
export function decidePinRefresh({ deployAppsEnabled, previous = {}, resolution = null, readError = '' } = {}) {
  const comparison = comparePins(previous, resolution);
  const none = { repin: {}, comparison };

  // A run that does not render the Container Apps writes no image, so there is
  // no pin to be stale. Saying this out loud beats a silent skip: the step is
  // still reached, still logs, and still cannot be mistaken for a check that
  // ran and found nothing.
  if (String(deployAppsEnabled) !== 'true') {
    return {
      ...none,
      decision: 'proceed',
      reason:
        `deployAppsEnabled=${String(deployAppsEnabled) || '(empty)'} — app-deployments.bicep does not run on this ` +
        'deploy, so no container image is written and no pin can go stale. Nothing to re-measure.',
    };
  }

  if (!resolution || resolution.probed !== true) {
    return {
      ...none,
      decision: 'refuse',
      reason:
        'the RUNNING container images could not be re-read immediately before the apply, so it is UNKNOWN ' +
        'whether the tags this deploy is about to write are still the tags that are running. They were measured ' +
        'minutes ago and the roll lane writes the same field (#3676). Refusing rather than applying a pin that ' +
        'cannot be shown to be current — an unreadable estate is not permission to proceed (deploy-integrity R7)' +
        (readError ? `. Detail: ${String(readError).slice(0, 400)}` : '.'),
    };
  }

  if (comparison.unknown.length) {
    return {
      ...none,
      decision: 'refuse',
      reason:
        'these images were pinned by this run and the fresh read can no longer say what they are running: ' +
        comparison.unknown.map((u) => `${u.key} (pinned ${u.was}; ${u.why})`).join('; ') +
        '. Applying the earlier pin might revert them and might not — UNKNOWN is not "unchanged". Refusing.',
    };
  }

  const repin = { ...(resolution.pinned || {}) };
  const drifted = comparison.moved.length + comparison.appeared.length;
  if (drifted === 0) {
    return {
      ...none,
      repin,
      decision: 'proceed',
      reason:
        `re-measured ${Object.keys(repin).length} running image(s) immediately before the apply; every one still ` +
        'matches the tag this deploy will write. The ARM PUT is a no-op for every image.',
    };
  }

  const parts = [];
  if (comparison.moved.length) {
    parts.push(
      'MOVED under this run: ' +
        comparison.moved.map((m) => `${m.repo} ${m.was} -> ${m.now}`).join(', '),
    );
  }
  if (comparison.appeared.length) {
    parts.push(
      'came up under this run: ' +
        comparison.appeared.map((m) => `${m.repo} now running ${m.now}`).join(', '),
    );
  }
  return {
    ...none,
    repin,
    decision: 'proceed',
    reason:
      `RE-PINNED ${drifted} image(s) to what is running RIGHT NOW — ${parts.join('; ')}. ` +
      'Applying the earlier measurement would have written the older tag back over the estate, which is exactly ' +
      'how PR #3665 was reverted nine minutes after it went live (#3676). The what-if above previewed the earlier ' +
      'tag for these image fields; every other argument is byte-identical, and the tags written are tags that are ' +
      'currently RUNNING, so they are known-pullable without a further registry read.',
  };
}

// ===========================================================================
// I-BEHIND — after the apply, the estate must not be behind the last roll
// ===========================================================================

/**
 * The lanes that legitimately write `loom-console`'s image, and how to read the
 * SHA each run actually shipped.
 *
 * WHY BOTH. Scanning only loom-roll-and-validate would make this gate cry wolf
 * the moment somebody uses full-app-deploy-commercial (which builds AND rolls
 * from its own head SHA): the estate would be ahead of the roll lane and the
 * gate would call that a regression. A guard that cries wolf is a guard that
 * gets switched off, so both writers are in the population.
 *
 * `job` is matched against the run's JOB names, not the run conclusion, because
 * a roll run can conclude SUCCESS having rolled NOTHING — measured 2026-08-17,
 * run 32006479915: `Should this roll proceed?` succeeded, `Roll image + validate
 * live URL` was SKIPPED (the console image had not built), and the run reports
 * `success`. Reading the run conclusion would have named 66bb26e7 as "the last
 * successful roll" when nothing of the sort had been deployed.
 *
 * `tagFrom` says where that run's shipped SHA lives:
 *   'title'    loom-roll-and-validate's `run-name` — `roll <sha> (…)`. Its
 *              `head_sha` is the DEFAULT-BRANCH HEAD at trigger time, NOT the
 *              SHA it rolls (#2963), so the title is the only honest source.
 *   'headSha'  full-app-deploy-commercial builds from its own checkout, so the
 *              run's head_sha IS the tag it pushes and rolls.
 */
export const CONSOLE_ROLL_SOURCES = Object.freeze([
  Object.freeze({
    workflow: 'loom-roll-and-validate.yml',
    jobPattern: 'Roll image + validate live URL',
    tagFrom: 'title',
  }),
  Object.freeze({
    workflow: 'full-app-deploy-commercial.yml',
    jobPattern: 'Roll Container Apps to new image',
    tagFrom: 'headSha',
  }),
]);

/** A 40-hex commit SHA — the only tag shape this gate can compare. */
export const SHA_TAG_RE = /^[0-9a-f]{40}$/;

/**
 * The `appImageTags` key that drives `loom-console`, DERIVED from the table
 * rather than spelled 'console' at each use site.
 *
 * The repo has already shipped one key whose name and repository disagreed
 * (`directLake` pins loom-direct-lake-shim, `directLakeSvc` pins loom-
 * directlake), so a literal 'console' here would be a second place that can
 * drift. If the table ever stops naming loom-console this throws at import,
 * which is the honest outcome: the gate cannot pin a repository it cannot find.
 */
export const CONSOLE_IMAGE_KEY = (() => {
  const e = APP_IMAGE_TAGS.find((x) => x.repo === 'loom-console');
  if (!e) throw new Error('reconcile-policy: APP_IMAGE_TAGS names no entry for the loom-console repository.');
  return e.key;
})();

/**
 * Pull the rolled SHA out of loom-roll-and-validate's `run-name`.
 *
 * The contract is that workflow's `run-name:` literal:
 *   roll <tag> (build-triggered)   |   roll <tag> (manual dispatch)
 *
 * A dispatch may name a floating tag ('latest', a prefix). That is a perfectly
 * normal roll and NOT an error — but the SHA it resolved to lives only inside
 * that run, so this returns `sha: null` and the caller must treat it as
 * UNKNOWN rather than comparing a floating name to a commit SHA.
 *
 * @param {string} title
 * @returns {{tag:string, sha:string|null, trigger:string}|null} null = unparseable
 */
export function parseRollRunTitle(title) {
  const m = /^roll\s+(\S+)\s+\((build-triggered|manual dispatch)\)\s*$/.exec(String(title ?? '').trim());
  if (!m) return null;
  const tag = m[1];
  return { tag, sha: SHA_TAG_RE.test(tag) ? tag : null, trigger: m[2] };
}

/**
 * Which console-writing run last actually shipped an image?
 *
 * @param {Array<{id:(number|string), workflow:string, title?:string, headSha?:string,
 *                completedAt:string, jobCompletedAt?:string, jobConclusion:(string|null)}>|null} runs
 *        Already filtered by the caller to runs that COMPLETED after the pin was
 *        measured. `jobConclusion: null` means the run's jobs could not be read.
 *        `runs: null` means the run list itself could not be read.
 *
 *        ORDERING USES `jobCompletedAt` WHEN PRESENT. The run's `updated_at` is
 *        when the whole run finished, which for the roll lane trails the actual
 *        `az containerapp update` by minutes — on the incident night, 4m45s
 *        (update 07:10:44, run completed 07:15:30). With two writers finishing
 *        close together, ordering by the run can name the wrong "latest". The
 *        job's own completion is the closest observable proxy for the write and
 *        the caller already fetches it. `completedAt` remains the fallback so a
 *        caller that cannot supply the job time still gets an answer rather than
 *        an exception.
 * @returns {{status:'none'|'found'|'unknown', roll?:object, reason:string}}
 */
export function selectLastConsoleRoll(runs) {
  if (runs === null || runs === undefined) {
    return {
      status: 'unknown',
      reason:
        'the console-rolling workflow runs could not be listed, so it is UNKNOWN what the estate was last rolled ' +
        'to and therefore UNKNOWN whether this deploy moved it backwards.',
    };
  }
  const unreadable = runs.filter((r) => r && r.jobConclusion === null);
  if (unreadable.length) {
    return {
      status: 'unknown',
      reason:
        `${unreadable.length} console-rolling run(s) completed in this window but their jobs could not be read ` +
        `(${unreadable.map((r) => `${r.workflow}#${r.id}`).join(', ')}), so it is UNKNOWN whether any of them ` +
        'shipped an image. "I could not look" is not "nothing happened".',
    };
  }
  const shipped = runs.filter((r) => r && r.jobConclusion === 'success');
  if (!shipped.length) {
    return {
      status: 'none',
      reason:
        `the Actions API listed ${runs.length} completed console-rolling run(s) in that window and none of them ` +
        'had a successful roll job, so THE ACTIONS API shows nothing this deploy could have overwritten. That is ' +
        'a statement about the API listing, NOT about the estate: on 2026-08-19 this same clause read "0 run(s)" ' +
        'and went green while roll 32225337320 — completed 3m50s earlier — had in fact been overwritten. The ' +
        'estate itself is read by the revision-history check, which does not depend on this listing.',
    };
  }
  /** When the image write actually landed, as closely as this data allows. */
  const wroteAt = (r) => Date.parse(r?.jobCompletedAt || r?.completedAt || 0) || 0;
  const latest = shipped.reduce((a, b) => (wroteAt(b) > wroteAt(a) ? b : a));
  const source = CONSOLE_ROLL_SOURCES.find((s) => s.workflow === latest.workflow);
  if (!source) {
    return {
      status: 'unknown',
      reason:
        `run ${latest.id} came from '${latest.workflow}', which is not in CONSOLE_ROLL_SOURCES, so this file ` +
        'does not know how to read the SHA it shipped. An unrecognised writer is not a pass.',
    };
  }
  let sha = null;
  if (source.tagFrom === 'headSha') {
    const v = String(latest.headSha || '').trim();
    sha = SHA_TAG_RE.test(v) ? v : null;
  } else {
    const parsed = parseRollRunTitle(latest.title);
    sha = parsed ? parsed.sha : null;
  }
  if (!sha) {
    return {
      status: 'unknown',
      reason:
        `${latest.workflow} run ${latest.id} shipped an image at ${latest.completedAt}, but the SHA it shipped ` +
        `could not be read from ${source.tagFrom === 'headSha' ? `its head_sha ('${latest.headSha || ''}')` : `its run title (${JSON.stringify(latest.title || '')})`}` +
        ' — a floating tag, or a changed run-name. Comparing the estate to a SHA that was never established would ' +
        'assert something this code did not measure (deploy-integrity R7).',
    };
  }
  return {
    status: 'found',
    roll: { id: latest.id, workflow: latest.workflow, sha, completedAt: latest.completedAt },
    reason: `${latest.workflow} run ${latest.id} shipped loom-console:${sha} at ${latest.completedAt}.`,
  };
}

/**
 * WHICH revision is the estate actually SERVING? (#3798)
 *
 * ── WHY RECENCY WAS NOT AN ANSWER, ONLY A COINCIDENCE ───────────────────────
 *
 * selectRevisionOverwrite used to read "the newest revision in the window" as
 * "the live image". Measured on the Commercial estate 2026-08-21:
 *
 *   activeRevisionsMode : Multiple
 *   revisions           : 54, every one active
 *   trafficWeight       : 53 x 0, and exactly ONE at 100 (the newest)
 *   ingress traffic     : [{ latestRevision: true, weight: 100 }]
 *
 * So recency IS serving today — but only because app-deployments.bicep pins
 * `latestRevision: true` on an app whose mode is Multiple *specifically so that
 * traffic can be split imperatively* by console-bluegreen-roll.yml. The moment
 * that lane works, a roll can create revision N+1 carrying the new tag at
 * WEIGHT 0 while the deploy's revision keeps 100% of the traffic — and the
 * recency reading would report `ahead` ("this apply did not leave the estate
 * behind") about an estate that is serving the deploy's stale image. A false
 * green in the exact class #3676 exists to catch, produced by the gate written
 * to catch it.
 *
 * The platform computes `properties.trafficWeight` per revision from whatever
 * split is configured — including resolving `latestRevision: true` to an actual
 * revision — so reading the weights answers "what is serving" under BOTH split
 * styles, with no second API call and no assumption about the bicep.
 *
 * ── UNWEIGHTED IS ITS OWN STATUS, AND EVERY CALLER FAILS CLOSED ON IT ───────
 *
 * A payload where NO revision carries a weight is a projection that did not ask
 * for one. The first draft of this change fell back to RECENCY there and
 * claimed the fallback was disclosed in the verdict; it was not — on the path
 * that matters (`rollSelection.status === 'found'` and the estate on the roll's
 * SHA) the OK message never interpolates the revision reason at all, so the
 * fallback was silent, and flipping `trafficWeight` to null on an otherwise
 * identical incident payload turned `regression` + a heal SHA into a green
 * `ok`. There is also no caller it protected: `assert-estate-not-behind-roll`
 * has exactly ONE production call site (deploy-fiab-commercial.yml, three
 * invocations, all projecting `trafficWeight`), and the sovereign lanes do not
 * call it at all.
 *
 * So `unweighted` is reported as its own status and BOTH callers fail closed on
 * it: selectRevisionOverwrite returns UNKNOWN, and the `serving-tag` CLI exits
 * 1. Weights present and all ZERO, a digest-pinned serving revision, and
 * traffic split across two different IMAGES are equally UNKNOWN — the live
 * image is genuinely not a single comparable value.
 *
 * @param {Array<{name?:string, image?:string, trafficWeight?:(number|string|null)}>|null} revisions
 * @returns {{status:'found'|'unweighted'|'unknown', tag?:string, name?:string,
 *            weight?:number, reason:string}}
 */
export function selectServingRevision(revisions) {
  if (revisions === null || revisions === undefined || !Array.isArray(revisions)) {
    return {
      status: 'unknown',
      reason:
        'the revision history is not a readable array, so which revision is taking traffic could not be read from it.',
    };
  }
  /** A weight the platform actually reported. null = this revision reported none. */
  const weightOf = (r) => {
    const v = r?.trafficWeight;
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const weighted = revisions.map((raw) => ({ raw, w: weightOf(raw) })).filter((x) => x.w !== null);
  if (!weighted.length) {
    return {
      status: 'unweighted',
      reason:
        `none of the ${revisions.length} revision(s) in this payload carries a trafficWeight, so the traffic ` +
        'split was NOT read and which revision is serving is NOT established by this data.',
    };
  }
  const serving = weighted.filter((x) => x.w > 0);
  if (!serving.length) {
    return {
      status: 'unknown',
      reason:
        `all ${weighted.length} revision(s) that report a traffic weight report 0, so NO revision is taking ` +
        'traffic and the image the estate serves cannot be derived from the split. That is not "the newest one" — ' +
        'it is an app that is serving nothing, which this gate will not guess past.',
    };
  }
  const tags = new Set();
  for (const { raw, w } of serving) {
    const ref = parseImageRef(String(raw?.image ?? ''));
    const tag = ref && ref.tag ? ref.tag : null;
    if (!tag) {
      return {
        status: 'unknown',
        reason:
          `revision ${JSON.stringify(String(raw?.name ?? ''))} is SERVING (${w}% of traffic) an image ` +
          `${JSON.stringify(String(raw?.image ?? ''))} that carries no tag this gate can compare ` +
          `${ref && ref.digest ? '(it is digest-pinned, and a digest does not name a commit)' : '(unparseable)'}.`,
      };
    }
    tags.add(tag);
  }
  if (tags.size > 1) {
    return {
      status: 'unknown',
      reason:
        `traffic is split across ${tags.size} different images (${[...tags].join(', ')}), so "the image the estate ` +
        'is running" is not a single value this gate can compare against the tag this deploy applied.',
    };
  }
  const top = serving.reduce((a, b) => (b.w > a.w ? b : a));
  return {
    status: 'found',
    tag: [...tags][0],
    name: String(top.raw?.name ?? ''),
    weight: top.w,
    reason:
      `revision ${String(top.raw?.name ?? '')} is serving loom-console:${[...tags][0]} (${top.w}% of traffic` +
      `${serving.length > 1 ? `, across ${serving.length} revisions of the same image` : ''}).`,
  };
}

/**
 * Did THIS apply overwrite a newer image that landed inside its own window —
 * according to the ESTATE, not according to GitHub?
 *
 * ── WHY THIS EXISTS, WHEN selectLastConsoleRoll ALREADY DID THIS (#3676) ────
 *
 * On 2026-08-19 the post-apply gate ran, reported OK, and the estate had gone
 * backwards while it did. Measured from the Container App itself:
 *
 *   0000781  2026-08-19T05:46:46Z  loom-console:83e7cab6…
 *   0000782  2026-08-19T07:04:56Z  loom-console:150d2937…   <- the roll
 *   0000783  2026-08-19T07:10:19Z  loom-console:83e7cab6…   <- the apply, stale
 *
 * The gate's own verdict at 07:14:52Z was:
 *
 *   "0 run(s) completed in that window, none with a successful roll job"
 *
 * Roll run 32225337320 had completed at 07:11:02Z — 3m50s earlier — with its
 * `Roll image + validate live URL` job `success`. Replaying the gate's exact
 * query (`/actions/workflows/loom-roll-and-validate.yml/runs?status=completed
 * &per_page=30`, then the same jq `select(.completedAt > $since)`) returns that
 * run as the single candidate, which drives decideEstateRegression() straight
 * to `regression`. So the DECISION logic was right and the POPULATION was
 * empty. Why the Actions API omitted a run that had completed 3m50s earlier is
 * NOT established here and is deliberately not asserted.
 *
 * What IS established is the design defect: the gate asked a third-party,
 * eventually-consistent index a question about OUR estate, and the estate held
 * the answer the whole time, timestamped, one `az containerapp revision list`
 * away. This function is that read. It needs no token, no Actions API, and no
 * consistency window — a revision exists the moment ARM creates it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Take every revision created at or after the moment this deploy MEASURED the
 * tags it was going to write (the same `measured_at` the re-pin step records),
 * oldest first. Establish which revision is SERVING from the traffic weights
 * (selectServingRevision — NOT from recency, #3798). Then:
 *
 *   the LIVE revision's tag != the tag we applied
 *       -> the image the estate serves is not the one this apply wrote.
 *          Whatever else happened, this apply did not leave the estate behind.
 *          'ahead'.
 *   the LIVE revision's tag == the tag we applied, and a revision carrying a
 *   DIFFERENT tag sits EARLIER in the window than our own revision
 *       -> another writer put that tag on the estate and we wrote after it.
 *          'overwritten' — this is the incident, and the roll-forward target is
 *          read off the estate, not inferred.
 *   the LIVE revision's tag == the tag we applied, and the competing revision
 *   is LATER than ours (or we wrote nothing in this window at all)
 *       -> something wrote after this apply and is not taking traffic. This
 *          apply displaced NOTHING, so 'overwritten' would be an attribution
 *          the history contradicts. 'drifted' — exit 1, no direction claimed,
 *          NO roll-forward target, and therefore no auto-dispatch. The
 *          realistic producer is a blue-green green revision deployed at weight
 *          0 and still being health-gated (console-bluegreen-roll.yml), which
 *          promoting would race.
 *   otherwise
 *       -> 'none'. Nothing in this window contradicts what we applied.
 *
 * UNKNOWN IS NOT 'none'. An unreadable list, an unparseable createdTime, a
 * revision in the window whose image carries no comparable tag (a digest pin),
 * a payload carrying no traffic weights at all, a traffic split across two
 * different images, and "every weight is 0" all resolve to 'unknown', which the
 * caller fails closed on. Spending "I could not look" as "nothing happened" is
 * the collapse that produced this issue's green run and the one
 * deploy-integrity R7 forbids.
 *
 * WINDOW BOUND IS INCLUSIVE (`>=`). `measured_at` has second resolution and is
 * recorded BEFORE the read it timestamps, so a revision created in that same
 * second is genuinely ambiguous. Over-inclusion costs one extra comparison;
 * under-inclusion hides the incident.
 *
 * @param {Array<{name?:string, createdTime?:string, image?:string,
 *                trafficWeight?:(number|string|null)}>|null} revisions
 *        `az containerapp revision list` projection. null/undefined = the query
 *        FAILED, which is deliberately NOT an empty history. `trafficWeight` is
 *        what makes "live" mean SERVING rather than NEWEST; a payload without it
 *        is UNKNOWN, never a silent fall back to recency.
 * @param {{measuredAt?:string, appliedTag?:string}} opts
 * @returns {{status:'none'|'ahead'|'overwritten'|'drifted'|'unknown', reason:string,
 *            overwrittenTag?:string, liveTag?:string, liveRevision?:string,
 *            liveFrom?:'traffic',
 *            window?:Array<{name:string,createdTime:string,tag:string}>}}
 */
export function selectRevisionOverwrite(revisions, { measuredAt = '', appliedTag = '' } = {}) {
  const applied = String(appliedTag || '').trim();
  if (revisions === null || revisions === undefined) {
    return {
      status: 'unknown',
      reason:
        "the Container App's revision history could not be read, so it is UNKNOWN whether another writer moved " +
        "the estate inside this apply's window and this apply put it back. \"I could not look\" is not \"nothing happened\".",
    };
  }
  if (!Array.isArray(revisions)) {
    return {
      status: 'unknown',
      reason:
        'the revision history did not arrive as a JSON array, so the az projection has changed shape and no ' +
        'window can be built from it. Refusing to read a pass out of an unrecognised payload.',
    };
  }
  const since = Date.parse(String(measuredAt || ''));
  if (!Number.isFinite(since)) {
    return {
      status: 'unknown',
      reason:
        `the moment this deploy measured the tags it would apply is not established (measured-at ` +
        `${JSON.stringify(String(measuredAt || ''))}), so the window in which a competing write could have landed ` +
        'cannot be bounded, and an unbounded window proves nothing either way.',
    };
  }

  const inWindow = [];
  for (const r of revisions) {
    const created = Date.parse(String(r?.createdTime ?? ''));
    if (!Number.isFinite(created)) {
      return {
        status: 'unknown',
        reason:
          `revision ${JSON.stringify(String(r?.name ?? ''))} carries no readable createdTime ` +
          `(${JSON.stringify(String(r?.createdTime ?? ''))}), so it cannot be placed inside or outside this ` +
          "apply's window. An unplaceable revision is UNKNOWN, never \"outside\".",
      };
    }
    if (created >= since) inWindow.push({ raw: r, createdMs: created });
  }

  if (!inWindow.length) {
    return {
      status: 'none',
      reason:
        `no loom-console revision was created at or after ${measuredAt}, so nothing wrote this field during the ` +
        'apply — neither this deploy nor anyone else — and there is nothing that could have been overwritten.',
    };
  }

  inWindow.sort((a, b) => a.createdMs - b.createdMs || String(a.raw?.name ?? '').localeCompare(String(b.raw?.name ?? '')));

  /** @type {Array<{name:string, createdTime:string, tag:string}>} */
  const tagged = [];
  for (const { raw } of inWindow) {
    const image = String(raw?.image ?? '');
    const ref = parseImageRef(image);
    const tag = ref && ref.tag ? ref.tag : null;
    if (!tag) {
      return {
        status: 'unknown',
        reason:
          `revision ${JSON.stringify(String(raw?.name ?? ''))} was created at ${String(raw?.createdTime ?? '')} — ` +
          `inside this apply's window — running ${JSON.stringify(image)}, which carries no tag this gate can ` +
          `compare ${ref && ref.digest ? '(it is digest-pinned, and a digest does not name a commit)' : '(unparseable)'}. ` +
          'Whether it was a NEWER image this apply overwrote is therefore UNKNOWN.',
      };
    }
    tagged.push({ name: String(raw?.name ?? ''), createdTime: String(raw?.createdTime ?? ''), tag });
  }

  const render = (rs) => rs.map((r) => `${r.name}@${r.createdTime}=${r.tag}`).join(', ');

  // ── WHAT IS THE ESTATE SERVING? (#3798) ───────────────────────────────────
  // The live image is the revision TAKING TRAFFIC. A payload that carries no
  // traffic data at all cannot answer that, and this gate does not answer it
  // from recency instead: the one production caller projects `trafficWeight`
  // (contract-tested), so an unweighted payload means the projection changed
  // under us, which is UNKNOWN and fails closed.
  const servingSel = selectServingRevision(revisions);
  if (servingSel.status !== 'found') {
    return {
      status: 'unknown',
      window: tagged,
      reason:
        `${servingSel.reason} Which image the estate SERVES is therefore unestablished, and it is NOT read off ` +
        `recency instead — "the newest revision" is the live one only while the app's traffic split is ` +
        '`latestRevision: true`, which this payload did not show (#3798). ' +
        `Window: ${render(tagged)}.`,
    };
  }
  const live = { tag: servingSel.tag, name: servingSel.name, how: servingSel.reason };

  if (!applied || live.tag !== applied) {
    return {
      status: 'ahead',
      window: tagged,
      liveTag: live.tag,
      liveRevision: live.name,
      liveFrom: 'traffic',
      reason:
        `the live loom-console image is loom-console:${live.tag} (${live.how}), which is not the tag this deploy ` +
        `applied${applied ? ` ('${applied}')` : ' (this deploy applied none)'} — so the image the estate is serving ` +
        `is not the one this apply wrote, and this apply did not leave the estate behind. Window: ${render(tagged)}.`,
    };
  }

  // ── THE ESTATE IS SERVING OUR TAG. WHO WROTE LAST? ────────────────────────
  //
  // `overwritten` is an ATTRIBUTION — "this run replaced that image" — and it
  // is only a fact when OUR write came AFTER the other one. The first draft of
  // the #3798 fix dropped that precondition (it took the newest non-applied
  // revision in the window unconditionally), which made the gate accuse this
  // apply of overwriting a revision that landed AFTER it, and then auto-
  // dispatch a roll on that accusation.
  //
  // That is not hypothetical. console-bluegreen-roll.yml deploys its green
  // revision at WEIGHT 0 and health-gates it for minutes before shifting
  // traffic. Estate during that window: blue serving 100% on the tag this
  // deploy applied, and a NEWER green revision at weight 0 carrying the
  // candidate. The dropped precondition turns that into `regression` +
  // `rollForwardTo=<green>`, and the auto-heal step then promotes an image
  // another lane is still validating — racing its traffic shift and its
  // rollback path. The gate would cause the class of defect it exists to catch.
  //
  // So: `overwritten` requires our revision to be LATER in the window than the
  // competing one. When it is not, this is `drifted` — still exit 1, still
  // loud, but no direction asserted, no roll-forward target, and therefore no
  // auto-dispatch. Same reasoning decideEstateRegression already applies to an
  // unattributable estate tag (deploy-integrity R7).
  const oursIdx = tagged.map((r) => r.tag).lastIndexOf(applied);
  const otherIdx = tagged.map((r) => r.tag !== applied).lastIndexOf(true);
  if (otherIdx === -1) {
    return {
      status: 'none',
      window: tagged,
      liveTag: live.tag,
      liveRevision: live.name,
      liveFrom: 'traffic',
      reason:
        `every loom-console revision created since ${measuredAt} runs the tag this deploy applied ` +
        `('${applied}'), and that is also the live image (${live.how}), so no other writer's image was ` +
        `overwritten. Window: ${render(tagged)}.`,
    };
  }
  const other = tagged[otherIdx];
  if (oursIdx === -1 || otherIdx > oursIdx) {
    return {
      status: 'drifted',
      window: tagged,
      liveTag: live.tag,
      liveRevision: live.name,
      liveFrom: 'traffic',
      reason:
        `THE ESTATE IS SERVING THE TAG THIS DEPLOY APPLIED ('${applied}', ${live.how}) WHILE A DIFFERENT IMAGE SITS ` +
        `IN THIS WINDOW UNSERVED: revision ${other.name} was created at ${other.createdTime} running ` +
        `loom-console:${other.tag}` +
        (oursIdx === -1
          ? ', and NO revision carrying this deploy\'s tag was created in this window at all — so this apply did ' +
            'not write the live image and cannot have displaced anything.'
          : ` — AFTER this deploy's own revision ${tagged[oursIdx].name} (${tagged[oursIdx].createdTime}). This ` +
            'apply therefore did not overwrite it; something wrote afterwards and is not taking traffic.') +
        ' NO DIRECTION IS BEING CLAIMED and no roll-forward target is named: a revision deployed at weight 0 and ' +
        'still being health-gated (console-bluegreen-roll.yml does exactly this) looks identical from here, and ' +
        'promoting it would race the lane that owns it. Read the container app and the in-flight runs before ' +
        `acting. Window: ${render(tagged)}.`,
    };
  }

  return {
    status: 'overwritten',
    overwrittenTag: other.tag,
    window: tagged,
    liveTag: live.tag,
    liveRevision: live.name,
    liveFrom: 'traffic',
    reason:
      `revision ${other.name} was created at ${other.createdTime} running loom-console:${other.tag} — after this ` +
      `deploy measured the tags it would write (${measuredAt}) — and this deploy's own revision ` +
      `${tagged[oursIdx].name} then followed it at ${tagged[oursIdx].createdTime}; the estate is SERVING ` +
      `'${live.tag}', the tag THIS DEPLOY applied (${live.how}). Window: ${render(tagged)}.`,
  };
}

/**
 * How to state what the estate is running when the two reads can DISAGREE.
 *
 * `az containerapp show` returns the app TEMPLATE's image — the last thing
 * written to the field — while the traffic split says what is actually being
 * SERVED. Under the weight-0 roll of #3798 those are two different images, and
 * a message naming only the template would assert the wrong one as "what the
 * estate is running" (deploy-integrity R7). When they agree, this reads exactly
 * as it did before.
 *
 * @param {string|null} estateTag        from `az containerapp show`
 * @param {ReturnType<typeof selectRevisionOverwrite>|null} revisionSelection
 */
function describeLive(estateTag, revisionSelection) {
  const template = String(estateTag ?? '').trim();
  const live = String(revisionSelection?.liveTag ?? '').trim();
  if (!live || live === template) return `loom-console is now running '${template}'.`;
  return (
    `loom-console is SERVING '${live}' (revision ${revisionSelection?.liveRevision || 'unnamed'}), while the ` +
    `container app's template names '${template}'. The template is the last WRITE; the traffic split is what the ` +
    'estate actually serves, and on this run they disagree.'
  );
}

/**
 * Did this deploy leave the estate BEHIND the last thing that rolled it?
 *
 * THREE FAILING VERDICTS, NOT ONE, AND THE DIFFERENCE IS THE REMEDIATION.
 * An earlier draft returned `regression` — headline "THE ESTATE WENT
 * BACKWARDS" — for a state whose own explanatory text said "something else
 * moved it", and printed a remediation naming the last COMPLETED roll's SHA.
 * The realistic producer of that state is a roll whose `az containerapp update`
 * landed AFTER the apply but whose RUN has not finished yet, so it is not in
 * the population at all (on the incident night that gap was 4m45s). In that
 * case the estate is AHEAD, and rolling to the named SHA would move it
 * BACKWARDS — the gate causing the very defect it exists to catch.
 *
 * So: `regression` is claimed ONLY when this deploy's own applied tag is what
 * is live, which is the one case attribution is certain. Anything else that
 * fails to match is `drifted` — still exit 1, still loud, but it asserts no
 * direction and names no rollback target.
 *
 * @param {object} a
 * @param {string} a.appliedTag   the console tag this deploy applied ('' = none)
 * @param {string|null} a.estateTag the console tag running NOW (null = unreadable)
 * @param {string} [a.estateReadError]
 * @param {ReturnType<typeof selectLastConsoleRoll>} a.rollSelection
 * @param {ReturnType<typeof selectRevisionOverwrite>} [a.revisionSelection]
 *        The ESTATE's own account of the window, which does not depend on the
 *        Actions API. Consulted BEFORE rollSelection because it is the source
 *        that was available and unconsulted on the run this gate missed, and
 *        because its remediation SHA is read off the estate rather than
 *        inferred from a run title. It is STRICTLY ADDITIVE: it can turn an
 *        'ok' into a 'regression' or an 'unknown', and can never turn a failing
 *        Actions-API verdict green.
 * @returns {{verdict:'ok'|'regression'|'drifted'|'unknown', reason:string}}
 */
export function decideEstateRegression({ appliedTag = '', estateTag = null, estateReadError = '', rollSelection = null, revisionSelection = null } = {}) {
  const applied = String(appliedTag || '').trim();
  if (!applied) {
    return {
      verdict: 'ok',
      reason:
        'this run applied no loom-console image tag (app-deployments.bicep did not render the Container Apps), ' +
        'so it cannot have moved the estate backwards.',
    };
  }
  if (estateTag === null || estateTag === undefined || !String(estateTag).trim()) {
    return {
      verdict: 'unknown',
      reason:
        'the image loom-console is running could not be read after the apply, so it is NOT established that this ' +
        'deploy left the estate where the last roll put it. It is equally not established that it did not' +
        (estateReadError ? `. Detail: ${String(estateReadError).slice(0, 400)}` : '.'),
    };
  }
  // ── THE ESTATE'S OWN ACCOUNT FIRST (#3676, 2026-08-19) ────────────────────
  // This is consulted BEFORE the Actions API because on the run that produced
  // this issue's reopening the Actions API listing was empty and the revision
  // history was not. It can only ADD a failure: `ahead` and `none` fall through
  // to the comparison below unchanged, so no Actions-API red can be turned
  // green here.
  if (revisionSelection && revisionSelection.status === 'overwritten') {
    return {
      verdict: 'regression',
      reason:
        'THE ESTATE WENT BACKWARDS, AND ITS OWN REVISION HISTORY RECORDS IT. ' +
        `${revisionSelection.reason} ${describeLive(estateTag, revisionSelection)} This run overwrote that image. ` +
        'Every merge in that window is inert on the live estate until it is rolled again (deploy-integrity R2/R3).',
      rollForwardTo: revisionSelection.overwrittenTag,
    };
  }
  // A competing revision that landed AFTER ours is NOT something this apply
  // overwrote, and the estate's own timestamps say so. It fails the run — an
  // unserved image in our window is a state a human must look at — but it
  // names no roll-forward target, which is what keeps the auto-heal step from
  // promoting an image another lane is still health-gating (#3798 review).
  // This takes precedence over the Actions-API comparison below deliberately:
  // that comparison would report `regression` with a rollForwardTo on the same
  // state, and it is reasoning from a run listing while this is reasoning from
  // the estate's own ordered history. It cannot launder anything green — both
  // verdicts exit 1.
  if (revisionSelection && revisionSelection.status === 'drifted') {
    return {
      verdict: 'drifted',
      reason: `${revisionSelection.reason} ${describeLive(estateTag, revisionSelection)}`,
    };
  }
  if (revisionSelection && revisionSelection.status === 'unknown') {
    // ── #3797 — AN UNREADABLE SECOND SOURCE MUST NOT DISCARD A DEFINITE FIRST
    // ONE. This used to return UNKNOWN here unconditionally, which threw away
    // an Actions-API `regression` that had already been established — and with
    // it the roll-forward SHA the operator needs. Both paths exit 1, so nothing
    // unsafe shipped; what was lost was the next action, on the one run where
    // it was knowable from a source that HAD answered.
    //
    // Re-entering with the revision evidence removed is deliberate: it reuses
    // the Actions-API comparison below rather than restating it, and ONLY its
    // `regression` is taken. An 'ok' or a 'drifted' from that path is discarded
    // and stays UNKNOWN here, so an unreadable estate can never be laundered
    // green by a quiet Actions API.
    const actionsOnly = decideEstateRegression({
      appliedTag,
      estateTag,
      estateReadError,
      rollSelection,
      revisionSelection: null,
    });
    if (actionsOnly.verdict === 'regression') {
      return {
        ...actionsOnly,
        reason:
          `${actionsOnly.reason} The estate's own revision history — the independent second source, and the one ` +
          `that caught the 2026-08-19 miss — could NOT be used on this run: ${revisionSelection.reason} The ` +
          'regression above does not rest on it; it is established by the Actions API and by the tag the estate ' +
          'is running.',
      };
    }
    return {
      verdict: 'unknown',
      reason: `estate is running loom-console:${estateTag}, but ${revisionSelection.reason}`,
    };
  }

  if (!rollSelection || rollSelection.status === 'unknown') {
    return {
      verdict: 'unknown',
      reason: `estate is running loom-console:${estateTag}, but ${rollSelection ? rollSelection.reason : 'no roll selection was supplied'}`,
    };
  }
  if (rollSelection.status === 'none') {
    return {
      verdict: 'ok',
      reason:
        `estate is running loom-console:${estateTag}; ${rollSelection.reason}` +
        `${revisionSelection ? ` And the estate's own revision history agrees: ${revisionSelection.reason}` : ''}`,
    };
  }
  const { sha, workflow, id, completedAt } = rollSelection.roll;
  if (String(estateTag).trim() === sha) {
    return {
      verdict: 'ok',
      reason:
        `estate is running loom-console:${sha}, which is exactly what ${workflow} run ${id} shipped at ` +
        `${completedAt}. This deploy did not overwrite it.`,
    };
  }
  if (String(estateTag).trim() === applied) {
    return {
      verdict: 'regression',
      reason:
        `THE ESTATE WENT BACKWARDS. ${workflow} run ${id} shipped loom-console:${sha} at ${completedAt} — after this ` +
        `deploy measured the tags it was going to write — and loom-console is now running '${estateTag}', which is ` +
        'the tag THIS DEPLOY applied. This run overwrote that roll. Every merge in that window is inert on the ' +
        'live estate until it is rolled again (deploy-integrity R2/R3).',
      rollForwardTo: sha,
    };
  }
  return {
    verdict: 'drifted',
    reason:
      `THE ESTATE IS ON AN IMAGE NOBODY IN THIS COMPARISON PUT THERE. loom-console is running '${estateTag}', which ` +
      `is neither the last shipped roll (${workflow} run ${id} shipped loom-console:${sha} at ${completedAt}) nor ` +
      `the tag this deploy applied ('${applied}'). The most likely benign explanation is a roll whose image write ` +
      'has landed but whose RUN has not completed, so it is not yet in the population — in which case the estate is ' +
      'AHEAD, not behind. NO DIRECTION IS BEING CLAIMED and no rollback target is named, because rolling to the SHA ' +
      'above could move a healthy estate backwards. Read the container app and the in-flight runs before acting.',
  };
}

// ===========================================================================
// CLI — file-fed, so every verdict above stays unit-testable
// ===========================================================================
//
// The workflow owns the `az` / `gh` calls and their exit codes (it already
// captures rc explicitly rather than swallowing stderr, per #3090 / R7) and
// hands the RESULT in here. This file never shells out, so a test can drive
// exactly the states production hits — including the unreadable ones, which are
// the states a live run cannot cheaply reproduce.
//
//   node scripts/ci/reconcile-policy.mjs pin-refresh
//        --deploy-apps-enabled true|false
//        (--containers <file> | --read-error <text>)
//   node scripts/ci/reconcile-policy.mjs assert-estate-not-behind-roll
//        --applied-tag <tag>
//        --measured-at <rfc3339>
//        (--estate-image <ref> | --read-error <text>)
//        (--rolls <file>       | --rolls-error <text>)
//        (--revisions <file>   | --revisions-error <text>)
//        [--heal-request <file>]   where the roll-forward SHA is written when —
//                                  and ONLY when — the verdict is a definite
//                                  `regression` carrying a 40-hex SHA (#3799).
//                                  The auto-heal step reads THIS FILE rather
//                                  than a step output, so the hand-off does not
//                                  depend on how the runner treats the outputs
//                                  of a step that (by design) exits non-zero.
//   node scripts/ci/reconcile-policy.mjs serving-tag
//        --revisions <file> --out <file>
//        Writes the tag the estate is SERVING (traffic-derived, #3798) to
//        <file> and exits 0; exits 1 having written an empty file when the
//        serving image is not established. Used by the auto-heal step to VERIFY
//        recovery with the same logic the gate used to detect the regression,
//        rather than a second jq re-implementation of it.
//
// Exit 0 = proceed / ok, 1 = refuse / regression / unknown, 2 = usage error.

/** `--name value`, or '' when absent. Last occurrence wins. */
function cliArg(argv, name) {
  const i = argv.lastIndexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? String(argv[i + 1]) : '';
}

function cliHas(argv, name) {
  return argv.includes(`--${name}`);
}

/**
 * @param {string[]} argv        process.argv.slice(2)
 * @param {object} io            injected so the tests drive the real entrypoint
 * @param {(p:string)=>string} io.readFile
 * @param {(p:string, body:string)=>void} [io.writeFile]
 * @param {(line:string)=>void} io.writeEnv
 * @param {(line:string)=>void} io.writeOutput
 * @param {(s:string)=>void} io.log
 * @param {Record<string,string|undefined>} io.env
 * @returns {number} process exit code
 */
export function cliMain(argv, io) {
  const { readFile, writeEnv, writeOutput, log, env } = io;
  const writeFile = io.writeFile || (() => {});
  const cmd = argv[0] || '';

  const readJson = (file) => {
    const raw = readFile(file);
    const v = JSON.parse(raw);
    return v;
  };

  if (cmd === 'pin-refresh') {
    const deployAppsEnabled = cliArg(argv, 'deploy-apps-enabled');
    const containersFile = cliArg(argv, 'containers');
    const readError = cliArg(argv, 'read-error');
    if (!containersFile && !cliHas(argv, 'read-error')) {
      log('::error::reconcile-policy pin-refresh: exactly one of --containers <file> or --read-error <text> is required. Neither was supplied, and defaulting either way would invent a fact about the estate.');
      return 2;
    }
    let resolution = null;
    if (containersFile) {
      let containers;
      try {
        containers = readJson(containersFile);
      } catch (e) {
        log(`::error::reconcile-policy pin-refresh: --containers ${containersFile} could not be read or parsed (${String(e?.message || e).slice(0, 200)}). That is an UNREADABLE estate, not an empty one.`);
        return 1;
      }
      if (!Array.isArray(containers)) {
        log(`::error::reconcile-policy pin-refresh: --containers ${containersFile} did not contain a JSON array, so the az projection has changed shape. Refusing to read a pass out of it.`);
        return 1;
      }
      resolution = resolveRunningImageTags(containers);
    }

    const previous = pinsFromEnv(env);
    const verdict = decidePinRefresh({
      deployAppsEnabled,
      previous,
      resolution,
      readError,
    });

    for (const m of verdict.comparison.moved) {
      log(`::warning::[pin-refresh] MOVED ${m.repo}: pinned ${m.was}, now running ${m.now} — re-pinning to the running tag (#3676).`);
    }
    for (const m of verdict.comparison.appeared) {
      log(`::warning::[pin-refresh] APPEARED ${m.repo}: not pinned by this run, now running ${m.now} — pinning it so the param-file default is not written over it.`);
    }
    for (const m of verdict.comparison.vanished) {
      log(`::notice::[pin-refresh] GONE ${m.repo}: was running ${m.was}, no longer deployed. The apply will CREATE it at that tag; that is not a revert.`);
    }

    if (verdict.decision === 'refuse') {
      log(`::error::PIN REFRESH REFUSED — ${verdict.reason}`);
      return 1;
    }

    for (const line of tagEnvLines(verdict.repin)) writeEnv(line);
    const consoleTag = verdict.repin[CONSOLE_IMAGE_KEY] || '';
    writeOutput(`console_tag=${consoleTag}`);
    writeOutput(`drift_count=${verdict.comparison.moved.length + verdict.comparison.appeared.length}`);
    log(`[pin-refresh] ${verdict.reason}`);
    if (verdict.comparison.moved.length || verdict.comparison.appeared.length) {
      log(`::notice::PIN REFRESH — ${verdict.reason}`);
    }
    return 0;
  }

  if (cmd === 'assert-estate-not-behind-roll') {
    const appliedTag = cliArg(argv, 'applied-tag');
    const estateImage = cliArg(argv, 'estate-image');
    const estateReadError = cliArg(argv, 'read-error');
    const rollsFile = cliArg(argv, 'rolls');
    const rollsError = cliArg(argv, 'rolls-error');
    const revisionsFile = cliArg(argv, 'revisions');
    const revisionsError = cliArg(argv, 'revisions-error');
    const measuredAt = cliArg(argv, 'measured-at');
    if (!estateImage && !cliHas(argv, 'read-error')) {
      log('::error::reconcile-policy assert-estate-not-behind-roll: exactly one of --estate-image <ref> or --read-error <text> is required.');
      return 2;
    }
    if (!rollsFile && !cliHas(argv, 'rolls-error')) {
      log('::error::reconcile-policy assert-estate-not-behind-roll: exactly one of --rolls <file> or --rolls-error <text> is required.');
      return 2;
    }
    // The revision history is the source that was available and unread on the
    // 2026-08-19 miss. A caller that supplies NEITHER flag is not "a caller
    // without revision evidence" — it is a caller that would silently fall back
    // to the exact Actions-API-only comparison that went green on a revert. So
    // it is a usage error, loudly, rather than a default.
    if (!revisionsFile && !cliHas(argv, 'revisions-error')) {
      log('::error::reconcile-policy assert-estate-not-behind-roll: exactly one of --revisions <file> or --revisions-error <text> is required. Neither was supplied, and defaulting to "no revision evidence" would restore the Actions-API-only comparison that reported OK across the #3676 revert.');
      return 2;
    }

    let estateTag = null;
    if (estateImage) {
      const ref = parseImageRef(estateImage);
      estateTag = ref && ref.tag ? ref.tag : null;
      if (!estateTag) {
        return finishRegression(log, writeOutput, writeFile, cliArg(argv, 'heal-request'), {
          verdict: 'unknown',
          reason:
            `loom-console's image reference '${estateImage}' carries no tag this gate can compare ` +
            `${ref && ref.digest ? '(it is digest-pinned, and a digest does not name a commit)' : '(unparseable)'} — ` +
            'so whether the estate is behind the last roll is UNKNOWN.',
        });
      }
    }

    let rollSelection;
    if (!rollsFile) {
      rollSelection = selectLastConsoleRoll(null);
      if (rollsError) rollSelection = { ...rollSelection, reason: `${rollSelection.reason} Detail: ${rollsError.slice(0, 400)}` };
    } else {
      let runs;
      try {
        runs = readJson(rollsFile);
      } catch (e) {
        rollSelection = selectLastConsoleRoll(null);
        rollSelection = { ...rollSelection, reason: `${rollSelection.reason} Detail: --rolls ${rollsFile} could not be parsed (${String(e?.message || e).slice(0, 200)}).` };
        runs = undefined;
      }
      if (Array.isArray(runs)) rollSelection = selectLastConsoleRoll(runs);
      else if (runs !== undefined) rollSelection = selectLastConsoleRoll(null);
    }

    let revisionSelection;
    if (!revisionsFile) {
      revisionSelection = selectRevisionOverwrite(null, { measuredAt, appliedTag });
      if (revisionsError) {
        revisionSelection = { ...revisionSelection, reason: `${revisionSelection.reason} Detail: ${revisionsError.slice(0, 400)}` };
      }
    } else {
      let revs;
      let parseDetail = '';
      try {
        revs = readJson(revisionsFile);
      } catch (e) {
        parseDetail = ` Detail: --revisions ${revisionsFile} could not be parsed (${String(e?.message || e).slice(0, 200)}).`;
        revs = null;
      }
      revisionSelection = selectRevisionOverwrite(revs, { measuredAt, appliedTag });
      if (parseDetail) revisionSelection = { ...revisionSelection, reason: `${revisionSelection.reason}${parseDetail}` };
    }

    return finishRegression(log, writeOutput, writeFile, cliArg(argv, 'heal-request'), decideEstateRegression({
      appliedTag,
      estateTag,
      estateReadError,
      rollSelection,
      revisionSelection,
    }));
  }

  if (cmd === 'serving-tag') {
    const revisionsFile = cliArg(argv, 'revisions');
    const outFile = cliArg(argv, 'out');
    if (!revisionsFile || !outFile) {
      log('::error::reconcile-policy serving-tag: both --revisions <file> and --out <file> are required.');
      return 2;
    }
    let revs = null;
    let parseDetail = '';
    try {
      revs = readJson(revisionsFile);
    } catch (e) {
      parseDetail = ` --revisions ${revisionsFile} could not be read or parsed (${String(e?.message || e).slice(0, 200)}).`;
      revs = null;
    }
    const sel = selectServingRevision(revs);
    if (sel.status !== 'found') {
      // The file is ALWAYS written, and written EMPTY here, so a caller that
      // reads it without checking the exit code gets nothing rather than a
      // stale value from a previous poll.
      writeFile(outFile, '');
      log(`::warning::serving-tag: the image the estate is SERVING is NOT established — ${sel.reason}${parseDetail}`);
      return 1;
    }
    writeFile(outFile, `${sel.tag}\n`);
    log(`[serving-tag] ${sel.reason}`);
    return 0;
  }

  log(`::error::reconcile-policy: unknown subcommand ${JSON.stringify(cmd)}. Expected 'pin-refresh', 'assert-estate-not-behind-roll' or 'serving-tag'.`);
  return 2;
}

/**
 * Print the verdict, publish it, and — on a definite regression — leave the
 * roll-forward SHA where the auto-heal step can find it (#3799).
 *
 * THE HEAL REQUEST IS A FILE, NOT ONLY A STEP OUTPUT. This step exits 1 on the
 * verdict that produces the request, and "are the outputs of a failed step
 * readable by a later step" is a property of the runner rather than of this
 * repo. A file in $RUNNER_TEMP is written by the time the process exits, full
 * stop, and the extracted-step tests can read exactly what CI would.
 *
 * IT IS WRITTEN ONLY FOR A 40-HEX SHA. `drifted` names no target by design,
 * `unknown` establishes nothing, and a floating tag ('latest', a prefix) would
 * dispatch a roll at something that is not a commit. Each of those leaves the
 * request EMPTY, and the heal step dispatches nothing when it is empty.
 */
function finishRegression(log, writeOutput, writeFile, healRequestFile, verdict) {
  // `verdict` / `roll_forward_to` are published for the RUN LOG and for a human
  // reading `steps.estate_behind.outputs.*` — they are deliberately NOT the
  // hand-off. Nothing consumes them, and that is stated here rather than left
  // to be discovered: the auto-heal step reads the request FILE, because
  // whether a step that exits non-zero still publishes its outputs is a
  // property of the runner rather than of this repo, and the one channel that
  // matters must not depend on it.
  const publish = (name, value) => {
    if (typeof writeOutput === 'function') writeOutput(`${name}=${value}`);
  };
  publish('verdict', verdict.verdict);

  if (verdict.verdict === 'ok') {
    log(`::notice::estate-vs-roll: OK — ${verdict.reason}`);
    return 0;
  }
  if (verdict.verdict === 'regression') {
    const sha = String(verdict.rollForwardTo || '').trim();
    const dispatchable = SHA_TAG_RE.test(sha);
    // The remediation is printed ONLY here, because this is the only verdict in
    // which the SHA to roll to is established: the estate is running the tag
    // this deploy applied, so the roll's SHA is provably newer. See `drifted`.
    log(
      `::error::ESTATE REGRESSION (#3676) — ${verdict.reason} REMEDIATION: dispatch ` +
        `loom-roll-and-validate.yml with image_tag=${sha}, then confirm with ` +
        '`az containerapp show -n loom-console -g rg-csa-loom-admin-<region> --query ' +
        '"properties.template.containers[0].image"` — the container app, not /build-marker.txt.',
    );
    if (dispatchable) {
      publish('roll_forward_to', sha);
      if (healRequestFile) {
        writeFile(healRequestFile, `${sha}\n`);
        log(`::notice::estate-vs-roll: roll-forward target ${sha} written to ${healRequestFile} — the auto-heal step (#3799) dispatches it.`);
      }
    } else {
      log(
        `::warning::estate-vs-roll: the overwritten image is '${sha || '(none)'}', which is not a 40-hex commit SHA, ` +
          'so NO automatic roll-forward is requested. A roll dispatched at a tag that does not name a commit cannot ' +
          'be validated against a build marker (#2963). Roll it by hand after establishing what that tag is.',
      );
    }
    return 1;
  }
  if (verdict.verdict === 'drifted') {
    log(`::error::ESTATE DRIFT (#3676) — ${verdict.reason}`);
    return 1;
  }
  log(`::error::estate-vs-roll: UNKNOWN, which fails closed — ${verdict.reason}`);
  return 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/ci/reconcile-policy.mjs')) {
  const append = (file, line) => {
    if (!file) { console.log(`[dry] ${line}`); return; }
    appendFileSync(file, `${line}\n`);
  };
  process.exit(cliMain(process.argv.slice(2), {
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, body) => writeFileSync(p, body),
    writeEnv: (line) => append(process.env.GITHUB_ENV, line),
    writeOutput: (line) => append(process.env.GITHUB_OUTPUT, line),
    log: (s) => console.log(s),
    env: process.env,
  }));
}

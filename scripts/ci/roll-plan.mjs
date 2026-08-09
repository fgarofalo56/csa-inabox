#!/usr/bin/env node
/**
 * roll-plan.mjs — the data-plane roll registry, and the ATOMIC-GROUP rule that
 * makes rolling it safe.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Three production Container Apps had NO automated roll path in this repo:
 *
 *   loom-unity        the OSS Unity-Catalog-compatible metastore
 *   iceberg-catalog   the Iceberg REST catalog  (SAME IMAGE as loom-unity)
 *   loom-trino        the federated SQL engine
 *
 * Measured 2026-08-08, not assumed:
 *   * `full-app-deploy-commercial.yml` BUILDS loom-unity (matrix :434) and
 *     loom-trino (:441) and pushes both, and its roll job's
 *     `APPS=(loom-console loom-mcp loom-setup-orchestrator loom-activator
 *     loom-mirroring loom-direct-lake-shim)` contains NONE of the three. Both
 *     images are produced on every run and neither is ever shipped.
 *   * `loom-roll-and-validate.yml` is hard-bound to one app —
 *     `env.APP_NAME: loom-console` (:121) — with no app input.
 *   * On the live Commercial estate (rg-csa-loom-admin-centralus): loom-unity
 *     and iceberg-catalog both run `loom-unity:36b765e4`; loom-trino runs
 *     `loom-trino:v0.1`.
 *
 * deploy-integrity.md R1 makes a missing deploy path P0, and R3 calls a path
 * that has NEVER run the loudest case of drift rather than a silent pass.
 *
 * ── WHY A SEPARATE REGISTRY AND NOT `APPS=( … )` ───────────────────────────
 *
 * The existing roll loop builds its image reference as `$ACR/$app:$TAG` — it
 * hard-assumes CONTAINER APP NAME == IMAGE REPOSITORY NAME. That holds for all
 * six apps it rolls and is FALSE here: `iceberg-catalog` runs the `loom-unity`
 * repository (admin-plane/main.bicep:6190 passes
 * `image: '${…acrLoginServer}/loom-unity:${appImageTags.?unity ?? 'v0.1'}'`
 * into data-plane/iceberg-catalog-aca.bicep). Appending `iceberg-catalog` to
 * that array would ask ACR for an `iceberg-catalog` repository that no producer
 * has ever pushed. The mapping has to be EXPLICIT, so it lives here.
 *
 * ── THE ATOMIC-GROUP RULE (the part that is not obvious) ───────────────────
 *
 * Rolling loom-unity WITHOUT iceberg-catalog does not merely leave one app
 * behind — it disables the estate-wide configuration reconcile.
 *
 * scripts/ci/reconcile-policy.mjs `resolveRunningImageTags()` groups the live
 * Container Apps BY IMAGE REPOSITORY and refuses to pin a key when one
 * repository is running at two different tags:
 *
 *     `${hits.length} container(s) run ${entry.repo} at ${tags.length}
 *      different tags (…); one appImageTags key cannot preserve both`
 *
 * That is a correct refusal — there is exactly one `unity` key in
 * `appImageTags` and it cannot hold two values. But the consequence is that a
 * split pair makes the `unity` key UNKNOWN, and `decideDeployApps()` refuses to
 * upgrade `deployAppsEnabled` while anything is unknown. So a half-roll:
 *
 *   1. blocks the scheduled reconcile from applying ANY env/config change to
 *      the whole estate, not just to these two apps; and
 *   2. on an operator dispatch that forces `deploy_apps_enabled=true`, exports
 *      no `LOOM_UNITY_TAG` pin at all, so
 *      `readEnvironmentVariable('LOOM_UNITY_TAG','v0.1')` falls back and the
 *      next admin-plane deploy rewrites BOTH apps DOWN to `v0.1`.
 *
 * Hence: apps sharing an image repository are rolled together or not at all.
 * The groups are DERIVED from the repo field rather than declared, so a fourth
 * app on `loom-unity` joins the atomic group by construction — you cannot add
 * one and forget to update a second list. check-roll-atomicity.mjs then proves
 * the registry still matches what bicep actually deploys.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
 *
 * It does not make a hand-rolled tag DURABLE. `appImageTags.?unity ?? 'v0.1'`
 * in admin-plane/main.bicep reads the MUTABLE default, and only the Commercial
 * lane recovers the running tag (reconcile-resolve.mjs measures the estate and
 * exports LOOM_UNITY_TAG). The sovereign lanes read a REPO VARIABLE instead —
 * `deploy-fiab-gcch.yml:368` and `deploy-fiab-il5.yml:257` both use
 * `${{ vars.LOOM_UNITY_TAG || 'v0.1' }}` — so on Gov a rolled SHA survives only
 * if that variable is updated too. The CLI PRINTS that, per boundary, with the
 * exact variable name, rather than letting a roll look durable when it is not.
 *
 * Usage:
 *   node scripts/ci/roll-plan.mjs --list
 *   node scripts/ci/roll-plan.mjs --apps all --acr X.azurecr.io --tag T [--format json|tsv]
 *   node scripts/ci/roll-plan.mjs --verify --expected '<json>' --observed '<json>'
 *
 * Tests: node --test scripts/ci/__tests__/roll-plan.test.mjs
 */

/**
 * Every Container App this roll path ships, with its IMAGE REPOSITORY stated
 * explicitly because it is not always the app's own name.
 *
 * `tagKey` / `envVar` mirror scripts/ci/reconcile-policy.mjs APP_IMAGE_TAGS —
 * check-roll-atomicity.mjs asserts they agree, so a roll can never target an
 * image the reconcile has no key for (which would be a roll nothing can
 * preserve).
 *
 * @type {ReadonlyArray<{app:string, repo:string, tagKey:string, envVar:string, bicep:string, why:string}>}
 */
export const ROLL_TARGETS = Object.freeze([
  Object.freeze({
    app: 'loom-unity',
    repo: 'loom-unity',
    tagKey: 'unity',
    envVar: 'LOOM_UNITY_TAG',
    bicep: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
    why:
      'The OSS Unity-Catalog-compatible metastore. Databricks Unity Catalog has '
      + 'no Azure Government endpoint, so on a sovereign boundary this app IS the '
      + 'catalog (cloud-parity.md). admin-plane/main.bicep:6667 deploys it '
      + 'default-ON; nothing in this repo rolled it.',
  }),
  Object.freeze({
    app: 'iceberg-catalog',
    repo: 'loom-unity',
    tagKey: 'unity',
    envVar: 'LOOM_UNITY_TAG',
    bicep: 'platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep',
    why:
      'The Iceberg REST catalog, served by the SAME loom-unity image '
      + '(admin-plane/main.bicep:6190 passes the loom-unity reference in as '
      + '`image:`). App name != repository name, which is why an implicit '
      + '`$ACR/$app:$TAG` roll cannot ship it.',
  }),
  Object.freeze({
    app: 'loom-trino',
    repo: 'loom-trino',
    tagKey: 'trino',
    envVar: 'LOOM_TRINO_TAG',
    bicep: 'platform/fiab/bicep/modules/data-plane/loom-trino-aca.bicep',
    why:
      'The federated SQL engine over the Iceberg catalog. Built by '
      + 'full-app-deploy-commercial.yml (matrix :441) and never rolled; the live '
      + 'Commercial estate still ran `loom-trino:v0.1` on 2026-08-08.',
  }),
]);

/** Tag values that are mutable by convention — a roll onto one is not reproducible. */
export const MUTABLE_TAGS = Object.freeze(['latest', 'v0.1', 'main', 'dev']);

/**
 * Group targets by image repository. A repository with more than one app is an
 * ATOMIC group: every member rolls, or none does.
 *
 * DERIVED, never declared — adding a target with an existing `repo` extends the
 * group automatically. PURE.
 *
 * @param {ReadonlyArray<object>} [targets]
 * @returns {Map<string, object[]>} repo -> targets, insertion-ordered
 */
export function groupsByRepo(targets = ROLL_TARGETS) {
  /** @type {Map<string, object[]>} */
  const out = new Map();
  for (const t of targets) {
    if (!out.has(t.repo)) out.set(t.repo, []);
    out.get(t.repo).push(t);
  }
  return out;
}

/**
 * Expand a requested app selection to its atomic closure.
 *
 * FAILS CLOSED on an app this registry does not carry: silently dropping it
 * would let a dispatch that names a typo report success having rolled a subset.
 *
 * @param {ReadonlyArray<string>|string} requested app names, or 'all'
 * @param {ReadonlyArray<object>} [targets]
 * @returns {{apps:string[], added:string[], unknown:string[]}}
 *   `added` = apps pulled in ONLY because they share a repository with a
 *   requested app; the caller must announce them (a roll that quietly grows is
 *   as surprising as one that quietly shrinks).
 */
export function atomicClosure(requested, targets = ROLL_TARGETS) {
  const known = new Set(targets.map((t) => t.app));
  const list = Array.isArray(requested)
    ? requested.map((s) => String(s).trim()).filter(Boolean)
    : String(requested ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const wantAll = list.length === 0 || list.some((a) => a.toLowerCase() === 'all');
  const asked = wantAll ? targets.map((t) => t.app) : list;

  const unknown = wantAll ? [] : asked.filter((a) => !known.has(a));
  const groups = groupsByRepo(targets);

  const selected = new Set();
  for (const app of asked) {
    if (!known.has(app)) continue;
    const repo = targets.find((t) => t.app === app).repo;
    for (const mate of groups.get(repo)) selected.add(mate.app);
  }

  // Registry order, so the roll order is stable and reviewable.
  const apps = targets.map((t) => t.app).filter((a) => selected.has(a));
  const askedSet = new Set(asked);
  const added = apps.filter((a) => !askedSet.has(a));
  return { apps, added, unknown };
}

/**
 * Build a fully-qualified image reference.
 *
 * THROWS on an empty component rather than emitting `//:` or `X/repo:` — an
 * `az containerapp update --image` with a malformed reference is a failure this
 * should catch before it reaches Azure, and an empty tag would silently mean
 * `:latest` to some tooling.
 *
 * @param {{acr:string, repo:string, tag:string}} o
 * @returns {string}
 */
export function imageRef({ acr, repo, tag }) {
  const parts = { acr, repo, tag };
  for (const [k, v] of Object.entries(parts)) {
    if (!String(v ?? '').trim()) {
      throw new Error(
        `roll-plan: refusing to build an image reference with an empty ${k} `
        + `(acr=${JSON.stringify(acr)} repo=${JSON.stringify(repo)} tag=${JSON.stringify(tag)}).`,
      );
    }
  }
  return `${String(acr).trim()}/${String(repo).trim()}:${String(tag).trim()}`;
}

/**
 * The roll plan: which apps, in which order, at which image, grouped so a
 * caller can roll an atomic group as a unit.
 *
 * PURE — no fs, no az, no env. Every decision the workflow makes about WHAT to
 * roll is testable here rather than living in untestable inline YAML (#2819).
 *
 * @param {{apps?:string|string[], acr:string, tag:string, targets?:ReadonlyArray<object>}} o
 * @returns {{groups:Array<{repo:string, image:string, apps:string[], envVar:string, tagKey:string}>,
 *            rows:Array<{app:string, repo:string, image:string, envVar:string}>,
 *            added:string[], unknown:string[], mutableTag:boolean}}
 */
export function planRoll({ apps = 'all', acr, tag, targets = ROLL_TARGETS }) {
  const { apps: selected, added, unknown } = atomicClosure(apps, targets);
  if (unknown.length) {
    throw new Error(
      `roll-plan: unknown app(s) ${unknown.join(', ')}. This roll path carries `
      + `${targets.map((t) => t.app).join(', ')}. Refusing to roll a subset and `
      + 'report success — deploy-integrity.md R7.',
    );
  }
  if (!selected.length) {
    throw new Error('roll-plan: the selection resolved to ZERO apps. A roll that ships nothing must not exit 0.');
  }

  const chosen = targets.filter((t) => selected.includes(t.app));
  const groups = [];
  for (const [repo, members] of groupsByRepo(chosen)) {
    groups.push({
      repo,
      image: imageRef({ acr, repo, tag }),
      apps: members.map((m) => m.app),
      envVar: members[0].envVar,
      tagKey: members[0].tagKey,
    });
  }
  const rows = chosen.map((t) => ({
    app: t.app,
    repo: t.repo,
    image: imageRef({ acr, repo: t.repo, tag }),
    envVar: t.envVar,
  }));

  return {
    groups,
    rows,
    added,
    unknown,
    mutableTag: MUTABLE_TAGS.includes(String(tag).trim()),
  };
}

/**
 * Post-roll verdict: does what the estate is RUNNING match what this roll
 * resolved?
 *
 * Three outcomes kept APART, because collapsing them is the defect class this
 * repo keeps rediscovering (`UNKNOWN reported as a NEGATIVE`):
 *
 *   ok         the live image reference equals the requested one
 *   mismatch   the live reference is a DIFFERENT image — R7's "a roll must
 *              never report success having deployed a different SHA"
 *   unreadable the live reference could not be read at all; this is NOT a
 *              mismatch and must not be reported as one, but it is also NOT a
 *              pass — an unverified roll fails.
 *
 * @param {{expected:Record<string,string>, observed:Record<string,string>}} o
 *   `observed[app]` is the image string read off the live revision; an empty
 *   string / null / undefined means "could not read", never "no image".
 * @returns {{ok:boolean, rows:Array<{app:string, want:string, got:string|null, verdict:'ok'|'mismatch'|'unreadable'}>}}
 */
export function verifyLive({ expected, observed }) {
  const rows = [];
  for (const [app, want] of Object.entries(expected ?? {})) {
    const raw = observed ? observed[app] : undefined;
    const got = raw === undefined || raw === null || String(raw).trim() === ''
      ? null
      : String(raw).trim();
    const verdict = got === null ? 'unreadable' : got === String(want).trim() ? 'ok' : 'mismatch';
    rows.push({ app, want: String(want).trim(), got, verdict });
  }
  if (!rows.length) {
    // An empty expectation set means the caller verified NOTHING. Reporting ok
    // here is how a gate starts measuring nothing while staying green.
    return { ok: false, rows };
  }
  return { ok: rows.every((r) => r.verdict === 'ok'), rows };
}

/* ───────────────────────────── CLI ───────────────────────────── */

function arg(argv, name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return fallback;
  return v;
}

function main(argv) {
  if (argv.includes('--list')) {
    console.log('[roll-plan] data-plane roll registry:');
    for (const [repo, members] of groupsByRepo()) {
      const atomic = members.length > 1 ? '  ATOMIC GROUP' : '';
      console.log(`  repo ${repo}${atomic}`);
      for (const m of members) {
        console.log(`    ${m.app.padEnd(18)} appImageTags.${m.tagKey}  ${m.envVar}`);
        console.log(`      ${m.bicep}`);
      }
    }
    return 0;
  }

  if (argv.includes('--verify')) {
    let expected;
    let observed;
    try {
      expected = JSON.parse(arg(argv, '--expected', '{}'));
      observed = JSON.parse(arg(argv, '--observed', '{}'));
    } catch (e) {
      console.error(`[roll-plan] --verify needs valid JSON for --expected and --observed: ${e.message}`);
      return 2;
    }
    const { ok, rows } = verifyLive({ expected, observed });
    for (const r of rows) {
      const got = r.got === null ? '<could not read>' : r.got;
      console.log(`  ${r.verdict.padEnd(10)} ${r.app.padEnd(18)} want=${r.want} got=${got}`);
    }
    if (ok) {
      console.log('[roll-plan] OK — every rolled app is running the image this roll resolved.');
      return 0;
    }
    if (!rows.length) {
      console.error('[roll-plan] FAIL — nothing was verified. An empty expectation set is not a pass.');
      return 1;
    }
    for (const r of rows.filter((x) => x.verdict === 'mismatch')) {
      console.error(
        `::error::${r.app} is running '${r.got}' but this roll resolved '${r.want}'. `
        + 'A roll must never report success having deployed a different image than it was asked for '
        + '(deploy-integrity.md R7, #2963).',
      );
    }
    for (const r of rows.filter((x) => x.verdict === 'unreadable')) {
      console.error(
        `::error::Could not READ the image ${r.app} is running, so it is NOT established that it `
        + `is on '${r.want}'. This is not a claim that it is on something else — it is a refusal to `
        + 'report an unverified roll as a success (deploy-integrity.md R6).',
      );
    }
    return 1;
  }

  const acr = arg(argv, '--acr');
  const tag = arg(argv, '--tag');
  const apps = arg(argv, '--apps', 'all');
  const format = arg(argv, '--format', 'tsv');
  if (!acr || !tag) {
    console.error('[roll-plan] usage: --apps <all|a,b> --acr <loginServer> --tag <tag> [--format json|tsv]');
    console.error('            or --list, or --verify --expected <json> --observed <json>');
    return 2;
  }

  let plan;
  try {
    plan = planRoll({ apps, acr, tag });
  } catch (e) {
    console.error(`[roll-plan] ${e.message}`);
    return 1;
  }

  if (format === 'json') {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  // tsv: one row per app, consumed by the roll loop. Notices go to stderr so
  // stdout stays machine-parseable.
  if (plan.added.length) {
    console.error(
      `::notice::roll-plan pulled in ${plan.added.join(', ')} because they share an image `
      + 'repository with an app you asked for. Apps sharing a repository MUST roll together: '
      + 'scripts/ci/reconcile-policy.mjs cannot pin one appImageTags key to two different tags, '
      + 'so a split pair makes that key UNKNOWN and disables the estate-wide config reconcile.',
    );
  }
  if (plan.mutableTag) {
    console.error(
      `::warning::'${tag}' is a MUTABLE tag. The roll still creates a fresh revision (the workflow `
      + 'passes a unique --revision-suffix, which forces Container Apps to re-resolve the tag), but '
      + 'the post-roll image-string assertion cannot distinguish two different builds of the same '
      + 'tag. The digest re-check is what covers that.',
    );
  }
  for (const r of plan.rows) console.log(`${r.app}\t${r.repo}\t${r.image}\t${r.envVar}`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('roll-plan.mjs');
if (invokedDirectly) process.exit(main(process.argv.slice(2)));

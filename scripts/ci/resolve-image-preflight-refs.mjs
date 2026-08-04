#!/usr/bin/env node
/**
 * Resolve the EXACT `<repo>:<tag>` set a deployment will pull, so
 * scripts/ci/assert-acr-image-tags.sh can prove every one of them exists
 * BEFORE the deploy adopts a live estate.  (refs #2958)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `params/<boundary>.bicepparam` resolves every appImageTags key through
 * `readEnvironmentVariable('LOOM_<APP>_TAG', '<default>')`. In the deploy lanes
 * `scripts/ci/reconcile-resolve.mjs` runs first and exports LOOM_<APP>_TAG for
 * every app that is ACTUALLY RUNNING, so those keys pin to a tag that is
 * self-evidently present (something is running it). The keys with **no running
 * container** get no export and silently fall back to the paramfile default —
 * on the live Commercial estate 2026-08-04 that is five of seventeen:
 * orchestrator, maf, mapsTiles, duckdb, risingwave. Nothing has ever proven
 * those defaults exist in the registry.
 *
 * The Gov lanes already image-preflight, but only `loom-duckdb` — one
 * hard-coded ref that structurally cannot notice the other four. The Commercial
 * lane preflighted NOTHING. This closes both halves by deriving the set from
 * the two files that actually decide it, so it cannot drift:
 *
 *   1. scripts/ci/reconcile-policy.mjs  APP_IMAGE_TAGS  (key -> repo, envVar)
 *   2. the paramfile's readEnvironmentVariable defaults
 *
 * Add an app to APP_IMAGE_TAGS or change a default in the paramfile and the
 * preflight set follows automatically. That is the property a hard-coded list
 * cannot have, and the reason the duckdb-only guard missed four images.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not talk to Azure and it does not decide anything. It prints refs;
 * assert-acr-image-tags.sh does the proving and owns the three outcomes
 * (present / absent / unprovable). Keeping resolution offline means the whole
 * decision is unit-testable against fixtures — see
 * scripts/ci/__tests__/image-preflight-refs.test.mjs, which drives every branch
 * so this cannot become one more control that measures nothing.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   node scripts/ci/resolve-image-preflight-refs.mjs \
 *     --param-file platform/fiab/bicep/params/commercial.bicepparam \
 *     [--only-unpinned] [--json]
 *
 *   --only-unpinned  emit ONLY the keys with no LOOM_<APP>_TAG in the
 *                    environment — i.e. the ones falling back to a paramfile
 *                    default nobody has verified. Use for an ad-hoc probe.
 *                    Omit it in a deploy lane: preflighting a running tag too
 *                    is one cheap call and catches a registry purge.
 *   --json           emit {refs:[…], unpinned:[…], pinned:[…]} instead of lines.
 *
 * Exit 0 with one `<repo>:<tag>` per line on stdout. Diagnostics go to stderr
 * so `$(…)` capture stays clean.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_IMAGE_TAGS } from './reconcile-policy.mjs';

/**
 * Pull the fallback out of `readEnvironmentVariable('LOOM_X_TAG', 'v0.1')`.
 *
 * Quotes in bicepparam are always single, and the default is always a literal —
 * `check-reconcile-safety.mjs` (I4) already fails the build if one of these
 * slots carries a bare literal tag instead, so a paramfile that does not match
 * this shape is malformed, not an alternative spelling we should tolerate.
 *
 * Returns null when the paramfile does not mention the variable at all, which
 * is a real and correct case: commercial-full / il5 / tenant-dmlz declare a
 * SUBSET of the keys, and a key the template never pulls must not be asserted.
 *
 * @param {string} src   paramfile contents
 * @param {string} envVar
 * @returns {string|null}
 */
export function paramDefaultFor(src, envVar) {
  const re = new RegExp(
    `readEnvironmentVariable\\(\\s*'${envVar}'\\s*,\\s*'([^']*)'\\s*\\)`,
  );
  const m = String(src).match(re);
  return m ? m[1] : null;
}

/**
 * Keys whose image the template does NOT unconditionally pull.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A LOOPHOLE. A preflight that asserts a tag
 * the template will never pull is a FALSE failure, and a guard that cries wolf
 * gets switched off — which is strictly worse than no guard. But the same
 * mechanism, used loosely, is how a guard quietly stops measuring anything. So
 * the rule here is: an entry needs a grep that PROVES the exclusion, the reason
 * is recorded inline, every exclusion is PRINTED at run time, and anything not
 * listed is asserted. The default is "assert it".
 *
 * Verified on the tree at 2026-08-04:
 *
 *   orchestrator — DEAD KEY. `grep -rn 'appImageTags.orchestrator\|loom-orchestrator:'
 *     platform/fiab/bicep --include=*.bicep` returns ZERO. The key survives in
 *     APP_IMAGE_TAGS + every paramfile and is named in admin-plane/main.bicep's
 *     `appImageTags` @description, but NOTHING builds a container image
 *     reference from it, and `loom-orchestrator` is not one of the 30
 *     repositories in the live Commercial registry — nothing has ever built it.
 *     (`loom-setup-orchestrator` is a DIFFERENT key with its own repo, which
 *     does exist.) check-reconcile-safety.mjs only checks bicep -> table, so a
 *     table entry with no bicep reader is invisible to it; this is that entry.
 *
 *   mapsTiles — GOV ONLY. admin-plane/main.bicep:
 *     `var mapsTileServerEnabled = (boundary == 'GCC-High' || boundary == 'IL5')`
 *     gates the compute/loom-maps-app.bicep module that pulls
 *     `loom-maps-tileserver:${imageTag}`. On Commercial the module never
 *     deploys, so the (genuinely absent) `loom-maps-tileserver:v1` cannot break
 *     a Commercial deploy. It IS a live gap for GCC-High / IL5 — the repository
 *     does not exist in the Commercial registry and no workflow builds it —
 *     which is why the Gov boundaries still assert it.
 *
 * @type {Record<string, {deployedOn: (boundary: string) => boolean, why: string}>}
 */
export const DEPLOY_CONDITIONS = Object.freeze({
  orchestrator: {
    deployedOn: () => false,
    why: 'dead key — no bicep module builds an image reference from appImageTags.orchestrator in any boundary',
  },
  mapsTiles: {
    deployedOn: (boundary) => boundary === 'gcc-high' || boundary === 'il5',
    why: "compute/loom-maps-app.bicep is gated on mapsTileServerEnabled = (boundary == 'GCC-High' || boundary == 'IL5')",
  },
});

/**
 * The whole decision, pure: which `<repo>:<tag>` refs will this deployment pull?
 *
 * @param {object} o
 * @param {string} o.paramSrc          paramfile contents
 * @param {Record<string,string|undefined>} [o.env]  reconcile's exported pins
 * @param {boolean} [o.onlyUnpinned]   emit only the default-fallback refs
 * @param {string} [o.boundary]        commercial | gcc | gcc-high | il5
 * @param {ReadonlyArray<{key:string,repo:string,envVar:string}>} [o.table]
 * @param {Record<string,{deployedOn:(b:string)=>boolean,why:string}>} [o.conditions]
 * @returns {{refs:string[], pinned:string[], unpinned:string[], skipped:Array<{ref:string,why:string}>}}
 */
export function resolveRefs({
  paramSrc,
  env = {},
  onlyUnpinned = false,
  boundary = 'commercial',
  table = APP_IMAGE_TAGS,
  conditions = DEPLOY_CONDITIONS,
}) {
  const refs = [];
  const pinned = [];
  const unpinned = [];
  const skipped = [];

  for (const entry of table) {
    const fromEnv = env[entry.envVar];
    const fallback = paramDefaultFor(paramSrc, entry.envVar);

    // Neither a running pin nor a declared default => this paramfile does not
    // deploy this app. Asserting a tag the template will not pull would be a
    // FALSE failure, which is how a guard gets disabled.
    if (!fromEnv && !fallback) continue;

    const ref = `${entry.repo}:${fromEnv || fallback}`;

    // A RUNNING container outranks the static condition table: if the app is
    // live in this estate, its image is pulled here whatever the table says, and
    // the tag is provably present anyway. This ordering means a stale/incorrect
    // exclusion can never hide a tag that is actually in use.
    const cond = conditions[entry.key];
    if (!fromEnv && cond && !cond.deployedOn(boundary)) {
      skipped.push({ ref, why: cond.why });
      continue;
    }

    if (fromEnv) pinned.push(ref);
    else unpinned.push(ref);

    if (!onlyUnpinned || !fromEnv) refs.push(ref);
  }

  return { refs, pinned, unpinned, skipped };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Guarded so the module can be imported by the test suite without running.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const paramFile = flagValue('--param-file');
  const boundary = (flagValue('--boundary') || 'commercial').toLowerCase();
  const onlyUnpinned = argv.includes('--only-unpinned');
  const asJson = argv.includes('--json');

  if (!paramFile) {
    console.error(
      'resolve-image-preflight-refs: --param-file <path/to/x.bicepparam> is required.',
    );
    process.exit(2);
  }

  let paramSrc;
  try {
    paramSrc = readFileSync(paramFile, 'utf8');
  } catch (e) {
    console.error(
      `resolve-image-preflight-refs: cannot read ${paramFile}: ${e?.message || e}`,
    );
    process.exit(2);
  }

  const { refs, pinned, unpinned, skipped } = resolveRefs({
    paramSrc,
    env: process.env,
    onlyUnpinned,
    boundary,
  });

  console.error(
    `[image-preflight-refs] ${paramFile} (boundary=${boundary}): ${pinned.length} pinned to a RUNNING tag, ` +
      `${unpinned.length} falling back to a paramfile default` +
      `${unpinned.length ? ` (${unpinned.join(' ')})` : ''}.`,
  );
  // Every exclusion is printed. A guard that narrows itself silently is the
  // failure mode this whole file exists to avoid.
  for (const s of skipped) {
    console.error(`[image-preflight-refs]   NOT ASSERTED  ${s.ref} — ${s.why}`);
  }

  if (asJson) console.log(JSON.stringify({ refs, pinned, unpinned, skipped }, null, 2));
  else for (const r of refs) console.log(r);
}

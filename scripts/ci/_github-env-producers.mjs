/**
 * _github-env-producers.mjs — the ONE table of scripts that publish env vars
 * into `$GITHUB_ENV` from code a shell-text scanner cannot read.
 *
 * ── WHY THIS IS SHARED RATHER THAN RESTATED (#3449) ─────────────────────────
 *
 * Two guards ask overlapping questions about the same mechanism:
 *
 *   check-bicepparam-env-reaches-deploy.mjs — is `LOOM_UNITY_TAG` in scope
 *     where the template that reads it is deployed?
 *   check-workflow-unset-vars.mjs — is `$LOOM_UNITY_TAG` assigned anywhere
 *     before a `run:` step reads it under `set -u`?
 *
 * Both answer "yes" when an earlier step in the job wrote the name to
 * `$GITHUB_ENV`. Both detect the LITERAL shell form
 * (`echo "NAME=…" >> "$GITHUB_ENV"`) on their own. Neither can see a **Node**
 * script that appends to the same file — `reconcile-resolve.mjs` and
 * `adopt-image-tags.mjs` both do, via `appendFileSync(process.env.GITHUB_ENV, …)`.
 *
 * The first guard grew a private table for this. The second never did, and the
 * gap stayed invisible for one reason only: no `run:` step in
 * deploy-fiab-commercial.yml reads a `LOOM_*_TAG` in shell, so
 * reconcile-resolve.mjs's invisibility was never exercised. #3449 is the first
 * change to read one, and it turned a correct runtime into four false
 * "unassigned" findings on a merge-blocking, zero-tolerance lane.
 *
 * The obvious escape from that is `# unset-var-ok: NAME` on each site — which
 * would permanently blind four live reads and leave the CLASS open for the next
 * Node producer. That is the `guard_adoption_gap` shape this repo keeps
 * re-finding: the correct helper existed, the sibling never adopted it. So the
 * table moved here and both guards read it.
 *
 * ── WHAT THIS CREDITS — MEASURED, NOT ASSERTED ──────────────────────────────
 *
 * A guard cannot execute the producer, so it credits a DECLARED key list: the
 * FULL `APP_IMAGE_TAGS` set, currently 20 names, computed rather than typed out
 * so it cannot drift from the table the producers themselves iterate.
 *
 * THE CREDIT IS WIDER THAN WHAT EITHER PRODUCER WRITES. An earlier revision of
 * this file claimed "for that producer the credited set is exactly the written
 * set." That is FALSE and is retracted here. `adopt-image-tags.mjs` writes only
 * the tags the `.bicepparam` on its command line DECLARES:
 *
 *     param file            declared   credited but never written
 *     gcc-high.bicepparam        17    LOOM_DBT_RUNNER_TAG,
 *     il5.bicepparam             17    LOOM_TRANSFORM_RUNNER_TAG,
 *                                      LOOM_MAPS_TILES_TAG
 *     gcc.bicepparam              0    all 20
 *
 * `reconcile-resolve.mjs` is looser still: it emits a line only for an app that
 * is RUNNING, and an absent app legitimately falls through to the param file's
 * default.
 *
 * THE CONSEQUENCE, STATED PLAINLY. A `run:` step that reads one of the
 * over-credited names under `set -u` — say
 * `"loom-dbt-runner:$LOOM_DBT_RUNNER_TAG"` in a Gov lane — passes
 * check-workflow-unset-vars.mjs and then ABORTS AT RUNTIME with
 * `LOOM_DBT_RUNNER_TAG: unbound variable`. That is the #3030 class this credit
 * sits inside, so the gap is recorded here rather than left to be rediscovered
 * from a red deploy.
 *
 * WHY IT IS STILL BOUNDED. The over-credit can only mislead about a name NO
 * boundary param file declares, and every such read is by construction a read
 * of a tag the deploy has no value for — a defect on its own terms. No such
 * read exists in the tree today (measured). The narrowing fix — intersect the
 * credit with the tags declared by the `--param-file` named in the same step
 * body, which is already on the command line — is a tracked follow-up, not
 * done here.
 *
 * ADDING AN ENTRY IS A REVIEWABLE ACT. A new row here widens two guards at
 * once. It belongs in a diff with the producer it describes, never on its own.
 */
import { APP_IMAGE_TAGS } from './reconcile-policy.mjs';

/**
 * @typedef {{re: RegExp, keys: string[], script: string}} EnvProducer
 * `re` matches the invocation inside a step body; `keys` are the names the
 * script writes to `$GITHUB_ENV`; `script` is the path, for messages.
 */

/** @type {ReadonlyArray<EnvProducer>} */
export const GITHUB_ENV_PRODUCERS = Object.freeze([
  {
    script: 'scripts/ci/reconcile-resolve.mjs',
    re: /reconcile-resolve\.mjs/,
    keys: APP_IMAGE_TAGS.map((e) => e.envVar),
  },
  {
    script: 'scripts/ci/adopt-image-tags.mjs',
    re: /adopt-image-tags\.mjs/,
    keys: APP_IMAGE_TAGS.map((e) => e.envVar),
  },
]);

/**
 * Every env name a step body publishes by RUNNING a known producer script.
 *
 * Returns an empty set when no producer matches, so a caller can union it with
 * its own literal-shell detection without special-casing.
 *
 * @param {string} stepBody
 * @returns {Set<string>}
 */
export function producerEnvWrites(stepBody) {
  const out = new Set();
  const body = String(stepBody ?? '');
  for (const p of GITHUB_ENV_PRODUCERS) {
    if (p.re.test(body)) for (const k of p.keys) out.add(k);
  }
  return out;
}

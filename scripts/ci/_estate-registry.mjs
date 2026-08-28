#!/usr/bin/env node
/**
 * _estate-registry.mjs — the ONE list of live CSA Loom estates, and the ONE
 * parser for the /build-marker.txt each of them serves.
 *
 * WHY THIS EXISTS (#3730)
 * =======================
 * Measured 2026-08-18 by unauthenticated HTTPS GET against both consoles:
 *
 *   estate       live sha    build stamp           /api/version   behind main
 *   Commercial   09ac2517    2026-08-18 15:20Z     0.98.11                  0
 *   Government   28de89fb    2026-08-11 09:23Z     0.90.2                 251
 *
 * Gov was serving a seven-day-old image, eight minor versions back, and NOTHING
 * anywhere said so. It was found by hand-curling two URLs.
 *
 * The reason nothing said so is recorded, verbatim, in the file this module was
 * carved out of. check-deploy-staleness.mjs's ESTATES table carried exactly one
 * entry and this note:
 *
 *   "GOV IS NOT LISTED, AND THAT IS REPORTED, NOT SILENT. The Gov console has
 *    no publicly-reachable marker (private ingress), so this check cannot see
 *    it."
 *
 * THAT PREMISE IS FALSE, and was false when written or has since become so.
 * Both markers answer 200 over plain HTTPS with no credential, no `az`, and no
 * Azure login — verified from a workstation with no Gov access whatsoever:
 *
 *   $ curl -s https://csa-loom.limitlessdata.ai/build-marker.txt
 *   loom-build-marker sha=09ac2517e8139f4fb6dff87ff2dac6c029b7f8d0 stamp=20260818T152007Z token=LOOM_LIVE_BUILD
 *   $ curl -s https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us/build-marker.txt
 *   loom-build-marker sha=28de89fb stamp=2026-08-11T09:23:46Z token=LOOM_LIVE_BUILD
 *
 * So the honest note about an unmeasurable estate had become the thing keeping
 * it unmeasured — a stale premise that read as rigour. Deleting the sentence is
 * not enough (that is the "reword the allowlist entry" mistake); the estate has
 * to be MEASURED, which is what this registry makes possible for both clouds at
 * once. cloud-parity.md: a control that watches Commercial and not Gov is not a
 * complete control, it is a Commercial control.
 *
 * WHAT LIVES HERE, AND WHY IT IS A LIBRARY
 * ----------------------------------------
 * The `_` prefix marks this as a shared module rather than a control, so
 * check-ci-guard-reachability.mjs does not demand a workflow invoke it (the
 * same convention as _workflow-yaml.mjs / _ratchet-count.mjs). Two controls
 * consume it:
 *
 *   scripts/ci/check-cross-cloud-drift.mjs   the dedicated cross-cloud alarm
 *   scripts/ci/check-deploy-staleness.mjs    the existing merged-≠-deployed
 *                                            watchdog, whose live-estate half
 *                                            now covers both clouds
 *
 * and the console keeps a SECOND, parallel registry in TypeScript
 * (apps/fiab-console/lib/admin/estate-fleet.ts) because it cannot import an
 * .mjs CI script into a Next build. That duplication is real and is named here
 * rather than papered over: the Gov Front Door literal appears in both files,
 * so re-pointing that estate in CODE means editing both.
 *
 * TWO THINGS HOLD THE COPIES TOGETHER, and they are what keep the duplication
 * from turning into drift:
 *   - the four ENV OVERRIDE NAMES are identical on both sides
 *     (LOOM_ESTATE_MARKER_URL / LOOM_ESTATE_VERSION_URL and their LOOM_GOV_*
 *     twins), so an operator re-points an estate ONCE, in one vocabulary,
 *     without touching either file;
 *   - both parsers assert against ONE fixture corpus,
 *     scripts/ci/__fixtures__/build-markers.json, so they cannot diverge on
 *     marker-format handling without a test going red.
 */

/**
 * Parse a /build-marker.txt body. PURE.
 *
 * THE TWO CLOUDS SERVE DIFFERENT SHAPES, and that is the whole reason this is a
 * named, tested function rather than an inline regex:
 *
 *   Commercial  sha=09ac2517e8139f4fb6dff87ff2dac6c029b7f8d0  (40 hex)
 *               stamp=20260818T152007Z                        (basic ISO)
 *   Government  sha=28de89fb                                  (8 hex)
 *               stamp=2026-08-11T09:23:46Z                    (extended ISO)
 *
 * The difference is structural, not incidental — it comes from the producers:
 * build-fiab-images-acr-tasks.yml passes `${{ github.sha }}`, gov-build-images.yml
 * passes `$(git rev-parse --short=8 HEAD)`. Both are legitimate builds. A parser
 * that accepted only one would report a healthy sovereign estate as malformed,
 * or — far worse, and the direction this repo has actually failed in — would
 * find no sha, hand the caller a null, and let the caller compute ZERO commits
 * behind for an estate it never read.
 *
 * SO: THERE IS NO SUCCESS-SHAPED FAILURE HERE. Every rejection carries a reason
 * naming what was actually served (deploy-integrity.md R7 — an error must not
 * assert something it did not establish). The caller gets `sha: null` together
 * with a non-null `error`, and every caller in this repo turns that pair into
 * an UNKNOWN verdict that FAILS, never into "up to date".
 *
 * The stamp is EXPLICITLY optional and is never allowed to invalidate a marker:
 * it is display metadata, the sha is the fact. `stamp=unknown` (the Dockerfile
 * ARG default) degrades to null while the sha survives.
 *
 * @param {string|null|undefined} text raw response body
 * @returns {{sha: string|null, stamp: string|null, error: string|null}}
 */
export function parseBuildMarker(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { sha: null, stamp: null, error: 'the marker response was empty — the endpoint answered with no body' };
  }

  // Capture ANY non-whitespace run after `sha=`, then validate it. Matching
  // `[0-9a-f]{7,40}` directly would be worse, not stricter: a marker reading
  // `sha=unknown` would simply not match, and "no sha= field at all" and "a
  // sha= field naming no commit" would collapse into one indistinguishable
  // null. They have different causes and different fixes, so they get different
  // messages. `\r` is whitespace, so a CRLF-terminated marker yields a clean
  // value rather than one carrying a control character into git and into a URL.
  const raw = text.match(/(?:^|\s)sha=([^\s]*)/)?.[1];

  if (raw === undefined) {
    return {
      sha: null,
      stamp: null,
      error: `the response carried no sha= field, so it is not a build marker — served ${describeBody(text)}`,
    };
  }
  if (raw === '') {
    return { sha: null, stamp: null, error: 'the marker\'s sha= field is empty — the image was built with `--build-arg LOOM_BUILD_SHA=` (no value)' };
  }
  // apps/fiab-console/Dockerfile:41 `ARG LOOM_BUILD_SHA=unknown`. An image built
  // with no build-arg at all carries this literal; it names no commit, so it is
  // an unidentified build rather than a sha. readBuildMarker() in the console
  // drops the same value.
  if (raw === 'unknown') {
    return {
      sha: null,
      stamp: null,
      error: 'the marker reports sha=unknown — this image was built without a LOOM_BUILD_SHA build-arg, '
        + 'so it does not name the commit it was built from and cannot be compared to any branch',
    };
  }
  if (!GIT_OBJECT_ID.test(raw)) {
    return {
      sha: null,
      stamp: null,
      // The value is SHOWN (bounded, control characters stripped) because a CI
      // operator cannot diagnose "malformed" without seeing it — but it is
      // returned only inside `error`, never as `sha`, so it can never reach a
      // git argument or a compare URL. That containment is the point of
      // GIT_OBJECT_ID; see the SSRF note on the console's copy.
      error: `the marker's sha= field is not a git object id (expected 7-40 hex): ${quoteBounded(raw)}`,
    };
  }

  const stampRaw = text.match(/(?:^|\s)stamp=([^\s]*)/)?.[1];
  const stamp = stampRaw && stampRaw !== 'unknown' ? stampRaw : null;
  return { sha: raw, stamp, error: null };
}

/**
 * A git object id and nothing else: 7-40 hex.
 *
 * The floor is 7 because that is git's own minimum abbreviation; the ceiling is
 * 40 because that is a full object id. Both bounds are load-bearing — 6 hex is
 * too ambiguous to name a commit, and anything past 40 is not one.
 */
export const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

/**
 * A bounded, control-character-free rendering of an untrusted field value.
 *
 * A CODEPOINT LOOP RATHER THAN A CHARACTER-CLASS REGEX, and the reason is
 * recorded because this file learned it the hard way. Expressing the class
 * needs a backslash escape, and the first version of this very comment had
 * its escapes eaten and written as the raw bytes they denote — which made the
 * whole module BINARY to git, so it vanished from `gh pr diff` and from the
 * GitHub web diff while still running fine. A 300-line file holding both
 * cloud endpoints, the marker parser and the object-id validator reviewed
 * itself, invisibly.
 *
 * That is the same class of defect this repo has recorded repeatedly
 * (heredocs eating backslashes; CRLF no-oping multi-line needles), so the
 * fix is to have no escape here to lose: the loop compares codepoints
 * numerically, and the bounds are written as hex literals in code rather
 * than as characters in a pattern.
 */
function quoteBounded(v) {
  const s = String(v);
  let safe = '';
  for (const ch of s.slice(0, 60)) {
    const c = ch.codePointAt(0);
    safe += (c < 0x20 || c === 0x7f) ? '?' : ch;
  }
  return JSON.stringify(safe) + (s.length > 60 ? ' (truncated)' : '');
}

/**
 * Say what a non-marker body actually WAS, in one clause.
 *
 * The realistic failure is not a corrupt marker, it is a 200 carrying something
 * else entirely — a Front Door / WAF interstitial, a login redirect, an ingress
 * error page. "no sha= field" alone sends someone to look at the Dockerfile;
 * "no sha= field, served an HTML page (216 bytes)" sends them to the ingress,
 * which is where the problem is.
 */
function describeBody(text) {
  const n = text.length;
  const head = text.trimStart().slice(0, 24).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return `an HTML/XML page (${n} bytes) — that is an ingress, WAF or error page answering in the console's place, not the console`;
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    return `a JSON document (${n} bytes), not the plain-text marker`;
  }
  return `${n} bytes beginning ${quoteBounded(text.trimStart().slice(0, 40))}`;
}

/**
 * THE LIVE ESTATES, both clouds.
 *
 * `markerUrl` is the console's own build fingerprint, written by
 * apps/fiab-console/Dockerfile:152 from the LOOM_BUILD_SHA build-arg and served
 * from Next's public/ dir. loom-roll-and-validate already probes the Commercial
 * one, so it is a load-bearing, deliberately-unauthenticated artifact — which is
 * what makes measuring BOTH clouds possible with no credentials, no `az`, and
 * no Azure login on the lane. That matters especially for Gov, where the repo's
 * standing rule is that verification comes from a GitHub Actions run and never
 * from local `az`: this needs neither.
 *
 * `versionUrl` is display metadata only. /api/version is also unauthenticated
 * and returns `{current, build:{sha,stamp}}`, which is how the operator sees
 * "0.90.2 vs 0.98.11" rather than two opaque hashes. It is DELIBERATELY not
 * part of any verdict: a version string is a label, the sha is the fact, and a
 * failed version fetch must never be able to change a drift result.
 *
 * ── ON THE PER-ESTATE ALLOWANCES ───────────────────────────────────────────
 * THERE IS NO COMMIT-COUNT TOLERANCE, in either entry, deliberately. The first
 * cut of the Commercial entry (in check-deploy-staleness.mjs) shipped
 * `maxCommitsBehind: 20` while the live estate was 13 behind — so the control
 * written because "nothing surfaces 'the estate is N commits behind'" classified
 * the actual estate `ok`. A signal that cannot fire on the condition it was
 * written for is not a signal. Being behind AT ALL is the condition; the only
 * tolerance is a small TIME window for a roll that is demonstrably in flight,
 * measured against the OLDEST commit the estate is missing.
 *
 * WHY GOV'S WINDOW IS WIDER THAN COMMERCIAL'S, AND WHY IT IS STILL SMALL.
 * Commercial's 90 minutes is measured: build-fiab-images-acr-tasks successes ran
 * 7-38 min and loom-roll-and-validate successes 8-18 min, so ~56 min is the
 * observed worst case end to end. Gov's chain is gov-build-images ->
 * gov-console-roll, both `workflow_dispatch`-only, so a Gov roll includes a
 * human deciding to start it; 240 minutes is the outer edge of "a roll is
 * genuinely in flight" for that shape.
 *
 * IT IS NOT A TOLERANCE FOR GOV BEING BEHIND, and must never be raised into
 * one. At the measured 2026-08-18 state — 251 commits, 7 days — Gov exceeds this
 * by a factor of forty, and the alarm firing on it is the CORRECT reading, not a
 * cry-wolf to be tuned away. deploy-integrity.md R3: a deploy path that has
 * never run is the loudest case of drift and never a silent pass. If Gov's
 * dispatch-only posture is a deliberate change-control decision for the
 * sovereign boundary (#3730 flags that question and does not answer it), the
 * answer is a documented operator acknowledgement — not a wider band here.
 *
 * ── `rollWorkflows` — WHAT "A ROLL IS IN FLIGHT" IS ACTUALLY MEASURED FROM ──
 * ADDED BY #4143, and the defect it closes is a deploy-integrity.md R7 one.
 * Past the allowance, classifyEstate used to state as fact that "the roll path
 * has stopped applying main to this estate" — derived from ELAPSED TIME ALONE.
 * Nothing anywhere looked for a roll that was running at that moment, so the
 * sentence asserted a cause the code had not established. That is the same
 * error as the 2026-08-05 "the tag does not exist" claim, which was really "I
 * could not reach the registry", and which cost two investigations.
 *
 * These are the workflows whose execution CAN change the sha this estate's
 * marker serves, so an in-flight run of any of them is the evidence the claim
 * needs. BOTH halves of each chain are listed, because the marker cannot move
 * until the image exists: an image build in progress is as much "a roll in
 * flight" as the roll step that follows it.
 *
 *   Commercial   build-fiab-images-acr-tasks (push: main) -> loom-roll-and-validate
 *                (workflow_run). The chain that makes this estate roll itself.
 *   Gov          gov-build-images -> gov-console-roll, both dispatch-only, which
 *                is why the Gov window is 240 minutes rather than 90.
 *
 * An empty list would be a silent way to make the in-flight question
 * unanswerable and the claim unrestorable, so a consumer that finds one must
 * report UNKNOWN rather than "no roll is in flight" — absence of a query is not
 * absence of a roll.
 *
 * ── THE URL OVERRIDES ──────────────────────────────────────────────────────
 * Each URL may be overridden by env, which is what lets the alarm be
 * MUTATION-PROVED against a fabricated marker (a guard nobody has watched fail
 * is not a guard). An override is a loud, printed condition — see
 * `describeOverrides()` — precisely so it can never be used to quietly point a
 * production run at a marker that always reads current.
 */
export const CLOUD_ESTATES = [
  {
    id: 'commercial',
    name: 'Commercial',
    cloud: 'AzureCloud',
    markerUrl: process.env.LOOM_ESTATE_MARKER_URL
      || 'https://csa-loom.limitlessdata.ai/build-marker.txt',
    markerUrlEnv: 'LOOM_ESTATE_MARKER_URL',
    versionUrl: process.env.LOOM_ESTATE_VERSION_URL
      || 'https://csa-loom.limitlessdata.ai/api/version',
    versionUrlEnv: 'LOOM_ESTATE_VERSION_URL',
    behindGraceMinutes: 90,
    maxAgeDays: 7,
    // The chain whose in-flight run is the evidence for / against "the roll
    // path has stopped" (#4143). See the `rollWorkflows` note above.
    rollWorkflows: ['build-fiab-images-acr-tasks.yml', 'loom-roll-and-validate.yml'],
    rollHint: 'gh workflow run loom-roll-and-validate.yml --ref main',
  },
  {
    id: 'gov',
    name: 'Azure Government',
    cloud: 'AzureUSGovernment',
    markerUrl: process.env.LOOM_GOV_ESTATE_MARKER_URL
      || 'https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us/build-marker.txt',
    markerUrlEnv: 'LOOM_GOV_ESTATE_MARKER_URL',
    versionUrl: process.env.LOOM_GOV_ESTATE_VERSION_URL
      || 'https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us/api/version',
    versionUrlEnv: 'LOOM_GOV_ESTATE_VERSION_URL',
    behindGraceMinutes: 240,
    maxAgeDays: 7,
    // Both halves of the Gov chain (#4143). Listing them is a READ, not a
    // dispatch: it answers "is a roll running right now" so the drift message
    // can stop asserting a cause it never measured. It does not, and must not,
    // start one — see the note on rollHint immediately below.
    rollWorkflows: ['gov-build-images.yml', 'gov-console-roll.yml'],
    // Deliberately NOT a dispatch this lane could perform. Whether Gov should
    // roll automatically is an open change-control decision for the sovereign
    // boundary (#3730); this registry makes the drift visible and stops there.
    rollHint: 'gh workflow run gov-build-images.yml --ref main   # then gov-console-roll.yml',
  },
];

/**
 * Which estate URLs are currently pointed somewhere other than production.
 *
 * PRINTED BY EVERY CONSUMER, unconditionally. An env-overridable endpoint is the
 * cheapest possible way to silence an alarm — point it at a marker that always
 * reads current and the lane goes green forever, with the diff showing nothing.
 * The override exists because the alarm has to be provable against fabricated
 * markers, so the mitigation is not to remove it but to make it impossible to
 * use quietly: any run whose verdict came from a non-production endpoint says so
 * on the line above the verdict.
 *
 * @returns {{id:string, env:string, url:string, kind:'marker'|'version'}[]}
 */
export function describeOverrides(estates = CLOUD_ESTATES) {
  const out = [];
  for (const e of estates) {
    if (process.env[e.markerUrlEnv]) out.push({ id: e.id, env: e.markerUrlEnv, url: e.markerUrl, kind: 'marker' });
    if (process.env[e.versionUrlEnv]) out.push({ id: e.id, env: e.versionUrlEnv, url: e.versionUrl, kind: 'version' });
  }
  return out;
}

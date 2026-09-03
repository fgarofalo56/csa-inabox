/**
 * Teeth for the deploy-vs-roll IMAGE RACE and the silence around it (#3676).
 *
 * ── WHAT HAPPENED, MEASURED ────────────────────────────────────────────────
 *
 * deploy-fiab-commercial.yml pins `appImageTags` to the tags the estate is
 * RUNNING so its ARM PUT is a no-op for every image. That read is correct. It
 * is just taken at the top of a ~25-minute job, and loom-roll-and-validate.yml
 * writes the same field:
 *
 *   07:03:06  deploy-fiab-commercial starts (schedule, run 32004118361)
 *   07:03:40  [reconcile] PIN console loom-console:587ac3b8…
 *   07:04:36  loom-roll-and-validate starts for b9ca620b (run 32004219673)
 *   07:10:56  revision 0000755 — loom-console:b9ca620b…   the roll lands
 *   07:19:48  revision 0000756 — loom-console:587ac3b8…   the apply, stale
 *   07:27:26  deploy-fiab-commercial: SUCCESS
 *
 * PR #3665 (GHSA-v2g8-gp3r-rg4r, the five destructive databricks-sql-warehouse
 * routes) was live for nine minutes and then reverted, and BOTH lanes reported
 * success. The roll's rollback step is `skipped` — correctly; it rolled fine
 * and was overwritten afterwards.
 *
 * Not the first time. Run 31870181337 (2026-08-15, schedule) pinned 8f8e569a
 * at 06:44:38; roll 31870718201 moved the console to 2dda97b4 between 06:57 and
 * 07:10; that deploy's own outputs at 07:26:33 record `"console": "8f8e569a…"`.
 * Across the window where both workflows' run history overlaps (roll history
 * back to 2026-08-02), 24 deploy runs overlapped a roll run and 3 of those were
 * SCHEDULED runs that apply.
 *
 * ── WHAT THESE TESTS ARE, AND ARE NOT ──────────────────────────────────────
 *
 * Two classes, kept apart on purpose:
 *
 *   BEHAVIOURAL   drive the real decision functions and the real file-fed CLI
 *                 (cliMain) through the exact states production hits, INCLUDING
 *                 the unreadable ones a live run cannot cheaply reproduce.
 *
 *   CONTRACT      assert that the two workflows still carry the shapes those
 *                 decisions depend on — the roll lane's `run-name` and its
 *                 `Roll image + validate live URL` job name, the deploy lane's
 *                 two new steps and their ordering. Neither file can see the
 *                 other; without these, renaming a job silently turns the
 *                 regression gate into a permanent UNKNOWN.
 *
 * They deliberately do NOT re-implement the subject. Every fixture below is
 * shaped like real `az containerapp list` / Actions API output, and the CLI is
 * driven through its real entrypoint rather than through a copy of its logic.
 *
 * ── MUTATION RECORD ────────────────────────────────────────────────────────
 *
 * Kept in the PR, not here. An earlier revision of this header carried a table
 * (M1-M7, "baseline 34 pass") that was already stale against the shipped suite
 * within a day — wrong baseline, wrong red counts, and one entry describing a
 * mutation that had been replaced. A mutation record that drifts is worse than
 * none: it reads as evidence while asserting numbers nobody re-measured.
 *
 * What belongs here is the METHOD, which does not drift:
 *
 *   - single-line needles only. The repo is checked out CRLF, so a needle
 *     carrying a literal newline matches NOTHING — producing a "mutation" that
 *     never applied and a green run that proves the opposite of what it looks
 *     like. Every read in this file normalises to LF first (`readNorm`).
 *   - each mutation is asserted APPLIED by byte delta before the suite runs,
 *     and the file is restored and confirmed byte-identical by sha256 after.
 *   - a mutation that turns out to be a NO-OP is discarded, not counted as
 *     coverage. One did: injecting an export into the CLI's refusal path emits
 *     nothing, because `repin` is already {} there.
 *   - "delete the step" and "move the step" are DIFFERENT mutations and are
 *     measured separately. Conflating them overstates the controls exactly
 *     where ordering is what matters.
 *
 * Run: node --test scripts/ci/__tests__/roll-race.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  APP_IMAGE_TAGS,
  CONSOLE_APP_NAME,
  CONSOLE_IMAGE_KEY,
  CONSOLE_ROLL_SOURCES,
  ESTATE_ROLL_LANES,
  SHA_TAG_RE,
  buildHealRequests,
  cliMain,
  comparePins,
  decideEstateRegression,
  decideEstateRegressionAll,
  decidePinRefresh,
  parseRollRunTitle,
  pinsFromEnv,
  resolveRunningImageTags,
  selectLastConsoleRoll,
  selectRevisionOverwrite,
  selectServingRevision,
  selectWatchedApps,
} from '../reconcile-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * Normalised read. The repo is checked out CRLF on Windows; a needle written
 * with `\n` matches nothing against the raw bytes, and a guard whose search
 * silently finds zero reports a reassuring pass.
 */
const readNorm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const ROLL_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'loom-roll-and-validate.yml');
const DEPLOY_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-commercial.yml');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Every `deploy-fiab-*` lane, DERIVED from disk rather than hand-listed (#3907).
 *
 * #3888 ported the #3676 re-pin to `deploy-fiab-gcch.yml` and
 * `deploy-fiab-il5.yml` and did NOT port the guard that protects it, so the
 * adjacency invariant below was asserted on Commercial ONLY. Measured on
 * `origin/main` before this change: inserting a step between the re-pin and the
 * apply took roll-race.test.mjs RC 0 -> 1 on Commercial and RC 0 -> 0 on gcch —
 * five guards, zero discrimination. A hand-listed lane set is the same rot one
 * level down (#3896), so the population is read off the directory.
 */
const DEPLOY_LANES = readdirSync(WORKFLOW_DIR)
  .filter((f) => /^deploy-fiab-[a-z0-9]+\.yml$/.test(f))
  .sort()
  .map((f) => ({
    lane: f.replace(/^deploy-fiab-/, '').replace(/\.yml$/, ''),
    file: f,
    path: join(WORKFLOW_DIR, f),
  }));

/**
 * One workflow's steps at a given indent, as `{ name, id }`.
 *
 * The apply step is identified by its `id: provision`, not by its display name:
 * the three lanes spell it differently today — "Provision (idempotent)" on
 * Commercial, "Provision (with full Gov dispatch)" on gcch, "Teardown ->
 * redeploy -> smoke (full mode only)" on il5 — and a guard keyed to one spelling
 * is exactly the failure this issue is about. `id` is what the lanes' own `if:`
 * conditions and post-apply gates already key on, so it is the load-bearing
 * name.
 */
function stepsWithIds(yaml, indent = 6) {
  const pad = ' '.repeat(indent);
  const marks = [...yaml.matchAll(new RegExp(`^${pad}- name: (.+)$`, 'gm'))];
  return marks.map((m, k) => {
    const body = yaml.slice(m.index, k + 1 < marks.length ? marks[k + 1].index : yaml.length);
    const id = new RegExp(`^${pad}  id: (\\S+)\\s*$`, 'm').exec(body);
    return { name: m[1], id: id ? id[1] : null };
  });
}

/** The lanes that actually carry the re-pin, with their parsed step lists. */
const REPIN_LANES = DEPLOY_LANES
  .map((l) => ({ ...l, steps: stepsWithIds(readNorm(l.path)) }))
  .map((l) => ({
    ...l,
    repinIdx: l.steps.findIndex((s) => s.name.startsWith('Re-pin appImageTags to the RUNNING images')),
  }))
  .filter((l) => l.repinIdx !== -1);

/** The real SHAs from the incident, so the fixtures are not invented shapes. */
const ROLLED = 'b9ca620b2a4add7fb7d14bd301f695aadfc71a3b';   // what the roll shipped
const STALE = '587ac3b813606f56fc7cef188dca2d1e8e1206a5';    // what the deploy re-applied

/** `az containerapp list` projection, at a given console tag. */
const estateAt = (consoleTag) => [
  { name: 'loom-console', image: `acr1.azurecr.io/loom-console:${consoleTag}` },
  { name: 'loom-mcp', image: 'acr1.azurecr.io/loom-mcp:0.80.0' },
  { name: 'loom-unity', image: 'acr1.azurecr.io/loom-unity:0.80.0' },
];

// ---------------------------------------------------------------------------
// THE 2026-08-19 MISS — the run where this gate EXISTED, RAN, and passed.
//
// Every value below was read off the live Commercial estate and the two runs,
// not invented: `az containerapp revision list -n loom-console -g
// rg-csa-loom-admin-centralus`, deploy run 32225183031 and roll run
// 32225337320. The re-pin measured at 06:57:53Z; the gate queried at 07:14:52Z
// and printed "0 run(s) completed in that window" while revision 0000782 sat
// in the history between two revisions carrying the tag the deploy applied.
// ---------------------------------------------------------------------------

/** What the scheduled deploy re-applied on 2026-08-19. */
const AUG19_APPLIED = '83e7cab61e8c978de3352b21b05551e4bb85d7a6';
/** What roll 32225337320 shipped, and what was overwritten. */
const AUG19_ROLLED = '150d2937336415545a771fe12f0d7b2fba2093d8';
/** The moment the re-pin step recorded, verbatim from the run's env block. */
const AUG19_MEASURED_AT = '2026-08-19T06:57:53Z';

/**
 * `az containerapp revision list` projection, verbatim from the live estate AS
 * IT WAS PROJECTED THEN — no `trafficWeight`, because the gate did not ask for
 * one until #3798. Kept in exactly that shape, and used ONLY by the test that
 * asserts an unweighted payload now fails CLOSED. Every behavioural test below
 * uses AUG19_REVISIONS_WEIGHTED, which is the same three revisions as the
 * CURRENT projection returns them.
 *
 * 0000781 predates the measurement; 0000782 is the roll; 0000783 is the apply.
 */
const AUG19_REVISIONS = [
  { name: 'loom-console--0000781', createdTime: '2026-08-19T05:46:46+00:00', image: `acrloomk6mvh5sm6z7do.azurecr.io/loom-console:${AUG19_APPLIED}` },
  { name: 'loom-console--0000782', createdTime: '2026-08-19T07:04:56+00:00', image: `acrloomk6mvh5sm6z7do.azurecr.io/loom-console:${AUG19_ROLLED}` },
  { name: 'loom-console--0000783', createdTime: '2026-08-19T07:10:19+00:00', image: `acrloomk6mvh5sm6z7do.azurecr.io/loom-console:${AUG19_APPLIED}` },
];

/**
 * The live projection shape: `trafficWeight` alongside name/createdTime/image.
 *
 * The weights are not invented either. Measured on the same Container App on
 * 2026-08-21: 54 revisions, every one `active`, exactly ONE carrying weight 100
 * and all 53 others 0, with ingress traffic `[{latestRevision:true,weight:100}]`
 * — so "newest carries 100, the rest carry 0" is the shape this estate returns.
 */
const rev = (name, createdTime, tag, trafficWeight) => ({
  name, createdTime, trafficWeight,
  image: `acrloomk6mvh5sm6z7do.azurecr.io/loom-console:${tag}`,
});

/** The 2026-08-19 incident list as the NEW projection returns it. */
const AUG19_REVISIONS_WEIGHTED = [
  rev('loom-console--0000781', '2026-08-19T05:46:46+00:00', AUG19_APPLIED, 0),
  rev('loom-console--0000782', '2026-08-19T07:04:56+00:00', AUG19_ROLLED, 0),
  rev('loom-console--0000783', '2026-08-19T07:10:19+00:00', AUG19_APPLIED, 100),
];

// ---------------------------------------------------------------------------
// BEHAVIOURAL — I-FRESH (the re-pin immediately before the apply)
// ---------------------------------------------------------------------------

test('pinsFromEnv reads back exactly the LOOM_*_TAG pins a previous step exported', () => {
  const env = { LOOM_CONSOLE_TAG: STALE, LOOM_MCP_TAG: '0.80.0', LOOM_NOT_A_TAG: 'x', LOOM_UNITY_TAG: '  ' };
  const pins = pinsFromEnv(env);
  assert.equal(pins[CONSOLE_IMAGE_KEY], STALE);
  assert.equal(pins.mcp, '0.80.0');
  assert.ok(!('unity' in pins), 'a whitespace-only value is not a pin');
});

test('THE INCIDENT: a pin that went stale under a roll is detected and RE-PINNED, not applied', () => {
  const previous = { [CONSOLE_IMAGE_KEY]: STALE, mcp: '0.80.0', unity: '0.80.0' };
  const fresh = resolveRunningImageTags(estateAt(ROLLED));
  const v = decidePinRefresh({ deployAppsEnabled: 'true', previous, resolution: fresh });

  assert.equal(v.decision, 'proceed');
  assert.equal(v.comparison.moved.length, 1);
  assert.deepEqual(
    { repo: v.comparison.moved[0].repo, was: v.comparison.moved[0].was, now: v.comparison.moved[0].now },
    { repo: 'loom-console', was: STALE, now: ROLLED },
  );
  assert.equal(
    v.repin[CONSOLE_IMAGE_KEY],
    ROLLED,
    'the tag handed to the apply must be the one the estate is RUNNING. Applying the earlier ' +
      'measurement is what reverted PR #3665 nine minutes after it went live.',
  );
});

test('no drift -> the pins are re-emitted unchanged and the run says the PUT is a no-op', () => {
  const previous = { [CONSOLE_IMAGE_KEY]: ROLLED, mcp: '0.80.0', unity: '0.80.0' };
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous,
    resolution: resolveRunningImageTags(estateAt(ROLLED)),
  });
  assert.equal(v.decision, 'proceed');
  assert.equal(v.comparison.moved.length, 0);
  assert.equal(v.repin[CONSOLE_IMAGE_KEY], ROLLED);
  assert.match(v.reason, /no-op/);
});

test('an UNREADABLE estate REFUSES — it is not evidence that nothing moved', () => {
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous: { [CONSOLE_IMAGE_KEY]: STALE },
    resolution: resolveRunningImageTags(null),
    readError: 'AuthorizationFailed',
  });
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /UNKNOWN/);
  assert.match(v.reason, /AuthorizationFailed/, 'the refusal must carry what the control plane actually said');
  assert.deepEqual(v.repin, {}, 'a refusal must not also export pins');
});

test('a key that WAS pinned and is now digest-pinned is UNKNOWN, and UNKNOWN refuses', () => {
  const containers = [
    { name: 'loom-console', image: 'acr1.azurecr.io/loom-console@sha256:' + 'a'.repeat(64) },
  ];
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous: { [CONSOLE_IMAGE_KEY]: STALE },
    resolution: resolveRunningImageTags(containers),
  });
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /UNKNOWN is not "unchanged"/);
});

test('#4064: the pin-refresh landing inside the unity-pair roll window RE-PINS to the canonical, not refuses', () => {
  // The measured incident (deploy-fiab-commercial run 32819058867, step 27):
  // this run pinned unity, the data-plane roll moved loom-unity to a new tag,
  // and the fresh read landed 2s before iceberg-catalog followed. The old
  // repo-bucketing read "2 containers at 2 different tags" -> UNKNOWN ->
  // refuse, blocking a healthy estate. With the canonicalApp declaration the
  // pin follows loom-unity alone and the follower converges on the apply.
  const pinnedByThisRun = '4d4fd0b9';
  const rolledTo = '2456cebb';
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous: { [CONSOLE_IMAGE_KEY]: ROLLED, unity: pinnedByThisRun },
    resolution: resolveRunningImageTags([
      ...estateAt(ROLLED).filter((c) => c.name !== 'loom-unity'),
      { name: 'loom-unity', image: `acr1.azurecr.io/loom-unity:${rolledTo}` },
      { name: 'iceberg-catalog', image: `acr1.azurecr.io/loom-unity:${pinnedByThisRun}` },
    ]),
  });
  assert.equal(v.decision, 'proceed', 'a follower one apply behind must not refuse the pin-refresh');
  assert.equal(v.repin.unity, rolledTo, 'the apply must carry the tag the CANONICAL app is running');
  assert.ok(
    v.comparison.moved.some((m) => m.repo === 'loom-unity' && m.was === pinnedByThisRun && m.now === rolledTo),
    'the move is reported, not silent',
  );
  assert.equal(v.comparison.unknown.length, 0);
});

test('an app that came up under the run is PINNED, so the param default is not written over it', () => {
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous: { [CONSOLE_IMAGE_KEY]: ROLLED },
    resolution: resolveRunningImageTags(estateAt(ROLLED)),
  });
  assert.ok(v.comparison.appeared.some((a) => a.repo === 'loom-unity'));
  assert.equal(v.repin.unity, '0.80.0');
});

test('an app that VANISHED is reported but never refused — creating it is not a revert', () => {
  const v = decidePinRefresh({
    deployAppsEnabled: 'true',
    previous: { [CONSOLE_IMAGE_KEY]: ROLLED, mirroring: 'v0.1' },
    resolution: resolveRunningImageTags(estateAt(ROLLED)),
  });
  assert.equal(v.decision, 'proceed');
  assert.ok(v.comparison.vanished.some((x) => x.repo === 'loom-mirroring'));
});

test('deployAppsEnabled=false writes no image, so there is nothing to re-pin (and it says so)', () => {
  const v = decidePinRefresh({
    deployAppsEnabled: 'false',
    previous: { [CONSOLE_IMAGE_KEY]: STALE },
    resolution: resolveRunningImageTags(estateAt(ROLLED)),
  });
  assert.equal(v.decision, 'proceed');
  assert.deepEqual(v.repin, {});
  assert.match(v.reason, /no container image is written/);
});

test('comparePins on an unprobed resolution reports probed:false rather than "everything is fine"', () => {
  const c = comparePins({ [CONSOLE_IMAGE_KEY]: STALE }, resolveRunningImageTags(null));
  assert.equal(c.probed, false);
  assert.equal(c.moved.length, 0, 'no drift may be CLAIMED from a read that did not happen');
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — I-BEHIND (the post-apply estate-vs-roll comparison)
// ---------------------------------------------------------------------------

test('parseRollRunTitle reads the SHA out of the roll lane run-name contract', () => {
  assert.deepEqual(parseRollRunTitle(`roll ${ROLLED} (build-triggered)`), {
    tag: ROLLED, sha: ROLLED, trigger: 'build-triggered',
  });
  assert.deepEqual(parseRollRunTitle('roll latest (manual dispatch)'), {
    tag: 'latest', sha: null, trigger: 'manual dispatch',
  });
  assert.equal(parseRollRunTitle('deploy-fiab-commercial'), null);
  assert.equal(parseRollRunTitle(''), null);
});

test('a roll run that concluded SUCCESS with its roll job SKIPPED is NOT the last roll', () => {
  // Run 32006479915, measured: 8 seconds, gate succeeded, roll job skipped,
  // RUN conclusion `success`. Reading the run conclusion would name 66bb26e7 as
  // what the estate should be running and hide the revert entirely.
  const sel = selectLastConsoleRoll([
    {
      id: 32006479915, workflow: 'loom-roll-and-validate.yml',
      title: 'roll 66bb26e705a17796d639a9752990c6e70ab96c35 (build-triggered)',
      completedAt: '2026-08-17T07:35:30Z', jobConclusion: 'skipped',
    },
  ]);
  assert.equal(sel.status, 'none');
  assert.match(sel.reason, /none of them had a successful roll job/);
});

test('THE INCIDENT: the estate on the deploy-applied tag while a roll shipped a newer one is a REGRESSION', () => {
  const sel = selectLastConsoleRoll([
    {
      id: 32004219673, workflow: 'loom-roll-and-validate.yml',
      title: `roll ${ROLLED} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
    },
  ]);
  assert.equal(sel.status, 'found');
  assert.equal(sel.roll.sha, ROLLED);

  const v = decideEstateRegression({ appliedTag: STALE, estateTag: STALE, rollSelection: sel });
  assert.equal(
    v.verdict, 'regression',
    'this is the exact state of the live estate at 07:19:48 on 2026-08-17. A gate that passes here is a gate ' +
      'that cannot fail.',
  );
  assert.match(v.reason, /THE ESTATE WENT BACKWARDS/);
  assert.match(v.reason, new RegExp(ROLLED), 'the error must name the SHA that was overwritten');
  assert.match(v.reason, /THIS DEPLOY applied/, 'and must say the deploy is the one that did it');
});

// ---------------------------------------------------------------------------
// I-ESTATE — the revision history, which is the source that was available and
// unconsulted on the run this gate missed (#3676 reopened, 2026-08-19).
// ---------------------------------------------------------------------------

test('THE 2026-08-19 MISS: the estate\'s own revision history shows the overwrite the Actions API did not', () => {
  const sel = selectRevisionOverwrite(AUG19_REVISIONS_WEIGHTED, {
    measuredAt: AUG19_MEASURED_AT,
    appliedTag: AUG19_APPLIED,
  });
  assert.equal(
    sel.status, 'overwritten',
    'this is the live revision list at 07:14:52Z on 2026-08-19. Anything but `overwritten` here is a gate ' +
      'that cannot fail on the incident it was written for.',
  );
  assert.equal(sel.overwrittenTag, AUG19_ROLLED, 'the roll-forward target is read OFF THE ESTATE, not inferred');
  assert.match(sel.reason, /loom-console--0000782/, 'the reason must name the revision that was overwritten');
  assert.match(sel.reason, /loom-console--0000783/, 'and the revision that replaced it');
});

test('MUTATION CONTROL: with the revision evidence withheld, the very same state passes — which is what shipped', () => {
  // The Actions API population as this gate ACTUALLY received it at 07:14:52Z:
  // empty. Replaying the gate's own query today returns roll 32225337320, so
  // this fixture reproduces the miss, not a hypothetical.
  const rollSelection = selectLastConsoleRoll([]);
  const withoutRevisions = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection,
  });
  assert.equal(
    withoutRevisions.verdict, 'ok',
    'CONTROL: the pre-fix gate reported OK across the revert. If this ever stops being `ok`, the assertion below ' +
      'no longer proves the revision read is what moves the verdict.',
  );

  const withRevisions = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection,
    revisionSelection: selectRevisionOverwrite(AUG19_REVISIONS_WEIGHTED, {
      measuredAt: AUG19_MEASURED_AT,
      appliedTag: AUG19_APPLIED,
    }),
  });
  assert.equal(
    withRevisions.verdict, 'regression',
    'and WITH it, the same inputs go red. The revision read is the difference, not a coincidence of fixtures.',
  );
  assert.equal(withRevisions.rollForwardTo, AUG19_ROLLED);
  assert.match(withRevisions.reason, /ITS OWN REVISION HISTORY RECORDS IT/);
});

test('a roll that lands AFTER our apply AND TAKES TRAFFIC leaves the estate AHEAD — no false red', () => {
  const sel = selectRevisionOverwrite([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 0),
    rev('r2', '2026-08-19T07:20:00Z', AUG19_ROLLED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'ahead', 'the image being SERVED is not ours, so this apply left nothing behind');
  assert.match(sel.reason, /did not leave the estate behind/);
});

test('a transient revert that a later roll already repaired is AHEAD, not a red', () => {
  // roll -> our apply clobbers it -> the roll lane rolls again. The estate is
  // correct NOW; reddening here would be a gate crying wolf about a healed state.
  const sel = selectRevisionOverwrite([
    rev('r1', '2026-08-19T07:04:56Z', AUG19_ROLLED, 0),
    rev('r2', '2026-08-19T07:10:19Z', AUG19_APPLIED, 0),
    rev('r3', '2026-08-19T07:22:00Z', AUG19_ROLLED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'ahead');
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — WHAT IS SERVING, not what is NEWEST (#3798) — and WHO WROTE
// LAST, which is what makes an attribution a fact rather than an accusation.
//
// The gate read "the newest revision in the window" as "the live image". That
// is true on this estate TODAY — measured 2026-08-21: activeRevisionsMode
// Multiple, 54 revisions, 53 at trafficWeight 0 and exactly one at 100, ingress
// traffic [{latestRevision: true, weight: 100}] — but it is true because
// app-deployments.bicep pins `latestRevision: true`, i.e. because the feature
// that would break it (imperative traffic splitting from console-bluegreen-roll,
// 0-for-4) does not currently work.
// ---------------------------------------------------------------------------

test('selectServingRevision reads the SERVING revision off the traffic split', () => {
  const sel = selectServingRevision(AUG19_REVISIONS_WEIGHTED);
  assert.equal(sel.status, 'found');
  assert.equal(sel.tag, AUG19_APPLIED);
  assert.equal(sel.name, 'loom-console--0000783');
  assert.equal(sel.weight, 100);
});

test('selectServingRevision: a payload with NO weights is `unweighted` and SAYS the split was not read', () => {
  const sel = selectServingRevision(AUG19_REVISIONS);
  assert.equal(sel.status, 'unweighted', 'no weight anywhere is "I did not look", not "the newest one"');
  assert.match(sel.reason, /NOT read/, 'the fallback must be disclosed, never silently assumed (R7)');
});

test('selectServingRevision: every weight ZERO is UNKNOWN — an app serving nothing is not "the newest"', () => {
  const sel = selectServingRevision([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 0),
    rev('r2', '2026-08-19T07:10:00Z', AUG19_ROLLED, 0),
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /NO revision is taking/);
});

test('selectServingRevision: traffic split across two IMAGES is UNKNOWN, not a guess at one of them', () => {
  const sel = selectServingRevision([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 50),
    rev('r2', '2026-08-19T07:10:00Z', AUG19_ROLLED, 50),
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /split across 2 different images/);
});

test('selectServingRevision: a DIGEST-PINNED serving revision is UNKNOWN — a digest does not name a commit', () => {
  const sel = selectServingRevision([
    { name: 'r1', trafficWeight: 100, image: 'acr1.azurecr.io/loom-console@sha256:abc' },
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /digest-pinned/);
});

test('selectServingRevision: two revisions of the SAME image splitting traffic is still one answer', () => {
  const sel = selectServingRevision([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_ROLLED, 40),
    rev('r2', '2026-08-19T07:10:00Z', AUG19_ROLLED, 60),
  ]);
  assert.equal(sel.status, 'found');
  assert.equal(sel.tag, AUG19_ROLLED);
  assert.equal(sel.weight, 60, 'the heaviest revision names it, and both carry the same image anyway');
});

test('THE #3798 FALSE GREEN: a NEWER revision at weight 0 while our tag serves 100 is a FAILING verdict, not `ahead`', () => {
  // Blue-green starts working. The roll creates revision N+1 carrying the new
  // tag at weight 0; the deploy's revision keeps 100% of the traffic. Recency
  // says "the newest is not ours, so we left nothing behind" — about an estate
  // serving the deploy's stale image. That green is the defect.
  //
  // It is NOT, however, an OVERWRITE by this apply: our revision came FIRST.
  // Calling it `overwritten` would attribute to this run a write it did not
  // make, and — with the auto-heal wired to that verdict — would dispatch a
  // roll at an image console-bluegreen-roll.yml may still be health-gating at
  // weight 0. So the honest verdict is `drifted`: red, loud, no direction.
  const revisions = [
    rev('loom-console--0000783', '2026-08-19T07:10:19+00:00', AUG19_APPLIED, 100),
    rev('loom-console--0000784', '2026-08-19T07:20:00+00:00', AUG19_ROLLED, 0),
  ];
  const sel = selectRevisionOverwrite(revisions, {
    measuredAt: AUG19_MEASURED_AT,
    appliedTag: AUG19_APPLIED,
  });
  assert.equal(sel.status, 'drifted', `expected a failing, non-attributing verdict; got ${sel.status}: ${sel.reason}`);
  assert.equal(sel.liveTag, AUG19_APPLIED, 'the live image comes from the split, not from recency');
  assert.equal(sel.liveFrom, 'traffic');
  assert.ok(!('overwrittenTag' in sel), 'a state this apply did not cause must name no roll-forward target');
  assert.match(sel.reason, /NO DIRECTION IS BEING CLAIMED/);

  const verdict = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_ROLLED, // the app template followed the later write
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: sel,
  });
  assert.equal(verdict.verdict, 'drifted', 'and the whole gate fails on it');
  assert.ok(!verdict.rollForwardTo, 'with nothing for the auto-heal step to dispatch');
});

test('#3798 + blame: the SAME two revisions in the OTHER order are a regression, and DO name a target', () => {
  // Identical images, identical weights — only the creation order differs. This
  // is the discriminator: `overwritten` is claimed exactly when OUR revision
  // came after the competing one, which is the one case attribution is a fact.
  const sel = selectRevisionOverwrite([
    rev('loom-console--0000783', '2026-08-19T07:10:19+00:00', AUG19_ROLLED, 0),
    rev('loom-console--0000784', '2026-08-19T07:20:00+00:00', AUG19_APPLIED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'overwritten');
  assert.equal(sel.overwrittenTag, AUG19_ROLLED);
  const verdict = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: sel,
  });
  assert.equal(verdict.verdict, 'regression');
  assert.equal(verdict.rollForwardTo, AUG19_ROLLED);
});

test('BLAME: our tag is live but we wrote NOTHING in this window -> drifted, never an accusation', () => {
  // Traffic sits on a revision created before the measurement; the only thing
  // in the window is somebody else's unserved write. This apply cannot have
  // displaced it — it did not write at all.
  const sel = selectRevisionOverwrite([
    rev('loom-console--0000780', '2026-08-19T05:00:00+00:00', AUG19_APPLIED, 100),
    rev('loom-console--0000784', '2026-08-19T07:20:00+00:00', AUG19_ROLLED, 0),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'drifted');
  assert.match(sel.reason, /NO revision carrying this deploy's tag was created in this window/);
});

test('MUTATION CONTROL for #3798: the SAME list with trafficWeight stripped fails CLOSED', () => {
  const revisions = [
    rev('loom-console--0000783', '2026-08-19T07:10:19+00:00', AUG19_APPLIED, 100),
    rev('loom-console--0000784', '2026-08-19T07:20:00+00:00', AUG19_ROLLED, 0),
  ].map(({ trafficWeight, ...r }) => r); // eslint-disable-line no-unused-vars
  const sel = selectRevisionOverwrite(revisions, {
    measuredAt: AUG19_MEASURED_AT,
    appliedTag: AUG19_APPLIED,
  });
  assert.equal(
    sel.status, 'unknown',
    'CONTROL: without the weights "what is serving" is not established, and this gate does not read it off ' +
      'recency instead. The pre-change binary returned `ahead` (RC=0) on this exact payload — that is the false ' +
      'green — so the fallback is not a safe default, it IS the defect.',
  );
  assert.match(sel.reason, /carries a trafficWeight/);
  assert.match(sel.reason, /NOT read off/);
});

test('#3798 does not change TODAY\'s verdicts: the incident is still `overwritten` with the weights present', () => {
  const sel = selectRevisionOverwrite(AUG19_REVISIONS_WEIGHTED, {
    measuredAt: AUG19_MEASURED_AT,
    appliedTag: AUG19_APPLIED,
  });
  assert.equal(sel.status, 'overwritten');
  assert.equal(sel.overwrittenTag, AUG19_ROLLED);
  assert.equal(sel.liveFrom, 'traffic');
});

test('#3798 does not change TODAY\'s verdicts: a healthy roll after the apply is still `ahead`', () => {
  const sel = selectRevisionOverwrite([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 0),
    rev('r2', '2026-08-19T07:20:00Z', AUG19_ROLLED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'ahead');
  assert.equal(sel.liveTag, AUG19_ROLLED);
});

test('#3798 does not change TODAY\'s verdicts: an idempotent apply is still `none`', () => {
  const sel = selectRevisionOverwrite([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 0),
    rev('r2', '2026-08-19T07:20:00Z', AUG19_APPLIED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'none');
});

test('a serving read that is UNKNOWN fails the WHOLE verdict closed, even with a clean Actions API', () => {
  const sel = selectRevisionOverwrite([
    rev('r1', '2026-08-19T07:00:00Z', AUG19_APPLIED, 50),
    rev('r2', '2026-08-19T07:20:00Z', AUG19_ROLLED, 50),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  const verdict = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: sel,
  });
  assert.equal(verdict.verdict, 'unknown', 'an unestablished live image must never be spent as "nothing happened"');
});

test('R7: the verdict names the SERVING image when it disagrees with the app template', () => {
  // `az containerapp show` returns the TEMPLATE image — the last write. Under a
  // weight-0 write that is the other lane's tag while the estate serves ours,
  // and a message naming only the template would assert the wrong live image.
  const sel = selectRevisionOverwrite([
    rev('loom-console--0000783', '2026-08-19T07:10:19+00:00', AUG19_APPLIED, 100),
    rev('loom-console--0000784', '2026-08-19T07:20:00+00:00', AUG19_ROLLED, 0),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  const verdict = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_ROLLED, // the template moved; the traffic did not
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: sel,
  });
  assert.equal(verdict.verdict, 'drifted');
  assert.match(verdict.reason, /is SERVING '/, 'it must say what is SERVING');
  assert.match(verdict.reason, /template names '/, 'and disclose that the template says something else');
});

test('a window with nothing but our own tag is `none` — an idempotent apply is not a revert', () => {
  const sel = selectRevisionOverwrite([
    rev('r0', '2026-08-19T05:46:46Z', AUG19_ROLLED, 0),
    rev('r1', '2026-08-19T07:10:19Z', AUG19_APPLIED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'none', 'r0 is BEFORE the measurement, so it is outside the window by construction');
});

test('no revision created in the window at all is `none`, and says why', () => {
  const sel = selectRevisionOverwrite(AUG19_REVISIONS_WEIGHTED.slice(0, 1), {
    measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED,
  });
  assert.equal(sel.status, 'none');
  assert.match(sel.reason, /no loom-console revision was created at or after/);
});

test('the window bound is INCLUSIVE — a revision in the measurement second is not silently outside', () => {
  const sel = selectRevisionOverwrite([
    rev('r1', AUG19_MEASURED_AT, AUG19_ROLLED, 0),
    rev('r2', '2026-08-19T07:10:19Z', AUG19_APPLIED, 100),
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'overwritten', 'measured_at has second resolution; an exclusive bound would hide this');
  assert.equal(sel.overwrittenTag, AUG19_ROLLED);
});

test('an UNREADABLE revision history is UNKNOWN, never "nothing happened"', () => {
  const sel = selectRevisionOverwrite(null, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /could not look/);
});

test('a revision list that is not an array is UNKNOWN, not an empty history', () => {
  const sel = selectRevisionOverwrite({ error: 'nope' }, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /changed shape/);
});

test('NIT-3 FLIP: the incident payload with trafficWeight NULLED must not go green — it fails CLOSED', () => {
  // The whole state is identical to THE 2026-08-19 MISS except that every
  // `trafficWeight` is absent. The first draft of #3798 fell back to recency
  // here and produced `ahead`, which the Actions-API `none` then rendered as a
  // green OK — with nothing in the log saying a fallback had happened, because
  // the OK message on that path never interpolates the revision reason. So the
  // "disclosed fallback" was not disclosed, and the safeguard was the defect.
  const sel = selectRevisionOverwrite(AUG19_REVISIONS, {
    measuredAt: AUG19_MEASURED_AT,
    appliedTag: AUG19_APPLIED,
  });
  assert.equal(sel.status, 'unknown', `an unweighted payload establishes no live image; got ${sel.status}`);

  const verdict = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll([]), // the empty listing, as on the night
    revisionSelection: sel,
  });
  assert.equal(
    verdict.verdict, 'unknown',
    'and a quiet Actions API must not turn that into OK — this is the exact flip that made the fallback unsafe',
  );
});

test('NIT-3 FLIP, through the real CLI: unweighted revisions exit 1 and request no heal', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', `acrloom.azurecr.io/loom-console:${AUG19_APPLIED}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
      '--heal-request', 'heal.txt',
    ],
    { files: { 'rolls.json': [], 'revs.json': AUG19_REVISIONS } },
  );
  assert.equal(r.code, 1, 'the pre-fix code exited 0 on this exact input');
  assert.match(r.logs, /UNKNOWN, which fails closed/);
  assert.match(r.logs, /carries a trafficWeight/, 'and it names the missing field rather than failing vaguely');
  assert.ok(!('heal.txt' in r.written));
});

test('CLI serving-tag: an UNWEIGHTED payload is not "the newest one" either — exit 1', () => {
  const r = runCli(['serving-tag', '--revisions', 'revs.json', '--out', 'serving.txt'], {
    files: { 'revs.json': AUG19_REVISIONS },
  });
  assert.equal(r.code, 1, 'both callers of selectServingRevision must fail closed on the same status');
  assert.equal(r.written['serving.txt'], '');
});

test('an unbounded window (no measured-at) is UNKNOWN — it proves nothing either way', () => {
  const sel = selectRevisionOverwrite(AUG19_REVISIONS, { measuredAt: '', appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /cannot be bounded/);
});

test('a revision that cannot be PLACED in time is UNKNOWN, never "outside the window"', () => {
  const sel = selectRevisionOverwrite([
    { name: 'r1', createdTime: null, image: `acr1.azurecr.io/loom-console:${AUG19_ROLLED}` },
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /cannot be placed inside or outside/);
});

test('a DIGEST-PINNED revision inside the window is UNKNOWN — a digest does not name a commit', () => {
  const sel = selectRevisionOverwrite([
    { name: 'r1', createdTime: '2026-08-19T07:04:56Z', image: 'acr1.azurecr.io/loom-console@sha256:abc123' },
    { name: 'r2', createdTime: '2026-08-19T07:10:19Z', image: `acr1.azurecr.io/loom-console:${AUG19_APPLIED}` },
  ], { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED });
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /digest-pinned/);
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — an unreadable SECOND source must not discard a definite FIRST
// one (#3797). Both paths exit 1, so nothing unsafe ever shipped; what the
// early return threw away was the operator's next action — the roll-forward
// SHA — on the one run where a second, independent source HAD answered.
// ---------------------------------------------------------------------------

/** The real incident, seen through the Actions API alone. */
const AUG19_ROLL_RUNS = [{
  id: 32225337320,
  workflow: 'loom-roll-and-validate.yml',
  title: `roll ${AUG19_ROLLED} (build-triggered)`,
  completedAt: '2026-08-19T07:11:02Z',
  jobCompletedAt: '2026-08-19T07:10:44Z',
  jobConclusion: 'success',
}];

test('#3797: a definite Actions-API regression SURVIVES an unreadable revision history, with its SHA', () => {
  const v = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll(AUG19_ROLL_RUNS),
    revisionSelection: selectRevisionOverwrite(null, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED }),
  });
  assert.equal(v.verdict, 'regression', 'the regression was ESTABLISHED by a source that answered; losing it loses the remediation');
  assert.equal(v.rollForwardTo, AUG19_ROLLED, 'and the roll-forward SHA must survive with it');
  assert.match(v.reason, /THE ESTATE WENT BACKWARDS/);
  assert.match(
    v.reason, /could NOT be used on this run/,
    'the failed revision read is NAMED, not dropped — absence of one source is stated (deploy-integrity R7)',
  );
});

test('MUTATION CONTROL for #3797: the same unreadable history with a CLEAN Actions API stays UNKNOWN', () => {
  const v = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: selectRevisionOverwrite(null, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED }),
  });
  assert.equal(
    v.verdict, 'unknown',
    'CONTROL: only a definite REGRESSION may survive the unreadable read. If an `ok` could too, an unreadable ' +
      'estate would be laundered green by a quiet Actions API — the exact collapse #3676 turns on.',
  );
});

// ---------------------------------------------------------------------------
// ESTATE-WIDE (#3676) — the population, the roll-up, and the dispatch plan.
//
// These three functions are what turn a one-app gate into a twenty-app one, so
// each is tested on the states the workflow cannot cheaply reproduce: an
// unreadable list, an app nothing is running yet, an app no lane can roll.
// ---------------------------------------------------------------------------

const listAt = (pairs) => pairs.map(([name, repo, tag]) => ({ name, image: `acr1.azurecr.io/${repo}:${tag}` }));

test('selectWatchedApps derives the population from the PINS x the live list, not from a hand-kept table', () => {
  const sel = selectWatchedApps({
    containers: listAt([
      ['loom-console', 'loom-console', ROLLED],
      ['loom-mirroring', 'loom-mirroring', '0.80.0'],
      ['loom-mcp', 'loom-mcp', '0.80.0'],
    ]),
    pinned: { console: ROLLED, mirroring: '0.80.0' },
  });
  assert.equal(sel.status, 'ok');
  assert.deepEqual(sel.apps.map((a) => a.app), ['loom-console', 'loom-mirroring']);
  assert.deepEqual(
    sel.unwatched.map((u) => u.app), ['loom-mcp'],
    'an app running a repository this run pinned nothing for is REPORTED out of scope, never dropped silently',
  );
});

test('selectWatchedApps: an UNREADABLE list is UNKNOWN — it is not an estate with no apps in it', () => {
  for (const bad of [null, undefined, 'not json', { name: 'x' }]) {
    const sel = selectWatchedApps({ containers: bad, pinned: { console: ROLLED } });
    assert.equal(sel.status, 'unknown', `containers=${JSON.stringify(bad)} must be UNKNOWN`);
    assert.deepEqual(sel.apps, [], 'and it must compare nothing rather than compare an invented empty population');
    assert.match(sel.reason, /could not be read as a JSON array/);
  }
});

test('selectWatchedApps: a pinned repo nothing is running yet is CREATED, not compared', () => {
  // The apply WRITES this tag, but writing it creates the app. A creation
  // cannot have overwritten another writer, so folding it into `apps` would
  // manufacture an UNKNOWN every time a new app lands.
  const sel = selectWatchedApps({
    containers: listAt([['loom-console', 'loom-console', ROLLED]]),
    pinned: { console: ROLLED, duckdb: '0.1.0' },
  });
  assert.equal(sel.status, 'ok');
  assert.deepEqual(sel.apps.map((a) => a.app), ['loom-console']);
  assert.deepEqual(sel.created.map((c) => c.repo), ['loom-duckdb']);
});

test('decideEstateRegressionAll: precedence is regression > drifted > unknown > ok, so the SHA is never buried', () => {
  const all = decideEstateRegressionAll([
    { app: 'loom-console', verdict: 'unknown', reason: 'u' },
    { app: 'loom-mirroring', verdict: 'regression', reason: 'r', rollForwardTo: AUG19_ROLLED },
  ]);
  assert.equal(
    all.verdict, 'regression',
    'all four failing states exit 1 identically; what differs is the NEXT ACTION. Letting an unrelated app\'s ' +
      'unknown outrank a regression throws away the only verdict that carries a roll-forward SHA.',
  );
  assert.deepEqual(all.failing.map((f) => f.app).sort(), ['loom-console', 'loom-mirroring'],
    'and every failing app is still carried out — the headline must not hide the others');
});

test('decideEstateRegressionAll: ALL ok is ok, and an EMPTY population says so rather than implying health', () => {
  const ok = decideEstateRegressionAll([
    { app: 'loom-console', verdict: 'ok', reason: 'o' },
    { app: 'loom-mirroring', verdict: 'ok', reason: 'o' },
  ]);
  assert.equal(ok.verdict, 'ok');
  assert.deepEqual(ok.failing, []);
  const none = decideEstateRegressionAll([]);
  assert.equal(none.verdict, 'ok');
  assert.match(none.reason, /\S/, 'an empty comparison must still SAY it compared nothing');
});

test('buildHealRequests routes each app to the lane that can actually roll IT — console vs data plane', () => {
  const reqs = buildHealRequests([
    { app: 'loom-console', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
    { app: 'loom-unity', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
  ]);
  const byWf = Object.fromEntries(reqs.map((r) => [r.workflow, r]));
  assert.equal(byWf['loom-roll-and-validate.yml'].kind, 'console');
  assert.deepEqual(byWf['loom-roll-and-validate.yml'].apps, ['loom-console']);
  assert.equal(byWf['loom-dataplane-roll.yml'].kind, 'dataplane');
  assert.deepEqual(byWf['loom-dataplane-roll.yml'].apps, ['loom-unity']);
  for (const r of reqs) assert.equal(r.sha, AUG19_ROLLED);
});

test('buildHealRequests: an app with NO lane gets workflow:null and a stated reason — never a mis-aimed dispatch', () => {
  const [req] = buildHealRequests([
    { app: 'loom-mirroring', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
  ]);
  assert.equal(
    req.workflow, null,
    'loom-roll-and-validate hard-codes APP_NAME: loom-console. Dispatching it for loom-mirroring would roll the ' +
      'CONSOLE and report a healed estate — a false receipt is worse than an admitted gap.',
  );
  assert.match(req.why, /NO automated roll lane exists/);
  assert.deepEqual(req.apps, ['loom-mirroring']);
});

test('buildHealRequests: only a definite regression carrying a 40-hex SHA may ever reach a dispatch', () => {
  const reqs = buildHealRequests([
    { app: 'loom-console', verdict: 'ok', rollForwardTo: AUG19_ROLLED },
    { app: 'loom-unity', verdict: 'drifted', rollForwardTo: AUG19_ROLLED },
    { app: 'loom-trino', verdict: 'unknown', rollForwardTo: AUG19_ROLLED },
    { app: 'iceberg-catalog', verdict: 'regression', rollForwardTo: 'latest' },
  ]);
  assert.deepEqual(
    reqs, [],
    'a floating tag cannot be validated against a build marker (#2963), and a non-regression verdict names no ' +
      'direction — rolling to a guessed SHA could move a HEALTHY estate backwards',
  );
});

test('buildHealRequests groups apps that share one lane AND one SHA into a SINGLE dispatch', () => {
  // loom-unity and loom-trino are rolled by the same lane, which takes a comma
  // list. Two dispatches would race each other on the same Container Apps.
  const reqs = buildHealRequests([
    { app: 'loom-unity', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
    { app: 'loom-trino', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
  ]);
  assert.equal(reqs.length, 1, JSON.stringify(reqs));
  assert.deepEqual(reqs[0].apps, ['loom-trino', 'loom-unity']);
  assert.equal(reqs[0].boundary, 'commercial', 'the boundary travels with the request — the sovereign lanes reuse this (#3683)');
});

test('buildHealRequests: the SAME lane at DIFFERENT SHAs stays two dispatches, never one merged guess', () => {
  const reqs = buildHealRequests([
    { app: 'loom-unity', verdict: 'regression', rollForwardTo: AUG19_ROLLED },
    { app: 'loom-trino', verdict: 'regression', rollForwardTo: ROLLED },
  ]);
  assert.equal(reqs.length, 2, `two SHAs cannot be collapsed into one roll: ${JSON.stringify(reqs)}`);
});

test('MUTATION CONTROL for #3797: a DRIFTED Actions verdict does not survive it either — no direction is claimed', () => {
  const v = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: 'ffffffffffffffffffffffffffffffffffffffff', // neither the roll nor ours
    rollSelection: selectLastConsoleRoll(AUG19_ROLL_RUNS),
    revisionSelection: selectRevisionOverwrite(null, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED }),
  });
  assert.equal(v.verdict, 'unknown', 'drifted names no rollback target, so promoting it here would name one anyway');
});

test('revision UNKNOWN fails the whole verdict closed, even when the Actions API is happy', () => {
  const v = decideEstateRegression({
    appliedTag: AUG19_APPLIED,
    estateTag: AUG19_APPLIED,
    rollSelection: selectLastConsoleRoll([]),
    revisionSelection: selectRevisionOverwrite(null, { measuredAt: AUG19_MEASURED_AT, appliedTag: AUG19_APPLIED }),
  });
  assert.equal(v.verdict, 'unknown', 'an Actions-API "nothing to see" must not launder an unreadable estate');
});

test('the revision read is STRICTLY ADDITIVE — it cannot turn an Actions-API regression green', () => {
  const rollSelection = selectLastConsoleRoll([
    {
      id: 1, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
    },
  ]);
  // The revision source sees a clean window (it was told a different applied
  // tag than the estate is running), yet the Actions comparison still fails.
  const v = decideEstateRegression({
    appliedTag: STALE,
    estateTag: STALE,
    rollSelection,
    revisionSelection: { status: 'none', reason: 'nothing in this window.' },
  });
  assert.equal(v.verdict, 'regression', 'the pre-existing comparison must keep its teeth');
});

test('R7: the Actions-API "none" verdict no longer asserts a fact about the ESTATE', () => {
  const sel = selectLastConsoleRoll([]);
  assert.equal(sel.status, 'none');
  assert.match(
    sel.reason, /Actions API listed/,
    'the claim must be scoped to what was actually read — a listing — not to what the estate did',
  );
  assert.doesNotMatch(
    sel.reason, /nothing this deploy wrote could have overwritten a newer image\.$/,
    'the old wording asserted an estate-wide fact from an API listing, and that sentence was FALSE on 2026-08-19',
  );
});

test('the estate ON the last roll SHA passes', () => {  const sel = selectLastConsoleRoll([
    {
      id: 1, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
    },
  ]);
  const v = decideEstateRegression({ appliedTag: ROLLED, estateTag: ROLLED, rollSelection: sel });
  assert.equal(v.verdict, 'ok');
});

test('no roll finished in the window -> ok (nothing could have been overwritten)', () => {
  const v = decideEstateRegression({
    appliedTag: STALE, estateTag: STALE, rollSelection: selectLastConsoleRoll([]),
  });
  assert.equal(v.verdict, 'ok');
});

test('an UNREADABLE running image is UNKNOWN, and UNKNOWN is not a pass', () => {
  const v = decideEstateRegression({
    appliedTag: STALE,
    estateTag: null,
    estateReadError: 'ResourceNotFound',
    rollSelection: selectLastConsoleRoll([]),
  });
  assert.equal(v.verdict, 'unknown');
  assert.match(v.reason, /ResourceNotFound/);
  assert.match(v.reason, /equally not established that it did not/);
});

test('an UNREADABLE roll history is UNKNOWN even when the estate reads fine', () => {
  const v = decideEstateRegression({
    appliedTag: STALE, estateTag: STALE, rollSelection: selectLastConsoleRoll(null),
  });
  assert.equal(v.verdict, 'unknown');
});

test('ONE run whose jobs could not be read poisons the whole selection (fail closed)', () => {
  const sel = selectLastConsoleRoll([
    {
      id: 1, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
    },
    {
      id: 2, workflow: 'loom-roll-and-validate.yml', title: 'roll 66bb26e705a17796d639a9752990c6e70ab96c35 (build-triggered)',
      completedAt: '2026-08-17T07:35:30Z', jobConclusion: null,
    },
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /could not be read/);
});

test('a floating-tag roll (`latest`) is UNKNOWN, never compared as if it were a SHA', () => {
  const sel = selectLastConsoleRoll([
    {
      id: 3, workflow: 'loom-roll-and-validate.yml', title: 'roll latest (manual dispatch)',
      completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
    },
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /floating tag/);
});

test('full-app-deploy-commercial is in the population, keyed off head_sha, so it is not a false RED', () => {
  const OTHER = '184e5ed3'.padEnd(40, '0');
  const sel = selectLastConsoleRoll([
    {
      id: 4, workflow: 'loom-roll-and-validate.yml', title: `roll ${STALE} (build-triggered)`,
      completedAt: '2026-08-17T07:00:00Z', jobConclusion: 'success',
    },
    {
      id: 5, workflow: 'full-app-deploy-commercial.yml', title: 'full-app-deploy-commercial',
      headSha: OTHER, completedAt: '2026-08-17T07:20:00Z', jobConclusion: 'success',
    },
  ]);
  assert.equal(sel.status, 'found');
  assert.equal(sel.roll.sha, OTHER, 'the LATEST writer decides, whichever lane it was');
  assert.equal(decideEstateRegression({ appliedTag: OTHER, estateTag: OTHER, rollSelection: sel }).verdict, 'ok');
});

test('a writer this file does not know about is UNKNOWN, not a pass', () => {
  const sel = selectLastConsoleRoll([
    { id: 6, workflow: 'some-other-lane.yml', title: 'x', completedAt: '2026-08-17T07:20:00Z', jobConclusion: 'success' },
  ]);
  assert.equal(sel.status, 'unknown');
  assert.match(sel.reason, /CONSOLE_ROLL_SOURCES/);
});

test('a run that applied NO console tag cannot have regressed, and says why', () => {
  const v = decideEstateRegression({ appliedTag: '', estateTag: STALE, rollSelection: selectLastConsoleRoll(null) });
  assert.equal(v.verdict, 'ok');
  assert.match(v.reason, /applied no loom-console image tag/);
});

test('an unattributable estate tag is DRIFTED, not "went backwards", and names no rollback target', () => {
  // The realistic producer: a roll whose `az containerapp update` landed after
  // the apply but whose RUN has not completed, so it is not in the population.
  // The estate is then AHEAD. Calling that a regression and printing "roll to
  // <last completed roll>" would move a healthy estate BACKWARDS — the gate
  // causing the defect it exists to catch.
  const sel = selectLastConsoleRoll([
    {
      id: 7, workflow: 'loom-roll-and-validate.yml', title: `roll ${STALE} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobCompletedAt: '2026-08-17T07:10:44Z', jobConclusion: 'success',
    },
  ]);
  const v = decideEstateRegression({ appliedTag: 'aaaa'.padEnd(40, '0'), estateTag: ROLLED, rollSelection: sel });
  assert.equal(v.verdict, 'drifted');
  assert.doesNotMatch(v.reason, /WENT BACKWARDS/, 'no direction may be asserted for a state it cannot attribute');
  assert.match(v.reason, /NO DIRECTION IS BEING CLAIMED/);
  assert.equal(v.rollForwardTo, undefined, 'a drifted verdict must not carry a rollback target');
});

test('the CLI prints a rollback target ONLY for an attributable regression', () => {
  const rolls = [{
    id: 8, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
    completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
  }];
  // A window the REVISION source reads as clean, so this test still exercises
  // the Actions-API attribution path it was written for rather than the new one.
  const revs = [rev('r1', '2026-08-17T07:19:48Z', STALE, 100)];
  const regression = runCli(
    ['assert-estate-not-behind-roll', '--applied-tag', STALE, '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acr.azurecr.io/loom-console:${STALE}`, '--rolls', 'r.json', '--revisions', 'v.json'],
    { files: { 'r.json': rolls, 'v.json': revs } },
  );
  assert.equal(regression.code, 1);
  assert.match(regression.logs, new RegExp(`image_tag=${ROLLED}`),
    'an attributable regression names the exact SHA to roll forward to');

  const drifted = runCli(
    ['assert-estate-not-behind-roll', '--applied-tag', STALE, '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acr.azurecr.io/loom-console:${'c'.repeat(40)}`, '--rolls', 'r.json', '--revisions', 'v.json'],
    { files: { 'r.json': rolls, 'v.json': revs } },
  );
  assert.equal(drifted.code, 1, 'drift still fails closed');
  assert.match(drifted.logs, /ESTATE DRIFT/);
  assert.doesNotMatch(drifted.logs, /image_tag=/,
    'drift must name NO rollback target — the estate may be ahead, and rolling to the last completed roll ' +
      'would move it backwards');
});

test('selectLastConsoleRoll orders by the JOB completion, not the run finishing', () => {
  // On the incident night the roll's image write and its run completion were
  // 4m45s apart (update 07:10:44, run done 07:15:30). Ordering by the run can
  // therefore name the wrong "latest" when two writers finish close together.
  const sel = selectLastConsoleRoll([
    {
      id: 'wrote-last', workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
      completedAt: '2026-08-17T07:15:30Z', jobCompletedAt: '2026-08-17T07:14:00Z', jobConclusion: 'success',
    },
    {
      id: 'finished-last', workflow: 'loom-roll-and-validate.yml', title: `roll ${STALE} (build-triggered)`,
      completedAt: '2026-08-17T07:16:00Z', jobCompletedAt: '2026-08-17T07:10:44Z', jobConclusion: 'success',
    },
  ]);
  assert.equal(sel.status, 'found');
  assert.equal(sel.roll.id, 'wrote-last',
    'the run that finished last is not necessarily the one that WROTE last');
});

test('selectLastConsoleRoll falls back to the run time when no job time is supplied', () => {
  const sel = selectLastConsoleRoll([
    { id: 'a', workflow: 'loom-roll-and-validate.yml', title: `roll ${STALE} (build-triggered)`, completedAt: '2026-08-17T07:00:00Z', jobConclusion: 'success' },
    { id: 'b', workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`, completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success' },
  ]);
  assert.equal(sel.roll.id, 'b', 'a caller that cannot supply the job time must still get an answer');
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — the REAL CLI, driven end to end through files
// ---------------------------------------------------------------------------

/** Drive cliMain with a temp dir, capturing everything it would write. */
function runCli(argv, { env = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-race-'));
  try {
    const paths = {};
    for (const [name, body] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], typeof body === 'string' ? body : JSON.stringify(body));
    }
    const logs = [];
    const envLines = [];
    const outLines = [];
    /** path -> contents, for the files the CLI writes rather than appends. */
    const written = {};
    const resolved = argv.map((a) => (paths[a] ? paths[a] : a));
    const code = cliMain(resolved, {
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, body) => { written[p] = body; },
      writeEnv: (l) => envLines.push(l),
      writeOutput: (l) => outLines.push(l),
      log: (s) => logs.push(s),
      env,
    });
    return { code, logs: logs.join('\n'), envLines, outLines, written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI pin-refresh: the incident state exports the RUNNING tag to $GITHUB_ENV', () => {
  const r = runCli(
    ['pin-refresh', '--deploy-apps-enabled', 'true', '--containers', 'c.json'],
    {
      // The environment a real run carries: reconcile-resolve.mjs exported a
      // pin for every app it found running, and only the console has moved.
      env: { LOOM_CONSOLE_TAG: STALE, LOOM_MCP_TAG: '0.80.0', LOOM_UNITY_TAG: '0.80.0' },
      files: { 'c.json': estateAt(ROLLED) },
    },
  );
  assert.equal(r.code, 0);
  assert.ok(
    r.envLines.includes(`LOOM_CONSOLE_TAG=${ROLLED}`),
    `expected a re-pin to ${ROLLED}; got ${JSON.stringify(r.envLines)}`,
  );
  assert.ok(
    r.envLines.includes('LOOM_MCP_TAG=0.80.0'),
    'every pin is re-emitted, not only the moved one — a later $GITHUB_ENV write is what the apply reads',
  );
  assert.ok(r.outLines.includes(`console_tag=${ROLLED}`));
  assert.ok(
    r.outLines.includes('drift_count=1'),
    `exactly one image moved; got ${JSON.stringify(r.outLines)}`,
  );
  assert.match(r.logs, /::warning::\[pin-refresh\] MOVED loom-console/);
});

// ---------------------------------------------------------------------------
// #4240 — the follower note has to reach a LOG, not merely a return value.
// pin-refresh is the live consumer (deploy-fiab-commercial step 27, and the
// same command on the GCC-High / IL5 lanes), so the CLI is where it is proven.
// The control arm below is what makes the assertion falsifiable: same command,
// same env, follower converged, and the ONLY difference must be the note.
// ---------------------------------------------------------------------------

/** The unity pair mid-roll, alongside the rest of the estate. */
const estateWithFollowerAt = (icebergTag) => [
  ...estateAt(ROLLED).filter((c) => c.name !== 'loom-unity'),
  { name: 'loom-unity', image: `acr1.azurecr.io/loom-unity:${ROLLED}` },
  { name: 'iceberg-catalog', image: `acr1.azurecr.io/loom-unity:${icebergTag}` },
];

const PIN_ENV = { LOOM_CONSOLE_TAG: ROLLED, LOOM_MCP_TAG: '0.80.0', LOOM_UNITY_TAG: ROLLED };

test('#4240 CLI pin-refresh: a follower off the canonical tag LOGS a FOLLOWER note, and the run still proceeds', () => {
  const r = runCli(
    ['pin-refresh', '--deploy-apps-enabled', 'true', '--containers', 'c.json'],
    { env: PIN_ENV, files: { 'c.json': estateWithFollowerAt('0.80.0') } },
  );
  assert.equal(r.code, 0, 'an observation must never change the exit code');
  assert.match(r.logs, /::notice::\[pin-refresh\] FOLLOWER /, 'the divergence must reach the run log');
  assert.match(r.logs, /iceberg-catalog runs loom-unity:0\.80\.0/, 'naming the app and the ref it actually runs');
  assert.ok(
    r.envLines.includes(`LOOM_UNITY_TAG=${ROLLED}`),
    `the pin still follows the canonical; got ${JSON.stringify(r.envLines)}`,
  );
});

test('#4240 CONTROL CLI: the SAME command with the follower CONVERGED logs no FOLLOWER line, and everything else matches', () => {
  const diverged = runCli(
    ['pin-refresh', '--deploy-apps-enabled', 'true', '--containers', 'c.json'],
    { env: PIN_ENV, files: { 'c.json': estateWithFollowerAt('0.80.0') } },
  );
  const converged = runCli(
    ['pin-refresh', '--deploy-apps-enabled', 'true', '--containers', 'c.json'],
    { env: PIN_ENV, files: { 'c.json': estateWithFollowerAt(ROLLED) } },
  );
  assert.doesNotMatch(converged.logs, /FOLLOWER/, 'a converged pair must produce no note at all');
  assert.equal(converged.code, diverged.code, 'the note moves no exit code');
  assert.deepEqual(converged.envLines, diverged.envLines, 'the note moves no $GITHUB_ENV write');
  assert.deepEqual(converged.outLines, diverged.outLines, 'the note moves no step output');
  assert.equal(
    diverged.logs.replace(/^.*FOLLOWER.*$/gm, '').trim(),
    converged.logs.trim(),
    'strip the FOLLOWER line and the two runs must log identically — the note adds, it does not alter',
  );
});

test('CLI pin-refresh: --read-error exits 1 and exports NOTHING', () => {
  const r = runCli(['pin-refresh', '--deploy-apps-enabled', 'true', '--read-error', 'AuthorizationFailed'], {
    env: { LOOM_CONSOLE_TAG: STALE },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.envLines, []);
  assert.match(r.logs, /::error::PIN REFRESH REFUSED/);
});

test('CLI pin-refresh: a containers file that is not a JSON array is a REFUSAL, not an empty estate', () => {
  const r = runCli(['pin-refresh', '--deploy-apps-enabled', 'true', '--containers', 'c.json'], {
    env: { LOOM_CONSOLE_TAG: STALE }, files: { 'c.json': '{"error":"nope"}' },
  });
  assert.equal(r.code, 1);
  assert.match(r.logs, /did not contain a JSON array/);
});

test('CLI pin-refresh: neither source supplied is a USAGE error (2), never a silent pass', () => {
  const r = runCli(['pin-refresh', '--deploy-apps-enabled', 'true']);
  assert.equal(r.code, 2);
  assert.match(r.logs, /exactly one of --containers/);
});

test('CLI assert-estate-not-behind-roll: the incident exits 1 with an actionable remediation', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', STALE,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acrloom.azurecr.io/loom-console:${STALE}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
    ],
    {
      files: {
        'rolls.json': [{
          id: 32004219673, workflow: 'loom-roll-and-validate.yml',
          title: `roll ${ROLLED} (build-triggered)`,
          completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
        }],
        'revs.json': [
          rev('loom-console--0000755', '2026-08-17T07:10:56Z', ROLLED, 0),
          rev('loom-console--0000756', '2026-08-17T07:19:48Z', STALE, 100),
        ],
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.logs, /::error::ESTATE REGRESSION \(#3676\)/);
  assert.match(r.logs, /REMEDIATION: dispatch/);
  assert.match(r.logs, /loom-roll-and-validate\.yml with image_tag/);
});

test('CLI assert-estate-not-behind-roll: neither revision flag is a USAGE error (2), never a silent pass', () => {
  // Omitting them would silently restore the Actions-API-only comparison that
  // reported OK across the 2026-08-19 revert. It must not be a default.
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', STALE,
      '--estate-image', `acrloom.azurecr.io/loom-console:${STALE}`,
      '--rolls', 'rolls.json',
    ],
    { files: { 'rolls.json': [] } },
  );
  assert.equal(r.code, 2, 'a missing evidence source is a usage error, not an assumption');
  assert.match(r.logs, /exactly one of --revisions/);
});

test('CLI assert-estate-not-behind-roll: a digest-pinned console is UNKNOWN (exit 1), not OK', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', STALE,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', 'acrloom.azurecr.io/loom-console@sha256:' + 'b'.repeat(64),
      '--rolls', 'rolls.json',
      '--revisions-error', 'not reached',
    ],
    { files: { 'rolls.json': [] } },
  );
  assert.equal(r.code, 1);
  assert.match(r.logs, /digest-pinned/);
});

test('CLI assert-estate-not-behind-roll: the healthy path exits 0 and states what it compared', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', ROLLED,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
    ],
    {
      files: {
        'rolls.json': [{
          id: 1, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
          completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
        }],
        'revs.json': [
          rev('loom-console--0000755', '2026-08-17T07:10:56Z', ROLLED, 100),
        ],
      },
    },
  );
  assert.equal(r.code, 0);
  assert.match(r.logs, /::notice::estate-vs-roll: OK/);
  assert.match(r.logs, new RegExp(ROLLED));
});

test('CLI assert-estate-not-behind-roll: --rolls-error fails closed (exit 1)', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', ROLLED,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
      '--rolls-error', 'HTTP 403',
      '--revisions', 'revs.json',
    ],
    {
      files: {
        'revs.json': [
          rev('loom-console--0000755', '2026-08-17T07:10:56Z', ROLLED, 100),
        ],
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.logs, /UNKNOWN, which fails closed/);
  assert.match(r.logs, /HTTP 403/);
});

test('CLI assert-estate-not-behind-roll: --revisions-error fails closed even when the Actions API is clean', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', ROLLED,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
      '--rolls', 'rolls.json',
      '--revisions-error', 'az containerapp revision list exited 1: AuthorizationFailed',
    ],
    { files: { 'rolls.json': [] } },
  );
  assert.equal(r.code, 1, 'an unreadable estate history must not be laundered by a quiet Actions API');
  assert.match(r.logs, /UNKNOWN, which fails closed/);
  assert.match(r.logs, /AuthorizationFailed/, 'the refusal must quote the control plane, not invent a cause (R7)');
});

test('CLI #3797: --revisions-error over the REAL regression still prints the roll-forward SHA', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', `acrloom.azurecr.io/loom-console:${AUG19_APPLIED}`,
      '--rolls', 'rolls.json',
      '--revisions-error', 'az containerapp revision list exited 1: AuthorizationFailed',
      '--heal-request', 'heal.txt',
    ],
    { files: { 'rolls.json': AUG19_ROLL_RUNS } },
  );
  assert.equal(r.code, 1, 'fail-closed is unchanged — this is about WHICH failure is reported');
  assert.match(r.logs, /ESTATE REGRESSION \(#3676\)/);
  assert.match(r.logs, new RegExp(`image_tag=${AUG19_ROLLED}`), 'the operator gets the roll-forward SHA, not "I could not look"');
  assert.match(r.logs, /AuthorizationFailed/, 'and the source that FAILED is named in the same message');
  assert.equal(r.written['heal.txt'], `${AUG19_ROLLED}\n`, 'a definite regression is healable even when one source was down');
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — the auto-heal HAND-OFF (#3799). The request file is the only
// thing that makes the next step act, so what writes it — and what does NOT —
// is the whole safety property.
// ---------------------------------------------------------------------------

test('CLI #3799: a definite regression leaves the roll-forward SHA where the heal step reads it', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', `acrloom.azurecr.io/loom-console:${AUG19_APPLIED}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
      '--heal-request', 'heal.txt',
    ],
    { files: { 'rolls.json': [], 'revs.json': AUG19_REVISIONS_WEIGHTED } },
  );
  assert.equal(r.code, 1, 'auto-heal must never turn the detection green');
  assert.equal(r.written['heal.txt'], `${AUG19_ROLLED}\n`);
  assert.ok(r.outLines.includes(`roll_forward_to=${AUG19_ROLLED}`));
  assert.ok(r.outLines.includes('verdict=regression'));
});

test('CLI #3799 MUTATION CONTROL: a HEALTHY run requests no heal at all', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', ROLLED,
      '--measured-at', '2026-08-17T07:03:40Z',
      '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
      '--heal-request', 'heal.txt',
    ],
    {
      files: {
        'rolls.json': [],
        'revs.json': [rev('r1', '2026-08-17T07:10:00Z', ROLLED, 100)],
      },
    },
  );
  assert.equal(r.code, 0);
  assert.ok(!('heal.txt' in r.written), 'nothing to heal, nothing written — the heal step must not fire on a green run');
  assert.ok(r.outLines.includes('verdict=ok'));
});

test('CLI #3799: UNKNOWN and DRIFTED request nothing — only a definite verdict may dispatch', () => {
  const unknown = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', `acrloom.azurecr.io/loom-console:${AUG19_APPLIED}`,
      '--rolls-error', 'gh: HTTP 403',
      '--revisions-error', 'az: AuthorizationFailed',
      '--heal-request', 'heal.txt',
    ],
  );
  assert.equal(unknown.code, 1);
  assert.ok(!('heal.txt' in unknown.written), 'an UNKNOWN establishes nothing, so it may not dispatch a roll');

  const drifted = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', 'acrloom.azurecr.io/loom-console:ffffffffffffffffffffffffffffffffffffffff',
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
      '--heal-request', 'heal.txt',
    ],
    {
      files: {
        'rolls.json': AUG19_ROLL_RUNS,
        'revs.json': [rev('r1', '2026-08-19T07:20:00Z', 'ffffffffffffffffffffffffffffffffffffffff', 100)],
      },
    },
  );
  assert.equal(drifted.code, 1);
  assert.ok(
    !('heal.txt' in drifted.written),
    'DRIFTED claims no direction on purpose — rolling to a guessed SHA could move a HEALTHY estate backwards, ' +
      'which is the gate causing the defect it exists to catch',
  );
});

test('CLI #3799: a non-SHA roll-forward target is REFUSED as a dispatch, loudly, not written anyway', () => {
  // A floating tag can reach `overwrittenTag` from a revision list (an operator
  // rolled `:latest`). It is a real overwrite and must still go red — but a roll
  // dispatched at a name that is not a commit cannot be validated (#2963).
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', AUG19_APPLIED,
      '--measured-at', AUG19_MEASURED_AT,
      '--estate-image', `acrloom.azurecr.io/loom-console:${AUG19_APPLIED}`,
      '--rolls', 'rolls.json',
      '--revisions', 'revs.json',
      '--heal-request', 'heal.txt',
    ],
    {
      files: {
        'rolls.json': [],
        'revs.json': [
          rev('r1', '2026-08-19T07:04:56Z', 'latest', 0),
          rev('r2', '2026-08-19T07:10:19Z', AUG19_APPLIED, 100),
        ],
      },
    },
  );
  assert.equal(r.code, 1, 'still a regression, still red');
  assert.ok(!('heal.txt' in r.written), 'but not dispatchable');
  assert.match(r.logs, /not a 40-hex commit SHA/);
});

test('CLI serving-tag: resolves what the estate SERVES, and writes an EMPTY file when it cannot', () => {
  const ok = runCli(['serving-tag', '--revisions', 'revs.json', '--out', 'serving.txt'], {
    files: { 'revs.json': AUG19_REVISIONS_WEIGHTED },
  });
  assert.equal(ok.code, 0);
  assert.equal(ok.written['serving.txt'], `${AUG19_APPLIED}\n`);

  const nope = runCli(['serving-tag', '--revisions', 'revs.json', '--out', 'serving.txt'], {
    files: { 'revs.json': [rev('r1', '2026-08-19T07:00:00Z', AUG19_ROLLED, 0)] },
  });
  assert.equal(nope.code, 1, 'an unestablished serving image must not read as "recovered"');
  assert.equal(
    nope.written['serving.txt'], '',
    'the file is always written, and written empty — a caller that ignores the exit code must not read a STALE ' +
      'tag from the previous poll and call it recovery',
  );
});

test('CLI serving-tag: a missing flag is a USAGE error (2), never a silent empty answer', () => {
  const r = runCli(['serving-tag', '--revisions', 'revs.json'], { files: { 'revs.json': [] } });
  assert.equal(r.code, 2);
  assert.match(r.logs, /both --revisions <file> and --out <file> are required/);
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL — the REAL step bodies, extracted from the workflow and run with
// a stubbed `az` / `gh` and the REAL jq.
//
// The node tests above prove the decisions. They say nothing about the ~50
// lines of shell that reach them, which is where this repo's deploy defects
// have overwhelmingly lived: a merged stderr, a `head -c` that SIGPIPEs the
// step dead under `pipefail`, a jq filter that selects nothing. So these run
// the ACTUAL `run:` bodies — sliced out of the workflow, never restated — and
// let real jq apply the workflow's own filters to realistic Actions API
// payloads. Only `az` and `gh` are faked (they are the network); every string
// asserted on is produced by the real step and the real CLI.
// ---------------------------------------------------------------------------

const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const jqOk = spawnSync('bash', ['-c', 'command -v jq']).status === 0;
const shellSkip = (!bashOk && 'bash unavailable') || (!jqOk && 'jq unavailable');

/**
 * The `run:` scalar of a step, dedented — DERIVED from the workflow, so a shell
 * change is exercised here automatically and cannot drift from what CI runs.
 */
function runBodyOf(yaml, namePrefix) {
  const at = yaml.indexOf(`      - name: ${namePrefix}`);
  assert.notEqual(at, -1, `step starting ${JSON.stringify(namePrefix)} not found`);
  const rest = yaml.slice(at);
  const runAt = rest.indexOf('\n        run: |\n');
  assert.notEqual(runAt, -1, `step ${JSON.stringify(namePrefix)} has no block-scalar run:`);
  const lines = rest.slice(runAt + '\n        run: |\n'.length).split('\n');
  const out = [];
  for (const l of lines) {
    if (l.trim() === '') { out.push(''); continue; }
    if (!l.startsWith('          ')) break;
    out.push(l.slice(10));
  }
  return out.join('\n');
}

/**
 * The `env:` keys a step declares. Asserted against what the harness supplies
 * so a renamed input cannot leave this test silently exercising a step whose
 * variables are all empty — an extracted-step harness that does not DERIVE its
 * environment tests a different program than the one CI runs.
 */
function envKeysOf(yaml, namePrefix) {
  const at = yaml.indexOf(`      - name: ${namePrefix}`);
  const rest = yaml.slice(at);
  const envAt = rest.indexOf('\n        env:\n');
  const runAt = rest.indexOf('\n        run:');
  if (envAt === -1 || envAt > runAt) return [];
  return rest
    .slice(envAt, runAt)
    .split('\n')
    .map((l) => /^ {10}([A-Z0-9_]+):/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

const GH_STUB = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  // `gh workflow run` is the auto-heal dispatch (#3799). It is RECORDED rather
  // than performed, so a test can assert exactly what would have been sent —
  // and count it, because "one attempt, no loop" is a safety property.
  'if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then',
  '  printf "%s\\n" "$*" >> "$GH_DISPATCH_LOG"',
  '  if [ -n "${GH_DISPATCH_FAIL:-}" ]; then echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi',
  '  exit 0',
  'fi',
  '[ "$1" = "api" ] || { echo "unstubbed gh: $*" >&2; exit 99; }',
  'URL="$2"; JQ_EXPR=""',
  '[ "${3:-}" = "--jq" ] && JQ_EXPR="$4"',
  'case "$URL" in',
  '  *"/workflows/loom-roll-and-validate.yml/runs"*) PAYLOAD="$GH_FIXTURES/roll-runs.json" ;;',
  '  *"/workflows/full-app-deploy-commercial.yml/runs"*) PAYLOAD="$GH_FIXTURES/full-runs.json" ;;',
  '  *"/jobs"*) RID="${URL##*/runs/}"; RID="${RID%%/jobs*}"; PAYLOAD="$GH_FIXTURES/jobs-$RID.json" ;;',
  '  *) echo "unstubbed gh url: $URL" >&2; exit 99 ;;',
  'esac',
  '[ -n "${GH_FAIL:-}" ] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }',
  '[ -f "$PAYLOAD" ] || { echo "gh stub: no fixture $PAYLOAD" >&2; exit 1; }',
  // -r -c is how `gh --jq` behaves: raw for strings, compact JSON per result.
  'jq -r -c "$JQ_EXPR" < "$PAYLOAD"',
].join('\n');

const AZ_STUB = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  // `az containerapp revision list` MUST be matched before the bare `list`
  // branch below: its $2 is `revision`, not `list`, so order is not actually
  // load-bearing here — but keeping it first documents that they are two
  // different reads (running image vs. the timestamped history) rather than one.
  //
  // The call is COUNTED so a test can hand the auto-heal poll a stale estate
  // first and a healed one afterwards — recovery is a state that CHANGES, and a
  // stub that answers identically every time cannot tell "healed" from "never
  // moved" (the two-point-sampling trap this whole gate exists because of).
  'if [ "$1" = "containerapp" ] && [ "$2" = "revision" ] && [ "$3" = "list" ]; then',
  '  N=$(cat "$AZ_REV_COUNT"); N=$((N + 1)); printf "%s" "$N" > "$AZ_REV_COUNT"',
  '  if [ -n "${AZ_REV_ERR:-}" ]; then printf "%s\\n" "$AZ_REV_ERR" >&2; exit 1; fi',
  // ── PER-APP MODE (#3676). The gate now reads ONE history per watched app,
  // so a stub that answers identically for every `-n` cannot tell a healthy
  // console apart from a reverted loom-mirroring — i.e. it could not observe
  // the defect this change exists for. `-n` is parsed out of the real argv,
  // and a `<app>.fail` fixture makes THAT app's read fail while the others
  // succeed, which is the state the per-app UNKNOWN path is built around.
  '  APPN=""; PREV=""',
  '  for A in "$@"; do if [ "$PREV" = "-n" ]; then APPN="$A"; break; fi; PREV="$A"; done',
  '  if [ -n "${AZ_REV_DIR:-}" ] && [ -n "$APPN" ]; then',
  '    if [ -f "$AZ_REV_DIR/$APPN.fail" ]; then cat "$AZ_REV_DIR/$APPN.fail" >&2; exit 1; fi',
  '    if [ -n "${AZ_REV_SWITCH_AT:-}" ] && [ "$N" -ge "${AZ_REV_SWITCH_AT}" ] && [ -f "$AZ_REV_DIR/$APPN.2.json" ]; then',
  '      cat "$AZ_REV_DIR/$APPN.2.json"; exit 0',
  '    fi',
  '    if [ -f "$AZ_REV_DIR/$APPN.json" ]; then cat "$AZ_REV_DIR/$APPN.json"; exit 0; fi',
  '    echo "az stub: no per-app revision fixture for $APPN in $AZ_REV_DIR" >&2; exit 1',
  '  fi',
  '  FILE="$AZ_REV_FILE"',
  '  if [ -n "${AZ_REV_FILE2:-}" ] && [ "$N" -ge "${AZ_REV_SWITCH_AT:-2}" ]; then FILE="$AZ_REV_FILE2"; fi',
  '  cat "$FILE"; exit 0',
  'fi',
  'if [ "$1" = "containerapp" ] && [ "$2" = "list" ]; then',
  '  if [ -n "${AZ_LIST_ERR:-}" ]; then printf "%s\\n" "$AZ_LIST_ERR" >&2; exit 1; fi',
  '  cat "$AZ_LIST_FILE"; exit 0',
  'fi',
  'if [ "$1" = "containerapp" ] && [ "$2" = "show" ]; then',
  '  if [ -n "${AZ_SHOW_ERR:-}" ]; then printf "%s\\n" "$AZ_SHOW_ERR" >&2; exit 1; fi',
  '  printf "%s\\n" "$AZ_SHOW_IMAGE"; exit 0',
  'fi',
  'echo "unstubbed az: $*" >&2; exit 99',
].join('\n');

/**
 * A workspace two steps can SHARE, so the gate's `$RUNNER_TEMP` hand-off to the
 * auto-heal step is exercised end to end rather than assumed. Without this each
 * runStep() gets its own temp dir and the request file the gate writes could
 * never be the one the heal step reads — the harness would prove nothing about
 * the wiring, which is the part that can silently break.
 */
function newStepCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'roll-race-ctx-'));
  const binDir = join(dir, 'bin');
  const fixDir = join(dir, 'fixtures');
  const runnerTemp = join(dir, 'runner-temp');
  for (const d of [binDir, fixDir, runnerTemp]) mkdirSync(d, { recursive: true });
  return { dir, binDir, fixDir, runnerTemp, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function runStep(namePrefix, { env = {}, fixtures = {}, azList = null, azRevisions = null, azRevisions2 = null, azRevisionsByApp = null, ctx = null } = {}) {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const body = runBodyOf(yaml, namePrefix);
  const declared = envKeysOf(yaml, namePrefix);
  for (const k of declared) {
    assert.ok(
      k in env,
      `the step declares env ${k} but this harness does not supply it — the harness would be exercising a ` +
        'different program than CI runs. Add it, or the assertion below proves nothing.',
    );
  }

  const own = ctx || newStepCtx();
  const { dir, binDir, fixDir, runnerTemp } = own;
  try {
    writeFileSync(join(binDir, 'gh'), GH_STUB);
    writeFileSync(join(binDir, 'az'), AZ_STUB);
    chmodSync(join(binDir, 'gh'), 0o755);
    chmodSync(join(binDir, 'az'), 0o755);
    for (const [name, body2] of Object.entries(fixtures)) {
      writeFileSync(join(fixDir, name), typeof body2 === 'string' ? body2 : JSON.stringify(body2));
    }
    const azListFile = join(dir, 'az-list.json');
    if (azList) writeFileSync(azListFile, JSON.stringify(azList));
    const azRevFile = join(dir, 'az-revisions.json');
    writeFileSync(azRevFile, JSON.stringify(azRevisions ?? []));
    const azRevFile2 = join(dir, 'az-revisions-2.json');
    if (azRevisions2) writeFileSync(azRevFile2, JSON.stringify(azRevisions2));
    const azRevCount = join(dir, 'az-revisions.count');
    writeFileSync(azRevCount, '0');
    // PER-APP fixtures (#3676). `{ 'loom-console': [...], 'loom-mirroring': {
    // fail: 'text' }, 'loom-x': { revisions: [...], then: [...] } }` — an array
    // is the history, `.fail` makes THAT app's az call fail while the rest
    // succeed, and `.then` is what the SECOND read onwards returns (the heal
    // poll's recovery, which is a state that must CHANGE for a two-point sample
    // to mean anything).
    const azRevDir = join(dir, 'az-revisions-by-app');
    if (azRevisionsByApp) {
      mkdirSync(azRevDir, { recursive: true });
      for (const [app, spec] of Object.entries(azRevisionsByApp)) {
        if (Array.isArray(spec)) {
          writeFileSync(join(azRevDir, `${app}.json`), JSON.stringify(spec));
          continue;
        }
        if (spec && typeof spec.fail === 'string') {
          writeFileSync(join(azRevDir, `${app}.fail`), spec.fail);
          continue;
        }
        if (spec && spec.revisions) writeFileSync(join(azRevDir, `${app}.json`), JSON.stringify(spec.revisions));
        if (spec && spec.then) writeFileSync(join(azRevDir, `${app}.2.json`), JSON.stringify(spec.then));
      }
    }
    const dispatchLog = join(dir, 'gh-dispatch.log');
    writeFileSync(dispatchLog, '');

    const script = join(dir, 'step.sh');
    writeFileSync(script, body, 'utf8');
    const ghEnvFile = join(dir, 'github_env');
    const ghOutFile = join(dir, 'github_output');
    writeFileSync(ghEnvFile, '');
    writeFileSync(ghOutFile, '');

    // `bash -e {0}` is GitHub's own invocation for a `run:` block. Running it
    // any other way would hide exactly the class of defect where a guard aborts
    // early and the skip reads as a pass.
    const res = spawnSync('bash', ['-e', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: ghEnvFile,
        GITHUB_OUTPUT: ghOutFile,
        GH_FIXTURES: fixDir,
        GH_DISPATCH_LOG: dispatchLog,
        AZ_LIST_FILE: azListFile,
        AZ_REV_FILE: azRevFile,
        ...(azRevisions2 ? { AZ_REV_FILE2: azRevFile2 } : {}),
        ...(azRevisionsByApp ? { AZ_REV_DIR: azRevDir } : {}),
        AZ_REV_COUNT: azRevCount,
      },
    });
    return {
      status: res.status,
      out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      envFile: readFileSync(ghEnvFile, 'utf8'),
      outFile: readFileSync(ghOutFile, 'utf8'),
      dispatches: readFileSync(dispatchLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    if (!ctx) own.dispose();
  }
}

const REPIN_STEP = 'Re-pin appImageTags to the RUNNING images';
const ESTATE_STEP = 'Estate must not be BEHIND the last successful roll';

test('SHELL: the re-pin step re-exports the RUNNING console tag over the stale pin', { skip: shellSkip }, () => {
  const r = runStep(REPIN_STEP, {
    azList: estateAt(ROLLED),
    env: {
      DEPLOY_APPS_ENABLED: 'true',
      HUB_PRESENT: 'true',
      DEPLOY_SUB: '',
      AZURE_LOCATION: 'centralus',
      LOOM_CONSOLE_TAG: STALE,
      LOOM_MCP_TAG: '0.80.0',
      LOOM_UNITY_TAG: '0.80.0',
    },
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.envFile, new RegExp(`LOOM_CONSOLE_TAG=${ROLLED}`), `GITHUB_ENV was:\n${r.envFile}\n---\n${r.out}`);
  assert.match(r.outFile, new RegExp(`console_tag=${ROLLED}`));
  assert.match(r.outFile, /measured_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  assert.match(r.out, /MOVED loom-console/);
});

test('SHELL: an `az containerapp list` failure REFUSES and carries what az actually said', { skip: shellSkip }, () => {
  const r = runStep(REPIN_STEP, {
    azList: [],
    env: {
      DEPLOY_APPS_ENABLED: 'true',
      HUB_PRESENT: 'true',
      DEPLOY_SUB: '',
      AZURE_LOCATION: 'centralus',
      LOOM_CONSOLE_TAG: STALE,
      AZ_LIST_ERR: 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action',
    },
  });
  assert.equal(r.status, 1, `expected a refusal; got ${r.status}:\n${r.out}`);
  assert.match(r.out, /PIN REFRESH REFUSED/);
  assert.match(r.out, /AuthorizationFailed/, 'the refusal must quote the control plane, not invent a cause (R7)');
  assert.equal(r.envFile.trim(), '', 'a refusal must export no pins');
});

test('SHELL: a long az error does not SIGPIPE the step dead under pipefail', { skip: shellSkip }, () => {
  const r = runStep(REPIN_STEP, {
    azList: [],
    env: {
      DEPLOY_APPS_ENABLED: 'true',
      HUB_PRESENT: 'true',
      DEPLOY_SUB: '',
      AZURE_LOCATION: 'centralus',
      LOOM_CONSOLE_TAG: STALE,
      // Comfortably past the 400-char trim, which is where `| head -c 400`
      // would kill `tr` with SIGPIPE and take the whole step down under
      // `set -o pipefail` — a guard aborting on its own error path.
      AZ_LIST_ERR: `ERROR: ${'x'.repeat(3000)}`,
    },
  });
  assert.equal(r.status, 1, `expected the refusal path, got ${r.status}:\n${r.out}`);
  assert.match(r.out, /PIN REFRESH REFUSED/, 'the step must still REACH its verdict on a very long error');
});

test('SHELL: a from-scratch estate (no hub) passes without asking az anything', { skip: shellSkip }, () => {
  const r = runStep(REPIN_STEP, {
    azList: null,
    env: {
      DEPLOY_APPS_ENABLED: 'true',
      HUB_PRESENT: 'false',
      DEPLOY_SUB: '',
      AZURE_LOCATION: 'centralus',
    },
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /from-scratch install/);
});

/** Actions API payloads, in the shape gh really returns. */
const rollRunsPayload = (runs) => ({ workflow_runs: runs });

/**
 * A revision history the REVISION source reads as clean, so the tests below
 * keep exercising the Actions-API attribution path they were written for.
 * The 2026-08-19 shape gets its own test rather than being smeared into these.
 * It carries `trafficWeight` because the live projection does — an unweighted
 * payload is UNKNOWN now, which would make every one of these fail closed for
 * the wrong reason.
 */
const cleanRevisions = (tag) => [rev('loom-console--0000756', '2026-08-17T07:19:48Z', tag, 100)];

/**
 * A revision for an app OTHER than the console (#3676).
 *
 * `rev()` bakes `loom-console` into the image reference, which was harmless
 * while the gate watched exactly one app and is actively misleading now: a
 * fixture whose image says `loom-console` cannot be matched onto
 * `loom-mirroring` by `selectWatchedApps`, so a test built on it would exercise
 * the console path under another app's name.
 */
const revOf = (app, name, createdTime, tag, trafficWeight) => ({
  name, createdTime, trafficWeight,
  image: `acrloomk6mvh5sm6z7do.azurecr.io/${app}:${tag}`,
});

/**
 * The env the ESTATE gate needs in its post-#3676 shape.
 *
 * The applied tag is no longer one `APPLIED_TAG` scalar. The step reads the
 * pins out of the ENVIRONMENT (`pinsFromEnv`), because that $GITHUB_ENV record
 * is what `commercial.bicepparam` resolves at bicep-compile time and therefore
 * IS what the apply wrote — a second scalar would be a copy that can drift.
 * Passing `consoleTag` here writes `LOOM_CONSOLE_TAG`, which is the same
 * variable the re-pin step exports in CI.
 */
const estateEnv = ({ consoleTag = null, measuredAt = '', pins = {}, ...over } = {}) => ({
  GH_TOKEN: 'x',
  DEPLOY_SUB: '',
  DEPLOY_APPS_ENABLED: 'true',
  MEASURED_AT: measuredAt,
  AZURE_LOCATION: 'centralus',
  GITHUB_REPOSITORY: 'acme/csa-inabox',
  ...(consoleTag ? { LOOM_CONSOLE_TAG: consoleTag } : {}),
  ...pins,
  ...over,
});

/** The two Actions-API populations the gate reads, both empty. */
const noRolls = () => ({
  'roll-runs.json': rollRunsPayload([]),
  'full-runs.json': rollRunsPayload([]),
});

test('SHELL: THE 2026-08-19 MISS end to end — the revision history reddens what the Actions API missed', { skip: shellSkip }, () => {
  // Every input is the live shape: the Actions API returns an EMPTY listing
  // (which is what it did at 07:14:52Z) and the revision history carries the
  // round trip. The old step body had no second witness and went green here.
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(AUG19_APPLIED),
    azRevisionsByApp: { 'loom-console': AUG19_REVISIONS_WEIGHTED },
    env: estateEnv({ consoleTag: AUG19_APPLIED, measuredAt: AUG19_MEASURED_AT }),
    fixtures: noRolls(),
  });
  assert.equal(
    r.status, 1,
    `the step must go RED on the exact state that shipped green on 2026-08-19; got ${r.status}:\n${r.out}`,
  );
  assert.match(r.out, /ESTATE REGRESSION \(#3676\)/);
  assert.match(r.out, /ITS OWN REVISION HISTORY RECORDS IT/);
  assert.match(
    r.out,
    new RegExp(`roll-forward requested — loom-roll-and-validate\\.yml for loom-console at ${AUG19_ROLLED}`),
    'and must name the SHA read off the estate, AND the lane that can actually roll that app forward',
  );
  assert.match(r.out, /loom-console--0000782/);
});

test('SHELL: MUTATION CONTROL — withhold the revision history and the gate has NOTHING left, so it fails CLOSED', { skip: shellSkip }, () => {
  // This control changed meaning with #3676, and the change is the point.
  //
  // It used to assert exit 0: the single-app gate had a SECOND witness (`az
  // containerapp show`), so removing the revision history left it comparing the
  // Actions API alone — the configuration that reported OK across the
  // 2026-08-19 revert. The estate-wide form deleted that fallback (the serving
  // image is derived from the SAME revision payload, per #3798), so withholding
  // the history now leaves NOTHING established and the gate refuses.
  //
  // The "it would have gone green" control is not lost — it lives at the policy
  // level, where the evidence can be withheld from `decideEstateRegression`
  // without also removing the witness: see 'MUTATION CONTROL: with the revision
  // evidence withheld, the very same state passes — which is what shipped'.
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(AUG19_APPLIED),
    azRevisionsByApp: { 'loom-console': [] },
    env: estateEnv({ consoleTag: AUG19_APPLIED, measuredAt: AUG19_MEASURED_AT }),
    fixtures: noRolls(),
  });
  assert.equal(
    r.status, 1,
    `with no revision history there is no witness at all, and "I could not look" must not read as "nothing ` +
      `happened":\n${r.out}`,
  );
  assert.match(r.out, /ESTATE UNKNOWN \(#3676\)/);
  assert.match(r.out, /trafficWeight/,
    'and it must say WHICH fact was missing, not merely that something was');
});

test('SHELL: an unreadable revision history fails CLOSED even when everything else is clean', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(ROLLED),
    azRevisionsByApp: {
      'loom-console': { fail: 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action' },
    },
    env: estateEnv({ consoleTag: ROLLED, measuredAt: '2026-08-17T07:03:40Z' }),
    fixtures: noRolls(),
  });
  assert.equal(r.status, 1, `an unreadable estate history is UNKNOWN, not a pass:\n${r.out}`);
  assert.match(r.out, /UNKNOWN/);
  assert.match(r.out, /AuthorizationFailed/, 'the refusal must quote the control plane, not invent a cause (R7)');
});

test('SHELL: THE INCIDENT end to end — stale image + a newer shipped roll exits 1', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(STALE),
    azRevisionsByApp: { 'loom-console': cleanRevisions(STALE) },
    env: estateEnv({ consoleTag: STALE, measuredAt: '2026-08-17T07:03:40Z' }),
    fixtures: {
      'roll-runs.json': rollRunsPayload([
        { id: 32004219673, display_title: `roll ${ROLLED} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-17T07:15:30Z' },
        { id: 32002439590, display_title: `roll ${STALE} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-17T06:46:45Z' },
      ]),
      'full-runs.json': rollRunsPayload([]),
      'jobs-32004219673.json': { jobs: [{ name: 'Should this roll proceed?', conclusion: 'success' }, { name: 'Roll image + validate live URL', conclusion: 'success' }] },
    },
  });
  assert.equal(r.status, 1, `expected a RED gate on the live incident state; got ${r.status}:\n${r.out}`);
  assert.match(r.out, /ESTATE REGRESSION \(#3676\)/);
  assert.match(r.out, new RegExp(ROLLED));
});

test('SHELL: a roll that concluded success with its roll job SKIPPED does not clear the gate', { skip: shellSkip }, () => {
  // Run 32006479915's real shape. If the step read the RUN conclusion instead
  // of the JOB conclusion this would report the estate as correct.
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(STALE),
    azRevisionsByApp: { 'loom-console': cleanRevisions(STALE) },
    env: estateEnv({ consoleTag: STALE, measuredAt: '2026-08-17T07:03:40Z' }),
    fixtures: {
      'roll-runs.json': rollRunsPayload([
        { id: 32006479915, display_title: 'roll 66bb26e705a17796d639a9752990c6e70ab96c35 (build-triggered)', head_sha: 'deadbeef', updated_at: '2026-08-17T07:35:30Z' },
        { id: 32004219673, display_title: `roll ${ROLLED} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-17T07:15:30Z' },
      ]),
      'full-runs.json': rollRunsPayload([]),
      'jobs-32006479915.json': { jobs: [{ name: 'Should this roll proceed?', conclusion: 'success' }, { name: 'Roll image + validate live URL', conclusion: 'skipped' }] },
      'jobs-32004219673.json': { jobs: [{ name: 'Roll image + validate live URL', conclusion: 'success' }] },
    },
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`shipped loom-console:${ROLLED}`),
    'the SKIPPED run must not be treated as the last roll; the last SHIPPED one is 32004219673');
});

test('SHELL: the healthy path exits 0', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(ROLLED),
    azRevisionsByApp: { 'loom-console': cleanRevisions(ROLLED) },
    env: estateEnv({ consoleTag: ROLLED, measuredAt: '2026-08-17T07:03:40Z' }),
    fixtures: {
      'roll-runs.json': rollRunsPayload([
        { id: 32004219673, display_title: `roll ${ROLLED} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-17T07:15:30Z' },
      ]),
      'full-runs.json': rollRunsPayload([]),
      'jobs-32004219673.json': { jobs: [{ name: 'Roll image + validate live URL', conclusion: 'success' }] },
    },
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /estate-vs-roll \(all apps\): OK/);
});

test('SHELL: an unreadable Actions API fails CLOSED rather than passing quietly', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(ROLLED),
    azRevisionsByApp: { 'loom-console': cleanRevisions(ROLLED) },
    env: estateEnv({ consoleTag: ROLLED, measuredAt: '2026-08-17T07:03:40Z', GH_FAIL: '1' }),
    fixtures: noRolls(),
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /UNKNOWN/);
  assert.match(r.out, /403/, 'the failure must carry what gh actually said');
});

test('SHELL: an unreadable container app LIST fails CLOSED', { skip: shellSkip }, () => {
  // The estate-wide gate reads `az containerapp list` to learn WHICH apps this
  // apply wrote. An unreadable list is not an empty estate: it leaves every app
  // unestablished, and must fail the whole gate rather than compare nothing.
  const r = runStep(ESTATE_STEP, {
    azList: estateAt(ROLLED),
    env: estateEnv({
      consoleTag: ROLLED,
      measuredAt: '2026-08-17T07:03:40Z',
      AZ_LIST_ERR: 'ERROR: (ResourceGroupNotFound) Resource group not found',
    }),
    fixtures: noRolls(),
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ResourceGroupNotFound/);
  assert.match(r.out, /UNKNOWN/);
});

test('SHELL: a whatif run that rendered no Container App passes without touching the Actions API', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    // No fixtures and no az fixtures at all: reaching gh or az here exits 99.
    env: estateEnv({ DEPLOY_APPS_ENABLED: 'false', measuredAt: '' }),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /rendered no Container App/);
});

test('SHELL: deployAppsEnabled=true with NO pin exported still short-circuits, and says which fact it used', { skip: shellSkip }, () => {
  // The other direction of the same guard: a from-scratch estate can render
  // apps while the re-pin exported nothing. Reaching az here would exit 99.
  const r = runStep(ESTATE_STEP, {
    env: estateEnv({ measuredAt: '' }),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /exported no appImageTags pin/);
});

// ---------------------------------------------------------------------------
// THE #3676 HEADLINE: the gate watched ONE app out of TWENTY.
//
// Everything above this line exercises loom-console, which is the app the gate
// has always watched. The tests below are the ones that discriminate: a
// NON-console app is overwritten mid-apply while the console is perfectly
// healthy. At head that is exit 0 with no signal — both lanes green, no heal,
// which is this issue's original shape verbatim. The mutation control below
// (`only the console pinned`) reproduces the head configuration through the
// SAME step body, so the RED and the GREEN differ by the population watched
// and nothing else.
// ---------------------------------------------------------------------------

/** A non-console estate: console healthy, loom-mirroring reverted under it. */
const MIRRORING_ROLLED = '150d2937336415545a771fe12f0d7b2fba2093d8';
const MIRRORING_APPLIED = '83e7cab61e8c978de3352b21b05551e4bb85d7a6';

const mixedEstate = () => [
  { name: 'loom-console', image: `acr1.azurecr.io/loom-console:${ROLLED}` },
  { name: 'loom-mirroring', image: `acr1.azurecr.io/loom-mirroring:${MIRRORING_APPLIED}` },
];

/** loom-mirroring's own history: roll lands, the apply puts the old tag back. */
const MIRRORING_REVERTED = [
  revOf('loom-mirroring', 'loom-mirroring--0000041', '2026-08-19T05:46:46+00:00', MIRRORING_APPLIED, 0),
  revOf('loom-mirroring', 'loom-mirroring--0000042', '2026-08-19T07:04:56+00:00', MIRRORING_ROLLED, 0),
  revOf('loom-mirroring', 'loom-mirroring--0000043', '2026-08-19T07:10:19+00:00', MIRRORING_APPLIED, 100),
];

const healthyConsoleRolls = () => ({
  'roll-runs.json': rollRunsPayload([
    { id: 32004219673, display_title: `roll ${ROLLED} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-19T07:15:30Z' },
  ]),
  'full-runs.json': rollRunsPayload([]),
  'jobs-32004219673.json': { jobs: [{ name: 'Roll image + validate live URL', conclusion: 'success' }] },
});

test('SHELL #3676: a NON-console app overwritten mid-apply is RED — the silent half, estate-wide', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    azList: mixedEstate(),
    azRevisionsByApp: {
      'loom-console': [rev('loom-console--0000756', '2026-08-19T07:19:48+00:00', ROLLED, 100)],
      'loom-mirroring': MIRRORING_REVERTED,
    },
    env: estateEnv({
      consoleTag: ROLLED,
      measuredAt: AUG19_MEASURED_AT,
      pins: { LOOM_MIRRORING_TAG: MIRRORING_APPLIED },
    }),
    fixtures: healthyConsoleRolls(),
  });
  assert.equal(
    r.status, 1,
    `loom-mirroring's own revision history records roll -> revert inside the window; the gate must go RED on it ` +
      `even though loom-console is healthy. Got ${r.status}:\n${r.out}`,
  );
  assert.match(r.out, /loom-mirroring/, 'the verdict must NAME the app that regressed');
  assert.match(r.out, new RegExp(MIRRORING_ROLLED), 'and the SHA it was overwritten from');
  assert.match(
    r.out, /estate-vs-roll \[loom-console\] OK/,
    'the healthy app must still be reported OK by name — a single estate-wide red that does not say WHICH app ' +
      'sends the reader to the wrong container',
  );
});

test('SHELL #3676 MUTATION CONTROL: the SAME estate with only the console pinned goes GREEN — that is head', { skip: shellSkip }, () => {
  // The needle is the WATCHED POPULATION, nothing else. Identical az list,
  // identical revision histories, identical Actions API. Dropping
  // LOOM_MIRRORING_TAG makes loom-mirroring out-of-scope, which is exactly what
  // the head gate's hard-coded `-n loom-console` did to nineteen apps — and the
  // reverted app sails through with the run green.
  const r = runStep(ESTATE_STEP, {
    azList: mixedEstate(),
    azRevisionsByApp: {
      'loom-console': [rev('loom-console--0000756', '2026-08-19T07:19:48+00:00', ROLLED, 100)],
      'loom-mirroring': MIRRORING_REVERTED,
    },
    env: estateEnv({ consoleTag: ROLLED, measuredAt: AUG19_MEASURED_AT }),
    fixtures: healthyConsoleRolls(),
  });
  assert.equal(
    r.status, 0,
    `CONTROL: with loom-mirroring outside the watched population the identical revert is invisible — if this ` +
      `ever fails, the test above is no longer discriminating:\n${r.out}`,
  );
  assert.match(r.out, /loom-mirroring is out of scope/,
    'and it must SAY it is not looking, rather than dropping the app silently');
});

test('SHELL #3676: an app whose history could not be read fails the WHOLE gate, even with a healthy console', { skip: shellSkip }, () => {
  // Per-app UNKNOWN. "I could not look at loom-mirroring" must not be spent as
  // "loom-mirroring is fine" just because loom-console read cleanly.
  const r = runStep(ESTATE_STEP, {
    azList: mixedEstate(),
    azRevisionsByApp: {
      'loom-console': [rev('loom-console--0000756', '2026-08-19T07:19:48+00:00', ROLLED, 100)],
      'loom-mirroring': { fail: 'ERROR: (AuthorizationFailed) no authorization to read loom-mirroring' },
    },
    env: estateEnv({
      consoleTag: ROLLED,
      measuredAt: AUG19_MEASURED_AT,
      pins: { LOOM_MIRRORING_TAG: MIRRORING_APPLIED },
    }),
    fixtures: healthyConsoleRolls(),
  });
  assert.equal(r.status, 1, `an unread app is UNKNOWN, which fails closed:\n${r.out}`);
  assert.match(r.out, /AuthorizationFailed/, 'R7: it must quote az rather than invent a cause');
  assert.match(r.out, /loom-mirroring/);
});

// ---------------------------------------------------------------------------
// SHELL — THE AUTO-HEAL (#3799). Detection was the previous change; this is the
// part that puts the image back. Everything below runs the REAL step body with
// a stubbed `gh workflow run` that RECORDS rather than dispatches, so "one
// attempt", "only on a definite verdict" and "verified against the estate" are
// measured properties rather than claims in a comment.
// ---------------------------------------------------------------------------

const HEAL_STEP = 'Roll the estate FORWARD to the image this apply overwrote';

/**
 * A roll-forward request line, in the NDJSON shape the gate now writes (#3676).
 *
 * It used to be a bare SHA, which could only ever describe ONE app and one
 * lane. Tests write it through this helper rather than by hand so a change to
 * the contract breaks in one place instead of seven.
 */
const healRequest = ({ workflow = 'loom-roll-and-validate.yml', kind = 'console', sha, apps = ['loom-console'], boundary = 'commercial', why = 'test fixture' }) =>
  `${JSON.stringify({ workflow, kind, sha, boundary, apps, why })}\n`;

const HEAL_REQ_FILE = 'estate-heal-request.ndjson';

/** The env the heal step needs; the harness asserts the declared keys are here. */
const healEnv = (over = {}) => ({
  GH_TOKEN: 'x',
  DEPLOY_SUB: '',
  AZURE_LOCATION: 'centralus',
  GITHUB_REPOSITORY: 'acme/csa-inabox',
  GITHUB_REF_NAME: 'main',
  LOOM_HEAL_POLLS: '3',
  LOOM_HEAL_SLEEP_SECONDS: '0',
  ...over,
});

test('SHELL #3799 END TO END: the gate writes the request, the heal step dispatches THAT sha and verifies recovery', { skip: shellSkip }, () => {
  // ONE workspace across BOTH steps, because $RUNNER_TEMP is the hand-off. Two
  // separate temp dirs would let the wiring be completely broken and still pass.
  const ctx = newStepCtx();
  try {
    const gate = runStep(ESTATE_STEP, {
      ctx,
      azList: estateAt(AUG19_APPLIED),
      azRevisionsByApp: { 'loom-console': AUG19_REVISIONS_WEIGHTED },
      env: estateEnv({ consoleTag: AUG19_APPLIED, measuredAt: AUG19_MEASURED_AT }),
      fixtures: noRolls(),
    });
    assert.equal(gate.status, 1, `the gate must detect the revert first:\n${gate.out}`);
    assert.deepEqual(gate.dispatches, [], 'the GATE never dispatches — it detects; the heal step acts');

    const heal = runStep(HEAL_STEP, {
      ctx,
      // Poll 1 still sees the reverted estate; poll 2 sees the roll landed.
      azRevisionsByApp: {
        'loom-console': {
          revisions: AUG19_REVISIONS_WEIGHTED,
          then: [
            ...AUG19_REVISIONS_WEIGHTED.map((r) => ({ ...r, trafficWeight: 0 })),
            rev('loom-console--0000784', '2026-08-19T07:40:00+00:00', AUG19_ROLLED, 100),
          ],
        },
      },
      env: healEnv({ AZ_REV_SWITCH_AT: '2' }),
    });
    assert.equal(heal.status, 0, `recovery was observed, so the heal step itself succeeded:\n${heal.out}`);
    assert.equal(heal.dispatches.length, 1, `exactly ONE dispatch, no loop; got ${JSON.stringify(heal.dispatches)}`);
    assert.match(heal.dispatches[0], /workflow run loom-roll-and-validate\.yml/);
    assert.match(
      heal.dispatches[0], new RegExp(`image_tag=${AUG19_ROLLED}`),
      'it must roll forward to the image the apply OVERWROTE — read off the estate, not the tag we applied',
    );
    assert.match(heal.out, /AUTO-HEAL VERIFIED/);
    assert.match(
      heal.out, /deploy still reports FAILURE/,
      'healing must not read as absolution — the run is red because the regression happened',
    );
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3799 MUTATION CONTROL: with NO request file the heal step dispatches nothing and exits 0', { skip: shellSkip }, () => {
  // The gate fails for four reasons and only one is actionable. This is what an
  // UNKNOWN or a DRIFTED verdict leaves behind: an empty request.
  const r = runStep(HEAL_STEP, { env: healEnv() });
  assert.equal(r.status, 0, `no request is not a failure of the heal step:\n${r.out}`);
  assert.deepEqual(
    r.dispatches, [],
    'CONTROL: if this ever dispatches, the "only a definite regression may dispatch" property is gone and the ' +
      'gate could roll a healthy estate backwards on a DRIFTED verdict',
  );
  assert.match(r.out, /dispatches NOTHING/);
});

test('SHELL #3799: recovery that is never observed is reported NOT VERIFIED — and dispatched exactly once', { skip: shellSkip }, () => {
  const ctx = newStepCtx();
  try {
    writeFileSync(join(ctx.runnerTemp, HEAL_REQ_FILE), healRequest({ sha: AUG19_ROLLED }));
    const r = runStep(HEAL_STEP, {
      ctx,
      azRevisionsByApp: { 'loom-console': AUG19_REVISIONS_WEIGHTED }, // never heals
      env: healEnv(),
    });
    assert.equal(r.status, 1, `an unobserved recovery must not read as success:\n${r.out}`);
    assert.equal(r.dispatches.length, 1, 'one attempt, then hand off — never a dispatch storm');
    assert.match(r.out, /AUTO-HEAL NOT VERIFIED/);
    assert.match(
      r.out, /does not say the roll failed/,
      'R7: not observing recovery inside a budget is not evidence the roll failed, and the message must not say ' +
        'it is — a roll still gating on vitest/cosign/UAT looks exactly like this',
    );
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3799: a dispatch that FAILS quotes gh and never claims the estate was healed', { skip: shellSkip }, () => {
  const ctx = newStepCtx();
  try {
    writeFileSync(join(ctx.runnerTemp, HEAL_REQ_FILE), healRequest({ sha: AUG19_ROLLED }));
    const r = runStep(HEAL_STEP, {
      ctx,
      azRevisionsByApp: { 'loom-console': AUG19_REVISIONS_WEIGHTED },
      env: healEnv({ GH_DISPATCH_FAIL: '1' }),
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /the dispatch of loom-roll-and-validate\.yml for loom-console FAILED/);
    assert.match(r.out, /Resource not accessible by integration/, 'it must quote gh, not invent a cause (R7)');
    assert.match(r.out, /STILL running the overwritten image/);
    assert.doesNotMatch(r.out, /AUTO-HEAL VERIFIED/);
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3799: it REFUSES to dispatch when the roll lane targets a different estate', { skip: shellSkip }, () => {
  // loom-roll-and-validate.yml is hard-pinned to rg-csa-loom-admin-centralus;
  // this deploy's region is ADOPTED from whatever hub exists. Dispatching it
  // while reconciling another region would roll an estate this run never
  // touched — a heal that damages a different estate is worse than no heal.
  const ctx = newStepCtx();
  try {
    writeFileSync(join(ctx.runnerTemp, HEAL_REQ_FILE), healRequest({ sha: AUG19_ROLLED }));
    const r = runStep(HEAL_STEP, { ctx, env: healEnv({ AZURE_LOCATION: 'eastus2' }) });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.dispatches, [], 'nothing may be dispatched at an estate this run did not apply to');
    assert.match(r.out, /rg-csa-loom-admin-eastus2/);
    assert.match(r.out, /rg-csa-loom-admin-centralus/);
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3799: a request that is not a 40-hex SHA is refused before any dispatch', { skip: shellSkip }, () => {
  const ctx = newStepCtx();
  try {
    writeFileSync(join(ctx.runnerTemp, HEAL_REQ_FILE), healRequest({ sha: 'latest' }));
    const r = runStep(HEAL_STEP, { ctx, env: healEnv() });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.dispatches, []);
    assert.match(r.out, /not a 40-hex commit SHA/);
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3676: a regressed app with NO roll lane is reported loudly and NEVER mis-dispatched', { skip: shellSkip }, () => {
  // The defect this replaces: the heal step dispatched loom-roll-and-validate
  // unconditionally, and that lane hard-codes APP_NAME: loom-console. Aiming it
  // at loom-mirroring would have rolled the CONSOLE and then reported a healed
  // estate — a false receipt is strictly worse than an admitted gap.
  const ctx = newStepCtx();
  try {
    writeFileSync(
      join(ctx.runnerTemp, HEAL_REQ_FILE),
      healRequest({
        workflow: null, kind: null, sha: MIRRORING_ROLLED, apps: ['loom-mirroring'],
        why: 'NO automated roll lane exists in this repository for this app.',
      }),
    );
    const r = runStep(HEAL_STEP, { ctx, env: healEnv() });
    assert.equal(r.status, 1, `an un-healable regression is not a pass:\n${r.out}`);
    assert.deepEqual(
      r.dispatches, [],
      'NOTHING may be dispatched for an app no lane can roll — a mis-aimed heal invents a receipt',
    );
    assert.match(r.out, /loom-mirroring/);
    assert.match(r.out, /CANNOT be auto-healed/);
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3676: a data-plane regression dispatches loom-dataplane-roll with the app NAMED', { skip: shellSkip }, () => {
  // loom-unity IS rollable, by a different lane with different inputs. The
  // dispatch must carry apps/tag/boundary/resource_group — an `image_tag` here
  // would silently do nothing, and the poll would then report NOT VERIFIED for
  // a reason that has nothing to do with the estate.
  const ctx = newStepCtx();
  try {
    writeFileSync(
      join(ctx.runnerTemp, HEAL_REQ_FILE),
      healRequest({
        workflow: 'loom-dataplane-roll.yml', kind: 'dataplane',
        sha: AUG19_ROLLED, apps: ['loom-unity'],
      }),
    );
    const r = runStep(HEAL_STEP, {
      ctx,
      azRevisionsByApp: {
        'loom-unity': {
          revisions: [revOf('loom-unity', 'loom-unity--0000010', '2026-08-19T07:10:19+00:00', AUG19_APPLIED, 100)],
          then: [revOf('loom-unity', 'loom-unity--0000011', '2026-08-19T07:40:00+00:00', AUG19_ROLLED, 100)],
        },
      },
      env: healEnv({ AZ_REV_SWITCH_AT: '2' }),
    });
    assert.equal(r.status, 0, `the roll landed on the second poll, so the heal step succeeded:\n${r.out}`);
    assert.equal(r.dispatches.length, 1, JSON.stringify(r.dispatches));
    assert.match(r.dispatches[0], /workflow run loom-dataplane-roll\.yml/);
    assert.match(r.dispatches[0], /apps=loom-unity/);
    assert.match(r.dispatches[0], new RegExp(`tag=${AUG19_ROLLED}`));
    assert.match(r.dispatches[0], /resource_group=rg-csa-loom-admin-centralus/,
      'the data-plane lane defaults to a literal centralus; this deploy ADOPTS its region, so it must be NAMED');
    assert.doesNotMatch(r.dispatches[0], /image_tag=/,
      'image_tag is the CONSOLE lane input — sending it here would be silently ignored');
  } finally {
    ctx.dispose();
  }
});

test('SHELL #3799: an unreadable revision history during the poll never reads as recovery', { skip: shellSkip }, () => {
  const ctx = newStepCtx();
  try {
    writeFileSync(join(ctx.runnerTemp, HEAL_REQ_FILE), healRequest({ sha: AUG19_ROLLED }));
    const r = runStep(HEAL_STEP, {
      ctx,
      env: healEnv({ AZ_REV_ERR: 'ERROR: (AuthorizationFailed) The client does not have authorization' }),
    });
    assert.equal(r.status, 1, `"I could not look" is not "it healed":\n${r.out}`);
    assert.match(r.out, /establishes NOTHING about recovery/);
    assert.match(r.out, /AuthorizationFailed/);
  } finally {
    ctx.dispose();
  }
});

test('CONTRACT #3799: the heal step is wired to the gate, and to the file the gate writes', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const gate = stepBodyByName(yaml, 'Estate must not be BEHIND the last successful roll (#3676)');
  const heal = stepBodyByName(yaml, 'Roll the estate FORWARD to the image this apply overwrote (#3799)');
  assert.ok(heal, 'the auto-heal step is gone — a detected revert would again sit there until something unrelated merges');

  // ANCHORED, AND AGAINST THE STEP — NOT AGAINST THE FILE.
  //
  // The first version of this assertion matched the `if:` string anywhere in a
  // 2332-line workflow and had no end anchor, so appending a condition to the
  // step's own `if:` passed it. Measured: appending
  // `&& inputs.run_mode == 'full'` — which is EMPTY on `schedule`, i.e. it
  // silently kills auto-heal on exactly the nightly runs the 2026-08-19
  // incident happened on — left the suite at 122/122 green. Every shell test
  // executes the extracted `run:` body directly, so nothing else in this file
  // ever observes the condition the runner evaluates.
  assert.match(
    heal, /^\s+if: always\(\) && steps\.estate_behind\.conclusion == 'failure'\s*$/m,
    'the heal step must run on EXACTLY "the gate step failed" — no extra condition. Anything ANDed onto it can ' +
      'scope the heal away from a trigger class (a `run_mode`/`inputs.*` term is empty on schedule) while every ' +
      'other test in this file still passes.',
  );
  // Same literal path on both sides. `$RUNNER_TEMP/x` in one step and
  // `$RUNNER_TEMP/y` in the other is a hand-off that silently never happens.
  // It became NDJSON when the gate went estate-wide (#3676): one dispatch per
  // line, because a single bare SHA cannot say WHICH app regressed and the heal
  // lane differs per app.
  const path = /estate-heal-request\.ndjson/;
  assert.match(gate, path, 'the gate must truncate + name the request file');
  assert.match(heal, path, 'and the heal step must read the same one');
  assert.match(gate, /--heal-request "\$HEAL_REQ"/, 'the CLI needs the path or it writes no request at all');
  assert.equal(
    (gate.match(/--heal-request "\$HEAL_REQ"/g) || []).length, 3,
    'EVERY CLI call site must pass it: a regression can be reached from more than one of them, and a site that ' +
      'omits it detects the revert and then silently declines to heal it',
  );
  assert.match(gate, /: > "\$HEAL_REQ"/, 'and it must be truncated first, so a request can only describe THIS run');

  assert.match(heal, /gh workflow run "\$WF"/, 'it must dispatch the lane the REQUEST names, not one lane for every app');
  assert.match(
    heal, /loom-roll-and-validate\.yml/,
    'and the console lane must still be reachable — it is the writer of the app the incident happened to',
  );
  assert.match(heal, /image_tag=\$\{TARGET\}/, 'with the recovered SHA');
  assert.match(heal, /serving-tag/, 'and verify recovery through the same tested serving logic the gate used');
  for (const re of [/continue-on-error/, /\|\|\s*true/, /2>\s*\/dev\/null/]) {
    assert.ok(!re.test(heal), `the auto-heal step discards a result (${re}); a heal that cannot fail is not a heal`);
  }
  assert.match(heal, /DISPATCH_RC=\$\?/, 'the dispatch must capture its own exit code rather than infer one');
  assert.match(heal, /2> "\$DISPATCH_ERR"/, 'and keep stderr, which is the only thing that says WHY it failed');
  assert.ok(
    !/gh run list|actions\/runs/.test(heal),
    'recovery must be verified against the ESTATE, not the Actions API listing — that index is the source whose ' +
      'lag produced the 2026-08-19 miss in the first place',
  );
  // THE KNOB MUST NOT BECOME THE BYPASS. LOOM_HEAL_POLLS / _SLEEP_SECONDS exist
  // so the extracted-step tests run in milliseconds. If the workflow itself ever
  // sets them, the verification budget becomes a value somebody can quietly edit
  // to nothing — the narrow-bypass shape this repo keeps finding. Nothing in CI
  // sets them, and this asserts that stays true.
  assert.ok(
    !/^\s*LOOM_HEAL_(POLLS|SLEEP_SECONDS):/m.test(yaml),
    'the deploy workflow now SETS a heal-poll knob. Those defaults are the verification budget; pinning them in ' +
      'the workflow makes the budget editable without touching this test.',
  );
});

test('CONTRACT #3799: the estate the heal step would roll is DERIVED from the roll lane, not restated', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const heal = stepBodyByName(yaml, 'Roll the estate FORWARD to the image this apply overwrote (#3799)');
  assert.match(heal, /RG_NAME:/, 'it must read the roll lane\'s own RG_NAME');
  assert.match(heal, /loom-roll-and-validate\.yml/);
  // CONTROL: the derivation only works while the roll lane still declares it at
  // two-space indent, so assert the shape the awk actually matches.
  const rollYaml = readNorm(ROLL_WORKFLOW);
  assert.match(
    rollYaml, /^ {2}RG_NAME: rg-csa-loom-admin-centralus$/m,
    'the roll lane no longer declares RG_NAME where the heal step reads it; the heal step would then refuse every ' +
      'dispatch (safe, and useless) rather than roll the estate forward',
  );
});

// ---------------------------------------------------------------------------
// THE SECOND SHARED-STATE STOMP: THE ACR FIREWALL LEASE (#3676, comment)
//
// The container image is not the only thing these two lanes write over each
// other. On the SAME night, in the same window, five of six app image builds
// failed — not on a build error, on the registry refusing the push.
//
// ROOT CAUSE, MEASURED — and it is neither of the two candidates the report
// listed. The lease did not expire, and no lane released it under the holder:
//
//   07:05:29-07:07:26  roll 32004219673 holds the lease (ttl 15m), releases it
//   07:07:45-07:09:07  deploy 32004118361 holds it for its image preflight
//   07:09:09           the deploy's `az deployment sub create` STARTS
//   07:09:51-07:10:43  the roll holds + releases a second time
//   07:11:16           build 32004290228 takes the lease, TTL 120m, opens ACR
//   07:17:06           last SUCCESSFUL push  (loom-mirroring)
//   07:17:23           first `denied: client with IP ...`  (loom-activator)
//   07:23:58           the apply FINISHES
//   07:35:07           the build's own release reads owner='none'
//
// The build had ~96 minutes of TTL left, so it did not expire. The last
// release by anyone before the lock was 07:10:43, before the build even
// claimed, so nothing released it under the holder. What closed the registry
// was the ARM apply: the template carries
// Microsoft.ContainerRegistry/registries/<acr>, an ARM resource PUT re-asserts
// publicNetworkAccess and REPLACES the resource's tags, and the lease IS four
// ARM tags on that resource. The deploy's own what-if said so at 07:05:39:
//
//     - tags.loomAcrFwExpiresEpoch / HolderUrl / Owner / SinceUtc
//     ~ properties.networkRuleSet.defaultAction: "Deny" => "Allow"
//
// So the fix is the same shape as the image fix: the writer must hold the
// mutex. It needs a CLAIM-ONLY mode, because that writer must not make the
// registry public for the duration of an apply.
// ---------------------------------------------------------------------------

const LEASE_SCRIPT = join(REPO_ROOT, 'scripts', 'csa-loom', 'acr-firewall-lease.sh');
const BUILD_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');

/**
 * The `az` stub is lifted from the lease's own vetted self-test
 * (scripts/ci/test-acr-firewall-lease.sh) so the two cannot disagree about what
 * `az` looks like. It models ONE registry's firewall state and ARM tags in a
 * file; every string asserted on below comes from the REAL script.
 */
const AZ_LEASE_STUB = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  'STATE="${STATE:?}"',
  '. "$STATE"',
  '_put() { sed -i "s|^${1}=.*|${1}=${2}|" "$STATE"; }',
  'QUERY=""; ARGS=()',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    --query) QUERY="$2"; shift 2 ;;',
  '    --subscription) shift 2 ;;',
  '    -o|--output) shift 2 ;;',
  '    *) ARGS+=("$1"); shift ;;',
  '  esac',
  'done',
  'set -- "${ARGS[@]:-}"',
  'case "${1:-}:${2:-}" in',
  '  acr:show)',
  '    case "$QUERY" in',
  "      id)                           printf '/subscriptions/0/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrtest\\n' ;;",
  "      publicNetworkAccess)          printf '%s\\n' \"$PNA\" ;;",
  "      networkRuleSet.defaultAction) printf '%s\\n' \"$DA\" ;;",
  "      tags.loomAcrFwOwner)          printf '%s\\n' \"$OWNER\" ;;",
  "      tags.loomAcrFwExpiresEpoch)   printf '%s\\n' \"$EXPIRES\" ;;",
  "      tags.loomAcrFwHolderUrl)      printf '%s\\n' \"$URL\" ;;",
  "      *) printf '\\n' ;;",
  '    esac ;;',
  '  acr:update)',
  '    echo "ACR_UPDATE_CALLED" >> "$STATE.calls"',
  '    PREV=""',
  '    for a in "$@"; do',
  '      case "$a" in',
  '        true)  [ "$PREV" = "--public-network-enabled" ] && _put PNA Enabled ;;',
  '        false) [ "$PREV" = "--public-network-enabled" ] && _put PNA Disabled ;;',
  '        Allow) _put DA Allow ;;',
  '        Deny)  _put DA Deny ;;',
  '      esac',
  '      PREV="$a"',
  '    done ;;',
  '  tag:update)',
  '    [ "$TAGWRITE" = "ok" ] || { echo "AuthorizationFailed" >&2; exit 1; }',
  '    for a in "$@"; do',
  '      case "$a" in',
  '        loomAcrFwOwner=*)        _put OWNER "${a#*=}" ;;',
  '        loomAcrFwExpiresEpoch=*) _put EXPIRES "${a#*=}" ;;',
  '        loomAcrFwHolderUrl=*)    _put URL "${a#*=}" ;;',
  '      esac',
  '    done ;;',
  'esac',
  'exit 0',
].join('\n');

/**
 * `C:\Users\x` -> `/c/Users/x`.
 *
 * The lease script edits its state through `sed -i "$STATE"`, and under MSYS a
 * Windows-shaped path reaches sed with backslashes and the edit silently does
 * nothing — the close then "fails" through all six verify attempts and the test
 * reports a defect in the subject that is really a defect in the harness.
 * Measured while writing this: 104 seconds and a false red. CI is ubuntu and
 * never hits it, which is exactly why it has to be handled here rather than
 * discovered later.
 */
function toPosixPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.split('\\').join('/');
  return `/${m[1].toLowerCase()}/${m[2].split('\\').join('/')}`;
}

function runLease(args, { state = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acr-lease-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'az'), AZ_LEASE_STUB);
    chmodSync(join(binDir, 'az'), 0o755);
    const statePath = join(dir, 'state.env');
    const s = { PNA: 'Disabled', DA: 'Deny', OWNER: '', EXPIRES: '', URL: '', TAGWRITE: 'ok', ...state };
    writeFileSync(statePath, Object.entries(s).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const ghEnv = join(dir, 'github_env');
    const ghOut = join(dir, 'github_output');
    writeFileSync(ghEnv, '');
    writeFileSync(ghOut, '');
    const res = spawnSync('bash', [toPosixPath(LEASE_SCRIPT), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        // EXPLICITLY CLEARED, not merely "not set". scripts/ci/test-acr-firewall-lease.sh
        // runs earlier in the SAME guardrails job, drives this script with
        // GITHUB_ACTIONS=true against a REAL $GITHUB_ENV, and therefore used to
        // leak its fixture's ACR_LEASE_STATE=held into every later step. This
        // suite then inherited it, and "a process that never held the lease"
        // went red in CI while passing locally. Inheriting ambient state is how
        // a harness ends up testing a different program than it claims to.
        ACR_LEASE_STATE: '',
        LOOM_ACR_LEASE_OWNER: '',
        ...env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        STATE: toPosixPath(statePath),
        GITHUB_ACTIONS: 'true',
        GITHUB_ENV: toPosixPath(ghEnv),
        GITHUB_OUTPUT: toPosixPath(ghOut),
        GITHUB_REPOSITORY: 'acme/csa-inabox',
        GITHUB_RUN_ID: '999',
        LOOM_ACR_LEASE_OPEN_SECONDS: '0',
        LOOM_ACR_LEASE_SETTLE_SECONDS: '0',
        LOOM_ACR_LEASE_WAIT_MINUTES: '0',
        LOOM_ACR_LEASE_TTL_MINUTES: '60',
        LOOM_ACR_CLOSE_ATTEMPTS: '2',
        LOOM_ACR_CLOSE_RETRY_SECONDS: '0',
      },
    });
    const after = Object.fromEntries(
      readFileSync(statePath, 'utf8').split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
    let calls = '';
    try { calls = readFileSync(`${statePath}.calls`, 'utf8'); } catch { calls = ''; }
    return {
      status: res.status,
      out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      state: after,
      calls,
      ghEnv: readFileSync(ghEnv, 'utf8'),
      ghOut: readFileSync(ghOut, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const future = () => String(Math.floor(Date.now() / 1000) + 3600);

test('LEASE: --no-open takes the mutex and leaves the firewall SHUT', { skip: shellSkip }, () => {
  const r = runLease(['acquire', '--acr', 'acrtest', '--no-open'], { env: { LOOM_ACR_LEASE_OWNER: 'deployRun' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.state.OWNER, 'deployRun', 'the mutex must actually be taken');
  assert.equal(r.state.PNA, 'Disabled', 'claim-only must NOT make the registry publicly reachable');
  assert.equal(r.state.DA, 'Deny');
  assert.equal(r.calls, '', 'claim-only must not call `az acr update` at all');
  assert.match(r.out, /CLAIM-ONLY/);
});

test('LEASE: CONTROL — without --no-open, acquire still opens (no regression)', { skip: shellSkip }, () => {
  const r = runLease(['acquire', '--acr', 'acrtest'], { env: { LOOM_ACR_LEASE_OWNER: 'buildRun' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.state.OWNER, 'buildRun');
  assert.equal(r.state.PNA, 'Enabled', 'the ordinary push path must still get an open registry');
  assert.equal(r.state.DA, 'Allow');
});

test('LEASE: --no-open still REFUSES behind a live foreign holder (bounded, loud)', { skip: shellSkip }, () => {
  const r = runLease(['acquire', '--acr', 'acrtest', '--no-open'], {
    state: { OWNER: 'buildRun', EXPIRES: future(), URL: 'https://github.com/acme/csa-inabox/actions/runs/32004290228' },
    env: { LOOM_ACR_LEASE_OWNER: 'deployRun' },
  });
  assert.notEqual(r.status, 0, 'a deploy must not rewrite the registry while a build holds it');
  assert.equal(r.state.OWNER, 'buildRun', 'the holder must be left alone');
  assert.match(r.out, /TIMED OUT/);
  assert.match(r.out, /32004290228/, 'the refusal must name the run that holds it');
});

test('LEASE: acquire PERSISTS its state to $GITHUB_ENV so a later STEP can read it', { skip: shellSkip }, () => {
  const r = runLease(['acquire', '--acr', 'acrtest'], { env: { LOOM_ACR_LEASE_OWNER: 'buildRun' } });
  assert.match(r.ghEnv, /^ACR_LEASE_STATE=held$/m,
    'acquire and release run in different shells in every CI caller; without this the state is always back at ' +
      'its default by release time and "my lease was erased" cannot be told from "I never had one"');
});

test('LEASE: acquire PUBLISHES lease_state to $GITHUB_OUTPUT — the cross-JOB hand-off (BLOCKER)', { skip: shellSkip }, () => {
  // $GITHUB_ENV reaches SUBSEQUENT steps only, and this script is a CHILD of
  // the step that calls it. The build lane's step used to do
  //     bash acr-firewall-lease.sh acquire ...
  //     echo "lease_state=${ACR_LEASE_STATE:-none}" >> "$GITHUB_OUTPUT"
  // which reads its OWN shell, where the variable was never set — measured
  // against the repo's az stub, the lease was HELD and the output said `none`.
  // The whole cross-job hand-off was inert and the erased-lease branch was
  // unreachable in the one workflow that needed it. The previous contract test
  // asserted only that three YAML strings EXISTED, which is presence, not
  // enforcement — this repo's own recurring class.
  const r = runLease(['acquire', '--acr', 'acrtest'], { env: { LOOM_ACR_LEASE_OWNER: 'buildRun' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.ghOut, /^lease_state=held$/m,
    `the step output must carry the REAL state; it read:\n${r.ghOut || '(empty)'}`);
  assert.doesNotMatch(r.ghOut, /^lease_state=none$/m);
});

test('LEASE: claim-only publishes a DISTINCT state, exactly once', { skip: shellSkip }, () => {
  const r = runLease(['acquire', '--acr', 'acrtest', '--no-open'], { env: { LOOM_ACR_LEASE_OWNER: 'deployRun' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.ghOut, /^lease_state=held-claim-only$/m);
  assert.equal(
    (r.ghOut.match(/^lease_state=/gm) || []).length, 1,
    `lease_state was written ${(r.ghOut.match(/^lease_state=/gm) || []).length} times; a duplicated output key ` +
      `leaves the result depending on undocumented runner precedence. Output was:\n${r.ghOut}`,
  );
  assert.equal((r.ghEnv.match(/^ACR_LEASE_STATE=/gm) || []).length, 1);
});

test('LEASE: acquire must NOT export LOOM_ACR_LEASE_OWNER — that hijacks every later lease call', { skip: shellSkip }, () => {
  // LOOM_ACR_LEASE_OWNER is an INPUT override (_lease_parse_args prefers it
  // over the derived id), so putting it in $GITHUB_ENV rewrites the identity of
  // every subsequent acquire/release in the job. Measured on the first CI run
  // of this PR: the guardrails job runs scripts/ci/test-acr-firewall-lease.sh,
  // which drives the real script under GITHUB_ACTIONS=true against a real
  // $GITHUB_ENV, so the self-test's fixture owner ('runA') and state leaked into
  // every later step. The owner needs no carrying — it derives to
  // gha:<repo>:<run id>:<attempt>, identical in both jobs of one run.
  const r = runLease(['acquire', '--acr', 'acrtest', '--no-open'], { env: { LOOM_ACR_LEASE_OWNER: 'deployRun' } });
  assert.doesNotMatch(r.ghEnv, /^LOOM_ACR_LEASE_OWNER=/m,
    `acquire wrote an owner override into $GITHUB_ENV; it read:\n${r.ghEnv}`);
});

test('LEASE: a holder whose lease was ERASED says so, and names the ARM re-render', { skip: shellSkip }, () => {
  // The live 07:35:07 state: this run held the lease, the owner tag now reads
  // 'none', and no one else took over.
  const r = runLease(['release', '--acr', 'acrtest'], {
    state: { PNA: 'Enabled', DA: 'Allow', OWNER: 'none', EXPIRES: '0' },
    env: { LOOM_ACR_LEASE_OWNER: 'buildRun', ACR_LEASE_STATE: 'held' },
  });
  assert.match(r.out, /THE LEASE ON 'acrtest' WAS ERASED WHILE THIS PROCESS HELD IT/);
  assert.match(r.out, /#3676/);
  assert.match(r.out, /is not allowed access/, 'it must connect the cause to the symptom the operator actually saw');
  assert.equal(r.state.PNA, 'Disabled', 'and it must still fail closed');
});

test('LEASE: a CLAIM-ONLY holder does NOT accuse itself — its own apply erased the lease', { skip: shellSkip }, () => {
  // The deploy takes the claim-only lease, its apply deletes the loomAcrFw*
  // tags (#3681), and its release then sees owner=''. Emitting the foreign-
  // erasure ::error:: there would put a red annotation on EVERY healthy nightly
  // whose remediation is "investigate this run" — cry-wolf, and an R7 violation
  // because the code knows exactly who did it.
  const r = runLease(['release', '--acr', 'acrtest'], {
    state: { PNA: 'Disabled', DA: 'Deny', OWNER: 'none', EXPIRES: '0' },
    env: { LOOM_ACR_LEASE_OWNER: 'deployRun', ACR_LEASE_STATE: 'held-claim-only' },
  });
  assert.doesNotMatch(r.out, /WAS ERASED WHILE THIS PROCESS HELD IT/,
    'a claim-only holder must not report its own expected tag deletion as a foreign erasure');
  assert.doesNotMatch(r.out, /::error::.*lease/i, 'and must not emit an error annotation for it at all');
  assert.match(r.out, /THIS RUN'S OWN ARM apply/);
  assert.match(r.out, /#3681/, 'it must point at the tracked cause rather than at an investigation');
  assert.equal(r.state.PNA, 'Disabled', 'and it must still fail closed');
});

test('LEASE: CHAIN — acquire --no-open then release, carrying the state acquire actually produced', { skip: shellSkip }, () => {
  // The two halves are covered separately above, which leaves the LINK between
  // them uncovered: acquire could persist one spelling and release check
  // another and both tests would still pass. This runs the real pair against
  // ONE registry, feeds release exactly the ACR_LEASE_STATE that acquire wrote
  // to $GITHUB_ENV, and simulates the apply in between by wiping the tags the
  // way an ARM PUT does.
  const dir = mkdtempSync(join(tmpdir(), 'acr-chain-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'az'), AZ_LEASE_STUB);
    chmodSync(join(binDir, 'az'), 0o755);
    const statePath = join(dir, 'state.env');
    const write = (s) => writeFileSync(statePath, Object.entries(s).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    write({ PNA: 'Disabled', DA: 'Deny', OWNER: '', EXPIRES: '', URL: '', TAGWRITE: 'ok' });
    const ghEnv = join(dir, 'gh_env');
    writeFileSync(ghEnv, '');

    const base = {
      ...process.env,
      ACR_LEASE_STATE: '',
      LOOM_ACR_LEASE_OWNER: 'deployRun',
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      STATE: toPosixPath(statePath),
      GITHUB_ACTIONS: 'true',
      GITHUB_ENV: toPosixPath(ghEnv),
      GITHUB_OUTPUT: toPosixPath(join(dir, 'gh_out')),
      LOOM_ACR_LEASE_OPEN_SECONDS: '0',
      LOOM_ACR_LEASE_SETTLE_SECONDS: '0',
      LOOM_ACR_LEASE_WAIT_MINUTES: '0',
      LOOM_ACR_CLOSE_ATTEMPTS: '2',
      LOOM_ACR_CLOSE_RETRY_SECONDS: '0',
    };
    writeFileSync(join(dir, 'gh_out'), '');

    const acq = spawnSync('bash', [toPosixPath(LEASE_SCRIPT), 'acquire', '--acr', 'acrtest', '--no-open'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: base });
    assert.equal(acq.status, 0, `${acq.stdout}${acq.stderr}`);

    // The state acquire actually recorded — read, not assumed.
    const envText = readFileSync(ghEnv, 'utf8');
    const carried = /^ACR_LEASE_STATE=(.+)$/m.exec(envText);
    assert.ok(carried, `acquire recorded no state; $GITHUB_ENV was:\n${envText}`);

    // The apply: an ARM PUT replaces the resource's tags (#3681).
    write({ PNA: 'Disabled', DA: 'Deny', OWNER: '', EXPIRES: '', URL: '', TAGWRITE: 'ok' });

    const rel = spawnSync('bash', [toPosixPath(LEASE_SCRIPT), 'release', '--acr', 'acrtest'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...base, ACR_LEASE_STATE: carried[1] } });
    const out = `${rel.stdout ?? ''}${rel.stderr ?? ''}`;
    assert.equal(rel.status, 0, out);
    assert.doesNotMatch(
      out, /WAS ERASED WHILE THIS PROCESS HELD IT/,
      `the claim-only holder accused itself. acquire recorded ${JSON.stringify(carried[1])}; release did not ` +
        'recognise it, so the two halves disagree about the spelling.',
    );
    assert.match(out, /THIS RUN'S OWN ARM apply/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LEASE: the lease self-test does not write into the CALLER\'s $GITHUB_ENV', { skip: shellSkip }, () => {
  // scripts/ci/test-acr-firewall-lease.sh runs inside loom-guardrails.yml with
  // GITHUB_ACTIONS already true. Once the lease script started recording
  // ACR_LEASE_STATE, the self-test's FIXTURE state began leaking into the real
  // job environment — 10 lines, ending ACR_LEASE_STATE=held, injected into every
  // later step. Nothing consumed it, which is exactly why it would have sat
  // there until something did. This is the control for that containment; without
  // it the fix is a line of code with nothing watching it.
  const dir = mkdtempSync(join(tmpdir(), 'acr-selftest-'));
  try {
    const callerEnv = join(dir, 'caller_github_env');
    const callerOut = join(dir, 'caller_github_output');
    writeFileSync(callerEnv, '');
    writeFileSync(callerOut, '');
    const res = spawnSync('bash', [toPosixPath(join(REPO_ROOT, 'scripts', 'ci', 'test-acr-firewall-lease.sh'))], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_ENV: toPosixPath(callerEnv),
        GITHUB_OUTPUT: toPosixPath(callerOut),
        ACR_LEASE_STATE: '',
        LOOM_ACR_LEASE_OWNER: '',
      },
    });
    assert.equal(res.status, 0, `the lease self-test itself failed:\n${res.stdout}${res.stderr}`);
    assert.equal(
      readFileSync(callerEnv, 'utf8'), '',
      `the self-test wrote into the caller's $GITHUB_ENV:\n${readFileSync(callerEnv, 'utf8')}`,
    );
    assert.equal(
      readFileSync(callerOut, 'utf8'), '',
      `the self-test wrote into the caller's $GITHUB_OUTPUT:\n${readFileSync(callerOut, 'utf8')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LEASE: a process that never held the lease does NOT emit the erased-lease error', { skip: shellSkip }, () => {
  // Otherwise the message is noise on every ordinary fail-closed re-lock, and a
  // message that fires on the healthy path teaches people to ignore it.
  const r = runLease(['release', '--acr', 'acrtest'], {
    state: { PNA: 'Enabled', DA: 'Allow', OWNER: 'none', EXPIRES: '0' },
    env: { LOOM_ACR_LEASE_OWNER: 'someRun' },
  });
  assert.doesNotMatch(r.out, /WAS ERASED WHILE THIS PROCESS HELD IT/);
  assert.equal(r.state.PNA, 'Disabled');
});

test('CONTRACT: the deploy takes a CLAIM-ONLY lease before the apply and releases it always', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const take = yaml.indexOf('- name: Take the ACR firewall lease for the apply');
  const provision = yaml.indexOf('- name: Provision (idempotent)');
  const release = yaml.indexOf('- name: Release the ACR firewall lease taken for the apply');
  assert.notEqual(take, -1, 'the apply again rewrites the registry with no mutex — this is the #3676 build kill');
  assert.notEqual(release, -1, 'a lease taken and never released blocks the build lane for its whole TTL');
  assert.ok(take < provision, 'the mutex must be held BEFORE the apply, not after it');
  assert.ok(provision < release, 'and released once the apply is done, so the build lane waits minutes not the TTL');

  const takeBody = stepBodyByName(yaml, 'Take the ACR firewall lease for the apply (claim-only — #3676)');
  assert.ok(takeBody, 'take-lease step not found by exact name');
  assert.match(takeBody, /acr-firewall-lease\.sh acquire .*--no-open/,
    'it must be CLAIM-ONLY: a deploy that opens the registry for a 15-minute apply is a security regression');
  for (const re of [/continue-on-error/, /\|\|\s*true/, /2>\s*\/dev\/null/]) {
    assert.ok(!re.test(takeBody), `the lease step discards a result (${re}) — a lease that cannot fail is not a lease`);
  }

  const releaseBody = stepBodyByName(yaml, 'Release the ACR firewall lease taken for the apply (#3676)');
  assert.ok(releaseBody);
  assert.ok(!/\|\|\s*true/.test(releaseBody),
    'release exits non-zero when it cannot VERIFY the registry locked (C24/#3088); swallowing that is a green ' +
      'step over a publicly reachable registry');
  const releaseIf = yaml.slice(release, release + 400);
  assert.match(releaseIf, /if: always\(\)/,
    'a FAILED apply has written the registry too — the mutex must not outlive the writer');
});

test('CONTRACT: the estate gate reads the REVISION HISTORY, and every CLI call carries it (#3676)', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const body = stepBodyByName(yaml, 'Estate must not be BEHIND the last successful roll (#3676)');
  assert.ok(body, 'estate gate step not found by exact name');

  assert.match(
    body, /az containerapp revision list -n "\$APP"/,
    'without this read the gate is back to asking the Actions API alone — the configuration that reported OK ' +
      'while revisions 0000782 -> 0000783 recorded the revert on 2026-08-19. It must be read PER APP (#3676): a ' +
      'literal -n loom-console here is the single-app gate that left nineteen image writers unwatched',
  );
  assert.doesNotMatch(
    body, /az containerapp (show|revision list) -n loom-console/,
    'a hard-coded console witness is exactly the defect #3676 is about — the app under test comes from the ' +
      'watched-apps list, never from a literal',
  );
  assert.match(
    body, /az containerapp list -g "\$RG"/,
    'the watched population is DERIVED from the post-apply container-app list; without it the gate would need a ' +
      'second hand-maintained copy of APP_IMAGE_TAGS in shell, which is a thing that can drift',
  );
  assert.match(body, /--query "\[\]\.\{name:name, createdTime:properties\.createdTime, trafficWeight:properties\.trafficWeight, image:properties\.template\.containers\[0\]\.image\}"/,
    'the projection must carry name + createdTime + trafficWeight + image. Without the timestamp there is no ' +
      'window; without the WEIGHT (#3798) the gate reads "newest" as "serving" and a weight-0 roll reads as a ' +
      'false green — and the code falls back to recency SILENTLY enough that only this assertion keeps the real ' +
      'lane off that path.');

  // Every reachable invocation must hand the CLI the per-app revision
  // directory. The CLI makes its absence a usage error, but a call site that
  // omits it would then fail for a reason nobody reads as "the gate lost its
  // witness".
  const calls = body.split('node scripts/ci/reconcile-policy.mjs assert-estate-not-behind-roll-all').slice(1);
  assert.equal(calls.length, 3, `expected 3 CLI call sites (no-apps, no-pin, healthy); found ${calls.length}`);
  for (const [i, c] of calls.entries()) {
    // The argument list is the run of backslash-continued lines that follows.
    const args = c.split('\n').reduce((acc, l) => (acc.done ? acc : (acc.lines.push(l), acc.done = !l.trimEnd().endsWith('\\'), acc)), { lines: [], done: false }).lines.join('\n');
    assert.match(
      args, /--app-revisions "\$REVDIR"/,
      `CLI call site ${i} passes no per-app revision evidence; its args were:\n${args}`,
    );
    assert.match(args, /--measured-at/, `CLI call site ${i} passes no --measured-at, so its window is unbounded`);
    assert.match(args, /--heal-request "\$HEAL_REQ"/, `CLI call site ${i} writes no heal request, so a regression it finds cannot be repaired`);
  }
  assert.equal(
    (body.match(/\$\{LIST_ARGS\[@\]\}/g) || []).length, 2,
    'the container-app list result must reach BOTH watched-apps and the assert; the two short-circuit call ' +
      'sites pass --containers-error inline because they never ran az at all',
  );

  assert.match(body, /REV_RC=\$\?/, 'the revision read must capture its own exit code rather than infer one');
  assert.match(body, /LIST_RC=\$\?/, 'and so must the container-app list — an unreadable list is UNKNOWN, not an empty estate');
  assert.match(body, /2> "\$REVDIR\/\$APP\.err"/, 'stderr goes to a per-app file; merging it would splice az warnings into the JSON');
  for (const re of [/continue-on-error/, /\|\|\s*true/, /2>\s*\/dev\/null/]) {
    assert.ok(!re.test(body), `the estate gate discards a result (${re}) — a gate that cannot fail is not a gate`);
  }

  // The window bound comes from the re-pin step, so the two must stay wired.
  const repin = stepBodyByName(yaml, 'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3676)');
  assert.match(repin, /measured_at=\$MEASURED_AT/,
    'the re-pin publishes the window start; without it the estate gate has an unbounded window and refuses');
  assert.match(yaml, /MEASURED_AT: \$\{\{ steps\.repin\.outputs\.measured_at \}\}/,
    'and the estate gate must consume that exact output');
});

test('CONTRACT: the build lane carries ACR_LEASE_STATE across the acquire/release JOB boundary', () => {
  const yaml = readNorm(BUILD_WORKFLOW);
  assert.match(yaml, /lease_state: \$\{\{ steps\.acquire\.outputs\.lease_state \}\}/,
    'acr_enable must publish the lease state; $GITHUB_ENV does not cross jobs, and without this the release ' +
      'job cannot tell an erased lease from one it never held');
  assert.match(yaml, /needs: \[resolve, build, acr_enable\]/,
    'acr_restore must depend on acr_enable or it cannot read those outputs');
  assert.match(yaml, /ACR_LEASE_STATE: \$\{\{ needs\.acr_enable\.outputs\.lease_state \|\| 'none' \}\}/,
    'and it must actually consume it — a published output nobody reads is the guard-adoption gap');
  assert.ok(
    !/LOOM_ACR_LEASE_OWNER:\s*\$\{\{/.test(yaml),
    'the holder id must NOT be carried between the jobs: it is an input override that would replace the derived ' +
      'identity for every later lease call, and it derives identically in both jobs of one run anyway',
  );
  // PRESENCE IS NOT ENFORCEMENT. Every assertion above passed while the
  // hand-off was completely inert, because the acquire step re-derived
  // `${ACR_LEASE_STATE:-none}` in its OWN shell after running the script as a
  // child — always `none`. The behavioural proof that it publishes the truth is
  // the $GITHUB_OUTPUT test above; this is the shape check that the step has
  // not gone back to re-deriving it.
  const acquire = stepBodyByName(yaml, 'Acquire the ACR firewall lease (opens the registry)', 6);
  assert.ok(acquire, 'acquire step not found by name');
  assert.ok(
    !/lease_state=\$\{ACR_LEASE_STATE/.test(acquire),
    'the acquire step re-derives lease_state from its own shell again. The lease script runs as a CHILD, so that ' +
      'variable is unset there and the output is always `none` — measured, with the lease genuinely HELD.',
  );
});

// ---------------------------------------------------------------------------
// CONTRACT — the workflows still carry the shapes these decisions depend on
// ---------------------------------------------------------------------------

test('the roll lane still declares the run-name shape parseRollRunTitle expects', () => {
  const yaml = readNorm(ROLL_WORKFLOW);
  const m = /^run-name:[\s\S]*?\n(?=\S)/m.exec(yaml);
  assert.ok(m, 'loom-roll-and-validate.yml declares no run-name; every automatic roll would then advertise the ' +
    'default-branch head instead of the SHA it rolled (#2963) and the estate gate would have nothing to read.');
  const block = m[0];
  assert.match(block, /workflow_run\.head_sha/, 'the title must come from the ROLLED sha, not github.sha');
  assert.match(block, /roll \$\{\{/, 'the literal prefix `roll ` is what parseRollRunTitle anchors on');
  assert.match(block, /build-triggered/);
  assert.match(block, /manual dispatch/);
});

test('the roll lane still names the job whose conclusion means "an image actually shipped"', () => {
  const yaml = readNorm(ROLL_WORKFLOW);
  const expected = CONSOLE_ROLL_SOURCES.find((s) => s.workflow === 'loom-roll-and-validate.yml').jobPattern;
  assert.ok(
    yaml.includes(`name: ${expected}`),
    `loom-roll-and-validate.yml no longer contains a job named ${JSON.stringify(expected)}. The post-apply gate ` +
      'asks the jobs API for exactly that name; without it every run reports UNKNOWN and the deploy lane goes ' +
      'permanently red for a rename.',
  );
});

test('full-app-deploy-commercial still names the job CONSOLE_ROLL_SOURCES looks for', () => {
  const expected = CONSOLE_ROLL_SOURCES.find((s) => s.workflow === 'full-app-deploy-commercial.yml').jobPattern;
  const yaml = readNorm(join(REPO_ROOT, '.github', 'workflows', 'full-app-deploy-commercial.yml'));
  assert.ok(
    yaml.includes(`name: ${expected}`),
    `full-app-deploy-commercial.yml no longer contains a job named ${JSON.stringify(expected)}, so a roll from ` +
      'that lane would be invisible to the gate and read as a REGRESSION — a false red is how a gate gets ' +
      'switched off.',
  );
});

test('every workflow named in CONSOLE_ROLL_SOURCES exists on disk', () => {
  for (const s of CONSOLE_ROLL_SOURCES) {
    const p = join(REPO_ROOT, '.github', 'workflows', s.workflow);
    assert.doesNotThrow(() => readFileSync(p), `CONSOLE_ROLL_SOURCES names ${s.workflow}, which is not in .github/workflows`);
  }
});

// ---------------------------------------------------------------------------
// ADJACENCY — asserted on EVERY lane that carries the re-pin, not just
// Commercial (#3907).
//
// THE POPULATION IS THE POINT. A guard that examines one lane and skips two is
// the zero-population failure this repo keeps rediscovering, so the population
// is asserted FIRST and by name: a lane that quietly loses its re-pin drops out
// of `REPIN_LANES` and would otherwise take its own coverage with it.
// ---------------------------------------------------------------------------

test('POPULATION: every deploy lane that carries the #3676 re-pin is under the adjacency guard', () => {
  const lanes = REPIN_LANES.map((l) => l.lane);
  // FLOOR, pinned by name. Derivation alone cannot catch a lane that DROPS the
  // re-pin — it would simply leave the population, and a smaller population
  // still passes. These three carry it today (#3683 ported it to the two
  // sovereign lanes), so losing it is a finding about the lane.
  for (const required of ['commercial', 'gcch', 'il5']) {
    assert.ok(
      lanes.includes(required),
      `deploy-fiab-${required}.yml no longer contains a step named "Re-pin appImageTags to the RUNNING images…". ` +
        'Either the re-pin was removed — reopening the #3676 window on that boundary — or it was renamed, which ' +
        'silently drops the lane out of this guard entirely. Both are defects; neither is a reason to edit this list.',
    );
  }
  assert.ok(
    lanes.length >= 3,
    `only ${lanes.length} deploy lane(s) carry the re-pin: ${JSON.stringify(lanes)}`,
  );
  // Reported, not merely asserted: the acceptance criterion for #3907 is the
  // POPULATION, and a verdict with no population is what let the gap live.
  console.log(`# roll-race adjacency population: ${lanes.length} lane(s) — ${lanes.join(', ')}`);
});

for (const lane of REPIN_LANES) {
  test(`[${lane.lane}] the re-pin is the LAST step before the apply — nothing may sit between them`, () => {
    // ADJACENCY, not ordering. The first version of this test asserted only
    // `repin < provision`, so an arbitrarily long step could sit between them and
    // it stayed green — and one did: the ACR lease step, whose bounded wait is up
    // to EIGHT MINUTES and whose whole purpose is to wait for the roll lane, i.e.
    // exactly the writer that invalidates the measurement. A measurement is only
    // as fresh as the last thing that happens before it is used.
    const { steps, repinIdx: i } = lane;
    assert.equal(
      steps[i].id, 'repin',
      `${lane.file}: the re-pin step declares id ${JSON.stringify(steps[i].id)}, not "repin". The lane's own ` +
        'downstream `if:` conditions key on that id, and so does this guard.',
    );
    const next = steps[i + 1];
    assert.ok(next, `${lane.file}: the re-pin is the LAST step in the job — there is no apply after it at all`);
    assert.equal(
      next.id, 'provision',
      `${lane.file}: the step immediately after the re-pin is ${JSON.stringify(next.name)} (id ` +
        `${JSON.stringify(next.id)}), not the apply. Whatever it is, its duration is added to the staleness of ` +
        'the measurement the re-pin exists to keep fresh. The lanes spell the apply differently — that is why ' +
        'this asserts the id and not the display name.',
    );
  });
}

test('[commercial] the ACR firewall lease is taken BEFORE the re-pin, not between it and the apply', () => {
  // Commercial-scoped ON PURPOSE, and said so rather than implied: gcch and il5
  // have no `Take the ACR firewall lease for the apply` step at all — measured,
  // 0 occurrences in either file — because those lanes do not open the registry
  // from this job. Asserting its presence there would be a false red about a
  // step that does not belong to them. The ADJACENCY invariant above is what is
  // shared, and it is asserted on all three.
  const commercial = REPIN_LANES.find((l) => l.lane === 'commercial');
  assert.ok(commercial, 'the Commercial lane is missing from the re-pin population');
  const before = commercial.steps.slice(0, commercial.repinIdx).map((s) => s.name);
  assert.ok(
    before.some((n) => n.startsWith('Take the ACR firewall lease for the apply')),
    'the ACR lease must be taken BEFORE the re-pin: its wait is for the roll lane, so waiting after measuring ' +
      'reopens the exact window being narrowed',
  );
});

test('CONTRACT #3676: every lane ESTATE_ROLL_LANES names EXISTS and takes the inputs the heal step sends it', () => {
  // A dispatch at a workflow that does not exist, or with an input it does not
  // declare, fails at the API — and the failure text ("workflow does not have
  // input X") reads as a repository defect long after the estate has been left
  // on the overwritten image. The table is checked against the files here so
  // that drift breaks a test rather than a 3am heal.
  const wfNames = new Set(Object.values(ESTATE_ROLL_LANES).map((l) => l.workflow));
  assert.ok(wfNames.size >= 2, 'both a console lane and a data-plane lane must be reachable');

  for (const wf of wfNames) {
    const p = join(WORKFLOW_DIR, wf);
    assert.ok(existsSync(p), `ESTATE_ROLL_LANES points at ${wf}, which does not exist — the heal would 404`);
  }

  // The console lane takes `image_tag`; the data-plane lane takes
  // apps/tag/boundary/resource_group. These are the exact flags the heal step
  // builds in DISPATCH_ARGS, so the two lists must agree.
  const consoleWf = readNorm(join(WORKFLOW_DIR, ESTATE_ROLL_LANES[CONSOLE_APP_NAME].workflow));
  assert.match(consoleWf, /^ {6}image_tag:/m, 'the console roll lane must still take image_tag');

  const dpLane = Object.entries(ESTATE_ROLL_LANES).find(([, l]) => l.kind === 'dataplane');
  assert.ok(dpLane, 'a data-plane lane must be declared, or a loom-unity revert can never be healed');
  const dpWf = readNorm(join(WORKFLOW_DIR, dpLane[1].workflow));
  for (const input of ['boundary', 'apps', 'tag', 'resource_group']) {
    assert.match(
      dpWf, new RegExp(`^ {6}${input}:`, 'm'),
      `${dpLane[1].workflow} declares no '${input}' input, but the heal step sends -f ${input}=… for a data-plane regression`,
    );
  }
  // `boundary` is a choice; `commercial` is the literal this deploy lane sends.
  assert.match(dpWf, /^ {10}- commercial$/m,
    "the heal step sends boundary=commercial; a choice input that does not offer it would reject the dispatch");
});

test('the deploy lane still runs the post-apply estate-vs-roll gate, and it cannot be skipped away', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const i = yaml.indexOf('- name: Estate must not be BEHIND the last successful roll');
  assert.notEqual(i, -1, 'the post-apply regression gate is gone — a backwards move would again produce no signal');
  const step = yaml.slice(i, i + 2500);
  // ANCHORED — the same lesson as the heal step's `if:`. An unanchored match
  // accepts `&& inputs.run_mode == 'full'` appended to it, which is empty on
  // `schedule` and would switch the gate off on precisely the trigger the
  // #3676 incidents happened on, with every other test still green.
  assert.match(step, /^\s+if: always\(\) && steps\.provision\.conclusion != 'skipped'\s*$/m,
    'the gate must run even when the apply FAILED (a failed apply can still have written the container app), and ' +
      'on EXACTLY that condition — an extra ANDed term can scope it away from a whole trigger class');
  // The BODY, not a fixed-width slice. The first draft of this assertion read
  // `yaml.slice(i, i + 2500)` and went RED the moment #3676 added comments to
  // the step, because the CLI invocation moved past character 2500 — a test
  // that fails when a COMMENT is added is measuring the wrong thing.
  const body = stepBodyByName(yaml, 'Estate must not be BEHIND the last successful roll (#3676)');
  assert.ok(body, 'estate gate step not found by exact name');
  assert.ok(!/continue-on-error/.test(body), 'a gate whose result is discarded is not a gate');
  assert.match(body, /assert-estate-not-behind-roll-all/,
    'the gate must run the ESTATE-WIDE form — the single-app form watched one writer out of twenty (#3676)');
});

/**
 * One workflow STEP, sliced by its `- name:` line at six-space indent, with
 * every comment line removed.
 *
 * Stripping comments is not tidiness — the first draft of the test below
 * matched `2>/dev/null` inside the Provision step's own COMMENT explaining why
 * a `2>/dev/null` had been removed, and reported a violation that did not
 * exist. A guard keyed to a string that also appears in prose about that string
 * is the same defect class as one keyed to a string that never appears.
 */
function stepBodyByName(yaml, name, indent = 6) {
  const pad = ' '.repeat(indent);
  const start = yaml.indexOf(`${pad}- name: ${name}`);
  if (start === -1) return null;
  const rest = yaml.slice(start + 1);
  const nextRel = rest.search(new RegExp(`\\n {${indent}}- name: `));
  const body = nextRel === -1 ? rest : rest.slice(0, nextRel);
  return body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('neither new deploy step discards a result (no continue-on-error / || true / 2>/dev/null)', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const names = [
    'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3676)',
    'Estate must not be BEHIND the last successful roll (#3676)',
  ];
  const forbidden = [/continue-on-error/, /\|\|\s*true/, /2>\s*\/dev\/null/];
  for (const name of names) {
    const body = stepBodyByName(yaml, name);
    assert.ok(body, `step ${JSON.stringify(name)} not found — it was renamed or removed`);
    assert.ok(body.length > 300, `step ${JSON.stringify(name)} sliced to ${body.length} bytes; the slicer is wrong`);
    for (const re of forbidden) {
      assert.ok(
        !re.test(body),
        `step ${JSON.stringify(name)} contains ${re} — deploy-integrity.md forbids a deploy step whose result is ` +
          'discarded, and a 2>/dev/null once turned a permission denial into a false "the tag does not exist".',
      );
    }
    assert.match(body, /2> "\$\w+"/, 'stderr must be CAPTURED to a file that is then read, not merged and not dropped');
  }
});

test('the gate keeps actions:read and the auto-heal gets actions:write on the JOB, not the whole workflow', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const m = /^permissions:\n((?:[ \t]+\S.*\n|[ \t]*#.*\n)+)/m.exec(yaml);
  assert.ok(m, 'deploy-fiab-commercial.yml declares no top-level permissions block');
  assert.match(m[1], /^\s*actions:\s*read\s*$/m,
    'without actions:read the gh calls in the estate gate 403 and the gate reports UNKNOWN forever — a ' +
      'permanently red deploy lane reads as a broken deploy path (deploy-integrity R1)');

  // The dispatch needs WRITE, and it is scoped to the one job that dispatches.
  // A workflow-level `actions: write` would hand every other job in the file
  // run-delete / artifact-delete / cancel for no reason.
  const jobAt = yaml.indexOf('    name: Deploy + validate CSA Loom in Commercial');
  assert.notEqual(jobAt, -1, 'the deploy-validate job was renamed; this assertion is looking at the wrong job');
  const jobHead = yaml.slice(jobAt, jobAt + 1600);
  const jobPerms = /\n {4}permissions:\n((?: {6}\S.*\n)+)/.exec(jobHead);
  assert.ok(jobPerms, 'the deploy-validate job declares no permissions block, so it inherits the workflow-level ' +
    'one — and the auto-heal dispatch (#3799) would 403 on the one run where the estate is already wrong');
  assert.match(jobPerms[1], /^\s*actions:\s*write\s*$/m, 'the dispatch needs actions:write');
  assert.match(jobPerms[1], /^\s*contents:\s*read\s*$/m,
    'a job-level block REPLACES the workflow-level one, so the checkout still needs contents:read here');
  assert.match(jobPerms[1], /^\s*issues:\s*write\s*$/m,
    'and the failure-notify step still needs issues:write for the same reason');
});

// ---------------------------------------------------------------------------
// CONTROL — these must stay GREEN under every mutation above. If one of these
// goes red, the harness broke, not the subject.
// ---------------------------------------------------------------------------

test('CONTROL: the fixtures parse into the console key the table actually declares', () => {
  const r = resolveRunningImageTags(estateAt(ROLLED));
  assert.equal(r.probed, true);
  assert.equal(r.pinned[CONSOLE_IMAGE_KEY], ROLLED);
  assert.ok(APP_IMAGE_TAGS.some((e) => e.key === CONSOLE_IMAGE_KEY && e.repo === 'loom-console'));
});

test('CONTROL: SHA_TAG_RE accepts a real commit SHA and rejects a floating tag', () => {
  assert.ok(SHA_TAG_RE.test(ROLLED));
  assert.ok(!SHA_TAG_RE.test('latest'));
  assert.ok(!SHA_TAG_RE.test(ROLLED.toUpperCase()));
});

test('CONTROL: both workflow files are readable and non-trivial', () => {
  for (const p of [ROLL_WORKFLOW, DEPLOY_WORKFLOW]) {
    const text = readNorm(p);
    assert.ok(text.length > 5000, `${p} read as ${text.length} bytes — the harness is looking at the wrong file`);
    assert.match(text, /^jobs:$/m);
  }
});

test('CONTROL: every verdict this file can produce is a real verdict with a real reason', () => {
  const cases = [
    decideEstateRegression({ appliedTag: '', estateTag: null, rollSelection: null }),
    decideEstateRegression({ appliedTag: STALE, estateTag: null, rollSelection: selectLastConsoleRoll([]) }),
    decideEstateRegression({ appliedTag: STALE, estateTag: STALE, rollSelection: selectLastConsoleRoll(null) }),
  ];
  for (const c of cases) {
    assert.ok(['ok', 'regression', 'unknown'].includes(c.verdict));
    assert.ok(typeof c.reason === 'string' && c.reason.length > 30, `thin reason: ${c.reason}`);
  }
});

// ==========================================================================
// #4148 — THE DURABILITY-PIN RACE IN loom-dataplane-roll.yml
// ==========================================================================
//
// Controls for the DURABILITY-PIN RACE in .github/workflows/loom-dataplane-roll.yml
// (#4148).
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
// Read out of run 33129547662's log, not inferred:
//
//   00:28:19-00:28:32  `az acr import` retagged loom-trino and loom-unity onto
//                      :v0.1. Both succeeded. This happened OUTSIDE the ACR
//                      firewall lease, because a control-plane import does not
//                      need the data plane.
//   00:28:32-00:51:14  the step then BLOCKED 22.5 minutes (to attempt 52) at
//                      the lease acquire, which it takes only for the read-back.
//                      The lease was held by run 33129550648
//                      (build-fiab-images-acr-tasks, sha 89153a31,
//                      00:23:15 -> 00:50:53).
//   00:51:14           by then that build had repointed :v0.1. The read-back
//                      emitted
//                        loom-trino:v0.1 resolves to sha256:4a96038a…, not the
//                        rolled digest sha256:5d52d40b… The pin did NOT land
//                      — a cause the code never established. The import DID
//                      land; it was superseded.
//   and then           the rollback gate `if: failure() && steps.roll.outcome ==
//                      'success'` fired and REVERTED a roll whose own health and
//                      live-image verification had both passed, printing
//                        A post-roll gate failed (health=success, verify=success)
//
// So: a write and its verification in two separate critical sections with an
// unbounded gap; a message asserting a cause it had not established
// (deploy-integrity.md R7); and an auto-rollback of a verified-live estate on
// the strength of a registry tag race.
//
// NOTE the issue's own stated fix — "wire the step through deploy-retry.mjs" —
// is wrong: it already is (loom-dataplane-roll.yml, the `--step "pin …"`
// invocation). That was a red herring from the auto-filed classification
// comment, and following it would have changed nothing.
//
// ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
// The REAL pin step, extracted from the workflow YAML and EXECUTED under bash in
// a sandbox working directory. Nothing is re-implemented here. The step invokes
// its three collaborators through explicit interpreters at repo-relative paths —
//
//     bash scripts/csa-loom/acr-firewall-lease.sh …
//     node scripts/ci/deploy-retry.mjs … -- az acr import …
//     bash scripts/ci/resolve-acr-digest.sh …
//
// — so the sandbox supplies stubs at exactly those paths and real bash/node run
// them. Each stub APPENDS TO AN ORDERED EVENT LOG, which is what makes the
// ordering claim a measurement rather than a reading of the source text. The
// step's own bytes are never rewritten except by a test that says it is
// mutating, and a harness control asserts that.
//
// The rollback gate is a workflow `if:`, so it is checked by translating that
// expression to JS and evaluating it over step outcomes. The translator refuses
// any construct it does not model rather than silently mis-evaluating one.

const WF = join(REPO_ROOT, '.github', 'workflows', 'loom-dataplane-roll.yml');
const PIN_STEP = 'Pin the verified digest onto :v0.1 (deploy durability)';
const ROLLBACK_STEP = 'Roll back on failure';

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const WANT_UNITY = 'sha256:5d52d40bfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
const WANT_TRINO = 'sha256:5d52d40bcafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const OTHER = 'sha256:4a96038adeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TAG = '89153a31';
const ACR = 'acrloomtest';

// ── Extracting the shipped step ─────────────────────────────────────────────

const wfLines = () => readFileSync(WF, 'utf8').split(/\r?\n/);

/**
 * Pull a step's `run:` block out of the workflow as text.
 *
 * Deliberately NOT a YAML library: the `guardrails` job that runs this suite
 * does `actions/setup-node` and no install, so a third-party import would make
 * the whole file throw — and a suite that cannot load is a suite that enforces
 * nothing. Same approach gov-bff-probe-scope.test.mjs takes.
 *
 * Every failure mode throws rather than returning something empty: an extractor
 * that silently yielded `''` would make every case below "pass" by running no
 * script at all.
 */
function stepRun(stepName) {
  const lines = wfLines();
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `workflow step "${stepName}" not found in ${WF} — renamed or removed?`);
  let runAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) break;
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) { runAt = i; break; }
  }
  assert.ok(runAt >= 0, `no "run: |" block under "${stepName}"`);
  const runIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^\s*/)[0].length <= runIndent) break;
    body.push(l.slice(runIndent + 2));
  }
  const script = body.join('\n');
  // The split/join normalises line endings on purpose. A Windows checkout hands
  // this file back CRLF; the mutation needles below match on plain LF, and a
  // stray \r would make those `replace()` calls silently no-op — the mutation
  // then "passes" by having changed nothing at all.
  assert.ok(!script.includes('\r'), 'extracted script carries CR — the mutation needles below would no-op');
  return script;
}

function pinScript() {
  const script = stepRun(PIN_STEP);
  assert.ok(script.includes('az acr import'), 'the extracted pin step issues no retag — extraction has drifted');
  assert.ok(
    script.includes('acr-firewall-lease.sh acquire'),
    'the extracted pin step acquires no lease — extraction has drifted',
  );
  assert.ok(script.includes('resolve-acr-digest.sh'), 'the extracted pin step reads nothing back');
  return script;
}

/** A step's `if:` expression, folded scalar included, as one line. */
function stepIf(stepName) {
  const lines = wfLines();
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `workflow step "${stepName}" not found`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) break;
    const m = lines[i].match(/^(\s*)if:\s*(.*)$/);
    if (!m) continue;
    const [, indent, rest] = m;
    if (rest.trim() !== '>-' && rest.trim() !== '>' && rest.trim() !== '') return rest.trim();
    const parts = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^\s*/)[0].length <= indent.length) break;
      parts.push(lines[j].trim());
    }
    assert.ok(parts.length > 0, `the folded if: under "${stepName}" is empty`);
    return parts.join(' ');
  }
  assert.fail(`no if: found on step "${stepName}"`);
}

// ── The sandbox ─────────────────────────────────────────────────────────────

const LEASE_STUB = `#!/usr/bin/env bash
# Harness stub for scripts/csa-loom/acr-firewall-lease.sh. Records the call in
# ORDER, which is the whole point: the ordering claim is measured, not read.
ACTION="\${1:-}"
printf '%s\\n' "lease:\${ACTION}" >> "\$EVENT_LOG"
if [ "\$ACTION" = "acquire" ]; then exit "\${STUB_ACQUIRE_RC:-0}"; fi
exit "\${STUB_RELEASE_RC:-0}"
`;

const RETRY_STUB = `// Harness stub for scripts/ci/deploy-retry.mjs. Records the retag it was asked
// to perform, in order, and honours STUB_IMPORT_FAIL_REPO.
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const i = argv.indexOf('--');
const cmd = i >= 0 ? argv.slice(i + 1) : argv;
const at = (flag) => { const k = cmd.indexOf(flag); return k >= 0 ? cmd[k + 1] : ''; };
const source = at('--source');
const image = at('--image');
appendFileSync(process.env.EVENT_LOG, \`import:\${source}->\${image}\\n\`);
const fail = process.env.STUB_IMPORT_FAIL_REPO || '';
process.exit(fail && image.startsWith(fail) ? 1 : 0);
`;

const RESOLVE_STUB = `#!/usr/bin/env bash
# Harness stub for scripts/ci/resolve-acr-digest.sh. Answers from a fixture map
# and records the read in ORDER. An image with no fixture exits LOUDLY (9)
# rather than answering empty — an unfixtured read must never look like a pass.
IMAGE=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --image) IMAGE="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' "resolve:\${IMAGE}" >> "\$EVENT_LOG"
ROW="\$(awk -F'\\t' -v im="\$IMAGE" '\$1 == im { print \$2 "\\t" \$3; exit }' "\$STUB_DIGEST_MAP")"
if [ -z "\$ROW" ]; then
  echo "stub: no fixture for '\$IMAGE'" >&2
  exit 9
fi
RC="\$(printf '%s' "\$ROW" | cut -f1)"
DG="\$(printf '%s' "\$ROW" | cut -f2)"
if [ "\$RC" != "0" ]; then exit "\$RC"; fi
printf '%s\\n' "\$DG"
`;

const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

/**
 * Run the pin step in a sandbox.
 *
 * `digests` is the .roll/digests.tsv the roll produced. `registry` is what the
 * resolver answers for each image ref: `[image, rc, digest]`. Anything the step
 * reads that is not in `registry` fails loudly, so a test cannot pass by reading
 * nothing.
 */
function runPin(script, { digests, registry, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-race-'));
  mkdirSync(join(dir, 'scripts', 'csa-loom'), { recursive: true });
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, '.roll'), { recursive: true });

  writeFileSync(join(dir, 'scripts', 'csa-loom', 'acr-firewall-lease.sh'), LEASE_STUB, 'utf8');
  writeFileSync(join(dir, 'scripts', 'ci', 'deploy-retry.mjs'), RETRY_STUB, 'utf8');
  writeFileSync(join(dir, 'scripts', 'ci', 'resolve-acr-digest.sh'), RESOLVE_STUB, 'utf8');
  writeFileSync(
    join(dir, '.roll', 'digests.tsv'),
    `${digests.map(([r, d]) => `${r}\t${d}`).join('\n')}\n`,
    'utf8',
  );
  const mapPath = join(dir, 'digest-map.tsv');
  writeFileSync(mapPath, `${registry.map((r) => r.join('\t')).join('\n')}\n`, 'utf8');
  const logPath = join(dir, 'events.log');
  writeFileSync(logPath, '', 'utf8');

  const stepPath = join(dir, 'pin.sh');
  writeFileSync(stepPath, script, 'utf8');

  const r = spawnSync('bash', [stepPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      TAG,
      ACR,
      ACR_LOGIN: `${ACR}.azurecr.io`,
      EVENT_LOG: posix(logPath),
      STUB_DIGEST_MAP: posix(mapPath),
      ...env,
    },
  });
  const events = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, events, dir, stepPath };
}

const errors = (out) => out.split('\n').filter((l) => l.includes('::error::'));

/** A clean two-repo roll whose :v0.1 read-back matches. */
const HAPPY = {
  digests: [['loom-unity', WANT_UNITY], ['loom-trino', WANT_TRINO]],
  registry: [
    ['loom-unity:v0.1', '0', WANT_UNITY],
    ['loom-trino:v0.1', '0', WANT_TRINO],
    [`loom-unity:${TAG}`, '0', WANT_UNITY],
    [`loom-trino:${TAG}`, '0', WANT_TRINO],
  ],
};

/**
 * The measured incident: :v0.1 was superseded by a concurrent build while the
 * SOURCE tag still carries the digest this run rolled.
 */
const SUPERSEDED = {
  digests: [['loom-trino', WANT_TRINO]],
  registry: [
    ['loom-trino:v0.1', '0', OTHER],
    [`loom-trino:${TAG}`, '0', WANT_TRINO],
  ],
};

// ── Harness integrity ───────────────────────────────────────────────────────

test('HARNESS: the script bash executes IS the shipped step, byte for byte', { skip: !bashAvailable }, () => {
  const script = pinScript();
  const r = runPin(script, HAPPY);
  assert.equal(readFileSync(r.stepPath, 'utf8'), script,
    'the harness rewrote the subject — every assertion below would then be about the harness');
});

test('HARNESS: the collaborators the step calls exist at those paths in the real repo', () => {
  const fileExists = (p) => { try { readFileSync(p); return true; } catch { return false; } };
  // If a collaborator were renamed, the sandbox would keep answering on the old
  // path and this suite would go on "passing" over a step that cannot run.
  for (const rel of [
    'scripts/csa-loom/acr-firewall-lease.sh',
    'scripts/ci/deploy-retry.mjs',
    'scripts/ci/resolve-acr-digest.sh',
  ]) {
    assert.ok(fileExists(join(REPO_ROOT, rel)), `${rel} no longer exists — the stub shadows a path that is gone`);
    assert.ok(pinScript().includes(rel), `the pin step no longer calls ${rel} — this suite stubs the wrong thing`);
  }
});

test('HARNESS: an image the fixture map does not cover fails LOUDLY', { skip: !bashAvailable }, () => {
  // Otherwise a test could pass by reading nothing at all.
  const r = runPin(pinScript(), {
    digests: [['loom-unity', WANT_UNITY]],
    registry: [[`loom-unity:${TAG}`, '0', WANT_UNITY]], // :v0.1 deliberately absent
  });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /resolver exit 9/);
});

// ── 1. ATOMICITY: the lease is held across the write AND the verify ─────────

test('ORDERING: the lease is acquired BEFORE the first retag, and released after the read-back', { skip: !bashAvailable }, () => {
  const r = runPin(pinScript(), HAPPY);
  assert.equal(r.status, 0, r.out);

  const firstAcquire = r.events.indexOf('lease:acquire');
  const firstImport = r.events.findIndex((e) => e.startsWith('import:'));
  const lastResolve = r.events.map((e) => e.startsWith('resolve:')).lastIndexOf(true);
  const release = r.events.indexOf('lease:release');

  assert.ok(firstAcquire >= 0, `no lease acquire was observed:\n${r.events.join('\n')}`);
  assert.ok(firstImport >= 0, `no retag was observed:\n${r.events.join('\n')}`);
  assert.ok(lastResolve >= 0, `no read-back was observed:\n${r.events.join('\n')}`);
  assert.ok(release >= 0, `the lease was never released:\n${r.events.join('\n')}`);

  assert.ok(firstAcquire < firstImport,
    `the retag ran OUTSIDE the lease — that is the #4148 race window:\n${r.events.join('\n')}`);
  assert.ok(lastResolve < release,
    `the read-back ran after the lease was released:\n${r.events.join('\n')}`);
  // Exactly one acquire: a second one would mean two critical sections again.
  assert.equal(r.events.filter((e) => e === 'lease:acquire').length, 1, r.events.join('\n'));
  assert.equal(r.events.filter((e) => e === 'lease:release').length, 1, r.events.join('\n'));
});

test('ORDERING MUTATION: the pre-fix order puts the retag OUTSIDE the lease', { skip: !bashAvailable }, () => {
  // The regression reintroduced, by swapping the two blocks back the way they
  // were. If the ordering assertion above could not see this, it would be
  // asserting nothing about where the lease is taken.
  const r = runPin(preFixOrdering(pinScript()), HAPPY);
  const firstAcquire = r.events.indexOf('lease:acquire');
  const firstImport = r.events.findIndex((e) => e.startsWith('import:'));
  assert.ok(firstImport >= 0 && firstAcquire >= 0, r.events.join('\n'));
  assert.ok(firstImport < firstAcquire,
    `the pre-fix transform did not actually restore the old order:\n${r.events.join('\n')}`);
});

test('LEASE REFUSED: nothing is retagged, and the message says so', { skip: !bashAvailable }, () => {
  // With the lease taken first, a refusal means no write happened — a better
  // and TRUER state than the old ordering could report, which had already
  // issued the retags before discovering it could not verify them.
  const r = runPin(pinScript(), { ...HAPPY, env: { STUB_ACQUIRE_RC: '1' } });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.events.filter((e) => e.startsWith('import:')).length, 0,
    `a retag was issued despite the lease being refused:\n${r.events.join('\n')}`);
  assert.match(errors(r.out)[0], /NO retag was attempted and :v0\.1 is unchanged/);
});

test('LEASE REFUSED MUTATION: under the pre-fix order the retags were already issued', { skip: !bashAvailable }, () => {
  const r = runPin(preFixOrdering(pinScript()), { ...HAPPY, env: { STUB_ACQUIRE_RC: '1' } });
  assert.equal(r.events.filter((e) => e.startsWith('import:')).length, 2,
    `the pre-fix order must show the writes happening before the refusal:\n${r.events.join('\n')}`);
});

/**
 * Rebuild the PRE-FIX ordering: move the lease acquisition back to AFTER the
 * import loop. A deterministic block swap on the extracted text — it fails loudly
 * if either block cannot be located, so it can never silently no-op.
 */
function preFixOrdering(script) {
  const leaseStart = script.indexOf('LEASE_HELD=0');
  const leaseEnd = script.indexOf('LEASE_HELD=1');
  assert.ok(leaseStart >= 0 && leaseEnd > leaseStart, 'could not locate the lease block');
  const leaseBlock = script.slice(leaseStart, leaseEnd + 'LEASE_HELD=1'.length);

  const impStart = script.indexOf('IMPORT_FAILED=0');
  assert.ok(impStart > leaseEnd, 'the import loop is not after the lease block — already pre-fix?');
  const impEnd = script.indexOf('done < .roll/digests.tsv', impStart);
  assert.ok(impEnd > impStart, 'could not locate the end of the import loop');
  const importBlock = script.slice(impStart, impEnd + 'done < .roll/digests.tsv'.length);

  // Replacer FUNCTIONS, not strings. `String.replace` interprets `$'` in a
  // string replacement, and both blocks contain `IFS=$'\t'` — with a plain
  // string replacement the swap silently corrupts the script instead of moving
  // it, and the "mutation" would then be testing garbage.
  const L = '@@LEASE_SLOT@@';
  const I = '@@IMPORT_SLOT@@';
  assert.ok(!script.includes(L) && !script.includes(I), 'the sentinels collide with the step text');
  const swapped = script
    .replace(leaseBlock, () => L)
    .replace(importBlock, () => I)
    .replace(L, () => importBlock)
    .replace(I, () => leaseBlock);
  assert.ok(!swapped.includes(L) && !swapped.includes(I), 'the block swap did not complete');
  assert.notEqual(swapped, script, 'the swap changed nothing — this proof no longer targets the ordering');
  assert.ok(
    swapped.indexOf('IMPORT_FAILED=0') < swapped.indexOf('acr-firewall-lease.sh acquire'),
    'the swap did not put the retag loop ahead of the acquire',
  );
  return swapped;
}

// ── 2. R7: a :v0.1 mismatch must not assert a cause it did not establish ────

test('SUPERSEDED: a mismatch re-resolves the SOURCE tag and reports supersession, NOT "the pin did NOT land"', { skip: !bashAvailable }, () => {
  const r = runPin(pinScript(), SUPERSEDED);
  assert.notEqual(r.status, 0, 'durability is genuinely not established — the step must still fail');

  // The discriminating read actually happened.
  assert.ok(r.events.includes(`resolve:loom-trino:${TAG}`),
    `the step did not re-resolve the source tag, so it cannot have distinguished the two causes:\n${r.events.join('\n')}`);

  const [line, ...rest] = errors(r.out);
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /SUPERSEDED by a later write/);
  assert.match(line, /STILL resolves to/);
  assert.match(line, /does NOT claim the import failed/);
  // deploy-integrity.md R7 — the exact false sentence from run 33129547662.
  assert.ok(!/The pin did NOT land/.test(line), `the step still asserts a cause it did not establish:\n${line}`);
  // And it says what IS established, rather than only what it will not claim.
  assert.match(line, /does not currently carry the rolled digest/);
  assert.match(line, /NOT rolled back for this/);
});

test('SUPERSEDED MUTATION: without the source re-resolution the step cannot tell the two apart', { skip: !bashAvailable }, () => {
  // Kill the discriminator and the same registry state is reported as a
  // different, and false, story about the source tag.
  const src = pinScript();
  const mutated = src.replace('elif [ "$SRC_NOW" = "$WANT_DIGEST" ]; then', 'elif false; then');
  assert.notEqual(mutated, src, 'the supersession discriminator moved — this proof no longer targets it');
  const r = runPin(mutated, SUPERSEDED);
  assert.notEqual(r.status, 0, r.out);
  const [line] = errors(r.out);
  assert.ok(!/SUPERSEDED/.test(line),
    `the supersession verdict must come from the discriminator, not from anywhere else:\n${line}`);
  assert.match(line, /has ALSO moved/); // i.e. it now says something untrue
});

test('SOURCE TAG ALSO MOVED: reported as UNKNOWN, not as supersession', { skip: !bashAvailable }, () => {
  const r = runPin(pinScript(), {
    digests: [['loom-trino', WANT_TRINO]],
    registry: [
      ['loom-trino:v0.1', '0', OTHER],
      [`loom-trino:${TAG}`, '0', OTHER],
    ],
  });
  assert.notEqual(r.status, 0, r.out);
  const [line] = errors(r.out);
  assert.match(line, /has ALSO moved/);
  assert.match(line, /which write won is UNKNOWN/);
  assert.ok(!/SUPERSEDED/.test(line), `both tags moved — supersession was not established:\n${line}`);
});

test('SOURCE TAG UNREADABLE: no cause is asserted at all', { skip: !bashAvailable }, () => {
  const r = runPin(pinScript(), {
    digests: [['loom-trino', WANT_TRINO]],
    registry: [
      ['loom-trino:v0.1', '0', OTHER],
      [`loom-trino:${TAG}`, '7', ''],
    ],
  });
  assert.notEqual(r.status, 0, r.out);
  const [line] = errors(r.out);
  assert.match(line, /could not be re-read \(resolver exit 7\)/);
  assert.match(line, /asserts no cause/);
  assert.ok(!/SUPERSEDED/.test(line), line);
  assert.ok(!/The pin did NOT land/.test(line), line);
});

test('A GENUINE retag failure is still reported as one', { skip: !bashAvailable }, () => {
  // The guard must not have become a blanket "it was probably a race".
  const r = runPin(pinScript(), { ...HAPPY, env: { STUB_IMPORT_FAIL_REPO: 'loom-trino' } });
  assert.notEqual(r.status, 0, r.out);
  assert.ok(errors(r.out).some((l) => /Could not retag loom-trino/.test(l)), r.out);
});

test('THE HAPPY PATH still passes and still says what it proved', { skip: !bashAvailable }, () => {
  const r = runPin(pinScript(), HAPPY);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(errors(r.out), []);
  assert.match(r.out, /loom-unity:v0\.1 now resolves to/);
  assert.match(r.out, /loom-trino:v0\.1 now resolves to/);
});

// ── 3. The rollback gate must not fire on a durability-pin failure ──────────

/**
 * Translate the subset of the GitHub expression language this gate uses into
 * JS. Anything left over after the known constructs are stripped means the
 * expression grew something this translator does not model — refuse rather than
 * mis-evaluate it, because a translator that quietly guesses would make every
 * assertion below a statement about the guess.
 */
function ghIfToJs(expr) {
  const js = expr
    .replace(/\bfailure\(\)/g, 'CTX.failure')
    .replace(/\bsuccess\(\)/g, 'CTX.success')
    .replace(/\bcancelled\(\)/g, 'CTX.cancelled')
    .replace(/\balways\(\)/g, 'true')
    .replace(/\bsteps\.([A-Za-z_][A-Za-z0-9_]*)\.outcome\b/g, (_m, id) => `CTX.outcome[${JSON.stringify(id)}]`)
    .replace(/!=/g, '!==')
    .replace(/(?<![=!<>])==(?!=)/g, '===');
  const residue = js
    .replace(/CTX\.outcome\[[^\]]*\]/g, '')
    .replace(/CTX\.(failure|success|cancelled)/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\b(true|false)\b/g, '')
    .replace(/[\s()&|!=]/g, '');
  assert.equal(residue, '',
    `the rollback if: uses a construct this translator does not model (${JSON.stringify(residue)}) — `
    + 'teach it, or the cases below are evaluating something other than the shipped gate');
  return js;
}

const rollbackFires = (ctx) => {
  const fn = new Function('CTX', `return (${ghIfToJs(stepIf(ROLLBACK_STEP))});`);
  return fn({ failure: true, success: false, cancelled: false, outcome: ctx });
};

test('ROLLBACK GATE: a durability-pin failure does NOT trigger a rollback', () => {
  // The measured incident. health and verify both passed; the pin failed on a
  // registry tag race; the roll was reverted anyway.
  assert.equal(
    rollbackFires({ roll: 'success', health: 'success', verify: 'success', digest: 'success', pin: 'failure' }),
    false,
    'a verified-live roll is still reverted when only the durability pin fails (#4148)',
  );
});

test('ROLLBACK GATE: every gate that judges the LIVE ESTATE still triggers it', () => {
  // The other direction, so the fix is a discrimination and not a disabling.
  for (const failing of ['health', 'verify', 'digest']) {
    const ctx = { roll: 'success', health: 'success', verify: 'success', digest: 'success', pin: 'success' };
    ctx[failing] = 'failure';
    assert.equal(rollbackFires(ctx), true, `a ${failing} failure no longer rolls back — that is a coverage loss`);
  }
});

test('ROLLBACK GATE: a failed roll still does not trigger it (pre-existing behaviour)', () => {
  assert.equal(
    rollbackFires({ roll: 'failure', health: 'skipped', verify: 'skipped', digest: 'skipped', pin: 'skipped' }),
    false,
  );
});

test('ROLLBACK GATE MUTATION: the pre-fix expression DOES revert on a pin-only failure', () => {
  // The gate as it shipped before this change, evaluated by the same translator.
  const OLD = "failure() && steps.roll.outcome == 'success'";
  const fn = new Function('CTX', `return (${ghIfToJs(OLD)});`);
  assert.equal(
    fn({
      failure: true,
      success: false,
      cancelled: false,
      outcome: { roll: 'success', health: 'success', verify: 'success', digest: 'success', pin: 'failure' },
    }),
    true,
    'the pre-fix gate must fire here — otherwise the control above proves nothing',
  );
});

test('ROLLBACK GATE: the message names the gates it fires on, and excludes the pin', () => {
  // deploy-integrity.md R7 applied to the rollback's own announcement: the old
  // one printed "A post-roll gate failed (health=success, verify=success)"
  // while reverting, which named two passing steps as the cause.
  const run = stepRun(ROLLBACK_STEP);
  assert.match(run, /health=\$\{\{ steps\.health\.outcome \}\}/);
  assert.match(run, /verify=\$\{\{ steps\.verify\.outcome \}\}/);
  assert.match(run, /digest-reassert=\$\{\{ steps\.digest\.outcome \}\}/);
  assert.match(run, /durability pin is NOT one of these/i);
});

test('the digest re-assertion step carries the id the rollback gate reads', () => {
  // Without the id, `steps.digest.outcome` is always '' and the gate silently
  // stops rolling back on a tag re-point — a coverage loss with no error.
  const lines = wfLines();
  const at = lines.findIndex((l) => l.trim() === '- name: Re-assert the tag still resolves to the preflighted digest');
  assert.ok(at >= 0, 'the digest re-assertion step was renamed — the rollback gate now reads a dead id');
  assert.equal(lines[at + 1].trim(), 'id: digest',
    'the digest re-assertion step lost its `id: digest`, so steps.digest.outcome is empty in the rollback gate');
});

/**
 * Self-tests for assert-no-silent-image-tag-revert.mjs (#3161, runtime half).
 *
 * WHAT IS BEING PINNED. The static guard proves a tag env var is IN SCOPE where
 * the template is deployed. That is necessary and not sufficient: being in
 * scope with the value `v0.1` is precisely the state that flattened the Gov
 * estate. Only a live read distinguishes "correctly deploying the default" from
 * "silently reverting a pin", and only these tests prove the distinction is
 * actually drawn rather than asserted in a comment.
 *
 * Every CONTROL is chosen to DIE under an obvious mutation:
 *
 *   - make decideTagWrites() return no refusals -> the silent-revert control
 *     and the digest control both go red.
 *   - treat UNKNOWN as absent (the collapse deploy-integrity R7 forbids) ->
 *     the digest control and the failed-probe control go red.
 *   - drop the `source === 'pin'` branch -> the intentional-roll-forward
 *     control goes red (the guard would block every legitimate roll and be
 *     turned off within a week).
 *   - compare against the bicep default instead of the running tag -> the
 *     no-op control goes red (Gov legitimately RUNS :v0.1 after a roll).
 *   - honour LOOM_ALLOW_IMAGE_TAG_REVERT unconditionally -> the
 *     override-still-reports control goes red.
 *
 * The running-image side is NOT re-implemented here: it comes from
 * resolveRunningImageTags() in reconcile-policy.mjs, the same function the
 * Commercial lane uses in production. A fixture that modelled the code instead
 * of the dependency would agree with itself and prove nothing.
 *
 * Run: node --test scripts/ci/__tests__/silent-image-tag-revert.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { decideTagWrites, declaredTagDefaults, digestPinsByKey, remediationFor, KEY_BY_ENV_VAR } from '../assert-no-silent-image-tag-revert.mjs';
import { resolveRunningImageTags } from '../reconcile-policy.mjs';

const ACR = 'acrloomxxxx.azurecr.us';
const declared = new Map([['LOOM_UNITY_TAG', 'v0.1'], ['LOOM_TRINO_TAG', 'v0.1']]);
const running = (pairs) => resolveRunningImageTags(pairs.map(([name, image]) => ({ name, image })));
const row = (r, envVar) => r.rows.find((x) => x.envVar === envVar);

// ---------------------------------------------------------------------------
// THE #3161 CONTROL
// ---------------------------------------------------------------------------

test('CONTROL: the param default about to overwrite a SHA-pinned live app is REFUSED', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' }, // vars unset -> the default
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:5f9edba7`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'REFUSE');
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'fallback');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, '5f9edba7');
  // loom-trino already runs what would be written — no finding, no noise.
  assert.equal(row(r, 'LOOM_TRINO_TAG').verdict, 'no-op');
});

test('an EXPLICIT pin moving a live app is allowed and reported as a move, not a revert', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'abc1234', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'move');
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'pin');
});

test('Gov after a dataplane roll: :v0.1 re-pointed at the verified digest is a NO-OP, not a revert', () => {
  // loom-dataplane-roll.yml's interim mitigation makes :v0.1 carry the rolled
  // content, so the running TAG is legitimately v0.1. A guard that compared
  // against "is this the bicep default" instead of "is this what is running"
  // would refuse every Gov deploy forever.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:v0.1`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
  });
  assert.equal(r.decision, 'proceed');
  assert.ok(r.rows.every((x) => x.verdict === 'no-op'));
});

test('greenfield: an app that is not running cannot be reverted', () => {
  const r = decideTagWrites({ declared, env: {}, resolution: running([]) });
  assert.equal(r.decision, 'proceed');
  assert.ok(r.rows.every((x) => x.verdict === 'create'));
});

// ---------------------------------------------------------------------------
// UNKNOWN IS NOT ABSENT
// ---------------------------------------------------------------------------

test('CONTROL: a DIGEST-pinned container is UNKNOWN, and a default-sourced write over it is refused', () => {
  // ACA pins the digest a revision was created with, so a rolled app frequently
  // reports no tag at all. Reading that as "nothing there" is the exact
  // UNKNOWN-as-NEGATIVE collapse.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity@sha256:0123456789abcdef`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, 'UNKNOWN');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /digest/);
});

test('CONTROL: a FAILED container-app query refuses rather than reporting an empty estate', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: resolveRunningImageTags(null), // null = the query failed
  });
  assert.equal(r.decision, 'refuse');
  assert.ok(r.rows.every((x) => x.running === 'UNKNOWN'));
});

test('two containers running one repo at two tags is UNKNOWN, not a silent pick', () => {
  // loom-trino declares NO canonicalApp, so two tags on its repo remain the
  // genuine ambiguity this guard exists for. (This fixture used the
  // unity/iceberg pair before #4064 declared that pair's canonical.)
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:v0.1`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
      ['loom-trino-blue', `${ACR}/loom-trino:abc9999`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_TRINO_TAG').running, 'UNKNOWN');
});

test('#4064: writing the tag the CANONICAL runs is a no-op even while the follower still lags', () => {
  // Mid-roll, iceberg-catalog trails loom-unity by ~25s on the SAME repo. The
  // running truth for the unity key is the canonical's tag; re-asserting it is
  // exactly what converges the follower, so it must not read as UNKNOWN.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:v0.1`],
      ['iceberg-catalog', `${ACR}/loom-unity:abc9999`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'no-op');
});

test('#4064: the default about to overwrite a SHA-pinned CANONICAL is still REFUSED — the guard is not weakened', () => {
  // The follower's presence must not dilute the revert guard: the canonical
  // runs a SHA, the write would be the v0.1 fallback, and that is the exact
  // flatten this file exists to refuse.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:5f9edba7`],
      ['iceberg-catalog', `${ACR}/loom-unity:5f9edba7`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'REFUSE');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, '5f9edba7');
});

// ---------------------------------------------------------------------------
// the override is explicit, logged, and still reports
// ---------------------------------------------------------------------------

test('LOOM_ALLOW_IMAGE_TAG_REVERT proceeds but the refusals are still ENUMERATED', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
    allowRevert: true,
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(r.refusals.length, 1, 'an acknowledged revert is still a reverted tag and must stay visible');
});

// ---------------------------------------------------------------------------
// THE DIGEST CASE, RESOLVED RATHER THAN GUESSED (#3449)
// ---------------------------------------------------------------------------
//
// On GCC-High loom-unity RUNS BY DIGEST (measured, run 33519232492), so the tag
// comparison above has nothing to compare. This file used to attribute that pin
// to gov-build-images.yml "setting Gov Container Apps to <acr>/<app>@sha256:…".
// That is FALSE — that workflow has no `az containerapp update` at all, and every
// image the templates compose is `<acr>/<repo>:${tag}` — so the pin is OUT-OF-BAND
// state whose origin is not established. The shape is real; the mechanism was not.
//
// The registry can still answer the ONE question that decides the invariant: does
// the tag this deploy would write resolve, right now, to the digest the app is
// running?
//
// Mutations these controls kill:
//   - treat any digestCheck as permission to proceed -> the `different` control
//     goes red, and a genuine content revert would ship.
//   - treat `unknown` as `same` (an unreadable registry as an all-clear) ->
//     the unreadable control goes red — the #3090 collapse exactly.
//   - drop the digestChecks branch entirely -> the `same` control goes red and
//     GCC-High goes back to refusing every scheduled run.

const DIG_A = 'sha256:aaaa000000000000000000000000000000000000000000000000000000000000';
const DIG_B = 'sha256:bbbb111111111111111111111111111111111111111111111111111111111111';
const digestEstate = () => running([
  ['loom-unity', `${ACR}/loom-unity@${DIG_A}`],
  ['loom-trino', `${ACR}/loom-trino:v0.1`],
]);

test('CONTROL: the candidate tag resolving to the SAME digest the app runs is a no-op, not a revert', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'same', running: DIG_A, candidate: DIG_A } },
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'no-op');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /SAME digest/);
});

test('CONTROL: the candidate tag resolving to a DIFFERENT digest is REFUSED — a revert the tag names hid', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'different', running: DIG_A, candidate: DIG_B } },
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'REFUSE');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /DIFFERENT digest/);
});

test('CONTROL: a registry that could not be READ leaves the digest case UNKNOWN and still refuses', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'unknown', running: DIG_A, detail: 'resolve-acr-digest exit 4' } },
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, 'UNKNOWN');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /could not be read/);
});

// ---------------------------------------------------------------------------
// THE TWO `unresolved` REMEDIES (deploy-integrity R7)
//
// Both of these land on cause:'unresolved', and before #4297 both got the SAME
// remedy: "resolve the ACR read". On the path below where registryConsulted is
// false the registry was never consulted at all, so that sentence asserted a
// failure that may never have happened and aimed the reader at the wrong
// subsystem. Splitting the arm fixed that — and then very nearly repeated it in
// the other direction, by asserting a multi-container ESTATE disagreement on a
// path where decideTagWrites knows only that no digest check was supplied.
// digestPinsByKey runs in the CALLER and its output is not passed in, so the
// decision function structurally cannot tell "probe was ambiguous" from "the
// resolve step never ran". The control for that is the byte-identity assertion:
// a ONE-container estate and a TWO-container estate are indistinguishable here,
// so any remedy that names one of them as the cause is lying about one of them.
//
// Dies under: collapsing the arms back into one (the ACR-blame assertion), and
// under rewording either arm to assert a cause instead of naming both.
// ---------------------------------------------------------------------------

test('CONTROL: the un-consulted `unresolved` remedy does not blame the registry, and does not assert a cause it never established', () => {
  // Same repo, same cause, two estates the decision function cannot tell apart.
  const oneContainer = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity@${DIG_A}`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  const twoContainers = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity@${DIG_A}`],
      ['iceberg-catalog', `${ACR}/loom-unity@${DIG_B}`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });

  const a = row(oneContainer, 'LOOM_UNITY_TAG');
  const b = row(twoContainers, 'LOOM_UNITY_TAG');
  assert.equal(a.cause, 'unresolved');
  assert.equal(b.cause, 'unresolved');
  assert.equal(a.registryConsulted, false, 'no digestChecks were supplied, so the registry was not consulted');
  assert.equal(b.registryConsulted, false);

  const remedyOne = remediationFor(a);
  const remedyTwo = remediationFor(b);

  // The load-bearing control. One container and two containers at different
  // digests produce the SAME row here. If a future edit asserts either estate
  // shape as the cause, it is asserting it for the fixture where it is false —
  // and the only honest way to make these diverge is to carry real evidence of
  // which shape it is, which is a genuine fix rather than better prose.
  assert.equal(remedyOne, remedyTwo,
    'the decision function cannot distinguish these two estates, so the remedy must not claim to');

  // Finding 1: never send the reader at the ACR read on a path that never read it.
  assert.doesNotMatch(remedyOne, /Resolve the ACR read/i,
    'the registry was never consulted on this path — blaming it is the #4291 defect');
  assert.match(remedyOne, /was NOT consulted/,
    'the remedy must say the registry was not consulted, not imply it failed');

  // R7: where the code does not know, the message says it does not know, and
  // hands back the observation that settles it.
  assert.match(remedyOne, /not been established/i, 'the unknown sub-cause must be stated as unknown');
  assert.match(remedyOne, /\beither\b[\s\S]*\bor\b/, 'both candidate causes must be named, neither asserted');
  assert.match(remedyOne, /containerapp list/, 'the remedy must name the observation that discriminates');
});

test('CONTROL: the CONSULTED `unresolved` remedy does name the registry read as the thing to fix', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'unknown', running: DIG_A, detail: 'resolve-acr-digest exit 4' } },
  });
  const r0 = row(r, 'LOOM_UNITY_TAG');
  assert.equal(r0.cause, 'unresolved');
  assert.equal(r0.registryConsulted, true, 'a digestCheck WAS supplied, so the registry was consulted');

  const remedy = remediationFor(r0);
  // Here the blame IS established: the check ran and came back unknown.
  assert.match(remedy, /Resolve the ACR read/i);
  assert.match(remedy, new RegExp(DIG_A), 'the running digest is known on this path and belongs in the remedy');
  // Still not permission to proceed — the collapse R7 forbids.
  assert.match(remedy, /not permission to proceed/i);
});

test('an EXPLICIT pin onto a different digest is a MOVE, not a revert — intent is still honoured', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'abc1234', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'different', running: DIG_A, candidate: DIG_B } },
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'move');
});

test('digestPinsByKey names the digest-pinned keys, and holds two digests on one repo as ambiguous', () => {
  const one = digestPinsByKey([
    { name: 'loom-unity', image: `${ACR}/loom-unity@${DIG_A}` },
    { name: 'loom-trino', image: `${ACR}/loom-trino:v0.1` },
  ]);
  assert.deepEqual([...one.keys()], ['unity']);
  assert.equal(one.get('unity').digest, DIG_A);

  // Two containers serving one repository at two DIFFERENT digests cannot have
  // a single answer to "would writing tag T change the image?", so the key is
  // left out and stays UNKNOWN rather than being decided from one of them.
  const two = digestPinsByKey([
    { name: 'loom-unity', image: `${ACR}/loom-unity@${DIG_A}` },
    { name: 'iceberg-catalog', image: `${ACR}/loom-unity@${DIG_B}` },
  ]);
  assert.equal(two.size, 0);

  // A failed probe is not an estate with no digest pins.
  assert.equal(digestPinsByKey(null).size, 0);
});

// ---------------------------------------------------------------------------
// self-defence + real-file wiring
// ---------------------------------------------------------------------------

test('a tag var absent from APP_IMAGE_TAGS is reported unmapped, never scored safe', () => {
  const r = decideTagWrites({
    declared: new Map([['LOOM_NOT_A_REAL_TAG', 'v0.1']]),
    env: {},
    resolution: running([]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(r.rows[0].verdict, 'unmapped');
});

test('declaredTagDefaults reads the REAL Gov param files, and every tag maps to an image', () => {
  for (const [file, expectConsole] of [
    ['platform/fiab/bicep/params/gcc-high.bicepparam', 'v0.1'],
    ['platform/fiab/bicep/params/il5.bicepparam', 'v3.0'],
  ]) {
    const d = declaredTagDefaults(readFileSync(file, 'utf8'));
    assert.ok(d.size >= 16, `${file} should declare at least 16 tag defaults, saw ${d.size}`);
    assert.equal(d.get('LOOM_CONSOLE_TAG'), expectConsole);
    for (const envVar of d.keys()) {
      assert.ok(KEY_BY_ENV_VAR[envVar], `${file} reads ${envVar}, which APP_IMAGE_TAGS cannot map to an image`);
    }
  }
});

// ---------------------------------------------------------------------------
// THE REMEDIATION — the shape that had NO FIXTURE
// ---------------------------------------------------------------------------
//
// decideTagWrites has been fixtured since #3161. The SENTENCE THE OPERATOR READS
// never was, and that is precisely where two defects survived into production:
// it asserted a cause run 33519232492 disproved ("the estate did not answer"),
// and it advised an action that provably cannot clear an `unmapped` row.
//
// Every row below is DERIVED FROM decideTagWrites, never hand-built. A literal
// `{cause:'digest-different'}` would be type-correct and would still pass if the
// producer forgot to set `cause` at all — the exact fixture-shaped-like-the-
// mutation trap. Deriving it means a missing `cause` kills these controls.
//
// Mutations these kill:
//   - drop `cause` from any row in decideTagWrites  -> the cause-coverage control
//     and whichever branch lost it go red.
//   - make remediationFor return one string for everything (the old behaviour)
//     -> the adoption-blame, unmapped, and estate-action controls go red.
//   - let the digest-tag diagnostic reach the verdict -> the isolation control
//     goes red.
//   - offer a tag when the digest carries SEVERAL -> the ambiguity control goes
//     red (choosing one invents an intent nobody stated).

/**
 * The GCC-High run-33519232492 shape: unity digest-pinned, :v0.1 since moved.
 * `extra` is spread into the call so a control can attempt to feed the decision
 * a field it should not consult. Without it every invocation is byte-identical
 * and any comparison between two of them is f() === f() — a tautology.
 */
const run33519232492 = (extra = {}) => decideTagWrites({
  declared,
  env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
  resolution: digestEstate(),
  digestChecks: { unity: { status: 'different', running: DIG_A, candidate: DIG_B } },
  ...extra,
});

test('CONTROL: every refusal row carries a `cause`, so no branch falls through to generic advice', () => {
  // The producer, not a literal. A branch that forgets `cause` is caught here
  // rather than silently taking remediationFor's default arm.
  for (const r of [
    run33519232492(),
    decideTagWrites({ declared, env: {}, resolution: resolveRunningImageTags(null) }),
    decideTagWrites({ declared: new Map([['LOOM_NOT_A_REAL_TAG', 'v0.1']]), env: {}, resolution: running([]) }),
    decideTagWrites({
      declared,
      env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
      resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
    }),
  ]) {
    assert.ok(r.refusals.length > 0, 'fixture should produce a refusal to have a remedy for');
    for (const row of r.refusals) {
      assert.ok(row.cause, `${row.envVar} (${row.verdict}) has no cause, so its remedy would be the default arm`);
    }
  }
});

test('CONTROL: a digest-pinned refusal does NOT blame adoption — adoption declined correctly, it did not fail', () => {
  // Run 33519232492: adoption RAN and adopted console+wrangler live SHAs. It
  // cannot derive a tag from a digest, which is its documented limit. The old
  // message sent the reader to a script that is working as designed.
  const row = run33519232492().refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG');
  const remedy = remediationFor(row);
  assert.doesNotMatch(remedy, /adopt-image-tags/, 'a digest refusal must not name adoption as the culprit');
  assert.doesNotMatch(remedy, /did not (happen|answer)/i, 'must not assert a cause the run disproved');
  // and it must name the action that actually clears it
  assert.match(remedy, /out of band/i);
  assert.match(remedy, /az acr import --force/);
  assert.match(remedy, new RegExp(DIG_A), 'the remedy must carry the digest the app is actually running');
});

test('CONTROL: the digest remedy says re-running will NOT help — it is a standing condition, not a transient', () => {
  // Whatever re-points the tag, this deploy is not it: the tag already names
  // different content than the app runs, and re-running does not re-point it.
  // Advice that implies "try again" would burn a run per attempt forever.
  //
  // The regex is deliberately loose about the words BETWEEN "re-running" and
  // "will not change" — this control is about the CLAIM, and the previous form
  // pinned one exact sentence, so a truthful rewording went red for no reason.
  // It stays tight on both halves so unrelated prose cannot satisfy it.
  const row = run33519232492().refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG');
  const remedy = remediationFor(row);
  assert.match(remedy, /[Rr]e-running[^.]{0,32}will not change/);
  assert.doesNotMatch(remedy, /try again|retry the (run|deploy)|re-?run and see/i,
    'the remedy must not invite a retry that provably cannot clear this');
});

test('CONTROL: an `unmapped` row is NOT told to set the repo variable — that provably cannot clear it', () => {
  // The row is pushed with verdict 'unmapped' regardless of source, so setting
  // the variable changes nothing. The old advice offered exactly that.
  const r = decideTagWrites({ declared: new Map([['LOOM_NOT_A_REAL_TAG', 'v0.1']]), env: {}, resolution: running([]) });
  const remedy = remediationFor(r.refusals[0]);
  assert.match(remedy, /APP_IMAGE_TAGS/, 'the real remedy is to map the tag to a repository');
  assert.match(remedy, /will NOT clear this/, 'and it must say the variable route does not work');
});

test('a tag-vs-tag revert DOES still point at adoption — that advice was right for this shape', () => {
  // Not every refusal changed. Where the app runs a TAG and the deploy would
  // write the default, adoption exporting the running tag is genuinely the fix.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
  });
  const remedy = remediationFor(r.refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG'));
  assert.match(remedy, /adopt-image-tags/);
  assert.match(remedy, /5f9edba7/, 'and it names the tag that is actually running');
});

test('a FAILED probe is told to fix the container-app read, not to set a tag', () => {
  const r = decideTagWrites({ declared, env: {}, resolution: resolveRunningImageTags(null) });
  const remedy = remediationFor(r.refusals[0]);
  assert.match(remedy, /could not be listed/);
  assert.doesNotMatch(remedy, /az acr import/, 'nothing about the registry is established when the probe failed');
});

// --- the running-digest tag diagnostic -------------------------------------

test('exactly ONE tag on the running digest is offered as a pin', () => {
  const row = run33519232492().refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG');
  const remedy = remediationFor(row, { digestTags: { unity: { tags: ['a1b2c3d4'] } } });
  assert.match(remedy, /LOOM_UNITY_TAG=a1b2c3d4/);
});

test('CONTROL: SEVERAL tags on the running digest are ENUMERATED, never chosen between', () => {
  // loom-unity is a slow-moving OSS image, so two nightly builds can produce
  // identical layers and one digest can carry several 8-hex tags. Picking one
  // would be inventing an intent nobody stated.
  const row = run33519232492().refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG');
  const remedy = remediationFor(row, { digestTags: { unity: { tags: ['a1b2c3d4', 'e5f6a7b8', 'v0.1-rc'] } } });
  assert.match(remedy, /3 tags/);
  assert.doesNotMatch(remedy, /LOOM_UNITY_TAG=/, 'must not offer one of several as though it were the answer');
});

test('ZERO tags and an UNREADABLE lookup are reported DIFFERENTLY — absence is not failure to observe', () => {
  const row = run33519232492().refusals.find((x) => x.envVar === 'LOOM_UNITY_TAG');
  assert.match(remediationFor(row, { digestTags: { unity: { tags: [] } } }), /carries NO tags/);
  const unreadable = remediationFor(row, { digestTags: { unity: { detail: 'firewall lease denied' } } });
  assert.match(unreadable, /could not be read/);
  assert.doesNotMatch(unreadable, /carries NO tags/, 'an unreadable registry must never be reported as "no tags" (R7)');
});

test('CONTROL: the digest-tag diagnostic cannot change the DECISION — it reaches advice only', () => {
  // The one direction that would be unsafe: a run that refuses today must still
  // refuse whatever the diagnostic says, and a run that passes today must not be
  // turned red by it.
  //
  // This control used to call run33519232492() with no arguments on BOTH sides of
  // the comparison, so `base` and `again` were byte-identical recomputations and
  // `again.decision === base.decision` was f() === f() — a tautology no mutation
  // could fail. The diagnostic was varied only in the argument to remediationFor,
  // which is the advice side, i.e. not the thing the control is about. It now
  // actually feeds digestTags INTO decideTagWrites, so if someone plumbs the
  // diagnostic into the decision the claim in this header goes red.
  const base = run33519232492();
  assert.equal(base.decision, 'refuse');
  for (const digestTags of [
    {}, { unity: { tags: ['a1b2c3d4'] } }, { unity: { tags: [] } }, { unity: { detail: 'unreadable' } },
  ]) {
    const again = run33519232492({ digestTags });
    assert.equal(again.decision, base.decision, 'the decision is computed without the diagnostic');
    assert.equal(again.refusals.length, base.refusals.length);
    assert.deepEqual(
      again.refusals.map((r) => r.cause), base.refusals.map((r) => r.cause),
      'the diagnostic must not even change WHICH refusal is reported',
    );
    // and the remedy is the only thing that varies
    assert.ok(remediationFor(again.refusals[0], { digestTags }).length > 0);
  }
  // A passing shape stays passing with every diagnostic value.
  const pass = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: digestEstate(),
    digestChecks: { unity: { status: 'same', running: DIG_A, candidate: DIG_A } },
  });
  assert.equal(pass.decision, 'proceed');
  assert.equal(pass.refusals.length, 0);
});

// --- the claim this file itself used to get wrong ---------------------------

test('CONTROL: no template in this repo writes a DIGEST-pinned ESTATE-ACR image', () => {
  // The header of the guard, and this file, both asserted gov-build-images.yml
  // "sets Gov Container Apps to <acr>/<app>@sha256:…". It does not, and that
  // false mechanism was cited as authority by gov-console-roll.yml and cost a
  // full investigation branch. Pin the measurement so the claim cannot come back.
  const gbi = readFileSync('.github/workflows/gov-build-images.yml', 'utf8');
  assert.doesNotMatch(gbi, /\bcontainerapp\b/, 'gov-build-images.yml must not be described as updating Container Apps');

  // This half of the control used to read ONE file and match only a LITERAL digest
  // on an `image:` line — blind twice over. It could not see dab-runtime.bicep at
  // all, and even inside that file it would have missed `image: dabImage` (:123)
  // because the digest lives in the param default (:43). Both blindnesses are
  // fixed here: every admin-plane template, and every digest anywhere in it.
  //
  // The claim is deliberately SCOPED to estate-ACR images, because the unqualified
  // absolute is false: dab-runtime and udf-runtime DO pin digests, on purpose, for
  // MCR base images (data-api-builder, azure-functions, busybox) — a different
  // population with its own documented bump procedure and its own enforcing gate,
  // scripts/ci/check-mcr-image-pins.mjs. A digest on a Loom app image is what would
  // make the out-of-band pin in-band, and that is what this watches for.
  const dir = 'platform/fiab/bicep/modules/admin-plane';
  const offenders = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.bicep'))) {
    const src = readFileSync(`${dir}/${file}`, 'utf8');
    const lines = src.split('\n');
    lines.forEach((text, i) => {
      if (!/@sha256:[0-9a-f]{64}/.test(text)) return;
      if (/mcr\.microsoft\.com/.test(text)) return; // deliberate base-image pin
      offenders.push(`${file}:${i + 1} ${text.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'a template that composed a digest ref for an estate-ACR app image would make the pin in-band');
});

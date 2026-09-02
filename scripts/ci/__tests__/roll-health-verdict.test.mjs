#!/usr/bin/env node
/**
 * The roll's revision-health gate — BEHAVIOURAL MUTATION PROOFS. (refs #4238)
 *
 * ── WHAT #4238 REPORTED, AND WHAT IS ACTUALLY TRUE ─────────────────────────
 * "Wait for revision health" in loom-roll-and-validate.yml decided the roll's
 * fate against the whole tsv ROW:
 *
 *     if [[ "$STATE" == *"Healthy"* && "$STATE" == *"Running"* ]]; then OK=true
 *
 * #4238 read that as fail-OPEN, on the grounds that `*"Healthy"*` matches
 * "Unhealthy". MEASURED, it does not: `[[ ]]` globbing is case-SENSITIVE
 * (nocasematch is off), and "Unhealthy" contains "healthy" with a lowercase h.
 * The mutation receipt in the PR body is the proof — restoring that exact line
 * leaves the FIRST test in this file GREEN. No unhealthy revision was ever
 * passed by the old predicate, and the report's P0 framing was wrong.
 *
 * ── THE DEFECT THAT IS REAL ────────────────────────────────────────────────
 * The old form matched two enums against ONE concatenated row, so each test
 * could be satisfied by the OTHER field. It came out right only because no
 * member of RevisionHealthState (Healthy | Unhealthy | None) and no member of
 * RevisionRunningState (Running | Processing | Stopped | Degraded | Failed |
 * Unknown — plus RunningAtMaxScale / ScaledToZero in practice) happens to
 * contain the other's token. Both are ExpandableStringEnum: Microsoft reserves
 * the right to add values, and a future runningState carrying "Healthy" would
 * make this gate pass a revision the control plane called unhealthy. The
 * CROSS-FIELD test below is the one that fails on the old line.
 *
 * ── AND THE FIX #4238 PROPOSED WOULD HAVE REGRESSED ────────────────────────
 * The issue asked for `[[ "$HEALTH" == "Healthy" && "$RUNNING" == "Running" ]]`.
 * The old glob also accepted `RunningAtMaxScale`, which this estate really
 * reports (iceberg-catalog, ~60s into a cold start, 2026-08-07 — recorded in
 * apps/fiab-console/lib/azure/uc-token-exchange.ts). Under the bare literal a
 * healthy revision at max scale fails the gate, and because the rollback fires
 * on a non-unknown health failure it would AUTO-REVERT A GOOD DEPLOY (#4231
 * D3). The accepted set is therefore written out, and pinned by its own test.
 *
 * ── #4287 — AND THE FIRST FIX FOR ALL OF THAT HAD THREE DEFECTS OF ITS OWN ──
 * 1. CUMULATIVE FAILURE COUNT. `FAILED_READS -ge 12` promoted the verdict to
 *    `unknown` over the whole 30-poll budget, however many polls had SUCCEEDED.
 *    12 successful `Unhealthy` reads scattered among 12 refusals produced
 *    `unknown`, which makes the rollback `if:` false — so a revision the
 *    control plane called Unhealthy was left LIVE — while the error text
 *    claimed "a revision state this step never read" about a state it had read
 *    twelve times. `unknown` answers "did I learn anything?", so it is gated on
 *    SUCCESS_READS -eq 0, exactly as gov-console-roll.yml has always done.
 * 2. STILL CASE-DEPENDENT. The exact literals kept the dependence the PR title
 *    named: `Healthy<TAB>RunningAtMaxscale` PASSED the old glob and FAILED the
 *    new literal, i.e. the fix introduced an auto-revert of a good deploy. Both
 *    sides are folded now; equality (not substring) still refuses "unhealthy".
 * 3. STILL POSITIONAL. Splitting one multiselect row moved correctness from
 *    the capital H onto the field order of a `{health:…, running:…}` hash.
 *    Each enum now has its OWN scalar --query, naming its own property.
 *
 * ── WHY THIS RUNS THE SHIPPED BASH ─────────────────────────────────────────
 * This repo has a recorded failure class of tests that model the CODE instead
 * of the thing: a substring/`includes` assertion over the step's text would
 * have been satisfied by the broken line exactly as happily as by the fixed
 * one, and a hand-written re-implementation of the loop can never disagree
 * with the loop. So this harness EXTRACTS the step's `run:` block from the
 * workflow verbatim, substitutes only the GitHub `${{ … }}` expressions —
 * failing loudly if any expression it does not know about survives — and
 * EXECUTES that text under `bash -e` (the runner's shell) with `az` and
 * `sleep` stubbed on PATH. The loop, the three-valued verdict, the read
 * counting, the side-file stderr handling and the image read-back are the
 * SHIPPED text, not a model of it.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────
 * PROVEN: given a control-plane answer, which verdict this step writes to
 * $GITHUB_OUTPUT and whether it exits non-zero — i.e. whether an unhealthy
 * revision reaches live validation, and whether the rollback's
 * `verdict != 'unknown'` guard sees the right value.
 * MEASURED OUTSIDE THIS FILE (az 2.88.0, recorded because the previous revision
 * of this docblock asserted the opposite from the CLI's documented behaviour
 * rather than from a run): `--query "{zzz:'FIRST', aaa:'SECOND'}" -o tsv` emits
 * `FIRST<TAB>SECOND`, i.e. WRITTEN order, not key order; and a top-level list
 * multiselect emits one row PER ELEMENT, so `--query "[a, b]" -o tsv` is two
 * LINES, not two fields. Neither fact is load-bearing any more — the step reads
 * two scalars — but the wrong version of the first one was load-bearing before.
 * NOT PROVEN: the job-level `if:` wiring, a real ACA revision, and either
 * cloud's live estate. Those need a live roll.
 *
 * Run: node --test scripts/ci/__tests__/roll-health-verdict.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'loom-roll-and-validate.yml');
// Normalised: the repo checks out with CRLF on Windows and these assertions are
// about workflow SEMANTICS. (The CR the CONTROL PLANE may emit is a different
// thing entirely, and is exercised as its own scenario below.)
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const STEP_NAME = 'Wait for revision health';

const APP = 'loom-console';
const RG = 'rg-loom';
const REVISION = 'loom-console--0a1b2c3';
const WANT_IMAGE = 'acrtest.azurecr.io/loom-console:4a4dc9b0f00ba5e1c2d3e4f5a6b7c8d9';

/**
 * Pull a step's `run:` block out of the workflow, verbatim.
 * (Shape lifted from scripts/ci/__tests__/sc1-verify-gate.test.mjs, the vetted
 * extractor in this repo. Copied rather than imported because importing a
 * `.test.mjs` would run its whole suite as a side effect.)
 * @param {string} src
 * @param {string} stepName
 * @returns {string}
 */
function extractRunBlock(src, stepName) {
  const lines = String(src).split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(at >= 0, `step not found in the workflow: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.ok(runAt > at, `no \`run: |\` after step: ${stepName}`);
  const indent = (lines[runAt + 1].match(/^ */) || [''])[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith(' '.repeat(indent))) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

/**
 * The env keys the SHIPPED step declares. The extracted script opens
 * `set -uo pipefail`, so a key this harness does not supply aborts it on first
 * reference — which surfaces as a suite that exits non-zero having emitted no
 * failed assertion at all (#3422 measured exactly that at the sibling
 * sc1-verify-gate harness). Today the step declares none; this derives that
 * rather than assuming it, so the day one is added the failure is legible.
 * @param {string} src
 * @param {string} stepName
 * @returns {string[]}
 */
function extractStepEnv(src, stepName) {
  const lines = String(src).split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(at >= 0, `step not found in the workflow: ${stepName}`);
  const dashIndent = lines[at].indexOf('- name:');
  const keyIndent = dashIndent + 2;
  const keys = [];
  let inEnv = false;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const indent = (l.match(/^ */) || [''])[0].length;
    if (indent <= dashIndent) break;
    if (indent === keyIndent) {
      inEnv = /^\s*env:\s*$/.test(l);
      continue;
    }
    if (!inEnv) continue;
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):/);
    assert.ok(m, `unparsed line in the \`env:\` block of step "${stepName}":\n${l}`);
    keys.push(m[1]);
  }
  return keys;
}

/** The step's body from `- name:` to the next step, for static assertions. */
function stepBody(name) {
  const start = WORKFLOW.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" not found in ${WORKFLOW_PATH}`);
  const next = WORKFLOW.indexOf('\n      - name: ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? WORKFLOW.length : next);
}

/** GitHub expressions this harness knows how to stand in for. */
const SUBSTITUTIONS = [
  [/\$\{\{ env\.APP_NAME \}\}/g, APP],
  [/\$\{\{ env\.RG_NAME \}\}/g, RG],
  [/\$\{\{ steps\.roll\.outputs\.new_revision \}\}/g, REVISION],
  [/\$\{\{ steps\.vars\.outputs\.image \}\}/g, WANT_IMAGE],
];

function renderScript() {
  let src = extractRunBlock(WORKFLOW, STEP_NAME);
  for (const [re, val] of SUBSTITUTIONS) src = src.replace(re, val);
  // An unhandled expression must FAIL, not silently become a literal that makes
  // the harness measure something other than the shipped step.
  assert.ok(
    !src.includes('${{'),
    `unhandled GitHub expression in the extracted step:\n${src
      .split('\n')
      .filter((l) => l.includes('${{'))
      .join('\n')}`,
  );
  return src;
}

const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const skipNoBash = { skip: !bashOk && 'bash unavailable' };

// #4287 — A SUITE THAT SILENTLY SHRINKS TO ITS TWO STATIC TESTS IS A CONTROL
// THAT IS GREEN BECAUSE ITS INPUT COULD NOT BE READ. Every behavioural arm here
// runs the SHIPPED `run:` text under bash; without bash all of them skip and the
// suite still reports PASS. That is latent on ubuntu runners and live the moment
// this lane moves to windows-latest or the runner image changes. Under CI the
// absence of bash is therefore a HARD failure of the suite, not a quiet skip.
// The local-dev escape hatch stays, because a developer without bash should
// still be able to run the two static assertions.
test('the behavioural harness can actually run (a skipped suite is a vacuous suite)', () => {
  assert.ok(
    bashOk || !process.env.CI,
    'bash is not on PATH, so every behavioural arm in this file would skip and the suite would ' +
      'report PASS having executed nothing but its two static string checks. Under CI that is a ' +
      'hollow control: fix the runner shell rather than accepting a green that measured nothing.',
  );
});

/**
 * Execute the SHIPPED step against a stubbed control plane.
 *
 * @param {object} o
 * @param {string[]} [o.probes]  one entry per health POLL: "<health>,<running>",
 *                               "FAIL" (both reads of the poll are refused), or
 *                               "HALF:<health>,<running>" (the healthState read
 *                               succeeds and the runningState read of the same
 *                               poll is refused). The LAST entry repeats for
 *                               every further poll.
 * @param {boolean} [o.crlf]     the control plane terminates each value with CR
 * @param {string}  [o.image]    the image the revision reports running
 * @param {boolean} [o.imageReadFails] every image read-back is refused
 * @returns {{code:number, out:string, verdict:string|null}}
 */
function runHealthStep({
  probes = ['Healthy,Running'],
  crlf = false,
  image = WANT_IMAGE,
  imageReadFails = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roll-health-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const counter = path.join(dir, 'probe-count');
  const ghOutput = path.join(dir, 'github-output');
  writeFileSync(ghOutput, '');

  // `az containerapp revision show … --query <q> -o tsv`, dispatching on the
  // JMESPath the step asks for. Nothing here invents a response shape: since
  // #4287 the step reads each enum with its OWN scalar --query, and a scalar
  // `-o tsv` is one bare value on one line. The poll counter advances on the
  // healthState read, which the step issues first; the runningState read of
  // the SAME poll reads that counter without advancing it, so one probe entry
  // describes one poll however many calls the poll makes.
  writeFileSync(
    path.join(bin, 'az'),
    [
      '#!/usr/bin/env bash',
      'Q=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--query" ]; then Q="$a"; fi',
      '  prev="$a"',
      'done',
      'pick_for() {',
      '  i=0; p=""',
      '  for t in $STUB_PROBES; do',
      '    i=$((i+1)); p="$t"',
      '    if [ "$i" -ge "$1" ]; then break; fi',
      '  done',
      '  printf %s "$p"',
      '}',
      'emit() {',
      '  if [ "${STUB_CRLF:-0}" = "1" ]; then printf "%s\\r\\n" "$1"; else printf "%s\\n" "$1"; fi',
      '}',
      'case "$Q" in',
      '  *healthState*)',
      '    n=0',
      '    if [ -s "$STUB_COUNTER" ]; then n=$(cat "$STUB_COUNTER"); fi',
      '    n=$((n+1)); printf %s "$n" > "$STUB_COUNTER"',
      '    pick=$(pick_for "$n")',
      '    if [ "$pick" = "FAIL" ]; then',
      '      echo "ERROR: (SubscriptionRequestsThrottled) stub: ARM refused this read" >&2',
      '      exit 1',
      '    fi',
      '    case "$pick" in HALF:*) pick="${pick#HALF:}" ;; esac',
      '    hv="${pick%%,*}"',
      '    # EMPTY reproduces the MEASURED shape of `az containerapp revision',
      '    # show --query <path-that-does-not-resolve> -o tsv`: exit 0, and ZERO',
      '    # BYTES on stdout. Not a hypothetical — this is what an ARM property',
      '    # rename looks like to the step, and it had no fixture (#4238).',
      '    if [ "$hv" = "EMPTY" ]; then exit 0; fi',
      '    emit "$hv"',
      '    exit 0 ;;',
      '  *runningState*)',
      '    n=1',
      '    if [ -s "$STUB_COUNTER" ]; then n=$(cat "$STUB_COUNTER"); fi',
      '    pick=$(pick_for "$n")',
      '    case "$pick" in',
      '      HALF:*)',
      '        echo "ERROR: (SubscriptionRequestsThrottled) stub: ARM refused the runningState half of this poll" >&2',
      '        exit 1 ;;',
      '    esac',
      '    rv="${pick##*,}"',
      '    if [ "$rv" = "EMPTY" ]; then exit 0; fi',
      '    emit "$rv"',
      '    exit 0 ;;',
      '  *containers*)',
      '    if [ "${STUB_IMAGE_READ_FAILS:-0}" = "1" ]; then',
      '      echo "ERROR: (AuthorizationFailed) stub: the image read was denied" >&2',
      '      exit 1',
      '    fi',
      '    printf "%s\\n" "$STUB_IMAGE"',
      '    exit 0 ;;',
      'esac',
      'echo "stub az: unexpected invocation: $*" >&2',
      'exit 64',
    ].join('\n'),
    'utf8',
  );
  chmodSync(path.join(bin, 'az'), 0o755);

  // The shipped loop sleeps 10s between polls and budgets 30 of them. Left
  // real, the unhealthy scenarios below would each take ~5 minutes and the
  // node:test lane would time out — reported as `cancelled`, which reads like
  // "superseded" rather than "this job died". Stubbing `sleep` changes the
  // step's WALL CLOCK and nothing else about the branch it takes.
  writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(path.join(bin, 'sleep'), 0o755);

  const script = path.join(dir, 'health.sh');
  writeFileSync(script, renderScript(), 'utf8');

  const childEnv = {
    GITHUB_OUTPUT: ghOutput,
    STUB_COUNTER: counter,
    STUB_PROBES: probes.join(' '),
    STUB_CRLF: crlf ? '1' : '0',
    STUB_IMAGE: image,
    STUB_IMAGE_READ_FAILS: imageReadFails ? '1' : '0',
  };

  // DERIVED coverage, not hand-maintained: every `env:` key the SHIPPED step
  // declares must be one this harness supplies EXPLICITLY.
  const declaredEnv = extractStepEnv(WORKFLOW, STEP_NAME);
  const uncovered = declaredEnv.filter((k) => !(k in childEnv));
  assert.deepEqual(
    uncovered,
    [],
    `the workflow step "${STEP_NAME}" declares env key(s) this harness does not supply: ${uncovered.join(', ')}. ` +
      'The extracted script runs under `set -uo pipefail`, so an unsupplied key aborts it on first ' +
      'reference — which surfaces as a suite that exits non-zero having emitted no failed assertion at all.',
  );

  // `bash -e` — GitHub's default `run:` shell is `bash -e {0}`, and the step's
  // own `set -uo pipefail` does NOT clear -e. Running it any other way would
  // hide exactly the class of abort #4231 D1 was filed for.
  const res = spawnSync('bash', ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...childEnv,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  });

  const written = existsSync(ghOutput) ? readFileSync(ghOutput, 'utf8') : '';
  // Actions takes the LAST value written for a key; the image-read-exhaustion
  // path deliberately writes a second, correcting `verdict=unknown`.
  const verdicts = written
    .split(/\r?\n/)
    .filter((l) => l.startsWith('verdict='))
    .map((l) => l.slice('verdict='.length));
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

  if (process.env.ROLL_HEALTH_VERBOSE) {
    console.log(`\n───── PROBES ${probes.join(' ')} → exit ${res.status} verdict=${verdicts.at(-1)}`);
    console.log(out.trimEnd());
  }

  return { code: res.status, out, verdict: verdicts.at(-1) ?? null };
}

// ── Does the ROLLBACK actually fire? EVALUATED, not eyeballed ───────────────
//
// A verdict in $GITHUB_OUTPUT matters through exactly one consumer: the `if:`
// of the "Rollback on validation failure" step. Asserting the verdict string
// alone leaves the thing that actually hurts — a good deploy being auto-
// reverted — unproven. So the predicate is EXTRACTED from the shipped workflow
// and EVALUATED. Nothing below restates it; if the expression changes, these
// arms re-evaluate the new one rather than pinning the old one.
const ROLLBACK_STEP = 'Rollback on validation failure';

function rollbackPredicate() {
  const body = stepBody(ROLLBACK_STEP);
  const m = body.match(/\n\s*if: >-\n([\s\S]*?)\n\s*run: \|/);
  assert.ok(m, `could not extract the \`if:\` of step "${ROLLBACK_STEP}"`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .join(' ')
    .trim();
}

function rollbackFires(ctx) {
  const js = rollbackPredicate()
    .replace(/\bfailure\(\)/g, 'C.failure')
    .replace(/steps\.([A-Za-z0-9_]+)\.outputs\.([A-Za-z0-9_]+)/g, 'C.out["$1.$2"]')
    .replace(/steps\.([A-Za-z0-9_]+)\.outcome/g, 'C.outcome["$1"]')
    .replace(/!=/g, '@NE@')
    .replace(/==/g, '===')
    .replace(/@NE@/g, '!==');
  // Fail CLOSED on anything this translator does not model. `success()`, a new
  // `steps.` reference, or any other GHA function would otherwise evaluate to
  // `undefined` and make every arm below vacuously green — a guard that does
  // not watch. Deliberately NOT modelling success() as !failure(): they are not
  // the same predicate, and guessing is how this class of bug starts.
  assert.doesNotMatch(
    js,
    /steps\.|[A-Za-z_]+\(\)/,
    `unmodelled GitHub Actions syntax in the "${ROLLBACK_STEP}" if:: ${js}`,
  );
  // eslint-disable-next-line no-new-func
  return Boolean(new Function('C', `return (${js});`)(ctx));
}

/** The post-roll context this suite produces: roll succeeded, health failed. */
function rollbackFiresFor(verdict) {
  return rollbackFires({
    failure: true,
    outcome: { roll: 'success', validate: 'skipped', uat: 'skipped', health: 'failure' },
    out: { 'health.verdict': verdict ?? '' },
  });
}

// ── The #4238 arm — GREEN BOTH WAYS, and that is the finding ────────────────
// This is the behaviour the issue said was broken. It is not, and restoring the
// old line does not move this test. Kept because it is the property that
// matters, and because a reader who only sees "the fix" needs the counter-proof
// next to it.
test('an Unhealthy + Running revision FAILS the gate', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Unhealthy,Running'] });
  assert.equal(
    r.code,
    1,
    'the step must exit non-zero on a revision the control plane calls Unhealthy.\n' + r.out,
  );
  assert.equal(
    r.verdict,
    'unhealthy',
    'the verdict written to $GITHUB_OUTPUT must be "unhealthy"; the rollback step reads it ' +
      `(\`steps.health.outputs.verdict != 'unknown'\`) to decide whether to revert.\n${r.out}`,
  );
  assert.match(r.out, /never reached Healthy\+Running/, 'the failure must say what it measured');
  assert.doesNotMatch(
    r.out,
    /matches the requested image/,
    'an unhealthy revision must never reach the image read-back, let alone the success notice',
  );
});

// A gate that refuses EVERYTHING is broken in the other direction, and would
// have satisfied the assertion above. These hold the fix honest.
test('a Healthy + Running revision on the requested image PASSES', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,Running'] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'healthy', r.out);
  assert.match(r.out, /Healthy\+Running on .*matches the requested image/, r.out);
});

test('a revision that becomes healthy on a later poll PASSES', skipNoBash, () => {
  const r = runHealthStep({ probes: ['None,Activating', 'Unhealthy,Running', 'Healthy,Running'] });
  assert.equal(r.code, 0, `the loop must keep polling — a revision is briefly None/Activating\n${r.out}`);
  assert.equal(r.verdict, 'healthy', r.out);
});

// ── THE NON-REGRESSION ARM: the fix #4238 asked for would have broken this ──
test('Healthy + RunningAtMaxScale PASSES — a good deploy at max scale is not reverted', skipNoBash, () => {
  // The old `*"Running"*` glob accepted RunningAtMaxScale, and this estate
  // really reports it (iceberg-catalog, ~60s into a cold start, 2026-08-07 —
  // apps/fiab-console/lib/azure/uc-token-exchange.ts). A bare
  // `[[ "$RUNNING" == "Running" ]]` — the literal fix the issue proposed —
  // fails this, and the rollback fires on a non-unknown health failure, so the
  // narrowing would auto-revert a GOOD deploy (#4231 D3).
  const r = runHealthStep({ probes: ['Healthy,RunningAtMaxScale'] });
  assert.equal(r.code, 0, `RunningAtMaxScale is a serving state and must clear the gate\n${r.out}`);
  assert.equal(r.verdict, 'healthy', r.out);
});

// ── THE ARM THAT ACTUALLY MOVES: cross-field matching ───────────────────────
test('a row whose RUNNING field carries the health token does NOT pass (cross-field)', skipNoBash, () => {
  // SYNTHETIC. No runningState is spelled "RunningHealthy" today — that is the
  // point. RevisionHealthState and RevisionRunningState are both
  // ExpandableStringEnums, so the old whole-row form was correct only because
  // no member happened to contain the other's token. This row satisfies BOTH
  // old globs (`*Healthy*` and `*Running*` both hit the running field) while
  // healthState is None, i.e. the control plane is reporting no health at all.
  // Field-scoped comparison is what refuses it; the old line passes it.
  const r = runHealthStep({ probes: ['None,RunningHealthy'] });
  assert.equal(
    r.code,
    1,
    'healthState is None — nothing about this row says the revision is healthy. ' +
      'The whole-row glob passed it because the token appeared in the OTHER field.\n' +
      r.out,
  );
  assert.equal(
    r.verdict,
    'unknown',
    'CHANGED BY #4238: this was `unhealthy`. "RunningHealthy" is not a member of either enum, so ' +
      'the poll is a statement about the --query, not about the revision — and an uninterpretable ' +
      `value must never produce a rollback. The gate still REFUSES the row, which is the property ` +
      `this arm exists to defend.\n${r.out}`,
  );
  assert.equal(rollbackFiresFor(r.verdict), false, r.out);
  assert.doesNotMatch(r.out, /matches the requested image/, r.out);
});

// ── The rest of the enum, and the other non-Running states ──────────────────
test('healthState None FAILS the gate', skipNoBash, () => {
  const r = runHealthStep({ probes: ['None,Running'] });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict, 'unhealthy', r.out);
});

test('Healthy but not Running FAILS the gate', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,Stopped'] });
  assert.equal(r.code, 1, `a stopped revision serves nothing\n${r.out}`);
  assert.equal(r.verdict, 'unhealthy', r.out);
});

test('Healthy + ScaledToZero FAILS the gate — the accepted set is unchanged', skipNoBash, () => {
  // The old glob did not accept it either ("ScaledToZero" contains no
  // "Running"), and a revision with no replicas is not serving the validation
  // this gate clears the way for. Pinned so a later widening is deliberate.
  const r = runHealthStep({ probes: ['Healthy,ScaledToZero'] });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict, 'unhealthy', r.out);
});

// The exact comparison and the CR strip have to coexist: exact matching on a
// value that still carries the control plane's CR would fail a GOOD roll, which
// is the auto-revert-a-healthy-deploy shape #4231 D3 exists to prevent.
test('a CR-terminated control-plane row still PASSES (exactness must not become a false red)', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,Running'], crlf: true });
  assert.equal(r.code, 0, `\`tr -d '\\r'\` must run before the exact compare\n${r.out}`);
  assert.equal(r.verdict, 'healthy', r.out);
});

// ── #4287: THE CASING OF A SERIALIZED ENUM IS CONVENTION, NOT CONTRACT ──────
// The exact-literal form this PR shipped kept the very dependence its title
// named — it was right only by the capital H of Healthy, the capital R of
// Running and the capital S of RunningAtMaxScale. `RunningAtMaxscale` PASSED
// the old whole-row glob and FAILED the exact literal, i.e. the PR introduced
// an auto-revert of a good deploy. Case-folding both sides keeps the compare an
// EQUALITY, so "Unhealthy" still cannot satisfy "healthy".
test('Healthy + RunningAtMaxscale (lowercase s) PASSES — casing must not auto-revert a good deploy', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,RunningAtMaxscale'] });
  assert.equal(
    r.code,
    0,
    'a revision at max scale whose enum arrived with different casing is a GOOD deploy. ' +
      `Refusing it makes verdict=unhealthy, which FIRES the rollback (#4231 D3).\n${r.out}`,
  );
  assert.equal(r.verdict, 'healthy', r.out);
});

test('healthy + running (all lowercase) PASSES', skipNoBash, () => {
  const r = runHealthStep({ probes: ['healthy,running'] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'healthy', r.out);
});

test('HEALTHY + RUNNINGATMAXSCALE (all upper) PASSES', skipNoBash, () => {
  const r = runHealthStep({ probes: ['HEALTHY,RUNNINGATMAXSCALE'] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'healthy', r.out);
});

// The counter-arm: folding must not turn the equality back into something a
// health-adjacent string can satisfy.
test('unhealthy (lowercase) still FAILS — folding is an equality, not a substring', skipNoBash, () => {
  const r = runHealthStep({ probes: ['unhealthy,running'] });
  assert.equal(r.code, 1, `case-folding must not make "unhealthy" satisfy "healthy"\n${r.out}`);
  assert.equal(r.verdict, 'unhealthy', r.out);
});

// ── #4287: the two enums are addressed BY NAME, not by position in a row ────
// Each field now has its own scalar --query, so there is no row to split and no
// column order to depend on. The pair of arms below is the proof that HEALTH is
// fed by the healthState query and RUNNING by the runningState one: swap the
// two values and the verdict flips. Were the assignments reversed in the
// shipped step, the first arm would fail and the second would pass.
test('a swapped read — healthState carrying the running token — FAILS', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Running,Healthy'] });
  assert.equal(
    r.code,
    1,
    'healthState=Running is not a health verdict and runningState=Healthy is not a running ' +
      `state. Only a positional/whole-row read could accept this.\n${r.out}`,
  );
  assert.equal(
    r.verdict,
    'unknown',
    'CHANGED BY #4238: this was `unhealthy`. Neither value is a member of the enum it was read ' +
      'from, so the step established nothing about the revision — and must not revert it on the ' +
      `strength of a query that has stopped resolving.\n${r.out}`,
  );
  assert.equal(rollbackFiresFor(r.verdict), false, r.out);
});

// A poll that reads only ONE of the two properties establishes NEITHER, so it
// must count as a failed read rather than be graded on a stale companion value.
test('a poll whose runningState half is refused is a FAILED read, not a half-verdict', skipNoBash, () => {
  const r = runHealthStep({ probes: ['HALF:Healthy,Running'] });
  assert.equal(r.code, 1, `neither property was fully established\n${r.out}`);
  assert.equal(
    r.verdict,
    'unknown',
    `no poll ever read BOTH properties, so nothing about the revision was measured\n${r.out}`,
  );
  assert.match(r.out, /Cannot say whether revision/, r.out);
});

test('a half-refused poll followed by a clean one still PASSES', skipNoBash, () => {
  const r = runHealthStep({ probes: ['HALF:Healthy,Running', 'Healthy,Running'] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'healthy', r.out);
});

// ── A value neither enum recognises is a QUERY problem until proven otherwise ─
// R7: if a --query ever stops resolving to the property it names, the step must
// fail closed AND must not let the operator read "the revision is unhealthy"
// out of a message about its own query.
//
// ── #4238 — THE ARM THAT HAD NO FIXTURE, AND THE DEFECT IT WAS HIDING ───────
//
// MEASURED against a stub that exits 0 printing zero bytes, on the step as it
// shipped in the first round of this PR:
//
//     30/30 polls counted as SUCCESSFUL reads
//     ODD_READS = 60   (100% unrecognised)
//     verdict   = unhealthy      -> the rollback `if:` is TRUE
//
// So an ARM API change that moved or renamed `properties.healthState` would
// have auto-reverted every healthy deploy. ODD_READS noticed it; nothing acted
// on it, which is why a counter is not a control. The fix routes an
// uninterpretable value away from SUCCESS_READS, so it reaches the
// `SUCCESS_READS -eq 0` -> unknown path that #4231 D3 already proved suppresses
// the rollback.
test('30/30 zero-byte reads are UNKNOWN and DO NOT roll back (#4238)', skipNoBash, () => {
  const r = runHealthStep({ probes: ['EMPTY,EMPTY'] });
  assert.equal(r.code, 1, `an uninterpretable control plane must still fail closed\n${r.out}`);
  assert.equal(
    r.verdict,
    'unknown',
    'a value the step cannot interpret is not a reading of the revision. Counting it as one is ' +
      `how a property rename becomes an auto-revert of every healthy deploy.\n${r.out}`,
  );
  assert.equal(
    rollbackFiresFor(r.verdict),
    false,
    'THE INVARIANT: a value the code cannot interpret must never produce a rollback. Evaluated ' +
      'against the shipped `if:` of the rollback step.',
  );
  assert.match(r.out, /NOT ONE poll returned a state this gate could interpret/, r.out);
  assert.match(
    r.out,
    /EXITS 0 AND PRINTS NOTHING/,
    'R7: the message must name the shape it actually saw — a query that stopped resolving — and ' +
      `not assert a revision state it never read.\n${r.out}`,
  );
});

// The counter-arm. Without it the assertion above is green for a predicate that
// is false for EVERY verdict, i.e. for a rollback that never fires at all.
test('a measured unhealthy DOES roll back — the predicate is not vacuously false', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Unhealthy,Running'] });
  assert.equal(r.verdict, 'unhealthy', r.out);
  assert.equal(
    rollbackFiresFor(r.verdict),
    true,
    `the rollback must still fire on a revision the control plane called Unhealthy\n${r.out}`,
  );
});

// Per FIELD, not per row: half a rename is still a rename. Neither half may be
// converted into "the revision is unhealthy".
test('an empty healthState with a good runningState is UNKNOWN', skipNoBash, () => {
  const r = runHealthStep({ probes: ['EMPTY,Running'] });
  assert.equal(r.verdict, 'unknown', r.out);
  assert.equal(rollbackFiresFor(r.verdict), false, r.out);
});

test('an empty runningState with a Healthy healthState is UNKNOWN', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,EMPTY'] });
  assert.equal(
    r.verdict,
    'unknown',
    'the step cannot confirm Running, and it must not turn that into "unhealthy" and revert a ' +
      `revision whose healthState it read as Healthy.\n${r.out}`,
  );
  assert.equal(rollbackFiresFor(r.verdict), false, r.out);
});

// …but an INTERPRETABLE `Unhealthy` is a measurement, and #4287 forbids
// overwriting a measurement with `unknown`. The uninterpretable-value rule must
// not become a way to suppress a rollback the control plane asked for.
test('Unhealthy with an unrecognised runningState is STILL unhealthy (#4287)', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Unhealthy,eastus'] });
  assert.equal(
    r.verdict,
    'unhealthy',
    `an odd runningState must not suppress a healthState the control plane returned\n${r.out}`,
  );
  assert.equal(rollbackFiresFor(r.verdict), true, r.out);
  assert.match(r.out, /not recognised members of RevisionHealthState/, r.out);
  assert.match(r.out, /this failure is about the QUERY and not about the revision/, r.out);
  // R7: the verdict is unhealthy while `interpretable reads: 0`. Without this
  // sentence those two facts read as a contradiction and the operator cannot
  // tell what the rollback stood on.
  assert.match(r.out, /interpretable reads: 0/, r.out);
  assert.match(
    r.out,
    /healthState WAS read as 'Unhealthy'/,
    `the message must name the read the verdict actually rests on\n${r.out}`,
  );
});

test('an unrecognised enum value is reported as a shape caveat, not as a revision state', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,eastus'] });
  assert.equal(r.code, 1, `"eastus" is not a runningState — this must fail closed\n${r.out}`);
  assert.equal(
    r.verdict,
    'unknown',
    'CHANGED BY #4238, deliberately. This arm used to expect `unhealthy` — i.e. it rolled the ' +
      'estate back on a value the step could not interpret. "eastus" in runningState says the ' +
      `--query stopped resolving; that is a claim about the query, not about the revision.\n${r.out}`,
  );
  assert.equal(rollbackFiresFor(r.verdict), false, r.out);
  assert.match(r.out, /empty or unrecognised value/, r.out);
  assert.match(r.out, /not about the revision/, r.out);
});

test('the shape caveat is ABSENT when every value was a known enum member', skipNoBash, () => {
  // A caveat printed on every failure is a caveat nobody reads. It must appear
  // only when an unrecognised value was actually observed.
  const r = runHealthStep({ probes: ['Unhealthy,Running'] });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(
    r.out,
    /not recognised members/,
    `a well-formed pair of enum members must not raise a shape caveat\n${r.out}`,
  );
});

// ── Everything #4231 added, still standing ─────────────────────────────────
test('twelve refused reads are UNKNOWN, never "unhealthy" (#4231 D1/D3, R7)', skipNoBash, () => {
  const r = runHealthStep({ probes: ['FAIL'] });
  assert.equal(r.code, 1, `an unreadable control plane must fail closed\n${r.out}`);
  assert.equal(
    r.verdict,
    'unknown',
    'a read that never succeeded says NOTHING about the revision. Writing "unhealthy" here ' +
      `would auto-revert a good deploy — measured in run 33429557771.\n${r.out}`,
  );
  assert.match(r.out, /Cannot say whether revision/, r.out);
  assert.match(
    r.out,
    /NOT ONE succeeded/,
    'the unknown branch is reachable ONLY when nothing was read, and the message must say so ' +
      'rather than quoting a failure threshold (#4287)',
  );
  assert.doesNotMatch(
    r.out,
    /never reached Healthy\+Running/,
    'an unknown must not be reported as a measured unhealthy',
  );
});

test('transient read failures below the budget do not poison a healthy verdict', skipNoBash, () => {
  const r = runHealthStep({ probes: ['FAIL', 'FAIL', 'FAIL', 'Healthy,Running'] });
  assert.equal(r.code, 0, `3 refused reads then Healthy+Running is a GOOD roll\n${r.out}`);
  assert.equal(r.verdict, 'healthy', r.out);
  assert.match(
    r.out,
    /control-plane read FAILED \(failed reads: 3, successful reads so far: 0/,
    'failed reads must be counted and named ALONGSIDE the successful count, since it is the ' +
      'successful count that decides unknown-vs-unhealthy (#4287)',
  );
});

// ── #4287 — THE ARM WITH NO FIXTURE, AND THE DEFECT IT WAS HIDING ───────────
// `FAILED_READS` used to be cumulative over the whole 30-poll budget, so twelve
// scattered refusals promoted the verdict to `unknown` no matter how many polls
// had successfully read the revision. `unknown` makes the rollback `if:` false,
// so a revision the control plane called Unhealthy was left LIVE — and the
// error text claimed "a revision state this step never read" about a state it
// had read twelve times. Both wrongs come from counting the wrong thing: the
// question `unknown` answers is "did I learn anything?", which is a count of
// SUCCESSES, not of failures. This is the shape the Gov sibling has always had.
test('successful Unhealthy reads interleaved with refusals are UNHEALTHY, not unknown (#4287)', skipNoBash, () => {
  // 12 successful `Unhealthy Running` reads alternating with 12 refusals; the
  // remaining polls of the 30-budget repeat the last entry (a refusal), so the
  // run ends on 12 successes and 18 failures — well past the old 12-failure
  // give-up threshold.
  const interleaved = Array.from({ length: 12 }, () => ['Unhealthy,Running', 'FAIL']).flat();
  const r = runHealthStep({ probes: interleaved });
  assert.equal(r.code, 1, r.out);
  assert.equal(
    r.verdict,
    'unhealthy',
    'the step READ this revision twelve times and every read said Unhealthy. Reporting that as ' +
      '`unknown` suppresses the rollback and leaves the estate parked on a revision the control ' +
      `plane called unhealthy — the exact outcome this gate exists to prevent.\n${r.out}`,
  );
  assert.match(
    r.out,
    /never reached Healthy\+Running/,
    'a measured unhealthy must be reported as a measured unhealthy',
  );
  assert.doesNotMatch(
    r.out,
    /a revision state this step never read/,
    'R7: the step must not deny a measurement it made twelve times',
  );
  assert.match(
    r.out,
    /interpretable reads: 12, uninterpretable reads: 0, failed reads: 18/,
    'the failure must name what was actually read and what was not, so the operator can tell a ' +
      'measured verdict from a starved one',
  );
});

test('one successful read among refusals is still enough to deny `unknown` (#4287)', skipNoBash, () => {
  // The boundary: exactly ONE poll established a state. That is information,
  // so the verdict is a measurement — not an absence of one.
  const r = runHealthStep({ probes: ['Unhealthy,Running', 'FAIL'] });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict, 'unhealthy', r.out);
  assert.match(r.out, /interpretable reads: 1, uninterpretable reads: 0, failed reads: 29/, r.out);
});

test('a healthy revision running a DIFFERENT image FAILS the gate (#2963)', skipNoBash, () => {
  const r = runHealthStep({
    probes: ['Healthy,Running'],
    image: 'acrtest.azurecr.io/loom-console:stale',
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /is running '.*stale' but this roll resolved/, r.out);
});

test('an unreadable image read-back is UNKNOWN, not a claimed mismatch (R7)', skipNoBash, () => {
  const r = runHealthStep({ probes: ['Healthy,Running'], imageReadFails: true });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict, 'unknown', `the healthy verdict must be corrected to unknown\n${r.out}`);
  assert.match(r.out, /Could not READ revision .* running image after 3 attempts/, r.out);
  assert.doesNotMatch(r.out, /but this roll resolved/, 'a failed read must not be reported as a mismatch');
});

// ── Static: the whole-row glob must not come back ──────────────────────────
test('the health decision compares each field against its OWN enum', () => {
  // EXECUTABLE LINES ONLY. The fix's own comment quotes the old line verbatim,
  // so a whole-body regex would match the COMMENT and this guard would be
  // satisfied by the description of the shape it exists to prevent.
  const body = stepBody(STEP_NAME)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // Non-weakening: strip the comments and there must still be a body to grade.
  assert.ok(body.includes('az containerapp revision show'), 'the comment strip removed the whole step');

  assert.doesNotMatch(
    body,
    /"\$STATE"\s*==\s*\*/,
    'the gate must not glob the concatenated ROW — each test could then be satisfied by the ' +
      'other field, which is the #4238 class',
  );
  assert.match(
    body,
    /"\$\{HEALTH,,\}"\s*==\s*"healthy"/,
    'healthState must be tested exactly, against its own field, and CASE-FOLDED — the exact ' +
      'literal "Healthy" re-creates the capital-H dependence the fix was named for (#4287)',
  );
  assert.match(
    body,
    /"\$\{RUNNING,,\}"\s*==\s*"running"\s*\|\|\s*"\$\{RUNNING,,\}"\s*==\s*"runningatmaxscale"/,
    'runningState must be tested against the ENUMERATED accepted set, folded — narrowing it to ' +
      'the bare "Running" literal, or leaving it case-sensitive, auto-reverts a healthy revision ' +
      'that is at max scale (#4231 D3, #4287)',
  );

  // #4287 — separately ADDRESSED, not separately SLICED. Two scalar --query
  // reads, each naming its own property; no multiselect, no positional split.
  assert.match(
    body,
    /--query properties\.healthState -o tsv/,
    'healthState must be read by its own name in its own scalar --query',
  );
  assert.match(
    body,
    /--query properties\.runningState -o tsv/,
    'runningState must be read by its own name in its own scalar --query',
  );
  assert.doesNotMatch(
    body,
    /\{\s*health\s*:|\{\s*running\s*:/,
    'a multiselect hash puts correctness back on FIELD ORDER. Measured on az 2.88.0, the tsv ' +
      'writer emits a hash in WRITTEN order (not by key as the previous comment claimed), so the ' +
      'gate would again be right for a reason nobody had verified (#4287)',
  );
  assert.doesNotMatch(
    body,
    /HEALTH="\$\{STATE%%|RUNNING="\$\{STATE##/,
    'no positional split of a shared row may return',
  );

  // #4287 — the unknown promotion must be keyed on the absence of information,
  // not on a count of failures. A cumulative failure count overwrote a MEASURED
  // unhealthy with `unknown` and suppressed the rollback of a bad deploy.
  assert.match(
    body,
    /SUCCESS_READS -eq 0/,
    '`unknown` must be gated on having read NOTHING — the shape gov-console-roll.yml has always ' +
      'had (`if [ "$READS" -eq 0 ]`). Gating it on FAILED_READS alone lets scattered throttling ' +
      'suppress the rollback of a revision the control plane called Unhealthy (#4287)',
  );
  assert.doesNotMatch(
    body,
    /if \[\[ \$FAILED_READS -ge 12 \]\]; then\s*\n?\s*VERDICT=unknown/,
    'the failure-count promotion to unknown must not come back',
  );
});

// ── The sibling Gov roll — cloud-parity, asserted BEHAVIOURALLY ─────────────
//
// THE PREVIOUS REVISION OF THIS TEST WAS AN OBSTRUCTION, NOT A GUARD, and this
// PR introduced it. It asserted the LITERAL arms `^\s*Healthy\)` and
// `^\s*Unhealthy\)` and called the Gov lane "clean". Those literals ARE the
// defect: `case "$H" in Healthy) … Unhealthy)` with no default arm means a
// lowercase `unhealthy` matches NEITHER arm and falls through, so THE GOV LANE
// NEVER ROLLED BACK A BAD REVISION — the case-sensitivity half of #4287,
// surviving in the sovereign boundary. Fixing the parity broke the test; a test
// that has to be deleted to fix a bug was defending the bug.
//
// It now asserts BEHAVIOUR: the shipped `case` block is EXTRACTED from
// gov-console-roll.yml and EXECUTED against each value, and the arm it takes is
// observed — including whether `az containerapp update` (the rollback) is
// actually invoked. Renaming an arm, reordering, or adding one re-runs against
// the real block; only a change in what the lane DOES can fail it.
//
// cloud-parity.md is die-hard: a fix that lands in Commercial and leaves the
// sovereign boundary broken is incomplete, not "Commercial-first".
const GOV_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'gov-console-roll.yml');
const GOV = readFileSync(GOV_PATH, 'utf8').replace(/\r\n/g, '\n');

function govHealthCaseBlock() {
  const m = GOV.match(/^([ \t]*)case "\$\{H,,\}" in$[\s\S]*?^\1esac$/m);
  assert.ok(
    m,
    'no case-FOLDED health `case` block in gov-console-roll.yml. Either it was renamed, or it ' +
      'reverted to the case-SENSITIVE `case "$H" in Healthy) …` shape — which is the #4287 ' +
      'defect: a lowercase `unhealthy` matches no arm, and Gov never rolls back a bad revision.',
  );
  return m[0];
}

/** Execute the SHIPPED Gov health `case` block for one healthState value. */
function runGovHealthArm(h, { probeOk = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gov-health-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const marker = path.join(dir, 'rollback-invoked').replace(/\\/g, '/');
  writeFileSync(
    path.join(bin, 'az'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${marker}"\nexit 0\n`,
    'utf8',
  );
  chmodSync(path.join(bin, 'az'), 0o755);

  const script = path.join(dir, 'arm.sh');
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      'APP=loom-console; RG=rg-loom; SHA=deadbeef; NEWREV=loom-console--0a1b2c3',
      'IMG=acr.azurecr.us/loom-console:new; ROLLBACK_IMAGE=acr.azurecr.us/loom-console:old',
      'i=1; READS=0; ODD=0; LAST_ODD=""',
      `PROBE_OK=${probeOk ? 'true' : 'false'}`,
      `H=${JSON.stringify(h)}`,
      govHealthCaseBlock(),
      'echo "FELL_THROUGH reads=$READS odd=$ODD"',
    ].join('\n'),
    'utf8',
  );

  const res = spawnSync('bash', ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return {
    code: res.status,
    out,
    rolledBack: existsSync(marker.replace(/\//g, path.sep)),
    fellThrough: /FELL_THROUGH/.test(out),
  };
}

test('Gov: Healthy in ANY casing exits 0 and does not roll back', skipNoBash, () => {
  for (const h of ['Healthy', 'healthy', 'HEALTHY']) {
    const r = runGovHealthArm(h);
    assert.equal(r.code, 0, `Gov must accept healthState '${h}'\n${r.out}`);
    assert.equal(r.rolledBack, false, `a healthy revision must not be rolled back ('${h}')\n${r.out}`);
  }
});

test('Gov: unhealthy in ANY casing ROLLS BACK (#4287, the half that survived in Gov)', skipNoBash, () => {
  for (const h of ['Unhealthy', 'unhealthy', 'UNHEALTHY']) {
    const r = runGovHealthArm(h);
    assert.equal(r.code, 1, `Gov must fail closed on healthState '${h}'\n${r.out}`);
    assert.equal(
      r.rolledBack,
      true,
      `MEASURED before this fix, for '${h}': the arms were the bare literals Healthy) and ` +
        'Unhealthy) with NO default, so any other casing matched nothing, fell through, and the ' +
        `sovereign lane left a bad revision live.\n${r.out}`,
    );
  }
});

test('Gov: an unrecognised value is NOT read as healthy and does NOT roll back', skipNoBash, () => {
  const r = runGovHealthArm('eastus');
  assert.equal(r.fellThrough, true, `an unrecognised state must keep polling, not decide\n${r.out}`);
  assert.equal(r.rolledBack, false, `R7: an unrecognised value is a claim about the --query\n${r.out}`);
  assert.match(r.out, /reads=0/, `an uninterpretable value must not reach READS\n${r.out}`);
  assert.match(r.out, /odd=1/, `it must be counted as uninterpretable\n${r.out}`);
});

test('Gov: a zero-byte read is uninterpretable, not a read (#4238 parity)', skipNoBash, () => {
  const r = runGovHealthArm('', { probeOk: true });
  assert.equal(r.fellThrough, true, r.out);
  assert.equal(r.rolledBack, false, r.out);
  assert.match(r.out, /reads=0/, `an empty successful read must not advance READS\n${r.out}`);
  assert.match(r.out, /odd=1/, r.out);
  assert.match(
    r.out,
    /ZERO BYTES/,
    `the log must name the shape: --query exited 0 and printed nothing\n${r.out}`,
  );
});

test('Gov: a FAILED probe is distinguished from a zero-byte one', skipNoBash, () => {
  const r = runGovHealthArm('', { probeOk: false });
  assert.equal(r.fellThrough, true, r.out);
  assert.equal(r.rolledBack, false, r.out);
  assert.match(r.out, /reads=0/, r.out);
  assert.match(
    r.out,
    /odd=0/,
    'a failed probe is already reported by the read itself. Counting it as an uninterpretable ' +
      `VALUE too would claim the --query is suspect when nothing was returned at all (R7).\n${r.out}`,
  );
});

test('Gov: healthState None counts as a read but decides nothing', skipNoBash, () => {
  const r = runGovHealthArm('None');
  assert.equal(r.fellThrough, true, r.out);
  assert.equal(r.rolledBack, false, r.out);
  assert.match(r.out, /reads=1/, `None is a recognised member — it IS a reading of the revision\n${r.out}`);
});

test('Gov never decides health by substring (#4238)', () => {
  const body = GOV.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  // Non-weakening: the file must actually still probe healthState, or every
  // assertion above is about a lane that no longer reads anything.
  assert.match(body, /properties\.healthState/, 'gov-console-roll.yml no longer probes healthState');
  assert.doesNotMatch(
    body,
    /==\s*\*"?(Un)?[Hh]ealthy"?\*|=\s*\*"?(Un)?[Hh]ealthy"?\*/,
    'the Gov roll must never adopt the #4238 substring shape',
  );
});

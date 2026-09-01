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
 * ── WHY THIS RUNS THE SHIPPED BASH ─────────────────────────────────────────
 * This repo has a recorded failure class of tests that model the CODE instead
 * of the thing: a substring/`includes` assertion over the step's text would
 * have been satisfied by the broken line exactly as happily as by the fixed
 * one, and a hand-written re-implementation of the loop can never disagree
 * with the loop. So this harness EXTRACTS the step's `run:` block from the
 * workflow verbatim, substitutes only the GitHub `${{ … }}` expressions —
 * failing loudly if any expression it does not know about survives — and
 * EXECUTES that text under `bash -e` (the runner's shell) with `az` and
 * `sleep` stubbed on PATH. The loop, the three-valued verdict, the failed-read
 * counting, the side-file stderr handling and the image read-back are the
 * SHIPPED text, not a model of it.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────
 * PROVEN: given a control-plane answer, which verdict this step writes to
 * $GITHUB_OUTPUT and whether it exits non-zero — i.e. whether an unhealthy
 * revision reaches live validation, and whether the rollback's
 * `verdict != 'unknown'` guard sees the right value.
 * NOT PROVEN: that real `az containerapp revision show --query
 * "{health:…, running:…}" -o tsv` orders its two columns health-then-running.
 * az's tsv writer emits a dict's values ordered by key ("health" < "running"),
 * so it does — but that is taken from the CLI's documented behaviour, not
 * measured here. Also NOT proven: the job-level `if:` wiring, a real ACA
 * revision, and either cloud's live estate. Those need a live roll.
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

/**
 * Execute the SHIPPED step against a stubbed control plane.
 *
 * @param {object} o
 * @param {string[]} [o.probes]  one entry per health poll: "<health>,<running>",
 *                               "FAIL" (the read itself is refused), or
 *                               "NOTAB:<value>" (a successful read whose row
 *                               carries no tab). The LAST entry repeats for
 *                               every further poll.
 * @param {boolean} [o.crlf]     the control plane terminates the row with CR
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
  // JMESPath the step asks for. Nothing here invents a response shape: the
  // health query is a two-key multiselect, whose tsv rendering is ONE row of
  // tab-separated values ordered by key (health, running).
  writeFileSync(
    path.join(bin, 'az'),
    [
      '#!/usr/bin/env bash',
      'Q=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--query" ]; then Q="$a"; fi',
      '  prev="$a"',
      'done',
      'case "$Q" in',
      '  *healthState*)',
      '    n=0',
      '    if [ -s "$STUB_COUNTER" ]; then n=$(cat "$STUB_COUNTER"); fi',
      '    n=$((n+1)); printf %s "$n" > "$STUB_COUNTER"',
      '    i=0; pick=""',
      '    for t in $STUB_PROBES; do',
      '      i=$((i+1)); pick="$t"',
      '      if [ "$i" -ge "$n" ]; then break; fi',
      '    done',
      '    if [ "$pick" = "FAIL" ]; then',
      '      echo "ERROR: (SubscriptionRequestsThrottled) stub: ARM refused this read" >&2',
      '      exit 1',
      '    fi',
      '    case "$pick" in',
      '      NOTAB:*)',
      '        printf "%s\\n" "${pick#NOTAB:}"',
      '        exit 0 ;;',
      '    esac',
      '    h="${pick%%,*}"; r="${pick##*,}"',
      '    if [ "${STUB_CRLF:-0}" = "1" ]; then printf "%s\\t%s\\r\\n" "$h" "$r"; else printf "%s\\t%s\\n" "$h" "$r"; fi',
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
  assert.equal(r.verdict, 'unhealthy', r.out);
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

// ── A row that cannot be split is a PARSING failure, not a revision verdict ──
// R7: if the --query shape ever drifts and the row arrives with no tab, the
// step must fail closed (it established nothing) AND must not let the operator
// read "the revision is unhealthy" out of a message about its own parsing.
test('a tab-less row fails CLOSED and is reported as a shape problem, not a revision state', skipNoBash, () => {
  const r = runHealthStep({ probes: ['NOTAB:Healthy'] });
  assert.equal(
    r.code,
    1,
    `a row that carries only one field cannot establish Healthy AND Running — it must fail closed\n${r.out}`,
  );
  assert.equal(r.verdict, 'unhealthy', r.out);
  assert.match(r.out, /came back with NO tab separator/, r.out);
  assert.match(r.out, /about the QUERY'S OUTPUT SHAPE and not about the revision/, r.out);
});

test('the shape caveat is ABSENT when every row split cleanly', skipNoBash, () => {
  // A caveat printed on every failure is a caveat nobody reads. It must appear
  // only when an unsplittable row was actually observed.
  const r = runHealthStep({ probes: ['Unhealthy,Running'] });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /NO tab separator/, `a well-formed row must not raise a shape caveat\n${r.out}`);
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
  assert.match(r.out, /control-plane read FAILED \(failed read 3\/12/, 'failed reads must be counted and named');
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
    /"\$HEALTH"\s*==\s*"Healthy"/,
    'healthState must be tested exactly, against its own field',
  );
  assert.match(
    body,
    /"\$RUNNING"\s*==\s*"Running"\s*\|\|\s*"\$RUNNING"\s*==\s*"RunningAtMaxScale"/,
    'runningState must be tested against the ENUMERATED accepted set — narrowing it to the bare ' +
      '"Running" literal auto-reverts a healthy revision that is at max scale (#4231 D3)',
  );
  assert.match(
    body,
    /HEALTH="\$\{STATE%%/,
    'the two tsv fields must be split out of the single read — one az call, two fields',
  );
});

// ── The sibling Gov roll, audited as #4238 asks ────────────────────────────
// AUDIT RESULT: clean. gov-console-roll.yml already decides on a `case` over
// the healthState value alone, whose patterns carry no globs, so it never had
// the whole-row shape. Pinned here so the Commercial fix and the Gov lane
// cannot drift apart — cloud-parity applies to the gate, not only the feature.
test('gov-console-roll.yml decides health by EXACT match, not by substring', () => {
  const gov = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'gov-console-roll.yml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const body = gov
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // Non-weakening: the file must actually still probe healthState, or this
  // whole assertion is vacuous.
  assert.match(body, /properties\.healthState/, 'gov-console-roll.yml no longer probes healthState');
  // It uses `case "$H" in Healthy) … Unhealthy) …`, whose patterns carry no
  // globs and therefore match the enum members exactly.
  assert.match(body, /^\s*Healthy\)\s/m, 'the Gov roll must keep an exact-literal Healthy arm');
  assert.match(body, /^\s*Unhealthy\)\s/m, 'the Gov roll must keep an exact-literal Unhealthy arm');
  assert.doesNotMatch(
    body,
    /==\s*\*"?(Un)?Healthy"?\*|=\s*\*"?(Un)?Healthy"?\*/,
    'the Gov roll must never adopt the #4238 substring shape',
  );
});

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
 * ── MUTATION RECORD (MEASURED, not predicted; baseline 34 pass / 0 fail) ────
 *
 * Each mutation was applied with a byte-delta assertion (the repo is checked
 * out CRLF, so every read here normalises to LF first — a multi-line needle
 * with a literal newline matches NOTHING against the on-disk bytes and a
 * "mutation" that never applied proves the opposite of what it looks like).
 *
 *   M1  decideEstateRegression: return {verdict:'ok'} when estateTag !== the
 *       roll's SHA — i.e. the gate that cannot fail          -> 4 RED
 *   M2  decideEstateRegression: treat an unreadable estate as 'ok'
 *       (UNKNOWN collapsed into a pass)                       -> 2 RED
 *   M3  selectLastConsoleRoll: take the last run by conclusion rather than by
 *       JOB conclusion — the 32006479915 shape                -> 2 RED
 *   M4  decidePinRefresh: drop the re-pin and keep the stale pins
 *                                                             -> 3 RED
 *   M5  decidePinRefresh: proceed when the fresh read failed   -> 2 RED
 *   M6  rename the roll lane's `Roll image + validate live URL` job
 *                                                             -> 1 RED
 *   M7  delete the deploy lane's post-apply gate step          -> 3 RED
 *
 * The four CONTROL tests at the bottom stayed GREEN under all seven.
 *
 * Run: node --test scripts/ci/__tests__/roll-race.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  APP_IMAGE_TAGS,
  CONSOLE_IMAGE_KEY,
  CONSOLE_ROLL_SOURCES,
  SHA_TAG_RE,
  cliMain,
  comparePins,
  decideEstateRegression,
  decidePinRefresh,
  parseRollRunTitle,
  pinsFromEnv,
  resolveRunningImageTags,
  selectLastConsoleRoll,
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
  assert.match(sel.reason, /none with a successful roll job/);
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

test('the estate ON the last roll SHA passes', () => {
  const sel = selectLastConsoleRoll([
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
    const resolved = argv.map((a) => (paths[a] ? paths[a] : a));
    const code = cliMain(resolved, {
      readFile: (p) => readFileSync(p, 'utf8'),
      writeEnv: (l) => envLines.push(l),
      writeOutput: (l) => outLines.push(l),
      log: (s) => logs.push(s),
      env,
    });
    return { code, logs: logs.join('\n'), envLines, outLines };
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
      '--estate-image', `acrloom.azurecr.io/loom-console:${STALE}`,
      '--rolls', 'rolls.json',
    ],
    {
      files: {
        'rolls.json': [{
          id: 32004219673, workflow: 'loom-roll-and-validate.yml',
          title: `roll ${ROLLED} (build-triggered)`,
          completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
        }],
      },
    },
  );
  assert.equal(r.code, 1);
  assert.match(r.logs, /::error::ESTATE REGRESSION \(#3676\)/);
  assert.match(r.logs, /REMEDIATION: dispatch/);
  assert.match(r.logs, /loom-roll-and-validate\.yml with image_tag/);
});

test('CLI assert-estate-not-behind-roll: a digest-pinned console is UNKNOWN (exit 1), not OK', () => {
  const r = runCli(
    [
      'assert-estate-not-behind-roll',
      '--applied-tag', STALE,
      '--estate-image', 'acrloom.azurecr.io/loom-console@sha256:' + 'b'.repeat(64),
      '--rolls', 'rolls.json',
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
      '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
      '--rolls', 'rolls.json',
    ],
    {
      files: {
        'rolls.json': [{
          id: 1, workflow: 'loom-roll-and-validate.yml', title: `roll ${ROLLED} (build-triggered)`,
          completedAt: '2026-08-17T07:15:30Z', jobConclusion: 'success',
        }],
      },
    },
  );
  assert.equal(r.code, 0);
  assert.match(r.logs, /::notice::estate-vs-roll: OK/);
  assert.match(r.logs, new RegExp(ROLLED));
});

test('CLI assert-estate-not-behind-roll: --rolls-error fails closed (exit 1)', () => {
  const r = runCli([
    'assert-estate-not-behind-roll',
    '--applied-tag', ROLLED,
    '--estate-image', `acrloom.azurecr.io/loom-console:${ROLLED}`,
    '--rolls-error', 'HTTP 403',
  ]);
  assert.equal(r.code, 1);
  assert.match(r.logs, /UNKNOWN, which fails closed/);
  assert.match(r.logs, /HTTP 403/);
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

function runStep(namePrefix, { env = {}, fixtures = {}, azList = null } = {}) {
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

  const dir = mkdtempSync(join(tmpdir(), 'roll-race-step-'));
  try {
    const binDir = join(dir, 'bin');
    const fixDir = join(dir, 'fixtures');
    const runnerTemp = join(dir, 'runner-temp');
    for (const d of [binDir, fixDir, runnerTemp]) mkdirSync(d, { recursive: true });
    writeFileSync(join(binDir, 'gh'), GH_STUB);
    writeFileSync(join(binDir, 'az'), AZ_STUB);
    chmodSync(join(binDir, 'gh'), 0o755);
    chmodSync(join(binDir, 'az'), 0o755);
    for (const [name, body2] of Object.entries(fixtures)) {
      writeFileSync(join(fixDir, name), typeof body2 === 'string' ? body2 : JSON.stringify(body2));
    }
    const azListFile = join(dir, 'az-list.json');
    if (azList) writeFileSync(azListFile, JSON.stringify(azList));

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
        AZ_LIST_FILE: azListFile,
      },
    });
    return {
      status: res.status,
      out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      envFile: readFileSync(ghEnvFile, 'utf8'),
      outFile: readFileSync(ghOutFile, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test('SHELL: THE INCIDENT end to end — stale image + a newer shipped roll exits 1', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: STALE,
      MEASURED_AT: '2026-08-17T07:03:40Z',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      AZ_SHOW_IMAGE: `acrloom.azurecr.io/loom-console:${STALE}`,
    },
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
  assert.match(r.out, /REMEDIATION: dispatch/);
});

test('SHELL: a roll that concluded success with its roll job SKIPPED does not clear the gate', { skip: shellSkip }, () => {
  // Run 32006479915's real shape. If the step read the RUN conclusion instead
  // of the JOB conclusion this would report the estate as correct.
  const r = runStep(ESTATE_STEP, {
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: STALE,
      MEASURED_AT: '2026-08-17T07:03:40Z',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      AZ_SHOW_IMAGE: `acrloom.azurecr.io/loom-console:${STALE}`,
    },
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
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: ROLLED,
      MEASURED_AT: '2026-08-17T07:03:40Z',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      AZ_SHOW_IMAGE: `acrloom.azurecr.io/loom-console:${ROLLED}`,
    },
    fixtures: {
      'roll-runs.json': rollRunsPayload([
        { id: 32004219673, display_title: `roll ${ROLLED} (build-triggered)`, head_sha: 'deadbeef', updated_at: '2026-08-17T07:15:30Z' },
      ]),
      'full-runs.json': rollRunsPayload([]),
      'jobs-32004219673.json': { jobs: [{ name: 'Roll image + validate live URL', conclusion: 'success' }] },
    },
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /estate-vs-roll: OK/);
});

test('SHELL: an unreadable Actions API fails CLOSED rather than passing quietly', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: ROLLED,
      MEASURED_AT: '2026-08-17T07:03:40Z',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      AZ_SHOW_IMAGE: `acrloom.azurecr.io/loom-console:${ROLLED}`,
      GH_FAIL: '1',
    },
    fixtures: { 'roll-runs.json': rollRunsPayload([]), 'full-runs.json': rollRunsPayload([]) },
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /UNKNOWN, which fails closed/);
  assert.match(r.out, /403/, 'the failure must carry what gh actually said');
});

test('SHELL: an unreadable container app fails CLOSED', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: ROLLED,
      MEASURED_AT: '2026-08-17T07:03:40Z',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      AZ_SHOW_IMAGE: '',
      AZ_SHOW_ERR: 'ERROR: (ResourceNotFound) loom-console was not found',
    },
    fixtures: {
      'roll-runs.json': rollRunsPayload([]),
      'full-runs.json': rollRunsPayload([]),
    },
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ResourceNotFound/);
});

test('SHELL: a whatif run that applied no tag passes without touching the Actions API', { skip: shellSkip }, () => {
  const r = runStep(ESTATE_STEP, {
    env: {
      GH_TOKEN: 'x',
      DEPLOY_SUB: '',
      APPLIED_TAG: '',
      MEASURED_AT: '',
      AZURE_LOCATION: 'centralus',
      GITHUB_REPOSITORY: 'acme/csa-inabox',
      // No fixtures at all: reaching gh or az here would exit 99.
      AZ_SHOW_IMAGE: '',
    },
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /applied no loom-console image tag/);
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
    writeFileSync(ghEnv, '');
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
  const r = runLease(['acquire', '--acr', 'acrtest', '--no-open'], { env: { LOOM_ACR_LEASE_OWNER: 'deployRun' } });
  assert.match(r.ghEnv, /^ACR_LEASE_STATE=held$/m,
    'acquire and release run in different shells in every CI caller; without this the state is always back at ' +
      'its default by release time and "my lease was erased" cannot be told from "I never had one"');
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

test('the deploy lane RE-PINS immediately before the apply, and the apply follows it', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const repin = yaml.indexOf('- name: Re-pin appImageTags to the RUNNING images');
  const provision = yaml.indexOf('- name: Provision (idempotent)');
  assert.notEqual(repin, -1, 'the re-pin step is gone; the pin applied would again be the one measured ~20 minutes earlier (#3676)');
  assert.notEqual(provision, -1);
  assert.ok(repin < provision, 'the re-pin must run BEFORE the apply — after it, it changes nothing');
  // Comments are stripped for the same reason as in the result-discarding test:
  // the step between these two EXPLAINS why `az deployment sub create` rewrites
  // the registry, and matching that prose reported a violation that was a
  // sentence, not a command.
  const between = yaml
    .slice(repin, provision)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/az deployment sub create/.test(between),
    'nothing may submit a deployment between the re-measurement and the apply it is for',
  );
});

test('the deploy lane still runs the post-apply estate-vs-roll gate, and it cannot be skipped away', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const i = yaml.indexOf('- name: Estate must not be BEHIND the last successful roll');
  assert.notEqual(i, -1, 'the post-apply regression gate is gone — a backwards move would again produce no signal');
  const step = yaml.slice(i, i + 2500);
  assert.match(step, /if: always\(\) && steps\.provision\.conclusion != 'skipped'/,
    'the gate must run even when the apply FAILED: a failed apply can still have written the container app');
  assert.ok(!/continue-on-error/.test(step), 'a gate whose result is discarded is not a gate');
  assert.match(step, /assert-estate-not-behind-roll/);
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
function stepBodyByName(yaml, name) {
  const start = yaml.indexOf(`      - name: ${name}`);
  if (start === -1) return null;
  const rest = yaml.slice(start + 1);
  const nextRel = rest.search(/\n {6}- name: /);
  const body = nextRel === -1 ? rest : rest.slice(0, nextRel);
  return body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('neither new deploy step discards a result (no continue-on-error / || true / 2>/dev/null)', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const names = [
    'Re-pin appImageTags to the RUNNING images (closes the roll race — #3676)',
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

test('the deploy lane grants actions:read, or the gate fails closed on every run', () => {
  const yaml = readNorm(DEPLOY_WORKFLOW);
  const m = /^permissions:\n((?:[ \t]+\S.*\n|[ \t]*#.*\n)+)/m.exec(yaml);
  assert.ok(m, 'deploy-fiab-commercial.yml declares no top-level permissions block');
  assert.match(m[1], /^\s*actions:\s*read\s*$/m,
    'without actions:read the gh calls in the estate gate 403 and the gate reports UNKNOWN forever — a ' +
      'permanently red deploy lane reads as a broken deploy path (deploy-integrity R1)');
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

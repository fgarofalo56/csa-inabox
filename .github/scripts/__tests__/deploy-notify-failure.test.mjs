/**
 * deploy-notify-failure.test.mjs
 *
 * The notifier this replaces failed three ways at once: it posted to a CLOSED
 * issue, its body carried no cause, and its promise was neither awaited nor
 * returned so an API rejection could not fail the step. Each of those is a test
 * here.
 *
 * Run: node --test .github/scripts/__tests__/deploy-notify-failure.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIssueTitle,
  buildIssueBody,
  notifyFailure,
  shouldFile,
  FAILURE_LABEL,
} from '../deploy-notify-failure.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function recorder(handlers) {
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    for (const [re, fn] of handlers) {
      if (re.test(`${method} ${url}`)) return fn(body);
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
  return { request, calls };
}

const QUOTA_FAILURE = {
  class: 'quota',
  signalId: 'quota.exceeded',
  retryable: false,
  attempts: [{ attempt: 1, exitCode: 1, class: 'quota' }],
  whyStopped: 'not retrying: class "quota" is not in --class-allow (transient).',
  established: [{ signal: 'quotaexceeded', line: 'ERROR: QuotaExceeded: standardDDSv5Family Cores' }],
  remediationKind: 'operator-action',
  remediation: 'The subscription is at a quota limit in this region. Retrying cannot help.',
  portalPath: 'Subscription > Usage + quotas',
};

test('the notice targets a DEDICATED issue titled per workflow, never a hard-coded number', async () => {
  const { request, calls } = recorder([
    [/^GET /, () => []],
    [/^POST .*\/issues$/, (b) => ({ number: 4242, ...b })],
  ]);
  const r = await notifyFailure({
    repo: 'o/r',
    workflow: 'deploy-fiab-commercial',
    body: 'x',
    request,
  });
  assert.equal(r.created, true);
  assert.equal(r.issueNumber, 4242);
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'));
  assert.equal(create.body.title, 'deploy: deploy-fiab-commercial is failing');
  assert.deepEqual(create.body.labels, [FAILURE_LABEL]);
});

test('only OPEN issues are searched — a closed notice must never be reused', async () => {
  const { request, calls } = recorder([
    [/^GET /, () => []],
    [/^POST .*\/issues$/, () => ({ number: 1 })],
  ]);
  await notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'x', request });
  const search = calls.find((c) => c.method === 'GET');
  assert.match(search.url, /state=open/, 'the search must be scoped to OPEN issues');
});

test('an existing open notice is commented on, not duplicated', async () => {
  const { request, calls } = recorder([
    [/^GET /, () => [{ number: 77, title: buildIssueTitle('wf') }]],
    [/^POST .*\/comments$/, () => ({ id: 1 })],
  ]);
  const r = await notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'the body', request });
  assert.equal(r.created, false);
  assert.equal(r.issueNumber, 77);
  assert.equal(calls.filter((c) => c.url.endsWith('/issues')).length, 0, 'no duplicate issue');
  assert.equal(calls.find((c) => c.url.includes('/comments')).body.body, 'the body');
});

test('a PR that happens to share the title is not mistaken for the notice issue', async () => {
  const { request, calls } = recorder([
    [/^GET /, () => [{ number: 9, title: buildIssueTitle('wf'), pull_request: { url: 'x' } }]],
    [/^POST .*\/issues$/, () => ({ number: 10 })],
  ]);
  const r = await notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'x', request });
  assert.equal(r.created, true);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/issues')));
});

test('MUTATION-RELEVANT — an API failure FAILS the notifier, it is not swallowed', async () => {
  const { request } = recorder([
    [/^GET /, () => {
      throw new Error('403 rate limited');
    }],
  ]);
  await assert.rejects(
    () => notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'x', request }),
    /403 rate limited/,
  );
});

test('a non-array search result is an error, not "no issue exists"', async () => {
  // A truncated / errored search that returned an object must NOT be read as
  // "nothing found" — that would silently open a duplicate every run
  // (csa_loom_unknown_as_negative_class).
  const { request } = recorder([[/^GET /, () => ({ message: 'Bad credentials' })]]);
  await assert.rejects(
    () => notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'x', request }),
    /cannot tell whether a notice issue exists/,
  );
});

test('a creation that returns no number is an error, not a silent success', async () => {
  const { request } = recorder([
    [/^GET /, () => []],
    [/^POST .*\/issues$/, () => ({})],
  ]);
  await assert.rejects(() => notifyFailure({ repo: 'o/r', workflow: 'wf', body: 'x', request }), /was not filed/);
});

// ── the BODY carries a cause, which "Check workflow logs" never did ──────────

test('the body names the class, what was established, and the remediation', () => {
  const body = buildIssueBody({
    workflow: 'build-fiab-images-acr-tasks',
    runId: '123',
    runUrl: 'https://example/runs/123',
    sha: 'abc1234',
    failure: QUOTA_FAILURE,
  });
  assert.match(body, /Classification: quota/);
  assert.match(body, /quota\.exceeded/);
  assert.match(body, /Established from the output/);
  assert.match(body, /standardDDSv5Family Cores/);
  assert.match(body, /Usage \+ quotas/);
  assert.doesNotMatch(body, /Check workflow logs/);
});

test('R7 — with no classification captured, the body says SO and asserts nothing', () => {
  const body = buildIssueBody({ workflow: 'wf', runId: '1', runUrl: 'u', sha: 's', failure: null });
  assert.match(body, /No classification was captured/);
  assert.doesNotMatch(body, /Classification: /);
  assert.doesNotMatch(body, /does not exist/i);
});

test('R7 — an unknown classification is reported as a taxonomy gap, not as a cause', () => {
  const body = buildIssueBody({
    workflow: 'wf',
    runId: '1',
    runUrl: 'u',
    sha: 's',
    failure: { class: 'unknown', signalId: null, retryable: false, attempts: [{}], whyStopped: 'unknown fails closed' },
  });
  assert.match(body, /no cause is asserted/i);
  assert.match(body, /failure-taxonomy\.json/);
});

test('the body states R1/R2 so a merge is never mistaken for a fix', () => {
  const body = buildIssueBody({ workflow: 'wf', runId: '1', runUrl: 'u', sha: 's', failure: QUOTA_FAILURE });
  assert.match(body, /P0/);
  assert.match(body, /run GREEN/);
});

// ── CANCELLED IS NOT FAILED (#3368) ──────────────────────────────────────────
//
// The issue's acceptance criterion is explicit that a one-directional test is
// half a guard: "feed the filer a `cancelled` conclusion and assert NO issue is
// created; feed it `failure` and assert one IS. Both directions."

test('ACCEPTANCE — a `cancelled` outcome files NOTHING', () => {
  const d = shouldFile('cancelled');
  assert.equal(d.file, false);
  assert.equal(d.category, 'no-verdict');
  assert.match(d.why, /produced NO verdict/);
  // R7: the reason must not assert a failure it did not establish.
  assert.doesNotMatch(d.why, /genuinely failed/);
});

test('ACCEPTANCE — a `failure` outcome DOES file', () => {
  const d = shouldFile('failure');
  assert.equal(d.file, true);
  assert.equal(d.category, 'failure');
  assert.match(d.why, /genuinely failed/);
});

test('MUTATION TABLE — every outcome, and the two directions never collapse', () => {
  const table = [
    ['failure', true],
    ['timed_out', true],
    ['startup_failure', true],
    ['success', false],
    ['cancelled', false], // #3356: the exact conclusion that filed a false P0
    ['skipped', false],
    ['neutral', false],
    ['action_required', false],
    ['in_progress', false],
    ['', false],
    [null, false],
    ['a_state_github_has_not_invented_yet', false],
  ];
  for (const [result, file] of table) {
    assert.equal(shouldFile(result).file, file, `${JSON.stringify(result)} → file=${file}`);
  }
  // Non-degenerate: the table must contain BOTH directions, or it proves nothing.
  assert.ok(table.some(([, f]) => f === true), 'no filing case in the table');
  assert.ok(table.some(([, f]) => f === false), 'no refusing case in the table');
});

test('a SUCCESS is refused with a message that blames the caller, not the deploy', () => {
  // If this is ever reached, the caller's `if:` is wrong. Say that, rather than
  // filing "the deploy path is failing" over a green run.
  const d = shouldFile('success');
  assert.equal(d.file, false);
  assert.match(d.why, /SUCCEEDED/);
  assert.match(d.why, /`if:` condition is wrong/);
});

// ── THE ADOPTION RATCHET ─────────────────────────────────────────────────────
//
// "The correct helper existed, siblings never adopted it" and "six consumers had
// the fix and the seventh broke the deploy" are both recorded failure modes
// here. Enumerate the callers MECHANICALLY so a sixth one added later cannot
// quietly skip the flag.

function notifyInvocations() {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Each invocation plus its continuation lines, up to the blank line/next step.
    const re = /node\s+\.github\/scripts\/deploy-notify-failure\.mjs([\s\S]*?)(?=\n\s*\n|\n\s{0,8}-\s|\n\s{0,6}[a-z-]+:\s|$)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      hits.push({ file: f, invocation: m[0] });
    }
  }
  return hits;
}

test('RATCHET — every deploy-notify-failure caller passes --result', () => {
  const hits = notifyInvocations();
  // Fail closed on a broken matcher: this repo has five call sites today, and
  // zero would mean the regex drifted, not that the callers vanished.
  assert.ok(hits.length >= 5, `expected >=5 call sites, found ${hits.length} — the matcher drifted`);
  const missing = hits.filter((h) => !/--result\b/.test(h.invocation)).map((h) => h.file);
  assert.deepEqual(
    missing,
    [],
    'a caller invokes the filer without --result; it cannot tell a failure from a cancellation and will file blind (#3368)',
  );
});

test('RATCHET — no caller gates the filer on a `!= \'success\'` predicate', () => {
  // The literal shape that filed #3356. `!= 'success'` is true for `cancelled`
  // and `skipped`, so it can never be the trigger for a P0 filer.
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!src.includes('deploy-notify-failure.mjs')) continue;
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*if:.*\.result\s*!=\s*'success'/.test(line)) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], 'a filer is gated on `result != \'success\'`, which fires on cancelled (#3356)');
});

test('SELF-DEFENCE — the ratchet can actually detect the defect it guards', () => {
  // A guard whose population is zero protects nothing once the debt is paid, so
  // prove the predicates against the VERBATIM before-shapes rather than only
  // against the fixed tree.
  const before = "        if: ${{ needs.redeploy-with-apps.result != 'success' || needs.build.result == 'failure' }}";
  assert.ok(/^\s*if:.*\.result\s*!=\s*'success'/.test(before), 'the != success matcher must catch the #3356 line');
  const after = "        if: ${{ needs.redeploy-with-apps.result == 'failure' }}";
  assert.equal(/^\s*if:.*\.result\s*!=\s*'success'/.test(after), false, 'and must not catch the fixed line');

  const noFlag = 'node .github/scripts/deploy-notify-failure.mjs \\\n  --workflow x \\\n  --failure-json y.json';
  assert.equal(/--result\b/.test(noFlag), false, 'the --result matcher must catch an unadopted caller');
});

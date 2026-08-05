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

import {
  buildIssueTitle,
  buildIssueBody,
  notifyFailure,
  FAILURE_LABEL,
} from '../deploy-notify-failure.mjs';

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

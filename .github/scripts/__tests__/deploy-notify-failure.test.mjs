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
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildIssueTitle,
  buildIssueBody,
  notifyFailure,
  shouldFile,
  formatStdout,
  formatStderr,
  FAILURE_LABEL,
} from '../deploy-notify-failure.mjs';
import {
  streamWrites,
  stripComments,
  unboundedWrites,
  callCount,
  forbiddenPublishers,
  inheritedStreamSpawns,
  CONTROL_SOURCE_CRLF,
} from '../../../scripts/ci/__tests__/_publication-surfaces.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'deploy-notify-failure.mjs');

/** The synthetic id every redaction fixture in this file is poisoned with. */
const SYNTHETIC_OID = '11111111-2222-3333-4444-555555555555';

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

// ── THE PUBLIC-REPO REDACTION BOUNDARY (#3829) ───────────────────────────────
//
// This repo is PUBLIC and this script is its widest-audience publisher. On
// #3817 the auto-posted body carried a raw Entra object id: `redact()` was
// applied to `leaf.message` and `evidence.line` at their composition sites but
// NOT to `whyStopped`, which `decideRetryForLeaves` builds by embedding a
// leaf's `resourceName` — `<server>/<objectId>` for a
// flexibleServers/administrators leaf.
//
// The fix redacts the ASSEMBLED body once, so these tests are written against
// the PROPERTY ("no GUID leaves this function") rather than against the one
// field that leaked. Every GUID below is obviously synthetic.

/** The assertion under test. Deliberately the issue's own pattern, verbatim. */
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The VERBATIM pre-fix shape, reconstructed from #3817's posted body. */
const LEAKED_WHY_STOPPED =
  "not retrying: 1 ARM leaf(s) could not be classified (ResourceDeploymentFailure on " +
  "'psql-loom-weave-default-abc123/11111111-2222-3333-4444-555555555555' → unknown), so nothing is known " +
  'about whether retrying could help. Unknown fails closed (deploy-integrity.md R7).';

test('POSITIVE CONTROL — the GUID assertion FIRES on the pre-fix body shape', () => {
  // A redaction test whose fixture happens to contain no GUID passes forever
  // while proving nothing (the zero-population shape this repo has been bitten
  // by). Prove the assertion can fail BEFORE trusting it to pass: run it
  // against the literal string #3817 published.
  assert.match(LEAKED_WHY_STOPPED, GUID_RE, 'the GUID matcher must detect the value that actually leaked');
  assert.equal(
    GUID_RE.test('psql-loom-weave-default-abc123/<guid>'),
    false,
    'and must NOT fire on the redacted form, or it could never go green',
  );
});

test('ACCEPTANCE — a GUID in whyStopped does NOT reach the issue body, and the field survives redacted', () => {
  const failure = { ...QUOTA_FAILURE, whyStopped: LEAKED_WHY_STOPPED };

  // Direction 1 — the fixture is genuinely populated. Without this the "no
  // GUID in the body" assertion below could be satisfied by an empty input.
  assert.match(failure.whyStopped, GUID_RE, 'the INPUT must carry a GUID or this test proves nothing');

  const body = buildIssueBody({ workflow: 'wf', runId: '1', runUrl: 'u', sha: 'abc1234', failure });

  // Direction 2 — the guard itself.
  assert.doesNotMatch(body, GUID_RE, 'a GUID-shaped substring reached a PUBLIC issue body (#3829)');

  // Direction 3 — REDACTED, not DROPPED. A body that silently omitted
  // whyStopped would also contain no GUID and would be a false pass, while
  // destroying the diagnostic R6 requires. The surrounding context must
  // survive with `<guid>` substituted in place.
  assert.match(body, /stopped because: not retrying/, 'the field must still be reported');
  assert.match(body, /psql-loom-weave-default-abc123\/<guid>/, 'the id must be REDACTED in place, not removed');
});

test('BY CONSTRUCTION — no field of the body can carry a GUID, including ones that never leaked', () => {
  // The point of redacting the assembled body rather than `whyStopped` is that
  // a field nobody thought about is covered too. Poison EVERY input — the
  // artifact fields AND the environment-derived ones — and assert the property
  // holds for all of them at once.
  const g = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-2222-3333-444444444444`;
  const body = buildIssueBody({
    workflow: `deploy-${g(1)}`,
    runId: '1',
    runUrl: `https://example/runs/${g(2)}`,
    sha: g(3),
    failure: {
      class: 'permission',
      signalId: `permission.${g(4)}`,
      retryable: false,
      attempts: [{}],
      whyStopped: `blocked on ${g(5)}`,
      established: [{ signal: 'authorizationfailed', line: `principal ${g(6)} lacks access` }],
      remediationKind: 'operator-action',
      remediation: `Grant the UAMI ${g(7)} the Contributor role`,
      grantHint: `az role assignment create --assignee ${g(8)}`,
      portalPath: `Subscription ${g(9)} > IAM`,
    },
  });

  // Non-degenerate: every poisoned value really is GUID-shaped.
  for (let n = 1; n <= 9; n += 1) assert.match(g(n), GUID_RE, `control value ${n} is not GUID-shaped`);
  // ALL of them, in one assertion over the whole body.
  assert.doesNotMatch(body, GUID_RE, 'some field of the assembled body still publishes a GUID (#3829)');
  // …and the body is still a useful notice, not a redacted husk.
  assert.match(body, /Classification: permission/);
  assert.match(body, /Contributor role/);
});

test('the ARM-id and subscription-id forms are stripped from the body too', () => {
  const body = buildIssueBody({
    workflow: 'wf',
    runId: '1',
    runUrl: 'u',
    sha: 's',
    failure: {
      ...QUOTA_FAILURE,
      whyStopped:
        'scope /subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-csa-loom-admin-centralus',
    },
  });
  assert.doesNotMatch(body, GUID_RE);
  assert.doesNotMatch(body, /\/subscriptions\/[0-9a-f-]{36}/i);
  assert.match(body, /rg-csa-loom-admin-centralus/, 'the useful last segment must survive');
});

// ── THE POSTER BOUNDARY, NOT THE BODY BUILDER (#3829 round 2) ────────────────
//
// Round 1 put the redaction at the end of buildIssueBody(), one level ABOVE the
// place the payload actually leaves the process, and titled the PR "redact at
// the issue-poster boundary". Two holes were measured at that head:
//
//   buildIssueTitle('deploy-<guid>')  -> "deploy: deploy-<guid> is failing"  LEAK
//   notifyFailure({ body: '<hand-built string>' })                          LEAK
//
// The title reaches the same public issue — and the issue LIST — and
// notifyFailure() posts whatever `body` it is handed. The redaction now sits in
// notifyFailure() over BOTH, which makes the claim literally true.

/** A GUID glued to a word char on ONE side — the residual round 1 got wrong. */
const GLUED_GUID = 'deploy_11111111-2222-3333-4444-555555555555';

test('POSITIVE CONTROL — the pre-fix TITLE really did carry a GUID', () => {
  // buildIssueTitle() is unredacted BY DESIGN: it is the pure title shape, and
  // the redaction is at the poster. Prove the input is genuinely poisoned, so
  // the assertion below is not passing on an empty string.
  const raw = buildIssueTitle(GLUED_GUID);
  assert.match(raw, GUID_RE, 'the title builder must be the thing that carries the id, or the next test is vacuous');
});

test('ACCEPTANCE — the TITLE is redacted at the poster, on create AND on the search', async () => {
  // Both repos, for the reason the hand-built-body test spells out: `repo ===
  // 'o/r' ? redact(title) : title` survived 31/31 while every fixture in this
  // file used the stand-in. The title has no second redactor anywhere on its
  // path — buildIssueTitle() is unredacted by design — so this is the only place
  // that key can be caught.
  for (const repo of ['o/r', 'fgarofalo56/csa-inabox']) {
    const { request, calls } = recorder([
      [/^GET /, () => []],
      [/^POST .*\/issues$/, (b) => ({ number: 4243, ...b })],
    ]);
    const r = await notifyFailure({ repo, workflow: GLUED_GUID, body: 'x', request });
    assert.equal(r.created, true);

    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'));
    assert.doesNotMatch(create.body.title, GUID_RE, `${repo}: a GUID reached a PUBLIC issue TITLE (#3829)`);
    // REDACTED, not dropped: the title must still identify the workflow.
    assert.equal(create.body.title, 'deploy: deploy_<guid> is failing');
  }
});

test('the notice is FOUND by its redacted title — redaction must not open a duplicate every run', async () => {
  // If the title were redacted only on create, the next run's search would look
  // for the RAW title, miss, and open a second issue. Feed the search the
  // redacted title and assert it is matched and commented on.
  const { request, calls } = recorder([
    [/^GET /, () => [{ number: 88, title: 'deploy: deploy_<guid> is failing' }]],
    [/^POST .*\/comments$/, () => ({ id: 1 })],
  ]);
  const r = await notifyFailure({ repo: 'o/r', workflow: GLUED_GUID, body: 'x', request });
  assert.equal(r.created, false, 'the existing notice must be reused, not duplicated');
  assert.equal(r.issueNumber, 88);
  assert.equal(calls.filter((c) => c.url.endsWith('/issues')).length, 0, 'no duplicate issue');
});

test('ACCEPTANCE — a HAND-BUILT body is redacted at the poster, for every REAL caller name', async () => {
  // `body` is a parameter. Round 1 redacted inside buildIssueBody(), so any
  // caller that assembled its own string — the shape every future caller is one
  // refactor away from — posted it verbatim.
  //
  // The workflow name is NOT the contrived 'wf' this test used in round 2. A
  // bypass keyed to the caller population — `String(workflow).startsWith('deploy-')`
  // — left the suite fully green while every live caller took the bypass, and two
  // of the five live callers do not even carry that prefix. So the population is
  // read MECHANICALLY out of the workflows and every member is exercised: a
  // name-keyed bypass now has nowhere to hide, whatever key it picks.
  //
  // THE REPO IS VARIED HERE, AND ONLY HERE IT COUNTS (#3829 round 4). Every
  // fixture in this file passed `repo: 'o/r'`, so `repo === 'o/r' ? redact(body)
  // : body` — a bypass that leaks on the only repo that actually exists — passed
  // 31/31. Varying it in the CLI test does NOT catch that, measured: the CLI
  // path builds its body with buildIssueBody(), which redacts at its own return,
  // so two redactors sit on that path and the mutation stays green
  // (csa_loom_mutation_that_does_not_move_the_verdict). THIS test hands
  // notifyFailure() a hand-built string, so the poster boundary is the only
  // redactor on the path and the repo key is discriminating.
  const handBuilt = `HAND-BUILT BODY psql-loom-weave-default-abc123/${SYNTHETIC_OID}`;
  assert.match(handBuilt, GUID_RE, 'the INPUT must carry a GUID or this test proves nothing');

  const callers = callerWorkflowNames();
  assert.ok(callers.length >= 5, `expected >=5 real caller names, found ${callers.length} — the matcher drifted`);
  // Non-degenerate in the direction the bypass exploited: the population is not
  // uniform, so a prefix-keyed exemption cannot cover it.
  assert.ok(callers.some((w) => !w.startsWith('deploy-')), 'the caller population must not be prefix-uniform');

  const repos = ['o/r', 'fgarofalo56/csa-inabox'];
  for (const repo of repos) {
    for (const workflow of callers) {
      // Path 1 — create.
      const create = recorder([
        [/^GET /, () => []],
        [/^POST .*\/issues$/, (b) => ({ number: 1, ...b })],
      ]);
      await notifyFailure({ repo, workflow, body: handBuilt, request: create.request });
      const posted = create.calls.find((c) => c.method === 'POST').body.body;
      assert.doesNotMatch(posted, GUID_RE, `${repo} ${workflow}: a hand-built body reached a PUBLIC issue unredacted (#3829)`);
      assert.match(posted, /psql-loom-weave-default-abc123\/<guid>/, `${repo} ${workflow}: redacted in place, not dropped`);

      // Path 2 — comment on an existing notice. Both writes go through the boundary.
      const comment = recorder([
        [/^GET /, () => [{ number: 5, title: buildIssueTitle(workflow) }]],
        [/^POST .*\/comments$/, () => ({ id: 1 })],
      ]);
      await notifyFailure({ repo, workflow, body: handBuilt, request: comment.request });
      const commented = comment.calls.find((c) => c.url.includes('/comments')).body.body;
      assert.doesNotMatch(commented, GUID_RE, `${repo} ${workflow}: the COMMENT path bypassed the redaction (#3829)`);
      assert.match(commented, /psql-loom-weave-default-abc123\/<guid>/);
    }
  }
});

test('MUTATION-VISIBLE — a NON-STRING body cannot become a SILENT EMPTY notice', async () => {
  // redact() returns '' for a non-string, by design, so a caller cannot publish
  // `[object Object]` out of it. Applied bare to `body` that is a REGRESSION,
  // not a safety property: pre-#3829 an object body reached the API and threw,
  // and the notifier failed the step as its own docstring promises. Bare
  // redact(body) instead FILES AN EMPTY P0 NOTICE AND EXITS 0 — the exact
  // swallow this file was written to remove. String() first, as the sibling
  // formatAnnotation() already does.
  async function postedFor(body) {
    const { request, calls } = recorder([
      [/^GET /, () => []],
      [/^POST .*\/issues$/, (b) => ({ number: 1, ...b })],
    ]);
    await notifyFailure({ repo: 'o/r', workflow: 'deploy-fiab-commercial', body, request });
    return calls.find((c) => c.method === 'POST').body.body;
  }

  // CONTROL — a plain string is still posted byte-for-byte. Without this, an
  // implementation that stringified everything to a constant would also pass.
  assert.equal(await postedFor('the deploy failed on step X'), 'the deploy failed on step X');

  // The regression itself: none of these may post an EMPTY body.
  for (const [why, body] of [
    ['a plain object', { msg: 'the deploy failed' }],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ]) {
    const posted = await postedFor(body);
    assert.notEqual(posted, '', `${why} filed an EMPTY P0 notice — a notifier that cannot notify must FAIL, not swallow`);
    assert.ok(posted.length > 0, `${why} produced a zero-length notice body`);
  }

  // …and a message object with a real toString() survives INTACT, not as a husk.
  assert.match(await postedFor({ toString: () => 'ARM refused the template' }), /ARM refused the template/);

  // …and String() must not open a redaction hole: a non-string carrying a GUID
  // is still redacted, because String() runs INSIDE redact()'s argument.
  const poisoned = await postedFor({ toString: () => `blocked on psql-loom-weave-default-abc123/${SYNTHETIC_OID}` });
  assert.doesNotMatch(poisoned, GUID_RE, 'String() bypassed the redaction for a non-string body (#3829 round 3)');
  assert.match(poisoned, /psql-loom-weave-default-abc123\/<guid>/, 'redacted in place');
});

test('the poster redaction covers a GUID glued on EITHER side, not only a delimited one', () => {
  // Round 1 stated the residual as "glued on BOTH sides survives". Measured, it
  // was EITHER side — and `_` is a word character, so `admin_<guid>` (an ARM
  // deployment-name shape) leaked. Assert the property through the real
  // buildIssueBody(), which is what a workflow actually calls.
  const body = buildIssueBody({
    workflow: 'wf',
    runId: '1',
    runUrl: 'u',
    sha: 's',
    failure: { ...QUOTA_FAILURE, whyStopped: 'blocked on admin_11111111-2222-3333-4444-555555555555 and x11111111-2222-3333-4444-555555555555' },
  });
  assert.doesNotMatch(body, GUID_RE, 'a word-char-glued GUID survived into a PUBLIC issue body (#3829 round 2)');
  assert.match(body, /admin_<guid>/, 'redacted in place');
  assert.match(body, /x<guid>/, 'redacted in place');
});

// ── THE RUN LOG IS A PUBLISHED SURFACE TOO (#3829 round 3) ───────────────────
//
// notifyFailure() covers what reaches the GitHub API. It does not cover what
// main() PRINTS, and main() printed `${workflow}` raw into a `::notice::`
// annotation and into stdout — both public in this repo's Actions logs, and the
// #3829 justification for redacting the TITLE is verbatim "a workflow name
// containing a GUID would have put one in a public issue title". Measured at
// round-2 head, `--workflow deploy-fiab-<guid> --result cancelled` printed:
//
//   ::notice::deploy-notify-failure: no issue filed for deploy-fiab-11111111-… — …
//
// These are CLI tests — a real child process, real stdout, and for the filing
// path a real HTTP transport — because the defect lives in main(), which no
// unit test of the exported functions can reach.

function runCli(args, env) {
  // NODE_TEST_CONTEXT is STRIPPED, deliberately (#3829 round 4). These children
  // stand in for a real CI invocation, and inheriting the test-runner marker let
  // a mutation as blunt as
  //
  //     if (!process.env.NODE_TEST_CONTEXT) return text;   // inside redact()
  //
  // survive the whole suite: every path that could have caught it ran with the
  // variable set. A child that only redacts when it can see it is being tested
  // is the purest form of a gate that cannot fail. Same reason
  // scripts/ci/__tests__/node-test-suites.test.mjs deletes it.
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A stub GitHub API on 127.0.0.1, so the FILING path can be driven end to end. */
async function stubApi(route) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route(req.method, req.url, raw)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const POISONED_WORKFLOW = `deploy-fiab-${SYNTHETIC_OID}`;

test('POSITIVE CONTROL — the workflow name handed to the CLI really is GUID-shaped', () => {
  // Without this, "no GUID in stdout" is satisfiable by a CLI that prints nothing.
  assert.match(POISONED_WORKFLOW, GUID_RE, 'the CLI input must carry a GUID or the next two tests are vacuous');
});

test('ACCEPTANCE — the NOT-FILED annotation redacts the workflow name (#3829 round 3)', async () => {
  const r = await runCli(['--workflow', POISONED_WORKFLOW, '--result', 'cancelled'], {
    GITHUB_REPOSITORY: 'o/r',
    GH_TOKEN: 'not-a-real-token',
  });
  assert.equal(r.code, 0, `a cancellation must not turn the run red; stderr=${r.stderr}`);
  // Non-degenerate: the annotation really was emitted, and it is the one meant.
  assert.match(r.stdout, /^::notice::deploy-notify-failure: no issue filed for /, 'the annotation was not emitted at all');
  assert.doesNotMatch(r.stdout, GUID_RE, 'a GUID reached a PUBLIC ::notice:: annotation (#3829 round 3)');
  // REDACTED, not dropped — the notice must still name which workflow it is about.
  assert.match(r.stdout, /no issue filed for deploy-fiab-<guid> —/, 'the workflow name was removed rather than redacted');
});

test('ACCEPTANCE — the FILED-issue log line redacts the workflow name too, over a real transport', async () => {
  const seen = [];
  const { server, base } = await stubApi((method, url, raw) => {
    seen.push({ method, url, raw });
    if (method === 'GET') return [];
    return { number: 4321 };
  });
  try {
    const r = await runCli(['--workflow', POISONED_WORKFLOW, '--result', 'failure'], {
      // The REAL repo, not 'o/r' (#3829 round 4). Every poster fixture in this
      // file used the same two-char stand-in, so `repo === 'o/r' ? redact(body)
      // : body` — a bypass that would leak on the only repo that actually
      // matters — passed 31/31. The token literal is varied for the same reason:
      // `token === 'not-a-real-token' ? … : …` was equally invisible.
      GITHUB_REPOSITORY: 'fgarofalo56/csa-inabox',
      GH_TOKEN: 'ghs_aDifferentSyntheticTokenLiteral',
      GITHUB_API_URL: base,
      GITHUB_RUN_ID: '99',
      GITHUB_SHA: 'abc1234',
    });
    assert.equal(r.code, 0, `the filer must succeed against the stub; stderr=${r.stderr}`);
    // Non-degenerate: it really filed, so the log line under test really ran.
    assert.match(r.stdout, /opened #4321 for /, 'the CLI did not reach the filing log line');
    assert.doesNotMatch(r.stdout, GUID_RE, 'a GUID reached the PUBLIC run log on the filing path (#3829 round 3)');
    assert.match(r.stdout, /opened #4321 for deploy-fiab-<guid>\./, 'redacted in place, not dropped');

    // …and the same run is an END-TO-END receipt for the poster boundary: the
    // title and body that crossed a real HTTP transport carry no GUID either.
    const created = seen.find((c) => c.method === 'POST');
    assert.ok(created, 'no issue was POSTed');
    const payload = JSON.parse(created.raw);
    assert.doesNotMatch(payload.title, GUID_RE, 'a GUID reached the PUBLIC issue TITLE over the wire');
    assert.doesNotMatch(payload.body, GUID_RE, 'a GUID reached the PUBLIC issue BODY over the wire');
    assert.equal(payload.title, 'deploy: deploy-fiab-<guid> is failing');
    assert.match(payload.body, /\*\*deploy-fiab-<guid>\*\* failed\./, 'the body must still name the workflow');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── ONE BOUNDARY, NOT ONE VARIABLE (#3829 round 4) ───────────────────────────
//
// Round 3 redacted `${workflow}` on the not-filed `::notice::` line and left
// `${result}` — the very next interpolation on the SAME statement — raw. It
// reaches that line twice: once directly, and once inside `decision.why`, which
// shouldFile() builds by embedding the observed value. Measured at round-3 head:
//
//   $ node deploy-notify-failure.mjs --workflow deploy-fiab-commercial \
//       --result 11111111-2222-3333-4444-555555555555
//   ::notice::… ("11111111-2222-3333-4444-555555555555") … (observed result:
//   "11111111-2222-3333-4444-555555555555", category: unknown)   ← 2 GUIDs
//
// Latent — all five live callers pass `${{ job.status }}` or a literal — but
// that is verbatim the standard round 3 applied to `workflow` in this same file,
// and "the field added next forgets to opt in" is the entire thesis of #3829.
// The per-variable local is gone; formatStdout() is the single boundary.

const POISONED_RESULT = SYNTHETIC_OID;

test('POSITIVE CONTROL — the --result value really is GUID-shaped, and reaches BOTH interpolations', () => {
  // Without this, "no GUID in stdout" is satisfiable by a CLI that prints
  // nothing — and the `decision.why` half is invisible unless the classifier
  // really does echo the observed value back.
  assert.match(POISONED_RESULT, GUID_RE, 'the CLI input must carry a GUID or the next test is vacuous');
  const why = shouldFile(POISONED_RESULT).why;
  assert.match(why, GUID_RE, 'shouldFile() must embed the observed result, or only one of the two sites is under test');
});

test('ACCEPTANCE — a GUID in --result reaches NO public surface (#3829 round 4)', async () => {
  const r = await runCli(['--workflow', 'deploy-fiab-commercial', '--result', POISONED_RESULT], {
    GITHUB_REPOSITORY: 'fgarofalo56/csa-inabox',
    GH_TOKEN: 'ghs_aDifferentSyntheticTokenLiteral',
  });
  assert.equal(r.code, 0, `an unrecognised outcome must not turn the run red; stderr=${r.stderr}`);
  // Non-degenerate: the annotation really was emitted, and it is the one meant.
  assert.match(r.stdout, /^::notice::deploy-notify-failure: no issue filed for /, 'the annotation was not emitted at all');
  assert.doesNotMatch(r.stdout, GUID_RE, 'a GUID in --result reached a PUBLIC ::notice:: annotation (#3829 round 4)');
  assert.doesNotMatch(r.stderr, GUID_RE, 'a GUID in --result reached stderr, which is equally public');
  // REDACTED IN PLACE, at BOTH sites — not dropped, and not merely absent
  // because the line was truncated. The verdict must be unchanged.
  assert.match(r.stdout, /\("<guid>"\)/, 'the decision.why copy of the observed result was not redacted in place');
  assert.match(r.stdout, /observed result: "<guid>", category: unknown/, 'the direct copy was not redacted in place');
  assert.match(r.stdout, /no issue filed for deploy-fiab-commercial —/, 'the verdict or the workflow name changed');
});

test('MUTATION-VISIBLE — formatStdout() is the ONLY way this file reaches stdout', () => {
  // The two assertions above are end-to-end, and an end-to-end assertion cannot
  // say WHICH redactor did the work when several sit on the path. Pin the
  // boundary directly — pure and exported precisely so a pass-through mutation
  // (`return String(text)`) is visible here rather than only inferable
  // (csa_loom_mutation_that_does_not_move_the_verdict).
  assert.equal(formatStdout(`x${SYNTHETIC_OID}`), 'x<guid>', 'the boundary does not redact');
  assert.doesNotMatch(formatStdout(`observed result: "${SYNTHETIC_OID}"`), GUID_RE);
  // String() first: a non-string must not become a silently EMPTY log line.
  assert.equal(formatStdout(42), '42');
  assert.equal(formatStdout(undefined), 'undefined');
});

// ── EVERY SURFACE, NOT THE ONE THIS ROUND HAPPENED TO NOTICE (#3829 round 5) ──
//
// Round 4's structural assertion was this, and it is the right SHAPE:
//
//   const writes = [...src.matchAll(/process\.stdout\.write\(([^\n]*)/g)]…
//   assert.equal(writes.length, 1, …);
//   assert.match(writes[0], /^formatStdout\(/, …);
//
// It is also stdout-ONLY, so it could not see the three unbounded
// `process.stderr.write` calls sitting in the same file — which is round 2's
// finding (stderr publishes) recurring one file over, guarded by a regex that
// could not have detected it even in principle. Generalised below: the
// enumeration is mechanical, it covers BOTH streams plus the shapes that reach a
// stream without going through one (`console.*`, a step summary), and it is the
// same enumerator all three scripts in this lane are held to.

const SCRIPT_SRC = fs.readFileSync(SCRIPT, 'utf8');

/** The named functions a write in THIS file may hand its argument to. */
const NOTIFY_BOUNDARIES = ['formatStdout', 'formatStderr'];

test('MUTATION-VISIBLE — formatStderr() is the ONLY way this file reaches stderr', () => {
  // Direct, for the reason formatStdout() is tested directly: main().catch()'s
  // message reaches stderr through this and nothing else, so a pass-through
  // mutation must be visible without inferring it from an end-to-end run.
  assert.equal(formatStderr(`x${SYNTHETIC_OID}`), 'x<guid>', 'the stderr boundary does not redact');
  assert.doesNotMatch(formatStderr(`blocked on psql-loom-weave-default-abc123/${SYNTHETIC_OID}`), GUID_RE);
  assert.match(formatStderr(`psql-loom-weave-default-abc123/${SYNTHETIC_OID}`), /psql-loom-weave-default-abc123\/<guid>/);
  // String() first — a refusal that printed nothing is worse than the refusal.
  assert.equal(formatStderr(42), '42');
  assert.equal(formatStderr(undefined), 'undefined');
});

test('STRUCTURAL — EVERY write to a public stream crosses a named boundary', () => {
  const writes = streamWrites(SCRIPT_SRC);

  // Non-degenerate #1: the enumerator found the writes at all. Zero would mean
  // the matcher drifted, not that the file stopped publishing
  // (guard_with_zero_population_needs_embedded_control).
  assert.ok(writes.length >= 2, `expected >=2 stream writes, found ${writes.length} — the enumerator drifted`);
  // Non-degenerate #2: BOTH streams are in the population. An enumeration that
  // saw only stdout is exactly the round-4 defect this test replaces.
  assert.ok(writes.some((w) => w.stream === 'stdout'), 'no stdout write found — the enumerator is stdout-blind');
  assert.ok(writes.some((w) => w.stream === 'stderr'), 'no stderr write found — the enumerator is stderr-blind');

  assert.deepEqual(
    unboundedWrites(SCRIPT_SRC, NOTIFY_BOUNDARIES).map((w) => `${w.line}: ${w.arg.split('\n')[0]}`),
    [],
    'a write to a PUBLIC stream bypasses the redaction boundary (#3829)',
  );

  // ZERO disclosed exceptions in this file, and that is an assertion rather than
  // an omission: deploy-retry.mjs legitimately publishes a child's bytes raw,
  // this file has no child and therefore no reason to. If one appears, it has to
  // be argued here.
  assert.equal(
    callCount(SCRIPT_SRC, 'unredactedByDesign'),
    0,
    'a disclosed-exception marker appeared in a file that has no stream to be verbatim about',
  );

  // The surfaces that reach a stream WITHOUT `process.<stream>.write` — the
  // blind side every structural assertion in this lane has had so far.
  assert.deepEqual(forbiddenPublishers(SCRIPT_SRC), [], 'a publication shape with no boundary to attach to');

  // …including the one no write-based assertion can see at all: a spawn with
  // `stdio: [_,'inherit',_]` hands a child THIS process's public log. There is
  // no spawn in this file today, and adding one would be a new surface, not a
  // detail — so the zero is asserted rather than assumed.
  assert.deepEqual(
    inheritedStreamSpawns(SCRIPT_SRC),
    [],
    'a spawn in this file publishes through an INHERITED stream, which no boundary here can cover',
  );
  // Non-degenerate: the enumerator can see the shape whose absence is asserted.
  assert.deepEqual(inheritedStreamSpawns("x({ stdio: ['ignore', 'inherit', 'pipe'] })")[0].inherits, ['stdout']);
  assert.equal(inheritedStreamSpawns("x({ stdio: ['inherit', 'pipe', 'pipe'] })").length, 0, 'an inherited STDIN is not a publication surface');
});

test('SELF-DEFENCE — the surface enumerator can actually detect an unbounded write', () => {
  // The assertion above passes on a clean tree, which is also what it would do
  // if it had stopped looking. Prove it against the verbatim violation shapes,
  // in a CRLF source — the line ending these files carry in a Windows working
  // tree — so a `\n`-anchored regression is caught here rather than by being
  // silently green (csa_loom_crlf_makes_mutation_needles_silently_noop).
  const found = unboundedWrites(CONTROL_SOURCE_CRLF, [...NOTIFY_BOUNDARIES, 'unredactedByDesign']);
  assert.equal(found.length, 2, `expected the control's 2 violations, found ${found.length}`);
  assert.ok(
    found.some((w) => w.arg.startsWith('`deploy:')),
    'a bare template-literal write was not detected',
  );
  assert.ok(
    found.some((w) => w.arg.startsWith('redact(')),
    'a PER-SITE redact() was not detected — one boundary per surface is the rule; a per-field call is the defect',
  );
  // …and the three legitimate shapes in the same control are NOT flagged, or the
  // guard would be unusable and would be silenced rather than obeyed.
  assert.equal(streamWrites(CONTROL_SOURCE_CRLF).length, 5, 'the control source lost a write to CRLF handling');

  // The comment stripper is load-bearing here: this file's own header documents
  // its write sites in prose, and counting those would inflate every number.
  const occurrences = (s, needle) => s.split(needle).length - 1;
  assert.ok(
    occurrences(SCRIPT_SRC, 'process.stdout.write(formatStdout(') >= 2,
    'the header no longer documents the boundary in prose — this control has lost its population',
  );
  assert.equal(
    occurrences(stripComments(SCRIPT_SRC), 'process.stdout.write(formatStdout('),
    1,
    'the stripper left header prose in the executable source — every count above is inflated',
  );
  // …and it does NOT strip real code. Both directions, or it is not a control.
  assert.match(stripComments(SCRIPT_SRC), /process\.stdout\.write\(formatStdout\(text\)\)/, 'the stripper ate real code');
  // A `//` inside a STRING must not blank the rest of its line — this file
  // carries 'https://github.com' and 'https://api.github.com'.
  assert.match(stripComments(SCRIPT_SRC), /'https:\/\/api\.github\.com'/, 'the stripper treated a URL as a comment');
});

test('ACCEPTANCE — a GUID in an API error reaches STDERR redacted, over a real transport', async () => {
  // The filed path's stderr had no assertion at all before round 5: the one
  // `assert.doesNotMatch(r.stderr, …)` in this file sits on the NOT-filed test,
  // where stderr is empty and the assertion is therefore vacuous. This drives a
  // real child against a real HTTP transport and makes stderr genuinely carry
  // the id — main().catch() is the likeliest live carrier in the file, because
  // the search failure embeds 200 bytes of the API's own response.
  const { server, base } = await stubApi(() => ({
    message: `Bad credentials for psql-loom-weave-default-abc123/${SYNTHETIC_OID}`,
  }));
  try {
    const r = await runCli(['--workflow', 'deploy-fiab-commercial', '--result', 'failure'], {
      GITHUB_REPOSITORY: 'fgarofalo56/csa-inabox',
      GH_TOKEN: 'ghs_aDifferentSyntheticTokenLiteral',
      GITHUB_API_URL: base,
      GITHUB_RUN_ID: '99',
      GITHUB_SHA: 'abc1234',
    });
    // A notifier that cannot notify must FAIL the step, not swallow.
    assert.equal(r.code, 1, `the notifier must exit non-zero when it cannot file; stderr=${r.stderr}`);
    // Non-degenerate: stderr really carries the diagnostic, so "no GUID" is not
    // satisfied by an empty stream.
    assert.match(r.stderr, /cannot tell whether a notice issue exists/, 'the error path did not run');
    assert.match(r.stderr, /Bad credentials for psql-loom-weave-default-abc123/, 'the API response was not echoed at all');
    // The guard.
    assert.doesNotMatch(r.stderr, GUID_RE, 'a GUID reached the PUBLIC Actions run log on stderr (#3829 round 5)');
    // REDACTED IN PLACE, not dropped — the diagnostic must survive.
    assert.match(r.stderr, /psql-loom-weave-default-abc123\/<guid>/, 'the id was removed rather than redacted');
  } finally {
    await new Promise((r) => server.close(r));
  }
});


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

/**
 * The `--workflow` VALUES the real callers pass, read out of the workflows
 * rather than guessed. Used to key the redaction tests to the population a
 * name-shaped bypass would actually have to cover.
 */
function callerWorkflowNames() {
  const names = new Set();
  for (const h of notifyInvocations()) {
    const m = /--workflow\s+([^\s\\]+)/.exec(h.invocation);
    if (m) names.add(m[1]);
  }
  return [...names];
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

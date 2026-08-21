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
  const { request, calls } = recorder([
    [/^GET /, () => []],
    [/^POST .*\/issues$/, (b) => ({ number: 4243, ...b })],
  ]);
  const r = await notifyFailure({ repo: 'o/r', workflow: GLUED_GUID, body: 'x', request });
  assert.equal(r.created, true);

  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'));
  assert.doesNotMatch(create.body.title, GUID_RE, 'a GUID reached a PUBLIC issue TITLE (#3829)');
  // REDACTED, not dropped: the title must still identify the workflow.
  assert.equal(create.body.title, 'deploy: deploy_<guid> is failing');
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

test('ACCEPTANCE — a HAND-BUILT body is redacted at the poster too, on both post paths', async () => {
  // `body` is a parameter. Round 1 redacted inside buildIssueBody(), so any
  // caller that assembled its own string — the shape every future caller is one
  // refactor away from — posted it verbatim.
  const handBuilt = `HAND-BUILT BODY psql-loom-weave-default-abc123/11111111-2222-3333-4444-555555555555`;
  assert.match(handBuilt, GUID_RE, 'the INPUT must carry a GUID or this test proves nothing');

  // Path 1 — create.
  const create = recorder([
    [/^GET /, () => []],
    [/^POST .*\/issues$/, (b) => ({ number: 1, ...b })],
  ]);
  await notifyFailure({ repo: 'o/r', workflow: 'wf', body: handBuilt, request: create.request });
  const posted = create.calls.find((c) => c.method === 'POST').body.body;
  assert.doesNotMatch(posted, GUID_RE, 'a hand-built body reached a PUBLIC issue unredacted (#3829)');
  assert.match(posted, /psql-loom-weave-default-abc123\/<guid>/, 'redacted in place, not dropped');

  // Path 2 — comment on an existing notice. Both writes go through the boundary.
  const comment = recorder([
    [/^GET /, () => [{ number: 5, title: buildIssueTitle('wf') }]],
    [/^POST .*\/comments$/, () => ({ id: 1 })],
  ]);
  await notifyFailure({ repo: 'o/r', workflow: 'wf', body: handBuilt, request: comment.request });
  const commented = comment.calls.find((c) => c.url.includes('/comments')).body.body;
  assert.doesNotMatch(commented, GUID_RE, 'the COMMENT path bypassed the redaction (#3829)');
  assert.match(commented, /psql-loom-weave-default-abc123\/<guid>/);
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

/**
 * Self-tests for the estate-resume boundary guard (#4149).
 *
 * WHAT WENT WRONG. scripts/measure/estate-resume.mjs hard-codes the COMMERCIAL
 * resource groups (rg-csa-loom-admin-centralus, rg-csa-loom-dlz-default-centralus)
 * and cluster (adx-csa-loom-z52x3p), and its `subFor()` resolved a subscription
 * BY RESOURCE NAME with `limit 1` against whatever cloud the ambient `az`
 * session happened to be on. Nothing read the active cloud before the first
 * mutation — `az containerapp update`, `az resource invoke-action --action
 * resume`, `az kusto cluster start` — so an operator who had run
 * `az cloud set --name AzureUSGovernment` intending to resume Gov could silently
 * mutate the Commercial estate and read a green report about it. The transcript
 * named no boundary and no subscription, so it could not even be audited after
 * the fact.
 *
 * WHY THIS SUITE LIVES UNDER scripts/ci/__tests__. loom-guardrails.yml runs
 * `node --test scripts/ci/__tests__/*.test.mjs` explicitly, so this file is
 * covered by that step AND by the tree-wide discovery runner.
 *
 * A CORRECTION, because the premise came in with the work item and would
 * otherwise propagate: the stated reason for this placement was that "nothing in
 * CI runs scripts/measure/*.test.mjs". THAT IS FALSE at head. Measured:
 *
 *   $ node scripts/ci/check-node-test-suites.mjs --list
 *   … 145 suites, including scripts/measure/measure.test.mjs,
 *     scripts/measure/cmd-quote.test.mjs, measurement-guard.test.mjs and
 *     scripts/measure/__tests__/measure-injection.test.mjs
 *
 * The discovery runner (#2856) finds every node:test suite in the tree and the
 * REQUIRED `guardrails` job runs it, so a suite beside the script would have had
 * teeth too. This placement is belt and braces, not a rescue.
 *
 * WHAT THESE TESTS ARE BUILT TO CATCH. The unit tests below pin the classifier,
 * but the load-bearing one is the BEHAVIOURAL test: it drives the real `main()`
 * with a fake `az` reporting a sovereign cloud and asserts the injected `run`
 * was NEVER called. An exported, unit-tested `classifyBoundary` that `main`
 * forgot to call would pass every other test in this file while guarding
 * nothing — this repo's most-repeated defect, and exactly the shape #4074-R4
 * found in the AAS preflight (`shouldResuspend` was exported, tested, and
 * called by no one).
 *
 * Run: node --test scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBoundary,
  classifySubResolution,
  readAccount,
  main,
  APPS,
  AAS,
  ADX,
  BOUNDARY,
  EXPECTED_ENVIRONMENT,
  RESOURCE_NAME,
} from '../../measure/estate-resume.mjs';

/**
 * A resource-graph answer that matches the REAL tables in estate-resume.mjs.
 *
 * Built from APPS/AAS/ADX rather than hand-written, so it cannot drift away from
 * what the script actually asks for — a fixture that no longer resembles the
 * subject is how a positive control quietly stops controlling anything.
 */
const TYPE_OF = new Map([
  ...APPS.map((a) => [a.name, ['microsoft.app/containerapps', a.rg]]),
  ...AAS.map((s) => [s.name, ['microsoft.analysisservices/servers', s.rg]]),
  [ADX.name, ['microsoft.kusto/clusters', ADX.rg]],
]);

/**
 * `resources | where name =~ 'loom-activator' | …` → `loom-activator`.
 *
 * Read out of the WHOLE argv rather than a fixed index. An index made this
 * fixture return an empty graph for every name, and — because "nothing found"
 * is a legitimate refusal — the run still produced a plausible-looking
 * transcript. It was only the exit code that gave it away.
 */
const nameFromArgs = (args) => (args.join(' ').match(/name =~ '([^']+)'/) || [])[1] || '';

function graphAnswerFor(args, sub) {
  const [type, rg] = TYPE_OF.get(nameFromArgs(args)) || [];
  return { data: type ? [{ sub, rg, type }] : [] };
}

/** A recording pair of fakes: `az` answers from a queue, `run` records calls. */
function harness({ account, azAnswer = () => 0 }) {
  const mutations = [];
  const lines = [];
  const az = (args) => {
    if (args[0] === 'account' && args[1] === 'show') {
      if (account instanceof Error) throw account;
      return account;
    }
    return azAnswer(args);
  };
  const run = (bin, args) => {
    mutations.push([bin, ...args].join(' '));
    return { stdout: '', stderr: '', status: 0 };
  };
  return { az, run, mutations, lines, log: (s) => lines.push(String(s)) };
}

// ── the guard's verdict ──────────────────────────────────────────────────────

test('#4149 — a NON-AzureCloud environmentName FAILS CLOSED', () => {
  // The case the issue is about. Every sovereign name must refuse; none of them
  // owns the resources this script names.
  for (const env of ['AzureUSGovernment', 'AzureChinaCloud', 'AzureGermanCloud', 'USNat', 'USSec']) {
    const v = classifyBoundary({
      environmentName: env,
      id: '00000000-0000-0000-0000-000000000001',
      name: 'some gov sub',
      tenantId: 'aaaaaaaa-0000-0000-0000-000000000002',
    });
    assert.equal(v.ok, false, `${env} must not be accepted`);
    // The refusal must name BOTH clouds — what it saw and what it needs — or the
    // operator cannot tell which end is wrong.
    assert.match(v.reason, new RegExp(env));
    assert.match(v.reason, new RegExp(EXPECTED_ENVIRONMENT));
    assert.match(v.reason, new RegExp(BOUNDARY));
    // And it must report what it MEASURED, not just that it refused.
    assert.equal(v.environmentName, env);
  }
});

test('#4149 — AzureCloud with a subscription is the ONLY accepted state', () => {
  const v = classifyBoundary({
    environmentName: 'AzureCloud',
    id: '11111111-2222-3333-4444-555555555555',
    name: 'CSA Loom Commercial',
    tenantId: '99999999-8888-7777-6666-555555555555',
  });
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
  assert.equal(v.subscriptionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(v.subscriptionName, 'CSA Loom Commercial');
});

test('#4149 — UNKNOWN is a refusal, never a pass', () => {
  // The recurring trap: a control that reads "no answer" as "the good answer".
  const cases = [
    [null, /could not be read at all/],
    [undefined, /could not be read at all/],
    ['AzureCloud', /could not be read at all/], // a bare string is not the projection
    [{ error: 'az: command not found' }, /az: command not found/],
    [{ id: 'x' }, /no environmentName/],
    [{ environmentName: '   ', id: 'x' }, /no environmentName/],
    [{ environmentName: 'AzureCloud' }, /no subscription id/],
    [{ environmentName: 'AzureCloud', id: '' }, /no subscription id/],
  ];
  for (const [account, why] of cases) {
    const v = classifyBoundary(account);
    assert.equal(v.ok, false, `${JSON.stringify(account)} must be refused`);
    assert.match(v.reason, why);
  }
});

test('#4149 — readAccount turns an az failure into a REASON, never an empty pass', () => {
  const boom = () => { throw new Error('Please run `az login` to setup account.'); };
  const acct = readAccount(boom);
  assert.match(String(acct.error), /az login/);
  assert.equal(classifyBoundary(acct).ok, false);
});

// ── the guard's WIRING: fail closed BEFORE the first mutation ────────────────

test('#4149 — BEHAVIOURAL: a Gov session mutates NOTHING and exits non-zero', () => {
  // THE TEST THAT MATTERS. A passing classifier proves nothing if main() does
  // not call it; this drives the real main() and asserts on the property the
  // issue is about — that no mutation is issued.
  const h = harness({
    account: {
      environmentName: 'AzureUSGovernment',
      id: '00000000-0000-0000-0000-0000000000gv'.replace('gv', '99'),
      name: 'gov sub',
      tenantId: 'gov-tenant',
    },
    // If the guard is bypassed, THIS is what the run would do next: report a
    // minReplicas of 0 for every app and proceed to update them.
    azAnswer: () => 0,
  });
  const code = main({ argv: ['node', 'estate-resume.mjs', '--apply'], az: h.az, run: h.run, log: h.log });

  assert.notEqual(code, 0, 'a sovereign session must not exit 0');
  assert.equal(h.mutations.length, 0,
    `fail-closed means ZERO mutations; got: ${h.mutations.join(' | ')}`);
  const out = h.lines.join('\n');
  assert.match(out, /REFUSED/);
  assert.match(out, /AzureUSGovernment/);
  assert.match(out, /Nothing was read and nothing was changed/);
  // It must not print a resume report at all — a refusal that still prints
  // section headers reads like a partial run.
  assert.doesNotMatch(out, /=== Container Apps ===/);
});

test('#4149 — the refusal covers --dry-run too', () => {
  // A dry-run report about the wrong boundary is the report the operator would
  // then act on, so the guard cannot be apply-only.
  const h = harness({ account: { environmentName: 'AzureUSGovernment', id: 'sub-gov' } });
  const code = main({ argv: ['node', 'estate-resume.mjs', '--dry-run'], az: h.az, run: h.run, log: h.log });
  assert.notEqual(code, 0);
  assert.equal(h.mutations.length, 0);
  assert.doesNotMatch(h.lines.join('\n'), /WOULD CHANGE/);
});

test('#4149 — CONTROL: on AzureCloud the script DOES run (the guard is not a brick)', () => {
  // A guard that refuses everything is not a guard, it is an outage. This is the
  // positive control: same code, same fakes, only the cloud differs.
  const SUB = '11111111-2222-3333-4444-555555555555';
  const h = harness({
    account: { environmentName: 'AzureCloud', id: SUB, name: 'CSA Loom Commercial', tenantId: 't' },
    azAnswer: (args) => (args[0] === 'graph' ? graphAnswerFor(args, SUB) : 0),
  });
  const code = main({ argv: ['node', 'estate-resume.mjs', '--dry-run'], az: h.az, run: h.run, log: h.log });
  assert.equal(code, 0, h.lines.join('\n'));
  const out = h.lines.join('\n');
  assert.match(out, /=== Container Apps ===/);
  assert.match(out, /DRY RUN/);
  assert.doesNotMatch(out, /FAILED: [1-9]/, 'every named resource must resolve on the happy path');
  assert.equal(h.mutations.length, 0, 'a dry run mutates nothing even on the right cloud');
});

test('#4149 — every printed line names the boundary AND a subscription', () => {
  // The audit property: a pasted transcript must say which estate it is about.
  const SUB = '11111111-2222-3333-4444-555555555555';
  const h = harness({
    account: { environmentName: 'AzureCloud', id: SUB, name: 'CSA Loom Commercial', tenantId: 't' },
    azAnswer: (args) => (args[0] === 'graph' ? graphAnswerFor(args, SUB) : 0),
  });
  main({ argv: ['node', 'estate-resume.mjs', '--dry-run'], az: h.az, run: h.run, log: h.log });
  assert.ok(h.lines.length > 5, 'precondition: the run must have produced a transcript');
  for (const line of h.lines) {
    assert.match(line, new RegExp(`^\\[${BOUNDARY}/${EXPECTED_ENVIRONMENT} sub=`),
      `a line that does not name its estate is not auditable: ${line}`);
  }
  // The subscription must be the real one, not a placeholder.
  assert.ok(h.lines.every((l) => l.includes(SUB) || l.includes('sub=unresolved')),
    'every line must carry a concrete subscription');
});

// ── subFor: ambiguous or unexpected resolutions are refused ──────────────────

test('#4149 — a name that resolves to TWO subscriptions is refused, not picked from', () => {
  // The `limit 1` defect: the old code took whichever row came back first.
  const v = classifySubResolution({
    name: 'loomdefault',
    rg: 'rg-csa-loom-dlz-default-centralus',
    rows: [
      { sub: 'sub-a', rg: 'rg-csa-loom-dlz-default-centralus', type: 'microsoft.analysisservices/servers' },
      { sub: 'sub-b', rg: 'rg-csa-loom-dlz-default-centralus', type: 'microsoft.analysisservices/servers' },
    ],
  });
  assert.equal(v.ok, false);
  assert.equal(v.sub, null);
  assert.match(v.reason, /2 different subscriptions/);
  assert.match(v.reason, /sub-a/);
  assert.match(v.reason, /sub-b/);
});

test('#4149 — the right NAME in the wrong RESOURCE GROUP is refused, and says where it is', () => {
  const v = classifySubResolution({
    name: 'loomdefault',
    rg: 'rg-csa-loom-dlz-default-centralus',
    rows: [{ sub: 'someone-elses-sub', rg: 'rg-blog-prod', type: 'microsoft.analysisservices/servers' }],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /NONE of them in resource group/);
  assert.match(v.reason, /rg-blog-prod/);
  assert.match(v.reason, /someone-elses-sub/);
});

test('#4149 — nothing found says "not visible", not "does not exist"', () => {
  // R7: RBAC and absence produce the same empty list, and the message must not
  // pick one.
  const v = classifySubResolution({ name: 'loom-activator', rg: 'rg-csa-loom-admin-centralus', rows: [] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /is visible to this session/);
  assert.match(v.reason, /not proof it does not exist/);
  assert.match(v.reason, /cannot read/);
});

test('#4149 — a non-list answer is UNKNOWN, never an absence', () => {
  for (const rows of [null, undefined, {}, 'nope']) {
    const v = classifySubResolution({ name: 'x', rg: 'y', rows });
    assert.equal(v.ok, false);
    assert.match(v.reason, /UNKNOWN/);
  }
});

test('#4149 — an unambiguous match in the right group resolves', () => {
  // The positive control for the refusals above.
  const v = classifySubResolution({
    name: 'loom-activator',
    rg: 'rg-csa-loom-admin-centralus',
    type: 'microsoft.app/containerapps',
    rows: [
      { sub: 'sub-commercial', rg: 'rg-csa-loom-admin-centralus', type: 'Microsoft.App/containerApps' },
      { sub: 'sub-other', rg: 'rg-somebody-else', type: 'microsoft.app/containerapps' },
    ],
  });
  assert.equal(v.ok, true);
  assert.equal(v.sub, 'sub-commercial', 'the row in the NAMED resource group wins, not the first row');
});

// ── the constants the guard protects ─────────────────────────────────────────

test('#4149 — every resource this file names passes the KQL-safe name rule', () => {
  // The names are constants, so this is defence in depth — but `subFor` is
  // exported and builds a KQL string by concatenation, so the property is
  // asserted at the boundary rather than assumed of the callers.
  for (const r of [...APPS, ...AAS, ADX]) {
    assert.match(r.name, RESOURCE_NAME, `${r.name} would be interpolated into a graph query`);
    assert.match(r.rg, /^rg-csa-loom-/, `${r.rg} is not a CSA Loom resource group`);
    assert.match(r.rg, /-centralus$/, `${r.rg} is not in the Commercial estate's region`);
  }
});

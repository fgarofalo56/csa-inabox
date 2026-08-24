/**
 * estate-preflight tests (refs #3754) — the two reads that stand between a
 * GCC-High deploy and the ARM leaves that have failed it since 2026-08-15.
 *
 * THE BUGS THESE PIN, both measured from run 32126019475:
 *
 *   1. `BadRequest on 'admin-plane': IP allocation method cannot be changed
 *      after creation. … ipAllocationMethod=Dynamic, existingIpAllocationMethod=Static`
 *      network.bicep hard-coded the method. The literal was flipped once already
 *      (Static → Dynamic in #2881, to fix Commercial) and that flip is what broke
 *      GCC-High. The property is IMMUTABLE, so a literal can only ever be right
 *      on one estate; the value has to be READ. The tempting shortcut — treat a
 *      failed read as "no endpoint, use the default" — is the R7 defect that
 *      turns "I could not look" into "it is not there", so the greenfield and
 *      refuse branches are pinned INDEPENDENTLY.
 *
 *   2. `ClusterNotValidForPrincipals … Cluster is in state 'Stopped', cannot
 *      retrieve list of principals`. The tempting shortcut here is to treat any
 *      non-Running state as "start it and hope", or to report success once the
 *      start call returns. Both are pinned against.
 *
 *   3. THE ONE THIS SUITE ORIGINALLY MISSED, found in review. The ADX preflight
 *      classified a MISSING ADMIN RESOURCE GROUP as an unreadable control plane,
 *      so it hard-failed every GREENFIELD apply — `main.bicep` creates that RG
 *      and the preflight runs immediately before it — and blamed the service
 *      principal's Reader role for a cause it had not established (R4 + R7).
 *
 *      WHY IT WAS MISSED, which is the instructive part: bug 1's script put this
 *      exact decision in a PURE, EXPORTED, unit-tested function, and bug 2's
 *      script left the equivalent decision in its untested I/O shell. Two
 *      standards in one change. The rule now lives ONCE, in _arm-absence.mjs,
 *      and both scripts import it — so the drift that caused this cannot recur
 *      silently, and mutation G below proves the suite notices if it tries.
 *
 * MUTATION-PROVEN (measured 2026-08-18, 32 tests, 32 pass / 0 skip at baseline;
 * every file restored byte-identical afterwards):
 *
 *   F. THE ORIGINAL BLOCKER — make a failed enumeration always refuse, so a
 *      missing admin RG reads as an unreadable control plane again
 *        → 2 RED: "a MISSING admin resource group is greenfield, not an
 *                  unreadable control plane", "a missing SUBSCRIPTION is
 *                  greenfield too"
 *   G. ADX stops importing the shared absence rule (the two scripts drift back
 *      to the two standards that caused F)                        → 3 RED
 *   H. widen the SHARED ABSENCE_CODES to swallow 'AuthorizationFailed'
 *        → 2 RED, one per script — which is the point of sharing it
 *   I. network.bicep renames the resolver the preflight reads (a 404 would
 *      then read as greenfield and silently reintroduce #3754)     → 1 RED
 *   J. derive an address for a Static endpoint that reports none   → 1 RED
 *   K. unrecognised ADX state → 'start' instead of 'refuse'        → 1 RED
 *   L. evaluatePoll returns ok:true on budget exhaustion           → 1 RED
 *   M. network.bicep goes back to a hard-coded literal             → 1 RED
 *
 * RECORDED BECAUSE IT NEARLY WENT UNNOTICED: an earlier attempt at a mutation
 * here — neutering the method-is-missing guard with `if (false)` — left the
 * suite GREEN. Not because the test was weak, but because a second branch
 * rejected the value one step later, so the protection was still there. A
 * mutation that does not move the verdict is a statement about the MUTATION,
 * not about the test.
 *
 * Run: node --test scripts/ci/__tests__/estate-preflight.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDnsInboundRead,
  inboundEndpointId,
  GREENFIELD_DEFAULT,
} from '../resolve-dns-inbound-allocation.mjs';
import {
  classifyClusterState,
  classifyClusterListRead,
  evaluatePoll,
  azWithRetry,
  nextRetryDelaySeconds,
  TRANSIENT_BACKOFF_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
} from '../ensure-adx-cluster-running.mjs';
import { classifyAzFailure, isRetryable, remediationFor } from '../_az-failure-class.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const okRead = (config) => ({
  ok: true,
  stdout: JSON.stringify({ properties: { ipConfigurations: [config] } }),
  stderr: '',
});

// ── 1. DNS inbound endpoint addressing ──────────────────────────────────────

test('the live Static endpoint that broke GCC-High is discovered WITH its address', () => {
  const v = classifyDnsInboundRead(
    okRead({ privateIpAllocationMethod: 'Static', privateIpAddress: '10.60.9.4' }),
  );
  assert.equal(v.decision, 'discovered');
  assert.equal(v.value, '10.60.9.4');
});

test('a Static endpoint at an address the old code would NOT have derived is still discovered', () => {
  // An earlier revision of this fix emitted the derived `<prefix>.9.4`. If the
  // live endpoint sits anywhere else, deriving would have failed on
  // privateIpAddress immutability instead — the same defect, one field over.
  // Measuring cannot.
  const v = classifyDnsInboundRead(
    okRead({ privateIpAllocationMethod: 'Static', privateIpAddress: '10.60.9.7' }),
  );
  assert.equal(v.value, '10.60.9.7');
});

test('the live Dynamic endpoint that Commercial holds pins no address', () => {
  const v = classifyDnsInboundRead(
    okRead({ privateIpAllocationMethod: 'Dynamic', privateIpAddress: '10.60.9.4' }),
  );
  assert.equal(v.decision, 'discovered');
  assert.equal(v.value, '');
});

test('a Static endpoint that reports NO address REFUSES rather than deriving one', () => {
  const v = classifyDnsInboundRead(okRead({ privateIpAllocationMethod: 'Static' }));
  assert.equal(v.decision, 'refuse');
  assert.equal(v.value, null);
});

test('a definite ResourceNotFound is greenfield and takes the template default', () => {
  const v = classifyDnsInboundRead({
    ok: false,
    stdout: '',
    stderr: "(ResourceNotFound) The Resource 'Microsoft.Network/dnsResolvers/dnspr-loom-usgovvirginia' was not found.",
  });
  assert.equal(v.decision, 'greenfield');
  assert.equal(v.value, GREENFIELD_DEFAULT);
});

test('a ParentResourceNotFound (no resolver at all) is greenfield', () => {
  const v = classifyDnsInboundRead({ ok: false, stdout: '', stderr: '(ParentResourceNotFound) Failed to perform' });
  assert.equal(v.decision, 'greenfield');
});

test('an RBAC denial is UNKNOWN, never greenfield', () => {
  const v = classifyDnsInboundRead({
    ok: false,
    stdout: '',
    stderr: "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Network/dnsResolvers/read'",
  });
  assert.equal(v.decision, 'refuse');
  assert.equal(v.value, null);
});

test('a throttle is UNKNOWN, never greenfield', () => {
  const v = classifyDnsInboundRead({ ok: false, stdout: '', stderr: '(TooManyRequests) Rate limit exceeded' });
  assert.equal(v.decision, 'refuse');
});

test('a network failure with no ARM code at all is UNKNOWN', () => {
  const v = classifyDnsInboundRead({ ok: false, stdout: '', stderr: 'Could not connect to the endpoint URL' });
  assert.equal(v.decision, 'refuse');
});

test('an endpoint whose payload carries no method REFUSES', () => {
  const v = classifyDnsInboundRead(okRead({}));
  assert.equal(v.decision, 'refuse');
  assert.equal(v.value, null);
});

test('exit 0 with unparseable output REFUSES', () => {
  const v = classifyDnsInboundRead({ ok: true, stdout: 'Welcome to Azure CLI', stderr: '' });
  assert.equal(v.decision, 'refuse');
});

test('an allocation method that is neither Dynamic nor Static REFUSES', () => {
  const v = classifyDnsInboundRead(okRead({ privateIpAllocationMethod: 'Automatic' }));
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /Automatic/);
});

test('the endpoint id names the hub resolver convention network.bicep uses', () => {
  const id = inboundEndpointId({ subscription: 'sub-1', rg: 'rg-csa-loom-admin-usgovvirginia', location: 'usgovvirginia' });
  assert.equal(
    id,
    '/subscriptions/sub-1/resourceGroups/rg-csa-loom-admin-usgovvirginia' +
      '/providers/Microsoft.Network/dnsResolvers/dnspr-loom-usgovvirginia/inboundEndpoints/inbound',
  );
});

// ── 2. ADX cluster ENUMERATION — the greenfield blocker ─────────────────────
//
// Verbatim from live ARM (Commercial, 2026-08-18), because the exit code alone
// does not separate these two:
//   missing RG  -> exit 3, stdout "[]",  stderr "(ResourceGroupNotFound) …"
//   real RG     -> exit 0, stdout ["/subscriptions/…/clusters/adx-csa-loom-z52x3p"]

test('a MISSING admin resource group is greenfield, not an unreadable control plane', () => {
  // The blocker: main.bicep CREATES the admin RG and this preflight runs
  // immediately before it, so on a fresh sovereign subscription — or after this
  // lane's own Teardown, or on the never-run IL5 boundary — the RG is absent by
  // construction. Refusing here killed every greenfield apply (R4) and blamed
  // the service principal's Reader role for it (R7).
  const v = classifyClusterListRead({
    ok: false,
    stdout: '[]',
    stderr: "ERROR: (ResourceGroupNotFound) Resource group 'rg-csa-loom-admin-usgovvirginia' could not be found.",
  });
  assert.equal(v.decision, 'greenfield');
  assert.deepEqual(v.ids, []);
});

test('a missing SUBSCRIPTION is greenfield too', () => {
  const v = classifyClusterListRead({ ok: false, stdout: '', stderr: '(SubscriptionNotFound) not found' });
  assert.equal(v.decision, 'greenfield');
});

test('an RBAC denial on the enumeration REFUSES — unreadable is not empty', () => {
  const v = classifyClusterListRead({
    ok: false,
    stdout: '[]',
    stderr: "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Kusto/clusters/read'",
  });
  assert.equal(v.decision, 'refuse');
  assert.equal(v.ids, null);
});

test('a throttle on the enumeration REFUSES', () => {
  const v = classifyClusterListRead({ ok: false, stdout: '', stderr: '(TooManyRequests) Rate limit exceeded' });
  assert.equal(v.decision, 'refuse');
});

test('a REAL resource group holding no clusters is greenfield, not a refusal', () => {
  const v = classifyClusterListRead({ ok: true, stdout: '[]', stderr: '' });
  assert.equal(v.decision, 'greenfield');
});

test('a real cluster list is passed through for state checking', () => {
  const id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx-csa-loom-fmezxj';
  const v = classifyClusterListRead({ ok: true, stdout: JSON.stringify([id]), stderr: '' });
  assert.equal(v.decision, 'listed');
  assert.deepEqual(v.ids, [id]);
});

test('exit 0 with a non-array / unparseable enumeration REFUSES', () => {
  assert.equal(classifyClusterListRead({ ok: true, stdout: 'Welcome to Azure CLI', stderr: '' }).decision, 'refuse');
  assert.equal(classifyClusterListRead({ ok: true, stdout: '{"a":1}', stderr: '' }).decision, 'refuse');
});

// ── 3. ADX cluster state ────────────────────────────────────────────────────

test("the measured 'Stopped' state starts the cluster", () => {
  const v = classifyClusterState('Stopped');
  assert.equal(v.action, 'start');
  assert.match(v.reason, /ClusterNotValidForPrincipals/);
});

test('a Running cluster is left completely alone', () => {
  assert.equal(classifyClusterState('Running').action, 'none');
});

test('a cluster already Starting is waited on, not started again', () => {
  assert.equal(classifyClusterState('Starting').action, 'wait');
});

test('an Unavailable cluster REFUSES — no start resolves it', () => {
  const v = classifyClusterState('Unavailable');
  assert.equal(v.action, 'refuse');
});

test('an unrecognised state REFUSES rather than guessing', () => {
  assert.equal(classifyClusterState('Hibernating').action, 'refuse');
  assert.equal(classifyClusterState('').action, 'refuse');
  assert.equal(classifyClusterState(undefined).action, 'refuse');
});

test('Running ends the poll successfully', () => {
  const v = evaluatePoll({ state: 'Running', elapsedSeconds: 90, budgetSeconds: DEFAULT_TIMEOUT_SECONDS });
  assert.deepEqual([v.done, v.ok], [true, true]);
});

test('an exhausted budget is a FAILURE, not a pass', () => {
  const v = evaluatePoll({ state: 'Starting', elapsedSeconds: 1800, budgetSeconds: 1800 });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /UNCONFIRMED/);
});

test('a cluster that goes Unavailable mid-poll ends the poll as a failure immediately', () => {
  const v = evaluatePoll({ state: 'Unavailable', elapsedSeconds: 30, budgetSeconds: 1800 });
  assert.deepEqual([v.done, v.ok], [true, false]);
});

// ── 4. CONTROLS — these must stay GREEN under every mutation above ──────────

test('CONTROL: both preflights share ONE definition of "definitely absent"', () => {
  // The blocker above existed because the two scripts answered the same
  // question by two different standards. Importing the shared rule is what
  // makes that impossible; if either stops importing it, they can drift again.
  for (const f of ['resolve-dns-inbound-allocation.mjs', 'ensure-adx-cluster-running.mjs']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci', f), 'utf8');
    assert.match(src, /from '\.\/_arm-absence\.mjs'/, `${f} must use the shared absence rule`);
  }
});

test('CONTROL: the resolver name the preflight reads matches the one bicep DEPLOYS', () => {
  // NIT 4 — greenfield and "I looked in the wrong place" are indistinguishable
  // to ARM: both are a 404. If network.bicep ever renames the resolver, the
  // preflight would 404 on a Static estate, classify it greenfield, emit '',
  // and silently reintroduce #3754. The id convention is duplicated by
  // necessity (bicep cannot export it to a node script), so it is pinned.
  const network = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/network.bicep'),
    'utf8',
  );
  assert.match(
    network,
    /resource dnsResolver 'Microsoft\.Network\/dnsResolvers@[^']+' = \{\s*\n\s*name: 'dnspr-loom-\$\{location\}'/,
    "network.bicep must still name the resolver 'dnspr-loom-${location}'",
  );
  assert.match(
    inboundEndpointId({ subscription: 's', rg: 'rg', location: 'usgovvirginia' }),
    /\/dnsResolvers\/dnspr-loom-usgovvirginia\/inboundEndpoints\/inbound$/,
  );
});

test('CONTROL: the greenfield default equals the bicep parameter default it stands in for', () => {
  // A drift here would silently propose a change to an IMMUTABLE property on
  // every greenfield deploy, which is the whole failure class this closes.
  const network = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/network.bicep'),
    'utf8',
  );
  const m = network.match(/param dnsResolverInboundStaticIp string = '([^']*)'/);
  assert.ok(m, 'network.bicep must declare dnsResolverInboundStaticIp with a default');
  assert.equal(m[1], GREENFIELD_DEFAULT);
});

test('CONTROL: the bicep resource keys BOTH branches off the SAME parameter', () => {
  // Without this, the resource could quietly go back to a hard-coded literal
  // and every test above would still pass — the classifier would be resolving a
  // value nothing consumed. That is the "guard with zero population" shape.
  const network = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/network.bicep'),
    'utf8',
  );
  assert.match(network, /empty\(dnsResolverInboundStaticIp\)/);
  assert.match(network, /privateIpAddress: dnsResolverInboundStaticIp/);
});

// ── 5. az FAILURE CLASSIFICATION + BOUNDED RETRY (#3786 round 2) ────────────
//
// Both fixtures below are VERBATIM stderr from the runs that broke the deploy
// on 2026-08-24. They are the point of this section: before this change every
// one of them produced the same message — "grant the deploy service principal
// Reader" — and only one of the classes is even about permissions.

/** deploy-fiab-commercial run 32700023215, step "ADX preflight". */
const MEASURED_COMMERCIAL_STDERR = [
  'ERROR: (GatewayTimeout) GatewayTimeout',
  'Code: GatewayTimeout',
  'Message: GatewayTimeout',
].join('\n');

/** deploy-fiab-gcch run 32716865363, same step, DIFFERENT cause. */
const MEASURED_GCCH_STDERR = [
  'ERROR: (InsufficientResourcesForSubscription) [BadRequest] Currently there are no available resources to start the cluster with current SKU. Please choose different SKU',
  'Code: InsufficientResourcesForSubscription',
].join('\n');

test('the MEASURED Commercial failure is TRANSIENT — not a permission problem', () => {
  assert.equal(classifyAzFailure(MEASURED_COMMERCIAL_STDERR), 'transient');
  assert.equal(isRetryable('transient'), true);
});

test('the MEASURED GCC-High failure is CAPACITY — not transient, not permissions', () => {
  assert.equal(classifyAzFailure(MEASURED_GCCH_STDERR), 'capacity');
  // Retrying a region that is out of SKU capacity just delays the real answer.
  assert.equal(isRetryable('capacity'), false);
});

test('neither measured failure produces a "grant Reader" remediation', () => {
  // THE REGRESSION THIS PINS. The old code emitted the permissions remediation
  // unconditionally, for exactly these two inputs.
  for (const stderr of [MEASURED_COMMERCIAL_STDERR, MEASURED_GCCH_STDERR]) {
    const text = remediationFor(classifyAzFailure(stderr), '/subscriptions/x/clusters/c');
    assert.doesNotMatch(text, /grant .*Reader|needs Reader/i, `misdiagnosed: ${stderr.split('\n')[0]}`);
  }
});

test('a REAL denial still gets the permission remediation — the classifier is not just "never blame RBAC"', () => {
  // COUNTERFACTUAL. Without this, deleting the DENIED branch entirely would
  // leave every test above green: "never say permissions" would satisfy them.
  const denial = 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action';
  assert.equal(classifyAzFailure(denial), 'denied');
  assert.match(remediationFor('denied', '/subscriptions/x/clusters/c'), /Reader|Kusto Contributor/);
});

test('an unrecognised failure asserts NO cause at all', () => {
  assert.equal(classifyAzFailure('ERROR: something nobody has seen before'), 'unknown');
  const text = remediationFor('unknown', '/scope');
  assert.match(text, /NO cause is asserted/);
  assert.doesNotMatch(text, /grant|permission problem/i);
});

test('a transient failure that CLEARS is retried and then succeeds', () => {
  let calls = 0;
  const slept = [];
  const res = azWithRetry(['resource', 'show'], {
    runner: () => {
      calls += 1;
      return calls < 3
        ? { ok: false, stdout: '', stderr: MEASURED_COMMERCIAL_STDERR }
        : { ok: true, stdout: 'Stopped\n', stderr: '' };
    },
    sleep: (s) => slept.push(s),
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(res.stdout.trim(), 'Stopped');
  assert.deepEqual(slept, [5, 15], 'must back off between attempts, not hammer ARM');
});

test('FAIL CLOSED: a transient failure that NEVER clears exhausts the budget and still FAILS', () => {
  // deploy-integrity.md R6 — "a retry that cannot fail is forbidden". This is
  // the mutation that matters: if the retry ever masked a real outage by
  // returning ok, the preflight would have stopped watching.
  const slept = [];
  const res = azWithRetry(['resource', 'show'], {
    runner: () => ({ ok: false, stdout: '', stderr: MEASURED_COMMERCIAL_STDERR }),
    sleep: (s) => slept.push(s),
  });
  assert.equal(res.ok, false, 'an unresolved transient failure must NOT be reported as success');
  assert.equal(res.kind, 'transient');
  assert.equal(res.attempts, TRANSIENT_BACKOFF_SECONDS.length + 1);
  assert.deepEqual(slept, TRANSIENT_BACKOFF_SECONDS, 'the schedule is the whole budget');
});

test('a NON-retryable failure returns immediately — no 50s spent on a refusal', () => {
  let calls = 0;
  const res = azWithRetry(['resource', 'invoke-action'], {
    runner: () => {
      calls += 1;
      return { ok: false, stdout: '', stderr: MEASURED_GCCH_STDERR };
    },
    sleep: () => assert.fail('a capacity refusal must not be slept on'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'capacity');
  assert.equal(calls, 1);
});

test('the backoff schedule is FINITE — the budget can actually be exceeded', () => {
  // The sibling defect this file already documents for --timeout-seconds: a
  // budget that can never be exceeded is a budget that is not enforced.
  assert.equal(nextRetryDelaySeconds(TRANSIENT_BACKOFF_SECONDS.length), null);
  assert.equal(nextRetryDelaySeconds(9999), null);
  assert.equal(nextRetryDelaySeconds(-1), null);
  assert.equal(nextRetryDelaySeconds(0), TRANSIENT_BACKOFF_SECONDS[0]);
});

test('CONTROL: the preflight no longer asserts an UNVERIFIED failure history', () => {
  // MEASURED at step level across 30 gcch runs and 25 commercial runs: the
  // claim "has failed every GCC-High deploy since 2026-08-15" was false — the
  // gcch failures in that window were `Provision (with full Gov dispatch)` and
  // `Bicep what-if`, and this leaf first failed anything on 2026-08-22T20:06Z.
  // A failure history asserted in a string and never re-measured rots exactly
  // like a cause asserted in a string.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const emitted = src.split('// ── I/O shell')[1] ?? '';
  assert.doesNotMatch(emitted, /has failed every GCC-High deploy since/);
});

test('CONTROL: no emitted remediation hard-codes a permissions cause', () => {
  // The R7 shape, keyed to the SHAPE rather than a spelling: any `fail(` message
  // in the I/O shell that names Reader/Contributor directly is asserting a cause
  // the call site did not establish. The permission wording now lives in ONE
  // place — remediationFor's `denied` branch — reachable only when az said so.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const shell = src.split('// ── I/O shell')[1] ?? '';
  assert.ok(shell.length > 0, 'the I/O shell marker must exist for this control to have a population');
  assert.doesNotMatch(shell, /needs Reader|grant the deploy service principal|needs Microsoft\.Kusto\/clusters\/start\/action/);
});

test('CONTROL: every az call in the preflight goes through the retry wrapper', () => {
  // The adoption gap in miniature: adding a fourth `az([...])` call later would
  // reintroduce the single-shot exposure that a GatewayTimeout turned into a
  // failed deploy, and every other test here would stay green.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const shell = src.split('// ── I/O shell')[1] ?? '';
  const bare = shell.match(/(?<!WithRetry)\baz\(\[/g) ?? [];
  assert.deepEqual(bare, [], 'every az invocation must be azWithRetry so transient failures are retried');
});

test('CONTROL: the shared az-failure classifier is actually imported', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  assert.match(src, /from '\.\/_az-failure-class\.mjs'/);
});

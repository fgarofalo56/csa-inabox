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
  elapsedSecondsSince,
  TRANSIENT_BACKOFF_SECONDS,
  POLL_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
} from '../ensure-adx-cluster-running.mjs';
import {
  classifyAzFailure,
  isRetryable,
  remediationFor,
  STATUS_TOKEN_LOOKBEHIND,
  STATUS_TOKEN_LOOKAHEAD,
} from '../_az-failure-class.mjs';
import {
  classifyPauseDeclaration,
  reconcileWithDeclaredPause,
  PAUSE_DECLARATION_PATH,
  MIN_REASON_CHARS,
} from '../_estate-pause-declaration.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const okRead = (config) => ({
  ok: true,
  stdout: JSON.stringify({ properties: { ipConfigurations: [config] } }),
  stderr: '',
});

/**
 * Source with comments removed.
 *
 * Every source-shape control in this file must scan CODE. Two of them were
 * first written against raw source and went red on a CORRECT tree, because the
 * docblocks explaining each fix QUOTE the defective form they replaced
 * (`elapsed += POLL_INTERVAL_SECONDS`, `\b40[13]\b`). A guard that fires on
 * prose is a guard that gets weakened or deleted, and it would have pushed the
 * next author to stop documenting the reason for the fix.
 */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

// ── 5b. THE ORDERING IS LOAD-BEARING, SO IT GETS DISCRIMINATING FIXTURES ────
//
// Added after review of #4013. Every one of the three orderings below was
// documented as load-bearing and NONE had a control: inverting each one left
// the whole suite green (measured RC=0 for all three). The fixtures here are
// chosen so that they FLIP when the order flips — a fixture that classifies the
// same either way tests nothing about order.

test('F1: a DENIAL whose scope contains a status-shaped token is denied, NOT transient', () => {
  // THE SHIPS-A-DEFECT CASE. `\b(429|500|502|503|504)\b` treats `-` as a word
  // boundary, so `rg-loom-503` made a real AuthorizationFailed classify as
  // transient — and the transient remediation then affirmatively denied the
  // true cause. On this input the hardcoded message this file replaced was
  // RIGHT, which made the fix a regression for this one input class. Latent on
  // today's hub names; reachable on customer-named brownfield RGs (R5).
  const denial =
    "ERROR: (AuthorizationFailed) refused over scope '/subscriptions/x/resourceGroups/rg-loom-503/'";
  assert.equal(classifyAzFailure(denial), 'denied');
  assert.match(remediationFor('denied', '/scope'), /Reader|Kusto Contributor/);
});

test('F1: the numeric transient signals are ANCHORED to standalone tokens', () => {
  // Both halves matter, and each is DISCRIMINATED by its own fixture below —
  // these two are blocked by either anchor alone, so they pin the anchor's
  // existence but not which half.
  assert.notEqual(classifyAzFailure('ERROR: (Conflict) on resource rg-loom-503-hub'), 'transient');
  assert.notEqual(classifyAzFailure('ERROR: (Conflict) guid 0000-503a-0000'), 'transient');
  assert.equal(classifyAzFailure('ERROR: 502 Bad Gateway'), 'transient');
  assert.equal(classifyAzFailure('ERROR: status code: 429'), 'transient');
});

test('the LOOKBEHIND half is load-bearing: a TRAILING status token is not transient', () => {
  // Discriminates a lookbehind-only revert. `rg-loom-503` ends with the token,
  // so the lookahead does not block it — only the lookbehind does. Measured:
  // with the lookbehind removed this input matches TRANSIENT again.
  assert.notEqual(classifyAzFailure("ERROR: (Conflict) over scope 'rg-loom-503'"), 'transient');
  assert.equal(STATUS_TOKEN_LOOKBEHIND, '(?<![\\w-])');
});

test('the LOOKAHEAD half is load-bearing: a LEADING status token is not transient', () => {
  // Discriminates a lookahead-only revert. `503117` / `503Error` START with the
  // token, so the lookbehind does not block them — only the lookahead does.
  assert.notEqual(classifyAzFailure('ERROR: (Conflict) correlation 503117 failed'), 'transient');
  assert.notEqual(classifyAzFailure('ERROR: (Conflict) code 503Error raised'), 'transient');
  assert.equal(STATUS_TOKEN_LOOKAHEAD, '(?![\\w-])');
});

test('the SIBLING alternations are anchored too — all three, not just TRANSIENT', () => {
  // THE ROUND-2 ASK. The first fix anchored TRANSIENT and left DENIED's 40[13]
  // and NOT_FOUND's 404 on `\b` — and promoting DENIED to first made it worse
  // than round 1, not better. Measured before this fix, on the exact 2026-08-24
  // stderr: `rg-loom-403` -> denied, `rg-404-archive` -> notfound,
  // `adx-401` -> denied. The first printed "This one IS a permission problem,
  // and az named it: grant Reader" — the original defect restored, and the R6
  // retry lost with it because `denied` is not retryable.
  const gt = 'ERROR: (GatewayTimeout) GatewayTimeout';
  assert.equal(classifyAzFailure(`${gt} over scope '/resourceGroups/rg-loom-403/'`), 'transient');
  assert.equal(classifyAzFailure(`${gt} over scope '/resourceGroups/rg-401-x/'`), 'transient');
  assert.equal(classifyAzFailure(`${gt} over scope '/resourceGroups/rg-404-archive/'`), 'transient');
  assert.equal(
    classifyAzFailure("ERROR: (InsufficientResourcesForSubscription) there are no available resources on 'adx-401'"),
    'capacity',
  );

  // …and the real status codes must still classify, or the anchor has simply
  // deleted the alternation rather than constrained it.
  assert.equal(classifyAzFailure('ERROR: The remote server returned 403 Forbidden'), 'denied');
  assert.equal(classifyAzFailure('ERROR: HTTP 404 - the resource path does not exist'), 'notfound');
});

test('CONTROL: all three alternations build from the ONE shared anchor', () => {
  // Three regex literals meant three chances to half-fix and three to
  // half-revert; that is exactly how round 1 shipped one anchored and two not.
  // A shared fragment makes the anchor right everywhere or wrong everywhere.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/_az-failure-class.mjs'), 'utf8');
  const code = codeOnly(src);
  const uses = code.match(/statusToken\(/g) ?? [];
  // EXACTLY three: TRANSIENT (429|500|502|503|504), DENIED (40[13]),
  // NOT_FOUND (404). CAPACITY carries no status numbers, so it must NOT gain
  // one silently — an equality here catches both a dropped call site and a
  // fourth one nobody reviewed.
  assert.equal(uses.length, 3, `statusToken() must build all three status alternations, saw ${uses.length}`);
  // No alternation may go back to a hand-rolled \b around a status number.
  // Scanned on CODE: the docblock above deliberately quotes `\b40[13]\b` and
  // `\b404\b` as the forms that were wrong.
  assert.doesNotMatch(code, /\\b4\d\[?\d/, 'a status alternation is back on \\b — use statusToken()');
  assert.doesNotMatch(code, /\\b\(?429\|/, 'the transient alternation is back on \\b — use statusToken()');
  // POPULATION: the stripper must not have eaten the module.
  assert.match(code, /export const TRANSIENT/, 'the comment stripper ate the source — no population');
});

test('alpha: SKU exhaustion worded "temporarily unavailable" is CAPACITY, not transient', () => {
  // Flips to `transient` the moment TRANSIENT is tested before CAPACITY, which
  // would retry a region that is out of capacity and then report the wrong cause.
  assert.equal(
    classifyAzFailure('ERROR: (SkuNotAvailable) The requested SKU is temporarily unavailable in this region.'),
    'capacity',
  );
});

test('delta: a denial worded "could not be found" is DENIED, not notfound', () => {
  // Flips to `notfound` the moment NOT_FOUND is tested before DENIED — and the
  // notfound remediation says "ARM reports the target does not exist", turning
  // "I was refused" into "it is not there". That is the exact confusion
  // _arm-absence.mjs exists to prevent, one layer up.
  const denial =
    'ERROR: (LinkedAuthorizationFailed) the linked subscription could not be found or the client does not have access.';
  assert.equal(classifyAzFailure(denial), 'denied');
});

test('gamma: an EMPTY stderr is UNKNOWN — a failure that said nothing establishes nothing', () => {
  // Escaped a mutation that classified empty stderr as `denied`. az can fail
  // with an empty stderr for real (spawnSync ENOENT), so this is reachable.
  for (const empty of ['', '   \n  ', null, undefined]) {
    assert.equal(classifyAzFailure(empty), 'unknown', `empty-ish stderr must be unknown: ${JSON.stringify(empty)}`);
  }
});

test('the transient remediation states its LIMIT and makes no negative claim', () => {
  // It used to say "Nothing is wrong with the configuration" and "not the deploy
  // identity" — two negative claims the code never tested. R7 applies to a
  // confident exoneration exactly as it applies to a confident accusation.
  const text = remediationFor('transient', '/scope', 4);
  assert.doesNotMatch(text, /not the deploy identity|Nothing is wrong/i);
  assert.match(text, /did not complete/i);
  assert.match(text, /did not test/i);
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

// ── 5c. THE POLL BUDGET IS A WALL CLOCK, AND THE ERROR QUOTES IT ────────────

test('elapsed is REAL time, so retry sleeps are charged to the budget', () => {
  // The accumulator counted only the 30s poll sleeps. A poll whose readState
  // burned 50s of retry sleep and then succeeded advanced `elapsed` by 30 —
  // so the budget under-counted by the entire retry time.
  const t0 = 1_000_000;
  assert.equal(elapsedSecondsSince(t0, t0 + 80_000), 80, 'a poll (30s) plus its retries (50s) is 80s, not 30s');
  assert.equal(elapsedSecondsSince(t0, t0), 0);
  assert.equal(elapsedSecondsSince(t0, t0 + 1_500), 1, 'whole seconds, floored');
});

test('a non-monotonic clock cannot make the budget unreachable', () => {
  // NTP step / VM resume. A negative elapsed would read as "no time has passed"
  // and the budget could never be exceeded — the exact shape this file already
  // guards against for a NaN --timeout-seconds.
  const t0 = 1_000_000;
  assert.equal(elapsedSecondsSince(t0, t0 - 500_000), 0);
  assert.equal(elapsedSecondsSince(t0, Number.NaN), 0);
  assert.equal(elapsedSecondsSince(Number.NaN, t0), 0);
});

test('R7: the elapsed figure the error QUOTES is the figure that was measured', () => {
  // This is why the wall clock belongs in this PR rather than only in #4023.
  // The budget-exhausted message interpolates `elapsedSeconds` verbatim:
  //   "still 'Starting' after 120s (budget 120s)"
  // Under the accumulator, 370s of real waiting printed "after 120s" — an error
  // asserting a figure it had not measured, which is the exact class this PR
  // exists to close. Feed evaluatePoll the REAL elapsed and the text is true.
  const startedAtMs = 1_000_000;
  const realElapsed = elapsedSecondsSince(startedAtMs, startedAtMs + 370_000);
  const v = evaluatePoll({ state: 'Starting', elapsedSeconds: realElapsed, budgetSeconds: 120 });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /after 370s/, `the message must quote real elapsed time, got: ${v.reason}`);
  assert.doesNotMatch(v.reason, /after 120s/);
});

test('CONTROL: the poll loop derives elapsed from the clock, not an accumulator', () => {
  // Keyed to the shape. Re-adding `elapsed += POLL_INTERVAL_SECONDS` restores
  // both the false figure and the ~92-min ceiling, and every assertion above
  // would stay green because they test the helper rather than the loop.
  //
  // COMMENTS ARE STRIPPED FIRST. The first version of this control matched the
  // explanatory comment that QUOTES the old accumulator and went red on a
  // correct tree — a guard that fires on prose is a guard that gets deleted or
  // watered down. It must read code.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const shell = src.split('// ── I/O shell')[1] ?? '';
  const code = codeOnly(shell);

  assert.doesNotMatch(code, /elapsed\s*\+=/, 'the poll budget is back on an accumulator');
  assert.match(code, /elapsedSecondsSince\(startedAtMs, Date\.now\(\)\)/, 'the poll loop must read the clock');

  // POPULATION, two ways: the comment-stripper must not have eaten the loop,
  // and the interval constant must still drive the SLEEP. Without these a
  // stripper bug would leave an empty string that trivially satisfies the
  // doesNotMatch above.
  assert.ok(code.includes('for (;;)'), 'the poll loop vanished — this control has no population');
  assert.equal(typeof POLL_INTERVAL_SECONDS, 'number');
  assert.match(code, /sleepSeconds\(POLL_INTERVAL_SECONDS\)/);
});

test('CONTROL: the preflight emits no failure STATISTIC in an error string', () => {
  // NOT "because the claim was false" — it was TRUE. Measured at the ARM leaf,
  // `ClusterNotValidForPrincipals … Cluster is in state 'Stopped'` appears as
  // real timestamped output in 8 of the 8 gcch runs from 2026-08-15 to
  // 2026-08-22T10:12Z. The first version of this control cited a step-level
  // measurement to refute a leaf-level claim, which is a category error.
  //
  // The reason a statistic does not belong in an emitted error is that it rots:
  // the code that prints it cannot re-measure it, and this one was already
  // describing a closed window by the time it shipped. Keyed to the SHAPE — any
  // "every/all N … since <date>" style history — not to the one sentence, so
  // the next such claim is caught too.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const emitted = src.split('// ── I/O shell')[1] ?? '';
  assert.ok(emitted.length > 0, 'the I/O shell marker must exist for this control to have a population');
  assert.doesNotMatch(emitted, /has failed every|every .* deploy since|all \d+ .* since/i);
});

test('CONTROL: no emitted remediation hard-codes a permissions cause', () => {
  // Keyed to the SHAPE, not a spelling. The first version matched three literal
  // strings, and review drove a mutation straight past it: a new `fail()` saying
  // "REMEDIATION: assign the Contributor role to the deployment identity at this
  // scope" left every gate green while reintroducing the exact defect this PR
  // exists to close.
  //
  // The rule now: the I/O shell may not name a ROLE at all. Every permission
  // sentence lives in exactly one place — remediationFor's `denied` branch —
  // which is reachable only when az actually said `AuthorizationFailed`.
  // Measured on the fixed source: zero occurrences of any of these in the shell.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const shell = src.split('// ── I/O shell')[1] ?? '';
  assert.ok(shell.length > 0, 'the I/O shell marker must exist for this control to have a population');
  const roleTokens = shell.match(/\b(Reader|Contributor|Owner|RBAC|roleAssignment|role assignment)\b/gi) ?? [];
  assert.deepEqual(
    roleTokens,
    [],
    `the I/O shell names a role directly (${roleTokens.join(', ')}) — permission wording must come from remediationFor`,
  );
});

test('CONTROL: every az call in the preflight goes through the retry wrapper', () => {
  // Also re-keyed. The first version matched `az([` specifically, so
  // `const probeArgs = [...]; az(probeArgs);` reintroduced the single-shot
  // exposure with the suite green. This matches ANY `az(` call other than the
  // function's own definition — argument shape is irrelevant.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  const shell = src.split('// ── I/O shell')[1] ?? '';
  const calls = shell.match(/(?<!function )\baz\(/g) ?? [];
  assert.deepEqual(
    calls,
    [],
    `${calls.length} direct az(...) call(s) in the I/O shell — every invocation must be azWithRetry so transient failures are retried`,
  );
  // POPULATION: the definition must still be there, or the matcher above is
  // scanning a section that no longer contains any az call at all.
  assert.match(shell, /function az\(args\)/, 'the az() definition vanished — this control has no population');
});

test('CONTROL: the shared az-failure classifier is actually imported', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/ensure-adx-cluster-running.mjs'), 'utf8');
  assert.match(src, /from '\.\/_az-failure-class\.mjs'/);
});

// ── 9. THE CAPACITY REMEDIATION MUST NAME A LEVER THAT ACTUALLY MOVES ───────
//
// MEASURED (deploy-fiab-gcch run 32958070797, 2026-08-26 — the 5th consecutive
// class-A failure and the 17th consecutive red run since 2026-08-11):
//
//   ##[error]The start of ADX cluster 'adx-csa-loom-fmezxj' was REJECTED after 1
//   attempt(s) ... az classified this as: capacity. REMEDIATION: ... Either pick
//   a SKU that has capacity in the region (adx-cluster.bicep `adxSku`) ...
//
// The classification is RIGHT — the raw az error is
// `(InsufficientResourcesForSubscription)`, and no retry or role grant resolves
// that. The REMEDIATION is what this section pins, because lever after lever
// proposed for it turned out to be unreachable:
//
//   1. `adxSku` is not a parameter anywhere. adx-cluster.bicep declares
//      `param skuName`; admin-plane/main.bicep declares the var `adxSkuName`.
//   2. adx-cluster.bicep's `skuName` DEFAULT is dead on every path that reaches
//      this error, because admin-plane/main.bicep always passes `skuName:`
//      explicitly (control below). Editing that file changes nothing.
//   3. On GCC-High / IL5 the `effectiveAdxSkuName` boundary guard rewrites the
//      Commercial Dev default — but ONLY that default. An explicitly-set value
//      passes through unchanged, which is what makes lever 4 work now.
//      (An earlier revision of this comment said "regardless". That was wrong:
//      the guard is an equality test against the Commercial default, not an
//      unconditional overwrite. The message was corrected with it.)
//   4. `adxConfig.adxSkuName` in the boundary .bicepparam WAS unreachable, and
//      is now the real lever. HISTORY, because the receipt below is worth
//      keeping and would otherwise read as a present-tense claim:
//
//      UNTIL #4126 (ef6cf727e3), `adxConfig` was a param of the MODULE
//      (admin-plane/main.bicep) only. Every lane's .bicepparam is
//      `using '../main.bicep'`, the ROOT template, which declared no
//      `adxConfig` and passed none to the adminPlane module — so it always took
//      its `{}` default, and assigning it in the param file did not change the
//      SKU, it stopped the deploy from compiling.
//
//      RECEIPT AS MEASURED THEN (local `az bicep build-params`, no Azure
//      contact), each probe a byte-copy of the real params/gcc-high.bicepparam
//      plus ONE assignment:
//        baseline, unmodified ................................. RC=0
//        + hubAdxClusterPrincipalId (declared on root) ......... RC=0   <- positive control
//        + adxEnabled (declared, already assigned) ............. RC=1 BCP028 (duplicate)
//        + adxConfig .......................................... RC=1 BCP259
//        + adxSkuName ......................................... RC=1 BCP259
//      BCP259 is "assigned in the params file without being declared in the
//      Bicep file". The positive control returning RC=0 is what makes the two
//      BCP259s a measurement rather than "any append fails".
//
//      #4126 THEN BUILT THE LEVER: main.bicep:420 declares
//      `param adxConfig object = {}` and :1264 threads `adxConfig: adxConfig`
//      into the adminPlane module. So a boundary .bicepparam CAN now carry the
//      SKU, the BCP259 above no longer reproduces, and the CONVERSE arm in the
//      control below is what caught the message still claiming otherwise.
//
// So there are now TWO different actions, and the remediation names both
// because they are not substitutes for each other:
//   * to UNBLOCK THIS RUN — the LIVE cluster, changed out-of-band, because this
//     preflight aborts before the apply;
//   * to make it DURABLE — `adxConfig.adxSkuName` in the boundary .bicepparam,
//     or this lane's own apply asks for the template SKU again and reverts it.
//
// This is deploy-integrity.md R7 applied to a remediation rather than to a
// cause: a message must not assert a fix it did not establish would work — and,
// as this comment block itself had to learn, neither may the comment that
// justifies it.

const BICEP_SOURCES = [
  'platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep',
  'platform/fiab/bicep/modules/admin-plane/main.bicep',
  'platform/fiab/bicep/params/gcc-high.bicepparam',
];

// The .bicepparam the GCC-High lane actually deploys (deploy-fiab-gcch.yml
// passes it as --parameters alongside --template-file .../bicep/main.bicep).
const LANE_PARAM_FILE = 'platform/fiab/bicep/params/gcc-high.bicepparam';

// `_` and `-` are IN the class deliberately. With the previous
// /`([A-Za-z][A-Za-z0-9.]*)`/ a snake_case or kebab-case identifier extracted to
// NOTHING, so `adx_sku_name` — an identifier that exists nowhere — slipped past
// the existence loop entirely unless EVERY identifier in the message was
// snake/kebab (which is all the population assert could catch).
const IDENT_RE = /`([A-Za-z][A-Za-z0-9._-]*)`/g;

/**
 * Resolve what a .bicepparam can ACTUALLY set: follow its `using` to the
 * template it targets and collect that template's declared params.
 *
 * This is the fix for the control that let PR #4115's own message through. The
 * old version joined three bicep files into one haystack and word-matched the
 * dotted leaf, so a property of a MODULE's param type satisfied a claim about
 * what is settable in a ROOT-targeted param file. Following `using` cannot be
 * defeated that way, because it reads whichever layer is genuinely deployed.
 */
function paramTargetOf(paramFileRel) {
  const abs = path.join(REPO_ROOT, paramFileRel);
  const src = fs.readFileSync(abs, 'utf8');
  const using = src.match(/^\s*using\s+'([^']+)'/m);
  assert.ok(using, `${paramFileRel} has no \`using\` statement, so its deploy target cannot be resolved`);
  const targetAbs = path.resolve(path.dirname(abs), using[1]);
  assert.ok(fs.existsSync(targetAbs), `${paramFileRel} targets '${using[1]}', which does not exist`);
  const target = fs.readFileSync(targetAbs, 'utf8');
  const declared = new Set([...target.matchAll(/^param\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]));
  return { rel: using[1], src: target, declared };
}

test('every bicep identifier the CAPACITY remediation names actually exists', () => {
  const text = remediationFor('capacity', '/subscriptions/x/clusters/c');
  const named = [...text.matchAll(IDENT_RE)].map((m) => m[1]);

  // POPULATION. A remediation that names no identifier at all would satisfy the
  // loop below vacuously — that is the weakening this guards against.
  assert.ok(
    named.length > 0,
    'the capacity remediation names no bicep identifier at all, so it points the operator at nothing',
  );

  const haystack = BICEP_SOURCES.map((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).join('\n');
  for (const ident of named) {
    // Match the LEAF of a dotted path (adxConfig.adxSkuName -> adxSkuName), since
    // bicep declares the property, not the dotted access.
    const leaf = ident.split('.').pop();
    assert.ok(
      new RegExp(`\\b${leaf}\\b`).test(haystack),
      `the capacity remediation names \`${ident}\`, but no bicep source declares '${leaf}' — ` +
        'an operator following this remediation edits something that does not exist',
    );
  }
});

test('the CAPACITY remediation names an action that actually reaches the SKU', () => {
  const text = remediationFor('capacity', '/subscriptions/x/clusters/c');
  // The ONLY thing that unblocks THIS run is the live resource, changed
  // out-of-band — the .bicepparam lever #4126 built is durable but cannot take
  // effect here, because this preflight aborts before the apply (control
  // below). A remediation that names only template edits is naming things this
  // lane will never apply — which is the loop this whole section exists to
  // close.
  assert.match(
    text,
    /out-of-band/i,
    'the capacity remediation does not say the change has to happen OUT-OF-BAND on the live cluster — ' +
      'every in-repo lever is either non-existent or unappliable by this lane (BCP259 / preflight ordering)',
  );
  assert.match(
    text,
    /az kusto cluster update/,
    'the capacity remediation names no concrete out-of-band mechanism — deploy-integrity.md R6 wants the ' +
      'exact command or portal action, not "resolve it elsewhere"',
  );
});

test('CONTROL: the remediation may only name a .bicepparam lever the DEPLOYED template accepts', () => {
  const text = remediationFor('capacity', '/subscriptions/x/clusters/c');
  const { rel, src, declared } = paramTargetOf(LANE_PARAM_FILE);

  // POPULATION, twice over: the `using` target must resolve and must actually
  // declare parameters. Without this a typo in the path would make every branch
  // below vacuous and the control would pass on nothing.
  assert.ok(
    declared.size > 0,
    `${LANE_PARAM_FILE} targets '${rel}', which declares no params at all — this control has no population`,
  );

  // Does the message INSTRUCT the operator to set something in a .bicepparam?
  // Matched as a bounded window so the identifiers checked are the ones inside
  // the instruction, not every identifier the message happens to mention.
  const INSTRUCTION_RE =
    /\b(?:set|assign|add|put)\b[\s\S]{0,80}?\.bicepparam|\.bicepparam[\s\S]{0,80}?\b(?:set|assign|add|put)\b/gi;
  const instructions = text.match(INSTRUCTION_RE) ?? [];

  if (instructions.length > 0) {
    const inside = instructions.flatMap((w) => [...w.matchAll(IDENT_RE)].map((m) => m[1]));
    assert.ok(
      inside.length > 0,
      'the remediation tells the operator to set something in a .bicepparam but names no identifier, ' +
        'so there is nothing to check reachability against',
    );
    for (const ident of inside) {
      const root = ident.split('.')[0];
      assert.ok(
        declared.has(root),
        `the remediation tells the operator to set \`${ident}\` in a .bicepparam, but '${root}' is not ` +
          `declared on '${rel}' — the template ${LANE_PARAM_FILE} actually targets. Assigning it there ` +
          'fails to compile with BCP259; it does not change the SKU. This is the #4108 layer-hop: the ' +
          'identifier is real one layer down (admin-plane/main.bicep) and unreachable at the layer ' +
          'that is deployed.',
      );
    }
  }

  // THE CONVERSE, so this control keeps working after someone fixes the gap.
  // The day the root both declares adxConfig AND threads it into the adminPlane
  // module, a param-file lever genuinely exists and the message must name it
  // instead of saying there is none.
  const threaded = /\n\s*adxConfig:\s*\S/.test(src);
  if (declared.has('adxConfig') && threaded) {
    assert.ok(
      instructions.length > 0,
      `'${rel}' now declares adxConfig AND passes it to the adminPlane module, so the boundary ` +
        '.bicepparam IS a real SKU lever now — the capacity remediation still says there is no in-repo ' +
        'lever, and that is no longer true. Update the message.',
    );
  }
});

test('the CAPACITY remediation discloses that re-running this lane cannot apply the SKU change', () => {
  const text = remediationFor('capacity', '/subscriptions/x/clusters/c');
  // THE DEADLOCK. The preflight that prints this runs BEFORE what-if and before
  // the apply (control below), so "change a template value and re-run" dies at
  // the identical step, having applied nothing. A remediation that omits this
  // sends the operator round a loop that cannot terminate — and it is also why
  // the only lever that helps is one applied OUTSIDE the lane.
  assert.match(
    text,
    /before what-if|before the apply/i,
    'the capacity remediation does not disclose that this preflight aborts before the apply — so a ' +
      'reader can still conclude that changing a template value and re-running would take effect',
  );
});

test('CONTROL: adx-cluster.bicep’s skuName DEFAULT is dead — the caller always passes it', () => {
  // This is the premise of the message fix above. If someone later stops passing
  // skuName explicitly, adx-cluster.bicep's default becomes live again and the
  // remediation wording should be revisited — so this control goes red on that
  // change rather than letting the two drift apart silently.
  const mainBicep = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/main.bicep'),
    'utf8',
  );
  assert.match(
    mainBicep,
    /skuName:\s*effectiveAdxSkuName/,
    'admin-plane/main.bicep no longer passes skuName to the adx-cluster module',
  );
  assert.match(
    mainBicep,
    /var effectiveAdxSkuName\s*=/,
    'the effectiveAdxSkuName boundary guard is gone — the Gov SKU substitution this message describes no longer exists',
  );
});

test('CONTROL: the ADX preflight precedes what-if AND the apply on every deploy lane', () => {
  // The structural fact that makes the deadlock real, pinned per lane so a
  // future reorder cannot silently invalidate the remediation wording.
  //
  // PER-LANE, not `if (at === -1) continue`. The old shape skipped any reader it
  // could not find and only required 6 comparisons overall, which had two holes:
  // renaming a reader on one lane still left 6 and stayed green, and IL5's apply
  // step is called 'Teardown -> redeploy -> smoke', not 'Provision', so IL5's
  // APPLY was never ordering-checked at all — it was silently skipped as an
  // absence. Naming each lane's readers turns both into a red.
  const LANE_READERS = {
    'deploy-fiab-commercial': ['- name: Bicep what-if', '- name: Provision'],
    'deploy-fiab-gcc': ['- name: Bicep what-if', '- name: Provision'],
    'deploy-fiab-gcch': ['- name: Bicep what-if', '- name: Provision'],
    // IL5 has no step literally called 'Provision'; this is its apply.
    'deploy-fiab-il5': ['- name: Bicep what-if', '- name: Teardown -> redeploy -> smoke'],
  };
  let checkedReaders = 0;
  for (const [lane, readers] of Object.entries(LANE_READERS)) {
    const wf = fs.readFileSync(path.join(REPO_ROOT, `.github/workflows/${lane}.yml`), 'utf8');
    const preflight = wf.indexOf('- name: ADX preflight');
    assert.notEqual(preflight, -1, `${lane}: no ADX preflight step — this control has no population`);

    for (const reader of readers) {
      const at = wf.indexOf(reader);
      assert.notEqual(
        at,
        -1,
        `${lane}: expected step '${reader}' is gone. Either it was renamed — in which case this control ` +
          'stopped watching it — or the lane no longer previews/applies. Re-point it, do not delete it.',
      );
      checkedReaders += 1;
      assert.ok(
        preflight < at,
        `${lane}: '${reader}' appears BEFORE the ADX preflight — the preflight no longer gates it`,
      );
    }
  }
  // POPULATION, exact. The true count is 4 lanes x 2 readers. `>= 6` (the old
  // bound) had a free removal in it: dropping one lane's reader left 6 and
  // passed.
  assert.equal(checkedReaders, 8, `compared ${checkedReaders} preflight/reader pairs — expected exactly 8`);
});

test('CONTROL: only the ADX preflight imports remediationFor — its wording is ADX-specific', () => {
  // The capacity branch asserts 'this preflight runs BEFORE what-if and before
  // the apply'. That is true of ensure-adx-cluster-running.mjs and is NOT
  // guaranteed of any other caller, so a second importer would silently inherit
  // a claim that may be false for it. ensure-aas-server-settled.mjs already
  // declines to reuse this function for exactly that reason (see its comment)
  // and imports only classifyAzFailure/isRetryable — nothing pinned that until
  // now.
  const dir = path.join(REPO_ROOT, 'scripts/ci');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== '_az-failure-class.mjs');
  assert.ok(files.length > 0, 'no scripts/ci/*.mjs found — this control has no population');

  const importers = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const imported = src.match(/^import\s*\{([^}]*)\}\s*from\s*'\.\/_az-failure-class\.mjs'/m);
    if (imported && /\bremediationFor\b/.test(imported[1])) importers.push(f);
  }
  assert.deepEqual(
    importers,
    ['ensure-adx-cluster-running.mjs'],
    'the set of non-test importers of remediationFor changed. A NEW importer inherits ADX-specific ' +
      'wording (the what-if/apply ordering, the adxConfig/BCP259 explanation) that is not established ' +
      'for it — give it its own remediation, as ensure-aas-server-settled.mjs did. If the ADX preflight ' +
      'stopped importing it, the capacity message is now dead code.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 3 — A DELIBERATELY PAUSED ESTATE IS NOT A FAILURE
//
// deploy-fiab-gcch ran red for 17 consecutive runs after 2026-08-11, every one
// at the ADX preflight: `state=Stopped → start`, then
// `(InsufficientResourcesForSubscription)`. The estate is deliberately kept
// stopped under the pause/resume mandate, so the daily schedule was failing on a
// condition the operator chose.
//
// THE WHOLE RISK OF THIS CHANGE is that the fix becomes `if (state ===
// 'Stopped') skip` — a control that CANNOT FAIL, which would make a genuinely
// broken cluster read as fine forever on a P0 sovereign path. So the two tests
// that matter most are the two DIRECTIONS, and they are pinned separately and
// named for what they defend:
//
//   * `Stopped` WITHOUT a declaration must still ask for a start (→ the lane
//     still goes red on the capacity refusal). This is the test that dies if
//     anyone keys the suppression to the STATE.
//   * `Stopped` WITH a declaration must NOT start. This is the test that dies if
//     anyone drops the declaration and restores the old unconditional behaviour.
//
// A suppression whose verdict cannot move in BOTH directions is keyed to the
// wrong thing, and one of these two tests will say so.
// ─────────────────────────────────────────────────────────────────────────────

/** A register entry that satisfies every rule, so each test can break ONE thing. */
const VALID_REASON =
  'The GCC-High estate is deliberately held stopped under the estate pause mandate; '
  + 'resume it and delete this entry to measure the lane again.';
const validRegister = (over = {}) => ({
  paused: [{
    boundary: 'GCC-High',
    owner: 'fgarofalo56',
    declaredOn: '2026-08-26',
    reason: VALID_REASON,
    reviewBy: '2026-11-24',
    ...over,
  }],
});
const TODAY = '2026-08-26';

test('THE DIRECTION THAT MUST KEEP FAILING: Stopped with NO declaration still asks for a start', () => {
  // The undeclared estate is the whole reason this is not `if (stopped) skip`.
  // An operator who has NOT declared a pause is telling us nothing, and a
  // stopped cluster is then exactly the defect the preflight was written for.
  const pause = classifyPauseDeclaration({ register: null, boundary: 'GCC-High', today: TODAY });
  assert.equal(pause.declared, false, 'an absent register must never read as a declaration');

  const observed = classifyClusterState('Stopped');
  assert.equal(observed.action, 'start');
  const verdict = reconcileWithDeclaredPause({ action: observed.action, state: 'Stopped', declared: pause.declared });
  assert.equal(verdict.action, 'start', 'an UNDECLARED stopped cluster must still be started — and fail the lane when Azure refuses');
  assert.equal(verdict.note, null);
});

test('THE DIRECTION THAT MUST BE SUPPRESSED: Stopped WITH a declaration is `paused`, not `start`', () => {
  const pause = classifyPauseDeclaration({ register: validRegister(), boundary: 'GCC-High', today: TODAY });
  assert.equal(pause.declared, true, pause.reason);

  const verdict = reconcileWithDeclaredPause({ action: 'start', state: 'Stopped', declared: pause.declared });
  assert.equal(verdict.action, 'paused', 'a DECLARED-paused estate must not be started and must not fail');
  assert.match(verdict.note, /NOT starting it/);
});

test('a declaration for ANOTHER boundary does not cover this one', () => {
  // One boundary's pause must never silence a different boundary's deploy.
  const reg = validRegister({ boundary: 'IL5' });
  const pause = classifyPauseDeclaration({ register: reg, boundary: 'GCC-High', today: TODAY });
  assert.equal(pause.declared, false);
  assert.match(pause.reason, /not declared paused/);
  assert.match(pause.reason, /IL5/, 'the message must name what IS declared, so a typo is diagnosable');
});

test('declared paused + a RUNNING cluster is reported as an INCONSISTENCY, and still proceeds', () => {
  // A live cluster is precisely what the apply needs, so this must not fail —
  // but "declared down, observed up" is a real finding and is never silent.
  const verdict = reconcileWithDeclaredPause({ action: 'none', state: 'Running', declared: true });
  assert.equal(verdict.action, 'none', 'a running cluster must not be turned into a failure');
  assert.match(verdict.note, /INCONSISTENCY/);
});

test('a pause declaration does NOT excuse a cluster in a REFUSE state', () => {
  // The #3980 PAUSE_STATES lesson, restated: folding every non-Running state
  // into "paused" converts a genuine defect into a silent skip. A declaration
  // says the engine is deliberately DOWN; it says nothing about Deleting.
  for (const state of ['Unavailable', 'Deleting', 'Deleted', 'SomethingNew']) {
    const observed = classifyClusterState(state);
    assert.equal(observed.action, 'refuse', `${state} should be refuse`);
    const verdict = reconcileWithDeclaredPause({ action: observed.action, state, declared: true });
    assert.equal(verdict.action, 'refuse', `a declaration must not excuse '${state}'`);
  }
});

test('EVERY uncertain register outcome resolves to NOT-declared', () => {
  // The asymmetry #3980 established, applied to a register. Suppressing is the
  // dangerous direction, so it takes positive evidence; "I could not tell" must
  // never become "it is paused, stand down". Each case also has to SAY why, or
  // an operator who believes they declared a pause cannot find out otherwise.
  const cases = [
    ['null register', { register: null, boundary: 'GCC-High', today: TODAY }, /no .* was readable/],
    ['register is an array', { register: [], boundary: 'GCC-High', today: TODAY }, /not a JSON object/],
    ['no paused array', { register: { paused: 'yes' }, boundary: 'GCC-High', today: TODAY }, /no `paused` array/],
    ['boundary missing', { register: validRegister(), boundary: '', today: TODAY }, /no boundary was supplied/],
    ['today not a date', { register: validRegister(), boundary: 'GCC-High', today: 'now' }, /not an ISO date/],
    ['no owner', { register: validRegister({ owner: '' }), boundary: 'GCC-High', today: TODAY }, /names no `owner`/],
    ['thin reason', { register: validRegister({ reason: 'paused' }), boundary: 'GCC-High', today: TODAY }, /minimum 60/],
    ['placeholder reason', { register: validRegister({ reason: `TODO ${VALID_REASON}` }), boundary: 'GCC-High', today: TODAY }, /placeholder/],
    ['reviewBy malformed', { register: validRegister({ reviewBy: 'soon' }), boundary: 'GCC-High', today: TODAY }, /not an ISO date/],
    ['reviewBy EXPIRED', { register: validRegister({ reviewBy: '2026-08-25' }), boundary: 'GCC-High', today: TODAY }, /EXPIRED/],
  ];
  for (const [label, input, messagePattern] of cases) {
    const got = classifyPauseDeclaration(input);
    assert.equal(got.declared, false, `${label} must NOT suppress`);
    assert.match(got.reason, messagePattern, `${label} must say why it did not suppress`);
  }
  // POPULATION: the same builder with nothing broken MUST declare, or every row
  // above is passing for the trivial reason that nothing can ever declare.
  assert.equal(
    classifyPauseDeclaration({ register: validRegister(), boundary: 'GCC-High', today: TODAY }).declared,
    true,
    'the unbroken control case must declare — otherwise this test has no population',
  );
});

test('the expiry actually expires: the SAME entry declares before reviewBy and not after', () => {
  // The teeth. A pause that never lapses is how a lane stays dark for months
  // while every dashboard reads green (deploy-integrity.md R3).
  const reg = validRegister({ reviewBy: '2026-11-24' });
  assert.equal(classifyPauseDeclaration({ register: reg, boundary: 'GCC-High', today: '2026-11-24' }).declared, true, 'valid ON the review date');
  assert.equal(classifyPauseDeclaration({ register: reg, boundary: 'GCC-High', today: '2026-11-25' }).declared, false, 'expired the day AFTER');
});

test('the SHIPPED register is structurally valid', () => {
  // Deliberately NOT asserting non-expiry against the real clock: the expiry is
  // meant to re-red the deploy LANE, not to turn main's unit suite red on a
  // date. The lapse behaviour is pinned above with fixed dates instead.
  const file = path.join(REPO_ROOT, PAUSE_DECLARATION_PATH);
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(reg.paused), `${PAUSE_DECLARATION_PATH} must carry a \`paused\` array`);
  for (const e of reg.paused) {
    assert.match(e.boundary, /^(Commercial|GCC|GCC-High|IL5)$/, `unknown boundary '${e.boundary}'`);
    assert.ok(e.owner && e.owner.trim(), `${e.boundary} needs an owner`);
    assert.ok(e.reason.trim().length >= MIN_REASON_CHARS, `${e.boundary}'s reason is too thin`);
    assert.match(e.reviewBy, /^\d{4}-\d{2}-\d{2}$/, `${e.boundary} needs an ISO reviewBy`);
    assert.match(e.declaredOn, /^\d{4}-\d{2}-\d{2}$/, `${e.boundary} needs an ISO declaredOn`);
    assert.ok(e.reviewBy > e.declaredOn, `${e.boundary}'s reviewBy must be after declaredOn`);
    // Declared on its OWN declaredOn date — proves the shipped entry is one the
    // classifier accepts, not merely one that parses.
    assert.equal(
      classifyPauseDeclaration({ register: reg, boundary: e.boundary, today: e.declaredOn }).declared,
      true,
      `${e.boundary}'s shipped entry is rejected by the classifier`,
    );
  }
});

test('CONTROL: the gcch lane passes --boundary and stands down on the verdict', () => {
  // The script half is inert without the YAML half. Without `--boundary` the
  // register can never match; without the `estate_paused` gates the preflight
  // exits 0 straight into the identical ClusterNotValidForPrincipals refusal at
  // what-if and at the apply. Both are pinned so neither can be dropped quietly.
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-fiab-gcch.yml'), 'utf8');
  assert.match(wf, /id: adx_preflight/, 'the preflight needs an id for its output to be referenced');
  assert.match(wf, /--boundary "\$CSA_LOOM_BOUNDARY"/, 'the lane must pass its boundary or no declaration can apply');
  assert.match(wf, /estate_paused: \$\{\{ steps\.adx_preflight\.outputs\.estate_paused \}\}/, 'the job must publish the verdict');
  assert.match(wf, /needs\.deploy-validate\.outputs\.estate_paused != 'true'/, 'the chained bootstrap must stand down too');

  // POPULATION + REACHABILITY: count the step-level gates rather than matching
  // once. A single `!= 'true'` somewhere in a 1300-line file would satisfy a
  // bare regex while what-if or the apply ran on regardless.
  const stepGates = wf.match(/steps\.adx_preflight\.outputs\.estate_paused != 'true'/g) ?? [];
  assert.ok(
    stepGates.length >= 3,
    `expected at least 3 step-level estate_paused gates (what-if, provision, front-door), found ${stepGates.length}`,
  );
});

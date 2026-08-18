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
 * MUTATION-PROVEN (measured 2026-08-18, 23 tests, 23 pass / 0 skip at baseline):
 *
 *   A. widen ABSENCE_CODES to also swallow 'AuthorizationFailed' (i.e. treat an
 *      RBAC denial as greenfield — the exact R7 collapse)
 *        → 1 RED: "an RBAC denial is UNKNOWN, never greenfield"
 *   B. derive an address for a Static endpoint that reports none, instead of
 *      refusing
 *        → 1 RED: "a Static endpoint that reports NO address REFUSES rather
 *                  than deriving one"
 *   C. make classifyClusterState's default branch return {action:'start'}
 *      instead of refusing
 *        → 1 RED: "an unrecognised state REFUSES rather than guessing"
 *   D. make evaluatePoll return ok:true on budget exhaustion
 *        → 1 RED: "an exhausted budget is a FAILURE, not a pass"
 *   E. make network.bicep stop reading the parameter (back to a hard-coded
 *      literal) — the "resolver runs, nothing consumes it" shape
 *        → 1 RED: "CONTROL: the bicep resource keys BOTH branches off the SAME
 *                  parameter"
 *
 * Every file restored byte-identical afterwards (`git diff --stat` empty).
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
  evaluatePoll,
  DEFAULT_TIMEOUT_SECONDS,
} from '../ensure-adx-cluster-running.mjs';

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

// ── 2. ADX cluster state ────────────────────────────────────────────────────

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

// ── 3. CONTROLS — these must stay GREEN under every mutation above ──────────

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

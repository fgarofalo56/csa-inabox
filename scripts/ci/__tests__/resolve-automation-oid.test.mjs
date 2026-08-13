/**
 * resolve-automation-oid self-test (#3373).
 *
 * THE DEFECT BEING GUARDED
 * ------------------------
 * Six workflows read `vars.LOOM_AUTOMATION_OID` with no fallback, and nothing
 * in this repo could ever write that variable — `gh variable set` appears
 * nowhere in the tree. The verification lane that produces every browser-E2E
 * receipt was therefore gated on a hand-typed value.
 *
 * WHAT THIS SUITE HAS TO PROVE, BEYOND "the happy path resolves"
 * --------------------------------------------------------------
 * Three properties, and the last two are the teeth:
 *
 *   1. Precedence is what the header claims (explicit > derived > carried).
 *   2. A value that would mint a session and then 403 on every admin route is
 *      REJECTED WITH ITS REASON, not silently used. A comma list and a
 *      non-GUID both read as configured and match nobody — those are the
 *      shapes that shipped the #3109 outage.
 *   3. A read that DID NOT COMPLETE is never reported as a missing binding.
 *      deploy-integrity.md R7: a denied or transient az call means the value is
 *      UNKNOWN. A refusal that says "the console has no OID bound" on the
 *      strength of a 403 sends the next investigation at the deploy instead of
 *      at RBAC — the exact failure recorded in
 *      `csa_loom_unknown_as_negative_class`.
 *
 * Run: node --test scripts/ci/__tests__/resolve-automation-oid.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUID_RE,
  BINDING_VAR,
  validateCandidate,
  classifyAzFailure,
  decide,
  refusal,
  pickBinding,
} from '../resolve-automation-oid.mjs';

const OID_A = '866a2e12-0fee-4c99-923c-7cdfd61e08cd';
const OID_B = '11111111-2222-3333-4444-555555555555';

// ─────────────────────────── candidate validation ───────────────────────────

test('a single GUID is accepted, with surrounding whitespace and CR stripped', () => {
  const v = validateCandidate(`  ${OID_A}\r\n`);
  assert.equal(v.ok, true);
  assert.equal(v.value, OID_A);
  assert.match(v.value, GUID_RE);
});

test('a comma-separated list is REJECTED and the reason names strict equality', () => {
  const v = validateCandidate(`${OID_A},${OID_B}`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'comma-list');
  // The whole point: isTenantAdmin compares the WHOLE string with ===.
  assert.match(v.why, /strict equality|===/);
});

test('a non-GUID is REJECTED rather than passed through as an identity', () => {
  for (const bad of ['loom-verify@automation', 'not-a-guid', '866a2e12']) {
    const v = validateCandidate(bad);
    assert.equal(v.ok, false, `${bad} must not validate`);
    assert.equal(v.code, 'not-a-guid');
  }
});

test('empty / undefined are their own class, not "invalid"', () => {
  assert.equal(validateCandidate('').code, 'empty');
  assert.equal(validateCandidate(undefined).code, 'empty');
  assert.equal(validateCandidate('   ').code, 'empty');
});

// ───────────────────────────── az classification ────────────────────────────

test('az failures classify into transient / denied / notfound / unknown', () => {
  assert.equal(classifyAzFailure('(429) Too Many Requests'), 'transient');
  assert.equal(classifyAzFailure('ServiceUnavailable'), 'transient');
  assert.equal(
    classifyAzFailure("AuthorizationFailed: The client does not have authorization to perform action"),
    'denied',
  );
  assert.equal(classifyAzFailure('ResourceNotFound: the Resource was not found'), 'notfound');
  // The important one: an unrecognised failure must NOT be optimistically
  // bucketed as "not found", which would read as a measured absence.
  assert.equal(classifyAzFailure('some novel az explosion'), 'unknown');
  assert.equal(classifyAzFailure(''), 'unknown');
});

// ─────────────────────────────── precedence ─────────────────────────────────

test('the derived binding is used when no explicit override is set', () => {
  const r = decide({ derived: { status: 'resolved', value: OID_A } });
  assert.equal(r.ok, true);
  assert.equal(r.oid, OID_A);
  assert.equal(r.source, `derived:${BINDING_VAR}`);
  assert.deepEqual(r.warnings, []);
});

test('an explicit repo var overrides the derived value (the override is retained)', () => {
  const r = decide({ explicit: OID_B, derived: { status: 'resolved', value: OID_A } });
  assert.equal(r.ok, true);
  assert.equal(r.oid, OID_B);
  assert.equal(r.source, 'explicit-override');
});

test('an override that DISAGREES with the console is honoured but warned about', () => {
  const r = decide({ explicit: OID_B, derived: { status: 'resolved', value: OID_A } });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /DISAGREES/);
  // The warning has to say what the consequence is, or it is noise.
  assert.match(r.warnings[0], /403/);
});

test('an override that AGREES with the console produces no warning', () => {
  const r = decide({ explicit: OID_A.toUpperCase(), derived: { status: 'resolved', value: OID_A } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [], 'GUID case must not be reported as drift');
});

test('an unusable explicit override FAILS rather than falling through to the derived value', () => {
  // Falling through would make a typo in repo settings invisible, and the run
  // would then pass while asserting an identity the operator never chose.
  const r = decide({ explicit: `${OID_A},${OID_B}`, derived: { status: 'resolved', value: OID_A } });
  assert.equal(r.ok, false);
  assert.match(r.error, /comma-separated list|strict equality/);
  assert.match(r.error, /REMOVE the LOOM_AUTOMATION_OID repo variable/);
});

test('carry-forward is a LAST resort and is announced as possibly stale', () => {
  const r = decide({ derived: { status: 'denied' }, carried: OID_A });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'carried-forward:live-job');
  assert.match(r.warnings.join(' '), /stale/i);
});

test('carry-forward never beats a derived value', () => {
  const r = decide({ derived: { status: 'resolved', value: OID_A }, carried: OID_B });
  assert.equal(r.oid, OID_A);
  assert.equal(r.source, `derived:${BINDING_VAR}`);
});

test('an unusable carried value is ignored, said so, and does not rescue the run', () => {
  const r = decide({ derived: { status: 'empty' }, carried: 'garbage' });
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(' '), /unusable/);
});

// ──────────────────── R7: unknown is never reported as absent ───────────────

test('a DENIED read refuses as UNKNOWN and blames RBAC, never the deploy binding', () => {
  const msg = refusal({ status: 'denied' });
  assert.match(msg, /unknown, not absent/);
  assert.match(msg, /Reader/);
  assert.match(msg, /Nothing about the binding itself has been established/);
  assert.doesNotMatch(msg, /has no tenant-admin OID bound/);
});

test('a TRANSIENT read refuses as UNKNOWN, never as absent', () => {
  const msg = refusal({ status: 'transient' });
  assert.match(msg, /unknown, not absent/);
  assert.doesNotMatch(msg, /has no tenant-admin OID bound/);
});

test('an UNCLASSIFIED failure refuses as UNKNOWN, never as absent', () => {
  const msg = refusal({ status: 'unknown' });
  assert.match(msg, /unknown, not absent/);
  assert.doesNotMatch(msg, /has no tenant-admin OID bound/);
});

test('an EMPTY binding is a MEASURED absence and points the fix at the DEPLOY', () => {
  const msg = refusal({ status: 'empty' });
  assert.match(msg, /FIX THE DEPLOY/);
  assert.match(msg, /FIAB_TENANT_ADMIN_OID/);
  // And it must pre-empt the wrong fix: binding the group does not help a
  // minted session, because it carries no `groups` claim.
  assert.match(msg, /LOOM_TENANT_ADMIN_GROUP_ID will NOT fix this/);
});

test('every refusal states that the workflow will not guess an identity', () => {
  for (const status of ['empty', 'absent', 'secretref', 'denied', 'transient', 'unknown', 'app-not-found', 'ambiguous', 'no-target']) {
    assert.match(refusal({ status }), /will\s+not guess an identity/, `status=${status}`);
  }
});

test('no refusal is a bare failure — each carries a concrete remediation (R6)', () => {
  for (const status of ['empty', 'absent', 'secretref', 'denied', 'transient', 'unknown', 'app-not-found', 'ambiguous', 'no-target']) {
    const msg = refusal({ status });
    assert.ok(msg.length > 200, `status=${status} produced a too-thin message`);
    assert.match(msg, /re-?dispatch|re-run the deploy|Pass admin_rg|Supply CONSOLE_RG|Grant the workflow|re-deploy/i, `status=${status}`);
  }
});

// ────────────────────────── binding extraction ──────────────────────────────

test('the binding is found in ANY container, not just containers[0]', () => {
  const r = pickBinding([
    [{ name: 'OTHER', value: 'x' }],
    [{ name: BINDING_VAR, value: OID_A }],
  ]);
  assert.deepEqual(r, { status: 'resolved', value: OID_A });
});

test('a present-but-empty binding is "empty", which is a different fix from "absent"', () => {
  assert.equal(pickBinding([[{ name: BINDING_VAR, value: '' }]]).status, 'empty');
  assert.equal(pickBinding([[{ name: 'SOMETHING_ELSE', value: 'x' }]]).status, 'absent');
  assert.equal(pickBinding([]).status, 'absent');
});

test('a secretRef binding is reported as such — this tool does not read secrets', () => {
  assert.equal(pickBinding([[{ name: BINDING_VAR, secretRef: 'admin-oid' }]]).status, 'secretref');
});

test('pickBinding tolerates a malformed template rather than throwing', () => {
  assert.equal(pickBinding(null).status, 'absent');
  assert.equal(pickBinding([null, undefined]).status, 'absent');
});

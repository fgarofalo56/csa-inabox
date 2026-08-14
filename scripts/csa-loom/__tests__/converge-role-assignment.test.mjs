import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalGuid,
  decide,
  parseArgs,
  run,
  shortName,
  uuidVersion,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  EXIT_UNREADABLE,
} from '../converge-role-assignment.mjs';

// ── THE REAL PAYLOAD ─────────────────────────────────────────────────────────
// Verbatim from deploy-fiab-commercial run 31780698652 (2026-08-14). The stray
// ARM named, and the name the template computed for the same triple.
const STRAY_UNDASHED = '0a2b7dc58eb449709418694f83a6c164';
const STRAY_DASHED = '0a2b7dc5-8eb4-4970-9418-694f83a6c164';
const TEMPLATE_NAME = '54ecee13-3330-50e1-9ba9-314abdca3540';

const DIRECTLAKE_PRINCIPAL = '11111111-2222-3333-4444-555555555555';
const ACR_SCOPE =
  '/subscriptions/99999999-8888-7777-6666-555555555555/resourceGroups/rg-csa-loom-admin-centralus' +
  '/providers/Microsoft.ContainerRegistry/registries/acrloomk6mvh5sm6z7do';

function strayAssignment(over = {}) {
  return {
    id: `${ACR_SCOPE}/providers/Microsoft.Authorization/roleAssignments/${STRAY_DASHED}`,
    name: STRAY_DASHED,
    scope: ACR_SCOPE,
    principalId: DIRECTLAKE_PRINCIPAL,
    principalType: 'ServicePrincipal',
    roleDefinitionId:
      '/subscriptions/99999999-8888-7777-6666-555555555555/providers/Microsoft.Authorization' +
      '/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d',
    ...over,
  };
}

const okList = (assignments) => () => ({ status: 0, assignments, error: '' });
const okIds = (principalIds) => () => ({ status: 0, principalIds, error: '' });

// ── NAME NORMALISATION ───────────────────────────────────────────────────────

test('the 32-char form ARM prints and the dashed form the API returns are the SAME assignment', () => {
  assert.equal(canonicalGuid(STRAY_UNDASHED), STRAY_DASHED);
  assert.equal(canonicalGuid(STRAY_DASHED), STRAY_DASHED);
  assert.equal(canonicalGuid(STRAY_UNDASHED.toUpperCase()), STRAY_DASHED);
});

test('anything that is not a GUID is not normalised into one', () => {
  for (const bad of ['', null, undefined, 'not-a-guid', `${STRAY_UNDASHED}ff`, '../../etc/passwd']) {
    assert.equal(canonicalGuid(bad), null, `${JSON.stringify(bad)} must not normalise`);
  }
});

test('EMBEDDED CONTROL: the measured stray is a v4 and the measured template name is a v5', () => {
  // This is the discriminator that identifies the generator: ARM `guid()` emits
  // name-based v5 GUIDs (all 15 role-assignment names in that run's what-if
  // output are v5), while `az role assignment create` with no --name mints a
  // random v4. If this control ever flips, the story in the header is wrong and
  // the fix should be re-derived rather than trusted.
  assert.equal(uuidVersion(STRAY_UNDASHED), 4);
  assert.equal(uuidVersion(TEMPLATE_NAME), 5);
});

test('shortName keeps enough of the name to correlate and never emits a whole GUID', () => {
  const s = shortName(STRAY_UNDASHED);
  assert.equal(s, '0a2b7dc5…');
  assert.doesNotMatch(s, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

// ── THE DECISION ─────────────────────────────────────────────────────────────

test('the measured collision is converged: the stray is identified and marked for delete', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment(), strayAssignment({ name: TEMPLATE_NAME, id: 'other' })]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL, '00000000-0000-0000-0000-000000000001']),
  });
  assert.equal(v.action, 'delete');
  assert.equal(v.exit, EXIT_OK);
  assert.match(v.assignmentId, new RegExp(STRAY_DASHED));
});

test('an UNREADABLE control plane is never treated as an empty one', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: () => ({ status: 1, assignments: null, error: 'AuthorizationFailed' }),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_UNREADABLE);
  assert.match(v.reason, /could not be READ/);
});

test('a successful read that does not contain the name asserts only what it read', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment({ name: TEMPLATE_NAME })]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
  assert.match(v.reason, /not asserted to be absent from the/);
});

test('a USER or GROUP grant is never deleted, and neither is one whose type Azure did not report', () => {
  for (const principalType of ['User', 'Group', undefined, null, '']) {
    const v = decide({
      assignmentName: STRAY_UNDASHED,
      listAssignments: okList([strayAssignment({ principalType })]),
      listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    });
    assert.equal(v.action, 'none', `principalType ${JSON.stringify(principalType)} must refuse`);
    assert.equal(v.exit, EXIT_REFUSED);
  }
});

test('a service principal that is NOT a Loom managed identity is left alone', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment()]),
    listIdentities: okIds(['00000000-0000-0000-0000-000000000009']),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
  assert.match(v.reason, /NOT a user-assigned managed identity/);
});

test('an unreadable identity list refuses rather than assuming ownership', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment()]),
    listIdentities: () => ({ status: 1, principalIds: null, error: 'throttled' }),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_UNREADABLE);
});

test('a non-GUID --assignment-name is a usage error, and nothing is read or deleted', () => {
  let reads = 0;
  const v = decide({
    assignmentName: 'whatever-arm-said',
    listAssignments: () => {
      reads += 1;
      return { status: 0, assignments: [], error: '' };
    },
    listIdentities: okIds([]),
  });
  assert.equal(v.exit, EXIT_USAGE);
  assert.equal(reads, 0, 'a name that was never established must not even trigger a read');
});

// ── THE PROCESS: delete, then PROVE the delete landed ────────────────────────

/** A scripted `az` that records every invocation. */
function fakeAz(script) {
  const calls = [];
  const az = (argv) => {
    calls.push(argv.join(' '));
    for (const [match, res] of script) if (argv.join(' ').includes(match)) return res;
    throw new Error(`unscripted az call: ${argv.join(' ')}`);
  };
  return { az, calls };
}

const LIST_WITH_STRAY = { status: 0, stdout: JSON.stringify([strayAssignment()]), stderr: '' };
const LIST_WITHOUT = { status: 0, stdout: '[]', stderr: '' };
const IDS_OK = { status: 0, stdout: JSON.stringify([DIRECTLAKE_PRINCIPAL]), stderr: '' };

test('without --apply it reports and deletes NOTHING', () => {
  const { az, calls } = fakeAz([
    ['role assignment list', LIST_WITH_STRAY],
    ['identity list', IDS_OK],
  ]);
  const lines = [];
  const code = run(['--assignment-name', STRAY_UNDASHED], { az, log: (s) => lines.push(s) });
  assert.equal(code, EXIT_OK);
  assert.equal(calls.filter((c) => c.includes('delete')).length, 0);
  assert.match(lines.join('\n'), /dry run/);
});

test('with --apply it deletes and then RE-READS to prove the assignment is gone', () => {
  let listCall = 0;
  const calls = [];
  const az = (argv) => {
    const joined = argv.join(' ');
    calls.push(joined);
    if (joined.includes('role assignment list')) {
      listCall += 1;
      return listCall === 1 ? LIST_WITH_STRAY : LIST_WITHOUT;
    }
    if (joined.includes('identity list')) return IDS_OK;
    if (joined.includes('role assignment delete')) return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unscripted: ${joined}`);
  };
  const lines = [];
  const code = run(['--assignment-name', STRAY_UNDASHED, '--apply'], { az, log: (s) => lines.push(s) });
  assert.equal(code, EXIT_OK);
  assert.equal(calls.filter((c) => c.includes('role assignment delete')).length, 1);
  assert.equal(listCall, 2, 'the delete must be VERIFIED by a second read, not trusted');
  assert.match(lines.join('\n'), /converged/);
});

test('MUTATION: a delete that exits 0 but leaves the assignment in place FAILS', () => {
  // `az role assignment delete` exits 0 on a no-op. If the verdict were taken
  // from the exit code, this case would report "converged" and the retry would
  // fail identically — the exact class deploy-integrity R7 forbids.
  const az = (argv) => {
    const joined = argv.join(' ');
    if (joined.includes('role assignment list')) return LIST_WITH_STRAY; // never disappears
    if (joined.includes('identity list')) return IDS_OK;
    if (joined.includes('role assignment delete')) return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unscripted: ${joined}`);
  };
  const lines = [];
  const code = run(['--assignment-name', STRAY_UNDASHED, '--apply'], { az, log: (s) => lines.push(s) });
  assert.equal(code, EXIT_REFUSED, 'a delete that did not delete must not read as converged');
  assert.match(lines.join('\n'), /STILL present/);
});

test('a delete that FAILS is reported as unchanged, never as converged', () => {
  const az = (argv) => {
    const joined = argv.join(' ');
    if (joined.includes('role assignment list')) return LIST_WITH_STRAY;
    if (joined.includes('identity list')) return IDS_OK;
    if (joined.includes('role assignment delete')) return { status: 1, stdout: '', stderr: 'AuthorizationFailed' };
    throw new Error(`unscripted: ${joined}`);
  };
  const lines = [];
  const code = run(['--assignment-name', STRAY_UNDASHED, '--apply'], { az, log: (s) => lines.push(s) });
  assert.equal(code, EXIT_REFUSED);
  assert.match(lines.join('\n'), /the delete FAILED/);
});

test('the subscription flows through to every az read and to the delete path', () => {
  const { az, calls } = fakeAz([
    ['role assignment list', LIST_WITH_STRAY],
    ['identity list', IDS_OK],
  ]);
  run(['--assignment-name', STRAY_UNDASHED, '--subscription', 'sub-a'], { az, log: () => {} });
  assert.ok(
    calls.every((c) => c.includes('--subscription sub-a')),
    `every read must be scoped to the named subscription: ${calls.join(' | ')}`,
  );
});

test('subscription ids never reach the output', () => {
  const { az } = fakeAz([
    ['role assignment list', LIST_WITH_STRAY],
    ['identity list', IDS_OK],
  ]);
  const lines = [];
  run(['--assignment-name', STRAY_UNDASHED], { az, log: (s) => lines.push(s) });
  assert.doesNotMatch(lines.join('\n'), /99999999-8888-7777-6666-555555555555/);
});

test('an unknown argument is a usage error rather than a silently ignored flag', () => {
  assert.throws(() => parseArgs(['--not-a-flag']), /unknown argument/);
  assert.equal(run(['--not-a-flag'], { az: () => assert.fail('must not run az'), log: () => {} }), EXIT_USAGE);
  assert.equal(run([], { az: () => assert.fail('must not run az'), log: () => {} }), EXIT_USAGE);
});

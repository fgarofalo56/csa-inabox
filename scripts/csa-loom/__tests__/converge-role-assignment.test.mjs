import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalGuid,
  decide,
  ownerResourceId,
  parseArgs,
  run,
  shortName,
  subscriptionOf,
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
const okSp = (principal) => () => ({ status: 0, principal, error: '' });
const okSubs = (subscriptionIds) => () => ({ status: 0, subscriptionIds, error: '' });

// ── THE #4037 PAYLOAD ────────────────────────────────────────────────────────
// A Data Factory's SYSTEM-assigned identity, granted Key Vault Secrets User on
// the Loom vault (modules/admin-plane/adf-keyvault-rbac.bicep). The shape is
// CROSS-SUBSCRIPTION on purpose: the factory lives in a landing-zone RG in a
// different subscription from the vault the assignment is scoped to, which is
// the case #4041 actually deploys and the case a same-subscription bound would
// have wrongly refused.
const ADMIN_SUB = '99999999-8888-7777-6666-555555555555';
const DLZ_SUB = '88888888-7777-6666-5555-444444444444';
const ADF_PRINCIPAL = '77777777-6666-5555-4444-333333333333';
const ADF_RESOURCE_ID =
  `/subscriptions/${DLZ_SUB}/resourcegroups/rg-csa-loom-dlz-centralus` +
  '/providers/Microsoft.DataFactory/factories/adf-loom-dlz-centralus';
const VAULT_SCOPE =
  `/subscriptions/${ADMIN_SUB}/resourceGroups/rg-csa-loom-admin-centralus` +
  '/providers/Microsoft.KeyVault/vaults/kv-loom-centralus';

/** The blocking assignment ARM names when the hand-made KV grant already exists. */
function adfVaultAssignment(over = {}) {
  return {
    id: `${VAULT_SCOPE}/providers/Microsoft.Authorization/roleAssignments/${STRAY_DASHED}`,
    name: STRAY_DASHED,
    scope: VAULT_SCOPE,
    principalId: ADF_PRINCIPAL,
    principalType: 'ServicePrincipal',
    roleDefinitionId:
      `/subscriptions/${ADMIN_SUB}/providers/Microsoft.Authorization` +
      '/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6',
    ...over,
  };
}

/** What Entra returns for a system-assigned managed identity. */
const ADF_SYSTEM_ASSIGNED_SP = {
  servicePrincipalType: 'ManagedIdentity',
  alternativeNames: ['isExplicit=False', ADF_RESOURCE_ID],
};

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

test('a service principal that is NOT a managed identity at all is left alone', () => {
  // Not in `az identity list` AND the directory reports it as an application —
  // i.e. a foreign principal. This is the refusal #4037 kept intact.
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment()]),
    listIdentities: okIds(['00000000-0000-0000-0000-000000000009']),
    describePrincipal: okSp({ servicePrincipalType: 'Application', alternativeNames: [] }),
    listSubscriptions: okSubs([ADMIN_SUB]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
  assert.match(v.reason, /directory type is "Application"/);
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

// ── #4037: A SYSTEM-ASSIGNED MANAGED IDENTITY IS A MANAGED IDENTITY ──────────
// `az identity list` enumerates USER-assigned identities only, so before this
// the ADF → Key Vault grant reached the "foreign service principal" refusal and
// the deploy stayed wedged on a failure the platform can fix.

test('#4037 REGRESSION: the ADF system-assigned KV grant is converged, cross-subscription', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    // The factory's principal is structurally absent from `az identity list`.
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp(ADF_SYSTEM_ASSIGNED_SP),
    listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
  });
  assert.equal(v.action, 'delete', v.reason);
  assert.equal(v.exit, EXIT_OK);
  assert.equal(v.identityKind, 'resource-owned');
  assert.match(v.assignmentId, new RegExp(STRAY_DASHED));
});

test('#4037 CONTROL: the owner subscription bound is LOAD-BEARING — an unreachable owner is REFUSED', () => {
  // Same principal, same directory answer; only the reachable subscription set
  // changes. If this does not flip the verdict, the bound is decorative.
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp(ADF_SYSTEM_ASSIGNED_SP),
    listSubscriptions: okSubs([ADMIN_SUB]), // the DLZ sub is NOT reachable
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
  assert.match(v.reason, /NOT in any subscription these credentials can reach/);
});

test('#4037 CONTROL: an unrelated tenant-mate system-assigned MI is REFUSED', () => {
  // A ManagedIdentity, correctly typed by the directory, owned by a VM in a
  // subscription this deployment cannot see. "Extend the proof, do not relax
  // it": widening to "any ManagedIdentity" would delete this one.
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp({
      servicePrincipalType: 'ManagedIdentity',
      alternativeNames: [
        'isExplicit=False',
        '/subscriptions/12121212-3434-5656-7878-909090909090/resourcegroups/rg-someone-else' +
          '/providers/Microsoft.Compute/virtualMachines/vm-not-ours',
      ],
    }),
    listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
});

test('the assignment OWN subscription is always reachable, even if az account list omits it', () => {
  // A same-subscription system-assigned MI (the simple case) must converge on
  // the strength of the assignment's own scope, not on the CLI profile.
  const sameSubOwner =
    `/subscriptions/${ADMIN_SUB}/resourcegroups/rg-csa-loom-admin-centralus` +
    '/providers/Microsoft.DataFactory/factories/adf-loom-default-centralus';
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp({ servicePrincipalType: 'ManagedIdentity', alternativeNames: ['isExplicit=False', sameSubOwner] }),
    listSubscriptions: okSubs([]), // profile knows nothing
  });
  assert.equal(v.action, 'delete', v.reason);
  assert.equal(v.exit, EXIT_OK);
});

test('an UNREADABLE directory is EXIT_UNREADABLE and names the role to grant — never "foreign"', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: () => ({ status: 1, principal: null, error: 'Insufficient privileges to complete the operation' }),
    listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_UNREADABLE, 'an unreadable directory is not an absent one');
  assert.match(v.reason, /Directory Readers/);
});

test('an UNREADABLE subscription list is EXIT_UNREADABLE, never an accepted owner', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp(ADF_SYSTEM_ASSIGNED_SP),
    listSubscriptions: () => ({ status: 1, subscriptionIds: null, error: 'Please run az login' }),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_UNREADABLE);
});

test('FAIL-CLOSED DEFAULT: a caller that supplies no resolvers can never reach "delete"', () => {
  // The single most dangerous regression shape here is a resolver defaulting to
  // "absent" and the absence reading as "fine". Omitting both must refuse to
  // establish anything.
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_UNREADABLE);
});

test('a ManagedIdentity whose owning resource the directory does not name is REFUSED', () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp({ servicePrincipalType: 'ManagedIdentity', alternativeNames: ['isExplicit=False'] }),
    listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
  });
  assert.equal(v.action, 'none');
  assert.equal(v.exit, EXIT_REFUSED);
  assert.match(v.reason, /no owning Azure resource id/);
});

test('a Legacy or untyped directory object is REFUSED, not assumed to be a managed identity', () => {
  for (const servicePrincipalType of ['Legacy', 'SocialIdp', undefined, null, '']) {
    const v = decide({
      assignmentName: STRAY_UNDASHED,
      listAssignments: okList([adfVaultAssignment()]),
      listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
      describePrincipal: okSp({ servicePrincipalType, alternativeNames: ['isExplicit=False', ADF_RESOURCE_ID] }),
      listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
    });
    assert.equal(v.action, 'none', `servicePrincipalType ${JSON.stringify(servicePrincipalType)} must refuse`);
    assert.equal(v.exit, EXIT_REFUSED);
  }
});

test('the UAMI path never consults the directory — the #3439 collision needs no Graph read', () => {
  let directoryReads = 0;
  let subscriptionReads = 0;
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([strayAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: () => {
      directoryReads += 1;
      return { status: 1, principal: null, error: 'must not be reached' };
    },
    listSubscriptions: () => {
      subscriptionReads += 1;
      return { status: 1, subscriptionIds: null, error: 'must not be reached' };
    },
  });
  assert.equal(v.action, 'delete');
  assert.equal(v.identityKind, 'user-assigned');
  assert.equal(directoryReads, 0, 'a deploy identity without Entra read must lose nothing it had');
  assert.equal(subscriptionReads, 0);
});

test("the owner's subscription id never reaches the output", () => {
  const v = decide({
    assignmentName: STRAY_UNDASHED,
    listAssignments: okList([adfVaultAssignment()]),
    listIdentities: okIds([DIRECTLAKE_PRINCIPAL]),
    describePrincipal: okSp(ADF_SYSTEM_ASSIGNED_SP),
    listSubscriptions: okSubs([ADMIN_SUB, DLZ_SUB]),
  });
  assert.equal(v.action, 'delete');
  assert.doesNotMatch(v.reason, new RegExp(DLZ_SUB));
  assert.doesNotMatch(v.reason, new RegExp(ADMIN_SUB));
  assert.match(v.reason, /Microsoft\.DataFactory\/factories/, 'the owner must still be legible for correlation');
});

// ── THE PURE PARSERS ─────────────────────────────────────────────────────────

test('ownerResourceId finds the owner by SHAPE, in either order and for either flavour', () => {
  assert.equal(ownerResourceId(['isExplicit=False', ADF_RESOURCE_ID]), ADF_RESOURCE_ID);
  assert.equal(ownerResourceId([ADF_RESOURCE_ID, 'isExplicit=False']), ADF_RESOURCE_ID);
  const uami =
    `/subscriptions/${ADMIN_SUB}/resourcegroups/rg-csa-loom-admin-centralus` +
    '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-directlake-centralus';
  assert.equal(ownerResourceId(['isExplicit=True', uami]), uami);
});

test('ownerResourceId returns null rather than inventing an owner', () => {
  for (const bad of [null, undefined, [], ['isExplicit=False'], ['not/a/resource/id'], ['/subscriptions/nope'], 'a string']) {
    assert.equal(ownerResourceId(bad), null, `${JSON.stringify(bad)} must not resolve to an owner`);
  }
});

test('subscriptionOf reads a subscription from an id, and refuses one that has none', () => {
  assert.equal(subscriptionOf(ADF_RESOURCE_ID), DLZ_SUB);
  assert.equal(subscriptionOf(`/SUBSCRIPTIONS/${ADMIN_SUB.toUpperCase()}/resourceGroups/x`), ADMIN_SUB);
  assert.equal(subscriptionOf(`/subscriptions/${ADMIN_SUB}`), ADMIN_SUB);
  for (const bad of ['/providers/Microsoft.Management/managementGroups/mg-loom', '', null, undefined, '/subscriptions/short']) {
    assert.equal(subscriptionOf(bad), null, `${JSON.stringify(bad)} has no subscription to read`);
  }
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

test('END TO END (#4037): a system-assigned MI collision converges through the REAL az argv', () => {
  // Not decide() with hand-rolled IO — run(), so the az commands the resolvers
  // actually build are the ones under test. A resolver that queried the wrong
  // thing would throw "unscripted az call" here.
  let listCall = 0;
  const calls = [];
  const az = (argv) => {
    const joined = argv.join(' ');
    calls.push(joined);
    if (joined.includes('role assignment list')) {
      listCall += 1;
      return listCall === 1
        ? { status: 0, stdout: JSON.stringify([adfVaultAssignment()]), stderr: '' }
        : LIST_WITHOUT;
    }
    if (joined.includes('identity list')) return IDS_OK; // user-assigned only: no match
    if (joined.includes('ad sp show')) {
      return { status: 0, stdout: JSON.stringify(ADF_SYSTEM_ASSIGNED_SP), stderr: '' };
    }
    if (joined.includes('account list')) {
      return { status: 0, stdout: JSON.stringify([ADMIN_SUB, DLZ_SUB]), stderr: '' };
    }
    if (joined.includes('role assignment delete')) return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unscripted: ${joined}`);
  };
  const lines = [];
  const code = run(['--assignment-name', STRAY_UNDASHED, '--apply'], { az, log: (s) => lines.push(s) });
  assert.equal(code, EXIT_OK, lines.join('\n'));
  assert.equal(calls.filter((c) => c.includes('role assignment delete')).length, 1);
  assert.ok(
    calls.some((c) => c.includes(`ad sp show --id ${ADF_PRINCIPAL}`)),
    `the directory must be asked about the assignment's own principal: ${calls.join(' | ')}`,
  );
  assert.ok(calls.some((c) => c.includes('account list')));
  assert.match(lines.join('\n'), /converged/);
  // Public run log: no subscription id, no principal id.
  assert.doesNotMatch(lines.join('\n'), new RegExp(DLZ_SUB));
  assert.doesNotMatch(lines.join('\n'), new RegExp(ADF_PRINCIPAL));
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

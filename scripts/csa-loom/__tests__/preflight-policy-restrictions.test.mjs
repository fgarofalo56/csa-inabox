// Tests for preflight-policy-restrictions.mjs — R5 policy discovery (D5,
// run 31100384405). Driven through an injected runner; response shapes are the
// real checkPolicyRestrictions API shapes trimmed to the read fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  check,
  evaluateRestrictions,
  renderFindings,
  probeBody,
  idTail,
} from '../preflight-policy-restrictions.mjs';

const tmpBody = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-test-')), 'b.json');

// The restriction observed live on 2026-08-06 (management-group ids redacted).
const OBSERVED = {
  fieldRestrictions: [
    {
      field: 'Microsoft.Storage/storageAccounts/publicNetworkAccess',
      restrictions: [
        {
          result: 'Required',
          values: ['Disabled'],
          defaultValue: 'Disabled',
          policy: {
            policyDefinitionId:
              '/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policyDefinitions/StorageAccount_PublicNetwork_Modify',
            policyAssignmentId:
              '/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policyAssignments/MCAPSGovDeployPolicies',
          },
        },
      ],
    },
  ],
};

const ok = (obj) => ({ status: 0, stdout: JSON.stringify(obj), stderr: '' });
const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

test('the observed live restriction is reported with the assignment NAMED and the compliance default cited', () => {
  const findings = evaluateRestrictions(OBSERVED);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].assignment, 'MCAPSGovDeployPolicies');
  assert.equal(findings[0].definition, 'StorageAccount_PublicNetwork_Modify');
  assert.ok(findings[0].compliedBy, 'the Required=[Disabled] storage PNA restriction must cite the template default that complies');
  const text = renderFindings({ status: 'ok', scope: '/subscriptions/s', findings, reason: null });
  assert.match(text, /MCAPSGovDeployPolicies/);
  assert.match(text, /Loom COMPLIES by default/);
  assert.match(text, /purviewManagedResourcesPublicNetworkAccess/);
});

test('a restriction with NO compliance default is called out as the cause-to-quote', () => {
  const resp = {
    fieldRestrictions: [
      {
        field: 'Microsoft.Storage/storageAccounts/minimumTlsVersion',
        restrictions: [{ result: 'Required', values: ['TLS1_2'], policy: { policyAssignmentId: '/x/SomeOtherPolicy', policyDefinitionId: '/x/Def' } }],
      },
    ],
  };
  const text = renderFindings({ status: 'ok', scope: 's', findings: evaluateRestrictions(resp), reason: null });
  assert.match(text, /NO compliance default/);
  assert.match(text, /SomeOtherPolicy/);
});

test('RG scope answers => used and reported at that scope', () => {
  const r = check({
    subscription: 'sub-1',
    location: 'centralus',
    resourceGroup: 'rg-x',
    writeBody: tmpBody(),
    run: (args) => {
      const url = args[args.indexOf('--url') + 1];
      assert.match(url, /checkPolicyRestrictions\?api-version=/);
      return url.includes('/resourceGroups/rg-x') ? ok(OBSERVED) : fail('should not reach sub scope');
    },
  });
  assert.equal(r.status, 'ok');
  assert.match(r.scope, /resourceGroups\/rg-x/);
  assert.equal(r.findings.length, 1);
});

test('missing RG (greenfield) falls back to subscription scope and still reads', () => {
  const r = check({
    subscription: 'sub-1',
    location: 'centralus',
    resourceGroup: 'rg-missing',
    writeBody: tmpBody(),
    run: (args) => {
      const url = args[args.indexOf('--url') + 1];
      if (url.includes('/resourceGroups/')) return fail("ERROR: (ResourceGroupNotFound) Resource group 'rg-missing' could not be found.");
      return ok(OBSERVED);
    },
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.scope, '/subscriptions/sub-1');
});

test('R7: an engine that cannot be read at ANY scope is UNREADABLE — never "no restrictions"', () => {
  const r = check({
    subscription: 'sub-1',
    location: 'centralus',
    writeBody: tmpBody(),
    run: () => fail('ERROR: (AuthorizationFailed) no Microsoft.PolicyInsights/checkPolicyRestrictions/action'),
  });
  assert.equal(r.status, 'unreadable');
  assert.match(r.reason, /UNKNOWN/);
  assert.match(renderFindings(r), /UNREADABLE/);
});

test('an empty restriction set is reported with the measured caveat — NOT rendered as "no policies"', () => {
  const r = check({
    subscription: 'sub-1',
    location: 'centralus',
    writeBody: tmpBody(),
    run: () => ok({ fieldRestrictions: [] }),
  });
  assert.equal(r.status, 'ok');
  const text = renderFindings(r);
  assert.match(text, /no field restrictions/);
  assert.match(text, /NOT "no policies"/);
  assert.match(text, /what-if\/validate/);
});

test('probeBody pins the pending field the incident was about, with candidate values', () => {
  const b = probeBody('centralus');
  assert.equal(b.pendingFields[0].field, 'Microsoft.Storage/storageAccounts/publicNetworkAccess');
  assert.deepEqual(b.pendingFields[0].values, ['Enabled', 'Disabled']);
  assert.equal(b.resourceDetails.resourceContent.location, 'centralus');
});

test('idTail names an assignment without reproducing the full ARM id', () => {
  assert.equal(idTail('/providers/x/policyAssignments/MCAPSGovDeployPolicies'), 'MCAPSGovDeployPolicies');
  assert.equal(idTail(null), '<unknown>');
});

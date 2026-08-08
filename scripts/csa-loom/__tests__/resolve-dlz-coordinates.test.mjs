/**
 * resolve-dlz-coordinates.test.mjs — the DLZ resolver finds the real landing
 * zone, refuses to invent one, and can never report a read failure as an
 * absence (deploy-integrity.md R5/R6/R7).
 *
 * THE FIXTURE IS THE LIVE ESTATE. The rows below are the shape Azure Resource
 * Graph really returns for `resourcecontainers` /
 * `microsoft.{synapse,databricks}/workspaces`, taken from the Commercial estate
 * on 2026-08-08 with the subscription GUIDs replaced: the landing zone is
 * `rg-csa-loom-dlz-default-centralus` — domain `default`, NOT `single` — and it
 * sits in a different subscription from the admin plane. That is exactly the
 * estate on which run 31243230253 died with
 *
 *   (ResourceGroupNotFound) Resource group 'rg-csa-loom-dlz-single-centralus'
 *   could not be found.
 *
 * Run: node --test scripts/csa-loom/__tests__/resolve-dlz-coordinates.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT,
  DLZ_RG_QUERY,
  WORKSPACES_QUERY,
  domainOfDlzRg,
  pickWorkspace,
  resolveDlzCoordinates,
  githubEnvLines,
  render,
  parseArgs,
  exitCodeFor,
} from '../resolve-dlz-coordinates.mjs';

const ADMIN_SUB = '00000000-0000-0000-0000-00000000aaaa';
const DLZ_SUB = '00000000-0000-0000-0000-00000000bbbb';
const REGION = 'centralus';

const SYN = 'microsoft.synapse/workspaces';
const DBX = 'microsoft.databricks/workspaces';

const rg = (name, sub = DLZ_SUB, location = REGION) => ({ name, subscriptionId: sub, location });
const ws = (name, type, resourceGroup, sub = DLZ_SUB) => ({ name, type, resourceGroup, subscriptionId: sub });

/** ARG returns `{count, data:[…]}`; both queries are served from one map. */
function graph({ groups = [], workspaces = [], fail = null, failOn = null }) {
  return (query) => {
    if (fail) return fail;
    if (failOn && query === failOn) {
      return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) read denied.' };
    }
    const rows = query === DLZ_RG_QUERY ? groups : query === WORKSPACES_QUERY ? workspaces : null;
    if (rows === null) throw new Error(`unexpected query: ${query}`);
    return { status: 0, stdout: JSON.stringify({ count: rows.length, data: rows }), stderr: '' };
  };
}

/** The live Commercial estate: cross-sub, domain `default`. */
const LIVE = {
  groups: [rg('rg-csa-loom-dlz-default-centralus')],
  workspaces: [
    ws('syn-loom-default-centralus', SYN, 'rg-csa-loom-dlz-default-centralus'),
    ws('adb-loom-default-centralus', DBX, 'rg-csa-loom-dlz-default-centralus'),
  ],
};

test('THE REAL DEFECT — the live estate resolves to `default`, never to the `single` default', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph(LIVE),
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.dlzResourceGroup, 'rg-csa-loom-dlz-default-centralus');
  assert.equal(r.dlzDomain, 'default');
  assert.equal(r.dlzSubscription, DLZ_SUB);
  assert.equal(r.crossSubscription, true);
  assert.equal(r.synapseWorkspace, 'syn-loom-default-centralus');
  assert.equal(r.databricksWorkspace, 'adb-loom-default-centralus');

  // The name the workflow used to build from its inputs, and that ARM rejected.
  assert.notEqual(r.dlzResourceGroup, 'rg-csa-loom-dlz-single-centralus');

  const env = githubEnvLines(r);
  assert.ok(env.includes('DLZ_RG=rg-csa-loom-dlz-default-centralus'));
  assert.ok(env.includes('DLZ_DOMAIN=default'));
  assert.ok(env.includes(`DLZ_SUB=${DLZ_SUB}`));
  assert.ok(env.includes('SYNAPSE_WS=syn-loom-default-centralus'));
  assert.ok(env.includes('DBX_WS=adb-loom-default-centralus'));
});

test('MUTATION PROOF — move the SAME estate into one subscription named `single` and the answer follows it', () => {
  // main.bicep's useSingleDlz branch: the group is `…-dlz-single-…` but the
  // workspaces inside it are named `…-loom-default-…`. Only the fixture changes.
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({
      groups: [rg('rg-csa-loom-dlz-single-centralus', ADMIN_SUB)],
      workspaces: [
        ws('syn-loom-default-centralus', SYN, 'rg-csa-loom-dlz-single-centralus', ADMIN_SUB),
        ws('adb-loom-default-centralus', DBX, 'rg-csa-loom-dlz-single-centralus', ADMIN_SUB),
      ],
    }),
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.dlzResourceGroup, 'rg-csa-loom-dlz-single-centralus');
  assert.equal(r.dlzDomain, 'single');
  assert.equal(r.crossSubscription, false);
  // The RG's domain segment is `single` and the workspaces' is `default`. A
  // resolver that derived workspace names from the group name would emit
  // `syn-loom-single-centralus`, which does not exist.
  assert.equal(r.synapseWorkspace, 'syn-loom-default-centralus');
  assert.match(render(r), /single-subscription estate/);
});

test('a non-conventional domain resolves BOTH the group and the workspaces from the estate', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({
      groups: [rg('rg-csa-loom-dlz-finance-centralus')],
      workspaces: [
        ws('syn-loom-finance-centralus', SYN, 'rg-csa-loom-dlz-finance-centralus'),
        ws('adb-loom-finance-centralus', DBX, 'rg-csa-loom-dlz-finance-centralus'),
      ],
    }),
  });
  assert.equal(r.dlzDomain, 'finance');
  assert.equal(r.synapseWorkspace, 'syn-loom-finance-centralus');
  assert.equal(r.databricksWorkspace, 'adb-loom-finance-centralus');
});

test("the Gov dlz-attach shape (EMPTY domain, `rg-csa-loom-dlz--usgovvirginia`) is a real answer, not a miss", () => {
  const r = resolveDlzCoordinates({
    region: 'usgovvirginia',
    adminSubscription: ADMIN_SUB,
    run: graph({
      groups: [rg('rg-csa-loom-dlz--usgovvirginia', DLZ_SUB, 'usgovvirginia')],
      workspaces: [ws('syn-loom--usgovvirginia', SYN, 'rg-csa-loom-dlz--usgovvirginia')],
    }),
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.dlzDomain, '');
  assert.equal(r.dlzResourceGroup, 'rg-csa-loom-dlz--usgovvirginia');
  assert.equal(r.synapseWorkspace, 'syn-loom--usgovvirginia');
});

test('MUTATION PROOF — an unreadable estate is NEVER reported as "no DLZ"', () => {
  const denied = {
    status: 1,
    stdout: '',
    stderr: "ERROR: (AuthorizationFailed) does not have authorization to perform action 'Microsoft.ResourceGraph/resources/read'.",
  };
  const r = resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, run: graph({ fail: denied }) });
  assert.equal(r.status, 'unreadable');
  assert.equal(r.dlzResourceGroup, null);
  const out = render(r);
  assert.match(out, /COULD NOT READ/);
  assert.match(out, /not a finding of "no DLZ"/);
  assert.doesNotMatch(out, /no landing zone found/);
  assert.equal(exitCodeFor(r.status), EXIT.UNREADABLE);
});

test('a workspace read that fails does not get papered over with a convention name', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({ ...LIVE, failOn: WORKSPACES_QUERY }),
  });
  assert.equal(r.status, 'unreadable');
  assert.equal(r.synapseWorkspace, null);
});

test('non-JSON and a missing `data` array are unreadable, not empty', () => {
  const html = () => ({ status: 0, stdout: '<html/>', stderr: '' });
  assert.equal(resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, run: html }).status, 'unreadable');
  const noData = () => ({ status: 0, stdout: '{"count":0}', stderr: '' });
  assert.equal(resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, run: noData }).status, 'unreadable');
});

test('zero candidates FAILS CLOSED and says what it looked for and what it found', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({ groups: [rg('rg-csa-loom-dlz-default-eastus2', DLZ_SUB, 'eastus2')] }),
  });
  assert.equal(r.status, 'not-found');
  assert.equal(exitCodeFor(r.status), EXIT.NOT_FOUND);
  const out = render(r);
  assert.match(out, /no landing zone found for region "centralus"/);
  assert.match(out, /rg-csa-loom-dlz-default-eastus2/); // what it DID find
  assert.match(out, /Reader on the DLZ subscription/); // the likeliest cause
  assert.match(out, /dlz_domain/); // the explicit override, named
});

test('MORE THAN ONE candidate stops rather than picking — and names both', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({
      groups: [rg('rg-csa-loom-dlz-finance-centralus'), rg('rg-csa-loom-dlz-hr-centralus')],
    }),
  });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.dlzResourceGroup, null);
  assert.equal(exitCodeFor(r.status), EXIT.AMBIGUOUS);
  const out = render(r);
  assert.match(out, /AMBIGUOUS/);
  assert.match(out, /rg-csa-loom-dlz-finance-centralus/);
  assert.match(out, /rg-csa-loom-dlz-hr-centralus/);
  assert.match(out, /Nothing was assumed/);
});

test('an explicit --dlz-domain DISAMBIGUATES the same ambiguous estate', () => {
  const run = graph({
    groups: [rg('rg-csa-loom-dlz-finance-centralus'), rg('rg-csa-loom-dlz-hr-centralus')],
    workspaces: [ws('syn-loom-hr-centralus', SYN, 'rg-csa-loom-dlz-hr-centralus')],
  });
  const r = resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, dlzDomain: 'hr', run });
  assert.equal(r.status, 'resolved');
  assert.equal(r.dlzResourceGroup, 'rg-csa-loom-dlz-hr-centralus');
});

test('an override that matches NOTHING fails loudly instead of rebuilding the phantom name', () => {
  // The old code path did exactly this: dlz_domain=single with no such group
  // produced `rg-csa-loom-dlz-single-centralus` and handed it to ARM.
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    dlzDomain: 'single',
    run: graph(LIVE),
  });
  assert.equal(r.status, 'not-found');
  assert.match(r.reason, /--dlz-domain "single"/);
  assert.match(render(r), /rg-csa-loom-dlz-default-centralus/);
});

test('an explicit --dlz-subscription narrows to the DLZ in that subscription', () => {
  const run = graph({
    groups: [
      rg('rg-csa-loom-dlz-shared-centralus', ADMIN_SUB),
      rg('rg-csa-loom-dlz-shared-centralus', DLZ_SUB),
    ],
    workspaces: [ws('syn-loom-shared-centralus', SYN, 'rg-csa-loom-dlz-shared-centralus', DLZ_SUB)],
  });
  assert.equal(resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, run }).status, 'ambiguous');
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    dlzSubscription: DLZ_SUB,
    run,
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.dlzSubscription, DLZ_SUB);
  assert.equal(r.crossSubscription, true);
});

test('a DLZ with no Synapse is a supported estate — a stated fallback, not a silent one', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({ groups: LIVE.groups, workspaces: [] }),
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.synapseWorkspace, 'syn-loom-default-centralus');
  assert.equal(r.synapseHow, 'none');
  assert.ok(r.notes.some((n) => /no Synapse workspace exists/.test(n)));
  assert.ok(r.notes.some((n) => /no Databricks workspace exists/.test(n)));
  assert.match(render(r), /Note:/);
});

test('workspaces in a DIFFERENT resource group or subscription are not adopted', () => {
  const r = resolveDlzCoordinates({
    region: REGION,
    adminSubscription: ADMIN_SUB,
    run: graph({
      groups: LIVE.groups,
      workspaces: [
        ws('syn-loom-default-centralus', SYN, 'rg-csa-loom-dlz-default-centralus', ADMIN_SUB), // wrong sub
        ws('syn-someone-elses', SYN, 'rg-not-loom'), // wrong rg
      ],
    }),
  });
  assert.equal(r.synapseHow, 'none');
});

test('the RG-name parser handles every real shape and rejects the near-misses', () => {
  assert.equal(domainOfDlzRg('rg-csa-loom-dlz-default-centralus', 'centralus'), 'default');
  assert.equal(domainOfDlzRg('RG-CSA-LOOM-DLZ-Default-CentralUS', 'centralus'), 'default');
  assert.equal(domainOfDlzRg('rg-csa-loom-dlz--usgovvirginia', 'usgovvirginia'), '');
  assert.equal(domainOfDlzRg('rg-csa-loom-dlz-default-centralus', 'eastus2'), null);
  assert.equal(domainOfDlzRg('rg-csa-loom-admin-centralus', 'centralus'), null);
  // Prefix running straight into the region: not a DLZ group, and NOT the
  // empty-domain estate either.
  assert.equal(domainOfDlzRg('rg-csa-loom-dlz-centralus', 'centralus'), null);
  assert.equal(domainOfDlzRg('rg-csa-loom-dlz-default-centralus', ''), null);
  assert.equal(domainOfDlzRg(null, 'centralus'), null);
});

test('pickWorkspace prefers the convention, then the prefix, and reports a real tie', () => {
  const args = { prefix: 'syn', domain: 'finance', region: REGION };
  assert.deepEqual(pickWorkspace([], args), { name: null, how: 'none' });
  assert.equal(pickWorkspace([{ name: 'whatever-they-called-it' }], args).how, 'sole');
  assert.equal(
    pickWorkspace([{ name: 'syn-loom-finance-centralus' }, { name: 'syn-other' }], args).name,
    'syn-loom-finance-centralus',
  );
  assert.equal(
    pickWorkspace([{ name: 'syn-loom-default-centralus' }, { name: 'syn-other' }], args).how,
    'convention-default',
  );
  const tie = pickWorkspace([{ name: 'syn-a' }, { name: 'syn-b' }], args);
  assert.equal(tie.how, 'ambiguous');
  assert.deepEqual(tie.candidates, ['syn-a', 'syn-b']);
});

test('NO SUBSCRIPTION ID EVER REACHES STDOUT — only the GITHUB_ENV file', () => {
  const r = resolveDlzCoordinates({ region: REGION, adminSubscription: ADMIN_SUB, run: graph(LIVE) });
  const out = render(r);
  assert.doesNotMatch(out, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.match(out, /cross-subscription estate/); // the FACT, without the id
  assert.ok(githubEnvLines(r).some((l) => l === `DLZ_SUB=${DLZ_SUB}`));
});

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  const a = parseArgs(['--region', 'centralus', '--dlz-domain', 'hr', '--json']);
  assert.equal(a.region, 'centralus');
  assert.equal(a.dlzDomain, 'hr');
  assert.equal(a.json, true);
});

test('the five outcomes have five distinct exit codes', () => {
  assert.equal(
    new Set([EXIT.RESOLVED, EXIT.NOT_FOUND, EXIT.USAGE, EXIT.UNREADABLE, EXIT.AMBIGUOUS]).size,
    5,
  );
});

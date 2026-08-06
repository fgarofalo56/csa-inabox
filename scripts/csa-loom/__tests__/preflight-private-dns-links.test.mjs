/**
 * preflight-private-dns-links.test.mjs — the adopt-or-fail-clearly preflight
 * can FAIL, can pass, and can never report "clean" for an estate it could not
 * read (issue #3039, deploy-integrity.md R5/R7).
 *
 * The fixture rows are the shape Azure Resource Graph really returns for
 * `microsoft.network/privatednszones{,/virtualnetworklinks}` — verified against
 * the live Commercial estate on 2026-08-06, with the subscription GUIDs
 * replaced. The conflicting row is the real one: `link-hub` on the DLZ-resource-
 * group zone pointing at the admin hub VNet.
 *
 * Run: node --test scripts/csa-loom/__tests__/preflight-private-dns-links.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT,
  LINKS_QUERY,
  ZONES_QUERY,
  namespaceOfLink,
  zoneIdOfLink,
  subscriptionOf,
  analyseDnsLinks,
  render,
  parseArgs,
} from '../preflight-private-dns-links.mjs';

const ADMIN_SUB = '00000000-0000-0000-0000-00000000aaaa';
const DLZ_SUB = '00000000-0000-0000-0000-00000000bbbb';
const ADMIN_RG = 'rg-csa-loom-admin-centralus';
const DLZ_RG = 'rg-csa-loom-dlz-default-centralus';
const NS = 'privatelink.azuredatabricks.net';
const NS2 = 'privatelink.documents.azure.com';

const HUB_VNET = `/subscriptions/${ADMIN_SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-centralus`;
const zid = (sub, rg, ns) =>
  `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/privateDnsZones/${ns}`;
const link = (sub, rg, ns, name, vnet) => ({
  linkName: name,
  linkId: `${zid(sub, rg, ns)}/virtualNetworkLinks/${name}`,
  zoneRg: rg,
  zoneSub: sub,
  vnet: vnet.toLowerCase(),
});

/** ARG returns `{count, data:[…]}`; both queries are served from one map. */
function graph({ zones, links, fail = null }) {
  return (query) => {
    if (fail) return fail;
    const rows = query === ZONES_QUERY ? zones : query === LINKS_QUERY ? links : null;
    if (rows === null) throw new Error(`unexpected query: ${query}`);
    return { status: 0, stdout: JSON.stringify({ count: rows.length, data: rows }), stderr: '' };
  };
}

const ADMIN_ZONES = [
  { zoneName: NS, zoneId: zid(ADMIN_SUB, ADMIN_RG, NS), zoneRg: ADMIN_RG, zoneSub: ADMIN_SUB },
  { zoneName: NS2, zoneId: zid(ADMIN_SUB, ADMIN_RG, NS2), zoneRg: ADMIN_RG, zoneSub: ADMIN_SUB },
];

test('THE REAL CONFLICT — a foreign zone holding the hub link is named, not guessed at', () => {
  const r = analyseDnsLinks({
    hubVnetId: HUB_VNET,
    zoneRg: ADMIN_RG,
    run: graph({
      zones: [...ADMIN_ZONES, { zoneName: NS, zoneId: zid(DLZ_SUB, DLZ_RG, NS), zoneRg: DLZ_RG, zoneSub: DLZ_SUB }],
      links: [
        link(DLZ_SUB, DLZ_RG, NS, 'link-hub', HUB_VNET),
        link(ADMIN_SUB, ADMIN_RG, NS2, 'link-hub', HUB_VNET),
      ],
    }),
  });
  assert.equal(r.status, 'conflict');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].namespace, NS);
  assert.equal(r.conflicts[0].owningZoneRg, DLZ_RG);
  assert.equal(r.conflicts[0].crossSubscription, true);
  // The other namespace is converged and must NOT be reported as a problem.
  assert.deepEqual(r.converged.map((c) => c.namespace), [NS2]);

  const out = render(r, { hubVnetName: 'vnet-csa-loom-hub-centralus' });
  assert.match(out, /CONFLICT/);
  assert.match(out, new RegExp(DLZ_RG));
  assert.match(out, /migrate-private-dns-zone-owner\.mjs/);
  assert.match(out, /DO NOT delete the existing link first/);
});

test('MUTATION PROOF — move the link onto the intended zone and the SAME input is clean', () => {
  // Only the owning zone changes. Everything else is identical to the test
  // above, so a guard that reported "conflict" unconditionally fails here.
  const r = analyseDnsLinks({
    hubVnetId: HUB_VNET,
    zoneRg: ADMIN_RG,
    run: graph({
      zones: ADMIN_ZONES,
      links: [
        link(ADMIN_SUB, ADMIN_RG, NS, 'link-hub', HUB_VNET),
        link(ADMIN_SUB, ADMIN_RG, NS2, 'link-hub', HUB_VNET),
      ],
    }),
  });
  assert.equal(r.status, 'clean');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.converged.length, 2);
  assert.match(render(r), /OK\./);
});

test('a foreign zone linked to a DIFFERENT VNet is not this deploy\'s problem', () => {
  const otherVnet = `/subscriptions/${DLZ_SUB}/resourceGroups/${DLZ_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-dlz-default-centralus`;
  const r = analyseDnsLinks({
    hubVnetId: HUB_VNET,
    zoneRg: ADMIN_RG,
    run: graph({
      zones: [...ADMIN_ZONES, { zoneName: NS, zoneId: zid(DLZ_SUB, DLZ_RG, NS), zoneRg: DLZ_RG, zoneSub: DLZ_SUB }],
      links: [link(DLZ_SUB, DLZ_RG, NS, 'link-dlz', otherVnet)],
    }),
  });
  assert.equal(r.status, 'clean');
});

test('a namespace nobody owns yet is ignored unless --expect-namespaces names it', () => {
  const foreign = 'privatelink.brand.new.net';
  const links = [link(DLZ_SUB, DLZ_RG, foreign, 'link-hub', HUB_VNET)];
  const zones = [...ADMIN_ZONES, { zoneName: foreign, zoneId: zid(DLZ_SUB, DLZ_RG, foreign), zoneRg: DLZ_RG, zoneSub: DLZ_SUB }];

  assert.equal(analyseDnsLinks({ hubVnetId: HUB_VNET, zoneRg: ADMIN_RG, run: graph({ zones, links }) }).status, 'clean');
  const scoped = analyseDnsLinks({
    hubVnetId: HUB_VNET,
    zoneRg: ADMIN_RG,
    expectNamespaces: [foreign],
    run: graph({ zones, links }),
  });
  assert.equal(scoped.status, 'conflict');
  assert.equal(scoped.conflicts[0].namespace, foreign);
});

test('the limitation is DISCLOSED when --expect-namespaces was not supplied', () => {
  const r = analyseDnsLinks({ hubVnetId: HUB_VNET, zoneRg: ADMIN_RG, run: graph({ zones: ADMIN_ZONES, links: [] }) });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /being ADDED to admin-plane\/network\.bicep/);
  assert.match(render(r), /Note:/);
});

test('MUTATION PROOF — an unreadable estate is NEVER reported clean', () => {
  const denied = {
    status: 1,
    stdout: '',
    stderr: "ERROR: (AuthorizationFailed) does not have authorization to perform action 'Microsoft.ResourceGraph/resources/read'.",
  };
  const r = analyseDnsLinks({ hubVnetId: HUB_VNET, zoneRg: ADMIN_RG, run: graph({ zones: [], links: [], fail: denied }) });
  assert.equal(r.status, 'unreadable');
  const out = render(r);
  assert.match(out, /COULD NOT READ/);
  assert.match(out, /NOTHING is asserted/);
  assert.doesNotMatch(out, /No overlapping-namespace conflict/);
});

test('non-JSON and a missing `data` array are both unreadable, not empty', () => {
  const html = () => ({ status: 0, stdout: '<html/>', stderr: '' });
  assert.equal(analyseDnsLinks({ hubVnetId: HUB_VNET, zoneRg: ADMIN_RG, run: html }).status, 'unreadable');
  const noData = () => ({ status: 0, stdout: '{"count":0}', stderr: '' });
  assert.equal(analyseDnsLinks({ hubVnetId: HUB_VNET, zoneRg: ADMIN_RG, run: noData }).status, 'unreadable');
});

test('link ids are parsed into namespace and zone, case-insensitively', () => {
  const id = `${zid(DLZ_SUB, DLZ_RG, NS)}/virtualNetworkLinks/link-hub`;
  assert.equal(namespaceOfLink(id), NS);
  assert.equal(zoneIdOfLink(id), zid(DLZ_SUB, DLZ_RG, NS));
  assert.equal(namespaceOfLink('/nonsense'), null);
  assert.equal(subscriptionOf(HUB_VNET), ADMIN_SUB);
  assert.equal(subscriptionOf('rubbish'), null);
});

test('crossSubscription is only claimed when the subscriptions really differ', () => {
  const r = analyseDnsLinks({
    hubVnetId: HUB_VNET,
    zoneRg: ADMIN_RG,
    run: graph({
      zones: [...ADMIN_ZONES, { zoneName: NS, zoneId: zid(ADMIN_SUB, 'rg-somewhere-else', NS), zoneRg: 'rg-somewhere-else', zoneSub: ADMIN_SUB }],
      links: [link(ADMIN_SUB, 'rg-somewhere-else', NS, 'link-hub', HUB_VNET)],
    }),
  });
  assert.equal(r.status, 'conflict');
  assert.equal(r.conflicts[0].crossSubscription, false);
  assert.doesNotMatch(render(r), /DIFFERENT subscription/);
});

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.deepEqual(parseArgs(['--expect-namespaces', 'a.net, b.net']).expectNamespaces, ['a.net', 'b.net']);
});

test('the three outcomes have three distinct exit codes', () => {
  assert.equal(new Set([EXIT.CLEAN, EXIT.CONFLICT, EXIT.USAGE, EXIT.UNREADABLE]).size, 4);
});

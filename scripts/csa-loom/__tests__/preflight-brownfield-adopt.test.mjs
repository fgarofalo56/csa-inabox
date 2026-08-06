// Tests for preflight-brownfield-adopt.mjs — the R5 adopt-or-create discovery
// for estate-owned singletons (run 31100384405 leaves D4a/D4c).
//
// Every branch is driven through an injected runner, no Azure. The shapes in
// FIXTURES are the real az output shapes (`az network vnet-gateway list`,
// `az network private-dns link vnet list`) trimmed to the read fields.
//
// MUTATION NOTES (each is a behaviour the estate already paid for once):
//   - a denied read must NEVER come back as "nothing exists" (unreadable ≠ create)
//   - a gateway on a DIFFERENT VNet must not be adopted (misbind)
//   - an ExpressRoute gateway must not be adopted as the Vpn gateway
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discover,
  findVpnGatewayForVnet,
  findZoneLinkForVnet,
  isArmNotFound,
  APIM_GATEWAY_ZONE,
} from '../preflight-brownfield-adopt.mjs';

const HUB_ID =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-x/providers/Microsoft.Network/virtualNetworks/vnet-hub';

const ok = (obj) => ({ status: 0, stdout: JSON.stringify(obj), stderr: '' });
const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

const NOT_FOUND =
  "ERROR: (ResourceNotFound) The Resource 'Microsoft.Network/virtualNetworks/vnet-hub' under resource group 'rg-x' was not found.";
const DENIED =
  "ERROR: (AuthorizationFailed) The client 'x' does not have authorization to perform action 'Microsoft.Network/virtualNetworks/read'";

const GW_VPN = {
  name: 'vpngw-loom-centralus',
  gatewayType: 'Vpn',
  ipConfigurations: [{ subnet: { id: `${HUB_ID}/subnets/GatewaySubnet` } }],
};
const GW_ER = {
  name: 'ergw-loom',
  gatewayType: 'ExpressRoute',
  ipConfigurations: [{ subnet: { id: `${HUB_ID}/subnets/GatewaySubnet` } }],
};
const GW_OTHER_VNET = {
  name: 'vpngw-other',
  gatewayType: 'Vpn',
  ipConfigurations: [{ subnet: { id: `${HUB_ID.replace('vnet-hub', 'vnet-other')}/subnets/GatewaySubnet` } }],
};
const LINK_HUB = { name: 'link-apim-console', virtualNetwork: { id: HUB_ID } };
const LINK_OTHER = { name: 'link-other', virtualNetwork: { id: HUB_ID.replace('vnet-hub', 'vnet-other') } };

/** Route each az command family to a canned response. */
function runner({ vnet, gateways, links }) {
  return (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('network vnet show')) return vnet;
    if (joined.startsWith('network vnet-gateway list')) return gateways;
    if (joined.startsWith('network private-dns link vnet list')) return links;
    throw new Error(`unexpected az call: ${joined}`);
  };
}

const base = { resourceGroup: 'rg-x', hubVnetName: 'vnet-hub' };

test('brownfield: existing Vpn gateway + existing zone link are both ADOPTED by name', () => {
  const r = discover({
    ...base,
    run: runner({ vnet: ok({ id: HUB_ID }), gateways: ok([GW_ER, GW_VPN]), links: ok([LINK_OTHER, LINK_HUB]) }),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.vpnGatewayName, 'vpngw-loom-centralus');
  assert.equal(r.apimDnsLinkName, 'link-apim-console');
});

test('greenfield: hub VNet ResourceNotFound => create-new for both, status ok', () => {
  const r = discover({ ...base, run: runner({ vnet: fail(NOT_FOUND) }) });
  assert.equal(r.status, 'ok');
  assert.equal(r.hubVnetFound, false);
  assert.equal(r.vpnGatewayName, '');
  assert.equal(r.apimDnsLinkName, '');
});

test('estate with VNet but no gateway/link => create-new for both', () => {
  const r = discover({
    ...base,
    run: runner({ vnet: ok({ id: HUB_ID }), gateways: ok([]), links: ok([]) }),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.vpnGatewayName, '');
  assert.equal(r.apimDnsLinkName, '');
});

test('zone absent (ARM not-found on link list) is CREATE, not unreadable', () => {
  const r = discover({
    ...base,
    run: runner({
      vnet: ok({ id: HUB_ID }),
      gateways: ok([GW_VPN]),
      links: fail(`ERROR: (ResourceNotFound) The Resource 'Microsoft.Network/privateDnsZones/${APIM_GATEWAY_ZONE}' under resource group 'rg-x' was not found.`),
    }),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.vpnGatewayName, 'vpngw-loom-centralus');
  assert.equal(r.apimDnsLinkName, '');
});

// THE R7 CASES — a failed read must never be rendered as "nothing exists".

test('denied VNet read is UNREADABLE, never greenfield', () => {
  const r = discover({ ...base, run: runner({ vnet: fail(DENIED) }) });
  assert.equal(r.status, 'unreadable');
  assert.match(r.reason, /could not be READ/);
});

test('denied gateway list is UNREADABLE, never create-new', () => {
  const r = discover({
    ...base,
    run: runner({ vnet: ok({ id: HUB_ID }), gateways: fail(DENIED) }),
  });
  assert.equal(r.status, 'unreadable');
  assert.match(r.reason, /MultipleGatewaysOfTypeVpnUseSameVnet/);
});

test('denied link list is UNREADABLE, never create-new', () => {
  const r = discover({
    ...base,
    run: runner({ vnet: ok({ id: HUB_ID }), gateways: ok([]), links: fail(DENIED) }),
  });
  assert.equal(r.status, 'unreadable');
  assert.match(r.reason, /Conflict/);
});

// MISBIND GUARDS — the filter is per-VNet and per-type.

test('a Vpn gateway on a DIFFERENT VNet is not adopted', () => {
  assert.equal(findVpnGatewayForVnet([GW_OTHER_VNET], HUB_ID), null);
});

test('an ExpressRoute gateway is not adopted as the Vpn gateway', () => {
  assert.equal(findVpnGatewayForVnet([GW_ER], HUB_ID), null);
});

test('VNet-id match is case-insensitive (ARM ids vary in casing across APIs)', () => {
  assert.equal(findVpnGatewayForVnet([{ ...GW_VPN, ipConfigurations: [{ subnet: { id: `${HUB_ID.toUpperCase()}/SUBNETS/GATEWAYSUBNET` } }] }], HUB_ID), 'vpngw-loom-centralus');
  assert.equal(findZoneLinkForVnet([{ name: 'l', virtualNetwork: { id: HUB_ID.toUpperCase() } }], HUB_ID), 'l');
});

test('a link for a different VNet is not adopted', () => {
  assert.equal(findZoneLinkForVnet([LINK_OTHER], HUB_ID), null);
});

test('isArmNotFound: taxonomy-backed split — not-found true, denial false, empty false', () => {
  assert.equal(isArmNotFound(NOT_FOUND), true);
  assert.equal(isArmNotFound(DENIED), false);
  assert.equal(isArmNotFound(''), false);
});

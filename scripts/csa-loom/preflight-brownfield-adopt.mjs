#!/usr/bin/env node
/**
 * preflight-brownfield-adopt.mjs — discover estate-owned SINGLETONS so the
 * deploy ADOPTS them by name instead of colliding (deploy-integrity.md R5).
 *
 * WHY (run 31100384405, 2026-08-06 — two of its nine ARM leaf failures)
 *
 *   MultipleGatewaysOfTypeVpnUseSameVnet
 *     The VPN gateway …/virtualNetworkGateways/vpngw-loom-centralus already
 *     exists in the virtual network. Delete it and retry.
 *       [Microsoft.Network/virtualNetworkGateways 'vgw-loom-centralus']
 *
 *   Conflict
 *     Private zone 'azure-api.net' is already linked to the virtual network
 *     '…/virtualNetworks/vnet-csa-loom-hub-centralus'.
 *       [… virtualNetworkLinks 'azure-api.net/link-vnet-csa-loom-hub-centralus']
 *
 *   Azure permits exactly ONE Vpn-type gateway per VNet and ONE private-DNS
 *   zone link per (zone, VNet) pair. The live estate carries both under names
 *   that predate the current templates (vpngw-loom-centralus, created by an
 *   earlier naming scheme; link-apim-console, created by hand), so a
 *   create-new PUT can NEVER succeed and "delete it and retry" would take a
 *   working VPN (30-45 min recreate) or gateway DNS down. The only correct
 *   reconcile is to target the EXISTING names. Bicep cannot query a scope, so
 *   this runs BEFORE what-if/apply and hands the names to the template
 *   (root params existingVpnGatewayName / apimGatewayDnsLinkName).
 *
 * THREE-STATE (R7). Each discovery has three outcomes, never two:
 *   adopt       Azure ANSWERED and the resource exists → its name is emitted.
 *   create      Azure ANSWERED and it does not exist (ARM ResourceNotFound for
 *               the VNet/zone, or an empty filtered list) → empty name, the
 *               template keeps its create-new default.
 *   unreadable  Azure did NOT answer (denial, throttle, network) → exit 3 and
 *               NOTHING is asserted. A failed read must never be rendered as
 *               "nothing exists" — that is exactly how this estate ended up
 *               with a second-gateway PUT in the first place.
 *
 *   The not-found split is decided by the shared failure taxonomy
 *   (deploy-classify.mjs --assert-signal config.resource-not-found semantics),
 *   not by a local regex free to drift from it.
 *
 * USAGE
 *   node scripts/csa-loom/preflight-brownfield-adopt.mjs \
 *     --resource-group rg-csa-loom-admin-<region> \
 *     --hub-vnet-name vnet-csa-loom-hub-<region> \
 *     [--subscription <id>] [--json]
 *
 *   Exit: 0 discovered (adopt and/or create per resource) | 2 usage | 3 unreadable.
 *
 * Tests: node --test scripts/csa-loom/__tests__/preflight-brownfield-adopt.test.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify } from '../ci/deploy-classify.mjs';

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, UNREADABLE: 3 });

export const APIM_GATEWAY_ZONE = 'azure-api.net';

/** Real `az`, stderr CAPTURED so `unreadable` can say why (R7). */
export function azRunner(args) {
  const bin = process.env.LOOM_AZ_BIN ?? (process.platform === 'win32' ? 'az.cmd' : 'az');
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: /\.(cmd|bat)$/i.test(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) return { status: 127, stdout: '', stderr: `${res.error.message}` };
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Is this az failure ARM saying "the resource genuinely does not exist"?
 * Decided by THE taxonomy, so the split cannot drift from the rest of the
 * deploy plane. Anything else — permission, throttle, network — is NOT
 * absence.
 */
export function isArmNotFound(stderrText) {
  const d = classify(stderrText);
  return d.signalId === 'config.resource-not-found' || d.signalId === 'config.resource-group-not-found';
}

const lower = (s) => String(s ?? '').toLowerCase();

/**
 * The Vpn-type gateway on the given VNet, if any. ARM guarantees at most one,
 * but the FILTER is still per-VNet: a resource group can hold gateways for
 * several VNets and adopting a neighbour's would be the misbind defect.
 */
export function findVpnGatewayForVnet(gateways, hubVnetId) {
  const prefix = `${lower(hubVnetId)}/`;
  for (const gw of Array.isArray(gateways) ? gateways : []) {
    if (lower(gw?.gatewayType) !== 'vpn') continue;
    const ipcs = Array.isArray(gw?.ipConfigurations) ? gw.ipConfigurations : [];
    if (ipcs.some((c) => lower(c?.subnet?.id).startsWith(prefix))) return gw.name ?? null;
  }
  return null;
}

/** The zone link that already binds (zone, VNet), if any. */
export function findZoneLinkForVnet(links, hubVnetId) {
  const want = lower(hubVnetId);
  for (const l of Array.isArray(links) ? links : []) {
    if (lower(l?.virtualNetwork?.id) === want) return l.name ?? null;
  }
  return null;
}

/**
 * Run the discovery. Pure given `run`, so every branch is testable without
 * Azure.
 *
 * @returns {{status:'ok'|'unreadable', vpnGatewayName:string, apimDnsLinkName:string,
 *            hubVnetFound:boolean, notes:string[], reason:string|null}}
 */
export function discover({ resourceGroup, hubVnetName, subscription = null, run = azRunner }) {
  const sub = subscription ? ['--subscription', subscription] : [];
  const notes = [];

  // 1. The hub VNet anchors both discoveries. ResourceNotFound → a genuine
  //    greenfield: nothing can be linked to or gatewayed on a VNet that does
  //    not exist, so both answers are 'create'.
  const vnet = run(['network', 'vnet', 'show', '-g', resourceGroup, '-n', hubVnetName, ...sub, '-o', 'json']);
  if (vnet.status !== 0) {
    if (isArmNotFound(vnet.stderr)) {
      notes.push(`hub VNet ${hubVnetName}: ARM answered not-found — greenfield, nothing to adopt.`);
      return { status: 'ok', vpnGatewayName: '', apimDnsLinkName: '', hubVnetFound: false, notes, reason: null };
    }
    return {
      status: 'unreadable',
      vpnGatewayName: '',
      apimDnsLinkName: '',
      hubVnetFound: false,
      notes,
      reason:
        `the hub VNet ${hubVnetName} could not be READ (az exit ${vnet.status}): ` +
        `${(vnet.stderr || 'az produced no output').trim().split(/\r?\n/)[0]}. ` +
        'Whether a VPN gateway or zone link exists is NOT known; nothing is asserted.',
    };
  }
  let hubVnetId;
  try {
    hubVnetId = JSON.parse(vnet.stdout)?.id;
  } catch {
    hubVnetId = null;
  }
  if (!hubVnetId) {
    return {
      status: 'unreadable',
      vpnGatewayName: '',
      apimDnsLinkName: '',
      hubVnetFound: false,
      notes,
      reason: `az returned the hub VNet but its id could not be parsed; nothing is asserted.`,
    };
  }

  // 2. VPN gateway on that VNet.
  const gws = run(['network', 'vnet-gateway', 'list', '-g', resourceGroup, ...sub, '-o', 'json']);
  if (gws.status !== 0) {
    return {
      status: 'unreadable',
      vpnGatewayName: '',
      apimDnsLinkName: '',
      hubVnetFound: true,
      notes,
      reason:
        `the virtual network gateways in ${resourceGroup} could not be LISTED (az exit ${gws.status}): ` +
        `${(gws.stderr || 'az produced no output').trim().split(/\r?\n/)[0]}. ` +
        'A create-new deploy against an unknown gateway state risks MultipleGatewaysOfTypeVpnUseSameVnet; nothing is asserted.',
    };
  }
  let vpnGatewayName = '';
  try {
    vpnGatewayName = findVpnGatewayForVnet(JSON.parse(gws.stdout), hubVnetId) ?? '';
  } catch {
    return {
      status: 'unreadable',
      vpnGatewayName: '',
      apimDnsLinkName: '',
      hubVnetFound: true,
      notes,
      reason: 'az returned a gateway list that is not JSON; nothing is asserted.',
    };
  }
  notes.push(
    vpnGatewayName
      ? `VPN gateway: ADOPT existing '${vpnGatewayName}' (one Vpn gateway per VNet — create-new cannot succeed).`
      : 'VPN gateway: none on the hub VNet — create-new proceeds.',
  );

  // 3. The azure-api.net link for that VNet. A missing ZONE is ARM answering
  //    "not found" — genuinely nothing to adopt.
  const links = run([
    'network', 'private-dns', 'link', 'vnet', 'list',
    '-g', resourceGroup, '-z', APIM_GATEWAY_ZONE, ...sub, '-o', 'json',
  ]);
  let apimDnsLinkName = '';
  if (links.status !== 0) {
    if (isArmNotFound(links.stderr)) {
      notes.push(`zone ${APIM_GATEWAY_ZONE}: ARM answered not-found — nothing to adopt.`);
    } else {
      return {
        status: 'unreadable',
        vpnGatewayName,
        apimDnsLinkName: '',
        hubVnetFound: true,
        notes,
        reason:
          `the ${APIM_GATEWAY_ZONE} zone links could not be LISTED (az exit ${links.status}): ` +
          `${(links.stderr || 'az produced no output').trim().split(/\r?\n/)[0]}. ` +
          'A create-new link against an unknown link state risks the 409 Conflict; nothing is asserted.',
      };
    }
  } else {
    try {
      apimDnsLinkName = findZoneLinkForVnet(JSON.parse(links.stdout), hubVnetId) ?? '';
    } catch {
      return {
        status: 'unreadable',
        vpnGatewayName,
        apimDnsLinkName: '',
        hubVnetFound: true,
        notes,
        reason: 'az returned a zone-link list that is not JSON; nothing is asserted.',
      };
    }
    notes.push(
      apimDnsLinkName
        ? `${APIM_GATEWAY_ZONE} link: ADOPT existing '${apimDnsLinkName}' (one link per zone/VNet pair — a new name 409s).`
        : `${APIM_GATEWAY_ZONE} link: none for the hub VNet — create-new proceeds.`,
    );
  }

  return { status: 'ok', vpnGatewayName, apimDnsLinkName, hubVnetFound: true, notes, reason: null };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { resourceGroup: null, hubVnetName: null, subscription: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--resource-group' || a === '-g') out.resourceGroup = argv[++i];
    else if (a === '--hub-vnet-name') out.hubVnetName = argv[++i];
    else if (a === '--subscription') out.subscription = argv[++i];
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`preflight-brownfield-adopt: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  }
  if (!args.resourceGroup || !args.hubVnetName) {
    process.stderr.write('preflight-brownfield-adopt: --resource-group and --hub-vnet-name are required.\n');
    process.exit(EXIT.USAGE);
  }

  const r = discover(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    for (const n of r.notes) process.stdout.write(`${n}\n`);
    if (r.reason) process.stdout.write(`${r.reason}\n`);
  }
  if (r.status !== 'ok') {
    process.stderr.write(`preflight-brownfield-adopt: UNREADABLE — ${r.reason}\n`);
    process.exit(EXIT.UNREADABLE);
  }
  process.exit(EXIT.OK);
}

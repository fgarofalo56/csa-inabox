#!/usr/bin/env node
/**
 * preflight-private-dns-links.mjs — ADOPT OR FAIL CLEARLY, never collide.
 *
 * WHY (issue #3039, deploy-integrity.md R5/R6/R7)
 *
 *   Azure permits a virtual network at most ONE Private DNS zone link per
 *   namespace. On 2026-08-06 the Commercial reconcile died on:
 *
 *     privatelink.azuredatabricks.net/link-hub
 *     BadRequest: A virtual network cannot be linked to multiple zones with
 *     overlapping namespaces. You tried to link virtual network with
 *     'privatelink.azuredatabricks.net' and 'privatelink.azuredatabricks.net'.
 *
 *   The hub VNet was already linked to a DIFFERENT zone of that name, left in
 *   the DLZ resource group by a superseded design in which the DLZ owned it.
 *   admin-plane/network.bicep now owns it (index 23, #1466), and its link can
 *   therefore NEVER be created. Every future run fails the same way.
 *
 *   A raw ARM BadRequest reaching the operator is an R6 violation. This runs
 *   BEFORE the deploy, names the owning zone, and says exactly what to do.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT (R7)
 *
 *   It establishes, from Azure Resource Graph: every privatelink zone in the
 *   tenant that is linked to the named hub VNet, and which resource group and
 *   subscription each of those zones lives in.
 *
 *   It does NOT enumerate the namespaces admin-plane/network.bicep is about to
 *   create — that array carries per-boundary ternaries and re-deriving it here
 *   would be a second copy free to drift. The set checked is therefore
 *
 *       (zones that already exist in --zone-rg)  ∪  (--expect-namespaces)
 *
 *   which covers the reconcile case exactly (the owner zone exists) and the
 *   greenfield case trivially (a fresh hub VNet has no links at all). A
 *   namespace being ADDED to network.bicep in the same release that first
 *   collides is the one case this cannot see, and it says so rather than
 *   implying full coverage. Pass --expect-namespaces to close that gap for a
 *   specific namespace.
 *
 * USAGE
 *   node scripts/csa-loom/preflight-private-dns-links.mjs \
 *     --hub-vnet-id <arm id of the hub VNet> \
 *     --zone-rg rg-csa-loom-admin-<region> [--zone-subscription <sub>] \
 *     [--expect-namespaces privatelink.a.net,privatelink.b.net] [--json]
 *
 *   Exit: 0 clean/converged | 1 conflict | 2 usage | 3 could not read.
 *
 * Tests: node --test scripts/csa-loom/__tests__/preflight-private-dns-links.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ CLEAN: 0, CONFLICT: 1, USAGE: 2, UNREADABLE: 3 });

/**
 * Links to one VNet, tenant-wide. `resources` in Resource Graph spans every
 * subscription the identity can read, which is what makes a cross-subscription
 * leftover visible at all — the failing zone lives in the DLZ subscription and
 * the deploy runs against the admin one.
 */
export const LINKS_QUERY = [
  "resources",
  "| where type =~ 'microsoft.network/privatednszones/virtualnetworklinks'",
  '| extend vnet = tolower(tostring(properties.virtualNetwork.id))',
  '| project linkName = name, linkId = id, zoneRg = resourceGroup, zoneSub = subscriptionId, vnet',
].join(' ');

export const ZONES_QUERY = [
  'resources',
  "| where type =~ 'microsoft.network/privatednszones'",
  '| project zoneName = name, zoneId = id, zoneRg = resourceGroup, zoneSub = subscriptionId',
].join(' ');

/** `…/privateDnsZones/<namespace>/virtualNetworkLinks/<link>` → `<namespace>`. */
export function namespaceOfLink(linkId) {
  const m = /\/privateDnsZones\/([^/]+)\/virtualNetworkLinks\//i.exec(String(linkId ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** …and the zone's own resource id. */
export function zoneIdOfLink(linkId) {
  const m = /^(.*\/privateDnsZones\/[^/]+)\/virtualNetworkLinks\//i.exec(String(linkId ?? ''));
  return m ? m[1] : null;
}

export const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** The subscription segment of an ARM id, lower-cased, or null. */
export function subscriptionOf(armId) {
  const m = /\/subscriptions\/([^/]+)/i.exec(String(armId ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The Azure CLI binary. Linux/macOS (and every CI runner this project uses) get
 * a real executable and `shell: false`. Windows ships `az.cmd`, which Node 20+
 * refuses to spawn without a shell (EINVAL), so it is spawned through one
 * there. `LOOM_AZ_BIN` overrides both for an unusual install.
 */
export function azBinary() {
  if (process.env.LOOM_AZ_BIN) return process.env.LOOM_AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

export function azGraphRunner(query, subscriptions) {
  // The KQL is passed via the Azure CLI's `@file` argument-loading rather than
  // inline. On Windows `az.cmd` must be spawned through cmd.exe, and cmd treats
  // the `|` in a KQL pipeline as a shell pipe — which turned the whole query
  // into "'project' is not recognized as an internal or external command".
  // `@file` keeps every argument free of shell metacharacters on every
  // platform, so there is one code path rather than a Windows special case that
  // only local runs exercise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dns-preflight-'));
  const qf = path.join(dir, 'query.kql');
  fs.writeFileSync(qf, query, 'utf8');
  const args = ['graph', 'query', '-q', `@${qf}`, '--first', '1000', '-o', 'json'];
  if (subscriptions?.length) args.push('--subscriptions', ...subscriptions);
  const bin = azBinary();
  try {
    const res = spawnSync(bin, args, {
      encoding: 'utf8',
      shell: /\.(cmd|bat)$/i.test(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) return { status: 127, stdout: '', stderr: res.error.message };
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readGraph(run, query, subscriptions) {
  const res = run(query, subscriptions);
  if (res.status !== 0) {
    return { ok: false, reason: `az graph query exited ${res.status}: ${(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ')}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || 'null');
  } catch (e) {
    return { ok: false, reason: `az graph query returned output that is not JSON: ${e.message}` };
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'az graph query returned no `data` array; nothing is asserted about the estate.' };
  }
  return { ok: true, rows };
}

/**
 * @returns {{status:'clean'|'conflict'|'unreadable', conflicts:Array, converged:Array,
 *            checkedNamespaces:string[], notes:string[], reason:string|null}}
 */
export function analyseDnsLinks({
  hubVnetId,
  zoneRg,
  zoneSubscription = null,
  expectNamespaces = [],
  run = azGraphRunner,
}) {
  const subs = zoneSubscription ? [zoneSubscription] : [];
  const zones = readGraph(run, ZONES_QUERY, []);
  if (!zones.ok) {
    return { status: 'unreadable', conflicts: [], converged: [], checkedNamespaces: [], notes: [], reason: zones.reason };
  }
  const links = readGraph(run, LINKS_QUERY, []);
  if (!links.ok) {
    return { status: 'unreadable', conflicts: [], converged: [], checkedNamespaces: [], notes: [], reason: links.reason };
  }

  const ownedZones = zones.rows.filter(
    (z) =>
      String(z.zoneRg ?? '').toLowerCase() === String(zoneRg ?? '').toLowerCase() &&
      (subs.length === 0 || subs.some((s) => String(z.zoneSub ?? '').toLowerCase() === s.toLowerCase())),
  );
  const ownedByNamespace = new Map(ownedZones.map((z) => [String(z.zoneName).toLowerCase(), z]));

  const checked = new Set([
    ...ownedByNamespace.keys(),
    ...expectNamespaces.map((n) => n.trim().toLowerCase()).filter(Boolean),
  ]);

  const hubLinks = links.rows.filter((l) => sameId(l.vnet, hubVnetId));
  const hubSubscription = subscriptionOf(hubVnetId);

  const conflicts = [];
  const converged = [];
  for (const l of hubLinks) {
    const ns = namespaceOfLink(l.linkId);
    if (!ns || !checked.has(ns)) continue;
    const owner = ownedByNamespace.get(ns);
    const linkZoneId = zoneIdOfLink(l.linkId);
    if (owner && sameId(owner.zoneId, linkZoneId)) {
      converged.push({ namespace: ns, zoneRg: l.zoneRg, linkName: l.linkName });
      continue;
    }
    conflicts.push({
      namespace: ns,
      linkName: l.linkName,
      owningZoneRg: l.zoneRg,
      owningZoneSubscription: l.zoneSub,
      // Stated only when it is TRUE. The first cut printed "(a different
      // subscription)" for every conflict because the field was merely
      // non-empty — asserting a cross-subscription layout it had not
      // established (deploy-integrity.md R7).
      crossSubscription: hubSubscription !== null && String(l.zoneSub ?? '').toLowerCase() !== hubSubscription,
      owningZoneId: linkZoneId,
      intendedZoneRg: zoneRg,
      intendedZoneId: owner?.zoneId ?? null,
    });
  }

  const notes = [];
  if (expectNamespaces.length === 0) {
    notes.push(
      `the namespaces checked (${checked.size}) are the zones that already exist in ${zoneRg}; a namespace ` +
        'being ADDED to admin-plane/network.bicep in this same release is not among them. Pass ' +
        '--expect-namespaces to include it.',
    );
  }

  return {
    status: conflicts.length > 0 ? 'conflict' : 'clean',
    conflicts,
    converged,
    checkedNamespaces: [...checked].sort(),
    notes,
    reason: null,
  };
}

export function render(result, { hubVnetName = 'the hub VNet' } = {}) {
  if (result.status === 'unreadable') {
    return (
      'Private DNS link preflight: COULD NOT READ the estate, so NOTHING is asserted about whether a ' +
      `conflicting link exists. ${result.reason} Fix the read (the deploy identity needs Reader over the ` +
      'subscriptions that hold the private DNS zones) and re-run — this preflight is not being skipped.'
    );
  }
  if (result.status === 'clean') {
    return (
      `Private DNS link preflight: OK. Of the ${result.checkedNamespaces.length} namespace(s) checked, ` +
      `${hubVnetName} is already linked to ${result.converged.length} — every one of them on the zone in ` +
      'the intended resource group — and to no foreign zone of any of them. No overlapping-namespace ' +
      `conflict.${result.notes.length ? ` Note: ${result.notes.join(' ')}` : ''}`
    );
  }
  const lines = result.conflicts.map(
    (c) =>
      `  ${c.namespace}: ${hubVnetName} is already linked (link "${c.linkName}") to the zone in ` +
      `resource group "${c.owningZoneRg}"${c.crossSubscription ? ' (in a DIFFERENT subscription)' : ''}` +
      `, not to the one in "${c.intendedZoneRg}". Azure permits one link per namespace per VNet, so the ` +
      'deploy cannot add its own and will fail with "A virtual network cannot be linked to multiple zones ' +
      'with overlapping namespaces".',
  );
  return [
    `Private DNS link preflight: ${result.conflicts.length} CONFLICT(S) — this deploy would fail.`,
    ...lines,
    '',
    'DO NOT delete the existing link first: the A records live in that zone and removing the link takes the',
    'service dark. Adopt the namespace in the safe order instead:',
    '',
    '  node scripts/csa-loom/migrate-private-dns-zone-owner.mjs \\',
    `    --namespace ${result.conflicts[0].namespace} \\`,
    `    --keep-zone-rg ${result.conflicts[0].intendedZoneRg} \\`,
    `    --stale-zone-rg ${result.conflicts[0].owningZoneRg} \\`,
    '    --hub-vnet-id <hub vnet id> --stale-zone-subscription <sub>   # add --apply to execute',
    '',
    'It repoints the private-endpoint DNS zone groups at the surviving zone, links both VNets to it,',
    'VERIFIES the record resolves, and only then removes the stale zone. It is idempotent and a no-op',
    'once converged.',
  ].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    hubVnetId: null,
    zoneRg: null,
    zoneSubscription: null,
    expectNamespaces: [],
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hub-vnet-id') out.hubVnetId = argv[++i];
    else if (a === '--zone-rg') out.zoneRg = argv[++i];
    else if (a === '--zone-subscription') out.zoneSubscription = argv[++i];
    else if (a === '--expect-namespaces') out.expectNamespaces = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`preflight-private-dns-links: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  }
  if (!args.hubVnetId || !args.zoneRg) {
    process.stderr.write('preflight-private-dns-links: --hub-vnet-id and --zone-rg are required.\n');
    process.exit(EXIT.USAGE);
  }
  const result = analyseDnsLinks(args);
  const hubVnetName = String(args.hubVnetId).split('/').pop();
  process.stdout.write(
    args.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result, { hubVnetName })}\n`,
  );
  process.exit(
    result.status === 'clean' ? EXIT.CLEAN : result.status === 'conflict' ? EXIT.CONFLICT : EXIT.UNREADABLE,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

#!/usr/bin/env node
/**
 * governance-run.mjs - W0 entry point used by the dispatchable workflow
 * .github/workflows/governance-w0-measure.yml and by hand.
 *
 *   node scripts/measure/governance-run.mjs --boundary Commercial|GCC-High \
 *        [--subscriptions a,b] [--tenant TID] [--out out.json]
 *
 * Read-only. Runs the ARM inventory, finds Purview accounts, reads each
 * account's data plane (GET only), computes expected-vs-registered and the
 * cost table, and writes ONE json file of names/ids/counts. Exits 2 when any
 * top-level section is not MEASURED so a blind run cannot look green.
 *
 * The active az cloud must match --boundary or the run refuses before reading
 * anything (same guard as scripts/measure/estate-resume.mjs).
 */
import { writeFileSync } from 'node:fs';
import { az as azJson, MeasurementError } from './measure.mjs';
import { collectInventory } from './governance-arm-inventory.mjs';
import { measureDataPlane } from './governance-purview-dataplane.mjs';
import { expectedSources, diffRegistered, scrub, STATE } from './governance-lib.mjs';

export const CLOUD_FOR_BOUNDARY = { Commercial: 'AzureCloud', 'GCC-High': 'AzureUSGovernment' };

export function assertCloud(boundary, activeCloud) {
  const want = CLOUD_FOR_BOUNDARY[boundary];
  if (!want) throw new MeasurementError(`unknown boundary ${boundary}`);
  if (activeCloud !== want) {
    throw new MeasurementError(`boundary ${boundary} needs az cloud ${want} but the active cloud is ${String(activeCloud)}; refusing before any read`);
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

export async function main(o, azFn = azJson) {
  const boundary = o.boundary || 'Commercial';
  assertCloud(boundary, azFn(['account', 'show', '--query', 'environmentName']));
  const subs = o.subscriptions ? o.subscriptions.split(',').filter(Boolean) : azFn(['account', 'list', '--query', '[?state==`Enabled`].id']);
  const inv = collectInventory(subs, azFn);
  const out = { boundary, subscriptions: subs, inventory: inv, accounts: [], state: STATE.MEASURED };
  if (inv.state !== STATE.MEASURED) { out.state = inv.state; return out; }
  const exp = expectedSources(inv.resources, { containers: inv.containers });
  out.expected = { count: exp.expected.length, sources: exp.expected.map(({ id, name, kind, resourceGroup }) => ({ id, name, kind, resourceGroup })), notScannable: exp.notScannable, excludedCount: exp.excluded.length };
  const accounts = inv.resources.filter((r) => r.type?.toLowerCase() === 'microsoft.purview/accounts');
  out.purviewAccountCount = accounts.length;
  for (const a of accounts) {
    const arm = azFn(['resource', 'show', '--subscription', a.subscriptionId, '--ids', a.id]);
    const dp = await measureDataPlane({ account: a.name, tenant: o.tenant, boundary });
    const registered = dp.dataSources?.state === STATE.MEASURED ? dp.dataSources.value : null;
    out.accounts.push({
      name: a.name, resourceGroup: a.resourceGroup, location: a.location, sku: arm.sku,
      identityPresent: Boolean(arm.identity?.principalId), publicNetworkAccess: arm.properties?.publicNetworkAccess,
      endpoints: arm.properties?.endpoints, privateEndpointConnections: (arm.properties?.privateEndpointConnections ?? []).length,
      dataPlane: dp, diff: diffRegistered(exp.expected, registered),
    });
    if (dp.state !== STATE.MEASURED) out.state = STATE.BLOCKED;
  }
  if (accounts.length === 0) out.state = STATE.INCONCLUSIVE;
  return out;
}

if (process.argv[1]?.endsWith('governance-run.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  const res = await main(o);
  const text = scrub(JSON.stringify(res, null, 2));
  if (o.out) writeFileSync(o.out, text); else console.log(text);
  if (res.state !== STATE.MEASURED) process.exit(2);
}

#!/usr/bin/env node
/**
 * governance-cost.mjs - W0 scan-cost estimate, with provenance on every input.
 *
 *   node scripts/measure/governance-cost.mjs --inventory temp/inv.json --region eastus2 [--out file.json]
 *
 * Inputs are tagged so measured and assumed numbers never blend:
 *   published  - read at run time from the public Azure Retail Prices API
 *                (prices.azure.com, unauthenticated GET)
 *   measured   - counted from the ARM inventory this tool was given
 *   assumed    - a scenario knob with NO measurement behind it (vCores per
 *                scan, scan duration). Microsoft Learn publishes neither.
 * The result is therefore a table over the assumed knobs, not one number.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { blocked, scrub, expectedSources, scanCostMonthly, STATE } from './governance-lib.mjs';

/** Pick the two meters from a Retail Prices API item list. Throws if either is missing or ambiguous. */
export function pickRates(items) {
  const one = (pred, label) => {
    const hits = items.filter(pred);
    if (hits.length !== 1) throw new Error(`expected exactly 1 meter for ${label}, found ${hits.length}`);
    if (!(hits[0].retailPrice > 0)) throw new Error(`meter ${label} has non-positive price ${hits[0].retailPrice}`);
    return hits[0].retailPrice;
  };
  return {
    cuPerHour: one((i) => /Data Map/i.test(i.productName) && i.meterName === 'Standard Capacity Unit', 'Data Map Standard Capacity Unit'),
    vcoreHour: one((i) => /Scanning/i.test(i.productName) && i.meterName === 'Standard vCore', 'Scanning Standard vCore'),
  };
}

export async function fetchRates(region, fetchFn = fetch) {
  const filter = `serviceName eq 'Azure Purview' and armRegionName eq '${region}'`;
  const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`retail prices API answered HTTP ${res.status}`);
  const j = await res.json();
  return pickRates(j.Items ?? []);
}

/**
 * Scenario table. fullScansPerMonth=1 models the enrolment backfill amortised
 * over a month (worst case, every source re-fully-scanned monthly); incremental
 * is weekly (PRP D3 default = ~4.33/month).
 */
export function scenarios({ rates, sourceCount, capacityUnits }) {
  const rows = [];
  for (const vcores of [8, 16, 32]) {
    for (const [name, fullH, incrH] of [['small', 0.25, 0.1], ['medium', 1, 0.25], ['large', 4, 1]]) {
      const sources = Array.from({ length: sourceCount }, () => ({ fullScansPerMonth: 1, fullHours: fullH, incrScansPerMonth: 4.33, incrHours: incrH }));
      const c = scanCostMonthly({ cuRate: rates.cuPerHour, vcoreRate: rates.vcoreHour, capacityUnits, vcoresPerScan: vcores, sources });
      rows.push({ vcoresPerScan: vcores, duration: name, fullHours: fullH, incrHours: incrH, scanUsdPerMonth: +c.scanUsd.toFixed(2), scanUsdPerDay: +c.perDayScanUsd.toFixed(2) });
    }
  }
  return rows;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

if (process.argv[1]?.endsWith('governance-cost.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  const inv = JSON.parse(readFileSync(o.inventory, 'utf8'));
  let out;
  if (inv.state !== STATE.MEASURED) {
    out = { state: STATE.INCONCLUSIVE, reason: 'inventory was not MEASURED; no source count to price' };
  } else {
    const region = o.region || 'eastus2';
    try {
      const rates = await fetchRates(region);
      const exp = expectedSources(inv.resources, { containers: inv.containers });
      const sourceCount = exp.expected.length;
      const capacityUnits = Number(o.capacity || 1);
      out = {
        state: STATE.MEASURED,
        inputs: {
          region: { value: region, provenance: 'published' },
          cuPerHourUsd: { value: rates.cuPerHour, provenance: 'published (Azure Retail Prices API)' },
          vcoreHourUsd: { value: rates.vcoreHour, provenance: 'published (Azure Retail Prices API)' },
          capacityUnits: { value: capacityUnits, provenance: 'measured (ARM sku.capacity of the account)' },
          sourcesToRegister: { value: sourceCount, provenance: 'measured (ARM inventory, Loom-owned, scannable kinds)' },
          vcoresPerScan: { value: [8, 16, 32], provenance: 'ASSUMED: Learn publishes no per-scan vCore figure' },
          scanDurationHours: { value: 'small 0.25/0.1, medium 1/0.25, large 4/1 (full/incremental)', provenance: 'ASSUMED: no scan history exists to measure (see data-plane BLOCKED)' },
        },
        formula: 'monthly = capacityUnits*cuRate*730 + sum_sources(fullScans*fullHours + incrScans*incrHours) * vcoresPerScan * vcoreRate',
        baseMonthlyUsd: +(capacityUnits * rates.cuPerHour * 730).toFixed(2),
        scenarios: scenarios({ rates, sourceCount, capacityUnits }),
      };
    } catch (e) {
      out = blocked('purview price rates', { reason: e.message, who: 'operator: retry; prices.azure.com unreachable or response shape changed' });
    }
  }
  const text = scrub(JSON.stringify(out, null, 2));
  if (o.out) writeFileSync(o.out, text); else console.log(text);
  if (out.state !== STATE.MEASURED) process.exit(2);
}

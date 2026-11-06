#!/usr/bin/env node
// Create-and-delete ADX capacity probe for Azure Government. Refs #5123.
//
// WHY: `gov-adx-sku-probe.yml` reads list-sku and cannot see the runtime refusal
// `InsufficientResourcesForSubscription: no available resources for the cluster`,
// which blocked the GCC-High deploy for ~18 hours (Virginia L8as_v3, Arizona
// E8as_v5). The only instrument that sees it is an actual create.
//
// Each candidate SKU gets a throwaway cluster via a one-resource ARM deployment
// (the deployment error carries the real message; `cluster show` does not).
// Every cluster is deleted in `finally`, and leftovers named `adxprobe-*` are
// swept, so a crashed earlier run cannot keep billing.
//
// Verdicts never overstate: a deployment still running at the timeout is
// `inconclusive` (NOT refused, NOT accepted).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROBE_PREFIX = 'adxprobe-';

// Order matters: the capacity refusal is checked before the generic "not available".
export function classify(state, errorText) {
  const err = String(errorText ?? '');
  if (state === 'Succeeded') return 'accepted';
  if (/InsufficientResourcesForSubscription|no available resources/i.test(err)) return 'capacity-refused';
  if (/SkuNotAvailable|NotAvailableForSubscription|not available in (the )?(location|region)/i.test(err)) return 'not-offered';
  if (/QuotaExceeded/i.test(err)) return 'quota';
  if (state === 'Failed' || state === 'Canceled') return 'failed-other';
  return 'inconclusive';
}

export function template(clusterName, sku, capacity, region) {
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    resources: [
      {
        type: 'Microsoft.Kusto/clusters',
        apiVersion: '2023-08-15',
        name: clusterName,
        location: region,
        sku: { name: sku, tier: 'Standard', capacity },
      },
    ],
  };
}

function azRunner(args) {
  const r = spawnSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const sleep = (s) => new Promise((res) => setTimeout(res, s * 1000));

export async function probeOne({ az, sku, idx, rg, region, capacity, maxWait, poll, dir, sleepFn = sleep, runId = '' }) {
  const cluster = `${PROBE_PREFIX}${runId}${idx}`.slice(0, 22);
  const dep = `adxprobe-dep-${runId}${idx}`;
  const file = join(dir, `${cluster}.json`);
  writeFileSync(file, JSON.stringify(template(cluster, sku, capacity, region)));
  let detail = '';
  try {
    const c = az(['deployment', 'group', 'create', '-g', rg, '-n', dep, '--template-file', file, '--no-wait', '-o', 'none']);
    if (c.status !== 0) {
      detail = (c.stderr || c.stdout).trim();
      return { sku, cluster, verdict: classify('Failed', detail), detail };
    }
    for (let waited = 0; waited <= maxWait; waited += poll) {
      const s = az(['deployment', 'group', 'show', '-g', rg, '-n', dep, '--query', '{s:properties.provisioningState,e:properties.error}', '-o', 'json']);
      if (s.status !== 0) {
        detail = `could not read deployment state: ${(s.stderr || '').trim()}`;
        break;
      }
      let parsed;
      try {
        parsed = JSON.parse(s.stdout);
      } catch {
        detail = 'unparseable deployment state';
        break;
      }
      if (['Succeeded', 'Failed', 'Canceled'].includes(parsed.s)) {
        detail = parsed.e ? JSON.stringify(parsed.e) : '';
        if (parsed.s !== 'Succeeded') {
          // The deployment error only says "terminal provisioning state Failed"; the
          // RP's real message (e.g. InsufficientResourcesForSubscription) lives on the operation.
          const ops = az(['deployment', 'operation', 'group', 'list', '-g', rg, '-n', dep, '--query', "[?properties.provisioningState=='Failed'].properties.statusMessage", '-o', 'json']);
          detail += ops.status === 0 ? ` OPERATIONS=${ops.stdout.replace(/\s+/g, ' ').trim()}` : ' OPERATIONS=unreadable';
        }
        return { sku, cluster, verdict: classify(parsed.s, detail), detail };
      }
      await sleepFn(poll);
    }
    return { sku, cluster, verdict: 'inconclusive', detail: detail || `still running after ${maxWait}s` };
  } finally {
    az(['kusto', 'cluster', 'delete', '-g', rg, '-n', cluster, '--yes', '--no-wait']);
    az(['deployment', 'group', 'delete', '-g', rg, '-n', dep, '--no-wait']);
  }
}

export function sweep(az, rg) {
  const l = az(['kusto', 'cluster', 'list', '-g', rg, '--query', `[?starts_with(name, '${PROBE_PREFIX}')].name`, '-o', 'tsv']);
  if (l.status !== 0) return { ok: false, left: [], note: (l.stderr || '').trim() };
  const names = l.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (const n of names) az(['kusto', 'cluster', 'delete', '-g', rg, '-n', n, '--yes', '--no-wait']);
  return { ok: true, left: names, note: '' };
}

export async function main(argv, az = azRunner) {
  const o = { region: 'usgovarizona', skus: '', capacity: 2, rg: '', maxWait: 1500, poll: 30 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (k in o) o[k] = typeof o[k] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  const skus = o.skus.split(',').map((s) => s.trim()).filter(Boolean);
  if (!skus.length || !o.rg) {
    console.error('usage: --rg <rg> --skus a,b [--region r] [--capacity n] [--max-wait s]');
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'adxprobe-'));
  const runId = String(Date.now() % 1e5);
  const results = [];
  try {
    // Sequential: parallel creates would compete for the same capacity and blur each verdict.
    for (let i = 0; i < skus.length; i++) {
      const r = await probeOne({ az, sku: skus[i], idx: i, rg: o.rg, region: o.region, capacity: o.capacity, maxWait: o.maxWait, poll: o.poll, dir, runId });
      console.log(`${r.verdict.padEnd(17)} ${r.sku}  (${o.region}, capacity ${o.capacity})  ${r.detail.slice(-1200)}`);
      results.push(r);
    }
  } finally {
    const sw = sweep(az, o.rg);
    console.log(sw.ok ? `sweep: ${sw.left.length} ${PROBE_PREFIX}* cluster(s) found and deleted` : `sweep: COULD NOT LIST (${sw.note}) - check ${o.rg} for ${PROBE_PREFIX}* clusters by hand`);
    rmSync(dir, { recursive: true, force: true });
  }
  const accepted = results.filter((r) => r.verdict === 'accepted').map((r) => r.sku);
  console.log(`\nACCEPTED: ${accepted.length ? accepted.join(', ') : 'none'}`);
  return accepted.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

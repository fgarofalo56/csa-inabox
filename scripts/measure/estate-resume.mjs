#!/usr/bin/env node
/**
 * estate-resume.mjs — bring back exactly what was paused on 2026-08-23.
 *
 *   node scripts/measure/estate-resume.mjs --dry-run   # show what WOULD change
 *   node scripts/measure/estate-resume.mjs --apply     # do it
 *
 * Scope is a fixed list, deliberately. Of the 13 Container App environments in
 * these subscriptions only ONE is Loom's — the rest are a blog, Sentinel, two
 * Atlas estates and six others — so nothing here is discovered dynamically and
 * nothing outside this list is touched.
 *
 * Every action verifies its own outcome. A resume that reports success without
 * confirming state is the failure this directory exists to prevent.
 */

import { run, az, MeasurementError } from './measure.mjs';

const RG_ADMIN = 'rg-csa-loom-admin-centralus';
const RG_DLZ = 'rg-csa-loom-dlz-default-centralus';

// Paused 2026-08-23. minReplicas restored to what each carried BEFORE.
const APPS = [
  { name: 'loom-capacity-broker', rg: RG_ADMIN, min: 2 },
  { name: 'loom-activator', rg: RG_ADMIN, min: 1 },
  { name: 'loom-dbt-r2', rg: RG_ADMIN, min: 1 },
  { name: 'loom-direct-lake-shim', rg: RG_ADMIN, min: 1 },
  { name: 'loom-mirroring', rg: RG_ADMIN, min: 1 },
  { name: 'loom-onelake', rg: RG_ADMIN, min: 1 },
  { name: 'loom-prpt-r3', rg: RG_ADMIN, min: 1 },
  { name: 'loom-wrangler-h2', rg: RG_ADMIN, min: 1 },
];
const AAS = [
  { name: 'aasloomk6mvh5sm6z7do', rg: RG_ADMIN, note: 'S1' },
  { name: 'loomdefault', rg: RG_DLZ, note: 'B1' },
];
const ADX = { name: 'adx-csa-loom-z52x3p', rg: RG_ADMIN };

const APPLY = process.argv.includes('--apply');
const DRY = process.argv.includes('--dry-run') || !APPLY;
if (DRY) console.log('DRY RUN — nothing will be changed. Pass --apply to act.\n');

function subFor(name) {
  const rows = az(['graph', 'query', '-q',
    `resources | where name =~ '${name}' | project sub=subscriptionId | limit 1`]);
  const d = rows?.data ?? rows;
  if (!Array.isArray(d) || d.length === 0) {
    throw new MeasurementError(`cannot resolve a subscription for '${name}' — refusing to guess`);
  }
  return d[0].sub;
}

let changed = 0, skipped = 0, failed = 0;

console.log('=== Container Apps ===');
for (const a of APPS) {
  try {
    const sub = subFor(a.name);
    const before = az(['containerapp', 'show', '-n', a.name, '-g', a.rg, '--subscription', sub,
      '--query', 'properties.template.scale.minReplicas']);
    if (Number(before) >= a.min) {
      console.log(`  ${a.name.padEnd(24)} already at ${before} (target ${a.min}) — skip`);
      skipped++; continue;
    }
    if (DRY) { console.log(`  ${a.name.padEnd(24)} ${before} -> ${a.min}  [would change]`); changed++; continue; }
    run('az', ['containerapp', 'update', '-n', a.name, '-g', a.rg, '--subscription', sub,
      '--min-replicas', String(a.min)]);
    const after = az(['containerapp', 'show', '-n', a.name, '-g', a.rg, '--subscription', sub,
      '--query', 'properties.template.scale.minReplicas']);
    console.log(`  ${a.name.padEnd(24)} ${before} -> ${after} ${Number(after) === a.min ? 'OK' : 'MISMATCH'}`);
    changed++;
  } catch (e) {
    console.log(`  ${a.name.padEnd(24)} FAILED: ${String(e.message).slice(0, 90)}`);
    failed++;
  }
}

console.log('\n=== Analysis Services ===');
for (const s of AAS) {
  try {
    const sub = subFor(s.name);
    const args = ['resource', 'show', '--resource-type', 'Microsoft.AnalysisServices/servers',
      '-n', s.name, '-g', s.rg, '--subscription', sub, '--query', 'properties.state'];
    const before = az(args);
    if (String(before).toLowerCase() === 'succeeded') {
      console.log(`  ${s.name.padEnd(24)} already running — skip`); skipped++; continue;
    }
    if (DRY) { console.log(`  ${s.name.padEnd(24)} ${before} -> resume  [would change] (${s.note})`); changed++; continue; }
    run('az', ['resource', 'invoke-action', '--resource-type', 'Microsoft.AnalysisServices/servers',
      '-n', s.name, '-g', s.rg, '--subscription', sub, '--action', 'resume']);
    const after = az(args);
    console.log(`  ${s.name.padEnd(24)} ${before} -> ${after} (${s.note})`);
    changed++;
  } catch (e) {
    console.log(`  ${s.name.padEnd(24)} FAILED: ${String(e.message).slice(0, 90)}`);
    failed++;
  }
}

console.log('\n=== ADX ===');
try {
  const sub = subFor(ADX.name);
  const before = az(['kusto', 'cluster', 'show', '-n', ADX.name, '-g', ADX.rg, '--subscription', sub, '--query', 'state']);
  if (String(before) === 'Running') {
    console.log(`  ${ADX.name} already Running — skip`); skipped++;
  } else if (DRY) {
    console.log(`  ${ADX.name} ${before} -> Running  [would change]`); changed++;
  } else {
    run('az', ['kusto', 'cluster', 'start', '-n', ADX.name, '-g', ADX.rg, '--subscription', sub, '--no-wait']);
    console.log(`  ${ADX.name} ${before} -> start dispatched (takes several minutes; re-run to confirm)`);
    changed++;
  }
} catch (e) {
  console.log(`  ${ADX.name} FAILED: ${String(e.message).slice(0, 90)}`);
  failed++;
}

console.log(`\n${DRY ? 'WOULD CHANGE' : 'CHANGED'}: ${changed}   already-ok: ${skipped}   FAILED: ${failed}`);
if (failed > 0) {
  console.log('Some actions failed — the estate is PARTIALLY resumed. Re-run to retry; it is idempotent.');
  process.exit(1);
}
console.log('NOTE: the Synapse dedicated pool (loompool) was already paused before 2026-08-23 and');
console.log('is NOT resumed here. Resume it deliberately if you need it — it is the largest line item.');

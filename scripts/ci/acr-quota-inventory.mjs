#!/usr/bin/env node
/**
 * acr-quota-inventory.mjs - who is holding the regional VM-family quota that an
 * ACR Tasks agent pool needs? READ-ONLY. Never writes to Azure.
 *
 * WHY (2026-10-23). gov-console-roll run 40021972356 failed because pool
 * loombuild2 went to Error: "exceeding approved standardDDSv5Family Cores quota
 * ... Location: usgovvirginia, Current Limit: 100, Current Usage: 100,
 * Additional Required: 8". The first hypothesis was a LEAKED pool. The hourly
 * reaper had read that same pool at count 0 about 90 minutes earlier, so the 100 cores
 * were held by something else. This script names the holders instead of
 * guessing: regional usage vs limit per family, the visible consumers (VMs,
 * VMSS, AKS node pools, Container Apps workload profiles) with their cores, the
 * agent pools with their tier cores, and the UNATTRIBUTED remainder.
 *
 * Every read that fails is UNKNOWN, reported as such, and makes the exit code 1.
 * An unreadable consumer list is never counted as zero cores (R7).
 *
 * Usage: node acr-quota-inventory.mjs --acr <name> [--subscription <id>]
 *            [--families standardDDSv5Family,standardDSv5Family]
 * Exit:  0 every read succeeded   1 at least one read failed (UNKNOWN)   2 usage
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FAMILIES = ['standardDDSv5Family', 'standardDSv5Family'];
/** vCPUs per agent-pool instance (ACR Tasks tiers: S1 2, S2 4, S3 8). */
export const TIER_CORES = { S1: 2, S2: 4, S3: 8 };

/**
 * Pure. Attribute a family's measured usage to what can be seen.
 * usage: {currentValue, limit} | null (null = unreadable -> unknown).
 * visible: array of {cores:number|null, family}. A null `cores` is a consumer
 * whose size could not be resolved -> the remainder is unknown, not a number.
 */
export function attribute(family, usage, visible) {
  if (!usage) return { family, state: 'unknown', note: 'usage row could not be read' };
  const mine = visible.filter((v) => v.family === family);
  const unresolved = mine.filter((v) => v.cores === null).length;
  const seen = mine.reduce((n, v) => n + (v.cores ?? 0), 0);
  const free = usage.limit - usage.currentValue;
  if (unresolved > 0) {
    return { family, state: 'partial', used: usage.currentValue, limit: usage.limit, free, seen, unattributed: null,
      note: `${unresolved} consumer(s) have no resolvable core count, so the unattributed remainder is unknown` };
  }
  return { family, state: 'ok', used: usage.currentValue, limit: usage.limit, free, seen, unattributed: usage.currentValue - seen, note: '' };
}

/**
 * Pure. Derive the ARM quota family name from a VM size name, or null when the
 * name does not follow the `Standard_<series><n><suffix>_v<k>` shape.
 *   Standard_D8ds_v5 -> standardDDSv5Family   Standard_D8s_v5 -> standardDSv5Family
 *   Standard_D8d_v5  -> standardDDv5Family    Standard_D8_v5  -> standardDv5Family
 * Derived, not authoritative: irregular families (B-series, constrained-vCPU
 * sizes) can differ, which shows up as an unattributed remainder, never as a
 * silently wrong family.
 */
export function familyOf(size) {
  const m = /^Standard_([A-Z]+)(\d+)([a-z]*)(?:_(v\d+))?$/.exec(String(size ?? ''));
  if (!m) return null;
  return `standard${m[1]}${m[3].toUpperCase()}${m[4] ?? ''}Family`;
}

/** Pure. Pool instance cores for a pool row, or null if the tier is not a known one. */
export function poolCores(pool) {
  const per = TIER_CORES[String(pool.tier || '').toUpperCase()];
  return per === undefined || typeof pool.count !== 'number' ? null : per * pool.count;
}

let SUB = '';
function az(args) {
  const a = SUB ? [...args, '--subscription', SUB] : args;
  const r = spawnSync('az', [...a, '-o', 'json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-2).join(' | ') };
  try { return { ok: true, value: JSON.parse(r.stdout || 'null') }; } catch { return { ok: false, err: 'unparseable az output' }; }
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const acr = arg('--acr');
  SUB = arg('--subscription') ?? '';
  const families = (arg('--families') ?? DEFAULT_FAMILIES.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  if (!acr || families.length === 0) { console.error('usage: acr-quota-inventory.mjs --acr <name> [--subscription <id>] [--families a,b]'); return 2; }

  const unknowns = [];
  const note = (what, r) => { unknowns.push(`${what}: ${r.err}`); console.log(`::warning::${acr}: could not read ${what} (${r.err}). UNKNOWN, not zero.`); };

  const show = az(['acr', 'show', '-n', acr]);
  if (!show.ok || !show.value?.location) {
    console.log(`::error::${acr}: could not read the registry location (${show.ok ? 'no location field' : show.err}); the region's quota was NOT inspected.`);
    return 1;
  }
  const loc = String(show.value.location).toLowerCase().replace(/\s/g, '');

  const usageR = az(['vm', 'list-usage', '--location', loc]);
  if (!usageR.ok) note('vm list-usage', usageR);
  const usageOf = (fam) => {
    const row = usageR.ok ? (usageR.value || []).find((u) => u.name?.value === fam) : null;
    return row ? { currentValue: Number(row.currentValue), limit: Number(row.limit) } : null;
  };
  const regional = usageR.ok ? (usageR.value || []).find((u) => u.name?.value === 'cores') : null;

  // vCPUs per size from `vm list-sizes` (fast; `list-skus` takes minutes). The
  // family is DERIVED from the size name (familyOf), so it is labelled as derived
  // in the report; a size it cannot derive stays 'unresolved' with null cores.
  const sizesR = az(['vm', 'list-sizes', '--location', loc, '--query', '[].{n:name,c:numberOfCores}']);
  if (!sizesR.ok) note('vm list-sizes', sizesR);
  const sku = new Map((sizesR.ok ? sizesR.value || [] : []).map((s) => [String(s.n).toLowerCase(), Number(s.c)]));
  const sized = (size, n) => {
    const c = sku.get(String(size).toLowerCase());
    const family = familyOf(size);
    return c !== undefined && Number.isFinite(c) && family ? { family, cores: c * n } : { family: family ?? 'unresolved', cores: null };
  };

  const consumers = [];
  const vms = az(['vm', 'list', '--query', '[].{n:name,rg:resourceGroup,l:location,s:hardwareProfile.vmSize}']);
  if (!vms.ok) note('vm list', vms);
  for (const v of vms.ok ? vms.value || [] : []) if (String(v.l).toLowerCase() === loc) consumers.push({ kind: 'VM', name: `${v.rg}/${v.n}`, size: v.s, ...sized(v.s, 1) });
  const vmss = az(['vmss', 'list', '--query', '[].{n:name,rg:resourceGroup,l:location,s:sku.name,c:sku.capacity}']);
  if (!vmss.ok) note('vmss list', vmss);
  for (const v of vmss.ok ? vmss.value || [] : []) if (String(v.l).toLowerCase() === loc) consumers.push({ kind: 'VMSS', name: `${v.rg}/${v.n}`, size: `${v.s} x${v.c}`, ...sized(v.s, Number(v.c) || 0) });
  const aks = az(['aks', 'list', '--query', '[].{n:name,rg:resourceGroup,l:location,p:agentPoolProfiles[].{vm:vmSize,c:count,np:name}}']);
  if (!aks.ok) note('aks list', aks);
  for (const k of aks.ok ? aks.value || [] : []) {
    if (String(k.l).toLowerCase() !== loc) continue;
    for (const p of k.p || []) consumers.push({ kind: 'AKS', name: `${k.rg}/${k.n}/${p.np}`, size: `${p.vm} x${p.c}`, ...sized(p.vm, Number(p.c) || 0) });
  }
  const cae = az(['containerapp', 'env', 'list', '--query', '[].{n:name,rg:resourceGroup,l:location,w:properties.workloadProfiles[?workloadProfileType!=\'Consumption\'].{t:workloadProfileType,min:minimumCount,max:maximumCount}}']);
  if (!cae.ok) note('containerapp env list', cae);
  const caeRows = [];
  for (const e of cae.ok ? cae.value || [] : []) {
    if (String(e.l).toLowerCase() !== loc) continue;
    for (const w of e.w || []) caeRows.push(`${e.rg}/${e.n}: ${w.t} min=${w.min ?? '?'} max=${w.max ?? '?'}`);
  }

  const pools = az(['acr', 'agentpool', 'list', '-r', acr]);
  if (!pools.ok) note('acr agentpool list', pools);
  const poolRows = (pools.ok ? pools.value || [] : []).map((p) => ({ name: p.name, tier: p.tier, count: p.count, state: p.provisioningState, cores: poolCores(p) }));

  const results = families.map((f) => attribute(f, usageR.ok ? usageOf(f) : null, consumers));
  const out = [`### ACR quota inventory - ${acr} (${loc})`, ''];
  out.push('| family | used | limit | free | visible consumers | unattributed |', '|---|---|---|---|---|---|');
  for (const r of results) {
    out.push(r.state === 'unknown'
      ? `| ${r.family} | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |`
      : `| ${r.family} | ${r.used} | ${r.limit} | ${r.free} | ${r.seen} | ${r.unattributed ?? 'UNKNOWN'} |`);
  }
  if (regional) out.push('', `Total regional vCPUs: ${regional.currentValue} / ${regional.limit}`);
  out.push('', '| consumer | name | size | family (derived) | cores |', '|---|---|---|---|---|');
  for (const c of consumers) out.push(`| ${c.kind} | ${c.name} | ${c.size} | ${c.family} | ${c.cores ?? 'UNKNOWN'} |`);
  out.push('', '| agent pool | tier | count | state | cores if counted |', '|---|---|---|---|---|');
  for (const p of poolRows) out.push(`| ${p.name} | ${p.tier} | ${p.count} | ${p.state} | ${p.cores ?? 'UNKNOWN'} |`);
  if (caeRows.length) out.push('', 'Container Apps dedicated workload profiles (cores not exposed by ARM; listed for attribution):', ...caeRows.map((r) => `- ${r}`));
  if (unknowns.length) out.push('', '**UNKNOWN reads:**', ...unknowns.map((u) => `- ${u}`));
  console.log(out.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
  for (const r of results) if (r.state === 'ok' && r.free <= 0) console.log(`::warning::${acr}: ${r.family} in ${loc} is at its limit (${r.used}/${r.limit}); a pool scale-up needing cores will fail with QuotaExceeded. See docs/fiab/acr-agent-pool-reaper.md.`);
  return unknowns.length || results.some((r) => r.state === 'unknown') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

#!/usr/bin/env node
/**
 * Replace VMs that run a RETIRED marketplace image (#4672).
 *
 * Azure refuses an imageReference change on an existing VM
 * (PropertyChangeNotAllowed), so a VM on a retired image (denylist:
 * scripts/ci/retired-vm-images.json) can only be moved by DELETING it and
 * letting the bicep re-create it. This script does the delete half, safely:
 *
 *   1. List the VMs in the given resource group(s) only.
 *   2. For each whose storageProfile.imageReference matches the denylist,
 *      PREFLIGHT the replacement image (same publisher + replacementOffer +
 *      sku) exists in THAT VM's region (`az vm image list-skus`). If not, FAIL
 *      before deleting anything.
 *   3. Print VM, offer, sku, OS disk id, power state.
 *   4. `--mode apply` only: delete the VM, then its OS disk; wait for each;
 *      read back that both are gone. The NIC, Key Vault secrets and everything
 *      else stay so the bicep re-create reattaches to them.
 *
 * Never touches a VM that is not on a denylisted image, or outside the given
 * RG(s) (an OS disk in a different RG than its VM is refused, not deleted).
 * No `|| true`, no swallowed stderr: every az failure ends the run non-zero
 * with the failing command named (deploy-integrity R6/R7).
 *
 * A Power BI data gateway VM that had been registered needs ONE re-registration
 * after the re-create: Connect-DataGatewayServiceAccount +
 * Add-DataGatewayCluster -RecoveryKey <from the Key Vault secret>.
 *
 * Usage:
 *   node scripts/csa-loom/replace-retired-image-vms.mjs --boundary Commercial|GCC-High|IL5 \
 *     [--resource-group <rg> ...] [--location <region>] [--mode dry-run|apply] [--admin-plane-in-scope true]
 * `apply` REFUSES unless --admin-plane-in-scope true (the follow-on deploy re-creates the VM).
 * Default resource group: rg-csa-loom-admin-<location>; location defaults to
 * $AZURE_LOCATION (GCC-High/IL5 default usgovvirginia).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOUNDARIES = new Set(['Commercial', 'GCC-High', 'IL5']);

export class RemediationError extends Error {}

export function loadDenylist(file = path.join(HERE, '..', 'ci', 'retired-vm-images.json')) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new RemediationError(`${file}: denylist is empty or invalid`);
  return list;
}

/** Real az runner: execFile, no shell. Rejects with the command + stderr named. */
export async function realAz(args) {
  try {
    const { stdout } = await execFileP('az', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new RemediationError(`az ${args.slice(0, 3).join(' ')} failed: ${String(e.stderr || e.message).trim().slice(0, 800)}`);
  }
}

const lc = (s) => String(s ?? '').toLowerCase();
const rgOfId = (id) => /\/resourcegroups\/([^/]+)\//i.exec(id ?? '')?.[1] ?? null;

export function parseArgs(argv, env = process.env) {
  const o = { boundary: null, rgs: [], location: null, mode: 'dry-run', adminPlaneInScope: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new RemediationError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--boundary') o.boundary = next();
    else if (a === '--resource-group') o.rgs.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--location') o.location = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--admin-plane-in-scope') o.adminPlaneInScope = next() === 'true';
    else throw new RemediationError(`unknown argument ${a}`);
  }
  if (!BOUNDARIES.has(o.boundary)) throw new RemediationError(`--boundary must be one of ${[...BOUNDARIES].join(', ')} (got ${o.boundary})`);
  if (o.mode !== 'dry-run' && o.mode !== 'apply') throw new RemediationError(`--mode must be dry-run or apply (got ${o.mode})`);
  if (o.rgs.length === 0) {
    const loc = o.location || env.AZURE_LOCATION || (o.boundary === 'Commercial' ? '' : 'usgovvirginia');
    if (!loc) throw new RemediationError('no --resource-group and no --location/$AZURE_LOCATION: cannot derive rg-csa-loom-admin-<region>');
    o.rgs = [`rg-csa-loom-admin-${loc}`];
  }
  return o;
}

async function azJson(az, args) {
  const out = await az([...args, '-o', 'json']);
  try { return JSON.parse(out || 'null'); } catch { throw new RemediationError(`az ${args.slice(0, 3).join(' ')} returned non-JSON output`); }
}

export async function run({ rgs, mode, adminPlaneInScope = false, az = realAz, deny = loadDenylist(), log = console.log }) {
  if (mode === 'apply' && adminPlaneInScope !== true) {
    throw new RemediationError('--mode apply refused: pass --admin-plane-in-scope true only when the run that follows re-creates the VM (admin plane deployed). Without it a deleted VM would not come back (e.g. topology=dlz-attach). Nothing was deleted.');
  }
  const summary = { replaced: [], found: [], skippedRgs: [] };
  const plan = [];

  for (const rg of rgs) {
    const exists = (await az(['group', 'exists', '--name', rg])).trim();
    if (exists !== 'true') {
      if (exists !== 'false') throw new RemediationError(`az group exists ${rg} returned "${exists}", expected true|false`);
      log(`[${rg}] resource group does not exist (greenfield) - nothing to replace.`);
      summary.skippedRgs.push(rg);
      continue;
    }
    const vms = (await azJson(az, ['vm', 'list', '--resource-group', rg])) ?? [];
    for (const vm of vms) {
      const img = vm?.storageProfile?.imageReference;
      const hit = img && deny.find((d) => lc(d.publisher) === lc(img.publisher) && lc(d.offer) === lc(img.offer));
      if (!hit) continue;
      plan.push({ rg, vm, img, hit });
    }
  }

  // PREFLIGHT every candidate BEFORE the first delete.
  const skuCache = new Map();
  for (const p of plan) {
    const { vm, img, hit, rg } = p;
    const replacementOffer = hit.replacementOffer;
    if (!replacementOffer) throw new RemediationError(`denylist entry ${hit.publisher}:${hit.offer} has no replacementOffer`);
    const region = vm.location;
    const key = `${lc(region)}|${lc(hit.publisher)}|${lc(replacementOffer)}`;
    if (!skuCache.has(key)) {
      skuCache.set(key, await azJson(az, ['vm', 'image', 'list-skus', '--location', region, '--publisher', hit.publisher, '--offer', replacementOffer]));
    }
    const skus = (skuCache.get(key) ?? []).map((s) => lc(s.name));
    if (!skus.includes(lc(img.sku))) {
      throw new RemediationError(`replacement image ${hit.publisher}:${replacementOffer}:${img.sku} is NOT available in region ${region} (VM ${vm.name}); nothing was deleted. Available skus there: ${skus.join(', ') || '(none)'}.`);
    }
    const osDiskId = vm.storageProfile?.osDisk?.managedDisk?.id;
    if (!osDiskId) throw new RemediationError(`VM ${vm.name} has no managed OS disk id; refusing to guess what to delete.`);
    if (lc(rgOfId(osDiskId)) !== lc(rg)) {
      throw new RemediationError(`VM ${vm.name} OS disk ${osDiskId} is outside resource group ${rg}; refusing to delete outside scope.`);
    }
    const power = (await az(['vm', 'get-instance-view', '--resource-group', rg, '--name', vm.name, '--query', "instanceView.statuses[?starts_with(code,'PowerState/')].code | [0]", '-o', 'tsv'])).trim();
    p.osDiskId = osDiskId;
    p.replacementOffer = replacementOffer;
    log(`RETIRED IMAGE: vm=${vm.name} rg=${rg} region=${region} offer=${img.offer} sku=${img.sku} osDisk=${osDiskId} power=${power || 'unknown'} -> replace with ${replacementOffer}`);
    summary.found.push(vm.name);
  }

  if (plan.length === 0) {
    log('No VM in scope runs a retired image.');
    return summary;
  }
  if (mode !== 'apply') {
    log(`dry-run: ${plan.length} VM(s) would be deleted + re-created. Nothing was changed.`);
    return summary;
  }

  for (const p of plan) {
    const { rg, vm, osDiskId } = p;
    const diskName = osDiskId.split('/').pop();
    log(`[${rg}] deleting VM ${vm.name} ... NOTE: no rollback - if the deploy that follows fails, this VM stays absent until the next successful deploy.`);
    await az(['vm', 'delete', '--resource-group', rg, '--name', vm.name, '--yes']);
    const left = (await az(['vm', 'list', '--resource-group', rg, '--query', `[?name=='${vm.name}'].name`, '-o', 'tsv'])).trim();
    if (left) throw new RemediationError(`VM ${vm.name} still listed in ${rg} after delete; not deleting its disk.`);
    // The disk may already be gone (osDisk deleteOption=Delete); read, don't assume.
    const diskQuery = `[?name=='${diskName}'].[id,managedBy]`;
    const diskRow = (await az(['disk', 'list', '--resource-group', rg, '--query', diskQuery, '-o', 'tsv'])).trim();
    if (diskRow) {
      const managedBy = diskRow.split('\t')[1];
      if (managedBy && managedBy !== 'None') throw new RemediationError(`OS disk ${diskName} is still attached to ${managedBy} after VM delete; refusing to delete it.`);
      log(`[${rg}] deleting OS disk ${diskName} ...`);
      await az(['disk', 'delete', '--resource-group', rg, '--name', diskName, '--yes']);
    } else {
      log(`[${rg}] OS disk ${diskName} already removed with the VM.`);
    }
    const diskLeft = (await az(['disk', 'list', '--resource-group', rg, '--query', `[?name=='${diskName}'].name`, '-o', 'tsv'])).trim();
    if (diskLeft) throw new RemediationError(`OS disk ${diskName} still exists in ${rg} after delete.`);
    log(`[${rg}] VM ${vm.name} and OS disk ${diskName} are gone (read back). NIC and Key Vault secrets were left in place; the bicep deploy re-creates the VM. If this was the Power BI data gateway, it needs a one-time re-registration (Connect-DataGatewayServiceAccount + Add-DataGatewayCluster -RecoveryKey from the Key Vault secret).`);
    summary.replaced.push(vm.name);
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    console.log(`replace-retired-image-vms: boundary=${o.boundary} mode=${o.mode} rgs=${o.rgs.join(',')}`);
    const s = await run({ rgs: o.rgs, mode: o.mode, adminPlaneInScope: o.adminPlaneInScope });
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `retired_found=${s.found.length}\nretired_replaced=${s.replaced.length}\n`);
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

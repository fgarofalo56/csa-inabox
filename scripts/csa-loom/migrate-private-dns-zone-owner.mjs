#!/usr/bin/env node
/**
 * migrate-private-dns-zone-owner.mjs — adopt a privatelink namespace onto the
 * zone that OWNS it, without taking the service dark.
 *
 * WHY (issue #3039, deploy-integrity.md R5)
 *
 *   `privatelink.azuredatabricks.net` exists twice in the Commercial estate:
 *   the admin plane's zone (which admin-plane/network.bicep owns and creates,
 *   index 23, #1466) and a stale one in the DLZ resource group left by a
 *   superseded design. The STALE one holds `link-hub`, so Azure's one-link-per-
 *   namespace rule means the admin plane's link can never be created and every
 *   reconcile fails with BadRequest.
 *
 *   The obvious fix — delete `link-hub` — BREAKS DATABRICKS. The workspace A
 *   record `adb-<id>.NN` is registered into the stale zone by the DLZ private
 *   endpoint's DNS zone group; unlinking first leaves the Console unable to
 *   resolve the workspace. That trades a failing deploy for a live outage.
 *
 * THE ORDER, AND ONE CORRECTION TO IT
 *
 *   #3039 proposes: repoint the PE DNS group → link both VNets to the keep zone
 *   → verify → delete the stale zone. Step 2 CANNOT succeed as written: while
 *   the stale link exists, linking the same VNet to the keep zone fails with the
 *   very BadRequest being fixed. And repointing the PE DNS group ALONE moves the
 *   A record out of the linked zone into an unlinked one, which is itself an
 *   outage.
 *
 *   So the record is DUAL-REGISTERED first. A privateDnsZoneGroup accepts a LIST
 *   of zones, so the A record can exist in both at once:
 *
 *     1  ensure the keep zone exists
 *     2  point every PE DNS zone group at BOTH zones      (no gap: record in both)
 *     3  VERIFY the record is present in the keep zone    (refuses to go on if not)
 *     4  delete the stale zone's VNet links
 *     5  create the same links on the keep zone
 *     6  VERIFY every VNet the stale zone served is now linked to the keep zone
 *     7  point every PE DNS zone group at the keep zone ONLY
 *     8  delete the stale zone
 *
 *   Steps 4→5 are a genuine gap of seconds — Azure permits only one link per
 *   namespace per VNet, so the old link must go before the new one can exist.
 *   That is a property of Azure, not of this script, and it is stated rather
 *   than glossed.
 *
 * WHAT VERIFICATION HERE DOES AND DOES NOT PROVE (R7)
 *
 *   Steps 3 and 6 read ARM: the record set exists in the keep zone, and the keep
 *   zone carries a link for every VNet. That is NOT the same as proving the name
 *   resolves from inside the hub VNet — a hosted runner is not in the VNet and
 *   cannot answer that. The script says so; the in-VNet proof is a job on the
 *   ACA runner (`.github/workflows/loom-aca-runner-smoke.yml`) or the P2S VPN.
 *   It never claims resolution it did not observe.
 *
 * USAGE — DRY RUN BY DEFAULT. Nothing is mutated without --apply.
 *
 *   node scripts/csa-loom/migrate-private-dns-zone-owner.mjs \
 *     --namespace privatelink.azuredatabricks.net \
 *     --keep-zone-rg  rg-csa-loom-admin-<region>       --keep-zone-subscription  <sub> \
 *     --stale-zone-rg rg-csa-loom-dlz-default-<region> --stale-zone-subscription <sub> \
 *     [--pe-resource-group <rg> …]   # extra scopes to search for private endpoints
 *     [--apply] [--json]
 *
 *   Exit: 0 converged / plan produced | 1 blocked (a precondition failed)
 *         2 usage | 3 could not read the estate.
 *
 * Tests: node --test scripts/csa-loom/__tests__/migrate-private-dns-zone-owner.test.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, BLOCKED: 1, USAGE: 2, UNREADABLE: 3 });

/** Every mutation this script is allowed to perform, by step id. */
export const STEP_IDS = Object.freeze([
  'ensure-keep-zone',
  'dual-register',
  'verify-record-in-keep-zone',
  'unlink-stale',
  'link-keep',
  'verify-links-on-keep-zone',
  'single-register',
  'delete-stale-zone',
]);

export function azBinary() {
  if (process.env.LOOM_AZ_BIN) return process.env.LOOM_AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

/**
 * Runs one `az` command. stderr is CAPTURED and returned — never discarded, so
 * a refusal can be reported as a refusal rather than as an empty result.
 */
export function azRunner(args) {
  const bin = azBinary();
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: /\.(cmd|bat)$/i.test(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { status: 127, stdout: '', stderr: res.error.message };
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readJson(run, args) {
  const res = run(args);
  if (res.status !== 0) {
    return { ok: false, reason: `\`az ${args.slice(0, 4).join(' ')}\` exited ${res.status}: ${(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ')}` };
  }
  try {
    return { ok: true, value: JSON.parse(res.stdout || 'null') };
  } catch (e) {
    return { ok: false, reason: `az returned output that is not JSON: ${e.message}` };
  }
}

export const zoneId = (sub, rg, ns) =>
  `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/privateDnsZones/${ns}`;

const lower = (s) => String(s ?? '').toLowerCase();

/**
 * Read everything the plan depends on. Any read that fails aborts with
 * `unreadable` — a migration planned on a partial view of the estate is worse
 * than no plan.
 */
export function discover(opts, run) {
  const { namespace, keepZoneRg, keepZoneSubscription, staleZoneRg, staleZoneSubscription, peResourceGroups } = opts;
  const notes = [];

  const zonesRes = readJson(run, ['network', 'private-dns', 'zone', 'list', '--subscription', staleZoneSubscription, '-o', 'json']);
  if (!zonesRes.ok) return { ok: false, reason: zonesRes.reason };
  const staleZone = (zonesRes.value ?? []).find(
    (z) => lower(z.name) === lower(namespace) && lower(z.resourceGroup) === lower(staleZoneRg),
  );

  const keepZonesRes = readJson(run, ['network', 'private-dns', 'zone', 'list', '--subscription', keepZoneSubscription, '-o', 'json']);
  if (!keepZonesRes.ok) return { ok: false, reason: keepZonesRes.reason };
  const keepZone = (keepZonesRes.value ?? []).find(
    (z) => lower(z.name) === lower(namespace) && lower(z.resourceGroup) === lower(keepZoneRg),
  );

  let staleLinks = [];
  let staleRecords = [];
  if (staleZone) {
    const l = readJson(run, ['network', 'private-dns', 'link', 'vnet', 'list', '-g', staleZoneRg, '-z', namespace, '--subscription', staleZoneSubscription, '-o', 'json']);
    if (!l.ok) return { ok: false, reason: l.reason };
    staleLinks = (l.value ?? []).map((x) => ({ name: x.name, vnetId: x.virtualNetwork?.id ?? null, registration: x.registrationEnabled === true }));
    const r = readJson(run, ['network', 'private-dns', 'record-set', 'a', 'list', '-g', staleZoneRg, '-z', namespace, '--subscription', staleZoneSubscription, '-o', 'json']);
    if (!r.ok) return { ok: false, reason: r.reason };
    staleRecords = (r.value ?? []).map((x) => ({ name: x.name, ips: (x.aRecords ?? []).map((a) => a.ipv4Address) }));
  }

  let keepLinks = [];
  let keepRecords = [];
  if (keepZone) {
    const l = readJson(run, ['network', 'private-dns', 'link', 'vnet', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json']);
    if (!l.ok) return { ok: false, reason: l.reason };
    keepLinks = (l.value ?? []).map((x) => ({ name: x.name, vnetId: x.virtualNetwork?.id ?? null }));
    const r = readJson(run, ['network', 'private-dns', 'record-set', 'a', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json']);
    if (!r.ok) return { ok: false, reason: r.reason };
    keepRecords = (r.value ?? []).map((x) => ({ name: x.name, ips: (x.aRecords ?? []).map((a) => a.ipv4Address) }));
  }

  // Private endpoints whose DNS zone group references the STALE zone.
  //
  // Azure Resource Graph does NOT index privateDnsZoneGroups (measured: the
  // type returns 0 rows), and `customDnsConfigs` is empty precisely when a zone
  // group exists — which is every endpoint that matters here. So the search is
  // an explicit, BOUNDED set of resource groups, and the scopes searched are
  // reported: a scope that was not looked at is disclosed, never implied clean.
  const scopes = [
    { rg: staleZoneRg, subscription: staleZoneSubscription },
    ...peResourceGroups.map((rg) => ({ rg, subscription: staleZoneSubscription })),
  ];
  const staleZoneId = staleZone?.id ?? zoneId(staleZoneSubscription, staleZoneRg, namespace);
  const attachedEndpoints = [];
  for (const s of scopes) {
    const peRes = readJson(run, ['network', 'private-endpoint', 'list', '-g', s.rg, '--subscription', s.subscription, '-o', 'json']);
    if (!peRes.ok) return { ok: false, reason: peRes.reason };
    for (const pe of peRes.value ?? []) {
      const gRes = readJson(run, ['network', 'private-endpoint', 'dns-zone-group', 'list', '-g', s.rg, '--endpoint-name', pe.name, '--subscription', s.subscription, '-o', 'json']);
      if (!gRes.ok) return { ok: false, reason: gRes.reason };
      for (const g of gRes.value ?? []) {
        const cfgs = (g.privateDnsZoneConfigs ?? []).map((c) => ({ name: c.name, zoneId: c.privateDnsZoneId }));
        if (!cfgs.some((c) => lower(c.zoneId) === lower(staleZoneId))) continue;
        attachedEndpoints.push({ resourceGroup: s.rg, subscription: s.subscription, endpoint: pe.name, group: g.name, configs: cfgs });
      }
    }
  }
  notes.push(`private endpoints were searched in: ${scopes.map((s) => s.rg).join(', ')}. Any endpoint outside those resource groups was NOT examined.`);

  return { ok: true, staleZone, keepZone, staleLinks, staleRecords, keepLinks, keepRecords, attachedEndpoints, staleZoneId, notes };
}

/**
 * The ordered plan. Every step carries `needed` — false means the estate is
 * already in that state, which is what makes a re-run a genuine no-op rather
 * than a re-application.
 */
export function buildPlan(opts, state) {
  const { namespace, keepZoneRg, keepZoneSubscription, staleZoneRg, staleZoneSubscription } = opts;
  const keepId = state.keepZone?.id ?? zoneId(keepZoneSubscription, keepZoneRg, namespace);
  const staleId = state.staleZoneId;
  const cfgName = namespace.replace(/\./g, '-');
  const steps = [];

  steps.push({
    id: 'ensure-keep-zone',
    needed: !state.keepZone,
    why: 'the surviving zone must exist before anything is pointed at it.',
    argv: ['network', 'private-dns', 'zone', 'create', '-g', keepZoneRg, '-n', namespace, '--subscription', keepZoneSubscription, '-o', 'none'],
  });

  for (const pe of state.attachedEndpoints) {
    const already = pe.configs.some((c) => lower(c.zoneId) === lower(keepId));
    steps.push({
      id: 'dual-register',
      needed: !already,
      why: `${pe.endpoint} registers the A record; pointing it at BOTH zones puts the record in the surviving zone with no gap in resolution.`,
      argv: ['network', 'private-endpoint', 'dns-zone-group', 'create', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '-n', pe.group, '--subscription', pe.subscription, '--zone-name', cfgName, '--private-dns-zone', keepId, '-o', 'none'],
      // az's dns-zone-group `create` replaces the group; `add` appends one zone.
      // The append form is used so the STALE config survives this step — that
      // is the whole point of dual registration.
      argvOverride: ['network', 'private-endpoint', 'dns-zone-group', 'add', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '-n', pe.group, '--subscription', pe.subscription, '--zone-name', cfgName, '--private-dns-zone', keepId, '-o', 'none'],
    });
  }

  steps.push({
    id: 'verify-record-in-keep-zone',
    needed: true,
    verify: true,
    why: 'refuses to unlink anything until the record is provably present in the surviving zone.',
    expect: state.staleRecords.map((r) => r.name),
    argv: ['network', 'private-dns', 'record-set', 'a', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json'],
  });

  for (const l of state.staleLinks) {
    steps.push({
      id: 'unlink-stale',
      needed: true,
      why: `Azure permits ONE link per namespace per VNet, so "${l.name}" on the stale zone must go before the surviving zone can take it. THIS OPENS A RESOLUTION GAP OF SECONDS for ${l.vnetId?.split('/').pop() ?? 'that VNet'}.`,
      argv: ['network', 'private-dns', 'link', 'vnet', 'delete', '-g', staleZoneRg, '-z', namespace, '-n', l.name, '--subscription', staleZoneSubscription, '--yes', '-o', 'none'],
    });
  }

  for (const l of state.staleLinks) {
    const already = state.keepLinks.some((k) => lower(k.vnetId) === lower(l.vnetId));
    steps.push({
      id: 'link-keep',
      needed: !already,
      why: `re-establishes resolution for ${l.vnetId?.split('/').pop() ?? 'that VNet'} on the surviving zone.`,
      argv: ['network', 'private-dns', 'link', 'vnet', 'create', '-g', keepZoneRg, '-z', namespace, '-n', l.name, '--subscription', keepZoneSubscription, '--virtual-network', l.vnetId, '--registration-enabled', l.registration ? 'true' : 'false', '-o', 'none'],
    });
  }

  steps.push({
    id: 'verify-links-on-keep-zone',
    needed: true,
    verify: true,
    why: 'every VNet the stale zone served must resolve on the surviving zone before the stale zone is removed.',
    expect: state.staleLinks.map((l) => l.vnetId),
    argv: ['network', 'private-dns', 'link', 'vnet', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json'],
  });

  for (const pe of state.attachedEndpoints) {
    steps.push({
      id: 'single-register',
      needed: true,
      why: `drops the stale zone from ${pe.endpoint}'s DNS zone group so the zone can be deleted.`,
      argv: ['network', 'private-endpoint', 'dns-zone-group', 'remove', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '-n', pe.group, '--subscription', pe.subscription, '--zone-name', namespace.replace(/\./g, '-'), '-o', 'none'],
    });
  }

  steps.push({
    id: 'delete-stale-zone',
    needed: Boolean(state.staleZone),
    why: 'the leftover zone is what makes every reconcile fail; it goes last, and only once the surviving zone is proven to carry the record and the links.',
    argv: ['network', 'private-dns', 'zone', 'delete', '-g', staleZoneRg, '-n', namespace, '--subscription', staleZoneSubscription, '--yes', '-o', 'none'],
  });

  return { steps, keepId, staleId };
}

/** True when there is nothing left to do. */
export function isConverged(state, plan) {
  if (state.staleZone) return false;
  if (plan.steps.some((s) => s.needed && !s.verify)) return false;
  return true;
}

/**
 * Execute. Verification steps are HARD GATES: a failed verify stops the run
 * before anything destructive, and says what it could not establish.
 */
export function applyPlan(plan, run, log) {
  for (const step of plan.steps) {
    if (step.verify) {
      const res = readJson(run, step.argv);
      if (!res.ok) {
        return { ok: false, stoppedAt: step.id, reason: `verification could not read the estate: ${res.reason}. Nothing further was changed.` };
      }
      const got =
        step.id === 'verify-record-in-keep-zone'
          ? (res.value ?? []).map((x) => lower(x.name))
          : (res.value ?? []).map((x) => lower(x.virtualNetwork?.id));
      const missing = (step.expect ?? []).map(lower).filter((e) => !got.includes(e));
      if (missing.length > 0) {
        return {
          ok: false,
          stoppedAt: step.id,
          reason:
            `verification FAILED: ${missing.length} expected entr(ies) are absent from the surviving zone ` +
            `(${missing.join(', ')}). Nothing destructive was run. Resolve this before re-running — ` +
            'proceeding would take the service dark.',
        };
      }
      log(`  ✓ ${step.id}: ${step.expect.length} entr(ies) present in the surviving zone.`);
      continue;
    }
    if (!step.needed) {
      log(`  · ${step.id}: already in the desired state — skipped.`);
      continue;
    }
    const argv = step.argvOverride ?? step.argv;
    const res = run(argv);
    if (res.status !== 0) {
      return {
        ok: false,
        stoppedAt: step.id,
        reason: `\`az ${argv.slice(0, 5).join(' ')}\` exited ${res.status}: ${(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 4).join(' ')}`,
      };
    }
    log(`  ✓ ${step.id}: applied.`);
  }
  return { ok: true, stoppedAt: null, reason: null };
}

export function renderPlan(opts, state, plan, { apply }) {
  const out = [];
  out.push(`Private DNS ownership migration — ${opts.namespace}`);
  out.push(`  surviving zone : ${opts.keepZoneRg}${state.keepZone ? '' : '  (does not exist yet — step 1 creates it)'}`);
  out.push(`  stale zone     : ${opts.staleZoneRg}${state.staleZone ? '' : '  (already gone)'}`);
  out.push(`  stale links    : ${state.staleLinks.map((l) => `${l.name} → ${l.vnetId?.split('/').pop()}`).join(', ') || 'none'}`);
  out.push(`  stale records  : ${state.staleRecords.map((r) => `${r.name} → ${r.ips.join(',')}`).join(', ') || 'none'}`);
  out.push(`  PE DNS groups  : ${state.attachedEndpoints.map((p) => `${p.endpoint}/${p.group}`).join(', ') || 'none'}`);
  out.push('');
  if (isConverged(state, plan)) {
    out.push('CONVERGED — the stale zone is gone and there is nothing to do. This run changed nothing.');
    return out.join('\n');
  }
  out.push(apply ? 'APPLYING:' : 'DRY RUN — nothing below has been executed. Re-run with --apply to execute.');
  plan.steps.forEach((s, i) => {
    const mark = s.verify ? 'VERIFY' : s.needed ? 'DO    ' : 'skip  ';
    out.push(`  ${String(i + 1).padStart(2)}. [${mark}] ${s.id} — ${s.why}`);
    if (!s.verify) out.push(`        az ${(s.argvOverride ?? s.argv).join(' ')}`);
  });
  out.push('');
  out.push(
    'NOTE: steps `unlink-stale` → `link-keep` are a resolution gap of seconds. Azure permits one link ' +
      'per namespace per VNet, so the old link must be removed before the new one can be created; that is ' +
      'an Azure constraint, not a choice made here.',
  );
  out.push(
    'NOTE: the verification steps read ARM (the record set exists, the links exist). They do NOT prove the ' +
      'name resolves from INSIDE the hub VNet — a hosted runner is not in the VNet. For that proof run a ' +
      'lookup from the in-VNet runner (loom-aca-runner-smoke.yml) or over the admin P2S VPN.',
  );
  for (const n of state.notes) out.push(`NOTE: ${n}`);
  return out.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    namespace: null,
    keepZoneRg: null,
    keepZoneSubscription: null,
    staleZoneRg: null,
    staleZoneSubscription: null,
    peResourceGroups: [],
    apply: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--namespace') out.namespace = argv[++i];
    else if (a === '--keep-zone-rg') out.keepZoneRg = argv[++i];
    else if (a === '--keep-zone-subscription') out.keepZoneSubscription = argv[++i];
    else if (a === '--stale-zone-rg') out.staleZoneRg = argv[++i];
    else if (a === '--stale-zone-subscription') out.staleZoneSubscription = argv[++i];
    else if (a === '--pe-resource-group') out.peResourceGroups.push(argv[++i]);
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export function run(opts, runner = azRunner, log = (s) => process.stdout.write(`${s}\n`)) {
  const state = discover(opts, runner);
  if (!state.ok) {
    log(
      'Private DNS ownership migration: COULD NOT READ the estate, so no plan is produced and NOTHING is ' +
        `asserted about what needs to change. ${state.reason}`,
    );
    return EXIT.UNREADABLE;
  }
  const plan = buildPlan(opts, state);
  log(renderPlan(opts, state, plan, { apply: opts.apply }));
  if (!opts.apply || isConverged(state, plan)) return EXIT.OK;
  log('');
  const res = applyPlan(plan, runner, log);
  if (!res.ok) {
    log(`\nSTOPPED at ${res.stoppedAt}: ${res.reason}`);
    return EXIT.BLOCKED;
  }
  log('\nMigration applied. Re-run without --apply to confirm it reports CONVERGED.');
  return EXIT.OK;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`migrate-private-dns-zone-owner: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  }
  const missing = ['namespace', 'keepZoneRg', 'keepZoneSubscription', 'staleZoneRg', 'staleZoneSubscription'].filter(
    (k) => !opts[k],
  );
  if (missing.length) {
    process.stderr.write(`migrate-private-dns-zone-owner: missing required option(s): ${missing.join(', ')}\n`);
    process.exit(EXIT.USAGE);
  }
  process.exit(run(opts));
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

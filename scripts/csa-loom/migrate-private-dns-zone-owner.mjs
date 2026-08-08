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
 *      1  ensure the keep zone exists
 *      2  point every PE DNS zone group at BOTH zones     (no gap: record in both)
 *      3  VERIFY the record is present in the keep zone   (refuses to go on if not)
 *      4  delete the stale zone's VNet links
 *      5  create the same links on the keep zone
 *      6  VERIFY every VNet the stale zone served is now linked to the keep zone
 *      7  remove ONLY the stale config from each PE DNS zone group
 *      8  VERIFY each group still points at the keep zone   (terminal)
 *      9  VERIFY the records are still in the keep zone     (terminal)
 *     10  delete the stale zone
 *
 *   Steps 4→5 are a genuine gap of seconds — Azure permits only one link per
 *   namespace per VNet, so the old link must go before the new one can exist.
 *   That is a property of Azure, not of this script, and it is stated rather
 *   than glossed.
 *
 * THE OUTAGE THIS SCRIPT CAUSED, AND WHY (#3046, FINISHLINE D8)
 *
 *   The first cut of steps 2 and 7 selected the zone-group config the way a
 *   reader would ASSUME `az` selects it — by the zone. It does not. Measured
 *   from the vendor's own source
 *   (azure-cli/.../network/private_endpoint/dns_zone_group/_add.py and
 *   _remove.py, class SubresourceSelector):
 *
 *       filter(lambda e: e[1].name == self.ctx.args.zone_name, ...)
 *       add._set:    idx = next(filters, [len(result)])[0]   # REPLACE if that
 *                                                            # NAME exists, else APPEND
 *       remove._get: idx = next(filters)[0]                  # StopIteration if absent
 *
 *   `--zone-name` is the CONFIG's name inside the group, never the zone id. The
 *   script passed `namespace.replace(/\./g,'-')` for both — and that string is
 *   byte-identical to the config name the bicep already creates
 *   (landing-zone/databricks.bicep:135 = `privatelink-azuredatabricks-net`). So:
 *
 *     - step 2 REPLACED the stale config instead of appending. "Dual"
 *       registration never happened; the record moved to a zone with no VNet
 *       link. Step 3 still passed, because the record WAS in the keep zone.
 *     - step 7 then removed the only remaining config — the KEEP one — leaving
 *       the group with ZERO configs, which deregisters the endpoint's A record
 *       from every zone. The service went dark and the script exited 0.
 *     - nothing ran after step 7, so no check could see it.
 *
 *   The fix is three things, and each is load-bearing:
 *     - dual-register uses a config name NOTHING else owns, so `add` appends.
 *     - single-register removes the config selected BY ITS OWN NAME as READ FROM
 *       THE ESTATE, only when that config still points at the stale zone, and
 *       never when the removal would empty the group or leave it with no config
 *       on the keep zone. Per deploy-integrity.md R5 this script does not remove
 *       wiring it cannot prove is stale — DISCOVER, OFFER, never assume.
 *     - two TERMINAL verifications run after the removal and before the zone
 *       delete, so a wipe cannot be silent again.
 *
 *   Every destructive step also re-reads its subject immediately before acting:
 *   a plan built from a snapshot must not mutate a group that changed underneath
 *   it. That is what makes a re-run CONVERGE instead of re-applying.
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
  'verify-zone-group-bound-to-keep',
  'verify-record-after-single-register',
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
 * Read one private endpoint's DNS zone groups fresh. Destructive steps call this
 * immediately before acting so they never mutate a snapshot.
 */
function readZoneGroups(run, pe) {
  return readJson(run, [
    'network', 'private-endpoint', 'dns-zone-group', 'list',
    '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '--subscription', pe.subscription, '-o', 'json',
  ]);
}

const ARM_CHILD_NAME_MAX = 80;

/**
 * The config name dual-registration writes.
 *
 * MUST NOT collide with any name already in the group. `az … dns-zone-group add`
 * REPLACES a config whose `name` matches and only APPENDS when it does not
 * (measured: _add.py SubresourceSelector._set, `next(filters, [len(result)])`).
 * The obvious choice — `namespace.replace(/\./g,'-')` — is exactly the name the
 * bicep gives the config it creates (landing-zone/databricks.bicep:135), so it
 * silently turned "dual-register" into "replace", which is how the 2026-08-06
 * outage started. So: never `base`, always a suffixed name, and if that is taken
 * too, keep counting.
 */
export function keepConfigName(namespace, existingNames = []) {
  const base = String(namespace).replace(/\./g, '-');
  const taken = new Set(existingNames.map((n) => lower(n)));
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? '-loom-keep' : `-loom-keep-${i + 1}`;
    const cand = `${base.slice(0, ARM_CHILD_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(lower(cand))) return cand;
  }
  // 100 collisions is not a real estate; it is a bug. Say so rather than
  // returning a name that would overwrite one of them.
  throw new Error(
    `could not find a free privateDnsZoneConfigs name for "${namespace}" — 100 candidates were already taken ` +
      `(${existingNames.join(', ')}). Refusing to reuse one, because \`az dns-zone-group add\` would REPLACE it.`,
  );
}

/**
 * Run-time guard for `single-register`. This is the step that caused the outage,
 * so it re-reads the group and refuses anything it cannot prove is safe.
 * Returns { action: 'run' | 'skip' | 'stop', reason }.
 */
export function guardSingleRegister(run, pe, targetName, keepId, staleId) {
  const g = readZoneGroups(run, pe);
  if (!g.ok) {
    return {
      action: 'stop',
      reason:
        `could not re-read ${pe.endpoint}/${pe.group} before removing a DNS zone config, so whether the removal ` +
        `is safe is UNKNOWN — not "safe". ${g.reason}. Nothing was changed.`,
    };
  }
  const group = (g.value ?? []).find((x) => x.name === pe.group);
  if (!group) {
    return { action: 'skip', reason: `${pe.endpoint}/${pe.group} no longer exists — nothing to remove.` };
  }
  const cfgs = (group.privateDnsZoneConfigs ?? []).map((c) => ({ name: c.name, zoneId: c.privateDnsZoneId }));
  const target = cfgs.find((c) => c.name === targetName);
  if (!target) {
    return {
      action: 'skip',
      reason: `config "${targetName}" is already absent from ${pe.endpoint}/${pe.group} — converged, not re-applied.`,
    };
  }
  if (lower(target.zoneId) !== lower(staleId)) {
    return {
      action: 'stop',
      reason:
        `REFUSING to remove "${targetName}" from ${pe.endpoint}/${pe.group}: it now points at ${target.zoneId}, ` +
        `NOT the stale zone. Something changed this group since the plan was built. This script removes only ` +
        `wiring it can prove is stale (deploy-integrity R5). Nothing was changed.`,
    };
  }
  const survivors = cfgs.filter((c) => c.name !== targetName);
  if (survivors.length === 0) {
    return {
      action: 'stop',
      reason:
        `REFUSING to remove "${targetName}" from ${pe.endpoint}/${pe.group}: it is the ONLY config, so removing it ` +
        `leaves the group empty, which DEREGISTERS the endpoint's A record from every zone and takes the service ` +
        `dark. That is exactly the 2026-08-06 outage (#3046). Dual-registration has to land first.`,
    };
  }
  if (!survivors.some((c) => lower(c.zoneId) === lower(keepId))) {
    return {
      action: 'stop',
      reason:
        `REFUSING to remove "${targetName}" from ${pe.endpoint}/${pe.group}: afterwards NO config would point at ` +
        `the surviving zone (${keepId}), so the A record would not be registered in any zone this migration links. ` +
        `Nothing was changed.`,
    };
  }
  return { action: 'run', reason: null };
}

/** Run-time guard for `dual-register` — an `add` must never overwrite a config. */
export function guardDualRegister(run, pe, cfgName, keepId) {
  const g = readZoneGroups(run, pe);
  if (!g.ok) {
    return {
      action: 'stop',
      reason:
        `could not re-read ${pe.endpoint}/${pe.group} before adding a DNS zone config, so whether the add would ` +
        `APPEND or REPLACE is UNKNOWN. ${g.reason}. Nothing was changed.`,
    };
  }
  const group = (g.value ?? []).find((x) => x.name === pe.group);
  if (!group) {
    return {
      action: 'stop',
      reason:
        `${pe.endpoint}/${pe.group} does not exist any more, so there is no group to dual-register into. ` +
        `Nothing was changed.`,
    };
  }
  const cfgs = (group.privateDnsZoneConfigs ?? []).map((c) => ({ name: c.name, zoneId: c.privateDnsZoneId }));
  if (cfgs.some((c) => lower(c.zoneId) === lower(keepId))) {
    return { action: 'skip', reason: `${pe.endpoint}/${pe.group} already points at the surviving zone — converged.` };
  }
  const clash = cfgs.find((c) => c.name === cfgName);
  if (clash) {
    return {
      action: 'stop',
      reason:
        `REFUSING to add config "${cfgName}" to ${pe.endpoint}/${pe.group}: a config with that NAME already exists ` +
        `and points at ${clash.zoneId}. \`az dns-zone-group add\` matches on the config NAME and would REPLACE it, ` +
        `silently un-registering that zone — the 2026-08-06 failure mode. Nothing was changed.`,
    };
  }
  return { action: 'run', reason: null };
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
  const steps = [];

  steps.push({
    id: 'ensure-keep-zone',
    needed: !state.keepZone,
    why: 'the surviving zone must exist before anything is pointed at it.',
    argv: ['network', 'private-dns', 'zone', 'create', '-g', keepZoneRg, '-n', namespace, '--subscription', keepZoneSubscription, '-o', 'none'],
  });

  for (const pe of state.attachedEndpoints) {
    const keepCfg = pe.configs.find((c) => lower(c.zoneId) === lower(keepId));
    // Reuse an existing keep-zone config's name when there is one (idempotence);
    // otherwise mint a name NOTHING in the group owns, so `add` appends.
    const cfgName = keepCfg?.name ?? keepConfigName(namespace, pe.configs.map((c) => c.name));
    steps.push({
      id: 'dual-register',
      needed: !keepCfg,
      why:
        `${pe.endpoint} registers the A record; pointing it at BOTH zones puts the record in the surviving zone ` +
        `with no gap in resolution. The config is named "${cfgName}" — deliberately NOT ` +
        `"${namespace.replace(/\./g, '-')}", which the bicep already owns and which \`az … add\` would REPLACE ` +
        `rather than append (#3046).`,
      precondition: (run) => guardDualRegister(run, pe, cfgName, keepId),
      argv: ['network', 'private-endpoint', 'dns-zone-group', 'add', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '-n', pe.group, '--subscription', pe.subscription, '--zone-name', cfgName, '--private-dns-zone', keepId, '-o', 'none'],
    });
  }

  steps.push({
    id: 'verify-record-in-keep-zone',
    needed: true,
    verify: true,
    verifyKind: 'records',
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
    verifyKind: 'links',
    why: 'every VNet the stale zone served must resolve on the surviving zone before the stale zone is removed.',
    expect: state.staleLinks.map((l) => l.vnetId),
    argv: ['network', 'private-dns', 'link', 'vnet', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json'],
  });

  // Remove ONLY the configs that actually point at the stale zone, each selected
  // by the name READ FROM THE ESTATE — `az` matches --zone-name against the
  // config's name, not the zone id, so a guessed name removes the wrong thing.
  // Emitting a step per real config (rather than one blanket step per endpoint)
  // is also what makes a second run a no-op: after the first run there is no
  // stale config left to enumerate.
  for (const pe of state.attachedEndpoints) {
    for (const cfg of pe.configs.filter((c) => lower(c.zoneId) === lower(staleId))) {
      steps.push({
        id: 'single-register',
        needed: true,
        why:
          `removes config "${cfg.name}" — the one that points at the STALE zone — from ${pe.endpoint}/${pe.group}. ` +
          `Selected by the name read from the estate, and re-checked immediately before removal: it must still ` +
          `point at the stale zone, and the group must be left with at least one config still on the surviving zone.`,
        precondition: (run) => guardSingleRegister(run, pe, cfg.name, keepId, staleId),
        argv: ['network', 'private-endpoint', 'dns-zone-group', 'remove', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '-n', pe.group, '--subscription', pe.subscription, '--zone-name', cfg.name, '-o', 'none'],
      });
    }
  }

  // TERMINAL verifications. The first cut had NOTHING after single-register, so
  // when it emptied the group nothing could see it and the run exited 0.
  for (const pe of state.attachedEndpoints) {
    steps.push({
      id: 'verify-zone-group-bound-to-keep',
      needed: true,
      verify: true,
      verifyKind: 'zoneConfigs',
      why: `terminal check — ${pe.endpoint}/${pe.group} must STILL carry a config pointing at the surviving zone after the stale one was removed.`,
      expect: [keepId],
      argv: ['network', 'private-endpoint', 'dns-zone-group', 'list', '-g', pe.resourceGroup, '--endpoint-name', pe.endpoint, '--subscription', pe.subscription, '-o', 'json'],
    });
  }

  steps.push({
    id: 'verify-record-after-single-register',
    needed: true,
    verify: true,
    verifyKind: 'records',
    why: 'terminal check — every A record the stale zone served must STILL be in the surviving zone before the stale zone is deleted.',
    expect: state.staleRecords.map((r) => r.name),
    argv: ['network', 'private-dns', 'record-set', 'a', 'list', '-g', keepZoneRg, '-z', namespace, '--subscription', keepZoneSubscription, '-o', 'json'],
  });

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
 * How each kind of verification turns an `az … list` payload into the set of
 * things that must be present. Explicit, and looked up by `step.verifyKind` —
 * NOT by `step.id`. Keying on the id meant every id the author had not thought
 * of silently fell through to the "links" shape, which extracts `undefined` from
 * a record set and would have made a new verify step unable to fail.
 */
const VERIFY_EXTRACT = Object.freeze({
  records: (v) => (v ?? []).map((x) => lower(x.name)),
  links: (v) => (v ?? []).map((x) => lower(x.virtualNetwork?.id)),
  zoneConfigs: (v) => (v ?? []).flatMap((g) => (g.privateDnsZoneConfigs ?? []).map((c) => lower(c.privateDnsZoneId))),
});

/**
 * Execute. Verification steps are HARD GATES: a failed verify stops the run
 * before anything destructive, and says what it could not establish. Destructive
 * steps that carry a `precondition` re-read their subject first and may skip
 * (already converged) or stop (cannot prove the change is safe).
 */
export function applyPlan(plan, run, log) {
  for (const step of plan.steps) {
    if (step.verify) {
      const extract = VERIFY_EXTRACT[step.verifyKind];
      if (!extract) {
        return {
          ok: false,
          stoppedAt: step.id,
          reason:
            `internal defect: verification step "${step.id}" has no known verifyKind (got ${JSON.stringify(step.verifyKind)}). ` +
            'Refusing to continue rather than run a check that cannot fail. Nothing further was changed.',
        };
      }
      const res = readJson(run, step.argv);
      if (!res.ok) {
        return { ok: false, stoppedAt: step.id, reason: `verification could not read the estate: ${res.reason}. Nothing further was changed.` };
      }
      const got = extract(res.value);
      const expect = step.expect ?? [];
      const missing = expect.map(lower).filter((e) => !got.includes(e));
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
      // An empty expectation proves nothing, and must not be logged as if it did.
      log(
        expect.length === 0
          ? `  ~ ${step.id}: nothing to check (the stale zone served no such entries) — this step proved NOTHING.`
          : `  ✓ ${step.id}: ${expect.length} entr(ies) present in the surviving zone.`,
      );
      continue;
    }
    if (!step.needed) {
      log(`  · ${step.id}: already in the desired state — skipped.`);
      continue;
    }
    if (step.precondition) {
      const verdict = step.precondition(run);
      if (verdict.action === 'skip') {
        log(`  · ${step.id}: ${verdict.reason}`);
        continue;
      }
      if (verdict.action === 'stop') {
        return { ok: false, stoppedAt: step.id, reason: verdict.reason };
      }
      if (verdict.action !== 'run') {
        return {
          ok: false,
          stoppedAt: step.id,
          reason: `internal defect: precondition for "${step.id}" returned an unknown action ${JSON.stringify(verdict.action)}. Refusing to guess. Nothing further was changed.`,
        };
      }
    }
    const argv = step.argv;
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
    if (!s.verify) out.push(`        az ${s.argv.join(' ')}`);
  });
  out.push('');
  out.push(
    'NOTE: steps `unlink-stale` → `link-keep` are a resolution gap of seconds. Azure permits one link ' +
      'per namespace per VNet, so the old link must be removed before the new one can be created; that is ' +
      'an Azure constraint, not a choice made here.',
  );
  out.push(
    'NOTE: `az … dns-zone-group add|remove --zone-name` selects the CONFIG BY ITS NAME, not by the zone id ' +
      '(measured from azure-cli _add.py / _remove.py SubresourceSelector). Every add above uses a name nothing ' +
      'else in the group owns, and every remove targets a name read from the estate. Each destructive step ' +
      're-reads the group immediately before acting and REFUSES anything it cannot prove is safe — in ' +
      'particular it will never leave a group with zero configs (#3046).',
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

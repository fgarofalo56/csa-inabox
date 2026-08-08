/**
 * migrate-private-dns-zone-owner.test.mjs — the migration is ORDERED,
 * IDEMPOTENT, NON-DESTRUCTIVE, and REFUSES anything it cannot prove is safe
 * (issues #3039 / #3046 / #3038, deploy-integrity.md R5/R6/R7).
 *
 * THE FAKE `az` MODELS THE VENDOR'S BEHAVIOUR, NOT OURS.
 *
 *   The previous version of this file was GREEN while the script was causing a
 *   live outage, because its fake `dns-zone-group remove` filtered by
 *   `privateDnsZoneId` — i.e. it implemented the FIX the script did not have.
 *   A fixture that models what the code wishes were true proves nothing (memory:
 *   csa_loom_fixtures_that_model_the_code). So the semantics below are copied
 *   from the az CLI source, which is quoted here so a reader can check them:
 *
 *     azure-cli/src/azure-cli/azure/cli/command_modules/network/aaz/latest/
 *       network/private_endpoint/dns_zone_group/_add.py     (SubresourceSelector)
 *       network/private_endpoint/dns_zone_group/_remove.py  (SubresourceSelector)
 *
 *       def _get(self):
 *           result = self.ctx.vars.instance.properties.privateDnsZoneConfigs
 *           filters = filter(lambda e: e[1].name == self.ctx.args.zone_name, enumerate(result))
 *           idx = next(filters)[0]          # remove: StopIteration when absent
 *       def _set(self, value):
 *           ...
 *           idx = next(filters, [len(result)])[0]   # add: REPLACE if the NAME
 *           result[idx] = value                     # exists, else APPEND
 *
 *   Both commands select the config by its `name`. Neither looks at the zone id.
 *
 *   The estate model also encodes the physical consequence that made the outage
 *   an outage: a private endpoint registers its A record in EVERY zone its group
 *   references, and in none when the group has no configs.
 *
 *   The starting shape is what the bicep actually produces —
 *   platform/fiab/bicep/modules/landing-zone/databricks.bicep:135 names the
 *   config `privatelink-azuredatabricks-net`, byte-identical to
 *   `namespace.replace(/\./g,'-')`.
 *
 * Run: node --test scripts/csa-loom/__tests__/migrate-private-dns-zone-owner.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT,
  STEP_IDS,
  discover,
  buildPlan,
  isConverged,
  applyPlan,
  renderPlan,
  parseArgs,
  keepConfigName,
  guardSingleRegister,
  run as runMigration,
  zoneId,
} from '../migrate-private-dns-zone-owner.mjs';

const KEEP_SUB = '00000000-0000-0000-0000-00000000aaaa';
const STALE_SUB = '00000000-0000-0000-0000-00000000bbbb';
const KEEP_RG = 'rg-csa-loom-admin-centralus';
const STALE_RG = 'rg-csa-loom-dlz-default-centralus';
const NS = 'privatelink.azuredatabricks.net';
const BICEP_CFG_NAME = 'privatelink-azuredatabricks-net'; // databricks.bicep:135
const HUB = `/subscriptions/${KEEP_SUB}/resourceGroups/${KEEP_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-centralus`;
const SPOKE = `/subscriptions/${STALE_SUB}/resourceGroups/${STALE_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-dlz-default-centralus`;
const KEEP_ID = zoneId(KEEP_SUB, KEEP_RG, NS);
const STALE_ID = zoneId(STALE_SUB, STALE_RG, NS);
const PE = 'pe-adb-loom-default-uiapi';
const A_NAME = 'adb-7405606457049619.19';

const OPTS = {
  namespace: NS,
  keepZoneRg: KEEP_RG,
  keepZoneSubscription: KEEP_SUB,
  staleZoneRg: STALE_RG,
  staleZoneSubscription: STALE_SUB,
  peResourceGroups: [],
  apply: false,
  json: false,
};

/**
 * A fake estate in exactly the shape measured on the live Commercial estate on
 * 2026-08-06: the stale zone owns both links and the A record, the keep zone
 * exists and is empty, and the DLZ ui-api endpoint's DNS zone group points at
 * the stale zone through a config named by the bicep.
 */
function estate(overrides = {}) {
  return {
    calls: [],
    keepId: KEEP_ID,
    staleId: STALE_ID,
    zones: {
      [STALE_SUB]: [{ name: NS, id: STALE_ID, resourceGroup: STALE_RG }],
      [KEEP_SUB]: [{ name: NS, id: KEEP_ID, resourceGroup: KEEP_RG }],
    },
    links: {
      [STALE_ID]: [
        { name: 'link-dlz', virtualNetwork: { id: SPOKE }, registrationEnabled: false },
        { name: 'link-hub', virtualNetwork: { id: HUB }, registrationEnabled: false },
      ],
      [KEEP_ID]: [],
    },
    endpoints: {
      [STALE_RG]: [{ name: PE }, { name: 'pe-adb-loom-default-browserauth' }],
    },
    groups: {
      [PE]: [{ name: 'default', privateDnsZoneConfigs: [{ name: BICEP_CFG_NAME, privateDnsZoneId: STALE_ID }] }],
      'pe-adb-loom-default-browserauth': [],
    },
    ...overrides,
  };
}

/** Which zones the PE currently registers its A record into. */
function boundZones(st) {
  return new Set(
    Object.values(st.groups)
      .flat()
      .flatMap((g) => (g.privateDnsZoneConfigs ?? []).map((c) => c.privateDnsZoneId)),
  );
}
function zoneExists(st, zid) {
  return Object.values(st.zones).flat().some((z) => z.id === zid);
}
/** The A record is present in a zone iff the zone exists AND the PE binds it. */
function recordsIn(st, zid) {
  return zoneExists(st, zid) && boundZones(st).has(zid) ? [{ name: A_NAME, aRecords: [{ ipv4Address: '10.100.8.17' }] }] : [];
}
/** Every config across every group — what the group-level assertions look at. */
export function configsOf(st, pe = PE) {
  return st.groups[pe][0].privateDnsZoneConfigs;
}

/** Applies commands to `st`; reads answer from `st`. Vendor semantics — see header. */
function fakeAz(st, { failOn = null } = {}) {
  const ok = (v) => ({ status: 0, stdout: JSON.stringify(v ?? null), stderr: '' });
  const zoneKey = (sub, rg) => zoneId(sub, rg, NS);
  const arg = (a, f) => a[a.indexOf(f) + 1];

  return (args) => {
    st.calls.push(args.join(' '));
    const line = args.join(' ');
    const is = (prefix) => line.startsWith(prefix);
    if (failOn && is(failOn)) return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) refused' };

    const sub = arg(args, '--subscription');
    const g = arg(args, '-g');

    if (is('network private-dns zone list')) return ok(st.zones[sub] ?? []);
    if (is('network private-dns link vnet list')) return ok(st.links[zoneKey(sub, g)] ?? []);
    if (is('network private-dns record-set a list')) return ok(recordsIn(st, zoneKey(sub, g)));
    if (is('network private-endpoint list')) return ok(st.endpoints[g] ?? []);
    if (is('network private-endpoint dns-zone-group list')) return ok(st.groups[arg(args, '--endpoint-name')] ?? []);

    if (is('network private-endpoint dns-zone-group add')) {
      const grp = st.groups[arg(args, '--endpoint-name')][0];
      const cfgName = arg(args, '--zone-name');
      const zid = arg(args, '--private-dns-zone');
      const idx = grp.privateDnsZoneConfigs.findIndex((c) => c.name === cfgName);
      // _add.py: next(filters, [len(result)]) -> replace when the NAME exists.
      if (idx >= 0) grp.privateDnsZoneConfigs[idx] = { name: cfgName, privateDnsZoneId: zid };
      else grp.privateDnsZoneConfigs.push({ name: cfgName, privateDnsZoneId: zid });
      return ok(null);
    }
    if (is('network private-endpoint dns-zone-group remove')) {
      const grp = st.groups[arg(args, '--endpoint-name')][0];
      const cfgName = arg(args, '--zone-name');
      const idx = grp.privateDnsZoneConfigs.findIndex((c) => c.name === cfgName);
      // _remove.py: next(filters) with NO default -> StopIteration -> az fails.
      if (idx < 0) return { status: 1, stdout: '', stderr: 'ERROR: StopIteration' };
      grp.privateDnsZoneConfigs.splice(idx, 1);
      return ok(null);
    }
    if (is('network private-dns link vnet delete')) {
      const k = zoneKey(sub, g);
      const n = arg(args, '-n');
      st.links[k] = st.links[k].filter((l) => l.name !== n);
      return ok(null);
    }
    if (is('network private-dns link vnet create')) {
      const k = zoneKey(sub, g);
      st.links[k].push({ name: arg(args, '-n'), virtualNetwork: { id: arg(args, '--virtual-network') }, registrationEnabled: false });
      return ok(null);
    }
    if (is('network private-dns zone create')) {
      st.zones[sub] = [...(st.zones[sub] ?? []), { name: NS, id: zoneKey(sub, g), resourceGroup: g }];
      st.links[zoneKey(sub, g)] ??= [];
      return ok(null);
    }
    if (is('network private-dns zone delete')) {
      st.zones[sub] = (st.zones[sub] ?? []).filter((z) => z.resourceGroup !== g);
      return ok(null);
    }
    throw new Error(`fakeAz: unhandled ${line}`);
  };
}

test('discovery reads the estate the live one is in', () => {
  const st = estate();
  const s = discover(OPTS, fakeAz(st));
  assert.equal(s.ok, true);
  assert.ok(s.staleZone && s.keepZone);
  assert.deepEqual(s.staleLinks.map((l) => l.name).sort(), ['link-dlz', 'link-hub']);
  assert.deepEqual(s.staleRecords.map((r) => r.name), [A_NAME]);
  assert.equal(s.keepRecords.length, 0);
  assert.equal(s.attachedEndpoints.length, 1);
  assert.equal(s.attachedEndpoints[0].endpoint, PE);
  assert.match(s.notes.join(' '), /was NOT examined/);
});

test('THE ORDER — dual-register precedes every unlink; the terminal verifies sit between the removal and the zone delete', () => {
  const st = estate();
  const plan = buildPlan(OPTS, discover(OPTS, fakeAz(st)));
  const ids = plan.steps.map((s) => s.id);
  const idx = (id) => ids.indexOf(id);
  assert.ok(idx('dual-register') < idx('verify-record-in-keep-zone'));
  assert.ok(idx('verify-record-in-keep-zone') < idx('unlink-stale'));
  assert.ok(idx('unlink-stale') < idx('link-keep'));
  assert.ok(idx('link-keep') < idx('verify-links-on-keep-zone'));
  assert.ok(idx('verify-links-on-keep-zone') < idx('single-register'));
  // #3046: step 9 used to be the LAST thing before the delete, with nothing
  // watching it. Both terminal checks must now sit after it.
  assert.ok(idx('single-register') < idx('verify-zone-group-bound-to-keep'));
  assert.ok(idx('verify-zone-group-bound-to-keep') < idx('verify-record-after-single-register'));
  assert.ok(idx('verify-record-after-single-register') < idx('delete-stale-zone'));
  assert.equal(ids.at(-1), 'delete-stale-zone');
  assert.ok(ids.every((i) => STEP_IDS.includes(i)));
});

test('REGRESSION #3046 — dual-register must NOT reuse the config name the bicep owns', () => {
  const st = estate();
  const plan = buildPlan(OPTS, discover(OPTS, fakeAz(st)));
  const dual = plan.steps.find((s) => s.id === 'dual-register');
  const cfgArg = dual.argv[dual.argv.indexOf('--zone-name') + 1];
  assert.notEqual(
    cfgArg,
    BICEP_CFG_NAME,
    '`az dns-zone-group add` REPLACES a config whose NAME matches. Reusing the bicep name turns dual-registration into a silent single-registration.',
  );
  assert.equal(dual.argv[3], 'add', 'must be the appending form, never `create` (which replaces the whole group)');
});

test('REGRESSION #3046 — single-register targets the config by the name READ FROM THE ESTATE', () => {
  const st = estate();
  // A group whose stale config is named something the namespace does not predict.
  st.groups[PE][0].privateDnsZoneConfigs = [{ name: 'adb-legacy-cfg', privateDnsZoneId: STALE_ID }];
  const plan = buildPlan(OPTS, discover(OPTS, fakeAz(st)));
  const single = plan.steps.find((s) => s.id === 'single-register');
  assert.equal(
    single.argv[single.argv.indexOf('--zone-name') + 1],
    'adb-legacy-cfg',
    'the removal must name the real config, not namespace.replace(".","-")',
  );
});

test('REGRESSION #3046 — the full run leaves the zone group BOUND and the record RESOLVABLE', () => {
  const st = estate();
  const log = [];
  const code = runMigration({ ...OPTS, apply: true }, fakeAz(st), (s) => log.push(s));
  assert.equal(code, EXIT.OK, log.join('\n'));

  const cfgs = configsOf(st);
  assert.equal(cfgs.length, 1, `the group must not be emptied — got ${JSON.stringify(cfgs)}`);
  assert.equal(cfgs[0].privateDnsZoneId, KEEP_ID, 'the surviving config must point at the KEEP zone');
  assert.deepEqual(recordsIn(st, KEEP_ID).map((r) => r.name), [A_NAME], 'the A record must still resolve');

  // …and the migration actually happened.
  assert.equal(st.zones[STALE_SUB].length, 0, 'the stale zone is gone');
  assert.deepEqual(st.links[KEEP_ID].map((l) => l.virtualNetwork.id).sort(), [SPOKE, HUB].sort());
});

test('REGRESSION #3046 — the record is genuinely DUAL-registered during the window, not moved', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  // Run only up to the first verify: at that instant BOTH zones must carry it.
  const upToVerify = { steps: plan.steps.slice(0, plan.steps.findIndex((s) => s.id === 'verify-record-in-keep-zone') + 1) };
  const res = applyPlan(upToVerify, az, () => {});
  assert.equal(res.ok, true, res.reason ?? '');
  assert.equal(configsOf(st).length, 2, 'the group must reference BOTH zones — that is what "no gap" means');
  assert.deepEqual(recordsIn(st, STALE_ID).map((r) => r.name), [A_NAME]);
  assert.deepEqual(recordsIn(st, KEEP_ID).map((r) => r.name), [A_NAME]);
});

test('the resolution gap and the az selection semantics are DISCLOSED, not glossed', () => {
  const st = estate();
  const s = discover(OPTS, fakeAz(st));
  const out = renderPlan(OPTS, s, buildPlan(OPTS, s), { apply: false });
  assert.match(out, /RESOLUTION GAP OF SECONDS/);
  assert.match(out, /do NOT prove the name resolves from INSIDE the hub VNet/);
  assert.match(out, /selects the CONFIG BY ITS NAME/);
  assert.match(out, /never leave a group with zero configs/);
});

test('DRY RUN mutates nothing', () => {
  const st = estate();
  const code = runMigration({ ...OPTS, apply: false }, fakeAz(st), () => {});
  assert.equal(code, EXIT.OK);
  assert.ok(st.calls.every((c) => !/ (create|delete|add|remove)\b/.test(c)), st.calls.filter((c) => / (create|delete|add|remove)\b/.test(c)).join('\n'));
  assert.equal(st.links[STALE_ID].length, 2, 'the stale links are untouched');
  assert.equal(st.zones[STALE_SUB].length, 1, 'the stale zone is untouched');
  assert.deepEqual(configsOf(st), [{ name: BICEP_CFG_NAME, privateDnsZoneId: STALE_ID }]);
});

test('--apply converges the estate, and a SECOND run is a genuine no-op', () => {
  const st = estate();
  const log = [];
  assert.equal(runMigration({ ...OPTS, apply: true }, fakeAz(st), (s) => log.push(s)), EXIT.OK, log.join('\n'));

  const before = st.calls.length;
  const log2 = [];
  assert.equal(runMigration({ ...OPTS, apply: true }, fakeAz(st), (s) => log2.push(s)), EXIT.OK);
  assert.match(log2.join('\n'), /CONVERGED/);
  const mutations = st.calls.slice(before).filter((c) => /(zone|link vnet|dns-zone-group) (create|delete|add|remove)/.test(c));
  assert.deepEqual(mutations, [], 'a converged re-run must issue no mutation at all');
  // …and it did not damage anything on the way to deciding that.
  assert.equal(configsOf(st).length, 1);
  assert.deepEqual(recordsIn(st, KEEP_ID).map((r) => r.name), [A_NAME]);
});

test('NON-DESTRUCTIVE — a removal that would EMPTY the group is refused, and nothing changes', () => {
  const st = estate();
  const az = fakeAz(st);
  const s = discover(OPTS, az);
  const plan = buildPlan(OPTS, s);
  // Skip straight to the removal WITHOUT dual-registering — the state the
  // outage happened from. The guard must refuse rather than empty the group.
  const only = { steps: plan.steps.filter((x) => x.id === 'single-register') };
  const res = applyPlan(only, az, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'single-register');
  assert.match(res.reason, /ONLY config/);
  assert.match(res.reason, /takes the service dark/);
  assert.deepEqual(configsOf(st), [{ name: BICEP_CFG_NAME, privateDnsZoneId: STALE_ID }], 'nothing was removed');
  assert.deepEqual(recordsIn(st, STALE_ID).map((r) => r.name), [A_NAME], 'the record still resolves');
});

test('NON-DESTRUCTIVE — a config that no longer points at the stale zone is NOT removed', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  // Someone repoints the config between plan and apply. The plan is a snapshot;
  // the guard must notice and refuse rather than delete a live binding.
  configsOf(st)[0].privateDnsZoneId = KEEP_ID;
  configsOf(st).push({ name: 'other', privateDnsZoneId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net' });
  const only = { steps: plan.steps.filter((x) => x.id === 'single-register') };
  const res = applyPlan(only, az, () => {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /REFUSING/);
  assert.match(res.reason, /NOT the stale zone/);
  assert.equal(configsOf(st).length, 2, 'nothing was removed');
});

test('NON-DESTRUCTIVE — an unreadable group before a removal STOPS; unknown is not safe', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  const blind = (args) =>
    args.join(' ').startsWith('network private-endpoint dns-zone-group list')
      ? { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) refused' }
      : az(args);
  const only = { steps: plan.steps.filter((x) => x.id === 'single-register') };
  const res = applyPlan(only, blind, () => {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /UNKNOWN/);
  assert.match(res.reason, /Nothing was changed/);
  assert.equal(configsOf(st).length, 1);
});

test('NON-DESTRUCTIVE — an add whose config NAME is already taken is refused (it would REPLACE)', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  const dual = plan.steps.find((x) => x.id === 'dual-register');
  const cfgName = dual.argv[dual.argv.indexOf('--zone-name') + 1];
  // Someone creates a config with that exact name, pointing somewhere else.
  configsOf(st).push({ name: cfgName, privateDnsZoneId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net' });
  const res = applyPlan({ steps: [dual] }, az, () => {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /would REPLACE it/);
  assert.equal(configsOf(st).length, 2, 'nothing was overwritten');
});

test('a removal that is already done SKIPS — it does not re-issue and hit StopIteration', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  // Land the keep config, then drop the stale one out of band.
  configsOf(st).push({ name: 'already-keep', privateDnsZoneId: KEEP_ID });
  st.groups[PE][0].privateDnsZoneConfigs = configsOf(st).filter((c) => c.privateDnsZoneId !== STALE_ID);
  const only = { steps: plan.steps.filter((x) => x.id === 'single-register') };
  const log = [];
  const res = applyPlan(only, az, (s) => log.push(s));
  assert.equal(res.ok, true, res.reason ?? '');
  assert.match(log.join('\n'), /already absent/);
  assert.match(log.join('\n'), /converged, not re-applied/);
});

test('MUTATION PROOF — a failed verification stops BEFORE the first unlink', () => {
  const st = estate();
  const brokenAz = (args) => {
    if (args.slice(0, 4).join(' ') === 'network private-endpoint dns-zone-group add') {
      st.calls.push(args.join(' '));
      return { status: 0, stdout: 'null', stderr: '' }; // "succeeds", registers nothing
    }
    return fakeAz(st)(args);
  };
  const s = discover(OPTS, brokenAz);
  const res = applyPlan(buildPlan(OPTS, s), brokenAz, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'verify-record-in-keep-zone');
  assert.match(res.reason, /verification FAILED/);
  assert.match(res.reason, /Nothing destructive was run/);
  assert.equal(st.links[STALE_ID].length, 2);
  assert.equal(st.zones[STALE_SUB].length, 1);
});

test('MUTATION PROOF — the TERMINAL verify catches a wipe and stops before the zone delete', () => {
  const st = estate();
  const az = fakeAz(st);
  // A hostile `remove` that empties the group despite the guard — i.e. simulate
  // the guard being wrong. The terminal check is the second line of defence and
  // must catch it; without it, `delete-stale-zone` would run on a dark service.
  const wipingAz = (args) => {
    if (args.slice(0, 4).join(' ') === 'network private-endpoint dns-zone-group remove') {
      st.calls.push(args.join(' '));
      st.groups[PE][0].privateDnsZoneConfigs = [];
      return { status: 0, stdout: 'null', stderr: '' };
    }
    return az(args);
  };
  const res = applyPlan(buildPlan(OPTS, discover(OPTS, az)), wipingAz, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'verify-zone-group-bound-to-keep');
  assert.match(res.reason, /verification FAILED/);
  assert.equal(st.zones[STALE_SUB].length, 1, 'the stale zone was NOT deleted on a dark estate');
});

test('MUTATION PROOF — a verify with no recognised kind FAILS rather than passing vacuously', () => {
  const bogus = { steps: [{ id: 'verify-something', needed: true, verify: true, expect: ['x'], argv: ['network', 'private-dns', 'zone', 'list'] }] };
  const res = applyPlan(bogus, () => ({ status: 0, stdout: '[]', stderr: '' }), () => {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /no known verifyKind/);
  assert.match(res.reason, /cannot fail/);
});

test('MUTATION PROOF — a verification that cannot READ stops too, and says which it was', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  const blindRead = (args) =>
    args.join(' ').startsWith('network private-dns record-set a list') && args.includes(KEEP_RG)
      ? { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) refused' }
      : az(args);
  const res = applyPlan(plan, blindRead, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'verify-record-in-keep-zone');
  assert.match(res.reason, /could not read the estate/);
  assert.equal(st.links[STALE_ID].length, 2, 'nothing destructive ran');
});

test('an unreadable estate produces NO plan and asserts nothing', () => {
  const st = estate();
  const log = [];
  const code = runMigration(OPTS, fakeAz(st, { failOn: 'network private-dns zone list' }), (s) => log.push(s));
  assert.equal(code, EXIT.UNREADABLE);
  assert.match(log.join('\n'), /COULD NOT READ/);
  assert.match(log.join('\n'), /NOTHING is asserted/);
});

test('a mid-flight az refusal stops and reports the refusal verbatim', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  const refuseDelete = (args) =>
    args.join(' ').startsWith('network private-dns link vnet delete')
      ? { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) link delete refused' }
      : az(args);
  const res = applyPlan(plan, refuseDelete, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'unlink-stale');
  assert.match(res.reason, /link delete refused/);
});

test('keepConfigName never returns a name already in the group', () => {
  assert.equal(keepConfigName(NS, []), `${BICEP_CFG_NAME}-loom-keep`);
  assert.equal(keepConfigName(NS, [BICEP_CFG_NAME]), `${BICEP_CFG_NAME}-loom-keep`);
  assert.equal(keepConfigName(NS, [BICEP_CFG_NAME, `${BICEP_CFG_NAME}-loom-keep`]), `${BICEP_CFG_NAME}-loom-keep-2`);
  // Case-insensitive: ARM child names are not case-sensitive for uniqueness.
  assert.equal(keepConfigName(NS, [`${BICEP_CFG_NAME}-LOOM-KEEP`]), `${BICEP_CFG_NAME}-loom-keep-2`);
  // ARM caps a child resource name at 80 characters.
  const long = `privatelink.${'a'.repeat(90)}.net`;
  assert.ok(keepConfigName(long, []).length <= 80);
  assert.ok(keepConfigName(long, []).endsWith('-loom-keep'));
});

test('guardSingleRegister is callable on its own and refuses an empty-group removal', () => {
  const st = estate();
  const az = fakeAz(st);
  const pe = { resourceGroup: STALE_RG, subscription: STALE_SUB, endpoint: PE, group: 'default' };
  const v = guardSingleRegister(az, pe, BICEP_CFG_NAME, KEEP_ID, STALE_ID);
  assert.equal(v.action, 'stop');
  assert.match(v.reason, /2026-08-06 outage/);
});

test('isConverged is false while the stale zone exists, whatever else is true', () => {
  const st = estate();
  const s = discover(OPTS, fakeAz(st));
  assert.equal(isConverged(s, buildPlan(OPTS, s)), false);
});

test('parseArgs requires nothing it can silently default, and rejects typos', () => {
  assert.throws(() => parseArgs(['--aply']), /unknown argument/);
  const a = parseArgs(['--namespace', NS, '--pe-resource-group', 'rg-a', '--pe-resource-group', 'rg-b', '--apply']);
  assert.deepEqual(a.peResourceGroups, ['rg-a', 'rg-b']);
  assert.equal(a.apply, true);
  assert.equal(parseArgs([]).apply, false, 'dry run is the default');
});

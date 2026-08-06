/**
 * migrate-private-dns-zone-owner.test.mjs — the migration is ORDERED,
 * IDEMPOTENT, and REFUSES to do the destructive half on an unverified estate
 * (issue #3039, deploy-integrity.md R5/R6/R7).
 *
 * The runner is a fake `az` that models ESTATE STATE, not the script: it holds
 * zones, links, records and DNS zone groups, applies each command to that state,
 * and answers subsequent reads from it. So "the record is present in the keep
 * zone at step 3" is a consequence of step 2 having actually run, not of the
 * fixture being written to say so.
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
  run as runMigration,
  zoneId,
} from '../migrate-private-dns-zone-owner.mjs';

const KEEP_SUB = '00000000-0000-0000-0000-00000000aaaa';
const STALE_SUB = '00000000-0000-0000-0000-00000000bbbb';
const KEEP_RG = 'rg-csa-loom-admin-centralus';
const STALE_RG = 'rg-csa-loom-dlz-default-centralus';
const NS = 'privatelink.azuredatabricks.net';
const HUB = `/subscriptions/${KEEP_SUB}/resourceGroups/${KEEP_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-centralus`;
const SPOKE = `/subscriptions/${STALE_SUB}/resourceGroups/${STALE_RG}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-dlz-default-centralus`;

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
 * A fake estate. Starts in exactly the shape measured on the live Commercial
 * estate on 2026-08-06: the stale zone owns both links and the A record, the
 * keep zone exists and is empty, and the DLZ ui-api endpoint's DNS zone group
 * points at the stale zone.
 */
function estate(overrides = {}) {
  const staleId = zoneId(STALE_SUB, STALE_RG, NS);
  const keepId = zoneId(KEEP_SUB, KEEP_RG, NS);
  return {
    calls: [],
    keepId,
    staleId,
    zones: {
      [STALE_SUB]: [{ name: NS, id: staleId, resourceGroup: STALE_RG }],
      [KEEP_SUB]: [{ name: NS, id: keepId, resourceGroup: KEEP_RG }],
    },
    links: {
      [staleId]: [
        { name: 'link-dlz', virtualNetwork: { id: SPOKE }, registrationEnabled: false },
        { name: 'link-hub', virtualNetwork: { id: HUB }, registrationEnabled: false },
      ],
      [keepId]: [],
    },
    records: {
      [staleId]: [{ name: 'adb-7405606457049619.19', aRecords: [{ ipv4Address: '10.100.8.17' }] }],
      [keepId]: [],
    },
    endpoints: {
      [STALE_RG]: [{ name: 'pe-adb-loom-default-uiapi' }, { name: 'pe-adb-loom-default-browserauth' }],
    },
    zoneGroups: {
      'pe-adb-loom-default-uiapi': [{ name: 'default', privateDnsZoneConfigs: [{ name: 'adb', privateDnsZoneId: staleId }] }],
      'pe-adb-loom-default-browserauth': [],
    },
    ...overrides,
  };
}

/** Applies commands to `st`; reads answer from `st`. */
function fakeAz(st, { failOn = null } = {}) {
  const ok = (v) => ({ status: 0, stdout: JSON.stringify(v ?? null), stderr: '' });
  const zoneKey = (sub, rg) => zoneId(sub, rg, NS);
  const subOf = (a) => a[a.indexOf('--subscription') + 1];
  const gOf = (a) => a[a.indexOf('-g') + 1];

  return (args) => {
    st.calls.push(args.join(' '));
    const line = args.join(' ');
    const is = (prefix) => line.startsWith(prefix);
    if (failOn && is(failOn)) {
      return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) refused' };
    }
    if (is('network private-dns zone list')) return ok(st.zones[subOf(args)] ?? []);
    if (is('network private-dns link vnet list')) return ok(st.links[zoneKey(subOf(args), gOf(args))] ?? []);
    if (is('network private-dns record-set a list')) return ok(st.records[zoneKey(subOf(args), gOf(args))] ?? []);
    if (is('network private-endpoint list')) return ok(st.endpoints[gOf(args)] ?? []);
    if (is('network private-endpoint dns-zone-group list')) {
      return ok(st.zoneGroups[args[args.indexOf('--endpoint-name') + 1]] ?? []);
    }
    if (is('network private-endpoint dns-zone-group add')) {
      const pe = args[args.indexOf('--endpoint-name') + 1];
      const z = args[args.indexOf('--private-dns-zone') + 1];
      st.zoneGroups[pe][0].privateDnsZoneConfigs.push({ name: 'added', privateDnsZoneId: z });
      // Adding the zone to the group is what registers the A record in it.
      st.records[z] = [...st.records[st.staleId]];
      return ok(null);
    }
    if (is('network private-endpoint dns-zone-group remove')) {
      const pe = args[args.indexOf('--endpoint-name') + 1];
      st.zoneGroups[pe][0].privateDnsZoneConfigs = st.zoneGroups[pe][0].privateDnsZoneConfigs.filter(
        (c) => c.privateDnsZoneId !== st.staleId,
      );
      st.records[st.staleId] = [];
      return ok(null);
    }
    if (is('network private-dns link vnet delete')) {
      const k = zoneKey(subOf(args), gOf(args));
      const n = args[args.indexOf('-n') + 1];
      st.links[k] = st.links[k].filter((l) => l.name !== n);
      return ok(null);
    }
    if (is('network private-dns link vnet create')) {
      const k = zoneKey(subOf(args), gOf(args));
      st.links[k].push({
        name: args[args.indexOf('-n') + 1],
        virtualNetwork: { id: args[args.indexOf('--virtual-network') + 1] },
        registrationEnabled: false,
      });
      return ok(null);
    }
    if (is('network private-dns zone create')) {
      const sub = subOf(args);
      st.zones[sub] = [...(st.zones[sub] ?? []), { name: NS, id: zoneKey(sub, gOf(args)), resourceGroup: gOf(args) }];
      st.links[zoneKey(sub, gOf(args))] ??= [];
      st.records[zoneKey(sub, gOf(args))] ??= [];
      return ok(null);
    }
    if (is('network private-dns zone delete')) {
      const sub = subOf(args);
      st.zones[sub] = (st.zones[sub] ?? []).filter((z) => z.resourceGroup !== gOf(args));
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
  assert.deepEqual(s.staleRecords.map((r) => r.name), ['adb-7405606457049619.19']);
  assert.equal(s.keepRecords.length, 0);
  assert.equal(s.attachedEndpoints.length, 1);
  assert.equal(s.attachedEndpoints[0].endpoint, 'pe-adb-loom-default-uiapi');
  assert.match(s.notes.join(' '), /was NOT examined/);
});

test('THE ORDER — dual-register and its verify come BEFORE any unlink, and the delete is last', () => {
  const st = estate();
  const plan = buildPlan(OPTS, discover(OPTS, fakeAz(st)));
  const ids = plan.steps.map((s) => s.id);
  const idx = (id) => ids.indexOf(id);
  assert.ok(idx('dual-register') < idx('verify-record-in-keep-zone'));
  assert.ok(idx('verify-record-in-keep-zone') < idx('unlink-stale'));
  assert.ok(idx('unlink-stale') < idx('link-keep'));
  assert.ok(idx('link-keep') < idx('verify-links-on-keep-zone'));
  assert.ok(idx('verify-links-on-keep-zone') < idx('single-register'));
  assert.equal(ids.at(-1), 'delete-stale-zone');
  assert.ok(ids.every((i) => STEP_IDS.includes(i)));
  // The dangerous ordering the issue proposed is explicitly NOT produced.
  assert.ok(idx('unlink-stale') > idx('dual-register'), 'never unlink before the record is dual-registered');
});

test('the resolution gap is DISCLOSED, not glossed', () => {
  const st = estate();
  const s = discover(OPTS, fakeAz(st));
  const out = renderPlan(OPTS, s, buildPlan(OPTS, s), { apply: false });
  assert.match(out, /RESOLUTION GAP OF SECONDS/);
  assert.match(out, /do NOT prove the name resolves from INSIDE the hub VNet/);
});

test('DRY RUN mutates nothing', () => {
  const st = estate();
  const code = runMigration({ ...OPTS, apply: false }, fakeAz(st), () => {});
  assert.equal(code, EXIT.OK);
  assert.ok(st.calls.every((c) => !/ (create|delete|add|remove)\b/.test(c)), st.calls.filter((c) => / (create|delete|add|remove)\b/.test(c)).join('\n'));
  assert.equal(st.links[st.staleId].length, 2, 'the stale links are untouched');
  assert.ok(st.zones[STALE_SUB].length === 1, 'the stale zone is untouched');
});

test('--apply converges the estate, and a SECOND run is a genuine no-op', () => {
  const st = estate();
  const log = [];
  const first = runMigration({ ...OPTS, apply: true }, fakeAz(st), (s) => log.push(s));
  assert.equal(first, EXIT.OK, log.join('\n'));

  // The estate really moved.
  assert.equal(st.zones[STALE_SUB].length, 0, 'the stale zone is gone');
  assert.deepEqual(st.links[st.keepId].map((l) => l.virtualNetwork.id).sort(), [SPOKE, HUB].sort());
  assert.equal(st.records[st.keepId].length, 1);

  const before = st.calls.length;
  const log2 = [];
  const second = runMigration({ ...OPTS, apply: true }, fakeAz(st), (s) => log2.push(s));
  assert.equal(second, EXIT.OK);
  assert.match(log2.join('\n'), /CONVERGED/);
  // A no-op reads the estate and issues no mutation at all.
  const mutations = st.calls.slice(before).filter((c) => /(zone|link vnet|dns-zone-group) (create|delete|add|remove)/.test(c));
  assert.deepEqual(mutations, []);
});

test('MUTATION PROOF — a failed verification stops BEFORE the first unlink', () => {
  const st = estate();
  // Break exactly one thing: dual-registration silently registers nothing, so
  // the record never appears in the keep zone. Everything else is unchanged.
  const brokenAz = (args) => {
    if (args.slice(0, 4).join(' ') === 'network private-endpoint dns-zone-group add') {
      st.calls.push(args.join(' '));
      return { status: 0, stdout: 'null', stderr: '' }; // "succeeds", registers nothing
    }
    return fakeAz(st)(args);
  };
  const s = discover(OPTS, brokenAz);
  const plan = buildPlan(OPTS, s);
  const res = applyPlan(plan, brokenAz, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'verify-record-in-keep-zone');
  assert.match(res.reason, /verification FAILED/);
  assert.match(res.reason, /Nothing destructive was run/);
  // …and the estate still has both stale links, i.e. no outage was caused.
  assert.equal(st.links[st.staleId].length, 2);
  assert.equal(st.zones[STALE_SUB].length, 1);
});

test('MUTATION PROOF — a verification that cannot READ stops too, and says which it was', () => {
  const st = estate();
  const az = fakeAz(st);
  const plan = buildPlan(OPTS, discover(OPTS, az));
  const blindRead = (args) => {
    if (args.join(' ').startsWith('network private-dns record-set a list') && args.includes(KEEP_RG)) {
      return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) refused' };
    }
    return az(args);
  };
  const res = applyPlan(plan, blindRead, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'verify-record-in-keep-zone');
  assert.match(res.reason, /could not read the estate/);
  assert.equal(st.links[st.staleId].length, 2, 'nothing destructive ran');
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
  const refuseDelete = (args) => {
    if (args.join(' ').startsWith('network private-dns link vnet delete')) {
      return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) link delete refused' };
    }
    return az(args);
  };
  const res = applyPlan(plan, refuseDelete, () => {});
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, 'unlink-stale');
  assert.match(res.reason, /link delete refused/);
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

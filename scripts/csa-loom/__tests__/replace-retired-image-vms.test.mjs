// Tests for scripts/csa-loom/replace-retired-image-vms.mjs (#4672), with a stubbed az.
// Each test names the input that breaks it (assertion-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, parseArgs, loadDenylist, RemediationError } from '../replace-retired-image-vms.mjs';

const RG = 'rg-csa-loom-admin-centralus';
const DISK = (n, rg = RG) => `/subscriptions/s/resourceGroups/${rg}/providers/Microsoft.Compute/disks/${n}`;
const vm = (name, offer, { sku = '2022-datacenter-azure-edition', rg = RG, diskRg = rg, location = 'centralus' } = {}) => ({
  name, location,
  storageProfile: {
    imageReference: { publisher: 'MicrosoftWindowsServer', offer, sku, version: 'latest' },
    osDisk: { managedDisk: { id: DISK(`${name}-osdisk`, diskRg) } },
  },
});

/** Stateful az stub: VMs and disks disappear when deleted; every call is recorded. */
function makeAz({ vms, skus = ['2022-datacenter-azure-edition', '2022-datacenter'], rgExists = 'true', diskAttachedAfterDelete = false }) {
  const calls = [];
  const state = { vms: [...vms], disks: vms.map((v) => v.storageProfile.osDisk.managedDisk.id.split('/').pop()) };
  const az = async (args) => {
    calls.push(args.join(' '));
    const [a, b] = args;
    const flag = (f) => args[args.indexOf(f) + 1];
    if (a === 'group' && b === 'exists') return `${rgExists}\n`;
    if (a === 'vm' && b === 'list') {
      if (args.includes('--query')) return state.vms.filter((v) => v.name === /name=='([^']+)'/.exec(flag('--query'))[1]).map((v) => v.name).join('\n');
      return JSON.stringify(state.vms);
    }
    if (a === 'vm' && b === 'image') return JSON.stringify(skus.map((name) => ({ name })));
    if (a === 'vm' && b === 'get-instance-view') return 'PowerState/running\n';
    if (a === 'vm' && b === 'delete') { state.vms = state.vms.filter((v) => v.name !== flag('--name')); return ''; }
    if (a === 'disk' && b === 'list') {
      const name = /name=='([^']+)'/.exec(flag('--query'))[1];
      if (!state.disks.includes(name)) return '';
      return args.includes('--query') && /\[id,managedBy\]/.test(flag('--query')) ? `${DISK(name)}\t${diskAttachedAfterDelete ? 'vm-other' : 'None'}\n` : `${name}\n`;
    }
    if (a === 'disk' && b === 'delete') { state.disks = state.disks.filter((d) => d !== flag('--name')); return ''; }
    throw new Error(`unexpected az call: ${args.join(' ')}`);
  };
  return { az, calls, state };
}
const mutating = (calls) => calls.filter((c) => /^(vm|disk) delete/.test(c));
const quiet = () => {};

test('dry-run deletes nothing but reports the retired VM (breaks on: any delete call in dry-run)', async () => {
  const { az, calls, state } = makeAz({ vms: [vm('vm-loom-pbigw-centralus', 'WindowsServer')] });
  const s = await run({ rgs: [RG], mode: 'dry-run', az, log: quiet });
  assert.deepEqual(mutating(calls), []);
  assert.deepEqual(s.found, ['vm-loom-pbigw-centralus']);
  assert.equal(state.vms.length, 1);
});

test('apply deletes the VM THEN its disk, in that order, and reads both back (breaks on: disk-first order or missing read-back)', async () => {
  const { az, calls, state } = makeAz({ vms: [vm('vm-loom-pbigw-centralus', 'WindowsServer')] });
  const s = await run({ rgs: [RG], mode: 'apply', az, log: quiet });
  assert.deepEqual(mutating(calls), [
    `vm delete --resource-group ${RG} --name vm-loom-pbigw-centralus --yes`,
    `disk delete --resource-group ${RG} --name vm-loom-pbigw-centralus-osdisk --yes`,
  ]);
  assert.deepEqual(s.replaced, ['vm-loom-pbigw-centralus']);
  assert.deepEqual(state.vms, []);
  assert.deepEqual(state.disks, []);
  const lastVmDelete = calls.findIndex((c) => c.startsWith('vm delete'));
  assert.ok(calls.slice(lastVmDelete + 1).some((c) => c.startsWith('vm list') && c.includes('--query')), 'VM read-back must follow the delete');
});

test('missing replacement image in the VM region: NOTHING deleted and error names region + sku (breaks on: delete before preflight)', async () => {
  const { az, calls } = makeAz({ vms: [vm('a', 'WindowsServer', { location: 'usgovvirginia' })], skus: ['2019-datacenter'] });
  await assert.rejects(run({ rgs: [RG], mode: 'apply', az, log: quiet }), (e) => {
    assert.ok(e instanceof RemediationError);
    assert.match(e.message, /usgovvirginia/);
    assert.match(e.message, /2022-datacenter-azure-edition/);
    return true;
  });
  assert.deepEqual(mutating(calls), []);
});

test('one VM missing its image blocks deleting a SECOND, healthy-to-replace VM (breaks on: per-VM instead of up-front preflight)', async () => {
  const good = vm('good', 'WindowsServer');
  const bad = vm('bad', 'WindowsServer', { sku: '2022-datacenter-core-g2' });
  const { az, calls } = makeAz({ vms: [good, bad] });
  await assert.rejects(run({ rgs: [RG], mode: 'apply', az, log: quiet }), /2022-datacenter-core-g2/);
  assert.deepEqual(mutating(calls), []);
});

test('non-denylisted VMs are untouched; case variant of the retired offer IS replaced (breaks on: deleting windowsserver2022 / case-sensitive match)', async () => {
  const keep = vm('keep', 'windowsserver2022');
  const lin = { name: 'linux', location: 'centralus', storageProfile: { imageReference: { publisher: 'Canonical', offer: 'WindowsServer', sku: 'x' }, osDisk: { managedDisk: { id: DISK('linux-osdisk') } } } };
  const retired = vm('old', 'windowsserver');
  const { az, calls, state } = makeAz({ vms: [keep, lin, retired] });
  await run({ rgs: [RG], mode: 'apply', az, log: quiet });
  assert.deepEqual(mutating(calls), [
    `vm delete --resource-group ${RG} --name old --yes`,
    `disk delete --resource-group ${RG} --name old-osdisk --yes`,
  ]);
  assert.deepEqual(state.vms.map((v) => v.name), ['keep', 'linux']);
});

test('only the given resource group is queried (breaks on: subscription-wide listing)', async () => {
  const { az, calls } = makeAz({ vms: [vm('a', 'windowsserver2022')] });
  await run({ rgs: [RG], mode: 'apply', az, log: quiet });
  for (const c of calls.filter((x) => x.startsWith('vm list') || x.startsWith('disk list'))) {
    assert.ok(c.includes(`--resource-group ${RG}`), c);
  }
});

test('OS disk in a different resource group than the VM is refused, nothing deleted', async () => {
  const { az, calls } = makeAz({ vms: [vm('a', 'WindowsServer', { diskRg: 'rg-other' })] });
  await assert.rejects(run({ rgs: [RG], mode: 'apply', az, log: quiet }), /outside resource group/);
  assert.deepEqual(mutating(calls), []);
});

test('disk still attached elsewhere after VM delete: disk NOT deleted', async () => {
  const { az, calls } = makeAz({ vms: [vm('a', 'WindowsServer')], diskAttachedAfterDelete: true });
  await assert.rejects(run({ rgs: [RG], mode: 'apply', az, log: quiet }), /still attached/);
  assert.deepEqual(mutating(calls), [`vm delete --resource-group ${RG} --name a --yes`]);
});

test('missing resource group (greenfield) is a clean no-op, not an error', async () => {
  const { az, calls } = makeAz({ vms: [], rgExists: 'false' });
  const s = await run({ rgs: [RG], mode: 'apply', az, log: quiet });
  assert.deepEqual(s.skippedRgs, [RG]);
  assert.deepEqual(calls, [`group exists --name ${RG}`]);
});

test('an az failure propagates (no swallowed error) (breaks on: try/catch around az)', async () => {
  const { az } = makeAz({ vms: [vm('a', 'WindowsServer')] });
  const failing = async (args) => { if (args[0] === 'vm' && args[1] === 'delete') throw new RemediationError('az vm delete failed: Forbidden'); return az(args); };
  await assert.rejects(run({ rgs: [RG], mode: 'apply', az: failing, log: quiet }), /Forbidden/);
});

test('parseArgs: default RG derives from region; bad boundary/mode rejected', () => {
  assert.deepEqual(parseArgs(['--boundary', 'GCC-High'], {}).rgs, ['rg-csa-loom-admin-usgovvirginia']);
  assert.deepEqual(parseArgs(['--boundary', 'Commercial'], { AZURE_LOCATION: 'centralus' }).rgs, [RG]);
  assert.equal(parseArgs(['--boundary', 'GCC-High'], {}).mode, 'dry-run');
  assert.throws(() => parseArgs(['--boundary', 'Commercial'], {}), /cannot derive/);
  assert.throws(() => parseArgs(['--boundary', 'Mars']), /--boundary/);
  assert.throws(() => parseArgs(['--boundary', 'IL5', '--mode', 'yolo']), /--mode/);
});

test('denylist loads and carries a replacementOffer', () => {
  assert.equal(loadDenylist()[0].replacementOffer, 'windowsserver2022');
});

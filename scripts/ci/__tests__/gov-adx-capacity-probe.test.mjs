import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, probeOne, sweep, template } from '../gov-adx-capacity-probe.mjs';

const CAP = '{"code":"InsufficientResourcesForSubscription","message":"no available resources for the cluster"}';

test('classify: the exact Gov refusal is capacity-refused; the same text on a Succeeded state is still accepted', () => {
  assert.equal(classify('Failed', CAP), 'capacity-refused');
  assert.equal(classify('Succeeded', CAP), 'accepted');
  assert.equal(classify('Failed', 'SkuNotAvailable for subscription'), 'not-offered');
  assert.equal(classify('Failed', 'something else'), 'failed-other');
  assert.equal(classify('Running', ''), 'inconclusive');
});

function fakeAz(states) {
  const calls = [];
  const az = (a) => {
    calls.push(a.join(' '));
    if (a[0] === 'deployment' && a[2] === 'show') return { status: 0, stdout: JSON.stringify(states.shift()), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { az, calls };
}
const base = (az, extra = {}) => ({
  az, sku: 'Standard_E8as_v5+1TB_PS', idx: 0, rg: 'rg', region: 'usgovarizona', capacity: 2,
  maxWait: 60, poll: 30, dir: mkdtempSync(join(tmpdir(), 't-')), sleepFn: async () => {}, runId: '1', ...extra,
});

test('probeOne: a Failed deployment with the capacity error is refused, and the cluster is still deleted', async () => {
  const { az, calls } = fakeAz([{ s: 'Running', e: null }, { s: 'Failed', e: JSON.parse(CAP) }]);
  const r = await probeOne(base(az));
  assert.equal(r.verdict, 'capacity-refused');
  assert.ok(calls.some((c) => c.startsWith('kusto cluster delete') && c.includes('adxprobe-10')), calls.join('\n'));
});

test('probeOne: Succeeded is accepted', async () => {
  const { az } = fakeAz([{ s: 'Succeeded', e: null }]);
  assert.equal((await probeOne(base(az))).verdict, 'accepted');
});

test('probeOne: still Running at the timeout is inconclusive, never refused or accepted', async () => {
  const { az } = fakeAz(Array(5).fill({ s: 'Running', e: null }));
  assert.equal((await probeOne(base(az, { maxWait: 60 }))).verdict, 'inconclusive');
});

test('probeOne: an unreadable state is inconclusive and still cleans up', async () => {
  const calls = [];
  const az = (a) => {
    calls.push(a.join(' '));
    return a[2] === 'show' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' };
  };
  const r = await probeOne(base(az));
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(calls.some((c) => c.startsWith('kusto cluster delete')));
});

test('template carries the SKU name verbatim (the + survives), the region and the capacity', () => {
  const t = template('adxprobe-1', 'Standard_E8as_v5+1TB_PS', 2, 'usgovarizona');
  assert.equal(t.resources[0].sku.name, 'Standard_E8as_v5+1TB_PS');
  assert.equal(t.resources[0].location, 'usgovarizona');
  assert.equal(t.resources[0].sku.capacity, 2);
});

test('sweep deletes exactly what the list returned, and reports when it cannot list', () => {
  const calls = [];
  const az = (a) => {
    calls.push(a.join(' '));
    return a[2] === 'list' ? { status: 0, stdout: 'adxprobe-9\nadxprobe-8\n', stderr: '' } : { status: 0, stdout: '', stderr: '' };
  };
  const s = sweep(az, 'rg');
  assert.deepEqual(s.left, ['adxprobe-9', 'adxprobe-8']);
  assert.equal(calls.filter((c) => c.includes('delete')).length, 2);
  assert.equal(sweep(() => ({ status: 1, stdout: '', stderr: 'denied' }), 'rg').ok, false);
});

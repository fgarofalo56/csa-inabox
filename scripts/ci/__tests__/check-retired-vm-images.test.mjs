// Tests for scripts/ci/check-retired-vm-images.mjs (#4672).
// Each test names the input that would break it (assertion-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRoot, loadDenylist } from '../check-retired-vm-images.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DENY = loadDenylist();

function scanFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-img-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
    }
    return scanRoot(dir, DENY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const vm = (offer, pub = "'MicrosoftWindowsServer'") => `resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: 'x'
  properties: {
    storageProfile: {
      imageReference: {
        publisher: ${pub}
        offer: ${offer}
        sku: '2022-datacenter-azure-edition'
        version: 'latest'
      }
    }
  }
}
`;

test('retired offer WindowsServer fails and names file:line (breaks on: offer line 7)', () => {
  const r = scanFiles({ 'a/vm.bicep': vm("'WindowsServer'") });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'retired');
  assert.match(r.violations[0].message, /^a\/vm\.bicep:7:/);
  assert.equal(r.checked, 1);
});

test('windowsserver2022 passes and is actually examined (breaks on: any retired match, or checked==0)', () => {
  const r = scanFiles({ 'a/vm.bicep': vm("'windowsserver2022'") });
  assert.deepEqual(r.violations, []);
  assert.equal(r.checked, 1, 'the reference must be examined, not skipped');
});

test('case variants fail (breaks on: a case-sensitive compare)', () => {
  for (const offer of ["'windowsServer'", "'WINDOWSSERVER'", "'windowsserver'"]) {
    const r = scanFiles({ 'vm.bicep': vm(offer) });
    assert.equal(r.violations.length, 1, `${offer} must fail`);
  }
  const pubCase = scanFiles({ 'vm.bicep': vm("'WindowsServer'", "'microsoftwindowsserver'") });
  assert.equal(pubCase.violations.length, 1, 'publisher case must not launder the offer');
});

test('a different publisher with the same offer name passes (breaks on: offer-only matching)', () => {
  const r = scanFiles({ 'vm.bicep': vm("'WindowsServer'", "'SomeoneElse'") });
  assert.deepEqual(r.violations, []);
});

test('param default carrying the retired offer fails (breaks on: ignoring identifier offers)', () => {
  const body = `param windowsImageOffer string = 'WindowsServer'\n` + vm('windowsImageOffer');
  const r = scanFiles({ 'vm.bicep': body });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'retired');
  assert.match(r.violations[0].message, /default of windowsImageOffer \(line 1\)/);
});

test('param with a good default passes', () => {
  const body = `param windowsImageOffer string = 'windowsserver2022'\n` + vm('windowsImageOffer');
  assert.deepEqual(scanFiles({ 'vm.bicep': body }).violations, []);
});

test('param with NO default fails as unresolvable (breaks on: treating unknown as safe)', () => {
  const body = `param windowsImageOffer string\n` + vm('windowsImageOffer');
  const r = scanFiles({ 'vm.bicep': body });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'unresolvable');
  assert.match(r.violations[0].message, /^vm\.bicep:\d+:/);
});

test('ternary offer expression fails as unresolvable', () => {
  const r = scanFiles({ 'vm.bicep': vm("isWin ? 'windowsserver2022' : 'x'") });
  assert.equal(r.violations[0].kind, 'unresolvable');
});

test('retired offer inside a commented-out line is ignored; real offer on the next line still checked', () => {
  const body = vm("'windowsserver2022'").replace('        offer:', "        // offer: 'WindowsServer'\n        offer:");
  const r = scanFiles({ 'vm.bicep': body });
  assert.deepEqual(r.violations, []);
  assert.equal(r.checked, 1);
});

test('bicepparam assignment to a param used as an offer fails', () => {
  const r = scanFiles({
    'vm.bicep': `param windowsImageOffer string\n` + vm('windowsImageOffer'),
    'p.bicepparam': `using './vm.bicep'\nparam windowsImageOffer = 'WindowsServer'\n`,
  });
  assert.ok(r.violations.some((v) => v.kind === 'retired' && /^p\.bicepparam:2:/.test(v.message)), JSON.stringify(r.violations));
});

test('ARM JSON: literal retired offer fails, parameters() default resolved, expression fails', () => {
  const tpl = (offer, params = {}) => JSON.stringify({
    $schema: 'x', contentVersion: '1.0.0.0', parameters: params,
    resources: [{ properties: { storageProfile: { imageReference: { publisher: 'MicrosoftWindowsServer', offer, sku: 's' } } } }],
  }, null, 2);
  assert.equal(scanFiles({ 't.json': tpl('WindowsServer') }).violations[0].kind, 'retired');
  assert.deepEqual(scanFiles({ 't.json': tpl('windowsserver2022') }).violations, []);
  const viaParam = scanFiles({ 't.json': tpl("[parameters('o')]", { o: { type: 'string', defaultValue: 'WindowsServer' } }) });
  assert.equal(viaParam.violations[0].kind, 'retired');
  assert.equal(scanFiles({ 't.json': tpl("[concat('Windows','Server')]") }).violations[0].kind, 'unresolvable');
});

test('the denylist file itself is not scanned, and an empty denylist is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-img-'));
  try {
    const f = path.join(dir, 'd.json');
    fs.writeFileSync(f, '[]');
    assert.throws(() => loadDenylist(f), /empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL REPO: no retired image, and the scan is not blind (breaks on: any retired template, or checked<5)', () => {
  const r = scanRoot(REPO, DENY);
  assert.deepEqual(r.violations.map((v) => v.message), []);
  assert.ok(r.checked >= 5, `only ${r.checked} references examined`);
});

/**
 * check-arm-counted-fetch self-test.
 *
 * assertion-design: every case names the input that makes it fail. The guard's
 * POSITIVE CONTROL is the first block: a fixture file with a direct ARM fetch
 * must make the guard report a violation (a guard that cannot fail is the
 * defect this repo is about).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, loadAllowlist, scanRoot, stripComments } from '../check-arm-counted-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(HERE, '..', 'check-arm-counted-fetch.mjs');

const DIRECT_ARM_FETCH = [
  "import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';",
  "import { armBase } from '@/lib/azure/cloud-endpoints';",
  'export const read = () => fetchWithTimeout(`${armBase()}/subscriptions/s?api-version=1`);',
].join('\n');

const COUNTED_ARM_FETCH = DIRECT_ARM_FETCH
  .replace('fetchWithTimeout', 'armCountedFetch').replace('fetchWithTimeout', 'armCountedFetch')
  .replace('fetch-with-timeout', 'arm-counted-fetch');

function fixtureRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armcf-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

test('POSITIVE CONTROL: a direct ARM fetch is a violation (fails if classify goes blind)', () => {
  assert.equal(classify(DIRECT_ARM_FETCH), 'violation');
  const root = fixtureRoot({ 'apps/fiab-console/lib/azure/x-client.ts': DIRECT_ARM_FETCH });
  const r = scanRoot(root, {});
  assert.deepEqual(r.violations, ['apps/fiab-console/lib/azure/x-client.ts']);
});

test('the same file routed through armCountedFetch is clean (paired with the control above)', () => {
  assert.match(COUNTED_ARM_FETCH, /armCountedFetch\(/);
  assert.equal(classify(COUNTED_ARM_FETCH), 'ok');
  const root = fixtureRoot({ 'apps/fiab-console/lib/azure/x-client.ts': COUNTED_ARM_FETCH });
  assert.deepEqual(scanRoot(root, {}).violations, []);
});

test('bare global fetch and a management-host literal are also caught', () => {
  assert.equal(classify("const u = 'https://management.azure.com/x'; await fetch(u);"), 'violation');
  assert.equal(classify("const u = 'https://management.usgovcloudapi.net/x'; await fetch(u);"), 'violation');
});

test('a fetch with no ARM marker in the file is out of scope (documented blind spot)', () => {
  assert.equal(classify("await fetch('https://example.test/x');"), 'ok');
});

test('a file that calls beginArmRead IS a counted transport, not a violation', () => {
  const src = "import { armBase } from './cloud-endpoints';\nconst t = await beginArmRead();\nawait fetchWithTimeout(armBase());";
  assert.equal(classify(src), 'counted-transport');
});

test('a commented-out raw fetch does not count, but a live one next to it does', () => {
  const commentedOnly = "import { armBase } from './c';\n// await fetch(armBase())\n/* fetchWithTimeout(armBase()) */\nconst a = armBase();";
  assert.equal(classify(commentedOnly), 'ok');
  assert.equal(classify(commentedOnly + '\nawait fetch(a);'), 'violation');
  assert.ok(!/fetch/.test(stripComments(commentedOnly)), 'stripComments left a fetch behind');
});

test('"://" in a URL is not mistaken for a line comment that eats the fetch', () => {
  assert.equal(classify("const u = 'https://management.azure.com/x'; fetch(u);"), 'violation');
});

test('a method named .fetch( (e.g. client.fetch) is not a raw fetch', () => {
  assert.equal(classify("const a = armBase(); await client.fetch(a);"), 'ok');
});

test('allowlist: listed file passes; a STALE entry (file no longer violates) fails the ratchet', () => {
  const root = fixtureRoot({
    'apps/fiab-console/lib/azure/a.ts': DIRECT_ARM_FETCH,
    'apps/fiab-console/lib/azure/b.ts': COUNTED_ARM_FETCH,
  });
  const ok = scanRoot(root, { 'apps/fiab-console/lib/azure/a.ts': 'x'.repeat(30) });
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.stale, []);
  const stale = scanRoot(root, {
    'apps/fiab-console/lib/azure/a.ts': 'x'.repeat(30),
    'apps/fiab-console/lib/azure/b.ts': 'x'.repeat(30),
  });
  assert.deepEqual(stale.stale, ['apps/fiab-console/lib/azure/b.ts']);
});

test('allowlist entries need a real WHY (a 3-char reason is rejected)', () => {
  const f = path.join(fixtureRoot({ 'a.json': JSON.stringify({ allow: { 'x.ts': 'ok' } }) }), 'a.json');
  assert.throws(() => loadAllowlist(f), /needs a WHY/);
});

test('test files and __tests__ directories are not scanned', () => {
  const root = fixtureRoot({
    'apps/fiab-console/lib/azure/__tests__/t.ts': DIRECT_ARM_FETCH,
    'apps/fiab-console/lib/azure/y.test.ts': DIRECT_ARM_FETCH,
  });
  assert.equal(scanRoot(root, {}).scanned, 0);
});

test('CLI refuses a vacuous pass: a root that scans < 100 files exits 1 even with zero violations', () => {
  const root = fixtureRoot({ 'apps/fiab-console/lib/azure/ok.ts': COUNTED_ARM_FETCH });
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing a vacuous pass/);
});

test('REAL TREE: the guard passes on the repository (and scans a real population)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, REPO], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /\((\d+) files scanned, (\d+) allowlisted\)/.exec(r.stdout);
  assert.ok(m && Number(m[1]) > 1000, `population too small to mean anything: ${r.stdout}`);
});

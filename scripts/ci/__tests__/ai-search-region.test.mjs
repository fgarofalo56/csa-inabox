/**
 * AI Search region (Gov run 42106150785).
 *
 * Microsoft.Search `standard` returned ResourcesForSkuUnavailable in usgovvirginia, so GCC-High places the
 * service in usgovarizona through `aiSearchLocation`. Every control names the value that breaks it.
 *
 * NOT PROVEN HERE: that usgovarizona HAS capacity. These are source-text pins; only a live create witnesses it.
 *
 * Run: node --test scripts/ci/__tests__/ai-search-region.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BICEP = path.resolve(import.meta.dirname, '..', '..', '..', 'platform', 'fiab', 'bicep');
const read = (rel) => fs.readFileSync(path.join(BICEP, rel), 'utf8').replace(/\r\n/g, '\n');

test('SEARCH REGION: admin-plane places AI Search in aiSearchLocation and falls back to the hub location', () => {
  // Breaks if: the module goes back to `location: location` (the Gov capacity failure returns) or the fallback is
  // dropped (`location: aiSearchLocation`), which would hand every other boundary an EMPTY region.
  const src = read('modules/admin-plane/main.bicep');
  assert.ok(src.includes("param aiSearchLocation string = ''\n"), "the parameter must default to '' so the fallback is the default");
  const block = src.slice(src.indexOf("module aiSearch 'ai-search.bicep'"));
  const head = block.slice(0, block.indexOf('\n}\n'));
  assert.ok(
    head.includes('\n    location: empty(aiSearchLocation) ? location : aiSearchLocation\n'),
    'the ai-search module must take empty(aiSearchLocation) ? location : aiSearchLocation',
  );
});

test('SEARCH REGION: the root declares aiSearchLocation empty by default and hands it to admin-plane', () => {
  // Breaks if: the pass-through is deleted (admin-plane then always sees '' and Gov stays in Virginia) or the root
  // default stops being empty (every boundary would move).
  const root = read('main.bicep');
  assert.ok(root.includes("param aiSearchLocation string = ''\n"), "root default must be ''");
  assert.ok(root.includes('    aiSearchLocation: aiSearchLocation\n'), 'the root must pass aiSearchLocation to admin-plane');
});

test('SEARCH REGION: only the GCC-High param file sets it, and to usgovarizona', () => {
  // Breaks if: GCC-High loses the line (Gov back in Virginia) or another boundary gains one (an unprobed move).
  // Positive half first: the GCC-High line must exist, so an empty scan cannot pass vacuously.
  const dir = path.join(BICEP, 'params');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bicepparam'));
  assert.ok(files.length >= 8, `expected at least 8 param files, found ${files.length}`);
  const setters = {};
  for (const f of files) {
    const m = /^param aiSearchLocation = '([^']*)'/m.exec(read(`params/${f}`));
    if (m) setters[f] = m[1];
  }
  assert.deepEqual(setters, { 'gcc-high.bicepparam': 'usgovarizona' });
});

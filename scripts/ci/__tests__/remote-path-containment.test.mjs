/**
 * Self-test for scripts/ci/check-remote-path-containment.mjs.
 *
 * WHY THIS EXISTS. The guard's own value depends entirely on it being ABLE to
 * fail. This repo has shipped several controls that ran, reported success and
 * measured nothing — a required vitest lane that passed in 13s, a Copilot eval
 * gate green for months on four silent `az` errors. "It was green on main" is
 * not evidence. These cases encode the mutations that were applied to the real
 * tree while writing the guard, so the guard stays capable of failing.
 *
 * Run: node --test scripts/ci/__tests__/remote-path-containment.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findRemotePathWrites,
  checkHelperIntegrity,
  findRivalHelpers,
} from '../check-remote-path-containment.mjs';

// ── M1 / M4: a network value reaching a path without containment ────────────

test('M1 — the original run-local defect is detected', () => {
  const src = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
async function runLocal(client, dir) {
  const ctx = await client.request('GET', '/context');
  for (const f of ctx.files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, 'utf-8');
  }
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 2, 'both the mkdir and the write are network-derived');
  assert.ok(hits.every((h) => !h.contained), 'neither is contained');
  assert.deepEqual(hits.map((h) => h.sink).sort(), ['mkdirSync', 'writeFileSync']);
});

test('M4 — a NEW download command with a raw join is detected', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function pullTemplates(client, dir) {
  const resp = await client.request('GET', '/api/templates');
  for (const f of resp.files) writeFileSync(join(dir, f.path), f.body);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, false);
});

test('taint crosses a LOCAL function boundary (fetch here, write there)', () => {
  // The shipped fix fetches in one function and writes in another. A purely
  // intra-procedural pass would call BOTH clean and enforce nothing.
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
function writeAll(dir, files) {
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
}
async function run(client, dir) {
  const ctx = await client.request('GET', '/context');
  writeAll(dir, ctx.files);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'the write inside writeAll is reached through the call site');
  assert.equal(hits[0].contained, false);
});

// ── M6a / M7: the negative controls ─────────────────────────────────────────

test('M6a CONTROL — the same command, contained, passes', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { containedJoin } from '../safe-path.js';
export async function pullTemplates(client, dir) {
  const resp = await client.request('GET', '/api/templates');
  for (const f of resp.files) writeFileSync(containedJoin(dir, f.path), f.body);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'still recognised as network-derived');
  assert.equal(hits[0].contained, true, 'and recognised as contained');
});

test('M7 CONTROL — network CONTENT with an operator-supplied PATH is not flagged', () => {
  // This is `loom apps export`, and the shape of CodeQL alert 636: the bundle
  // comes off the wire, but the path is the operator's own --out flag. A guard
  // that flagged this would force pointless sanitisation onto every
  // download-to-disk command and would rightly get deleted.
  const src = `
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export async function exportBundle(client, args) {
  const out = flagStr(args.flags, 'out') || 'app.loomapp';
  const bundle = await client.request('GET', '/export');
  writeFileSync(resolve(out), JSON.stringify(bundle), 'utf-8');
}`;
  assert.deepEqual(findRemotePathWrites(src), []);
});

test('CONTROL — a purely local path (constants, readdir) is not flagged', () => {
  const src = `
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const OUT = join(process.cwd(), 'docs');
for (const name of readdirSync(OUT)) writeFileSync(join(OUT, name), 'x');`;
  assert.deepEqual(findRemotePathWrites(src), []);
});

test('M6b CONTROL — a comment naming containedJoin cannot satisfy the check', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function sneaky(client, dir) {
  const resp = await client.request('GET', '/x');
  /* contained by containedJoin, honest */
  for (const f of resp.files) writeFileSync(join(dir, f.path), f.body); // containedJoin
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, false, 'comments are masked before the scan');
});

test('CONTROL — a string literal naming containedJoin cannot satisfy the check', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function sneaky(client, dir) {
  const resp = await client.request('GET', '/x');
  const note = 'we use containedJoin here';
  for (const f of resp.files) writeFileSync(join(dir, f.path), note);
}`;
  assert.equal(findRemotePathWrites(src)[0].contained, false);
});

// ── M2 / M3: the anti-inert layer assertions ────────────────────────────────

const INTACT_HELPER = `
import { resolve, sep } from 'node:path';
export function containedJoin(baseDir, untrustedRelPath) {
  const base = resolve(baseDir);
  const rel = String(untrustedRelPath).trim();
  if (rel.startsWith('/')) refuse('absolute');
  if (rel.split('/').some((s) => s === '..')) refuse('dotdot');
  const abs = resolve(base, rel);
  if (!abs.startsWith(base + sep)) refuse('escape');
  return abs;
}`;

test('the intact helper passes all three layer assertions', () => {
  assert.deepEqual(checkHelperIntegrity(INTACT_HELPER), []);
});

test('M2 — a helper that lost its ".." rejection is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(rel\.split.*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects "\.\." segments/);
});

test('M3 — a helper that lost its post-resolve containment is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(!abs\.startsWith.*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /post-resolve/);
});

test('a helper that lost its absolute-path rejection is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(rel\.startsWith\('\/'\).*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects absolute paths/);
});

test('a helper that keeps its NAME but has an empty body fails every layer', () => {
  // The #2729 shape: the fix is present, exported, imported and inert.
  const problems = checkHelperIntegrity(
    'export function containedJoin(baseDir, rel) {\n  return resolve(baseDir, rel);\n}',
  );
  assert.equal(problems.length, 3, 'all three layers reported, not just the first');
});

// ── M5: no rival implementation ─────────────────────────────────────────────

test('M5 — a rival containment helper is reported', () => {
  assert.deepEqual(
    findRivalHelpers('export function safeJoin(base, rel) { return resolve(base, rel); }'),
    ['safeJoin'],
  );
});

test('CONTROL — a comment mentioning safeJoin is not a rival definition', () => {
  assert.deepEqual(findRivalHelpers('// consider a safeJoin(base, rel) helper one day\n'), []);
});

#!/usr/bin/env node
/**
 * external-origin-urls — MUTATION PROOFS. (refs #3443, #3442)
 *
 * Run: node --test scripts/ci/__tests__/external-origin-urls.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findViolations, stripComments, BAD_ORIGIN, EXEMPT } from '../check-external-origin-urls.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'ci', 'check-external-origin-urls.mjs');
const ROUTE = path.join(REPO_ROOT, 'apps', 'fiab-console', 'app', 'api', 'flightsql', 'connect', 'route.ts');

const run = () => {
  try {
    execFileSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};

test('importing the guard did not run its scan', () => {
  assert.equal(typeof findViolations, 'function');
});

test('both bad forms are caught, the good form is not', () => {
  assert.equal(findViolations("const u = new URL('/x', req.url);").length, 1);
  assert.equal(findViolations("const u = new URL('/x', req.nextUrl.origin);").length, 1);
  assert.equal(findViolations("const u = new URL('/x', request.nextUrl.origin);").length, 1);
  assert.equal(findViolations("const u = new URL('/x', externalOrigin(req.headers));").length, 0);
});

test('prose ABOUT the pattern is not a violation — 6 of the 7 sweep hits were comments', () => {
  assert.equal(findViolations("// never build new URL('/x', req.url) here").length, 0);
  assert.equal(findViolations('/**\n * see new URL(path, req.url)\n */\nconst a = 1;').length, 0);
  // …but a comment must not hide code on a LATER line.
  const mixed = "// explains new URL(p, req.url)\nconst u = new URL('/y', req.url);";
  assert.equal(findViolations(mixed).length, 1);
  assert.equal(findViolations(mixed)[0].line, 2);
});

test('stripComments blanks block comments without shifting line numbers', () => {
  const src = '/* a\n b */\nconst x = 1;';
  assert.equal(stripComments(src).split('\n').length, src.split('\n').length);
});

test('the real tree is clean', () => {
  assert.equal(run(), 0);
});

test('the guard is NOT vacuous — re-breaking the real route flips the verdict', () => {
  const original = readFileSync(ROUTE, 'utf8');
  assert.ok(
    original.includes('externalOrigin(req.headers)'),
    'the route should already be fixed — this control proves nothing otherwise',
  );
  const broken = original.replace('externalOrigin(req.headers)', 'req.nextUrl.origin');
  assert.notEqual(broken, original, 'mutation did not apply — this control proves nothing');
  writeFileSync(ROUTE, broken);
  try {
    assert.equal(run(), 1, 'the guard did NOT catch the re-broken route — it is blind');
  } finally {
    writeFileSync(ROUTE, original);
  }
  assert.equal(run(), 0, 'restore failed — the tree is left dirty');
});

test('a STALE exemption fails the guard rather than silently covering', () => {
  // The exemption list is a liability if it outlives its subject: the next real
  // violation in that file would inherit the cover.
  assert.ok(EXEMPT.size >= 1);
  for (const [f, reason] of EXEMPT) {
    assert.ok(reason && reason.length > 30, `${f}: exemption reason is too thin to review`);
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.ok(
      BAD_ORIGIN.test(stripComments(src)),
      `${f} is EXEMPT but no longer contains the construction — the entry is stale`,
    );
  }
});

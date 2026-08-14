/**
 * check-curl-httpcode-fallback self-test (#3414).
 *
 * The guard exists because a probe whose FAILURE is indistinguishable from an
 * ANSWER is worse than no probe. A GUARD that cannot detect is the same defect
 * one level up — and this file spent its whole life in exactly that state: it
 * DOCUMENTED a `-f`/`--fail` arm and never implemented one, while its `|| echo`
 * arm matched physical lines and therefore missed every one of the ELEVEN live
 * violations that put the `|| echo` on a backslash continuation.
 *
 * So these tests pin BOTH directions for BOTH arms, and pin the continuation
 * joining explicitly. MUTATION-PROVEN (outputs in the PR body): deleting ARM 2
 * reddens 5 assertions, widening ARM 2 to a bare `/--fail/` substring reddens 5,
 * and removing the continuation joining reddens 2 — so neither a blind guard nor
 * an over-broad one can pass this file.
 *
 * Run: node --test scripts/ci/__tests__/curl-httpcode-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanText,
  logicalLines,
  runControls,
  MUST_FLAG,
  MUST_NOT_FLAG,
} from '../check-curl-httpcode-fallback.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '..', 'check-curl-httpcode-fallback.mjs');

const arms = (src) => scanText(src).violations.map((v) => v.arm);

// ── ARM 2 (`-f`/`--fail`) — the arm #3414 reported as documented-but-absent ──

test('ARM 2 flags a lone -f on a probe that reads %{http_code}', () => {
  assert.deepEqual(arms(`CODE=$(curl -f -sS -w '%{http_code}' "$URL")`), ['fail-flag']);
});

test('ARM 2 flags the long --fail', () => {
  assert.deepEqual(arms(`curl --fail -o /dev/null -w '%{http_code}' "$URL"`), ['fail-flag']);
});

test('ARM 2 flags BUNDLED short flags — -fsS, -sSf, -sfL all contain --fail', () => {
  // curl's only lower-case `f` short flag is `-f`; `-F` is `--form`. So a
  // lower-case f inside a curl bundle IS --fail, and catching it is intended.
  assert.deepEqual(arms(`R=$(curl -fsS -o /dev/null -w "%{http_code}" "$URL")`), ['fail-flag']);
  assert.deepEqual(arms(`curl -sSf -o /dev/null -w "%{http_code}" "$URL"`), ['fail-flag']);
  assert.deepEqual(arms(`curl -sfL -o /dev/null -w "%{http_code}" "$URL"`), ['fail-flag']);
});

test('ARM 2 does NOT flag --fail-with-body or --fail-early — different flags', () => {
  assert.deepEqual(arms(`curl --fail-with-body -w '%{http_code}' "$URL"`), []);
  assert.deepEqual(arms(`curl --fail-early -w '%{http_code}' "$URL"`), []);
});

test('ARM 2 does NOT flag -F (--form, upper-case) or an unrelated -f test', () => {
  assert.deepEqual(arms(`curl -sS -F file=@a.json -w '%{http_code}' "$URL"`), []);
  assert.deepEqual(arms(`[ -f "$TOKEN" ] && curl -sS -w '%{http_code}' "$URL"`), []);
});

// ── ARM 1 (`|| echo`) and the continuation joining that used to hide it ──────

test('ARM 1 flags `|| echo` on the same line', () => {
  assert.deepEqual(arms(`CODE=$(curl -sS -w '%{http_code}' "$URL" || echo 000)`), ['fallback']);
});

test('ARM 1 flags `|| echo` on a CONTINUATION line — the shape that hid 11 sites', () => {
  const src = `CODE=$(curl -sS -w '%{http_code}' \\\n  --max-time 5 \\\n  "$URL" || echo 000)`;
  assert.deepEqual(arms(src), ['fallback']);
});

test('ARM 2 sees a --fail that only appears on a continuation line', () => {
  const src = `CODE=$(curl -sS -w '%{http_code}' \\\n  --fail \\\n  "$URL")`;
  assert.deepEqual(arms(src), ['fail-flag']);
});

test('both arms fire on a probe carrying both defects', () => {
  const src = `R=$(curl -fsS -o /dev/null -w "%{http_code}" \\\n  "$URL" || echo "000")`;
  assert.deepEqual(arms(src).sort(), ['fail-flag', 'fallback']);
});

test('the prescribed safe shape is not flagged', () => {
  assert.deepEqual(arms(`CODE="$(curl -sS -w '%{http_code}' "$URL" 2>/dev/null)" || true`), []);
  assert.deepEqual(arms(`CODE=$(curl -sS -w '%{http_code}' "$URL") || true`), []);
});

test('prose describing the rule is not the rule', () => {
  assert.deepEqual(arms(`#   curl -fsS -w "%{http_code}" … || echo "000"`), []);
});

test('logicalLines reports the FIRST physical line of a joined invocation', () => {
  const joined = logicalLines(`a\nb \\\n  c \\\n  d\ne`);
  assert.deepEqual(
    joined.map((l) => l.line),
    [1, 2, 5],
  );
  assert.match(joined[1].text, /b\s+c\s+d/);
});

// ── the embedded control, and the guard's own self-defence ──────────────────

test('the embedded control passes on the shipped matchers', () => {
  assert.deepEqual(runControls(), []);
  assert.ok(MUST_FLAG.length >= 6 && MUST_NOT_FLAG.length >= 6, 'control population must not be whittled away');
});

test('--self-test exits 0 and says the controls behaved', () => {
  const r = spawnSync(process.execPath, [GUARD, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-test OK/);
});

test('an empty %{http_code} population is a FAILURE, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curlfb-'));
  try {
    writeFileSync(join(dir, 'nothing.sh'), '#!/usr/bin/env bash\necho hi\n');
    assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: dir }).status, 0);
    assert.equal(spawnSync('git', ['add', '-A', '-f'], { cwd: dir }).status, 0);
    const r = spawnSync(process.execPath, [GUARD], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /found ZERO `%\{http_code\}` probes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

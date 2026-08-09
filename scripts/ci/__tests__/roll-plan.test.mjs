#!/usr/bin/env node
/**
 * Tests for scripts/ci/roll-plan.mjs.
 *
 * Every branch is driven in BOTH directions. A suite that only walked the happy
 * path would be the same shape of control this program keeps finding: green
 * while measuring nothing.
 *
 * The load-bearing assertions are the ones about ATOMICITY and about the
 * three-way live verdict, because those are the two places where a plausible
 * "simplification" silently reintroduces a real defect:
 *   - flattening the atomic group makes a half-roll possible, which turns the
 *     reconcile's `unity` key UNKNOWN and freezes estate-wide config;
 *   - collapsing `unreadable` into `mismatch` (or into `ok`) is how an
 *     unverified roll starts reporting success.
 *
 * Run: node --test scripts/ci/__tests__/roll-plan.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ROLL_TARGETS,
  MUTABLE_TAGS,
  groupsByRepo,
  atomicClosure,
  imageRef,
  planRoll,
  verifyLive,
} from '../roll-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'roll-plan.mjs');

/**
 * Run the CLI and return BOTH streams plus the exit code, so a non-zero exit is
 * an assertable value rather than a throw. spawnSync (not execFileSync) because
 * the notices this asserts on are emitted to stderr on SUCCESSFUL runs, and
 * execFileSync only surfaces stderr when it throws.
 */
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/* ── the registry itself ─────────────────────────────────────────────────── */

test('registry carries exactly the three apps that had no roll path', () => {
  assert.deepEqual(
    ROLL_TARGETS.map((t) => t.app).sort(),
    ['iceberg-catalog', 'loom-trino', 'loom-unity'],
  );
});

test('every target declares repo, tagKey, envVar, bicep and a reason', () => {
  for (const t of ROLL_TARGETS) {
    for (const k of ['app', 'repo', 'tagKey', 'envVar', 'bicep', 'why']) {
      assert.ok(String(t[k] ?? '').trim().length > 0, `${t.app} is missing ${k}`);
    }
    assert.match(t.envVar, /^LOOM_[A-Z0-9_]+_TAG$/, `${t.app} envVar shape`);
    assert.match(t.bicep, /^platform\/fiab\/bicep\/modules\/.+\.bicep$/, `${t.app} bicep path`);
  }
});

test('iceberg-catalog runs the loom-unity repo — app name is NOT the repo name', () => {
  // This is the fact that makes an implicit `$ACR/$app:$TAG` roll wrong, and it
  // is why the mapping is explicit. If someone "tidies" this to repo=app, the
  // roll asks ACR for a repository no producer has ever pushed.
  const iceberg = ROLL_TARGETS.find((t) => t.app === 'iceberg-catalog');
  assert.equal(iceberg.repo, 'loom-unity');
  assert.notEqual(iceberg.repo, iceberg.app);
});

test('apps sharing a repo share the SAME appImageTags key and env var', () => {
  // reconcile-policy.mjs has exactly one key per repo. Two apps on one repo with
  // different keys would be unrepresentable there, so the registry must agree.
  for (const [repo, members] of groupsByRepo()) {
    const keys = new Set(members.map((m) => m.tagKey));
    const vars = new Set(members.map((m) => m.envVar));
    assert.equal(keys.size, 1, `repo ${repo} maps to ${[...keys].join(', ')}`);
    assert.equal(vars.size, 1, `repo ${repo} maps to ${[...vars].join(', ')}`);
  }
});

/* ── groupsByRepo ────────────────────────────────────────────────────────── */

test('groupsByRepo derives the unity pair as one group', () => {
  const g = groupsByRepo();
  assert.deepEqual(g.get('loom-unity').map((t) => t.app), ['loom-unity', 'iceberg-catalog']);
  assert.deepEqual(g.get('loom-trino').map((t) => t.app), ['loom-trino']);
  assert.equal(g.size, 2);
});

test('groupsByRepo is derived, so a new app on an existing repo joins automatically', () => {
  // The whole point of deriving rather than declaring: you cannot add a target
  // and forget to extend a second hand-written list.
  const withFourth = [...ROLL_TARGETS, { app: 'unity-sidecar', repo: 'loom-unity', tagKey: 'unity', envVar: 'LOOM_UNITY_TAG', bicep: 'x.bicep', why: 'fixture' }];
  const g = groupsByRepo(withFourth);
  assert.deepEqual(g.get('loom-unity').map((t) => t.app), ['loom-unity', 'iceberg-catalog', 'unity-sidecar']);
});

test('groupsByRepo of an empty registry is empty, not a throw', () => {
  assert.equal(groupsByRepo([]).size, 0);
});

/* ── atomicClosure ───────────────────────────────────────────────────────── */

test('asking for loom-unity alone PULLS IN iceberg-catalog and says so', () => {
  const r = atomicClosure(['loom-unity']);
  assert.deepEqual(r.apps, ['loom-unity', 'iceberg-catalog']);
  assert.deepEqual(r.added, ['iceberg-catalog']);
  assert.deepEqual(r.unknown, []);
});

test('asking for iceberg-catalog alone pulls in loom-unity — closure works both directions', () => {
  const r = atomicClosure(['iceberg-catalog']);
  assert.deepEqual(r.apps, ['loom-unity', 'iceberg-catalog']);
  assert.deepEqual(r.added, ['loom-unity']);
});

test('asking for loom-trino pulls in NOTHING — it is a group of one', () => {
  const r = atomicClosure(['loom-trino']);
  assert.deepEqual(r.apps, ['loom-trino']);
  assert.deepEqual(r.added, []);
});

test('asking for both pair members reports no surprise additions', () => {
  const r = atomicClosure(['loom-unity', 'iceberg-catalog']);
  assert.deepEqual(r.apps, ['loom-unity', 'iceberg-catalog']);
  assert.deepEqual(r.added, []);
});

test("'all', an empty string, and an empty array each select every target", () => {
  for (const input of ['all', '', [], 'ALL']) {
    assert.deepEqual(
      atomicClosure(input).apps,
      ROLL_TARGETS.map((t) => t.app),
      `input ${JSON.stringify(input)}`,
    );
  }
});

test('a comma string is parsed and whitespace tolerated', () => {
  assert.deepEqual(atomicClosure(' loom-trino , loom-unity ').apps, ['loom-unity', 'iceberg-catalog', 'loom-trino']);
});

test('an unknown app is REPORTED, never silently dropped', () => {
  const r = atomicClosure(['loom-trino', 'loom-nope']);
  assert.deepEqual(r.unknown, ['loom-nope']);
  assert.deepEqual(r.apps, ['loom-trino']); // the known one still resolves
});

test('output order follows the registry regardless of request order', () => {
  assert.deepEqual(
    atomicClosure(['loom-trino', 'iceberg-catalog']).apps,
    ['loom-unity', 'iceberg-catalog', 'loom-trino'],
  );
});

/* ── imageRef ────────────────────────────────────────────────────────────── */

test('imageRef builds registry/repo:tag', () => {
  assert.equal(imageRef({ acr: 'x.azurecr.io', repo: 'loom-unity', tag: 'abc123' }), 'x.azurecr.io/loom-unity:abc123');
});

test('imageRef trims, so a trailing newline from `az … -o tsv` cannot corrupt the reference', () => {
  assert.equal(imageRef({ acr: ' x.azurecr.io ', repo: 'loom-trino', tag: ' v2\t' }), 'x.azurecr.io/loom-trino:v2');
});

test('imageRef THROWS on any empty component instead of emitting a malformed reference', () => {
  for (const bad of [
    { acr: '', repo: 'r', tag: 't' },
    { acr: 'a', repo: '', tag: 't' },
    { acr: 'a', repo: 'r', tag: '' },
    { acr: 'a', repo: 'r', tag: '   ' },
    { acr: 'a', repo: 'r' },
  ]) {
    assert.throws(() => imageRef(bad), /empty/, JSON.stringify(bad));
  }
});

/* ── planRoll ────────────────────────────────────────────────────────────── */

test('planRoll emits one group per repo with the repo-correct image', () => {
  const p = planRoll({ apps: 'all', acr: 'acr.azurecr.io', tag: 'sha1' });
  assert.deepEqual(p.groups.map((g) => g.repo), ['loom-unity', 'loom-trino']);
  const unity = p.groups.find((g) => g.repo === 'loom-unity');
  assert.equal(unity.image, 'acr.azurecr.io/loom-unity:sha1');
  assert.deepEqual(unity.apps, ['loom-unity', 'iceberg-catalog']);
  assert.equal(unity.envVar, 'LOOM_UNITY_TAG');
});

test('planRoll rows give iceberg-catalog the loom-unity image, not an iceberg-catalog one', () => {
  const p = planRoll({ apps: 'all', acr: 'acr.azurecr.io', tag: 'sha1' });
  const row = p.rows.find((r) => r.app === 'iceberg-catalog');
  assert.equal(row.image, 'acr.azurecr.io/loom-unity:sha1');
  assert.ok(!row.image.includes('/iceberg-catalog:'));
});

test('planRoll THROWS on an unknown app rather than rolling a subset', () => {
  assert.throws(
    () => planRoll({ apps: 'loom-nope', acr: 'a', tag: 't' }),
    /unknown app/,
  );
});

test('planRoll THROWS when the selection resolves to zero apps', () => {
  assert.throws(
    () => planRoll({ apps: 'all', acr: 'a', tag: 't', targets: [] }),
    /ZERO apps/,
  );
});

test('planRoll flags a mutable tag and clears the flag for an immutable one', () => {
  for (const t of MUTABLE_TAGS) {
    assert.equal(planRoll({ apps: 'all', acr: 'a', tag: t }).mutableTag, true, t);
  }
  assert.equal(planRoll({ apps: 'all', acr: 'a', tag: '36b765e4' }).mutableTag, false);
});

test('planRoll surfaces the atomic addition so the caller can announce it', () => {
  const p = planRoll({ apps: 'loom-unity', acr: 'a', tag: 't' });
  assert.deepEqual(p.added, ['iceberg-catalog']);
  assert.deepEqual(p.rows.map((r) => r.app), ['loom-unity', 'iceberg-catalog']);
});

/* ── verifyLive: the three-way verdict ───────────────────────────────────── */

test('verifyLive passes only when every live image equals the requested one', () => {
  const r = verifyLive({
    expected: { 'loom-unity': 'a/loom-unity:s1', 'iceberg-catalog': 'a/loom-unity:s1' },
    observed: { 'loom-unity': 'a/loom-unity:s1', 'iceberg-catalog': 'a/loom-unity:s1' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.verdict), ['ok', 'ok']);
});

test('verifyLive calls a DIFFERENT image a mismatch (R7: never report success on the wrong SHA)', () => {
  const r = verifyLive({
    expected: { 'loom-unity': 'a/loom-unity:s2' },
    observed: { 'loom-unity': 'a/loom-unity:s1' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.rows[0].verdict, 'mismatch');
  assert.equal(r.rows[0].got, 'a/loom-unity:s1');
});

test('verifyLive calls an UNREADABLE image unreadable — not a mismatch, and not a pass', () => {
  // The distinction is the whole point: "I could not read it" must never be
  // rendered as "it is running something else", and must never pass.
  for (const missing of [undefined, null, '', '   ']) {
    const r = verifyLive({ expected: { 'loom-trino': 'a/loom-trino:s1' }, observed: { 'loom-trino': missing } });
    assert.equal(r.ok, false, String(missing));
    assert.equal(r.rows[0].verdict, 'unreadable', String(missing));
    assert.equal(r.rows[0].got, null, String(missing));
  }
});

test('verifyLive treats a wholly absent observation map as unreadable, not ok', () => {
  const r = verifyLive({ expected: { 'loom-trino': 'a/loom-trino:s1' }, observed: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.rows[0].verdict, 'unreadable');
});

test('verifyLive with NOTHING expected FAILS — an empty check is not a pass', () => {
  // This is the "gate that measures nothing" shape. If the roll loop produced no
  // expectations, the verification step must not report success.
  const r = verifyLive({ expected: {}, observed: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows, []);
});

test('verifyLive trims both sides so tsv whitespace is not a false mismatch', () => {
  const r = verifyLive({
    expected: { 'loom-unity': 'a/loom-unity:s1' },
    observed: { 'loom-unity': ' a/loom-unity:s1\r' },
  });
  assert.equal(r.ok, true);
});

test('one bad app fails the whole verdict even when its sibling is fine', () => {
  const r = verifyLive({
    expected: { 'loom-unity': 'a/loom-unity:s2', 'iceberg-catalog': 'a/loom-unity:s2' },
    observed: { 'loom-unity': 'a/loom-unity:s2', 'iceberg-catalog': 'a/loom-unity:s1' },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows.map((x) => x.verdict), ['ok', 'mismatch']);
});

/* ── CLI ─────────────────────────────────────────────────────────────────── */

test('CLI --list exits 0 and names the atomic group', () => {
  const r = cli(['--list']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ATOMIC GROUP/);
  assert.match(r.stdout, /iceberg-catalog/);
  assert.match(r.stdout, /LOOM_UNITY_TAG/);
});

test('CLI tsv output is one row per app with the repo-correct image', () => {
  const r = cli(['--apps', 'all', '--acr', 'a.azurecr.io', '--tag', 'sha9']);
  assert.equal(r.code, 0);
  const rows = r.stdout.trim().split('\n').map((l) => l.split('\t'));
  assert.equal(rows.length, 3);
  const iceberg = rows.find((x) => x[0] === 'iceberg-catalog');
  assert.equal(iceberg[1], 'loom-unity');
  assert.equal(iceberg[2], 'a.azurecr.io/loom-unity:sha9');
  assert.equal(iceberg[3], 'LOOM_UNITY_TAG');
});

test('CLI announces the pulled-in pair mate on stderr, keeping stdout parseable', () => {
  const r = cli(['--apps', 'loom-unity', '--acr', 'a.azurecr.io', '--tag', 'sha9']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /iceberg-catalog/);
  assert.match(r.stderr, /::notice::/);
  for (const line of r.stdout.trim().split('\n')) assert.equal(line.split('\t').length, 4);
});

test('CLI warns on a mutable tag', () => {
  const r = cli(['--apps', 'loom-trino', '--acr', 'a.azurecr.io', '--tag', 'v0.1']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /::warning::.*MUTABLE/);
});

test('CLI exits 2 without --acr/--tag and 1 on an unknown app', () => {
  assert.equal(cli(['--apps', 'all']).code, 2);
  assert.equal(cli(['--acr', 'a', '--tag', 't', '--apps', 'nope']).code, 1);
});

test('CLI --verify exits 0 on a match and 1 on a mismatch, naming R7', () => {
  const expected = JSON.stringify({ 'loom-trino': 'a/loom-trino:s1' });
  assert.equal(cli(['--verify', '--expected', expected, '--observed', expected]).code, 0);

  const bad = cli(['--verify', '--expected', expected, '--observed', JSON.stringify({ 'loom-trino': 'a/loom-trino:s0' })]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /::error::/);
  assert.match(bad.stderr, /different image/);
});

test('CLI --verify exits 1 on an unreadable image WITHOUT claiming a different image', () => {
  const r = cli([
    '--verify',
    '--expected', JSON.stringify({ 'loom-trino': 'a/loom-trino:s1' }),
    '--observed', JSON.stringify({ 'loom-trino': '' }),
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NOT established/);
  assert.ok(!/different image/.test(r.stderr), 'must not assert a cause it did not establish (R7)');
});

test('CLI --verify exits 1 when nothing was verified', () => {
  const r = cli(['--verify', '--expected', '{}', '--observed', '{}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a pass/);
});

test('CLI --verify exits 2 on malformed JSON rather than treating it as empty', () => {
  const r = cli(['--verify', '--expected', '{oops', '--observed', '{}']);
  assert.equal(r.code, 2);
});

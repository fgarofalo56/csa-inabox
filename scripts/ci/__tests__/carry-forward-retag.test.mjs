/**
 * Tests for scripts/ci/carry-forward-retag.sh (run 39820244128: `docker buildx
 * imagetools create` gave every carried app a NEW digest, so all 12 failed the
 * digest-equality post-condition).
 *
 * The script is EXECUTED against a fake `az` and a fake digest resolver (both
 * test seams the script exposes). The fake registry is a directory of
 * `<repo>:<tag>` files holding digests; the fake `az acr import` writes the
 * target tag. The command line under test is lifted from the shipped script at
 * runtime, never transcribed, and each assertion names the input that breaks it
 * (.claude/rules/assertion-design.md).
 *
 * Run: node --test scripts/ci/__tests__/carry-forward-retag.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = process.env.CARRY_TEST_SCRIPT ?? join(ROOT, 'scripts', 'ci', 'carry-forward-retag.sh');
const WF = process.env.CARRY_TEST_WF ?? join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const script = readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const wf = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

const SHA = 'f'.repeat(40);
const D_OLD = `sha256:${'1'.repeat(64)}`;
const D_OTHER = `sha256:${'2'.repeat(64)}`;

// Fake az: only `acr import` is called directly (the resolver is faked too).
// MODE=same  -> import writes the SOURCE digest to the target tag (az acr import)
// MODE=drift -> import writes a DIFFERENT digest (what imagetools create did)
// MODE=fail  -> import exits 1 with a message on stderr
const FAKE_AZ = `#!/usr/bin/env bash
set -u
[ "$1" = acr ] && [ "$2" = import ] || { echo "fake az: unexpected call: $*" >&2; exit 9; }
shift 2
SRC=""; IMG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC="$2"; shift 2 ;;
    --image) IMG="$2"; shift 2 ;;
    --name|--force) [ "$1" = --name ] && shift 2 || shift ;;
    *) shift ;;
  esac
done
echo "$SRC $IMG" >> "$REG/import.log"
APP="\${IMG%%:*}"
if [ "\${MODE:-same}" = fail ] && [ "\${FAIL_APP:-$APP}" = "$APP" ]; then echo "az: boom importing $SRC" >&2; exit 1; fi
DIGEST="\${SRC##*@}"
if [ "\${MODE:-same}" = drift ]; then DIGEST="${D_OTHER}"; fi
echo "$DIGEST" > "$REG/\${IMG//:/__}"
`;

// Fake resolver: prints the digest stored for <repo:tag>, exit 3 when absent.
const FAKE_RESOLVER = `#!/usr/bin/env bash
IMAGE=""
while [ $# -gt 0 ]; do case "$1" in --image) IMAGE="$2"; shift 2 ;; *) shift ;; esac; done
F="$REG/\${IMAGE//:/__}"; [ -f "$F" ] || { echo "absent $IMAGE" >&2; exit 3; }
cat "$F"
`;

function run({ apps, mode = 'same', failApp, seed }) {
  const dir = mkdtempSync(join(tmpdir(), 'carry-'));
  try {
    const reg = join(dir, 'reg'); mkdirSync(reg);
    for (const a of seed ?? apps) writeFileSync(join(reg, `${a}__v0.1`), `${D_OLD}\n`);
    const az = join(dir, 'az.sh'); writeFileSync(az, FAKE_AZ); chmodSync(az, 0o755);
    const rs = join(dir, 'resolve.sh'); writeFileSync(rs, FAKE_RESOLVER); chmodSync(rs, 0o755);
    const r = spawnSync('bash', [SCRIPT, '--acr', 'acrx', '--login', 'acrx.azurecr.io', '--apps', apps.join(' '), '--src-tag', 'v0.1', '--sha', SHA], {
      encoding: 'utf8',
      env: { ...process.env, AZ: az, RESOLVER: rs, REG: reg, MODE: mode, ...(failApp ? { FAIL_APP: failApp } : {}) },
    });
    const log = existsSync(join(reg, 'import.log')) ? readFileSync(join(reg, 'import.log'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('digest preserved: every app passes and the import source is the DIGEST, not the floating tag', () => {
  const r = run({ apps: ['loom-mcp', 'loom-unity'] });
  assert.equal(r.status, 0, `an import that keeps the digest must pass: ${r.out}`);
  assert.match(r.log, new RegExp(`acrx\\.azurecr\\.io/loom-mcp@${D_OLD} loom-mcp:${SHA}`), 'source must be repo@digest, so a concurrent push of :v0.1 cannot change what is carried');
  assert.match(r.out, /loom-unity: carried forward/, 'each verified app is reported');
});

test('digest DRIFT (the imagetools-create shape) fails closed and NAMES the app', () => {
  const r = run({ apps: ['loom-mcp'], mode: 'drift' });
  assert.notEqual(r.status, 0, 'new tag digest sha256:2.. != source sha256:1.. must exit non-zero');
  assert.match(r.out, /loom-mcp: after the re-tag, loom-mcp:f+ reads 'sha256:2+'/, 'the message must name the app and the digest it read back');
  assert.match(r.out, /NOT verified/);
  assert.match(r.out, /apps=loom-mcp/, 'the remediation dispatch must list the failed app');
});

test('one failing app does not hide the others: failed apps listed, passing apps still carried', () => {
  const r = run({ apps: ['loom-mcp', 'loom-unity', 'loom-trino'], mode: 'fail', failApp: 'loom-unity' });
  assert.notEqual(r.status, 0, 'a failed import for loom-unity must fail the step');
  assert.match(r.out, /loom-unity: az acr import .* failed/, 'import failure names the app; az stderr is not discarded');
  assert.match(r.out, /az: boom importing/, 'az stderr must reach the log');
  assert.match(r.out, /loom-mcp: carried forward/, 'apps before the failure are still carried and reported');
  assert.match(r.out, /loom-trino: carried forward/, 'apps AFTER the failure are still processed (no early exit)');
  assert.match(r.out, /FAILED for: loom-unity\./, 'summary lists only the failed app');
});

test('missing source tag fails closed with the resolver exit, and nothing is imported for it', () => {
  const r = run({ apps: ['loom-mcp', 'loom-ghost'], seed: ['loom-mcp'] });
  assert.notEqual(r.status, 0, 'loom-ghost:v0.1 absent (resolver exit 3) must fail');
  assert.match(r.out, /loom-ghost: could not read loom-ghost:v0\.1 \(resolver exit 3/, 'must name the app and the resolver exit code');
  assert.doesNotMatch(r.log, /loom-ghost/, 'no import may be attempted for an app whose source digest was not read');
});

test('missing arguments are a usage error (exit 2), not a silent pass', () => {
  const r = spawnSync('bash', [SCRIPT, '--acr', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'no --apps/--sha/... must exit 2');
});

// ---- the shipped command + comparison, lifted from the source ------------------
test('script uses az acr import (ARM, digest-preserving) and never imagetools create', () => {
  assert.match(script, /"\$AZ" acr import --name "\$ACR" --source "\$LOGIN\/\$APP@\$SRC" --image "\$APP:\$SHA" --force/, 'the re-tag command must be the digest-pinned az acr import');
  assert.doesNotMatch(script.replace(/^#.*$/gm, ''), /imagetools create/, 'imagetools create rewrites the manifest; present in code (comments excluded) = regression');
});

test('script keeps the digest post-condition (removing it makes drift pass)', () => {
  assert.match(script, /\[ "\$DST" != "\$SRC" \]/, 'the read-back comparison must exist');
});

test('workflow step delegates to the script and no longer contains inline re-tag logic', () => {
  assert.match(wf, /bash scripts\/ci\/carry-forward-retag\.sh --acr "\$ACR" --login "\$LOGIN"/, 'carry_forward must call the tested script');
  assert.doesNotMatch(wf, /imagetools create/, 'no imagetools create anywhere in the producer workflow');
});

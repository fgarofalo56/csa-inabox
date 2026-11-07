/**
 * #5102 — Gov image builds default to the GitHub runner with a registry layer
 * cache; pool-tier input; failed-pool prune.
 *
 * Two kinds of assertion, kept apart on purpose:
 *   - STATIC reads of the real workflows (defaults, input shapes, parity of each
 *     gov-build-images leg between its az acr build and its gh-runner call);
 *   - EXECUTED runs of scripts/ci/gh-runner-buildx-push.sh against a fake
 *     `docker`, so "a cache failure does not fail the build but a push failure
 *     does" is observed behaviour, not a regex over the script.
 * Each assertion names the edit that turns it red.
 *
 * Run: node --test scripts/ci/__tests__/gov-gh-runner-build.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decidePrune } from '../reap-acr-agent-pools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const IMAGES = read('.github/workflows/gov-build-images.yml');
const CONSOLE = read('.github/workflows/gov-console-roll.yml');
const REAPER = read('.github/workflows/acr-agentpool-reaper.yml');
const SCRIPT_PATH = join(ROOT, 'scripts', 'ci', 'gh-runner-buildx-push.sh');
const SCRIPT = read('scripts/ci/gh-runner-buildx-push.sh');

// ── defaults ────────────────────────────────────────────────────────────────
test('gov-build-images: input, then GOV_IMAGES_BUILDER, then gh-runner', () => {
  assert.ok(
    IMAGES.includes("BUILDER: ${{ inputs.builder || vars.GOV_IMAGES_BUILDER || 'gh-runner' }}"),
    "falling back to 'acr-pool' (or dropping the var) sends scheduled Gov builds back to the dead ACR Tasks backend",
  );
  assert.equal((IMAGES.match(/\n {6}builder:\n(?: {8}.*\n)*? {8}default: ''\n/g) || []).length, 2,
    "both workflow_dispatch and workflow_call must default builder to '' so the variable can apply");
});

test('gov-console-roll: the coded fallback is gh-runner, order unchanged', () => {
  assert.ok(CONSOLE.includes("BUILDER: ${{ inputs.builder || vars.GOV_CONSOLE_BUILDER || 'gh-runner' }}"));
  assert.ok(!CONSOLE.includes("|| 'acr-pool' }}"), "a surviving 'acr-pool' fallback re-breaks the default");
});

test('agent_pool_tier: S3 default, S1/S2 offered, used for BOTH pool creates', () => {
  assert.match(CONSOLE, /\n {6}agent_pool_tier:\n(?: {8}.*\n)*? {8}default: 'S3'\n(?: {8}.*\n)*? {10}- S1\n/,
    'input must default to S3 and offer S1');
  assert.equal((CONSOLE.match(/agentpool create[^\n]*--tier "\$TIER"/g) || []).length, 2, 'both create sites must read $TIER');
  assert.ok(!/agentpool create[^\n]*--tier S\d/.test(CONSOLE), 'a hard-coded --tier bypasses the input');
  assert.match(CONSOLE, /TIER="\$\{TIER:-S3\}"/, 'push-triggered runs have an empty input and must fall back to S3');
});

// ── gov-build-images parity: each leg's gh-runner call vs its az acr build ──
function legBlock(src, label) {
  // text between `loom-console)`/`loom-uat)`/`*)` arms of each of the two case blocks
  const cases = [...src.matchAll(/case "\$APP" in(\n[\s\S]*?)\n\s+esac/g)].map((m) => m[1]);
  assert.equal(cases.length, 2, 'expected exactly two `case "$APP"` blocks (gh-runner and acr-pool)');
  const pick = (body) => {
    const re = label === '*'
      ? /\n\s+\*\)\n([\s\S]*?);;/
      : new RegExp(`\\n\\s+${label}\\)\\n([\\s\\S]*?);;`);
    const m = body.match(re);
    assert.ok(m, `leg ${label} missing`);
    return m[1].replace(/^\s*#.*$/gm, '').replace(/\\\n\s*/g, ' ');
  };
  const [gh, acr] = cases.map(pick);
  return { gh, acr };
}

test('loom-console leg: same Dockerfile, context and build args on both builders', () => {
  const { gh, acr } = legBlock(IMAGES, 'loom-console');
  for (const c of [gh, acr]) {
    assert.match(c, /--file apps\/fiab-console\/Dockerfile\b(?!\.)/);
    assert.match(c, /--build-arg "LOOM_BUILD_SHA=\$SHA_TAG"/);
    assert.match(c, /--build-arg "LOOM_BUILD_TIMESTAMP=\$STAMP"/);
    assert.match(c, /apps\/fiab-console\s*$/m);
  }
  assert.match(gh, /\$\{GH_TAGS\[@\]\}/, 'gh leg must push the same tag set as IMG_ARGS');
});

test('loom-uat leg: Dockerfile.uat, un-ignored e2e/tests, dockerignore restored, on both builders', () => {
  const { gh, acr } = legBlock(IMAGES, 'loom-uat');
  for (const c of [gh, acr]) {
    assert.match(c, /--file apps\/fiab-console\/Dockerfile\.uat apps\/fiab-console/);
    assert.match(c, /grep -vxE 'e2e\|tests'/, 'uat image would ship without its journeys');
    assert.match(c, /cp \/tmp\/di\.bak apps\/fiab-console\/\.dockerignore/);
  }
});

test('default leg: apps/$APP context on both builders', () => {
  const { gh, acr } = legBlock(IMAGES, '*');
  assert.match(gh, /"apps\/\$APP"/);
  assert.match(acr, /"apps\/\$APP"/);
});

test('every gh-runner leg passes --cache-image "$APP" and the tag list mirrors IMG_ARGS', () => {
  assert.match(IMAGES, /--cache-image "\$APP"/);
  assert.match(IMAGES, /IMG_ARGS="\$IMG_ARGS --image \$APP:\$t"\n\s+GH_TAGS\+=\(--tag "\$ACR_LOGIN\/\$APP:\$t"\)/,
    'IMG_ARGS and GH_TAGS must be built in the same loop or the tag sets drift');
});

test('gov-build-images: pool acquire and release are skipped on gh-runner; unknown builder fails', () => {
  assert.match(IMAGES, /if \[ "\$APP" = "loom-console" \] && \[ "\$BUILDER" = "acr-pool" \]; then/, 'pool acquire must be acr-pool only');
  assert.match(IMAGES, /if: always\(\) && env\.BUILDER != 'gh-runner' && matrix\.app == 'loom-console'/, 'release would touch a pool nobody acquired');
  assert.match(IMAGES, /\*\) echo "::error::builder='\$BUILDER' is not one of[^\n]*exit 1/);
});

test('gh-runner build sits after the lease, the data-plane gate and acr-login-retry', () => {
  const at = (s) => { const i = IMAGES.indexOf(s); assert.ok(i > 0, `missing ${s}`); return i; };
  const call = at('bash scripts/ci/gh-runner-buildx-push.sh');
  assert.ok(at('acr-firewall-lease.sh acquire') < call);
  assert.ok(at('acr-dataplane-gate.sh') < call);
  assert.ok(at('acr-login-retry.sh --acr "$ACR"') < call);
  assert.ok(IMAGES.indexOf('- name: Verify the DEPLOY-REFERENCED tag') > call, 'digest verify must follow the build');
});

// ── the script's static contract ────────────────────────────────────────────
test('script: docker-container builder, registry cache both ways, amd64, push', () => {
  assert.match(SCRIPT, /--driver docker-container/);
  assert.match(SCRIPT, /--cache-from "type=registry,ref=\$\{CACHE_REF\}"/);
  assert.match(SCRIPT, /--cache-to "type=registry,ref=\$\{CACHE_REF\},mode=max,image-manifest=true,oci-mediatypes=true"/);
  assert.match(SCRIPT, /--platform linux\/amd64 --push/);
  assert.match(SCRIPT, /CACHE_REF="\$\{ACR_LOGIN\}\/buildcache\/\$\{CACHE_IMAGE\}:cache"/);
});

// ── the script, executed against a fake docker ──────────────────────────────
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ghbuild-'));
  const calls = join(dir, 'calls.log');
  const fake = join(dir, 'docker');
  writeFileSync(fake, `#!/usr/bin/env bash
echo "$*" >> "${calls.replace(/\\/g, '/')}"
if [ "$1 $2" = "buildx build" ]; then
  case " $* " in *" --cache-to "*) HAS_TO=1 ;; *) HAS_TO=0 ;; esac
  # The progress lines every HEALTHY --cache-to build prints (BuildKit), i.e. not an error.
  if [ "\${FAKE_CACHE_PROGRESS:-}" = 1 ] && [ $HAS_TO = 1 ]; then echo "#15 exporting cache to registry"; echo "#15 writing cache image manifest ref=acr.example.us/buildcache/app:cache done"; fi
  if [ "\${FAKE_CACHE_FAIL:-}" = 1 ] && [ $HAS_TO = 1 ]; then echo "error: failed to configure registry cache exporter: denied"; exit 1; fi
  if [ "\${FAKE_PUSH_FAIL:-}" = 1 ]; then echo "error: failed to solve: failed to push: 401 Unauthorized"; exit 1; fi
  if [ "\${FAKE_COMPILE_FAIL:-}" = 1 ]; then echo "error: process npm run build did not complete successfully: exit code: 1"; exit 1; fi
fi
if [ "$1 $2" = "buildx inspect" ] && [ "$3" != "--bootstrap" ]; then exit 1; fi
exit 0
`);
  chmodSync(fake, 0o755);
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ auths: { 'acr.example.us': { auth: 'x' } } }));
  const run = (env = {}, extra = ['--tag', 'acr.example.us/app:1', 'ctx']) => {
    const r = spawnSync('bash', [SCRIPT_PATH, '--acr-login', 'acr.example.us', '--cache-image', 'app', '--', ...extra], {
      encoding: 'utf8',
      env: { ...process.env, GH_RUNNER_DOCKER: fake.replace(/\\/g, '/'), GH_RUNNER_DOCKER_CONFIG: cfg.replace(/\\/g, '/'), GH_RUNNER_SKIP_DISK_FREE: '1', ...env },
    });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { rc: r.status, out: `${r.stdout}${r.stderr}`, builds: log.filter((l) => l.startsWith('buildx build')) };
  };
  return { run, dir, cfg };
}

test('clean build: ONE buildx build with cache-from, cache-to, --push, amd64', () => {
  const h = harness();
  const r = h.run();
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.builds.length, 1, 'a healthy build must not be re-run');
  assert.match(r.builds[0], /--cache-from type=registry,ref=acr\.example\.us\/buildcache\/app:cache/);
  assert.match(r.builds[0], /--cache-to type=registry,ref=acr\.example\.us\/buildcache\/app:cache,mode=max,image-manifest=true,oci-mediatypes=true/);
  assert.match(r.builds[0], /--platform linux\/amd64 --push/);
});

test('cache EXPORT failure: warns, re-runs once without --cache-to, exits 0', () => {
  const h = harness();
  const r = h.run({ FAKE_CACHE_FAIL: '1' });
  assert.equal(r.rc, 0, `a cache failure must not fail the build: ${r.out}`);
  assert.equal(r.builds.length, 2);
  assert.match(r.builds[0], /--cache-to/);
  assert.doesNotMatch(r.builds[1], /--cache-to/);
  assert.match(r.builds[1], /--push/, 'the retry must still push (positive pair to the absence check above)');
  assert.match(r.out, /::warning::registry cache export/, 'the cache failure must be printed');
});

test('PUSH failure: exits non-zero even though a no-cache retry happens', () => {
  const h = harness();
  // The push error does not name the cache exporter, so no retry: first verdict stands.
  const r = h.run({ FAKE_PUSH_FAIL: '1' });
  assert.notEqual(r.rc, 0, 'a push failure must fail the step');
  assert.equal(r.builds.length, 1);
  assert.match(r.out, /failed to push/);
});

test('push failure whose log also names the cache exporter still fails (retry cannot launder it)', () => {
  const h = harness();
  // Both failures at once: cache-to run fails on the exporter; retry then fails on push.
  const r = h.run({ FAKE_CACHE_FAIL: '1', FAKE_PUSH_FAIL: '1' });
  assert.notEqual(r.rc, 0, 'cache failure + push failure must be a failure');
  assert.equal(r.builds.length, 2, 'the retry must have happened, else this test does not reach the laundering path');
  assert.doesNotMatch(r.builds[1], /--cache-to/);
});

// Breaks if the retry pattern matches HEALTHY cache-progress lines ("exporting cache", the cache ref): review of #5110
// found the original pattern did, so every push/auth failure got a wasted rebuild under a false cache warning.
test('a push failure whose log carries normal cache-PROGRESS lines is NOT retried', () => {
  const h = harness();
  const r = h.run({ FAKE_CACHE_PROGRESS: '1', FAKE_PUSH_FAIL: '1' });
  assert.notEqual(r.rc, 0, 'a push failure must fail the step');
  assert.equal(r.builds.length, 1, 'progress lines are not a cache-exporter error, so no retry');
  assert.doesNotMatch(r.out, /::warning::registry cache export/, 'no false "cache export failed" warning');
  // Positive pair: a REAL exporter error amid the same progress lines still takes the retry.
  const c = h.run({ FAKE_CACHE_PROGRESS: '1', FAKE_CACHE_FAIL: '1' });
  assert.equal(c.rc, 0, c.out);
  assert.equal(c.builds.length - r.builds.length, 2, 'the exporter error must still retry once (2 more builds logged)');
});

test('a compile failure is NOT retried and fails', () => {
  const h = harness();
  const r = h.run({ FAKE_COMPILE_FAIL: '1' });
  assert.notEqual(r.rc, 0);
  assert.equal(r.builds.length, 1, 'retrying a real build failure doubles the time for nothing');
});

test('missing docker credentials for the login server fail before any build', () => {
  const h = harness();
  writeFileSync(h.cfg, JSON.stringify({ auths: { 'other.example.io': {} } }));
  const r = h.run();
  assert.notEqual(r.rc, 0);
  assert.equal(r.builds.length, 0, 'an anonymous build would fail late and confusingly');
  assert.match(r.out, /no docker credentials for acr\.example\.us/);
});

// ── prune ───────────────────────────────────────────────────────────────────
const DEAD = Object.freeze({ count: 0, provisioningState: 'Failed', queueCount: 0 });
const prune = (patch) => decidePrune({ ...DEAD, ...patch }).action;

test('prune: Failed + count 0 + queue 0 is the only prune', () => {
  assert.equal(prune({}), 'prune');
});
test('prune: Succeeded at count 0 is kept (state guard)', () => {
  assert.equal(prune({ provisioningState: 'Succeeded' }), 'keep', 'deleting healthy idle pools would break the roll default');
});
test('prune: Failed but count 1 is kept (count guard)', () => {
  assert.equal(prune({ count: 1 }), 'keep');
});
test('prune: Failed, count 0, queue 3 is kept (queue guard)', () => {
  assert.equal(prune({ queueCount: 3 }), 'keep');
});
test('prune: unreadable queue (the wedged InternalServerError shape) deletes nothing', () => {
  assert.equal(prune({ queueCount: null }), 'unknown');
  assert.equal(prune({ count: null }), 'unknown');
});

test('prune input: default false, dispatch only, never reaches the schedule path', () => {
  assert.match(REAPER, /\n {6}prune_failed:\n(?: {8}.*\n)*? {8}default: false\n/);
  assert.ok(REAPER.includes("IN_PRUNE: ${{ github.event_name == 'workflow_dispatch' && inputs.prune_failed || false }}"),
    'dropping the event_name guard lets an input leak into scheduled runs');
  assert.match(REAPER, /\[\[ "\$IN_PRUNE" == "true" \]\] && args\+=\(--prune-failed\)/);
});

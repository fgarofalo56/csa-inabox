/**
 * #5102 — gov-console-roll.yml can build on the GitHub runner (builder=gh-runner).
 *
 * This reads the REAL workflow, not a fixture, because the properties that matter
 * are relations between two blocks of the same file:
 *   - the gh-runner `docker buildx build` and the acr-pool `az acr build` must
 *     carry the SAME build args and the SAME tags (supply-chain parity: the image
 *     the Trivy/cosign steps scan is the image the roll deploys);
 *   - the pool release step must be skipped on gh-runner (it must not touch a pool
 *     no run acquired);
 *   - the effective builder resolves input -> repo variable -> gh-runner.
 *
 * Each assertion names the edit that turns it red.
 *
 * Run: node --test scripts/ci/__tests__/gov-console-roll-builder.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = readFileSync(join(ROOT, '.github', 'workflows', 'gov-console-roll.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The logical command (continuations folded) that starts with `marker`. */
function command(marker) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(marker));
  assert.ok(start >= 0, `no executable line starts with '${marker}' (the builder block was deleted or renamed)`);
  let out = '';
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    out += ` ${t.replace(/\\$/, '')}`;
    if (!t.endsWith('\\')) break;
  }
  return out;
}

// The gh-runner leg is a call to the shared script (cache + builder + --push live
// there; scripts/ci/__tests__/gov-gh-runner-build.test.mjs pins and executes it).
const GH_CALL = 'bash scripts/ci/gh-runner-buildx-push.sh';
const buildArgs =(cmd) => [...cmd.matchAll(/--build-arg\s+"([^"]+)"/g)].map((m) => m[1]).sort();

test('both builders pass the identical --build-arg set (parity; a dropped arg breaks the build marker)', () => {
  const acr = buildArgs(command('az acr build'));
  const gh = buildArgs(command(GH_CALL));
  assert.deepEqual(acr, ['LOOM_BUILD_SHA=$SHA', 'LOOM_BUILD_TIMESTAMP=$STAMP'], 'acr-pool path lost an arg');
  assert.deepEqual(gh, acr, 'gh-runner build args differ from the acr-pool path');
});

test('both builders use the same Dockerfile, context and the SHA + latest tags', () => {
  const acr = command('az acr build');
  const gh = command(GH_CALL);
  for (const c of [acr, gh]) {
    assert.match(c, /--file apps\/fiab-console\/Dockerfile/);
    assert.match(c, /apps\/fiab-console\s*$/, 'context must be apps/fiab-console');
    assert.match(c, /loom-console:\$SHA/);
    assert.match(c, /loom-console:latest/);
  }
  assert.match(gh, /\$ACR_LOGIN\/loom-console:\$SHA/, 'tag must be fully qualified to the Gov ACR login server');
  assert.match(gh, /--cache-image loom-console/, 'cache repo name must be the image name');
  // --push and --platform are asserted on the script itself (gov-gh-runner-build.test.mjs).
});

test('gh-runner branch discards no result (R7): no || true, no 2>/dev/null', () => {
  const m = SRC.match(/# #5102 — build on THIS GitHub-hosted runner[\s\S]*?apps\/fiab-console\n\s*fi\n/);
  assert.ok(m, 'could not locate the gh-runner branch');
  assert.doesNotMatch(m[0].replace(/^\s*#.*$/gm, ''), /\|\|\s*true|2>\/dev\/null/);
  assert.match(m[0], /free -g/, 'runner memory evidence must be printed');
});

test('effective builder resolves input, then repo variable, then gh-runner (#5102 durable default)', () => {
  assert.ok(
    SRC.includes("BUILDER: ${{ inputs.builder || vars.GOV_CONSOLE_BUILDER || 'gh-runner' }}"),
    "reordering this expression, or restoring the 'acr-pool' fallback, changes which source wins",
  );
  // The dispatch default must be blank: a non-blank default would shadow the variable on dispatch.
  assert.match(SRC, /\n {6}builder:\n(?: {8}.*\n)*? {8}default: ''\n/, "builder input default must be '' so the variable can apply");
});

test('an unknown builder fails the build step instead of falling back', () => {
  assert.match(SRC, /acr-pool\|gh-runner\) echo/);
  assert.match(SRC, /\*\) echo "::error::builder='\$BUILDER' is not one of[^\n]*exit 1/);
});

test('pool release is skipped on gh-runner and still runs on acr-pool conclusions', () => {
  const m = SRC.match(/- name: Release the ACR build pool \(verified\)\n\s+if: ([^\n]+)\n/);
  assert.ok(m, 'release step not found');
  assert.ok(m[1].includes("env.BUILDER != 'gh-runner'"), 'release would touch a pool no run acquired');
  assert.ok(m[1].includes("steps.build.conclusion == 'cancelled'"), 'acr-pool path lost its cancelled-run release');
});

test('pool acquire/preflight lives only inside the acr-pool branch', () => {
  const acquire = SRC.indexOf('az acr agentpool create -r "$ACR" -n "$POOL" --tier "$TIER" -o none');
  const guard = SRC.lastIndexOf('if [ "$BUILDER" = "acr-pool" ]; then', acquire);
  const close = SRC.indexOf('# #2929', acquire);
  assert.ok(acquire > 0 && guard > 0 && guard < acquire && acquire < close, 'pool create is outside the acr-pool branch');
  assert.ok(!SRC.slice(guard, acquire).includes('# #2929'), 'the acr-pool branch closed before the pool create');
});

// The "is the ACR build pool needed" decision in build-fiab-images-acr-tasks.yml
// (the pool_acquire job) is a jq filter over the build matrix. On 2026-10-22 that
// filter was `select($a | contains("," + . + ","))`: after `$a |` the filter input
// `.` IS $a, so the pool list was compared against itself and the count was 0 for
// every matrix. The pool was never scaled up, console + directlake queued 105
// minutes on an empty pool, and three runs failed.
//
// This test LIFTS the filter out of the workflow at runtime (assertion-design.md
// rule 3: never transcribe a pattern into a probe) and runs the real jq on
// matrices whose correct answer is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(here, '..', '..', '..', '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const source = readFileSync(WORKFLOW, 'utf8');

// `jq -r --arg a ",$POOL_APPS," '<FILTER>' <<< "$MATRIX"` on the NEED= line.
const m = source.match(/NEED=\$\(jq -r --arg a ",\$POOL_APPS," '([^']+)' <<< "\$MATRIX"\)/);

function need(poolApps, matrixNames) {
  const matrix = JSON.stringify({ include: matrixNames.map((name) => ({ name, ctx: `./apps/${name}` })) });
  const r = spawnSync('jq', ['-r', '--arg', 'a', `,${poolApps},`, m[1]], { input: matrix, encoding: 'utf8' });
  assert.equal(r.status, 0, `jq must run (is jq installed?): ${r.stderr}`);
  return Number(r.stdout.trim());
}

test('the NEED filter was found in the workflow (otherwise every other test below is blind)', () => {
  assert.ok(m, 'could not lift the NEED=$(jq ...) filter from build-fiab-images-acr-tasks.yml');
});

test('a matrix containing both pool apps needs the pool: NEED is 2 (the unbound filter returned 0)', () => {
  assert.equal(need('loom-console,loom-directlake', ['loom-console', 'loom-mcp', 'loom-directlake', 'loom-trino']), 2);
});

test('a matrix containing exactly one pool app: NEED is 1', () => {
  assert.equal(need('loom-console,loom-directlake', ['loom-unity', 'loom-console']), 1);
});

test('a matrix with NO pool app does not touch the pool: NEED is 0', () => {
  assert.equal(need('loom-console,loom-directlake', ['loom-unity', 'loom-trino']), 0);
});

test('a name that merely CONTAINS a pool app name does not count: loom-console-extra is not loom-console', () => {
  assert.equal(need('loom-console,loom-directlake', ['loom-console-extra', 'loom-directlake-v2']), 0);
});

test('a jq failure is fatal, not silently "0 apps" (the pool must never be skipped on a parse error)', () => {
  assert.match(
    source,
    /if ! NEED=\$\(jq -r[\s\S]*?\); then\s+echo "::error::could not read the build matrix[\s\S]*?exit 1/,
    'the NEED assignment must be inside `if ! NEED=$(jq ...); then ... exit 1`',
  );
});

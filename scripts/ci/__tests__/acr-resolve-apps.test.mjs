/**
 * Executes the REAL `resolve` job `matrix` step body of
 * .github/workflows/build-fiab-images-acr-tasks.yml under bash and asserts the
 * matrix it emits (refs #5151). Measured defect: dispatching apps=loom-health-cp
 * rebuilt the entry from scratch (ctx ./apps/loom-health-cp, no file), so ACR
 * failed `COPY ... apps/loom-health-cp/package.json` - that image needs the
 * REPO ROOT as context. apps=all was correct. Run:
 *   node --test scripts/ci/__tests__/acr-resolve-apps.test.mjs
 * Set RESOLVE_WORKFLOW=<path> to point at a sandbox copy (used to prove RED).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const WF = process.env.RESOLVE_WORKFLOW
  ? resolve(process.env.RESOLVE_WORKFLOW)
  : join(REPO, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');

function stepBody() {
  const lines = readFileSync(WF, 'utf8').split(/\r?\n/);
  const id = lines.findIndex((l) => /^\s*- id: matrix\s*$/.test(l));
  assert.ok(id >= 0, 'no "- id: matrix" step found - the test would read nothing');
  const run = lines.findIndex((l, i) => i > id && /^\s*run: \|\s*$/.test(l));
  assert.ok(run > id, 'matrix step has no run: | block');
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n').replace("${{ inputs.apps || 'all' }}", '@@APPS@@');
}

/** Run the step body with the given apps input; returns { code, matrix, out }. */
function resolveApps(apps) {
  const script = stepBody().replace('@@APPS@@', apps);
  const dir = mkdtempSync(join(tmpdir(), 'acr-resolve-'));
  const ghOut = join(dir, 'out').split('\\').join('/');
  try {
    const stdout = execFileSync('bash', ['-s'], {
      cwd: REPO,
      input: script,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: ghOut,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_WORKFLOW: 'build-fiab-images-acr-tasks',
        GITHUB_SHA: '0'.repeat(40),
        GITHUB_REPOSITORY: 'x/y',
      },
    });
    const out = stdout + readFileSync(ghOut, 'utf8');
    const m = out.match(/^matrix=(.*)$/m);
    assert.ok(m, `no matrix= line emitted:\n${out}`);
    return { code: 0, matrix: JSON.parse(m[1]).include, out };
  } catch (e) {
    if (e.name === 'AssertionError') throw e;
    return { code: e.status ?? 1, matrix: null, out: `${e.stdout || ''}${e.stderr || ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('explicit apps=loom-health-cp keeps ctx "." and its own Dockerfile (breaks if ctx is rebuilt as ./apps/loom-health-cp or file is dropped)', () => {
  const r = resolveApps('loom-health-cp');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.matrix.length, 1, JSON.stringify(r.matrix));
  assert.equal(r.matrix[0].name, 'loom-health-cp');
  assert.equal(r.matrix[0].ctx, '.', 'ctx must be the repo root; ./apps/loom-health-cp is the measured defect');
  assert.equal(r.matrix[0].file, './apps/loom-health-cp/Dockerfile');
});

test('explicit selection resolves the same entry as apps=all, for EVERY default app (breaks if any ctx/file differs from the matrix)', () => {
  const all = resolveApps('all');
  assert.equal(all.code, 0, all.out);
  assert.ok(all.matrix.length >= 14, `population guard: expected >=14 default apps, got ${all.matrix.length}`);
  for (const entry of all.matrix) {
    const one = resolveApps(entry.name);
    assert.equal(one.code, 0, `${entry.name}: ${one.out}`);
    assert.equal(one.matrix[0].ctx, entry.ctx, `${entry.name} ctx`);
    assert.equal(one.matrix[0].file, entry.file, `${entry.name} file`);
  }
});

test('comma list keeps order and per-app context (breaks if only the first app uses the matrix)', () => {
  const r = resolveApps('loom-console,loom-health-cp');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.matrix.map((e) => [e.name, e.ctx]), [
    ['loom-console', './apps/fiab-console'],
    ['loom-health-cp', '.'],
  ]);
});

test('loom-uat (not in the matrix) still resolves to the console Dockerfile.uat', () => {
  const r = resolveApps('loom-uat');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.matrix[0].ctx, './apps/fiab-console');
  assert.equal(r.matrix[0].file, './apps/fiab-console/Dockerfile.uat');
});

test('unknown app still fails with the Dockerfile error (breaks if the fallback swallows unknown names)', () => {
  const r = resolveApps('loom-does-not-exist');
  assert.notEqual(r.code, 0, 'unknown app must exit non-zero');
  assert.match(r.out, /no Dockerfile for 'loom-does-not-exist'/);
});

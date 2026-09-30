/**
 * next-build-heap — pins the V8 old-space cap that the console's `next build`
 * runs under, in BOTH places it runs:
 *
 *   - .github/workflows/fiab-console-ci.yml, step `Build (next build)` — the
 *     REQUIRED `next build (node 20)` check, on ubuntu-latest (4 vCPU / 16 GB
 *     for a public repo).
 *   - apps/fiab-console/Dockerfile, `builder` stage — the image every console
 *     roll/deploy builds, on the ACR S3 agent pool (8 vCPU / 16 GB) or on
 *     ubuntu-latest via docker build.
 *
 * WHY. At 6144 the required check died intermittently on 2026-09-30 with
 * `FATAL ERROR: Reached heap limit` in the webpack compiler worker (5477 MB
 * used / 6193 MB committed, then SIGABRT) — main f9c1b59a5 and PR jobs
 * 109874887915 / 109896243197 — while re-runs of the same code passed. The
 * Dockerfile sat at 6656, only 512 MiB above the value that was OOMing.
 *
 * WHAT BREAKS EACH ASSERTION (assertion-design.md):
 *
 *   FLOOR 8192    — either site set back to 6144 (the CI value that OOMed) or
 *                   6656 (the pre-fix Dockerfile value) -> RED. A NODE_OPTIONS
 *                   that is DELETED, or moved off the step (e.g. to job env,
 *                   which this reader does not follow), reads as null -> RED.
 *   CEILING 10240 — either site raised to 12288 -> RED. The ceiling exists
 *                   because on a 16 GB machine the compiler worker also needs
 *                   ~2 GB of native memory (SWC, webpack buffers) beside its V8
 *                   heap, plus the `next build` parent (~1 GB) and the OS/runner.
 *                   Past ~10 GiB of heap the failure changes from a clean V8
 *                   abort WITH a stack to an opaque kernel OOM-kill (the
 *                   Dockerfile's 2026-07-16 history on the 8 GB ACR agent).
 *   EQUAL         — CI 8192 with Dockerfile 6656 (the exact pre-fix drift, in
 *                   reverse) -> RED. The two run the same compile on the same
 *                   16 GB class of machine; a divergence means one of them is
 *                   either starved or not the build the other one proves.
 *   STEP IDENTITY — exactly ONE step named `Build (next build)`, and its run
 *                   is `pnpm build`. Renaming the step, duplicating the name,
 *                   or pointing it at another command -> RED, so the floor can
 *                   never be satisfied by a step that is not the build.
 *
 * The fixture tests below prove the READERS, not the tree: a heap value in a
 * COMMENT does not count, a later step's value is not attributed to the build
 * step, the last of two flags wins (as it does for node), and an ENV in a
 * different Dockerfile stage — or after the build RUN — does not count. Each
 * fixture names the value the reader must return and one that would mean it
 * read the wrong line.
 *
 * Run: node --test scripts/ci/__tests__/next-build-heap.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readLogicalLines, isCommentLine } from '../_logical-lines.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'fiab-console-ci.yml');
const DOCKERFILE = path.join(REPO_ROOT, 'apps', 'fiab-console', 'Dockerfile');
const BUILD_STEP = 'Build (next build)';

export const HEAP_FLOOR_MIB = 8192;
export const HEAP_CEILING_MIB = 10240;

/** Last `--max-old-space-size` in a NODE_OPTIONS string (node: last wins), or null. */
export function heapFromNodeOptions(value) {
  const re = /--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/g;
  let last = null;
  for (const m of String(value ?? '').matchAll(re)) last = Number(m[1]);
  return last;
}

function stripQuotes(s) {
  const t = s.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Drop a trailing ` # comment` from a YAML scalar (not inside quotes — none here). */
function stripYamlTrailingComment(s) {
  return s.replace(/\s+#.*$/, '');
}

/**
 * Every step named `stepName` in a workflow, each as {run, nodeOptions}.
 * A step runs from its `- name:` line to the next line at the same or lower
 * indentation. Whole-line comments are skipped, so a value quoted in a comment
 * is never read as the setting.
 */
export function findWorkflowSteps(yamlText, stepName) {
  const lines = readLogicalLines(yamlText).map((l) => l.text);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)-\s+name:\s*(.+?)\s*$/.exec(lines[i]);
    if (!head || stripQuotes(stripYamlTrailingComment(head[2])) !== stepName) continue;
    const indent = head[1].length;
    const step = { line: i + 1, run: null, nodeOptions: null };
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '' || isCommentLine(line)) continue;
      const lead = /^(\s*)/.exec(line)[1].length;
      if (lead <= indent) break;
      const no = /^\s*NODE_OPTIONS:\s*(.*)$/.exec(line);
      if (no) step.nodeOptions = stripQuotes(stripYamlTrailingComment(no[1]));
      const run = /^\s*run:\s*(.*)$/.exec(line);
      if (run) step.run = stripQuotes(stripYamlTrailingComment(run[1]));
    }
    steps.push(step);
  }
  return steps;
}

/**
 * The heap cap `pnpm build` runs under in the Dockerfile stage `stageName`:
 * the last `ENV NODE_OPTIONS` in that stage BEFORE the RUN that invokes
 * `pnpm build`, overridden by an inline `NODE_OPTIONS=` on that RUN itself.
 * Returns {heap, sawBuild}.
 */
export function dockerBuildHeap(dockerText, stageName) {
  let inStage = false;
  let envValue = null;
  for (const { text } of readLogicalLines(dockerText)) {
    if (isCommentLine(text) || text.trim() === '') continue;
    const from = /^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(text);
    if (from) {
      if (inStage) break;
      inStage = (from[1] || '').toLowerCase() === stageName.toLowerCase();
      continue;
    }
    if (!inStage) continue;
    const env = /^\s*ENV\s+NODE_OPTIONS(?:=|\s+)(.*)$/i.exec(text);
    if (env) envValue = stripQuotes(env[1]);
    if (/^\s*RUN\b/i.test(text) && /\bpnpm\s+(?:run\s+)?build\b/.test(text)) {
      const inline = /\bNODE_OPTIONS=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
      const value = inline ? (inline[1] ?? inline[2] ?? inline[3]) : envValue;
      return { heap: heapFromNodeOptions(value), sawBuild: true };
    }
  }
  return { heap: null, sawBuild: false };
}

// ── the readers, against fixtures ────────────────────────────────────────────

test('heapFromNodeOptions: reads the value, last flag wins, absent is null', () => {
  assert.equal(heapFromNodeOptions('--max-old-space-size=8192'), 8192);
  // node applies the LAST occurrence; reading the first would return 4096.
  assert.equal(heapFromNodeOptions('--max-old-space-size=4096 --max-old-space-size=8192'), 8192);
  assert.equal(heapFromNodeOptions('--max_old_space_size 8192'), 8192);
  assert.equal(heapFromNodeOptions('--enable-source-maps'), null);
  assert.equal(heapFromNodeOptions(null), null);
});

const WF_FIXTURE = `jobs:
  build:
    steps:
      - name: Build (next build)
        env:
          # NODE_OPTIONS: --max-old-space-size=9000  (a comment, must not count)
          NODE_OPTIONS: --max-old-space-size=6144   # trailing comment
        run: pnpm build

      - name: Lint (next lint)
        env:
          NODE_OPTIONS: --max-old-space-size=8192
        run: pnpm lint
      - name: 'Other'
        run: echo hi
`;

test('findWorkflowSteps: reads the step value, not a comment and not the next step', () => {
  const steps = findWorkflowSteps(WF_FIXTURE, BUILD_STEP);
  assert.equal(steps.length, 1);
  // 9000 would mean the comment was read; 8192 would mean the Lint step bled in.
  assert.equal(heapFromNodeOptions(steps[0].nodeOptions), 6144);
  assert.equal(steps[0].run, 'pnpm build');
});

test('findWorkflowSteps: a build step with no NODE_OPTIONS reads null, even if a later step sets one', () => {
  const noEnv = WF_FIXTURE.replace(/ {8}env:\n {10}# NODE_OPTIONS[^\n]*\n {10}NODE_OPTIONS[^\n]*\n/, '');
  // Guard the fixture edit itself: if the regex above stopped matching, this
  // test would be re-testing the first fixture and could not fail for its reason.
  assert.notEqual(noEnv, WF_FIXTURE, 'fixture edit did not apply');
  const steps = findWorkflowSteps(noEnv, BUILD_STEP);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].nodeOptions, null, 'the Lint step\'s 8192 must not be attributed to the build step');
});

const DOCKER_FIXTURE = `FROM node:22-alpine AS deps
ENV NODE_OPTIONS=--max-old-space-size=9999
RUN pnpm install

FROM node:22-alpine AS builder
# ENV NODE_OPTIONS=--max-old-space-size=9000
ENV NODE_OPTIONS=--max-old-space-size=6656
RUN npm install -g pnpm@9 && \\
    pnpm build
ENV NODE_OPTIONS=--max-old-space-size=9001

FROM node:22-alpine AS runner
ENV NODE_OPTIONS=--max-old-space-size=9002
`;

test('dockerBuildHeap: reads the builder-stage ENV that precedes the build RUN (continuation-folded)', () => {
  // 9999 = deps stage, 9000 = comment, 9001 = after the build, 9002 = runner stage.
  assert.deepEqual(dockerBuildHeap(DOCKER_FIXTURE, 'builder'), { heap: 6656, sawBuild: true });
});

test('dockerBuildHeap: an inline NODE_OPTIONS on the build RUN overrides the stage ENV', () => {
  const inline = DOCKER_FIXTURE.replace('    pnpm build', '    NODE_OPTIONS=--max-old-space-size=4096 pnpm build');
  assert.notEqual(inline, DOCKER_FIXTURE, 'fixture edit did not apply');
  assert.equal(dockerBuildHeap(inline, 'builder').heap, 4096);
});

test('dockerBuildHeap: no build RUN in the stage is reported, not read as a value', () => {
  assert.deepEqual(dockerBuildHeap(DOCKER_FIXTURE, 'runner'), { heap: null, sawBuild: false });
});

// ── the real tree ────────────────────────────────────────────────────────────

function ciHeap() {
  const steps = findWorkflowSteps(readFileSync(WORKFLOW, 'utf8'), BUILD_STEP);
  assert.equal(steps.length, 1,
    `expected exactly ONE step named "${BUILD_STEP}" in fiab-console-ci.yml, found ${steps.length} — ` +
    'a rename or duplicate would leave this pin reading a different step (or none)');
  assert.equal(steps[0].run, 'pnpm build',
    `step "${BUILD_STEP}" (line ${steps[0].line}) must run \`pnpm build\`, got ${JSON.stringify(steps[0].run)}`);
  return heapFromNodeOptions(steps[0].nodeOptions);
}

function dockerHeap() {
  const r = dockerBuildHeap(readFileSync(DOCKERFILE, 'utf8'), 'builder');
  assert.equal(r.sawBuild, true, 'apps/fiab-console/Dockerfile: no `pnpm build` RUN found in the `builder` stage');
  return r.heap;
}

test(`fiab-console-ci.yml "${BUILD_STEP}": heap is within [${HEAP_FLOOR_MIB}, ${HEAP_CEILING_MIB}] MiB`, () => {
  const heap = ciHeap();
  assert.ok(heap !== null && heap >= HEAP_FLOOR_MIB,
    `next build heap is ${heap} MiB; the floor is ${HEAP_FLOOR_MIB} (6144 OOMed intermittently on 2026-09-30)`);
  assert.ok(heap <= HEAP_CEILING_MIB,
    `next build heap is ${heap} MiB; the ceiling is ${HEAP_CEILING_MIB} on a 16 GB runner (see file header)`);
});

test(`apps/fiab-console/Dockerfile builder: heap is within [${HEAP_FLOOR_MIB}, ${HEAP_CEILING_MIB}] MiB`, () => {
  const heap = dockerHeap();
  assert.ok(heap !== null && heap >= HEAP_FLOOR_MIB,
    `Dockerfile next build heap is ${heap} MiB; the floor is ${HEAP_FLOOR_MIB} (6656 was 512 MiB above the CI OOM)`);
  assert.ok(heap <= HEAP_CEILING_MIB,
    `Dockerfile next build heap is ${heap} MiB; the ceiling is ${HEAP_CEILING_MIB} on a 16 GB S3 agent (see file header)`);
});

test('the CI build and the image build run under the SAME heap', () => {
  const ci = ciHeap();
  const docker = dockerHeap();
  assert.equal(ci, docker,
    `fiab-console-ci.yml builds at ${ci} MiB but the Dockerfile builds at ${docker} MiB — ` +
    'the PR check stops proving the build the deploy runs');
});

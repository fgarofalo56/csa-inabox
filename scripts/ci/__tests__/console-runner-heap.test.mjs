/**
 * console-runner-heap — pins the RUNTIME V8 heap ceiling of the console image.
 *
 * WHY. The runner stage set no --max-old-space-size (NODE_OPTIONS lived only in
 * the builder stage), so node ran with its ~1048 MB default inside a 2Gi
 * container and died 10 times in 26 h on a heap-limit abort.
 *
 * WHAT BREAKS EACH ASSERTION (assertion-design.md):
 *   RUNNER = 1536   — the ENV deleted (null), or moved to the builder stage
 *                     only, or changed to 1024/8192 -> RED.
 *   BUILDER != 1536 — the runner value pasted over the builder's 8192 -> RED.
 *                     (The builder's own range is pinned by next-build-heap.)
 *   FROM line       — runner stage no longer `FROM node:22-alpine AS runner`
 *                     (the preflight/Trivy tests pin that text) -> RED.
 *   READER fixture  — an ENV in a different stage, or in a comment, must not be
 *                     attributed to the runner.
 *
 * Run: node --test scripts/ci/__tests__/console-runner-heap.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readLogicalLines, isCommentLine } from '../_logical-lines.mjs';
import { heapFromNodeOptions } from './next-build-heap.test.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCKERFILE = path.join(REPO_ROOT, 'apps', 'fiab-console', 'Dockerfile');
export const RUNNER_HEAP_MIB = 1536;

/** {from, heap}: the FROM line of `stageName` and its last ENV NODE_OPTIONS heap (null if none). */
export function stageRuntimeHeap(dockerText, stageName) {
  let inStage = false;
  const out = { from: null, heap: null };
  for (const { text } of readLogicalLines(dockerText)) {
    if (isCommentLine(text) || text.trim() === '') continue;
    const from = /^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(text);
    if (from) {
      if (inStage) break;
      inStage = (from[1] || '').toLowerCase() === stageName.toLowerCase();
      if (inStage) out.from = text.trim();
      continue;
    }
    if (!inStage) continue;
    const env = /^\s*ENV\s+NODE_OPTIONS(?:=|\s+)(.*)$/i.exec(text);
    if (env) out.heap = heapFromNodeOptions(env[1]);
  }
  return out;
}

const FIXTURE = `FROM node:22-alpine AS builder
ENV NODE_OPTIONS=--max-old-space-size=8192
# ENV NODE_OPTIONS=--max-old-space-size=7777
FROM node:22-alpine AS runner
# ENV NODE_OPTIONS=--max-old-space-size=6666
ENV NODE_OPTIONS=--max-old-space-size=1536
`;

test('reader: runner heap comes from the runner stage, not builder or a comment', () => {
  // 8192 = builder bled in; 6666/7777 = a comment was read.
  assert.equal(stageRuntimeHeap(FIXTURE, 'runner').heap, 1536);
  assert.equal(stageRuntimeHeap(FIXTURE, 'builder').heap, 8192);
});

test('reader: a runner with no NODE_OPTIONS reads null even when builder has one', () => {
  const noEnv = FIXTURE.replace(/ENV NODE_OPTIONS=--max-old-space-size=1536\n/, '');
  assert.notEqual(noEnv, FIXTURE, 'fixture edit did not apply');
  assert.equal(stageRuntimeHeap(noEnv, 'runner').heap, null);
});

test(`Dockerfile runner stage sets --max-old-space-size=${RUNNER_HEAP_MIB}`, () => {
  const r = stageRuntimeHeap(readFileSync(DOCKERFILE, 'utf8'), 'runner');
  assert.equal(r.heap, RUNNER_HEAP_MIB, 'runner stage must carry the runtime heap ceiling (null = absent)');
});

test('Dockerfile runner stage still begins with `FROM node:22-alpine AS runner`', () => {
  const r = stageRuntimeHeap(readFileSync(DOCKERFILE, 'utf8'), 'runner');
  assert.equal(r.from, 'FROM node:22-alpine AS runner');
});

test('the builder stage heap is not the runner value (the two are different knobs)', () => {
  const b = stageRuntimeHeap(readFileSync(DOCKERFILE, 'utf8'), 'builder');
  assert.notEqual(b.heap, RUNNER_HEAP_MIB);
  assert.ok(b.heap >= 8192, `builder heap ${b.heap} must stay at its own floor`);
});

/**
 * dockerfile-lockfiles guard tests.
 *
 * The guard exists because a Dockerfile can claim to install from a lockfile
 * that is not in the context it is built with, and nothing notices until the
 * image is built for the first time — which for azure-functions/lineage-extractor
 * was months after the Dockerfile merged (refs #2816, ACR task cj2du).
 *
 * MUTATION-PROVEN against the REAL tree, counts in the PR body: each of R1–R4
 * was driven red and restored to green on
 * azure-functions/lineage-extractor/Dockerfile, with
 * azure-functions/secret-expiry-monitor as a control that stayed green through
 * every mutation.
 *
 * The rows that matter most here are the ones that keep the guard from becoming
 * the thing it guards against:
 *
 *   - The REAL-TREE rows. All four lockfile-strict Dockerfiles in this repo are
 *     read off disk and must evaluate exactly as they really are. A guard that
 *     only ever fires on hand-written fixtures is a guard nobody can trust the
 *     day it fires for real.
 *   - The COMMENT rows. Every assertion is a claim about what a build DOES, and
 *     a Dockerfile comment can spell any instruction verbatim — including the
 *     `COPY package-lock.json ./` that would satisfy the rule. apps/fiab-console/
 *     Dockerfile.uat is the live proof this is not hypothetical: its comment
 *     says "--frozen-lockfile ensures the lockfile is respected exactly" while
 *     the command one line below is `pnpm install --no-frozen-lockfile`. A bare
 *     grep classifies that file wrongly. This guard must not.
 *   - The `npm cache clean` row. Three of these Dockerfiles run
 *     `npm ci --omit=dev && npm cache clean --force` on ONE line. An install
 *     matcher loose enough to also match `clean` would double-count; one that
 *     anchors wrongly would miss the install entirely.
 *   - The VACUITY row. Discovery that finds nothing must fail, not pass.
 *
 * Run: node --test scripts/ci/__tests__/dockerfile-lockfiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  EXEMPT,
  INSTALL_KINDS,
  stripDockerComments,
  joinContinuations,
  parseStages,
  copySources,
  copyDest,
  installKind,
  resolveWorkdir,
  globToRegExp,
  dockerignoreExcludes,
  deliveredLockfiles,
  landedLockfiles,
  findLockfilesUnder,
  discoverDockerfiles,
  deriveContextRoot,
  evaluateDockerfile,
  gitTrackedFiles,
} from '../check-dockerfile-lockfiles.mjs';

const LINEAGE = 'azure-functions/lineage-extractor/Dockerfile';
const SECRET = 'azure-functions/secret-expiry-monitor/Dockerfile';
const EVALUATOR = 'azure-functions/copilot-evaluator/Dockerfile';
const FRONTEND = 'portal/kubernetes/docker/frontend/Dockerfile';
const UAT = 'apps/fiab-console/Dockerfile.uat';

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const tracked = gitTrackedFiles();

// ── comments cannot satisfy anything ────────────────────────────────────────

test('stripDockerComments removes whole-line comments only', () => {
  assert.equal(stripDockerComments('# RUN npm ci\nRUN echo hi').trim(), 'RUN echo hi');
  assert.equal(stripDockerComments('   # COPY package-lock.json ./').trim(), '');
  // `#` mid-instruction is not a comment character.
  assert.match(stripDockerComments('RUN echo "a#b"'), /a#b/);
});

test('a COMMENT spelling the correct COPY does NOT satisfy the rule', () => {
  const text = [
    'FROM node:22 AS build',
    'WORKDIR /app',
    'COPY package.json ./',
    '# COPY package-lock.json ./',
    'RUN npm ci',
  ].join('\n');
  const { problems, checks } = evaluateDockerfile({
    dockerfileRel: 'azure-functions/lineage-extractor/Dockerfile',
    text,
    tracked,
  });
  assert.equal(checks, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R1/);
});

test('a commented-out RUN npm ci is not an install site', () => {
  const text = ['FROM node:22 AS build', 'WORKDIR /app', 'COPY src ./src', '# RUN npm ci'].join('\n');
  const { checks } = evaluateDockerfile({ dockerfileRel: LINEAGE, text, tracked });
  assert.equal(checks, 0);
});

// ── install detection ───────────────────────────────────────────────────────

test('npm ci is detected; npm cache clean on the same line is not a second site', () => {
  assert.equal(installKind('RUN npm ci --omit=dev && npm cache clean --force')?.tool, 'npm');
  assert.equal(installKind('RUN npm cache clean --force'), null);
  assert.equal(installKind('RUN npm install'), null); // not lockfile-strict
  assert.equal(installKind('RUN npm clean-install')?.tool, 'npm');
});

test('pnpm --no-frozen-lockfile is NOT a lockfile-strict install', () => {
  assert.equal(installKind('RUN pnpm install --frozen-lockfile')?.tool, 'pnpm');
  assert.equal(installKind('RUN pnpm install --no-frozen-lockfile'), null);
});

test('yarn --immutable is detected', () => {
  assert.equal(installKind('RUN yarn install --immutable')?.tool, 'yarn');
  assert.equal(installKind('RUN yarn install'), null);
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('parseStages splits on FROM and names stages', () => {
  const stages = parseStages('FROM a AS build\nRUN x\nFROM b AS runtime\nRUN y');
  assert.deepEqual(stages.map((s) => s.name), ['build', 'runtime']);
  assert.deepEqual(stages[0].instructions, ['RUN x']);
});

test('joinContinuations folds a multi-line RUN into one instruction', () => {
  assert.equal(installKind(joinContinuations('RUN npm ci \\\n  --omit=dev').trim())?.tool, 'npm');
});

test('copySources ignores COPY --from (another stage, not the context)', () => {
  assert.deepEqual(copySources('COPY package*.json tsconfig.json ./'), ['package*.json', 'tsconfig.json']);
  assert.equal(copySources('COPY --from=build /app/dist ./dist'), null);
  assert.deepEqual(copySources('COPY --chown=node:node package.json ./'), ['package.json']);
  assert.deepEqual(copySources('COPY ["package.json", "./"]'), ['package.json']);
});

test('copyDest returns the final operand', () => {
  assert.equal(copyDest('COPY package*.json tsconfig.json ./'), './');
  assert.equal(copyDest('COPY a.json /app/b.json'), '/app/b.json');
});

test('resolveWorkdir handles absolute and relative forms', () => {
  assert.equal(resolveWorkdir('/', '/app'), '/app');
  assert.equal(resolveWorkdir('/app', 'sub'), '/app/sub');
  assert.equal(resolveWorkdir('/app', '/other'), '/other');
});

test('globToRegExp uses Go filepath.Match semantics (* does not cross /)', () => {
  assert.ok(globToRegExp('package*.json').test('package-lock.json'));
  assert.ok(globToRegExp('package*.json').test('package.json'));
  assert.ok(!globToRegExp('package*.json').test('a/package.json'));
  assert.ok(globToRegExp('package-lock.json*').test('package-lock.json'));
});

// ── the exact defect: a glob that reads right and delivers nothing ───────────

test('COPY package*.json delivers a lockfile only if one is on disk', () => {
  const withLock = path.join(REPO_ROOT, 'azure-functions/secret-expiry-monitor');
  assert.deepEqual(deliveredLockfiles('package*.json', withLock, ['package-lock.json']), [
    'package-lock.json',
  ]);
  // A directory with package.json but no lockfile — the lineage-extractor shape.
  const noLock = path.join(REPO_ROOT, 'azure-functions/ops-agent-evaluator');
  assert.deepEqual(deliveredLockfiles('package*.json', noLock, ['package-lock.json']), []);
});

test('landedLockfiles places the file at WORKDIR when dest is ./', () => {
  const ctx = path.join(REPO_ROOT, 'azure-functions/secret-expiry-monitor');
  const landed = landedLockfiles('COPY package*.json tsconfig.json ./', ctx, '/app', [
    'package-lock.json',
  ]);
  assert.deepEqual(landed, [{ ctxRel: 'package-lock.json', imagePath: '/app/package-lock.json' }]);
});

test('a single-source COPY that RENAMES the lockfile does not satisfy the install', () => {
  const ctx = path.join(REPO_ROOT, 'azure-functions/secret-expiry-monitor');
  const landed = landedLockfiles('COPY package-lock.json /app/other.json', ctx, '/app', [
    'package-lock.json',
  ]);
  assert.deepEqual(landed, [{ ctxRel: 'package-lock.json', imagePath: '/app/other.json' }]);
});

test('nested lockfile keeps its path beneath a directory COPY', () => {
  const landed = landedLockfiles(
    'COPY azure-functions/secret-expiry-monitor ./app',
    REPO_ROOT,
    '/build',
    ['package-lock.json']
  );
  assert.ok(landed.some((l) => l.imagePath === '/build/app/package-lock.json'));
});

// ── per-stage isolation ─────────────────────────────────────────────────────

test('an earlier STAGE copying the lockfile does not satisfy a later stage', () => {
  const text = [
    'FROM node:22 AS build',
    'WORKDIR /app',
    'COPY package-lock.json package.json ./',
    'RUN npm ci',
    'FROM node:22 AS runtime',
    'WORKDIR /app',
    'COPY package.json ./',
    'RUN npm ci --omit=dev',
  ].join('\n');
  const { problems, checks } = evaluateDockerfile({ dockerfileRel: LINEAGE, text, tracked });
  assert.equal(checks, 2);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stage runtime/);
  assert.match(problems[0], /R1/);
});

test('a COPY AFTER the install does not satisfy it', () => {
  const text = [
    'FROM node:22 AS build',
    'WORKDIR /app',
    'RUN npm ci',
    'COPY package-lock.json package.json ./',
  ].join('\n');
  const { problems } = evaluateDockerfile({ dockerfileRel: LINEAGE, text, tracked });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R1/);
});

test('COPY . . does deliver the lockfile (not a loophole — it is what Docker does)', () => {
  const text = [
    'FROM node:22 AS build',
    'WORKDIR /app',
    'COPY . .',
    'RUN npm ci',
  ].join('\n');
  const { problems, checks } = evaluateDockerfile({ dockerfileRel: SECRET, text, tracked });
  assert.equal(checks, 1);
  assert.equal(problems.length, 0);
});

// ── .dockerignore (R4) ──────────────────────────────────────────────────────

test('dockerignoreExcludes models basename, path, and ! negation', () => {
  assert.ok(dockerignoreExcludes('package-lock.json', 'package-lock.json'));
  assert.ok(dockerignoreExcludes('**/package-lock.json', 'a/package-lock.json'));
  assert.ok(!dockerignoreExcludes('package-lock.json\n!package-lock.json', 'package-lock.json'));
  assert.ok(!dockerignoreExcludes('node_modules\ndist', 'package-lock.json'));
  assert.ok(dockerignoreExcludes('azure-functions', 'azure-functions/x/package-lock.json'));
});

test('no .dockerignore in this repo excludes a lockfile it also copies', () => {
  for (const rel of [LINEAGE, SECRET, EVALUATOR, FRONTEND]) {
    const { problems } = evaluateDockerfile({ dockerfileRel: rel, text: read(rel), tracked });
    assert.deepEqual(problems.filter((p) => /R4/.test(p)), [], `${rel} R4`);
  }
});

// ── context-root derivation ─────────────────────────────────────────────────

test('context root is derived correctly for every real Dockerfile', () => {
  const expected = {
    [LINEAGE]: 'azure-functions/lineage-extractor',
    [SECRET]: 'azure-functions/secret-expiry-monitor',
    [EVALUATOR]: '', // repo root — staged via `git archive HEAD`
    [FRONTEND]: '', // repo root — COPY portal/react-webapp/...
  };
  for (const [rel, root] of Object.entries(expected)) {
    const ctx = deriveContextRoot(rel, parseStages(read(rel)));
    assert.equal(ctx.root, root, `${rel} context root`);
    assert.ok(ctx.score > 0, `${rel} must resolve something`);
  }
});

test('a Dockerfile whose COPYs resolve under NEITHER candidate fails R0 rather than guessing', () => {
  const text = [
    'FROM node:22 AS build',
    'WORKDIR /app',
    'COPY totally/made/up/path.json ./',
    'RUN npm ci',
  ].join('\n');
  const { problems } = evaluateDockerfile({ dockerfileRel: LINEAGE, text, tracked });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R0/);
});

// ── the real tree ───────────────────────────────────────────────────────────

test('REAL TREE: all four lockfile-strict Dockerfiles pass', () => {
  const rels = [LINEAGE, SECRET, EVALUATOR, FRONTEND];
  let sites = 0;
  for (const rel of rels) {
    const { problems, checks } = evaluateDockerfile({ dockerfileRel: rel, text: read(rel), tracked });
    assert.deepEqual(problems, [], `${rel} must be clean`);
    assert.ok(checks > 0, `${rel} must have an install site`);
    sites += checks;
  }
  assert.equal(sites, 7, 'expected 7 lockfile-strict install sites across the four Dockerfiles');
});

test('REAL TREE: lineage-extractor now has a tracked lockfile (the #2816 fix)', () => {
  const lock = 'azure-functions/lineage-extractor/package-lock.json';
  assert.ok(existsSync(path.join(REPO_ROOT, lock)), 'lockfile must exist');
  if (tracked) assert.ok(tracked.has(lock), 'lockfile must be tracked in git');
  const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, lock), 'utf8'));
  assert.equal(parsed.lockfileVersion, 3, 'must match its siblings (npm v3)');
  assert.equal(parsed.name, 'lineage-extractor');
});

test('REAL TREE: Dockerfile.uat is NOT lockfile-strict, despite its comment saying so', () => {
  // The comment reads "--frozen-lockfile ensures the lockfile is respected
  // exactly"; the command is `pnpm install --no-frozen-lockfile`. This asserts
  // the guard classifies by the COMMAND. If the command is ever tightened to
  // --frozen-lockfile, this test flips and the file joins the population.
  const text = read(UAT);
  const strict = parseStages(text).some((s) => s.instructions.some((i) => installKind(i)));
  assert.equal(strict, false);
  assert.match(stripDockerComments(text), /pnpm install --no-frozen-lockfile/);
});

test('discovery finds the Dockerfiles and refuses an empty population', () => {
  const found = discoverDockerfiles();
  assert.ok(found.length >= 30, `expected the repo's Dockerfiles, got ${found.length}`);
  for (const rel of [LINEAGE, SECRET, EVALUATOR, FRONTEND, UAT]) {
    assert.ok(found.includes(rel), `discovery must include ${rel}`);
  }
  // The vacuity branch in main() keys off this being non-empty; if the walk
  // ever returns nothing the guard exits 1 rather than reporting success.
  assert.ok(found.length > 0);
});

test('findLockfilesUnder skips node_modules', () => {
  const hits = findLockfilesUnder(REPO_ROOT, 'azure-functions', ['package-lock.json']);
  assert.ok(hits.includes('azure-functions/secret-expiry-monitor/package-lock.json'));
  assert.ok(!hits.some((h) => h.includes('node_modules')));
});

test('EXEMPT is empty — committing a lockfile is cheaper than justifying its absence', () => {
  assert.deepEqual(Object.keys(EXEMPT), []);
});

test('INSTALL_KINDS covers the three lockfile-strict managers', () => {
  assert.deepEqual(INSTALL_KINDS.map((k) => k.tool), ['npm', 'pnpm', 'yarn']);
});

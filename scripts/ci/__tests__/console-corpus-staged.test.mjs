/**
 * check-console-corpus-staged self-test (#2929).
 *
 * THE BUG THIS GUARD EXISTS FOR. `apps/fiab-console/copilot-corpus/` is tracked
 * as exactly one file — `.gitkeep`. The console Dockerfile's
 * `COPY /app/copilot-corpus ./copilot-corpus` therefore succeeds whether or not
 * `scripts/csa-loom/stage-copilot-corpus.sh` ran: unstaged, it copies an EMPTY
 * directory, silently. On 2026-08-04 only 1 of 8 console-image builders ran that
 * script, so the live console served a corpus of zero files,
 * POST /api/help-copilot/reindex 502'd with "No corpus chunks discovered", and
 * copilot-quality-evals measured a stale index (run 30937670794).
 *
 * A guard for that has to go RED on the real shape of the miss and, just as
 * importantly, must not go green by finding nothing. Both are proved below on
 * fixture trees — the checker is pointed at them via --root, so these exercise
 * the REAL checker, not a re-implementation of it.
 *
 * Run: node --test scripts/ci/__tests__/console-corpus-staged.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConsoleCorpusStaging } from '../check-console-corpus-staged.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-console-corpus-staged.mjs');
const REPO = resolve(HERE, '..', '..', '..');

/** Build a throwaway repo root with the given `<name> → <yaml>` workflows. */
function fixture(workflows) {
  const root = mkdtempSync(join(tmpdir(), 'corpus-guard-'));
  const dir = join(root, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(dir, name), body, 'utf8');
  }
  return root;
}

const BUILD_WITH_STAGING = `
jobs:
  build:
    steps:
      - run: bash scripts/csa-loom/stage-copilot-corpus.sh
      - run: az acr build --registry acr --file apps/fiab-console/Dockerfile apps/fiab-console
`;

const BUILD_WITHOUT_STAGING = `
jobs:
  build:
    steps:
      - run: az acr build --registry acr --file apps/fiab-console/Dockerfile apps/fiab-console
`;

test('a console builder that stages the corpus passes', () => {
  const root = fixture({ 'ok.yml': BUILD_WITH_STAGING });
  try {
    const { builders, missing } = scanConsoleCorpusStaging(root);
    assert.deepEqual(builders, ['ok.yml']);
    assert.deepEqual(missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * MUTATION-PROOF: this is the EXACT shape the five broken workflows had. Delete
 * the staging requirement from the checker and this test goes RED.
 */
test('a console builder with NO staging step is caught', () => {
  const root = fixture({ 'broken.yml': BUILD_WITHOUT_STAGING });
  try {
    const { builders, missing } = scanConsoleCorpusStaging(root);
    assert.deepEqual(builders, ['broken.yml']);
    assert.deepEqual(missing, ['broken.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI exits 1 (with an actionable error) on a missing staging step', () => {
  const root = fixture({ 'broken.yml': BUILD_WITHOUT_STAGING });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /::error::/);
    assert.match(res.stderr, /stage-copilot-corpus\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A MENTION IS NOT A BUILD, and a MENTION IS NOT STAGING. A workflow that only
 * talks about the script in a comment or an echo has not run it — counting
 * either would make the guard green on a workflow that still ships an empty
 * corpus, i.e. a control that measures nothing.
 */
test('a commented-out / echoed staging line does NOT satisfy the guard', () => {
  const root = fixture({
    'fake.yml': `
jobs:
  build:
    steps:
      # bash scripts/csa-loom/stage-copilot-corpus.sh
      - run: echo "remember to run scripts/csa-loom/stage-copilot-corpus.sh"
      - run: az acr build --file apps/fiab-console/Dockerfile apps/fiab-console
`,
  });
  try {
    assert.deepEqual(scanConsoleCorpusStaging(root).missing, ['fake.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workflow that only MENTIONS the console context is not treated as a builder', () => {
  const root = fixture({
    'mention.yml': `
jobs:
  x:
    steps:
      # apps/fiab-console is built elsewhere
      - run: echo "see apps/fiab-console"
      - run: docker build ./apps/loom-unity
`,
    'ok.yml': BUILD_WITH_STAGING,
  });
  try {
    const { builders } = scanConsoleCorpusStaging(root);
    assert.deepEqual(builders, ['ok.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workflow with a console context but NO build invocation is not a builder', () => {
  const root = fixture({
    'lint.yml': `
jobs:
  lint:
    steps:
      - run: pnpm --dir apps/fiab-console lint
`,
    'ok.yml': BUILD_WITH_STAGING,
  });
  try {
    assert.deepEqual(scanConsoleCorpusStaging(root).builders, ['ok.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docker/build-push-action counts as a build invocation', () => {
  const root = fixture({
    'ghcr.yml': `
jobs:
  publish:
    steps:
      - run: bash scripts/csa-loom/stage-copilot-corpus.sh
      - uses: docker/build-push-action@v6
        with:
          context: ./apps/fiab-console
`,
  });
  try {
    assert.deepEqual(scanConsoleCorpusStaging(root).builders, ['ghcr.yml']);
    assert.deepEqual(scanConsoleCorpusStaging(root).missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * THE SELF-CHECK. A guard that passes when it found nothing to check is the
 * defect class this repo keeps hitting. Point it at an empty tree and it must
 * FAIL, not report success.
 */
test('finding ZERO console builders FAILS (a guard cannot pass on nothing)', () => {
  const root = fixture({});
  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ZERO workflows/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The real repo must satisfy its own guard. */
test('the actual repository passes', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', REPO], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /console-image builder\(s\) all stage the Copilot corpus/);
});

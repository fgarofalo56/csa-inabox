/**
 * Self-test for scripts/ci/check-gov-image-producer-parity.mjs.
 *
 * The guard's value is one distinction: a workflow that can build an image FOR
 * AZURE GOVERNMENT versus one that merely builds it, or merely names it in a
 * file that happens to start with `gov-`. Every case below holds that line,
 * because the permissive version of this check would have been green on the
 * tree that shipped loom-transform-runner with no sovereign producer at all
 * (#3416).
 *
 * Run: node --test scripts/ci/__tests__/gov-image-producer-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-gov-image-producer-parity.mjs');

/** Build a throwaway tree: { apps: [names], files: [paths], workflows: {name: body} }. */
function fixture({ apps = [], files = [], workflows = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'loom-gov-img-'));
  for (const a of apps) {
    mkdirSync(join(root, 'apps', a), { recursive: true });
    writeFileSync(join(root, 'apps', a, 'Dockerfile'), 'FROM scratch\n');
  }
  for (const f of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), 'FROM scratch\n');
  }
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(root, '.github', 'workflows', name), body);
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const COMMERCIAL = (ctx) => `name: commercial
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_CLIENT_ID }}
      - run: az acr build --registry "$ACR" --image x:1 ${ctx}
`;

const SOVEREIGN = (ctx) => `name: sovereign
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_GOV_CLIENT_ID }}
      - run: az cloud set --name AzureUSGovernment
      - run: az acr build --registry "$ACR" --image x:1 ${ctx}
`;

test('the embedded controls run on every invocation and are reported', () => {
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /embedded control\(s\) held/);
  rmSync(root, { recursive: true, force: true });
});

test('an app built ONLY by a Commercial-credentialed workflow FAILS', () => {
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  assert.match(r.out, /none of which can authenticate to Azure Government/);
  rmSync(root, { recursive: true, force: true });
});

test('adding a Gov-credentialed producer makes it pass', () => {
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+thing\s+s\.yml/);
  rmSync(root, { recursive: true, force: true });
});

test('the FILENAME is not the oracle — a gov-*.yml with Commercial creds does NOT satisfy the rule', () => {
  // #3416 measured the gap with `grep -l <image> .github/workflows/gov-*.yml`.
  // That test passes for a file merely NAMED gov-*, which proves nothing about
  // which cloud it can reach.
  const root = fixture({ apps: ['thing'], workflows: { 'gov-lookalike.yml': COMMERCIAL('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  rmSync(root, { recursive: true, force: true });
});

test('the FILENAME is not the oracle — a non-gov-named lane WITH Gov creds DOES satisfy it', () => {
  // build-fiab-images-acr-tasks.yml is exactly this shape in the real tree.
  const root = fixture({ apps: ['thing'], workflows: { 'build-images.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('a Gov workflow that only names the app in a COMMENT is not a Gov producer', () => {
  const wf = SOVEREIGN('apps/other').replace('  b:', '  b:\n    # builds apps/thing one day');
  const root = fixture({ apps: ['thing', 'other'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  rmSync(root, { recursive: true, force: true });
});

test('a Gov workflow that only ECHOES the app is not a Gov producer — the sharpest case', () => {
  const wf = SOVEREIGN('apps/other').replace(
    '      - run: az cloud set --name AzureUSGovernment',
    '      - run: echo "apps/thing would be built here"',
  );
  const root = fixture({ apps: ['thing', 'other'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  rmSync(root, { recursive: true, force: true });
});

test('a Gov workflow that names the app in a ::notice:: is not a Gov producer', () => {
  const wf = SOVEREIGN('apps/other').replace(
    '      - run: az cloud set --name AzureUSGovernment',
    '      - run: printf "::notice::apps/thing is missing"',
  );
  const root = fixture({ apps: ['thing', 'other'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('an app NOBODY builds is left to check-image-producer-coverage, not double-reported', () => {
  const root = fixture({ apps: ['thing', 'orphan'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unbuilt\(\*\)\s+orphan/);
  rmSync(root, { recursive: true, force: true });
});

test('an EXTRA subject (Dockerfile outside apps/) is checked when its context exists', () => {
  // The copilot-evaluator class: nothing under apps/, so the sibling guard
  // never sees it. Here only a Commercial lane builds it.
  const ctxFile = 'azure-functions/copilot-evaluator/Dockerfile';
  const root = fixture({
    apps: ['thing'],
    files: [ctxFile],
    workflows: {
      'c.yml': `${COMMERCIAL('apps/thing')}      - run: az acr build --registry "$ACR" --image e:1 --file ${ctxFile} .\n`,
      's.yml': SOVEREIGN('apps/thing'),
    },
  });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+loom-copilot-evaluator/);
  rmSync(root, { recursive: true, force: true });
});

test('an EXTRA subject that no fixture created is not invented as a subject', () => {
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /loom-copilot-evaluator/);
  rmSync(root, { recursive: true, force: true });
});

test('a tree with no app Dockerfiles FAILS rather than reporting success on nothing', () => {
  const root = fixture({ workflows: { 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no apps\/<name>\/Dockerfile found/);
  rmSync(root, { recursive: true, force: true });
});

test('a tree whose workflows build nothing FAILS rather than passing everything', () => {
  const root = fixture({ apps: ['thing'], workflows: { 'n.yml': 'name: nothing\non: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n' } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no workflow contains an image-build invocation/);
  rmSync(root, { recursive: true, force: true });
});

// ── LOGICAL LINES (#3420 / #3427) ───────────────────────────────────────────
// The scanner folds `\` continuations and tests the prose markers only against
// the text BEFORE the match. These two cases are the reason, and they are the
// same two the guard carries as embedded controls — here they run against real
// files on disk rather than in-memory fixtures.

test('a FOLDED Gov build whose context shares a line with its own `|| echo` IS a producer', () => {
  // Physical lines see `apps/thing || echo "…"` and discard it as prose, so the
  // lane reports as having no Gov producer. That false-clean is exactly what a
  // guard hunting missing Gov producers must not do.
  const folded = `name: sovereign
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_GOV_CLIENT_ID }}
      - run: |
          az acr build --registry "$ACR" --image x:1 \\
            apps/thing || echo "::error::apps/thing build failed"
`;
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': folded } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+thing\s+s\.yml/);
  rmSync(root, { recursive: true, force: true });
});

test('a FOLDED echo is still prose — folding must not invent a producer', () => {
  const foldedEcho = `name: sovereign
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_GOV_CLIENT_ID }}
      - run: |
          echo "nothing here builds \\
            apps/thing yet"
          az acr build --registry "$ACR" --image other:1 apps/other
`;
  const root = fixture({ apps: ['thing', 'other'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': foldedEcho } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  rmSync(root, { recursive: true, force: true });
});

test('a build context COMMENTED OUT mid-command is not a producer', () => {
  // Folding's own hazard: the `#` line splices into a logical line that does not
  // START with `#`, so only a word-initial-`#`-before-the-match test sees it.
  // The shell reads it as a comment too, so the build has no context at all.
  const commented = `name: sovereign
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_GOV_CLIENT_ID }}
      - run: |
          az acr build --registry "$ACR" \\
            --image x:1 \\
            # apps/thing
`;
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': commented } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GOV-MISSING\s+thing/);
  rmSync(root, { recursive: true, force: true });
});

test('a hash INSIDE a tag is not mistaken for a comment', () => {
  // The word-initial `#` test must not reject `--image "x#y" apps/thing`.
  const hashTag = `name: sovereign
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_GOV_CLIENT_ID }}
      - run: az acr build --registry "$ACR" --image "thing:sha#abc" apps/thing
`;
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': hashTag } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+thing\s+s\.yml/);
  rmSync(root, { recursive: true, force: true });
});

test('the embedded controls are reported by count, and there are six of them', () => {
  // If a control is deleted to make a red guard green, this number moves.
  const root = fixture({ apps: ['thing'], workflows: { 'c.yml': COMMERCIAL('apps/thing'), 's.yml': SOVEREIGN('apps/thing') } });
  const r = run(root);
  assert.match(r.out, /6 embedded control\(s\) held/);
  rmSync(root, { recursive: true, force: true });
});

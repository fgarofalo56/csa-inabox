/**
 * Self-tests for check-deploy-paths-coverage.mjs (#2775 — the watchdog's own gap).
 *
 * WHAT IS BEING PINNED. check-deploy-staleness.mjs compares each watched
 * workflow's last successful run against commits touching that entry's `paths`.
 * That list was hand-written, and for the three #2775 paths it listed almost
 * nothing the workflow actually deploys — so a source missing from `paths` could
 * never register as drift and the entry read green while the source diverged.
 * This guard asserts the watchdog measures what it claims to measure.
 *
 * Every CONTROL case below is chosen to DIE under an obvious mutation:
 *
 *   - make isCovered() return true unconditionally → the uncovered-source test
 *     and the sibling-directory test both go red.
 *   - drop the `/**`-prefix handling in isCovered() → the glob test goes red.
 *   - make isCovered() a naive `startsWith` → the sibling-directory test goes
 *     red (apps/loom-unity-extras must NOT be covered by apps/loom-unity).
 *   - delete the isInert() filter in extractDeploySources() → the comment,
 *     echo and ::warning:: cases each yield a phantom source and go red. This
 *     is the #2816 false positive (a warning string counted as a deploy path),
 *     which the sibling reachability guard learned the hard way.
 *   - drop the CI_PLUMBING branch in classifyEntry() → the plumbing test goes
 *     red. Equally, turning CI_PLUMBING into a blanket mute is caught by the
 *     test asserting every entry carries a non-trivial REASON.
 *   - make decide() always return 0 → the any-gap test goes red.
 *
 * Run: node --test scripts/ci/__tests__/deploy-paths-coverage.test.mjs
 * (Auto-discovered by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractDeploySources,
  isCovered,
  classifyEntry,
  decide,
  isExecution,
  CI_PLUMBING,
} from '../check-deploy-paths-coverage.mjs';
import { WATCHED } from '../check-deploy-staleness.mjs';

const CI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// extractDeploySources — only real execution counts, never a mention
// ---------------------------------------------------------------------------

test('detects a shell script that is actually executed', () => {
  const src = extractDeploySources('        run: bash scripts/csa-loom/seed-governance.sh --rg x\n');
  assert.equal(src.get('scripts/csa-loom/seed-governance.sh'), 'script');
});

// ---------------------------------------------------------------------------
// #3787 — the `node <path>` shape the extractor was structurally blind to
// ---------------------------------------------------------------------------

test('detects a node-invoked deploy script (#3787 — the shape that passed VACUOUSLY)', () => {
  // Before this shape existed, `node scripts/ci/deploy-retry.mjs` yielded ZERO
  // sources while `-f X.bicep` and `bash X.sh` on the same corpus yielded two.
  // Measured across the 15 watched workflows: 34 node-invoked deploy sources
  // were invisible, including the script that decides deploy_apps_enabled and
  // both GCC-High estate preflights.
  const src = extractDeploySources('          node scripts/ci/deploy-fiab-guard.mjs\n');
  assert.equal(src.get('scripts/ci/deploy-fiab-guard.mjs'), 'node');
});

test('the node shape survives an interpreter flag, a quote and a $GITHUB_WORKSPACE prefix', () => {
  // Real call sites in this repo carry all three.
  assert.equal(
    extractDeploySources('          node --experimental-vm-modules scripts/ci/roll-plan.mjs\n')
      .get('scripts/ci/roll-plan.mjs'),
    'node',
  );
  assert.equal(
    extractDeploySources('          node "$GITHUB_WORKSPACE/scripts/ci/adopt-image-tags.mjs" --json\n')
      .get('scripts/ci/adopt-image-tags.mjs'),
    'node',
  );
  assert.equal(
    extractDeploySources('          node ./scripts/csa-loom/resolve-dlz-coordinates.mjs\n')
      .get('scripts/csa-loom/resolve-dlz-coordinates.mjs'),
    'node',
  );
  // .cjs and .js are the same shape, and scripts/csa-loom/loom-verify.js is a
  // real deploy source of this repo — restricting the class to .mjs would have
  // re-created the blind spot one extension over.
  assert.equal(
    extractDeploySources('          node scripts/csa-loom/loom-verify.js\n').get('scripts/csa-loom/loom-verify.js'),
    'node',
  );
});

test('CONTROL: a MENTIONED node script is NOT a deploy source', () => {
  // Same discipline as the .sh shape: being permissive here re-admits the #2816
  // false positive, where a warning string counted as a deploy path.
  assert.equal(extractDeploySources('          # node scripts/ci/deploy-retry.mjs is the retry primitive\n').size, 0);
  assert.equal(extractDeploySources('          echo "run node scripts/ci/deploy-retry.mjs to retry"\n').size, 0);
  assert.equal(extractDeploySources('          echo "::warning::node scripts/ci/deploy-retry.mjs failed"\n').size, 0);
  assert.equal(extractDeploySources(' * `node scripts/ci/deploy-retry.mjs` — the retry primitive\n').size, 0);
});

test('CONTROL: `node -e` and a node path outside the source roots are NOT deploy sources', () => {
  // `node -e '<program>'` has no repo path to watch, and a single-dash flag must
  // not be swallowed by the optional --flag run.
  assert.equal(extractDeploySources("          node -e 'console.log(1)'\n").size, 0);
  assert.equal(extractDeploySources('          node /usr/local/lib/whatever.mjs\n').size, 0);
  // A bare word ending in .mjs that is not preceded by `node` is nobody's
  // execution — it must not be picked up by the `.sh`-style bare scan.
  assert.equal(extractDeploySources('          FILE=scripts/ci/deploy-retry.mjs\n').size, 0);
});

test('THE TWO-ARM CONTROL: the OLD extractor passes VACUOUSLY where the NEW one fails', async () => {
  // The mutation is the defect itself: delete the node matcher and re-ask the
  // same question. A guard whose verdict does not MOVE under the mutation it
  // exists to catch is not watching (the "mutation that does not move the
  // verdict" class).
  const guard = path.join(CI_DIR, 'check-deploy-paths-coverage.mjs');
  const original = readFileSync(guard, 'utf8');
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);

  // Strip the loop body of the node matcher — keyed on the `add(m[1], 'node')`
  // call, which is the thing that must exist, not on any comment around it.
  const at = lines.findIndex((l) => /^\s*add\(m\[1\], 'node'\);\s*$/.test(l));
  assert.ok(at >= 0, "the mutation did not apply — no `add(m[1], 'node')` call found, so this control proves NOTHING");
  lines[at] = '      // MUTATED BY THE CONTROL — node sources dropped on the floor';

  // The copy sits beside the original so its relative import of
  // ./check-deploy-staleness.mjs still resolves.
  const mutant = path.join(CI_DIR, 'check-deploy-paths-coverage.__control__.mjs');
  writeFileSync(mutant, lines.join(nl));
  try {
    const old = await import(pathToFileURL(mutant).href);

    // ONE fixture, both arms. A watched entry that executes a node deploy source
    // and does not declare it.
    const fixture = {
      workflow: 'w.yml',
      paths: ['.github/workflows/w.yml'],
      text: '        run: node scripts/ci/deploy-fiab-guard.mjs\n',
      plumbing: {},
    };

    const nowRow = classifyEntry(fixture);
    const oldRow = old.classifyEntry(fixture);

    assert.equal(oldRow.checked, 0, 'the OLD extractor should see NOTHING here — that is the bug');
    assert.equal(decide([oldRow]).code, 0, 'the OLD guard passed on an undeclared deploy source (VACUOUS)');

    assert.equal(nowRow.checked, 1, 'the NEW extractor must SEE the node invocation');
    assert.deepEqual(nowRow.uncovered, [{ path: 'scripts/ci/deploy-fiab-guard.mjs', how: 'node' }]);
    assert.equal(decide([nowRow]).code, 1, 'the NEW guard must FAIL on an undeclared node deploy source');
  } finally {
    rmSync(mutant, { force: true });
  }

  assert.equal(readFileSync(guard, 'utf8'), original, 'the real guard must be untouched by this control');
});

test('POPULATION: the node shape is not decoration — it matches real watched workflows', () => {
  // A guard with a zero population proves nothing. This asserts the new shape
  // actually fires across the tree, and names the count, so a future refactor
  // that silently stops matching (a renamed capture group, a tightened class)
  // goes red instead of going quiet.
  let nodeSources = 0;
  const lanes = new Set();
  for (const entry of WATCHED) {
    const wf = `.github/workflows/${entry.workflow}`;
    if (!existsSync(wf)) continue;
    for (const how of extractDeploySources(readFileSync(wf, 'utf8')).values()) {
      if (how === 'node') { nodeSources += 1; lanes.add(entry.workflow); }
    }
  }
  assert.ok(nodeSources >= 30, `only ${nodeSources} node deploy source(s) detected across the watched lanes — 34 were measured when #3787 landed, so the matcher has stopped matching`);
  assert.ok(lanes.size >= 8, `only ${lanes.size} lane(s) carry a node deploy source — 9 were measured when #3787 landed`);
});

test('detects a bicep template applied with -f', () => {
  const src = extractDeploySources('          -f platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep \\\n');
  assert.equal(src.get('platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep'), 'bicep');
});

test('detects an image build: the Dockerfile AND the build context (the #2643 shape)', () => {
  // The real gov-uc-purview-wire step. apps/loom-unity is where the #2643 fix
  // lives; it was absent from that entry's paths, so the watchdog written
  // because a #2643 fix sat undeployed could not see the #2643 fix change.
  const yaml = [
    '            --image "loom-unity:$SHA" \\',
    '            --file apps/loom-unity/Dockerfile \\',
    '            apps/loom-unity',
  ].join('\n');
  const src = extractDeploySources(yaml);
  assert.equal(src.get('apps/loom-unity/Dockerfile'), 'image');
  assert.equal(src.get('apps/loom-unity'), 'image-context');
});

test('detects a Function-App code publish behind a cd', () => {
  const src = extractDeploySources('              ( cd azure-functions/report-subscriptions && npm ci --no-audit && npm run build \\\n');
  assert.equal(src.get('azure-functions/report-subscriptions'), 'func-publish');
});

test('a templated asset path contributes its literal directory', () => {
  const src = extractDeploySources('                --definition "@platform/fiab/grafana/${D}.json" \\\n');
  assert.equal(src.get('platform/fiab/grafana'), 'asset');
});

test('the asset class keeps `-`, `{`, `}` and `$` LITERAL (CodeQL #768 rewrote it)', () => {
  // #768: the class was written `[A-Za-z0-9._/\\-\${}]` inside a TEMPLATE literal,
  // where `\$` is consumed by the template and the regex only ever saw a bare `$`.
  // Inside a class that is a literal `$` and the guard worked — but the escape
  // said one thing and the regex did another. Rewritten to `[A-Za-z0-9._/{}$-]`,
  // which needs no escape at all. These pin what must not change with it:
  // a HYPHENATED directory (the `-` must not become a range) that is also
  // TEMPLATED (the `{`, `}` and `$` must all still be matched, or the path is
  // truncated at the wrong place and the wrong directory is watched).
  const templated = extractDeploySources('          --definition "@platform/fiab/grafana-alerts/${D}.json" \\\n');
  assert.equal(templated.get('platform/fiab/grafana-alerts'), 'asset');
  const literal = extractDeploySources('          --definition "@platform/fiab/grafana-alerts/cost-v2.json" \\\n');
  assert.equal(literal.get('platform/fiab/grafana-alerts/cost-v2.json'), 'asset');
});

test('CONTROL: a YAML comment naming a script is NOT a deploy source', () => {
  const src = extractDeploySources('          # through scripts/csa-loom/kv-firewall-window.sh, whose close RE-READS\n');
  assert.equal(src.size, 0, 'a comment is a mention, not an execution');
});

test('CONTROL: an ::warning:: naming a script is NOT a deploy source (#2816 false positive)', () => {
  const src = extractDeploySources('          echo "::warning::run scripts/csa-loom/patch-navigator-env.sh manually"\n');
  assert.equal(src.size, 0, 'a warning string is what let #2816 sit unnoticed');
});

test('CONTROL: an echoed path is NOT a deploy source', () => {
  const src = extractDeploySources('          echo "see scripts/csa-loom/seed-governance.sh for details"\n');
  assert.equal(src.size, 0);
});

test('CONTROL: a path outside the known source roots is ignored', () => {
  const src = extractDeploySources('          run: bash /usr/local/bin/whatever.sh\n');
  assert.equal(src.size, 0);
});

// isExecution must agree with the sibling reachability guard, or a script could
// pass one guard and fail the other.
test('isExecution matches the sibling guard: bash/./source yes, echo/comment no', () => {
  const p = 'scripts/csa-loom/x.sh';
  assert.equal(isExecution(`bash ${p} --flag`, p), true);
  assert.equal(isExecution(`./${p}`, p), true);
  assert.equal(isExecution(`source ${p}`, p), true);
  assert.equal(isExecution(`  # bash ${p}`, p), false);
  assert.equal(isExecution(`echo "bash ${p}"`, p), false);
  assert.equal(isExecution(`echo "::warning::${p}"`, p), false);
});

// ---------------------------------------------------------------------------
// isCovered — exact, glob and directory coverage (and what must NOT match)
// ---------------------------------------------------------------------------

test('exact path coverage', () => {
  assert.equal(isCovered('scripts/csa-loom/a.sh', ['scripts/csa-loom/a.sh']), true);
});

test('a /** glob covers everything beneath it', () => {
  assert.equal(isCovered('apps/loom-unity/Dockerfile', ['apps/loom-unity/**']), true);
  assert.equal(isCovered('apps/loom-unity', ['apps/loom-unity/**']), true);
});

test('a bare directory entry covers everything beneath it', () => {
  assert.equal(isCovered('platform/fiab/grafana/loom-usage.json', ['platform/fiab/grafana']), true);
});

test('CONTROL: a sibling directory sharing a prefix is NOT covered', () => {
  // A naive startsWith would wrongly pass this — apps/loom-unity-extras is a
  // different tree, and treating it as covered would silence real drift.
  assert.equal(isCovered('apps/loom-unity-extras/x.ts', ['apps/loom-unity/**']), false);
  assert.equal(isCovered('scripts/csa-loom/a-b.sh', ['scripts/csa-loom/a.sh']), false);
});

test('CONTROL: an unlisted path is NOT covered', () => {
  assert.equal(isCovered('scripts/csa-loom/b.sh', ['scripts/csa-loom/a.sh']), false);
});

// ---------------------------------------------------------------------------
// classifyEntry — the decision
// ---------------------------------------------------------------------------

const YAML_ONE_SCRIPT = '        run: bash scripts/csa-loom/seed-governance.sh\n';

test('a deploy source missing from paths is a GAP (the #2775 shape)', () => {
  const r = classifyEntry({
    workflow: 'w.yml',
    paths: ['.github/workflows/w.yml'],
    text: YAML_ONE_SCRIPT,
    plumbing: {},
  });
  assert.equal(r.uncovered.length, 1);
  assert.equal(r.uncovered[0].path, 'scripts/csa-loom/seed-governance.sh');
  assert.equal(r.uncovered[0].how, 'script');
});

test('CONTROL: the same source listed in paths is NOT a gap', () => {
  const r = classifyEntry({
    workflow: 'w.yml',
    paths: ['.github/workflows/w.yml', 'scripts/csa-loom/seed-governance.sh'],
    text: YAML_ONE_SCRIPT,
    plumbing: {},
  });
  assert.equal(r.uncovered.length, 0);
  assert.equal(r.checked, 1, 'it was measured, not skipped');
});

test('a CI_PLUMBING source is allowed but REPORTED, never silently dropped', () => {
  const r = classifyEntry({
    workflow: 'w.yml',
    paths: ['.github/workflows/w.yml'],
    text: '        run: bash scripts/csa-loom/acr-firewall-lease.sh acquire\n',
    plumbing: { 'scripts/csa-loom/acr-firewall-lease.sh': 'reason' },
  });
  assert.equal(r.uncovered.length, 0);
  assert.deepEqual(r.plumbing, ['scripts/csa-loom/acr-firewall-lease.sh']);
});

test('a workflow with no detectable source reports checked===0 (UNKNOWN, not a pass)', () => {
  // gov-workspace-identity.yml is this shape: it ASSERTS against a running
  // estate and applies nothing. Reporting that as a plain "ok" would claim a
  // verification never performed — the "UNKNOWN reported as a result" trap.
  const r = classifyEntry({ workflow: 'w.yml', paths: ['.github/workflows/w.yml'], text: '# nothing\n', plumbing: {} });
  assert.equal(r.checked, 0);
  assert.equal(r.uncovered.length, 0);
});

test('decide: any gap → exit 1; none → exit 0', () => {
  assert.equal(decide([{ uncovered: [] }, { uncovered: [] }]).code, 0);
  assert.equal(decide([{ uncovered: [] }, { uncovered: [{ path: 'x' }] }]).code, 1);
});

// ---------------------------------------------------------------------------
// The allowlist must stay a reasoned loan, not a mute
// ---------------------------------------------------------------------------

test('every CI_PLUMBING entry carries a substantive reason', () => {
  for (const [p, reason] of Object.entries(CI_PLUMBING)) {
    assert.ok(typeof reason === 'string' && reason.length > 40,
      `${p} must state WHY editing it cannot change the deployed estate`);
  }
});

// ---------------------------------------------------------------------------
// The live tree: the three #2775 paths must declare what they deploy
// ---------------------------------------------------------------------------

test('LIVE: the three #2775 deploy paths declare every source they deploy', () => {
  for (const wf of [
    'gov-uc-purview-wire.yml',
    'gov-workspace-identity.yml',
    'csa-loom-post-deploy-bootstrap.yml',
  ]) {
    const entry = WATCHED.find((e) => e.workflow === wf);
    assert.ok(entry, `${wf} is watched`);
    const r = classifyEntry({
      workflow: wf,
      paths: entry.paths,
      text: readFileSync(`.github/workflows/${wf}`, 'utf8'),
    });
    assert.deepEqual(r.uncovered, [], `${wf} deploys from sources its entry does not watch`);
  }
});

test('LIVE: gov-uc-purview-wire watches apps/loom-unity — the tree the #2643 fix lives in', () => {
  const entry = WATCHED.find((e) => e.workflow === 'gov-uc-purview-wire.yml');
  assert.ok(
    entry.paths.some((p) => p === 'apps/loom-unity/**' || p === 'apps/loom-unity'),
    'the image this workflow builds comes from apps/loom-unity; without it, a change there is invisible drift',
  );
});

test('LIVE: post-deploy-bootstrap watches the #2757 Iceberg template it applies', () => {
  const entry = WATCHED.find((e) => e.workflow === 'csa-loom-post-deploy-bootstrap.yml');
  assert.ok(
    entry.paths.includes('platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep'),
  );
});

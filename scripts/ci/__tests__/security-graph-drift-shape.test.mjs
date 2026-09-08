/**
 * THE DRIFT GATE'S COMPARISON, AND THE COUNTERFACTUAL THAT PROVES IT MOVED (#4128).
 *
 * `scripts/brain/extract-security-graph.mjs --check` is the job named
 * `brain security graph — committed artifact matches the tree`. Until #4128 it
 * compared `{graph, join}` and nothing else, so a change that moved the
 * POPULATION without moving the GRAPH went straight past it — while the
 * REQUIRED census in `no-estate-identifiers.test.ts` caught the same change and
 * went red. The advisory gate whose entire job is drift detection was the blind
 * one, and a triager reading it green would look for the vitest failure in the
 * wrong place.
 *
 * ── THE ARM WITHOUT WHICH THIS CHANGE IS UNTESTABLE ──────────────────────
 *
 * A fix to a guard is indistinguishable from no fix at all unless something
 * demonstrates the guard newly catches a case it used to pass. So the pre-fix
 * comparison is reproduced VERBATIM below as {@link PARENT_NORM} and run over
 * the SAME artifact pair as the post-fix comparison:
 *
 *     PARENT_NORM       -> the pair is EQUAL     (the blind spot is real)
 *     driftDifferences  -> the pair DIFFERS      (the fix closes it)
 *
 * Both arms, one process, one fixture. Measured end-to-end on the real CLI as
 * well, using `scripts/ci/__fixtures__/census-drift-probe.mjs` as the delta:
 * parent RC=0, tip RC=1, node and edge counts identical in both.
 *
 * ── AND THE ARM THAT KEEPS IT FIXED ──────────────────────────────────────
 *
 * The obvious fix — adding `meta.scanScopes` to the two compared fields — is a
 * NARROWER ENUMERATION, and this repo loses to the next name every time it
 * writes one: `meta.filesScanned` would still have been invisible. So the
 * comparison is keyed to shape (compare everything, exempt by declaration) and
 * `a meta field invented later is compared without being named anywhere` asserts
 * exactly that, by inventing one.
 *
 * Run: node --test scripts/ci/__tests__/security-graph-drift-shape.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VOLATILE_META_FIELDS,
  POPULATION_META_FIELDS,
  comparableArtifact,
  driftDifferences,
  populationRefusals,
} from '../../brain/_artifact-drift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DRIFT_MODULE = resolve(HERE, '..', '..', 'brain', '_artifact-drift.mjs');
const FIXTURE = resolve(HERE, '..', '__fixtures__', 'census-drift-probe.mjs');
const ARTIFACT = resolve(
  REPO_ROOT,
  'apps/fiab-console/lib/brain/security/extract/__generated__/security-graph.json',
);

const VOLATILE_NAMES = VOLATILE_META_FIELDS.map((v) => v.field);

/**
 * THE PRE-FIX COMPARISON, COPIED VERBATIM FROM THE PARENT COMMIT.
 *
 * `scripts/brain/extract-security-graph.mjs` at 6fb688aa, the last revision
 * before this change:
 *
 *     const norm = (x) => JSON.stringify({ graph: x.graph, join: x.join });
 *     if (norm(a) !== norm(artifact)) { ...exit 1... }
 *
 * Kept here so the counterfactual runs both arms in one process over one
 * fixture, rather than asking a reader to trust a transcript.
 */
const PARENT_NORM = (x) => JSON.stringify({ graph: x.graph, join: x.join });

/**
 * A minimal artifact shaped like the real one and satisfying the population
 * floor: two scan scopes whose counts reconcile with `filesScanned`, and a
 * non-empty graph.
 */
function baseArtifact() {
  return JSON.parse(
    JSON.stringify({
      graph: {
        source: 'extracted',
        nodes: [
          {
            id: 'sec:publication:scripts/ci/example.mjs#console:member:10',
            kind: 'publication-surface',
            provenance: 'declared',
            label: 'scripts/ci/example.mjs',
            facet: { kind: 'publication-surface', declaredSinkCount: 1, sinks: [] },
          },
        ],
        edges: [],
        annotations: { expectedPredicateClusterSize: {} },
      },
      join: { painted: [], unjoined: [] },
      meta: {
        generatorVersion: 7,
        generatedAt: '2026-08-27T00:00:00.000Z',
        commit: '0d2d28f5b2773b4d8bc95f4b65df9da0076b537e',
        inputsDigest: '0d3dccaf8dfc02fc',
        filesScanned: 2056,
        scanScopes: [
          { scope: 'app/**/route.ts (console BFF routes)', filesMatched: 1694, nodesEmitted: 706 },
          {
            scope: '.github/**, scripts/** (CI publication surfaces)',
            filesMatched: 362,
            nodesEmitted: 214,
          },
        ],
        skipped: [
          { subject: '.github/workflows/', reason: '118 file(s) were seen and NOT read by this extractor.' },
        ],
      },
    }),
  );
}

/**
 * THE COUNTERFACTUAL FIXTURE: the population moves, the graph does not.
 *
 * Exactly the delta `scripts/ci/__fixtures__/census-drift-probe.mjs` produces on
 * the real tree — one more `.mjs` inside the declared publication scope, and it
 * emits no node — measured as 362 -> 363 files matched, 2056 -> 2057 scanned,
 * 920 nodes / 174 edges unchanged.
 */
function censusDriftPair() {
  const committed = baseArtifact();
  const current = baseArtifact();
  current.meta.scanScopes[1].filesMatched = 363;
  current.meta.filesScanned = 2057;
  return { committed, current };
}

// ── THE COUNTERFACTUAL: BOTH ARMS, SAME FIXTURE ────────────────────────────

test('the fixture really is the #4128 shape — population moves, graph does not', () => {
  const { committed, current } = censusDriftPair();
  // Without this the two arms below would be measuring something else entirely.
  assert.deepEqual(committed.graph, current.graph, 'the graph must be identical across the pair');
  assert.deepEqual(committed.join, current.join, 'the join must be identical across the pair');
  assert.notEqual(
    committed.meta.scanScopes[1].filesMatched,
    current.meta.scanScopes[1].filesMatched,
    'the population must actually differ, or neither arm proves anything',
  );
});

test('PARENT arm: the pre-fix comparison sees NO drift on that pair (the blind spot is real)', () => {
  const { committed, current } = censusDriftPair();
  assert.equal(
    PARENT_NORM(committed),
    PARENT_NORM(current),
    'the pre-fix `{graph, join}` comparison should find these identical — if it does not, the ' +
      'premise of #4128 is wrong and this fix is unnecessary',
  );
});

test('TIP arm: the post-fix comparison DOES see drift on the same pair', () => {
  const { committed, current } = censusDriftPair();
  const differences = driftDifferences(committed, current);

  assert.ok(differences.length > 0, 'the post-fix comparison must report drift the parent missed');
  const paths = differences.map((d) => d.path);
  assert.ok(
    paths.some((p) => p.endsWith('filesMatched')),
    `expected a filesMatched difference, got: ${paths.join(', ')}`,
  );
  assert.ok(
    paths.includes('meta.filesScanned'),
    `expected meta.filesScanned — the field an enumeration fix would still have missed, got: ${paths.join(', ')}`,
  );
});

// ── ARRAYS OF IDENTIFIED THINGS ARE MATCHED BY ID (#4275) ──────────────────
//
// `graph.nodes` and `graph.edges` are ordered lists of objects with unique ids,
// and the reporter used to walk them by INDEX. So inserting one node at the
// front paired node 0 against node 1, node 1 against node 2, and so on: one
// added node reported as a wall of modified `id`/`kind`/`label`/… fields naming
// nodes nobody touched. With cap=20 that noise can crowd out the added node
// entirely, so the printed list points a triager at the wrong rows.
//
// Both arms again, one fixture: the pre-fix index pairing and the post-fix id
// pairing over the SAME pair.

/** A 5-node graph whose ids are stable and distinguishable. */
function fiveNodeArtifact() {
  const artifact = baseArtifact();
  artifact.graph.nodes = [1, 2, 3, 4, 5].map((i) => ({
    id: `sec:publication:scripts/ci/n${i}.mjs#console:member:${i}`,
    kind: 'publication-surface',
    provenance: 'declared',
    label: `scripts/ci/n${i}.mjs`,
    facet: { kind: 'publication-surface', declaredSinkCount: 1, sinks: [] },
  }));
  return artifact;
}

const ADDED_NODE_ID = 'sec:publication:scripts/ci/inserted.mjs#console:member:0';

/** The same 5 nodes, with one NEW node inserted at index 0. Nothing else moves. */
function insertedNodePair() {
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  current.graph.nodes.unshift({
    id: ADDED_NODE_ID,
    kind: 'publication-surface',
    provenance: 'declared',
    label: 'scripts/ci/inserted.mjs',
    facet: { kind: 'publication-surface', declaredSinkCount: 1, sinks: [] },
  });
  return { committed, current };
}

/**
 * THE PRE-FIX ARRAY WALK, in the shape `collect()` carried before this change:
 * `Math.min` of the two lengths, element i against element i, no id matching
 * anywhere. Reproduced here so the counterfactual runs in one process rather
 * than asking a reader to trust a transcript.
 */
function parentIndexDiff(a, b, path = '', out = [], cap = 20) {
  if (out.length >= cap || a === b) return out;
  const ka = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const kb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ka !== kb) {
    out.push({ path });
    return out;
  }
  if (ka === 'array') {
    if (a.length !== b.length) out.push({ path: `${path}.length` });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n && out.length < cap; i += 1) parentIndexDiff(a[i], b[i], `${path}[${i}]`, out, cap);
    return out;
  }
  if (ka === 'object') {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (out.length >= cap) return out;
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      const next = path === '' ? key : `${path}.${key}`;
      if (!inA || !inB) {
        out.push({ path: next });
        continue;
      }
      parentIndexDiff(a[key], b[key], next, out, cap);
    }
    return out;
  }
  out.push({ path });
  return out;
}

test('the fixture really is the #4275 shape — one node added, none of the others touched', () => {
  const { committed, current } = insertedNodePair();
  assert.equal(committed.graph.nodes.length, 5);
  assert.equal(current.graph.nodes.length, 6);
  const byId = new Map(current.graph.nodes.map((n) => [n.id, n]));
  for (const node of committed.graph.nodes) {
    assert.deepEqual(byId.get(node.id), node, `${node.id} must be byte-identical across the pair`);
  }
});

test('PARENT arm: the index walk reports the untouched nodes as modified', () => {
  const { committed, current } = insertedNodePair();
  const paths = parentIndexDiff(comparableArtifact(committed), comparableArtifact(current)).map((d) => d.path);

  const fieldNoise = paths.filter((p) => /^graph\.nodes\[\d+\]\./.test(p));
  assert.ok(
    fieldNoise.length >= 5,
    `the pre-fix walk should smear this insertion across untouched nodes — if it does not, the ` +
      `premise of #4275 is wrong. Got: ${paths.join(', ')}`,
  );
});

test('TIP arm: one inserted node is ONE difference naming that id, and no modified fields', () => {
  const { committed, current } = insertedNodePair();
  const differences = driftDifferences(committed, current);
  const paths = differences.map((d) => d.path);

  const nodeEntries = paths.filter((p) => p.startsWith('graph.nodes[id='));
  assert.deepEqual(
    nodeEntries,
    [`graph.nodes[id=${ADDED_NODE_ID}]`],
    `exactly one entry, naming the added id. Got: ${paths.join(', ')}`,
  );
  assert.equal(
    differences.find((d) => d.path === `graph.nodes[id=${ADDED_NODE_ID}]`).committed,
    '<absent>',
    'the added node must read as absent on the committed side, not as a modified one',
  );
  assert.deepEqual(
    paths.filter((p) => /\[id=.*\]\./.test(p)),
    [],
    `no field of a matched node changed, so none may be reported. Got: ${paths.join(', ')}`,
  );
  assert.deepEqual(
    paths.sort(),
    [`graph.nodes[id=${ADDED_NODE_ID}]`, 'graph.nodes.length'].sort(),
    `the population entry and the added id, and nothing else. Got: ${paths.join(', ')}`,
  );
});

test('an id-less array is still walked by index, so the fallback did not go missing', () => {
  // `meta.scanScopes` elements carry no `id`. Losing the index walk would make
  // this pair compare equal, which is the regression the id matching could cause.
  const committed = baseArtifact();
  const current = baseArtifact();
  current.meta.scanScopes[1].nodesEmitted += 1;

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path),
    ['meta.scanScopes[1].nodesEmitted'],
  );
});

test('duplicate ids fall back to the index walk rather than guessing a pairing', () => {
  // With a repeated id there is no single element the key names, so any pairing
  // would be a guess — and a guess printed as a difference is an R7 assertion
  // the comparator did not establish.
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  committed.graph.nodes[1].id = committed.graph.nodes[0].id;
  current.graph.nodes[1].id = current.graph.nodes[0].id;
  current.graph.nodes[3].label = 'scripts/ci/renamed.mjs';

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path),
    ['graph.nodes[3].label'],
  );
});

// ── THE ANTI-ENUMERATION ARM ───────────────────────────────────────────────

test('a meta field invented later is compared without being named anywhere', () => {
  const { committed, current } = censusDriftPair();
  const invented = 'aFieldNoExtractorHasEmittedYet';
  current.meta[invented] = 'some value';
  // Reset the population delta so this arm is measuring the invented field alone.
  current.meta.scanScopes[1].filesMatched = committed.meta.scanScopes[1].filesMatched;
  current.meta.filesScanned = committed.meta.filesScanned;

  const paths = driftDifferences(committed, current).map((d) => d.path);
  assert.ok(
    paths.includes(`meta.${invented}`),
    `a field absent from the committed artifact must be reported, got: ${paths.join(', ')}`,
  );

  // THE TEETH. If the comparison were keyed to a list of watched names, the only
  // way the assertion above could pass is if this name were ON that list.
  const source = readFileSync(DRIFT_MODULE, 'utf8');
  assert.ok(
    !source.includes(invented),
    'the comparison must catch this by SHAPE, not because the field was enumerated',
  );
});

test('the volatile exemption set may never swallow a field this gate exists to watch', () => {
  assert.ok(POPULATION_META_FIELDS.length > 0, 'the protected list must not be empty');
  for (const field of POPULATION_META_FIELDS) {
    assert.ok(
      !VOLATILE_NAMES.includes(field),
      `'${field}' is what this gate watches — exempting it would silence the red rather than fix it`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(baseArtifact().meta, field),
      `'${field}' is not a field the artifact carries, so protecting it protects nothing`,
    );
  }
});

test('every exemption carries a stated reason', () => {
  assert.ok(VOLATILE_META_FIELDS.length > 0, 'an empty exemption set would make this vacuous');
  for (const { field, reason } of VOLATILE_META_FIELDS) {
    assert.ok(typeof field === 'string' && field.length > 0);
    assert.ok(
      typeof reason === 'string' && reason.length > 60,
      `'${field}' is exempt without a substantive reason, which is how a blind spot gets added back`,
    );
  }
});

test('the volatile fields are ignored, so the gate does not cry wolf', () => {
  const committed = baseArtifact();
  const current = baseArtifact();
  current.meta.generatedAt = '2026-12-31T23:59:59.000Z';
  current.meta.commit = 'f'.repeat(40);
  current.meta.inputsDigest = 'ffffffffffffffff';

  assert.deepEqual(
    driftDifferences(committed, current),
    [],
    'a run-to-run difference in the exempt fields alone must not be reported as drift',
  );
  // Control: the same pair with a real change IS reported, so the assertion
  // above is not passing because the comparator reports nothing at all.
  current.meta.scanScopes[0].filesMatched += 1;
  assert.ok(driftDifferences(committed, current).length > 0);
});

test('comparableArtifact does not mutate its argument', () => {
  // `--check` prints counts off the live artifact AFTER comparing; a helper that
  // hollowed out its input would make those printed counts a lie (R7).
  const artifact = baseArtifact();
  comparableArtifact(artifact);
  assert.equal(artifact.meta.inputsDigest, '0d3dccaf8dfc02fc');
  assert.equal(artifact.meta.generatedAt, '2026-08-27T00:00:00.000Z');
});

// ── THE POPULATION FLOOR ───────────────────────────────────────────────────

/**
 * Degenerate populations, each of which a comparison alone would certify.
 *
 * Kept as a table so the suite can assert its own size — a floor suite that has
 * been emptied passes every assertion it still contains, which is the exact
 * shape this floor exists to refuse.
 */
const FLOOR_CASES = [
  {
    name: 'zero scan scopes',
    mutate: (a) => {
      a.meta.scanScopes = [];
    },
  },
  {
    name: 'a declared scope that matched no file',
    mutate: (a) => {
      a.meta.scanScopes[1].filesMatched = 0;
    },
  },
  {
    name: 'a zero-node graph',
    mutate: (a) => {
      a.graph.nodes = [];
    },
  },
  {
    name: 'zero files scanned',
    mutate: (a) => {
      a.meta.filesScanned = 0;
    },
  },
  {
    name: 'scan scopes that do not reconcile with filesScanned',
    mutate: (a) => {
      a.meta.filesScanned = 9999;
    },
  },
  {
    name: 'no meta at all',
    mutate: (a) => {
      delete a.meta;
    },
  },
  {
    name: 'a filesMatched that is not a number',
    mutate: (a) => {
      a.meta.scanScopes[0].filesMatched = null;
    },
  },
];

test('the floor case table is populated (an empty suite passes vacuously)', () => {
  assert.ok(
    FLOOR_CASES.length >= 5,
    `expected the degenerate-population cases to still be present, found ${FLOOR_CASES.length}`,
  );
});

test('a healthy artifact clears the floor (control — a floor that refuses everything is useless)', () => {
  assert.deepEqual(populationRefusals(baseArtifact(), 'fixture'), []);
});

for (const { name, mutate } of FLOOR_CASES) {
  test(`the floor refuses: ${name}`, () => {
    const artifact = baseArtifact();
    mutate(artifact);
    const refusals = populationRefusals(artifact, 'fixture');
    assert.ok(refusals.length > 0, `'${name}' must be refused, not certified`);
    for (const r of refusals) assert.ok(r.startsWith('fixture:'), 'each refusal names its side');
  });
}

test('a null or non-object artifact is refused rather than compared', () => {
  for (const value of [null, 'a string', 42, []]) {
    assert.ok(populationRefusals(value, 'fixture').length > 0, `${JSON.stringify(value)} must be refused`);
  }
});

test('TWO empty populations compare EQUAL — which is why the floor runs first', () => {
  // The vacuous pass, made explicit. Without the floor, `--check` would print OK
  // over an artifact and a tree that both measured nothing.
  const committed = baseArtifact();
  const current = baseArtifact();
  for (const a of [committed, current]) {
    a.graph.nodes = [];
    a.meta.scanScopes = [];
    a.meta.filesScanned = 0;
  }

  assert.deepEqual(driftDifferences(committed, current), [], 'two empty populations do compare equal');
  assert.ok(populationRefusals(committed, 'committed').length > 0, 'and the floor is what refuses them');
  assert.ok(populationRefusals(current, 'current').length > 0);
});

// ── THE REAL FIXTURE AND THE REAL ARTIFACT ─────────────────────────────────

test('the census-drift fixture exists and emits NO node, so the counterfactual holds', () => {
  assert.ok(existsSync(FIXTURE), 'the fixture the parent/tip counterfactual was measured on is gone');

  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  const fromFixture = artifact.graph.nodes.filter((n) => String(n.id).includes('census-drift-probe'));
  assert.deepEqual(
    fromFixture.map((n) => n.id),
    [],
    'the fixture emitted a node, so it no longer moves the population WITHOUT moving the graph — ' +
      'the counterfactual it anchors is void until it is inert again',
  );
});

test('the COMMITTED artifact clears the population floor', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  assert.deepEqual(populationRefusals(artifact, 'the committed artifact'), []);
});

// ── THE SCAN ENUMERATION: A GITIGNORED FILE IS NOT A SOURCE FILE (#4216) ───
//
// The extractor used to enumerate its scan roots with a bare `readdirSync`
// recursion, so it read whatever sat on disk. Measured on this repo on
// 2026-09-06: with one `.gitignore`d `.yml` planted under `scripts/`,
// `git status --porcelain` printed ZERO lines while `--check` exited 1 —
// `meta.skipped[].fileCount` 187 -> 188, and `*.yml` appended to that scope's
// extension list. The gate was unsatisfiable in both directions: regenerating
// locally baked the ignored file in, and CI (which never sees it) re-derived
// something else.
//
// Both arms run over ONE throwaway repository in one process, for the same
// reason PARENT_NORM exists above: a fix to an enumeration is indistinguishable
// from no fix unless the pre-fix enumeration is shown to disagree with it.

/** The PRE-FIX walk, copied in shape from the parent: no ignore filter at all. */
function parentWalk(dir, repoRoot, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
      parentWalk(full, repoRoot, out);
      continue;
    }
    out.push(relative(repoRoot, full).split(sep).join('/'));
  }
  return out;
}

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'loom-sg-ignore-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'scripts', 'generated'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'scripts/generated/\n', 'utf8');
  writeFileSync(join(repo, 'scripts', 'tracked.mjs'), 'console.log(1);\n', 'utf8');
  writeFileSync(join(repo, 'scripts', 'not-yet-added.mjs'), 'console.log(2);\n', 'utf8');
  writeFileSync(join(repo, 'scripts', 'generated', 'ignored.mjs'), 'console.log(3);\n', 'utf8');
  execFileSync('git', ['add', '.gitignore', 'scripts/tracked.mjs'], { cwd: repo });
  return repo;
}

test('the scan enumeration DROPS a gitignored file and KEEPS an unadded one (#4216)', async () => {
  // Imported for the enumeration helpers only. The module announces on stderr
  // that it extracted nothing, so this import cannot be mistaken for a run.
  process.env.LOOM_SECURITY_EXTRACT_IMPORT_ONLY = '1';
  const { gitVisibleFiles, scanFiles } = await import('../../brain/extract-security-graph.mjs');

  const repo = fixtureRepo();
  try {
    const visible = gitVisibleFiles(['scripts'], repo);
    const tip = scanFiles(repo, 'scripts', (rel) => rel.endsWith('.mjs'), visible)
      .map((f) => relative(repo, f).split(sep).join('/'))
      .sort();

    // TIP ARM. The ignored file is gone; the written-but-not-`git add`ed file
    // stays, because it IS part of the change under review — a new publication
    // surface must not be able to arrive and be certified in the same commit.
    assert.deepEqual(tip, ['scripts/not-yet-added.mjs', 'scripts/tracked.mjs']);

    // PARENT ARM, same fixture: the unfiltered walk read all three.
    const parent = parentWalk(join(repo, 'scripts'), repo).filter((r) => r.endsWith('.mjs')).sort();
    assert.deepEqual(parent, [
      'scripts/generated/ignored.mjs',
      'scripts/not-yet-added.mjs',
      'scripts/tracked.mjs',
    ]);
    assert.ok(
      parent.includes('scripts/generated/ignored.mjs') && !tip.includes('scripts/generated/ignored.mjs'),
      'the ignore filter is what changed the answer, not the fixture',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── THE RENAME CASE, ON A REQUIRED LANE (#4282) ────────────────────────────
//
// `security-graph.json` is guarded twice and until now NEITHER guard was both
// REQUIRED and name-aware:
//
//   - `extract-security-graph.mjs --check` re-derives the artifact and compares
//     it, so it sees a rename. It runs in the job `brain security graph —
//     committed artifact matches the tree`, which is ADVISORY. Measured
//     2026-09-08: `gh api repos/fgarofalo56/csa-inabox/branches/main/protection`
//     lists 15 required contexts and that job is not among them.
//   - the census in `apps/fiab-console/lib/brain/security/extract/__tests__/
//     no-estate-identifiers.test.ts` runs on `vitest (node 20)`, which IS
//     required — but it compared three INTEGERS. Every one of them is invariant
//     under a rename: move `app/api/foo/route.ts` to `app/api/bar/route.ts` and
//     `filesMatched`, `filesScanned` and the recomputed census all hold. The
//     artifact then merges naming a path the tree no longer carries, green.
//
// THIS suite runs on `guardrails` — a required context — via
// `node --test scripts/ci/__tests__/*.test.mjs` in loom-guardrails.yml, with no
// install of any kind. So the check lands here as well as in the vitest census:
// two required lanes, two independent enumerations (git below, `readdirSync`
// there), which is the only way agreement between them means anything.
//
// WHAT THIS DOES **NOT** ESTABLISH. `--check` re-derives everything; this
// compares NAMES only. It cannot tell you the artifact is current — a content
// edit that moves the graph is invisible to it. Promoting the advisory job to
// required is still the right end state and is left recorded on #4282, not
// claimed here.
//
// The comparison is on the canonical path form node ids embed
// (`extract/source-facts.ts#canonicalRepoPath`), which LOWERCASES: measured, 7
// named paths differ from their on-disk spelling only by the case of a bracketed
// dynamic segment (`[promptId]` -> `[promptid]`). A rename that changes letter
// case alone is therefore NOT caught. Every other rename, move or deletion is.

/** The scan roots `extract-security-graph.mjs#main()` walks. */
const SCAN_ROOTS = ['apps/fiab-console/app', 'scripts', '.github'];

/** `canonicalRepoPath` from `extract/source-facts.ts` — the form node ids embed. */
function canonicalRepoPath(p) {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/** The source path a node id embeds, per `extract/join.ts#pathOfNodeId`. */
function pathOfNodeId(nodeId) {
  const firstColon = nodeId.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = nodeId.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const hash = nodeId.lastIndexOf('#');
  const path = nodeId.slice(secondColon + 1, hash < 0 ? undefined : hash);
  return path.length > 0 ? path : null;
}

/**
 * Every path git carries under the scan roots, INTERSECTED with the worktree.
 *
 * `git ls-files --cached --others --exclude-standard` is the extractor's own
 * enumeration (`gitVisibleFiles`), so a gitignored file cannot satisfy this
 * check while being invisible to the generator — that divergence is #4216.
 *
 * The worktree intersection is what makes a rename visible at all: `--cached`
 * still lists a path deleted from disk, so without it a `mv` that has not been
 * `git add`ed reads as present and this check passes over the exact change it
 * exists to catch. `scanFiles` intersects for the same reason.
 *
 * No fallback. Without git this cannot establish what the tree contains, and
 * guessing would reintroduce #4216, so the `execFileSync` throw stands.
 */
function gitVisiblePaths() {
  const raw = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCAN_ROOTS],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return new Set(
    raw
      .split('\0')
      .filter(Boolean)
      .filter((rel) => existsSync(resolve(REPO_ROOT, rel)))
      .map(canonicalRepoPath),
  );
}

/** A `meta.skipped` subject naming one file rather than a pattern or a rule. */
const fileShaped = (subject) => /^[^\s()]+\.(?:tsx?|mjs|cjs|js)$/.test(subject);

/** Every source path the committed artifact NAMES, in node ids and in the ledger. */
function namedPaths() {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  return [
    ...new Set([
      ...artifact.graph.nodes
        .map((n) => pathOfNodeId(String(n.id)))
        .filter((p) => p !== null)
        .map(canonicalRepoPath),
      ...artifact.meta.skipped
        .map((s) => String(s.subject))
        .filter(fileShaped)
        .map(canonicalRepoPath),
    ]),
  ];
}

test('the artifact and the census are both real populations (floor)', () => {
  // Two empty sets compare equal. A pass because BOTH sides measured nothing is
  // the shape the guards-that-do-not-watch index exists to name, so the floor is
  // asserted on both sides before anything is compared.
  const named = namedPaths();
  assert.ok(named.length > 300, `the artifact names only ${named.length} path(s)`);
  const onDisk = gitVisiblePaths();
  assert.ok(onDisk.size > named.length, `git listed only ${onDisk.size} file(s) under ${SCAN_ROOTS}`);
});

test('every source path the committed artifact NAMES is still a file in the tree', () => {
  const onDisk = gitVisiblePaths();
  assert.deepEqual(
    namedPaths().filter((p) => !onDisk.has(p)),
    [],
    'the committed security graph names path(s) the tree no longer carries, so it was generated ' +
      'against a different tree. Run: node scripts/brain/extract-security-graph.mjs',
  );
});

test('control: a path the tree does not carry IS reported missing', () => {
  // Proves the assertion above watches the NAMES rather than passing because the
  // census over-collected — a walk that returned everything, or a canonicaliser
  // that mapped every input onto a member of the set, would pass it in silence.
  // Measured RELATIVE to the current baseline so this control still means
  // something on a tree that is genuinely drifted.
  const onDisk = gitVisiblePaths();
  const named = namedPaths();
  const baseline = named.filter((p) => !onDisk.has(p)).length;
  const injected = canonicalRepoPath('apps/fiab-console/app/api/__renamed__/route.ts');
  assert.ok(!onDisk.has(injected), 'the injected path must genuinely be absent for this to prove anything');
  assert.equal([...named, injected].filter((p) => !onDisk.has(p)).length, baseline + 1);
});

test('the scan roots this suite watches are the roots the extractor walks', () => {
  // `ROUTE_ROOT` and `PUBLICATION_ROOTS` are `const`s local to that module's
  // `main()`, so there is nothing to import and SCAN_ROOTS is a duplicate. The
  // duplicate is checked against the extractor's SOURCE rather than assumed: a
  // root added there and not here would make this suite silently narrower.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8');
  const declared = /const PUBLICATION_ROOTS = \[([^\]]*)\]/.exec(source);
  assert.ok(declared, 'PUBLICATION_ROOTS is no longer declared in the shape this check reads');
  const upstream = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(upstream.length > 0, 'PUBLICATION_ROOTS parsed to nothing, so this control is vacuous');
  assert.deepEqual(
    upstream.filter((r) => !SCAN_ROOTS.includes(r)),
    [],
    'the extractor walks a publication root this suite does not, so its census is narrower than ' +
      'the artifact it checks',
  );

  const routeRoot = /const ROUTE_ROOT = '([^']+)'/.exec(source);
  assert.ok(routeRoot, 'ROUTE_ROOT is no longer declared in the shape this check reads');
  assert.ok(SCAN_ROOTS.includes(routeRoot[1]), `the extractor walks '${routeRoot[1]}' and this suite does not`);
});

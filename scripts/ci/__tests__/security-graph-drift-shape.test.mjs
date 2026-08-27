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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

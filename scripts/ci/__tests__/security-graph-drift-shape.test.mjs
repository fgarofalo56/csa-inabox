/**
 * THE DRIFT GATE'S COMPARISON — WHAT IT COMPARES, WHAT IT REFUSES, AND THE
 * CENSUS THAT MOVED WITH THE COUNTS (#4128, #4275, #4798).
 *
 * `scripts/brain/extract-security-graph.mjs --check` is the job named
 * `brain security graph — committed artifact matches the tree`.
 *
 * ── #4798: THE COUNTS ARE NO LONGER COMMITTED ────────────────────────────
 *
 * #4128 made this gate compare `meta.scanScopes[].filesMatched` and
 * `meta.filesScanned`, so a zero-node file inside a scanned scope reddened it.
 * #4798 reverses that on purpose: those tallies moved with every file added
 * under a scanned root, so every open PR that touched the artifact conflicted
 * with every other after each merge, and two PRs that each moved a tally by one
 * merged cleanly to a wrong value. They are now RUN values
 * (`build.ts#buildSecurityGraphExtraction` returns them apart from the
 * artifact), `--check` REFUSES them if they reappear in the committed bytes
 * (`runOnlyFieldsPresent`, pinned below), and the census they were a proxy for
 * is taken here, against the generator's own enumeration, at the bottom of this
 * file. The merge property itself is measured in
 * `apps/fiab-console/lib/brain/security/extract/__tests__/merge-stability.test.ts`.
 *
 * ── AND THE ARM THAT KEEPS THE COMPARISON WHOLE ──────────────────────────
 *
 * A guard keyed to an ENUMERATION of watched names is defeated by the next name.
 * So the comparison covers everything, with no exemption at all since #4798, and
 * `a meta field invented later is compared without being named anywhere` asserts
 * exactly that, by inventing one.
 *
 * ── AND THE ARM THAT EXISTS BECAUSE A FIX WENT WRONG (#4275, review round 2) ─
 *
 * The first revision of the array matching walked the union of ids and RETURNED,
 * so order stopped being compared. `--check` then printed "OK — committed
 * artifact matches the tree" over an artifact with two nodes swapped: a false
 * green in the only lane that reads graph content, and an R7 violation in the
 * shipped sentence. `the keyed walk NEVER reports equal on unequal bytes` is the
 * general form of the arm that catches it — a table of twelve byte-changing
 * mutations, each of which must be reported.
 *
 * The same revision also made the report WORSE on the case #4275 actually
 * measured (sink ordinals renumbering: every key changes, so pure key matching
 * turns each sink into an absent/present pair costing two cap slots). `when the
 * KEYS move, the report does not get worse than the index walk` pins that.
 *
 * Both arms are mutation-proved: deleting the order comparison reds the first
 * three, disabling the leftover zip reds the fourth, and each of the two key
 * refusals has its own mutation. Measured 2026-09-08, `temp/mutate.sh`.
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
  CENSUS_SCOPES,
  RUN_ONLY_FIELDS,
  POPULATION_META_FIELDS,
  censusRefusals,
  driftDifferences,
  gitCensus as checkCensus,
  populationRefusals,
  runOnlyFieldsPresent,
} from '../../brain/_artifact-drift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DRIFT_MODULE = resolve(HERE, '..', '..', 'brain', '_artifact-drift.mjs');
const FIXTURE = resolve(HERE, '..', '__fixtures__', 'census-drift-probe.mjs');
const ARTIFACT = resolve(
  REPO_ROOT,
  'apps/fiab-console/lib/brain/security/extract/__generated__/security-graph.json',
);

const RUN_ONLY_META_NAMES = RUN_ONLY_FIELDS.filter((f) => f.where === 'meta').map((f) => f.field);

/**
 * A minimal artifact in the COMMITTED shape: a non-empty graph, a
 * `join.painted` row for the node, and two named scan scopes with no counts.
 *
 * The join row is not decoration. A first revision of this suite shipped
 * `join: { painted: [], unjoined: [] }`, and an empty array is never keyed — so
 * every assertion below about the reporter's array handling was a property of
 * THAT emptiness rather than of the code, and the same input against the real
 * artifact (707 painted rows, keyed `nodeId`, not `id`) behaved completely
 * differently. The fixture carries the real shape for that reason.
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
      join: {
        painted: [
          {
            nodeId: 'sec:publication:scripts/ci/example.mjs#console:member:10',
            codeModuleId: 'code:scripts/ci/example.mjs',
            deployedAs: 'loom-console',
          },
        ],
        unjoined: [],
      },
      meta: {
        generatorVersion: 7,
        scanScopes: [
          { scope: 'app/**/route.ts (console BFF routes)' },
          { scope: '.github/**, scripts/** (CI publication surfaces)' },
        ],
        skipped: [
          { subject: '.github/** (*.yml)', reason: 'Files under a SCANNED root were seen and NOT read.' },
        ],
      },
    }),
  );
}

/** The run that produced {@link baseArtifact}: counts that reconcile. */
function baseRun() {
  return {
    generatedAt: '2026-08-27T00:00:00.000Z',
    commit: '0d2d28f5b2773b4d8bc95f4b65df9da0076b537e',
    inputsDigest: '0d3dccaf8dfc02fc',
    filesScanned: 2056,
    scanScopes: [
      { scope: 'app/**/route.ts (console BFF routes)', filesMatched: 1694, nodesEmitted: 706 },
      { scope: '.github/**, scripts/** (CI publication surfaces)', filesMatched: 362, nodesEmitted: 214 },
    ],
    unmodeledPublicationSurfaces: [],
    nonSpawnSinks: 0,
  };
}

// ── #4798: A RUN-ONLY FIELD IN THE COMMITTED BYTES IS REFUSED ──────────────

test('a committed-shape artifact carries no run-only field (control)', () => {
  // Without this the arms below could pass on a detector that reports
  // everything.
  assert.deepEqual(runOnlyFieldsPresent(baseArtifact()), []);
});

test('EVERY run-only field is reported at its exact path when it reappears', () => {
  // The input that breaks this: dropping a row from RUN_ONLY_FIELDS, or a
  // `runOnlyFieldsPresent` that stops walking `meta.scanScopes[]`.
  assert.ok(RUN_ONLY_FIELDS.length >= 6, `the run-only table shrank to ${RUN_ONLY_FIELDS.length}`);
  for (const { where, field } of RUN_ONLY_FIELDS) {
    const artifact = baseArtifact();
    let expected;
    if (where === 'meta') {
      artifact.meta[field] = 'x';
      expected = `meta.${field}`;
    } else {
      artifact.meta.scanScopes[1][field] = 1;
      expected = `meta.scanScopes[1].${field}`;
    }
    assert.deepEqual(runOnlyFieldsPresent(artifact), [expected], `${where}.${field}`);
  }
});

test('the pre-#4798 committed meta is refused on all eight of its run-only paths', () => {
  const legacy = baseArtifact();
  const run = baseRun();
  Object.assign(legacy.meta, {
    generatedAt: run.generatedAt,
    commit: run.commit,
    inputsDigest: run.inputsDigest,
    filesScanned: run.filesScanned,
    scanScopes: run.scanScopes,
  });
  assert.deepEqual(
    runOnlyFieldsPresent(legacy).sort(),
    [
      'meta.commit',
      'meta.filesScanned',
      'meta.generatedAt',
      'meta.inputsDigest',
      'meta.scanScopes[0].filesMatched',
      'meta.scanScopes[0].nodesEmitted',
      'meta.scanScopes[1].filesMatched',
      'meta.scanScopes[1].nodesEmitted',
    ],
  );
});

test('the extractor REFUSES a committed run-only field before comparing (the call site, not only the helper)', () => {
  // A helper that works but is never called is the gap this pins. The input
  // that breaks it: deleting the `runOnlyFieldsPresent(a)` refusal from
  // `main()`. Read from source because running the CLI needs a compiled tsc,
  // and this lane installs nothing — a STRUCTURAL pin, weaker than a run, and
  // disclosed as such. Comment lines are stripped first so a comment naming the
  // call cannot satisfy it.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  const call = source.indexOf('runOnlyFieldsPresent(a)');
  const compare = source.indexOf('driftDifferences(a, artifact');
  assert.ok(call > 0, 'the --check path no longer calls runOnlyFieldsPresent on the committed artifact');
  assert.ok(compare > call, 'the run-only refusal must run BEFORE the comparison');
  assert.match(source.slice(call, compare), /process\.exit\(1\)/, 'the refusal must exit non-zero');
});

// ── ARRAYS OF IDENTIFIED THINGS ARE MATCHED BY KEY (#4275) ─────────────────
//
// `graph.nodes`, `graph.edges`, `facet.sinks`, `facet.allowPaths` and
// `join.painted` are ordered lists of objects with a per-element identity, and
// the reporter used to walk them by INDEX. So inserting one node at the front
// paired node 0 against node 1, node 1 against node 2, and so on: one added node
// reported as a wall of modified `id`/`kind`/`label`/… fields naming rows nobody
// touched. With cap=20 that noise crowds out the added node, so the printed list
// points a triager at the wrong rows.
//
// Three arms, because a keyed walk can go wrong in three separate directions and
// the first revision of this change went wrong in two of them:
//
//   1. the insertion case must shrink to the added element  (the point of #4275)
//   2. REORDER must still be reported. A keyed walk that ignores position calls
//      two byte-different artifacts equal, and the message says "matches the
//      tree" — a false green worse than the noise it replaced.
//   3. the case where the KEYS themselves moved must not get worse. That is the
//      exact output #4275 measured (sink ordinals renumbering), and pure key
//      matching turns each changed element into an absent/present PAIR.
//
// Each arm runs against the pre-fix index walk over the SAME fixture.

/**
 * Five nodes over FOUR modules, with the `join.painted` row each one carries in
 * the real artifact, and populated `facet.sinks`.
 *
 * Every detail here is load-bearing and none of it is decoration:
 *
 *   - two nodes share a module (an authorizer and a verdict-call on the same
 *     route — literally `join.painted[0]` and `[1]` of the committed artifact),
 *     so `codeModuleId` is NOT unique and `nodeId` is the single candidate key.
 *     With one node per module both are unique, the reporter refuses to key on
 *     either, and every join assertion below silently measures the index walk.
 *   - `facet.sinks` is populated, because the #4275 case lives there (2,403 sink
 *     ids across 229 arrays in the committed artifact) and `sinks: []` cannot
 *     reach that path at all.
 */
function fiveNodeArtifact() {
  const artifact = baseArtifact();
  const rows = [
    { kind: 'authorizer', module: 'scripts/ci/n1.mjs' },
    { kind: 'verdict-call', module: 'scripts/ci/n1.mjs' },
    { kind: 'authorizer', module: 'scripts/ci/n2.mjs' },
    { kind: 'authorizer', module: 'scripts/ci/n3.mjs' },
    { kind: 'authorizer', module: 'scripts/ci/n4.mjs' },
  ];
  artifact.graph.nodes = rows.map(({ kind, module }, i) => ({
    id: `sec:${kind}:${module}#module`,
    kind,
    provenance: 'declared',
    label: module,
    facet: {
      kind,
      declaredSinkCount: 2,
      sinks: [
        { id: `console:member:${(i + 1) * 100}`, surface: 'console', accessPath: 'member' },
        { id: `console:member:${(i + 1) * 100 + 4}`, surface: 'console', accessPath: 'member' },
      ],
    },
  }));
  artifact.join.painted = rows.map(({ kind, module }) => ({
    nodeId: `sec:${kind}:${module}#module`,
    codeModuleId: `code:${module}`,
    deployedAs: 'loom-console',
  }));
  return artifact;
}

const ADDED_NODE_ID = 'sec:authorizer:scripts/ci/inserted.mjs#module';

/**
 * The same 5 nodes with one NEW node inserted at index 0 — and its `join.painted`
 * row inserted alongside, which is what the extractor actually emits for a new
 * surface. Nothing else moves.
 */
function insertedNodePair() {
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  current.graph.nodes.unshift({
    id: ADDED_NODE_ID,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'scripts/ci/inserted.mjs',
    facet: {
      kind: 'authorizer',
      declaredSinkCount: 2,
      sinks: [
        { id: 'console:member:10', surface: 'console', accessPath: 'member' },
        { id: 'console:member:14', surface: 'console', accessPath: 'member' },
      ],
    },
  });
  current.join.painted.unshift({
    nodeId: ADDED_NODE_ID,
    codeModuleId: 'code:scripts/ci/inserted.mjs',
    deployedAs: 'loom-console',
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
  assert.equal(committed.join.painted.length, 5);
  assert.equal(current.join.painted.length, 6);
  const byId = new Map(current.graph.nodes.map((n) => [n.id, n]));
  for (const node of committed.graph.nodes) {
    assert.deepEqual(byId.get(node.id), node, `${node.id} must be byte-identical across the pair`);
  }
  const byNodeId = new Map(current.join.painted.map((r) => [r.nodeId, r]));
  for (const row of committed.join.painted) {
    assert.deepEqual(byNodeId.get(row.nodeId), row, `${row.nodeId}'s join row must be byte-identical`);
  }

  // THE TEETH ON THE FIXTURE ITSELF. The TIP arm below is only a statement about
  // the reporter if `join.painted` is keyed the way the real one is — one
  // candidate key, `nodeId`. Give every row its own module and `codeModuleId`
  // becomes unique too, the reporter refuses to key (two candidates, no basis to
  // choose), and the arm silently measures the index walk instead. Asserted
  // against the committed artifact's own property, not against a hope.
  for (const artifact of [committed, current]) {
    const modules = artifact.join.painted.map((r) => r.codeModuleId);
    assert.ok(
      new Set(modules).size < modules.length,
      'the fixture must carry two nodes on one module, as the real artifact does — otherwise ' +
        'codeModuleId is unique, the key is ambiguous, and this arm proves nothing about join.painted',
    );
  }
  const real = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  const realModules = real.join.painted.map((r) => r.codeModuleId);
  assert.ok(
    new Set(realModules).size < realModules.length,
    `the committed artifact's join.painted has ${new Set(realModules).size} distinct codeModuleId ` +
      `over ${realModules.length} row(s); if that ever becomes 1:1 this fixture stops matching it`,
  );
});

test('PARENT arm: the index walk reports the untouched nodes and join rows as modified', () => {
  const { committed, current } = insertedNodePair();
  const a = committed;
  const b = current;
  const paths = parentIndexDiff(a, b).map((d) => d.path);

  const fieldNoise = paths.filter((p) => /^graph\.nodes\[\d+\]\./.test(p));
  assert.ok(
    fieldNoise.length >= 5,
    `the pre-fix walk should smear this insertion across untouched nodes — if it does not, the ` +
      `premise of #4275 is wrong. Got: ${paths.join(', ')}`,
  );
  // At the production cap of 20 the node noise fills the list on its own, so
  // nothing under `join` is even reached — the cap-exhaustion half of #4275,
  // shown rather than asserted about.
  assert.equal(paths.length, 20, 'the pre-fix walk should exhaust the cap on this one insertion');
  assert.deepEqual(paths.filter((p) => p.startsWith('join.')), []);

  // Lifting the cap shows the join noise the cap was hiding.
  const uncapped = parentIndexDiff(a, b, '', [], 500).map((d) => d.path);
  assert.ok(
    uncapped.filter((p) => /^join\.painted\[\d+\]\./.test(p)).length >= 5,
    `the pre-fix walk should smear it across untouched join rows too. Got: ${uncapped.join(', ')}`,
  );
});

test('TIP arm: one inserted node is the added node and its join row, and nothing else', () => {
  const { committed, current } = insertedNodePair();
  const differences = driftDifferences(committed, current);
  const paths = differences.map((d) => d.path);

  assert.deepEqual(
    [...paths].sort(),
    [
      `graph.nodes[id=${ADDED_NODE_ID}]`,
      'graph.nodes.length',
      `join.painted[nodeId=${ADDED_NODE_ID}]`,
      'join.painted.length',
    ].sort(),
    `the two population entries and the two added rows, and nothing else. Got: ${paths.join(', ')}`,
  );
  assert.equal(
    differences.find((d) => d.path === `graph.nodes[id=${ADDED_NODE_ID}]`).committed,
    '<absent>',
    'the added node must read as absent on the committed side, not as a modified one',
  );
  assert.deepEqual(
    paths.filter((p) => /\[(?:id|nodeId)=.*\]\./.test(p)),
    [],
    `no field of a matched element changed, so none may be reported. Got: ${paths.join(', ')}`,
  );
});

/**
 * THE BROKEN INTERMEDIATE REVISION, in the shape it carried: match by id, walk
 * the union of ids, return. No order comparison anywhere.
 *
 * Copied here for the same reason {@link PARENT_NORM} is: an arm asserting that
 * reordering IS reported proves nothing on its own — a comparator that reports
 * everything would pass it. This shows the pairing that does NOT report it, over
 * the same fixture, in the same process.
 */
function keyedWithoutOrder(a, b, path = '', out = []) {
  if (a === b) return out;
  const ka = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const kb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ka !== kb) {
    out.push({ path });
    return out;
  }
  if (ka === 'array') {
    if (a.length !== b.length) out.push({ path: `${path}.length` });
    const idMap = (arr) => {
      if (arr.length === 0) return null;
      const m = new Map();
      for (const el of arr) {
        if (el === null || typeof el !== 'object' || Array.isArray(el)) return null;
        if (typeof el.id !== 'string' || el.id === '' || m.has(el.id)) return null;
        m.set(el.id, el);
      }
      return m;
    };
    const mapA = idMap(a);
    const mapB = idMap(b);
    if (mapA !== null && mapB !== null) {
      for (const id of new Set([...mapA.keys(), ...mapB.keys()])) {
        if (!mapA.has(id) || !mapB.has(id)) {
          out.push({ path: `${path}[id=${id}]` });
          continue;
        }
        keyedWithoutOrder(mapA.get(id), mapB.get(id), `${path}[id=${id}]`, out);
      }
      return out;
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) keyedWithoutOrder(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (ka === 'object') {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const next = path === '' ? key : `${path}.${key}`;
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (!inA || !inB) {
        out.push({ path: next });
        continue;
      }
      keyedWithoutOrder(a[key], b[key], next, out);
    }
    return out;
  }
  out.push({ path });
  return out;
}

test('REORDER is reported — a keyed walk that ignored position would call these equal', () => {
  // THE FALSE GREEN THIS ARM EXISTS FOR. An intermediate revision of this change
  // matched by id and returned, so an artifact whose elements were merely swapped
  // compared EQUAL and `--check` printed "OK — committed artifact matches the
  // tree" over bytes that differ. Measured on the real committed artifact with
  // graph.nodes[0]/[1] swapped and one facet.sinks array reversed: 0 differences
  // reported, RC=0.
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  const [first, second] = [current.graph.nodes[0], current.graph.nodes[1]];
  current.graph.nodes[0] = second;
  current.graph.nodes[1] = first;
  current.graph.nodes[2].facet.sinks.reverse();

  // The premise: the bytes genuinely differ, and nothing was added or removed on
  // either side — only the ORDER of two arrays moved.
  assert.notEqual(JSON.stringify(committed), JSON.stringify(current));
  const nodeIds = (a) => a.graph.nodes.map((n) => n.id).sort();
  const sinkIds = (a, i) => a.graph.nodes[i].facet.sinks.map((s) => s.id).sort();
  assert.deepEqual(nodeIds(current), nodeIds(committed), 'no node may be added or removed');
  assert.deepEqual(
    sinkIds(current, 2).concat(sinkIds(current, 0), sinkIds(current, 1)).sort(),
    sinkIds(committed, 2).concat(sinkIds(committed, 0), sinkIds(committed, 1)).sort(),
    'no sink may be added or removed',
  );

  // BROKEN ARM: the pairing without an order comparison finds nothing at all.
  assert.deepEqual(
    keyedWithoutOrder(committed, current),
    [],
    'if this finds something, the false green it stands for is not reproducible and this arm is ' +
      'no longer measuring anything',
  );

  // TIP ARM.
  const paths = driftDifferences(committed, current).map((d) => d.path);
  assert.ok(
    paths.includes('graph.nodes.order'),
    `a swapped pair of nodes must be reported. Got: ${paths.join(', ')}`,
  );
  assert.ok(
    paths.some((p) => p.endsWith('.facet.sinks.order')),
    `a reversed sinks array must be reported. Got: ${paths.join(', ')}`,
  );
  // Control: no keys moved, so nothing may be reported as added or removed.
  assert.deepEqual(
    paths.filter((p) => p.endsWith('.length')),
    [],
    `nothing was added or removed. Got: ${paths.join(', ')}`,
  );
});

test('the keyed walk NEVER reports equal on unequal bytes (the false-green invariant)', () => {
  // The general form of the reorder arm. Keying is only safe if "reported
  // nothing" implies "the arrays are element-wise identical in the same order",
  // and the reorder case is just the one shape that broke it. Each mutation below
  // changes the bytes; every one of them must be reported, and the unmutated
  // control must report nothing — otherwise the suite would pass on a comparator
  // that reports everything.
  const MUTATIONS = [
    ['swap two nodes', (a) => { const t = a.graph.nodes[0]; a.graph.nodes[0] = a.graph.nodes[1]; a.graph.nodes[1] = t; }],
    ['reverse all nodes', (a) => { a.graph.nodes.reverse(); }],
    ['reverse one sinks array', (a) => { a.graph.nodes[2].facet.sinks.reverse(); }],
    ['swap two join rows', (a) => { const t = a.join.painted[0]; a.join.painted[0] = a.join.painted[1]; a.join.painted[1] = t; }],
    ['insert a node', (a) => { a.graph.nodes.unshift({ ...a.graph.nodes[0], id: 'sec:authorizer:scripts/ci/x.mjs#module' }); }],
    ['delete a node', (a) => { a.graph.nodes.splice(2, 1); }],
    ['modify a node field', (a) => { a.graph.nodes[3].kind = 'other'; }],
    ['renumber every sink id', (a) => {
      for (const n of a.graph.nodes) for (const s of n.facet.sinks) s.id = s.id.replace(/:(\d+)$/, (_, d) => `:${Number(d) + 51}`);
    }],
    ['drop a sink', (a) => { a.graph.nodes[1].facet.sinks.pop(); }],
    ['move a sink between nodes', (a) => { a.graph.nodes[4].facet.sinks.push(a.graph.nodes[0].facet.sinks.pop()); }],
    ['rename a scan scope', (a) => { a.meta.scanScopes[0].scope = 'renamed scope'; }],
    ['reorder the scan scopes', (a) => { a.meta.scanScopes.reverse(); }],
  ];
  assert.ok(MUTATIONS.length >= 10, `an emptied mutation table passes vacuously, found ${MUTATIONS.length}`);

  // Control first: an unmutated pair must report nothing.
  assert.deepEqual(driftDifferences(fiveNodeArtifact(), fiveNodeArtifact()), []);

  for (const [name, mutate] of MUTATIONS) {
    const committed = fiveNodeArtifact();
    const current = fiveNodeArtifact();
    mutate(current);
    assert.notEqual(
      JSON.stringify(committed),
      JSON.stringify(current),
      `'${name}' did not change the bytes, so it cannot test anything`,
    );
    assert.ok(
      driftDifferences(committed, current).length > 0,
      `'${name}' changes the bytes and must be reported — a comparator that calls these equal makes ` +
        '"OK — committed artifact matches the tree" a false statement (R7)',
    );
  }
});

test('REORDER of the REAL committed artifact is reported (the fixture is not carrying this)', () => {
  // The fixture arm above is 5 nodes. This is the input the block was measured
  // on: the committed 936-node artifact with two nodes swapped and one sinks
  // array reversed. Byte-different, same id sets, nothing added or removed.
  const committed = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  const current = JSON.parse(JSON.stringify(committed));
  const [first, second] = [current.graph.nodes[0], current.graph.nodes[1]];
  current.graph.nodes[0] = second;
  current.graph.nodes[1] = first;
  const withSinks = current.graph.nodes.findIndex(
    (n) => n.facet && Array.isArray(n.facet.sinks) && n.facet.sinks.length > 1,
  );
  assert.ok(withSinks >= 0, 'the artifact carries no multi-sink node, so half this arm is vacuous');
  current.graph.nodes[withSinks].facet.sinks.reverse();

  assert.notEqual(JSON.stringify(committed), JSON.stringify(current), 'the bytes must genuinely differ');
  assert.deepEqual(
    current.graph.nodes.map((n) => n.id).sort(),
    committed.graph.nodes.map((n) => n.id).sort(),
    'no node may be added or removed, or this is not a reorder',
  );

  assert.deepEqual(keyedWithoutOrder(committed, current), []);
  assert.ok(
    driftDifferences(committed, current).length > 0,
    'a reorder of the real artifact must be reported as drift — otherwise `--check` prints "OK — ' +
      'committed artifact matches the tree" over bytes that do not match (R7)',
  );
});

test('when the KEYS move, the report does not get worse than the index walk (#4275 own case)', () => {
  // #4275's measured evidence is sink-ordinal renumbering: an edit above a sink
  // shifts `console:member:<offset>` for every sink below it. Every key changes,
  // so NOTHING matches by key — and pure key matching turns each renumbered sink
  // into an absent/present PAIR printing a truncated whole-object blob, costing
  // two cap slots to say what the index walk said in one. The leftovers are
  // zipped positionally to prevent exactly that.
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  for (const node of current.graph.nodes) {
    for (const sink of node.facet.sinks) {
      sink.id = sink.id.replace(/:(\d+)$/, (_, n) => `:${Number(n) + 51}`);
    }
  }

  const differences = driftDifferences(committed, current);
  const changedSinks = 5 * 2;
  assert.equal(
    differences.length,
    changedSinks,
    `${changedSinks} renumbered sinks must cost ${changedSinks} entries, not ${changedSinks * 2}. ` +
      `Got: ${differences.map((d) => d.path).join(', ')}`,
  );
  for (const d of differences) {
    assert.match(d.path, /^graph\.nodes\[id=[^\]]+\]\.facet\.sinks\[\d+\]\.id$/, 'each entry names the one changed field');
    assert.doesNotMatch(String(d.committed), /^\{/, 'a whole-object blob says less in the same cap slot');
    assert.notEqual(String(d.committed), '<absent>', 'a renumber is a modification, not a removal');
  }
  // Parity with the pre-fix walk is the bar: the index walk found the same ten.
  assert.equal(parentIndexDiff(committed, current).length, changedSinks);
});

test('an id-less array is still walked by index, so the fallback did not go missing', () => {
  // `meta.scanScopes` elements carry no `id`; their one string property `scope`
  // is the single candidate key. Losing the walk entirely would make this pair
  // compare equal, which is the regression key matching could cause. `weight`
  // is a NUMERIC fixture field so it can never become a second candidate key.
  const committed = baseArtifact();
  const current = baseArtifact();
  for (const a of [committed, current]) for (const s of a.meta.scanScopes) s.weight = 1;
  current.meta.scanScopes[1].weight += 1;

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path),
    ['meta.scanScopes[scope=.github/**, scripts/** (CI publication surfaces)].weight'],
  );
});

test('a collection with TWO unique-string properties refuses to key, rather than guessing', () => {
  // `join.unjoined` is the live case: `nodeId` and `codeModuleId` are both unique
  // across its 229 rows, so there is a choice to make and no basis for making it.
  // Picking one silently is how a reporter starts asserting a pairing it did not
  // establish (R7), so it index-walks instead.
  const committed = baseArtifact();
  const current = baseArtifact();
  for (const artifact of [committed, current]) {
    artifact.join.unjoined = [1, 2, 3].map((i) => ({
      nodeId: `sec:publication:scripts/ci/u${i}.mjs#module`,
      codeModuleId: `code:scripts/ci/u${i}.mjs`,
      reason: 'GitHub Actions surface.',
    }));
  }
  current.join.unjoined[1].reason = 'changed';

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path),
    ['join.unjoined[1].reason'],
    'two candidate keys must fall back to the index walk, not pick one',
  );
});

test('duplicate ids REFUSE to key at all, rather than falling through to another property', () => {
  // With a repeated id there is no single element the key names, so any pairing
  // would be a guess — and a guess printed as a difference is an R7 assertion the
  // comparator did not establish. The collection has ALREADY declared what names
  // its elements, so the answer is to stop, not to find a different property.
  //
  // The labels are made distinct on purpose. A first revision of this arm left
  // them duplicated as well, which meant no property was unique, which meant the
  // index walk happened for a reason that had nothing to do with the refusal —
  // measured: deleting the refusal left this arm GREEN. `label` is now the
  // property a fall-through WOULD key on, so the refusal is what the arm sees.
  const committed = fiveNodeArtifact();
  const current = fiveNodeArtifact();
  for (const artifact of [committed, current]) {
    artifact.graph.nodes[1].id = artifact.graph.nodes[0].id;
    artifact.graph.nodes.forEach((n, i) => {
      n.label = `scripts/ci/label-${i}.mjs`;
    });
  }
  current.graph.nodes[3].kind = 'renamed-kind';

  // The teeth, asserted rather than assumed: exactly one alternative key exists.
  const labels = committed.graph.nodes.map((n) => n.label);
  assert.equal(new Set(labels).size, labels.length, 'label must be unique or a fall-through has nowhere to go');
  const ids = committed.graph.nodes.map((n) => n.id);
  assert.ok(new Set(ids).size < ids.length, 'id must genuinely be duplicated');

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path),
    ['graph.nodes[3].kind'],
    'a duplicated id must produce an index walk — not a pairing on label',
  );
});

// ── THE ANTI-ENUMERATION ARM ───────────────────────────────────────────────

test('a meta field invented later is compared without being named anywhere', () => {
  const committed = baseArtifact();
  const current = baseArtifact();
  const invented = 'aFieldNoExtractorHasEmittedYet';
  current.meta[invented] = 'some value';

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

test('the run-only set may never swallow a committed field this gate exists to watch', () => {
  // The input that breaks this: adding `scanScopes`, `skipped` or
  // `generatorVersion` to RUN_ONLY_FIELDS to make a red go away.
  assert.ok(POPULATION_META_FIELDS.length > 0, 'the protected list must not be empty');
  for (const field of POPULATION_META_FIELDS) {
    assert.ok(
      !RUN_ONLY_META_NAMES.includes(field),
      `'${field}' is what this gate watches — declaring it run-only would silence the red rather than fix it`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(baseArtifact().meta, field),
      `'${field}' is not a field the artifact carries, so protecting it protects nothing`,
    );
  }
  // And the real committed meta carries exactly the protected set — nothing
  // run-only, nothing unprotected.
  const real = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  assert.deepEqual(Object.keys(real.meta).sort(), [...POPULATION_META_FIELDS].sort());
});

test('every run-only field carries a stated reason', () => {
  assert.ok(RUN_ONLY_FIELDS.length > 0, 'an empty run-only set would make this vacuous');
  for (const { where, field, reason } of RUN_ONLY_FIELDS) {
    assert.ok(where === 'meta' || where === 'meta.scanScopes[]', `unknown location '${where}'`);
    assert.ok(typeof field === 'string' && field.length > 0);
    assert.ok(
      typeof reason === 'string' && reason.length > 60,
      `'${field}' is run-only without a substantive reason, which is how a population field gets dropped`,
    );
  }
});

test('a run-only field is NOT ignored by the comparison either (no exemption is left)', () => {
  // Before #4798 `generatedAt`, `commit` and `inputsDigest` were EXEMPT here, so
  // a committed artifact carrying stale values of them compared equal. They are
  // now absent from the committed shape, so a side that carries one differs.
  // The input that breaks this: restoring an exemption list in `driftDifferences`.
  const committed = baseArtifact();
  const current = baseArtifact();
  committed.meta.generatedAt = '2026-12-31T23:59:59.000Z';
  committed.meta.inputsDigest = 'ffffffffffffffff';

  assert.deepEqual(
    driftDifferences(committed, current).map((d) => d.path).sort(),
    ['meta.generatedAt', 'meta.inputsDigest'],
  );
  // Control: an identical pair reports nothing, so the assertion above is not
  // passing because the comparator reports everything.
  assert.deepEqual(driftDifferences(baseArtifact(), baseArtifact()), []);
});

test('driftDifferences does not mutate its arguments', () => {
  // `--check` prints counts off the live artifact AFTER comparing; a comparator
  // that hollowed out its input would make those printed counts a lie (R7).
  const committed = baseArtifact();
  const current = baseArtifact();
  current.meta.generatorVersion = 8;
  const before = JSON.stringify([committed, current]);
  driftDifferences(committed, current);
  assert.equal(JSON.stringify([committed, current]), before);
});

// ── THE POPULATION FLOOR ───────────────────────────────────────────────────

/**
 * Degenerate populations, each of which a comparison alone would certify.
 *
 * Each case mutates the artifact, the run, or both. Since #4798 the committed
 * side carries no counts, so the count cases live on the run — which `--check`
 * has for the side it just extracted.
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
    name: 'a scope with no name',
    mutate: (a) => {
      a.meta.scanScopes[0].scope = '';
    },
  },
  {
    name: 'a declared scope that matched no file on the run',
    mutate: (a, r) => {
      r.scanScopes[1].filesMatched = 0;
    },
  },
  {
    name: 'a declared scope the run has no count for',
    mutate: (a, r) => {
      r.scanScopes.pop();
      // Reconcile the total to what is left, so the ONLY thing wrong is the
      // missing count. Without this the total-mismatch refusal fires instead
      // and the case passes with the missing-count check deleted (measured).
      r.filesScanned = r.scanScopes[0].filesMatched;
    },
  },
  {
    name: 'a zero-node graph',
    mutate: (a) => {
      a.graph.nodes = [];
    },
  },
  {
    name: 'zero files scanned on the run',
    mutate: (a, r) => {
      r.filesScanned = 0;
    },
  },
  {
    name: 'scope counts that do not reconcile with the run total',
    mutate: (a, r) => {
      r.filesScanned = 9999;
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
    mutate: (a, r) => {
      r.scanScopes[0].filesMatched = null;
    },
  },
  {
    name: 'a run with no per-scope counts',
    mutate: (a, r) => {
      delete r.scanScopes;
    },
  },
];

test('the floor case table is populated (an empty suite passes vacuously)', () => {
  assert.ok(
    FLOOR_CASES.length >= 8,
    `expected the degenerate-population cases to still be present, found ${FLOOR_CASES.length}`,
  );
});

test('a healthy artifact clears the floor (control — a floor that refuses everything is useless)', () => {
  assert.deepEqual(populationRefusals(baseArtifact(), 'fixture'), []);
  assert.deepEqual(populationRefusals(baseArtifact(), 'fixture', baseRun()), []);
});

for (const { name, mutate } of FLOOR_CASES) {
  test(`the floor refuses: ${name}`, () => {
    const artifact = baseArtifact();
    const run = baseRun();
    mutate(artifact, run);
    const refusals = populationRefusals(artifact, 'fixture', run);
    assert.ok(refusals.length > 0, `'${name}' must be refused, not certified`);
    for (const r of refusals) assert.ok(r.startsWith('fixture:'), 'each refusal names its side');
  });
}

test('the extractor floors the CURRENT side on its run (the call site, not only the helper)', () => {
  // A run argument the CLI never passes would leave every count case above
  // unreachable in `--check`. Structural pin, comment lines stripped; the input
  // that breaks it is dropping `run` from that call.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  assert.match(source, /populationRefusals\(artifact, '[^']+', run\)/);
});

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
  }

  assert.deepEqual(driftDifferences(committed, current), [], 'two empty populations do compare equal');
  assert.ok(populationRefusals(committed, 'committed').length > 0, 'and the floor is what refuses them');
  assert.ok(populationRefusals(current, 'current').length > 0);
});

// ── THE REAL FIXTURE AND THE REAL ARTIFACT ─────────────────────────────────

test('the census-drift fixture exists and emits NO node, so it is still a zero-node file', () => {
  assert.ok(existsSync(FIXTURE), 'the zero-node fixture #4128 and #4798 were measured on is gone');

  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  const fromFixture = artifact.graph.nodes.filter((n) => String(n.id).includes('census-drift-probe'));
  assert.deepEqual(
    fromFixture.map((n) => n.id),
    [],
    'the fixture emitted a node, so it no longer moves the population WITHOUT moving the graph',
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
// claimed here. (Update for #4798: the job is listed as required in
// `tools/drain/required_contexts.json`, snapshot 2026-09-18.)
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
  // `ROUTE_ROOT` and `PUBLICATION_ROOTS` are module-level `const`s the extractor
  // does not export, so SCAN_ROOTS is a duplicate. The
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

// ── THE CENSUS, MOVED WITH THE COUNTS (#4798) ──────────────────────────────
//
// Until #4798 `no-estate-identifiers.test.ts` recounted the scopes from the
// filesystem and compared them to the COMMITTED `filesMatched`. That was the
// only check independent of the generator's own walk: `build.ts`'s census
// counts the files the CLI HANDED it, so a CLI that stopped handing some over
// (a narrowed include regex, a new skip in the walk) narrows both of its sides
// together. The count is no longer committed, so this counts the CLI's actual
// enumeration — `enumerateScan`, the function `main()` calls — against a
// census built here from `git ls-files` with this file's own predicates.
//
// Raw repo-relative paths, NOT `gitVisiblePaths()`: that one canonicalises
// (lowercases) into a Set, which would merge two files differing only in case
// and make a COUNT disagree for a reason that has nothing to do with the walk.

/** Every path git carries under `roots` that still exists — raw spelling, no canonicalisation. */
function gitCensus(roots) {
  const raw = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return raw.split('\0').filter(Boolean).filter((rel) => existsSync(resolve(REPO_ROOT, rel)));
}

async function extractorEnumeration() {
  process.env.LOOM_SECURITY_EXTRACT_IMPORT_ONLY = '1';
  const { enumerateScan } = await import('../../brain/extract-security-graph.mjs');
  const scan = enumerateScan(REPO_ROOT);
  const rel = (files) => files.map((f) => relative(REPO_ROOT, f).split(sep).join('/')).sort();
  return { routes: rel(scan.routeFiles), scripts: rel(scan.scriptFiles), unmodeled: scan.unmodeledPublicationSurfaces };
}

test('the extractor reads EVERY `app/**/route.ts` git carries (census against its own enumeration)', async () => {
  // Breaks on: a skip added to `walk()` (e.g. `__tests__` or `[`-segments), a
  // route predicate narrowed to `route.ts` while a `route.tsx` exists, or
  // ROUTE_ROOT pointed at a subtree.
  const census = gitCensus(['apps/fiab-console/app']).filter((p) => /\/route\.tsx?$/.test(p)).sort();
  const { routes } = await extractorEnumeration();
  assert.ok(census.length > 100, `the route census found only ${census.length} — the floor, or nothing below means anything`);
  assert.deepEqual(routes, census);
});

test('the extractor reads EVERY JavaScript module git carries under each publication root', async () => {
  // Breaks on: PUBLICATION_INCLUDE losing an extension, a root dropped from
  // PUBLICATION_ROOTS, or a skip added to the walk. The roots are read from the
  // COMMITTED artifact's scope string, so a root the artifact declares and the
  // walk skips reddens here.
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).artifact;
  const publication = artifact.meta.scanScopes.find((s) => s.scope.includes('CI publication surfaces'));
  const roots = [...publication.scope.matchAll(/([^\s,()]+)\/\*\*/g)].map((m) => m[1]);
  assert.ok(roots.length > 1, `the publication scope names ${roots.length} root(s)`);

  const census = gitCensus(roots).filter((p) => /\.(?:mjs|cjs|js)$/.test(p)).sort();
  const { scripts } = await extractorEnumeration();
  assert.ok(census.length > 100, `the script census found only ${census.length}`);
  assert.deepEqual(scripts, census);
});

// ── THE CENSUS INSIDE `--check` (#4798, review round 2) ────────────────────
//
// The two tests above count `enumerateScan()` against git. They can't see a
// file dropped AFTER that call. Review A measured one on the round-1 head: a
// `.filter()` in `main()` between `enumerateScan()` and the builder, dropping
// the zero-node fixture, left `--check` green, because both sides of the drift
// comparison came from the filtered list. So `--check` now reconciles the
// counts the builder RECEIVED (`run.scanScopes[].filesMatched`,
// `run.filesScanned`) against `_artifact-drift.mjs#gitCensus`. The arms below
// pin the helper. The end-to-end kill (that `main()` filter, and its
// `console.log`-sink variant, both RED) needs a compiled extractor, so it was
// run as a sandbox mutation and is recorded in the PR body, not here.

/** A census that reconciles with {@link baseRun}: 1694 routes + 362 scripts = 2056. */
function baseCensus() {
  return [
    { runScopeTokens: ['app/**/route.ts'], label: 'app/**/route.ts', files: 1694 },
    { runScopeTokens: ['scripts/**', '.github/**'], label: 'scripts/**, .github/**', files: 362 },
  ];
}

test('census: a run whose counts match git reconciles (control)', () => {
  // Without this every refusal arm below could pass on a helper that refuses
  // everything. It is also the SORTED-ROOTS control: the run names the scope
  // '.github/**, scripts/**' and the census tokens are in the other order, so a
  // prefix or order-sensitive match would refuse here. The first revision of
  // this helper did exactly that against the real tree.
  assert.equal(baseRun().scanScopes[1].scope.startsWith('.github/**'), true, 'the fixture must carry the sorted spelling');
  assert.deepEqual(censusRefusals(baseRun(), baseCensus()), []);
});

test('census: ONE file dropped between enumeration and build is refused, naming the count', () => {
  // The review's measured defect in helper form. The value that breaks this:
  // any comparison that tolerates a shortfall (`>=` in place of `!==`), or one
  // that compares only the total, because the total is moved too.
  const run = baseRun();
  run.scanScopes[1].filesMatched = 361;
  run.filesScanned = 2055;
  const refusals = censusRefusals(run, baseCensus());
  assert.equal(refusals.length, 1, refusals.join('\n'));
  assert.match(refusals[0], /received 361 file\(s\) but `git ls-files` lists 362/);
  assert.match(refusals[0], /1 file\(s\) were dropped between the enumeration and the build/);
});

test('census: a count ABOVE git is refused as #4216, not as a drop', () => {
  // Pins the MESSAGE branch as well as the refusal: a builder reading a file
  // git does not carry is a different fault with a different fix.
  const run = baseRun();
  run.scanScopes[0].filesMatched = 1695;
  run.filesScanned = 2057;
  const refusals = censusRefusals(run, baseCensus());
  assert.equal(refusals.length, 1, refusals.join('\n'));
  assert.match(refusals[0], /#4216/);
  assert.doesNotMatch(refusals[0], /were dropped/);
});

test('census: a per-scope shortfall that the other scope hides from the TOTAL is still refused', () => {
  // A total-only reconciliation passes this: -1 in one scope and +1 in the
  // other leaves 2056. The per-scope comparison is what refuses it.
  const run = baseRun();
  run.scanScopes[0].filesMatched = 1693;
  run.scanScopes[1].filesMatched = 363;
  assert.equal(run.scanScopes[0].filesMatched + run.scanScopes[1].filesMatched, run.filesScanned, 'the total must be unmoved');
  assert.equal(censusRefusals(run, baseCensus()).length, 2);
});

test('census: a total that disagrees while every scope matches is refused', () => {
  // A file reaching the builder outside every census scope moves the total and
  // no scope. Deleting the total comparison makes this pass.
  const run = baseRun();
  run.filesScanned = 2057;
  const refusals = censusRefusals(run, baseCensus());
  assert.equal(refusals.length, 1, refusals.join('\n'));
  assert.match(refusals[0], /2057 file\(s\) in total but the census lists 2056/);
});

test('census: a run scope the census cannot find, or can find twice, is refused', () => {
  // Breaks on a match that takes the FIRST candidate, or skips a scope with no
  // match. 'scripts/** only' carries one of the two tokens, so a match on ANY
  // token instead of EVERY token would reconcile it against the wrong count.
  const renamed = baseRun();
  renamed.scanScopes[1].scope = 'scripts/** only (CI publication surfaces)';
  assert.match(censusRefusals(renamed, baseCensus()).join('\n'), /0 run scope\(s\) are named by 'scripts\/\*\*, \.github\/\*\*'/);

  const doubled = baseRun();
  doubled.scanScopes.push({ ...doubled.scanScopes[1] });
  assert.match(censusRefusals(doubled, baseCensus()).join('\n'), /2 run scope\(s\) are named by/);
});

test('census: an empty or zero census is refused, never read as reconciled', () => {
  // Two empty things compare equal. Each input here would otherwise reconcile
  // vacuously against a run that also counted nothing.
  assert.ok(censusRefusals(baseRun(), []).length > 0, 'an empty census');
  assert.ok(censusRefusals(baseRun(), null).length > 0, 'no census');
  const zeroed = baseCensus();
  zeroed[0].files = 0;
  const run = baseRun();
  run.scanScopes[0].filesMatched = 0;
  run.filesScanned = 362;
  assert.match(censusRefusals(run, zeroed).join('\n'), /emptied census/);
});

test('census: CENSUS_SCOPES spells the extractor\'s roots and predicates, lifted from its source', () => {
  // The census is literal on purpose, so it cannot narrow along with the
  // extractor. The cost is that it can DISAGREE with it, which is what this
  // pins. Breaks on: a root added to PUBLICATION_ROOTS and not here, an
  // extension added to PUBLICATION_INCLUDE and not here, or the route predicate
  // changing on one side. Lifted from the source text, never transcribed.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8');
  const pubRoots = [...(/const PUBLICATION_ROOTS = \[([^\]]*)\]/.exec(source)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const pubInclude = /const PUBLICATION_INCLUDE = (\/.+\/);/.exec(source)?.[1];
  const routeRoot = /const ROUTE_ROOT = '([^']+)'/.exec(source)?.[1];
  const routeInclude = /scanFiles\(repoRoot, ROUTE_ROOT, \(rel\) => (\/.+\/)\.test\(rel\)/.exec(source)?.[1];
  assert.ok(pubRoots.length > 0 && pubInclude && routeRoot && routeInclude, 'the extractor no longer declares these in the shape read here');

  const [route, publication] = CENSUS_SCOPES;
  assert.deepEqual([...route.roots], [routeRoot]);
  assert.equal(String(route.include), routeInclude);
  assert.deepEqual([...publication.roots].sort(), [...pubRoots].sort());
  assert.equal(String(publication.include), pubInclude);
});

test('census: gitCensus asks git the SAME question the extractor asks', () => {
  // The census and `gitVisibleFiles` must share `git ls-files` flags, or they
  // count different populations. Dropping `--others` here, for instance, would
  // make a new untracked-but-not-ignored route a false drop. The flags are
  // lifted from the extractor's call and compared with what gitCensus passes.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8');
  const extractorArgs = /\['ls-files',([^\]]*?)'--', \.\.\.roots\]/.exec(source);
  assert.ok(extractorArgs, 'the extractor no longer calls git ls-files in the shape read here');
  const flags = ['ls-files', ...[...extractorArgs[1].matchAll(/'([^']+)'/g)].map((m) => m[1])];

  let seen;
  const fakeGit = (cmd, args) => {
    seen = { cmd, args };
    return ['apps/fiab-console/app/api/x/route.ts', 'scripts/a.mjs', 'scripts/b.yml', ''].join('\0');
  };
  const census = checkCensus(REPO_ROOT, CENSUS_SCOPES, fakeGit);
  assert.equal(seen.cmd, 'git');
  const dash = seen.args.indexOf('--');
  assert.deepEqual(seen.args.slice(0, dash), flags);
  assert.deepEqual(seen.args.slice(dash + 1).sort(), ['.github', 'apps/fiab-console/app', 'scripts']);
  // The stub's paths do not exist on disk, so all three are dropped. That is
  // the deleted-from-the-worktree exclusion, and it zeroes both scopes.
  assert.deepEqual(census.map((c) => c.files), [0, 0]);
});

test('census: gitCensus on the real tree equals the extractor\'s enumeration, scope by scope', async () => {
  // The positive half: on an unmutated tree the census must NOT refuse, or
  // `--check` would be red on every PR. Breaks on a census predicate that
  // counts `.yml`, a root typo, or a missing existence filter.
  const census = checkCensus(REPO_ROOT);
  const { routes, scripts } = await extractorEnumeration();
  assert.ok(census[0].files > 100 && census[1].files > 100, JSON.stringify(census));
  assert.deepEqual(census.map((c) => c.files), [routes.length, scripts.length]);
});

test('census: `--check` reconciles the RUN against the census before it compares (the call site)', () => {
  // A helper that is never called is the gap round 1 shipped. Structural pin,
  // comment lines stripped. The inputs that break it: dropping the call,
  // passing it anything but the run, calling it after the comparison, or not
  // exiting on a refusal. The end-to-end version of this was run as a sandbox
  // mutation (PR body).
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/brain/extract-security-graph.mjs'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  const floor = source.indexOf("populationRefusals(artifact, 'the artifact just extracted");
  const takeCensus = source.indexOf('gitCensus(REPO_ROOT)');
  const call = source.indexOf('censusRefusals(run, census)');
  const compare = source.indexOf('driftDifferences(a, artifact');
  assert.ok(floor > 0 && takeCensus > floor, 'the census is no longer taken after the population floor');
  assert.ok(call > takeCensus, '--check no longer reconciles the run against the census');
  assert.ok(compare > call, 'the census reconciliation must run BEFORE the comparison');
  assert.match(source.slice(call, compare), /process\.exit\(1\)/, 'a census refusal must exit non-zero');
});

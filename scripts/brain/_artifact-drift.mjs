/**
 * LOOM BRAIN — what "the committed artifact still matches the tree" COMPARES.
 *
 * ── THE DEFECT THIS MODULE EXISTS TO CLOSE (#4128) ───────────────────────
 *
 * `security-graph.json` is guarded twice, and until now the two gates measured
 * different properties:
 *
 *   - `extract-security-graph.mjs --check` (CI job `brain security graph`,
 *     ADVISORY) compared `{graph, join}` and nothing else.
 *   - the census assertion in `no-estate-identifiers.test.ts` (CI job
 *     `vitest (node 20)`, REQUIRED) compares `meta.scanScopes[].filesMatched`
 *     against a filesystem walk it recomputes independently.
 *
 * So a change that moved the POPULATION without moving the GRAPH slipped past
 * `--check` entirely. Measured on PR #4127: a new `.mjs` under `scripts/**` is
 * inside the declared publication scope but carries no publication construct, so
 * it emitted zero nodes. `--check` printed `OK ... 920 nodes, 174 edges` and
 * exited 0 while the required census went red on `declared 361, census 362`.
 *
 * Reproduced on this branch against the parent commit, using
 * `scripts/ci/__fixtures__/census-drift-probe.mjs` as the fixture:
 *
 *     parent (pre-fix) --check  ->  RC=0   "OK — committed artifact matches the tree"
 *     tip    (post-fix) --check ->  RC=1   "filesMatched 362 -> 363"
 *
 * with the node and edge counts BYTE-IDENTICAL across both arms. The gate named
 * for drift detection could not see the drift, and a triager reading a green
 * `brain security graph` next to a red `vitest` would look in the wrong place.
 *
 * ── WHY THIS IS AN EXCLUSION LIST AND NOT AN INCLUSION LIST ──────────────
 *
 * The obvious fix — add `meta.scanScopes` to the two fields already compared —
 * is the shape this repo keeps losing to. A guard keyed to an ENUMERATION of
 * watched names is defeated by the next name: `meta.filesScanned` would still
 * have been invisible, and so would every field a later extractor version adds.
 *
 * So the comparison is inverted. EVERYTHING in the artifact is compared by
 * default, and a field is exempt only by appearing in {@link
 * VOLATILE_META_FIELDS} with a stated reason. A field invented tomorrow is
 * covered the day it is written, by nobody remembering anything — which is the
 * only kind of coverage that survives.
 *
 * {@link POPULATION_META_FIELDS} then pins the other direction: the fields whose
 * drift is the whole point of this gate may never be moved INTO the exempt set
 * to silence a red. `__tests__/security-graph-drift-shape.test.mjs` asserts that
 * intersection is empty.
 *
 * ── WHY `inputsDigest` IS EXEMPT, STATED PLAINLY ─────────────────────────
 *
 * It is a content hash over all ~2,056 scanned files, so ANY edit to ANY of them
 * moves it. Measured on this branch: across the five commits between the
 * artifact's own `commit` field (0d2d28f5) and `main` at 605bb5ba, exactly one
 * scanned file changed content — and the committed digest is ALREADY stale
 * against a fresh walk of `main` (committed `0d3dccaf8dfc02fc`, recomputed
 * `8e93de8782349783`) while the graph is identical.
 *
 * Comparing it would therefore red this lane roughly every fifth merge and force
 * unrelated PRs to regenerate a 2 MB artifact to say nothing new. `build.ts`
 * warns about exactly that outcome in its determinism docblock — "a gate that
 * cries wolf is worse than no gate" — and a content change that alters what the
 * detectors READ necessarily alters the graph, which IS compared. The exemption
 * is a disclosed narrowing, not an accident, and the stale-digest observation is
 * recorded on #4128 rather than folded in silently.
 */

/**
 * Fields that differ between two runs over the SAME tree, with the reason each
 * one is exempt. Anything not listed here is compared.
 */
export const VOLATILE_META_FIELDS = Object.freeze([
  Object.freeze({
    field: 'generatedAt',
    reason:
      'a wall-clock stamp written at run time, so it differs on every invocation regardless of ' +
      'whether the tree moved. Comparing it would make every run report drift.',
  }),
  Object.freeze({
    field: 'commit',
    reason:
      'the HEAD sha at generation time. It advances with every merge whether or not any scanned ' +
      'file changed, and it is null in a shallow or absent git context.',
  }),
  Object.freeze({
    field: 'inputsDigest',
    reason:
      'an FNV-1a hash over the text of all scanned files, so any edit to any one of them moves ' +
      'it. Measured on #4128: it is already stale on main against an identical graph, and one ' +
      'scanned file changed content in five commits. Comparing it would red this lane every few ' +
      'merges and force unrelated PRs to regenerate a 2 MB artifact — the cry-wolf state ' +
      'build.ts warns about. Behaviour-bearing content changes move the graph, which IS compared.',
  }),
]);

/**
 * The fields whose drift this gate exists to catch.
 *
 * Listed so that "silence the red by exempting the field" is a test failure
 * rather than a one-line diff. This is NOT the set of compared fields — that set
 * is "everything" — it is the set that may never become exempt.
 */
export const POPULATION_META_FIELDS = Object.freeze([
  'generatorVersion',
  'filesScanned',
  'scanScopes',
  'skipped',
]);

/** Names only, for the exemption walk. */
const VOLATILE_FIELD_NAMES = Object.freeze(VOLATILE_META_FIELDS.map((v) => v.field));

/**
 * A deep copy of `artifact` with the run-volatile meta fields removed.
 *
 * Never mutates its argument: `--check` prints counts off the live artifact
 * after the comparison, and a comparison helper that hollowed out its own input
 * would make those counts a lie.
 */
export function comparableArtifact(artifact) {
  const clone = JSON.parse(JSON.stringify(artifact));
  if (clone !== null && typeof clone === 'object' && clone.meta !== null && typeof clone.meta === 'object') {
    for (const field of VOLATILE_FIELD_NAMES) delete clone.meta[field];
  }
  return clone;
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function summarize(v) {
  if (v === undefined) return '<absent>';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (typeof s !== 'string') return String(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function childPath(path, key) {
  return path === '' ? String(key) : `${path}.${key}`;
}

function collect(a, b, path, out, cap) {
  if (out.length >= cap) return;
  if (a === b) return;

  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    out.push({ path, committed: summarize(a), current: summarize(b) });
    return;
  }

  if (ka === 'array') {
    if (a.length !== b.length) {
      out.push({ path: `${path}.length`, committed: a.length, current: b.length });
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n && out.length < cap; i += 1) {
      collect(a[i], b[i], `${path}[${i}]`, out, cap);
    }
    return;
  }

  if (ka === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      if (out.length >= cap) return;
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (!inA || !inB) {
        out.push({
          path: childPath(path, key),
          committed: inA ? summarize(a[key]) : '<absent>',
          current: inB ? summarize(b[key]) : '<absent>',
        });
        continue;
      }
      collect(a[key], b[key], childPath(path, key), out, cap);
    }
    return;
  }

  out.push({ path, committed: summarize(a), current: summarize(b) });
}

/**
 * Every way the committed artifact differs from a freshly built one, ignoring
 * only {@link VOLATILE_META_FIELDS}.
 *
 * Capped, because a genuine extractor change moves hundreds of nodes and a gate
 * that prints them all is a gate nobody reads. The cap is reported alongside the
 * differences so a truncated list never reads as a complete one.
 */
export function driftDifferences(committed, current, cap = 20) {
  const out = [];
  collect(comparableArtifact(committed), comparableArtifact(current), '', out, cap);
  return out;
}

/**
 * Why `artifact` describes a population too degenerate to certify.
 *
 * A comparison of two empty things succeeds, and a gate that passes because
 * BOTH sides measured nothing is the failure mode this repo's guards-that-do-not-
 * watch index exists to name. So the floor is asserted before the comparison,
 * on both sides, and an empty or unaccounted population is a REFUSAL rather than
 * a pass.
 *
 * Returns an empty array when the artifact is fit to compare.
 */
export function populationRefusals(artifact, label) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return [
      `${label}: is not an object, so it declares no population at all. A comparison against it ` +
        'would succeed by vacuity.',
    ];
  }

  const refusals = [];
  const graph = artifact.graph;
  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
    refusals.push(`${label}: carries no graph.nodes array, so its node population is unknown.`);
  } else if (graph.nodes.length === 0) {
    refusals.push(
      `${label}: carries ZERO nodes. A zero-node graph reports zero findings, which is ` +
        'indistinguishable from a clean estate, so it is refused rather than compared.',
    );
  }

  const meta = artifact.meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    refusals.push(`${label}: carries no meta, so it declares no scan scopes and no file counts.`);
    return refusals;
  }

  const scopes = meta.scanScopes;
  let scopesUsable = false;
  let declaredSum = 0;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    refusals.push(
      `${label}: declares ZERO scan scopes. The scan scopes ARE the population statement — with ` +
        'none, "the artifact matches the tree" is a claim about nothing.',
    );
  } else {
    scopesUsable = true;
    for (const [i, scope] of scopes.entries()) {
      if (scope === null || typeof scope !== 'object') {
        refusals.push(`${label}: scan scope [${i}] is not an object, so its file count cannot be read.`);
        scopesUsable = false;
        continue;
      }
      if (!Number.isInteger(scope.filesMatched) || scope.filesMatched <= 0) {
        refusals.push(
          `${label}: scan scope [${i}] ('${String(scope.scope)}') reports filesMatched=` +
            `${JSON.stringify(scope.filesMatched)}. A declared scope that matched no file is an ` +
            'emptied population, not a clean one.',
        );
        scopesUsable = false;
        continue;
      }
      declaredSum += scope.filesMatched;
    }
  }

  if (!Number.isInteger(meta.filesScanned) || meta.filesScanned <= 0) {
    refusals.push(
      `${label}: reports filesScanned=${JSON.stringify(meta.filesScanned)}. A scan that examined ` +
        'no file cannot certify anything.',
    );
  } else if (scopesUsable && declaredSum !== meta.filesScanned) {
    // POPULATION ACCOUNTING, NOT A SPOT CHECK.
    //
    // Every scanned file belongs to exactly one declared scope. If the scopes do
    // not add up to the total, a scope was dropped from the report or a count was
    // hand-edited — and either way the artifact's own population statement is
    // internally false, which no per-scope assertion catches.
    refusals.push(
      `${label}: scan scopes account for ${declaredSum} file(s) but filesScanned reports ` +
        `${meta.filesScanned}. The population statement does not reconcile with itself, so a ` +
        'scope is missing from the report or a count was edited by hand.',
    );
  }

  return refusals;
}

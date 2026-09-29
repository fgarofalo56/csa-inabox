/**
 * LOOM BRAIN — what "the committed artifact still matches the tree" COMPARES.
 *
 * ── WHAT IS COMMITTED, AND WHY THAT CHANGED (#4798) ──────────────────────
 *
 * `security-graph.json` used to carry the run's tallies in `meta`: `filesScanned`,
 * a per-scope `filesMatched` and `nodesEmitted`, an `inputsDigest`, a
 * `generatedAt` and a `commit`, plus unread-file and sink counts spelled inside
 * two ledger reasons. Every one of those moves when ANY file is added under a
 * scanned root, so every open PR that touched the artifact went CONFLICTING after
 * each merge to `main` — measured on #4767, #4769, #4770 and #4777, some twice —
 * and each resolution was a content push that voided every review verdict.
 *
 * Measured with `git merge-file` over artifacts regenerated on base, base+A and
 * base+B, A and B being unrelated files: 1 conflict in each of four shapes (two
 * zero-node `.mjs`, two sink-bearing `.mjs`, a `.yml` against a `.sh`, two
 * `route.ts`), and in every shape the merged bytes also DIFFERED from the
 * artifact regenerated with both files present — two PRs that each move a count
 * N -> N+1 merge cleanly to a value that is wrong for the pair.
 *
 * So those values are no longer committed. `build.ts#buildSecurityGraphExtraction`
 * returns them on a separate `run` object that the CLI prints and floors on, and
 * the committed artifact is the graph, the join and per-element ledger entries.
 * {@link RUN_ONLY_FIELDS} names each one with its reason, and `--check` REFUSES a
 * committed artifact that carries any of them rather than ignoring it: an
 * exemption would let one creep back in and restore the conflict silently.
 *
 * ── WHAT THIS GIVES UP, STATED PLAINLY ───────────────────────────────────
 *
 * #4128 made `--check` compare `filesMatched` so that a zero-node file inside a
 * scanned scope reddened it, because the REQUIRED census in
 * `no-estate-identifiers.test.ts` went red on exactly that change while this
 * then-advisory gate stayed green. That is reversed on purpose: a zero-node file
 * changes nothing any detector reads, so it now changes nothing committed, and
 * both gates agree it needs no regeneration. The census the #4128 fix protected
 * is kept, moved to where the numbers now live: the generator's own enumeration
 * is counted against an independent `git ls-files` census in
 * `scripts/ci/__tests__/security-graph-drift-shape.test.mjs` (required, on
 * `guardrails`), and `--check` floors on the run's counts before comparing.
 *
 * ── WHY THE COMPARISON IS STILL "EVERYTHING" AND NOT AN INCLUSION LIST ───
 *
 * A guard keyed to an ENUMERATION of watched names is defeated by the next name.
 * So every field of the committed artifact is compared, with no exemptions at
 * all, and a field invented tomorrow is covered the day it is written.
 * {@link POPULATION_META_FIELDS} pins the other direction: the committed fields
 * that may never be declared run-only to silence a red.
 */

/**
 * Fields that belong to ONE extractor run and must never be committed (#4798).
 *
 * `where` is the object the field would appear on: `meta`, or each element of
 * `meta.scanScopes`. Everything else in the artifact is compared.
 */
export const RUN_ONLY_FIELDS = Object.freeze([
  Object.freeze({
    where: 'meta',
    field: 'generatedAt',
    reason:
      'a wall-clock stamp, so it differs on every run whether or not the tree moved, and two PRs ' +
      'that each regenerate always conflict on it.',
  }),
  Object.freeze({
    where: 'meta',
    field: 'commit',
    reason:
      'the HEAD sha at generation time. It differs on every branch and advances with every merge ' +
      'whether or not any scanned file changed.',
  }),
  Object.freeze({
    where: 'meta',
    field: 'inputsDigest',
    reason:
      'an FNV-1a hash over the text of every scanned file, so any edit to any one of them moves it ' +
      'and two unrelated PRs always conflict on it. A content change that alters what the ' +
      'detectors read necessarily alters the graph, which IS compared.',
  }),
  Object.freeze({
    where: 'meta',
    field: 'filesScanned',
    reason:
      'a tally over every scope. Adding any file under a scanned root moves it, and two PRs that ' +
      'each move it N -> N+1 merge cleanly to a total that is wrong for both files together.',
  }),
  Object.freeze({
    where: 'meta.scanScopes[]',
    field: 'filesMatched',
    reason:
      'a tally over one whole scope, with the same two failure modes as filesScanned: a conflict ' +
      'when two PRs move it differently, a silently wrong value when they move it the same way.',
  }),
  Object.freeze({
    where: 'meta.scanScopes[]',
    field: 'nodesEmitted',
    reason:
      'a tally over one whole scope that moves whenever any file in it gains or loses a node. It ' +
      'is derivable from graph.nodes, which is compared element by element.',
  }),
]);

/**
 * The committed meta fields this gate exists to watch.
 *
 * Listed so that "silence the red by declaring the field run-only" is a test
 * failure rather than a one-line diff. This is NOT the set of compared fields —
 * that set is "everything" — it is the set that may never leave it.
 */
export const POPULATION_META_FIELDS = Object.freeze(['generatorVersion', 'scanScopes', 'skipped']);

/**
 * Every run-only field `artifact` carries, as a path, e.g. `meta.filesScanned` or
 * `meta.scanScopes[1].filesMatched`. Empty for a correctly committed artifact.
 *
 * Not an exemption: `--check` refuses a committed artifact for which this returns
 * anything, because the field's presence IS the merge conflict #4798 removed.
 */
export function runOnlyFieldsPresent(artifact) {
  const found = [];
  const meta = artifact !== null && typeof artifact === 'object' ? artifact.meta : undefined;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return found;
  for (const { where, field } of RUN_ONLY_FIELDS) {
    if (where === 'meta') {
      if (Object.prototype.hasOwnProperty.call(meta, field)) found.push(`meta.${field}`);
      continue;
    }
    if (!Array.isArray(meta.scanScopes)) continue;
    meta.scanScopes.forEach((scope, i) => {
      if (scope !== null && typeof scope === 'object' && Object.prototype.hasOwnProperty.call(scope, field)) {
        found.push(`meta.scanScopes[${i}].${field}`);
      }
    });
  }
  return found;
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

/** Whether `name` holds a distinct value on every element of `arr`. */
function isUniqueAcross(arr, name) {
  const seen = new Set();
  for (const element of arr) {
    if (seen.has(element[name])) return false;
    seen.add(element[name]);
  }
  return true;
}

/**
 * The property that identifies the elements of `arr`, or `null` when it has none.
 *
 * `id` first, because that is the name the extractor mints identity under
 * (`graph.nodes`, `graph.edges`, `facet.sinks`, `facet.allowPaths`). If every
 * element carries a non-empty string `id` and those ids are NOT unique, this
 * returns null rather than falling through to some other property: the
 * collection has already declared what names its elements, and pairing on
 * something else would be a guess about a collection that told us the answer.
 *
 * Otherwise a single unambiguous alternative is accepted — exactly one property
 * that is a non-empty string on every element AND distinct across all of them.
 * That is what reaches `join.painted` (keyed `nodeId`), `meta.scanScopes`
 * (`scope`) and `meta.skipped` (`subject`). "Exactly one" is the whole
 * safeguard: with two candidates there is a choice to make, and this function
 * has no basis for making it, so it refuses. `join.unjoined` is the live example
 * — `nodeId` and `codeModuleId` are both unique across its 229 rows — and it is
 * index-walked for that reason.
 *
 * The candidate set is DATA-DEPENDENT, and that is a disclosed narrowing rather
 * than an accident: if a second property later happens to be unique, the array
 * silently drops back to the index walk. That degrades the REPORT and never the
 * VERDICT. {@link collectKeyed} returns nothing only when the arrays are
 * element-wise identical IN THE SAME ORDER — a leftover that zipped to an equal
 * partner would have matched by key in the first place, and the shared-key order
 * is compared — so a keyed walk can print a different SHAPE of report than the
 * index walk (a swap is one `.order` entry rather than four field entries) but
 * can never call unequal arrays equal.
 */
function identityKey(arr) {
  if (arr.length === 0) return null;
  for (const element of arr) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) return null;
  }

  if (arr.every((element) => typeof element.id === 'string' && element.id !== '')) {
    return isUniqueAcross(arr, 'id') ? 'id' : null;
  }

  const candidates = Object.keys(arr[0]).filter(
    (name) =>
      arr.every((element) => typeof element[name] === 'string' && element[name] !== '') &&
      isUniqueAcross(arr, name),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * ARRAYS OF IDENTIFIED THINGS ARE MATCHED BY KEY, THEN ALIGNED BY POSITION (#4275).
 *
 * Walking two arrays by index pairs element i against element i, so INSERTING
 * one node at the front reports every subsequent node as a modified
 * `id`/`kind`/`label`/… — the cap (20) fills with index-shift noise and the
 * actual change, the added node, may not appear in the printed list at all.
 * Measured on the committed artifact: one inserted route node plus its
 * `join.painted` row produced 20 entries under the pure index walk, 17 of them
 * naming rows nobody touched.
 *
 * So elements present on BOTH sides under {@link identityKey} are paired by that
 * key. What is left over on each side is then zipped POSITIONALLY, in its
 * original relative order, and only a genuine surplus is reported as an
 * absent/present pair. That second half is not a detail — it is what keeps this
 * from being a regression when the keys themselves are what moved:
 *
 *   - one node inserted, 936 keys shared  -> 1 entry naming the added id
 *   - every `facet.sinks` id renumbered, 0 keys shared -> the leftovers zip 1:1
 *     and each sink reports its changed `.id` field, exactly as the index walk
 *     did. Without the zip each renumbered sink cost TWO cap slots (absent +
 *     present) and printed a truncated whole-object blob instead of the one
 *     field that changed — measured on the #4275 case (every ordinal +51): 20
 *     entries covering 10 sinks, against 20 entries covering 20 sinks.
 *
 * ORDER IS COMPARED. A keyed walk that ignored position would report NOTHING for
 * an artifact whose elements were merely reordered — and the message this feeds
 * says "the committed artifact matches the tree", which would then be false of
 * bytes that genuinely differ (R7). So the relative order of the SHARED keys is
 * compared and the first divergence is reported. Only shared keys, because an
 * insertion legitimately shifts everything after it and is already reported once.
 *
 * BLAST RADIUS, MEASURED on the committed artifact (936 nodes / 173 edges) on
 * 2026-09-08 — keying engages on 537 array instances of 7 kinds:
 * `graph.nodes` 1 (`id`), `graph.edges` 1 (`id`), `graph.nodes[].facet.sinks`
 * 227 of 229 (`id`; 2 carry duplicate ids and index-walk),
 * `graph.nodes[].facet.allowPaths` 305 (`id`), `join.painted` 1 (`nodeId`),
 * `meta.scanScopes` 1 (`scope`), `meta.skipped` 1 (`subject`).
 * `join.unjoined` is NOT keyed — two candidates, so it refuses.
 *
 * WHAT THIS DOES NOT FIX. #4275's stated root cause is the EXTRACTOR's
 * ordinal-based member identity (`console:member:<N>`, where N is a source
 * offset), which makes an unrelated edit above a sink renumber every sink id in
 * the file. Nothing here changes how those ids are minted; this only stops the
 * REPORT from smearing. The identity scheme is still open on #4275.
 */
function collectKeyed(a, b, key, path, out, cap) {
  const indexA = new Map(a.map((element, i) => [element[key], i]));
  const indexB = new Map(b.map((element, i) => [element[key], i]));

  const orderA = a.filter((element) => indexB.has(element[key])).map((element) => element[key]);
  const orderB = b.filter((element) => indexA.has(element[key])).map((element) => element[key]);
  for (let i = 0; i < orderA.length; i += 1) {
    if (orderA[i] === orderB[i]) continue;
    if (out.length >= cap) return;
    out.push({
      path: `${path}.order`,
      committed: `${key}=${orderA[i]} at position ${i} of the ${orderA.length} shared key(s)`,
      current: `${key}=${orderB[i]} at position ${i} of the ${orderB.length} shared key(s)`,
    });
    break;
  }

  // The leftovers come BEFORE the matched pairs: an element that arrived or left
  // IS the population statement, and it is the entry #4275 measured being pushed
  // off the end of a cap filled with field noise.
  const leftoverA = [...a.keys()].filter((i) => !indexB.has(a[i][key]));
  const leftoverB = [...b.keys()].filter((i) => !indexA.has(b[i][key]));
  const zipped = Math.min(leftoverA.length, leftoverB.length);
  for (let k = 0; k < zipped; k += 1) {
    if (out.length >= cap) return;
    const i = leftoverA[k];
    const j = leftoverB[k];
    // `[i|j]` when the two positions differ: the committed index, then the
    // current one. Naming only one of them would assert a position the other
    // side does not have the element at.
    collect(a[i], b[j], i === j ? `${path}[${i}]` : `${path}[${i}|${j}]`, out, cap);
  }
  for (const i of leftoverA.slice(zipped)) {
    if (out.length >= cap) return;
    out.push({ path: `${path}[${key}=${a[i][key]}]`, committed: summarize(a[i]), current: '<absent>' });
  }
  for (const j of leftoverB.slice(zipped)) {
    if (out.length >= cap) return;
    out.push({ path: `${path}[${key}=${b[j][key]}]`, committed: '<absent>', current: summarize(b[j]) });
  }

  for (const element of a) {
    if (out.length >= cap) return;
    const j = indexB.get(element[key]);
    if (j === undefined) continue;
    collect(element, b[j], `${path}[${key}=${element[key]}]`, out, cap);
  }
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
    const keyA = identityKey(a);
    const keyB = identityKey(b);
    if (keyA !== null && keyA === keyB) {
      collectKeyed(a, b, keyA, path, out, cap);
      return;
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
 * Every way the committed artifact differs from a freshly built one.
 *
 * No field is exempt. The fields that differ between two runs over the same tree
 * are not committed at all ({@link RUN_ONLY_FIELDS}), so there is nothing left
 * that may legitimately differ.
 *
 * Capped, because a genuine extractor change moves hundreds of nodes and a gate
 * that prints them all is a gate nobody reads. The cap is reported alongside the
 * differences so a truncated list never reads as a complete one.
 */
export function driftDifferences(committed, current, cap = 20) {
  const out = [];
  collect(committed, current, '', out, cap);
  return out;
}

/**
 * Why `artifact` — optionally with the `run` that produced it — describes a
 * population too degenerate to certify.
 *
 * A comparison of two empty things succeeds, and a gate that passes because
 * BOTH sides measured nothing is the failure mode this repo's guards-that-do-not-
 * watch index exists to name. So the floor is asserted before the comparison,
 * on both sides, and an empty or unaccounted population is a REFUSAL rather than
 * a pass.
 *
 * The committed side carries no counts any more (#4798), so on it the floor is
 * the node population and the declared scopes. The file counts are checked on
 * `run`, which `--check` has for the side it just extracted: every declared scope
 * must have a count, every count must be positive, and they must sum to
 * `run.filesScanned`.
 *
 * Returns an empty array when the artifact is fit to compare.
 */
export function populationRefusals(artifact, label, run = undefined) {
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
    refusals.push(`${label}: carries no meta, so it declares no scan scopes.`);
    return refusals;
  }

  const scopes = meta.scanScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    refusals.push(
      `${label}: declares ZERO scan scopes. The scan scopes ARE the population statement — with ` +
        'none, "the artifact matches the tree" is a claim about nothing.',
    );
    return refusals;
  }
  const names = [];
  for (const [i, scope] of scopes.entries()) {
    if (scope === null || typeof scope !== 'object' || typeof scope.scope !== 'string' || scope.scope === '') {
      refusals.push(`${label}: scan scope [${i}] does not name its scope, so it declares nothing.`);
      continue;
    }
    names.push(scope.scope);
  }

  if (run === undefined) return refusals;
  if (run === null || typeof run !== 'object' || !Array.isArray(run.scanScopes)) {
    refusals.push(`${label}: its run carries no per-scope counts, so the files it examined are unknown.`);
    return refusals;
  }

  let declaredSum = 0;
  let countsUsable = true;
  for (const name of names) {
    const counted = run.scanScopes.find((s) => s !== null && typeof s === 'object' && s.scope === name);
    if (counted === undefined) {
      refusals.push(`${label}: scan scope '${name}' has no count in the run that produced it.`);
      countsUsable = false;
      continue;
    }
    if (!Number.isInteger(counted.filesMatched) || counted.filesMatched <= 0) {
      refusals.push(
        `${label}: scan scope '${name}' matched filesMatched=${JSON.stringify(counted.filesMatched)} on ` +
          'this run. A declared scope that matched no file is an emptied population, not a clean one.',
      );
      countsUsable = false;
      continue;
    }
    declaredSum += counted.filesMatched;
  }

  if (!Number.isInteger(run.filesScanned) || run.filesScanned <= 0) {
    refusals.push(
      `${label}: its run reports filesScanned=${JSON.stringify(run.filesScanned)}. A scan that ` +
        'examined no file cannot certify anything.',
    );
  } else if (countsUsable && declaredSum !== run.filesScanned) {
    // POPULATION ACCOUNTING, NOT A SPOT CHECK. Every scanned file belongs to
    // exactly one declared scope, so the scopes must add up to the total or a
    // scope was dropped from the report.
    refusals.push(
      `${label}: scan scopes account for ${declaredSum} file(s) but the run scanned ` +
        `${run.filesScanned}. The population statement does not reconcile with itself, so a ` +
        'scope is missing from the report.',
    );
  }

  return refusals;
}

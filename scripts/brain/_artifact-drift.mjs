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
 * is kept, moved to where the numbers now live. {@link censusRefusals} runs INSIDE
 * `--check`: the counts the builder actually received are reconciled against
 * {@link gitCensus}, an independent `git ls-files` count with its own literal
 * roots and patterns, so a file dropped anywhere between the enumeration and the
 * build turns the gate red even when that file emits no node. The generator's
 * enumeration is also counted against a census in
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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

// ── THE INDEPENDENT CENSUS, INSIDE `--check` (#4798) ────────────────────────
//
// `--check` compares the committed artifact against one the extractor has just
// built. If the CLI stops handing the builder some file, both sides of that
// comparison lose it together: for a file that emits no node, the artifact does
// not move at all, and the gate goes green over a narrower population than it
// claims. `build.ts`'s own census cannot see this either, because it counts the
// files it was HANDED. Measured on the round-1 head of #4798: a `.filter()`
// after `enumerateScan()` in `main()` dropping the zero-node census fixture left
// `--check` green. Before #4798 the committed `filesMatched` would have reddened
// it; that count is no longer committed, so the count is re-derived here, from
// git, at check time.

/**
 * What the census counts, spelled HERE rather than imported from the extractor.
 *
 * A census that imported the extractor's roots and patterns would narrow with
 * them. These are literals, and `security-graph-drift-shape.test.mjs` checks
 * them against the extractor's SOURCE, so a root added there and not here is a
 * red test rather than a silently narrower census.
 *
 * `runScopeTokens` identifies the matching entry in the run's `scanScopes`.
 * `build.ts` names the scopes, and it sorts the publication roots, so matching is
 * by whole comma- or space-separated token, in any order. No match, or more than
 * one, is a refusal.
 */
export const CENSUS_SCOPES = Object.freeze([
  Object.freeze({
    runScopeTokens: Object.freeze(['app/**/route.ts']),
    roots: Object.freeze(['apps/fiab-console/app']),
    include: /\/route\.tsx?$/,
  }),
  Object.freeze({
    runScopeTokens: Object.freeze(['scripts/**', '.github/**']),
    roots: Object.freeze(['scripts', '.github']),
    include: /\.(?:mjs|cjs|js)$/,
  }),
]);

/** Whether the run scope named `scope` is the one `tokens` identifies. */
function namesScope(scope, tokens) {
  const words = scope.split(/[\s,]+/);
  return tokens.every((t) => words.includes(t));
}

/**
 * The number of files git carries for each census scope, counted from
 * `git ls-files` alone.
 *
 * It uses the same `git ls-files` flags as the extractor's `gitVisibleFiles`
 * (`-z --cached --others --exclude-standard`): tracked files plus untracked files
 * that are not ignored. The two must share flags, or they would count different
 * populations and disagree over a file nobody dropped. A path listed by
 * `--cached` but deleted from the worktree is excluded here for the same reason
 * the extractor excludes it: nothing reads it.
 *
 * Throws if git fails. With no census, the check cannot establish what the tree
 * holds, so the caller refuses rather than skipping the reconciliation.
 */
export function gitCensus(repoRoot, scopes = CENSUS_SCOPES, git = execFileSync) {
  const present = gitPresentFiles(repoRoot, [...new Set(scopes.flatMap((s) => s.roots))], git);
  return scopes.map((s) => ({
    runScopeTokens: s.runScopeTokens,
    label: s.runScopeTokens.join(', '),
    files: present.filter((rel) => s.roots.some((r) => rel.startsWith(`${r}/`)) && s.include.test(rel)).length,
  }));
}

/**
 * `git ls-files` under `roots`, minus paths deleted from the worktree. ONE helper
 * for both censuses, so the lexed and unread counts cannot ask git different
 * questions. Throws if git fails.
 */
function gitPresentFiles(repoRoot, roots, git) {
  const raw = git('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return String(raw)
    .split('\0')
    .filter(Boolean)
    .filter((rel) => existsSync(path.join(repoRoot, rel)));
}

// ── THE UNREAD SET, RECONCILED TOO (#4798, review round 3) ──────────────────
//
// The extractor also COUNTS, per publication root, the files it cannot lex
// (`.sh`, `.ps1`, `.yml`, ...), and reports them as a ledger subject. Before
// #4798 that count was spelled into a committed ledger reason, so a filter that
// dropped some of those files moved the artifact. The count is now a run value
// (`run.unmodeledPublicationSurfaces[].fileCount`), so without this census such a
// filter would be watched by nothing.

/**
 * The unread set, spelled HERE as a literal for the same reason as
 * {@link CENSUS_SCOPES}. `security-graph-drift-shape.test.mjs` checks the roots
 * and pattern against the extractor's `PUBLICATION_ROOTS` and
 * `PUBLICATION_UNMODELED`.
 */
export const CENSUS_UNREAD = Object.freeze({
  roots: Object.freeze(['scripts', '.github']),
  include: /\.(?:sh|ps1|psm1|py|yml|yaml)$/,
});

/** Per publication root, the number of unread-language files git carries. Throws if git fails. */
export function gitUnreadCensus(repoRoot, spec = CENSUS_UNREAD, git = execFileSync) {
  const present = gitPresentFiles(repoRoot, [...spec.roots], git);
  return spec.roots.map((r) => ({
    root: `${r}/`,
    files: present.filter((rel) => rel.startsWith(`${r}/`) && spec.include.test(rel)).length,
  }));
}

/**
 * Why the run's unread counts do NOT match {@link gitUnreadCensus}: one refusal
 * per root that is missing from the run, doubled, or counted differently.
 * Returns an empty array when every root reconciles.
 *
 * A ZERO count is not refused here, unlike the lexed census. A root with no
 * `.sh`/`.yml` file is a real possibility, and a git failure throws rather than
 * returning zeros. So a zero that matches is a reconciled zero.
 */
export function unreadCensusRefusals(run, census) {
  if (!Array.isArray(census) || census.length === 0) {
    return ['the independent census of unread files is empty, so the unread counts were checked against nothing.'];
  }
  const surfaces =
    run !== null && typeof run === 'object' && Array.isArray(run.unmodeledPublicationSurfaces)
      ? run.unmodeledPublicationSurfaces
      : [];
  const refusals = [];
  for (const c of census) {
    const matches = surfaces.filter((s) => s !== null && typeof s === 'object' && s.root === c.root);
    if (matches.length !== 1) {
      refusals.push(
        `${matches.length} unread-file count(s) in the run for '${c.root}', not exactly one, so the census ` +
          'for it has nothing to reconcile against.',
      );
      continue;
    }
    const got = matches[0].fileCount;
    if (got !== c.files) {
      refusals.push(
        `unread files under '${c.root}': the run counted ${JSON.stringify(got)} but \`git ls-files\` lists ` +
          `${c.files}. The ledger's "seen and NOT read" subject would then understate what this ` +
          'extractor cannot see.',
      );
    }
  }
  if (refusals.length === 0 && surfaces.length !== census.length) {
    refusals.push(
      `the run reports unread files under ${surfaces.length} root(s) but the census covers ${census.length}, ` +
        'so a root reached the ledger outside the census.',
    );
  }
  return refusals;
}

/**
 * Why the builder's input did NOT match the tree: the run's counts reconciled
 * against {@link gitCensus}, one scope at a time and then in total.
 *
 * `run.scanScopes[].filesMatched` is what the builder received per scope
 * (`build.ts` asserts it against its own predicate over the handed files), and
 * `run.filesScanned` is the total. A count BELOW the census means a file was
 * dropped between enumeration and build. A count ABOVE it means the builder read
 * a file git does not carry, which is #4216. Returns an empty array when every
 * count reconciles.
 */
export function censusRefusals(run, census) {
  if (!Array.isArray(census) || census.length === 0) {
    return ['the independent census is empty, so the counts the builder received were checked against nothing.'];
  }
  const scopes = run !== null && typeof run === 'object' && Array.isArray(run.scanScopes) ? run.scanScopes : [];
  const refusals = [];
  let total = 0;
  for (const c of census) {
    if (!Number.isInteger(c.files) || c.files <= 0) {
      refusals.push(
        `the census counted ${JSON.stringify(c.files)} file(s) for '${c.label}', so git lists nothing ` +
          'the extractor should read there. That is an emptied census, not a reconciled one.',
      );
      continue;
    }
    total += c.files;
    const matches = scopes.filter(
      (s) => s !== null && typeof s === 'object' && typeof s.scope === 'string' && namesScope(s.scope, c.runScopeTokens),
    );
    if (matches.length !== 1) {
      refusals.push(
        `${matches.length} run scope(s) are named by '${c.label}', not exactly one, so the census for it ` +
          'has nothing to reconcile against. A scope was renamed or dropped from the run.',
      );
      continue;
    }
    const got = matches[0].filesMatched;
    if (got !== c.files) {
      refusals.push(
        `scan scope '${matches[0].scope}': the builder received ${JSON.stringify(got)} file(s) but ` +
          `\`git ls-files\` lists ${c.files}. ` +
          (Number.isInteger(got) && got < c.files
            ? `${c.files - got} file(s) were dropped between the enumeration and the build, so the artifact ` +
              'was compared over a narrower population than the tree holds.'
            : 'The builder read file(s) git does not carry (#4216), or the count is not a number.'),
      );
    }
  }
  const scanned = run !== null && typeof run === 'object' ? run.filesScanned : undefined;
  if (refusals.length === 0 && scanned !== total) {
    refusals.push(
      `the run scanned ${JSON.stringify(scanned)} file(s) in total but the census lists ${total} across its ` +
        'scopes, so a file reached the builder outside every census scope, or one was lost from the total.',
    );
  }
  return refusals;
}

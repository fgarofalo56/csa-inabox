/**
 * LOOM BRAIN — SECURITY EXTRACTION: assembling the artifact.
 *
 * PURE. Takes files a caller already read and returns a {@link SecurityGraphArtifact}.
 * The CLI in `scripts/brain/extract-security-graph.mjs` does the I/O; everything
 * decided here is decided from text, so the whole pipeline is unit-testable and
 * produces identical bytes on Windows and Linux.
 *
 * ── WHY THE EDGE COUNT IS LOW, AND WHY THAT IS CORRECT ───────────────────
 *
 * A reader comparing this to the waste graph will notice it emits far more nodes
 * than edges, and might read that as an incomplete extraction. It is not. The
 * whole argument of `../substrate.ts` is that security detection needs facts a
 * CALL GRAPH CANNOT CARRY, and it names three, each with a measured instance:
 *
 *   - data-flow, so a CONSUMED verdict is distinguishable from a CALL. The
 *     2026-08-07 incident deleted `if (gate) return gate;` and left the import
 *     edge, the call edge and the guard's whole implementation intact.
 *   - per-node verdict TOTALITY (#3834 — fail-open in 2 of 9 modes).
 *   - cross-node DIFFERENTIAL semantics (11 tenant comparisons, all on-path).
 *
 * "A graph whose edges are calls or imports is blind to that class BY
 * CONSTRUCTION." So the security substrate puts the load on FACETS, and every
 * one of the nine detectors reads facets — not one of them traverses `edges`.
 * Edges are emitted here where they are genuinely derivable and true; inventing
 * more would add weight without adding a single fact any detector can use.
 *
 * ── WHAT IS EXTRACTED, AND WHAT IS DELIBERATELY NOT ──────────────────────
 *
 * Extracted: `authorizer` (C1), `verdict-call` (C3), `publication` (C4).
 *
 * NOT extracted: `scoped-handler` (C2), `verdict-totality` (C5),
 * `credential-egress` (C6), `principal` (C7), `emitted-command` (C8),
 * `predicate-impl` (C9).
 *
 * That is a REPORTED gap, not a hidden one, and the mechanism that reports it is
 * already built: `Population.emptyIsExpected` defaults to `false` on every
 * detector, so each of those six runs over an empty candidate set and synthesises
 * a `POP-population-integrity` finding reading "examined an EMPTY population —
 * green and blind". The sweep therefore says out loud, per detector, that six
 * classes were not measured. That is the honest state and it is strictly better
 * than an extractor that emits a plausible-looking node of each kind so the
 * numbers look complete — which would report a verdict over an estate nobody
 * examined.
 *
 * ── THE SCOPE REPORT IS DERIVED, NOT DECLARED ALONGSIDE THE WALK ─────────
 *
 * The same discipline applied to this file's own honesty, after it failed here.
 * Until 2026-08-24 the publication partition was `startsWith('scripts/') ||
 * startsWith('.github/')` and the emitted scope string said `scripts/**,
 * .github/**` — while the CLI walked `scripts/` alone. Two independent literals,
 * in two files, that disagreed. Measured on the committed artifact: 0 `.github`
 * nodes, 0 `skipped` entries naming it, and `.github/scripts/deploy-notify-
 * failure.mjs` — a failure NOTIFIER, i.e. precisely the publication surface C4
 * exists to find — silently outside a population the bytes claimed to cover.
 *
 * `.github/**` is walked for real now, and the structural half of the fix is that
 * `BuildInput.publicationRoots` is the ONE source: the partition and the label
 * are both derived from it, a root that matched no file throws, and what remains
 * unread (YAML / shell / Python under those roots) is pushed into `skipped` with
 * a COUNT. A narrowed scope is fine; an undeclared one is the defect.
 */

import type { SecurityEdge, SecurityGraph, SecurityNode } from '../substrate';
import type {
  ScanScopeReport,
  SecurityGraphArtifact,
  SkippedSubject,
  SourceFile,
  UnmodeledSurface,
} from './types';
import { extractRouteNodes, parseAllowlistPrefixes } from './route-nodes';
import { extractPublicationNodes } from './publications';
import { assertJoinCoversGraph, buildJoin } from './join';
import { assertCensusAgrees } from './population-contract';

/**
 * Bumped when extraction SEMANTICS change.
 *
 * The runtime refuses an artifact whose version it does not recognise, so a graph
 * produced by an older extractor cannot be rendered as though today's predicates
 * had run over it.
 */
export const GENERATOR_VERSION = 1;

/** File extensions the publication analyzer reads. Spelled as a LIST, not a regex. */
const PUBLICATION_LANGUAGES: readonly string[] = ['.mjs', '.cjs', '.js', '.ts'] as const;

/**
 * Is this path an `app/**\/route.ts` module?
 *
 * A SECOND, independent expression of the rule `source-facts.ts#routePathOf`
 * applies — deliberately, and for the reason `../population.ts` point 4 gives:
 * `extractRouteNodes`'s own `candidates` list is built by calling `routePathOf`,
 * so a narrowing applied INSIDE that function shrinks the numerator and the
 * denominator together and the judged-vs-candidates contract still balances.
 * This predicate is not derived from that one, so the two can disagree — and
 * {@link assertCensusAgrees} makes the disagreement fatal.
 */
function isRouteModule(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return p.includes('/app/') && /\/route\.tsx?$/.test(p);
}

export interface BuildInput {
  /** Every file to scan. The caller decides the scope; this function reports it. */
  readonly files: readonly SourceFile[];
  /**
   * The repo-relative roots the caller ACTUALLY walked for publication surfaces,
   * e.g. `['scripts/', '.github/']`.
   *
   * REQUIRED, and the scope string this artifact reports is DERIVED from it
   * rather than written alongside it. That is the fix for the defect this field
   * exists because of: the two used to be independent literals, one in the CLI
   * and one here, and they disagreed — the artifact declared `.github/**` for
   * weeks while nothing walked it. A root that matched no file at all throws,
   * so a root declared here and not walked cannot survive either.
   */
  readonly publicationRoots: readonly string[];
  /** What the caller saw under those roots and could not read. Reported, with counts. */
  readonly unmodeledPublicationSurfaces?: readonly UnmodeledSurface[];
  /** `scripts/ci/check-route-guards.mjs`, for the real allowlist prefixes. */
  readonly routeGuardSource: string | null;
  readonly commit: string | null;
  /** Injected so the artifact is reproducible in tests. */
  readonly now: Date;
}

/**
 * FNV-1a over (path, text) of every scanned file, in path order.
 *
 * Not cryptographic and does not need to be: its only job is to let CI re-run the
 * extractor and prove the committed artifact still matches the tree. A hand-rolled
 * hash keeps this package free of value imports, which is what keeps the build
 * step a plain `tsc` invocation rather than a bundler (see `join.ts`).
 */
export function inputsDigest(files: readonly SourceFile[]): string {
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= (s.charCodeAt(i) + i) & 0xff;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
  };
  for (const f of ordered) {
    mix(f.path);
    // Normalise line endings so a CRLF checkout and an LF checkout of the same
    // content produce the same digest — otherwise CI on Linux would report drift
    // against an artifact generated on Windows for every single file.
    mix(f.text.replace(/\r\n/g, '\n'));
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Build the committed artifact from source text. */
export function buildSecurityGraphArtifact(input: BuildInput): SecurityGraphArtifact {
  const skipped: SkippedSubject[] = [];
  const scanScopes: ScanScopeReport[] = [];

  // ── DETERMINISM IS A CORRECTNESS PROPERTY HERE, NOT A NICETY ──────────
  //
  // The artifact is COMMITTED, and CI re-runs this extractor to prove the
  // committed bytes still describe the tree. That comparison is over the graph,
  // so node ORDER is part of the artifact's identity.
  //
  // The caller walks the filesystem, and `readdirSync` returns entries in an
  // OS-dependent order: a Windows checkout and an ubuntu-latest runner enumerate
  // the same directory differently — measured, the first divergence was
  // `access-governance/reviews/route.ts` vs `access-governance/reviews/[id]/…`,
  // i.e. where a bracketed dynamic segment sorts. Without this sort the drift
  // gate reports DRIFT on every CI run for an artifact whose CONTENT is
  // identical, which would train everyone to ignore it — a gate that cries wolf
  // is worse than no gate.
  //
  // Sorted here rather than in the CLI so the property holds for every caller,
  // and by the same comparison `inputsDigest` already uses.
  const files = [...input.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const allowlistPrefixes = input.routeGuardSource
    ? parseAllowlistPrefixes(input.routeGuardSource)
    : [];
  if (input.routeGuardSource === null) {
    skipped.push({
      subject: 'scripts/ci/check-route-guards.mjs',
      reason:
        'guard source not supplied, so ALLOWLIST_PREFIXES could not be read and every ' +
        'verdict-call node is emitted with allowlisted: false. That understates C3 — an ' +
        'allowlisted route on an untested premise (#3607) will not be reported.',
    });
  } else if (allowlistPrefixes.length === 0) {
    // THE PRESENT-BUT-UNPARSEABLE ARM, WHICH USED TO DEGRADE IN SILENCE.
    //
    // `parseAllowlistPrefixes` returns `[]` both when the guard genuinely declares
    // no prefixes and when it declares them under a name this parser no longer
    // finds. Measured 2026-08-24 by renaming `ALLOWLIST_PREFIXES` upstream: the
    // `allowlisted: true` count went 23 -> 0 while the node count (909), the
    // skipped count (243) and the inputs digest all held IDENTICAL, and the whole
    // suite stayed green. An ordinary refactor in `check-route-guards.mjs` would
    // have switched this arm off permanently with no entry in any ledger.
    //
    // An empty parse over a PRESENT source is therefore recorded exactly as the
    // absent-source case is. It is the same understatement of C3 and it deserves
    // the same countable line — `__tests__/no-estate-identifiers.test.ts` asserts
    // this entry is ABSENT on the real tree, so the transition is loud in both
    // directions rather than only recoverable by reading the parser.
    skipped.push({
      subject: 'scripts/ci/check-route-guards.mjs (ALLOWLIST_PREFIXES)',
      reason:
        'the guard source WAS read but the ALLOWLIST_PREFIXES parse yielded ZERO prefixes, so ' +
        'every verdict-call node is emitted with allowlisted: false. Either the guard genuinely ' +
        'declares no prefixes now, or the declaration was renamed/reshaped and this parser no ' +
        'longer finds it — this extractor does not establish which, and asserts neither. Both ' +
        'UNDERSTATE C3: an allowlisted route on an untested premise (#3607) cannot be reported ' +
        'when nothing is marked allowlisted.',
    });
  }

  const routes = extractRouteNodes(files, allowlistPrefixes);
  // THE INDEPENDENT DENOMINATOR. `routes.filesMatched` is what the walk counted;
  // this is the same population counted by a predicate the walk does not call.
  // A loop-level narrowing is already refused inside `extractRouteNodes` by the
  // judged-after-verdict contract; this catches the other half — a narrowing
  // applied while `candidates` is being BUILT, which would shrink both sides of
  // that contract together. See `population-contract.ts`.
  assertCensusAgrees(
    'app/**/route.ts',
    routes.filesMatched,
    files.filter((f) => isRouteModule(f.path)).length,
    'build.ts#isRouteModule over the supplied files, which does not call routePathOf',
  );
  scanScopes.push({
    scope: 'app/**/route.ts (console BFF routes)',
    filesMatched: routes.filesMatched,
    nodesEmitted: routes.nodes.length,
  });
  skipped.push(...routes.skipped);

  // THE SCOPE THAT IS REPORTED IS THE SCOPE THAT WAS WALKED.
  //
  // Both of the next two values descend from `input.publicationRoots`, so the
  // partition and the label cannot disagree with each other. They used to: this
  // filter was `startsWith('scripts/') || startsWith('.github/')` with a matching
  // hand-written label, while the CLI walked `scripts/` alone. Measured on the
  // committed artifact — 0 `.github` nodes, 0 `skipped` entries naming it — the
  // `.github/` arm was dead code and the label was a false claim in published
  // bytes.
  const publicationRoots = [...input.publicationRoots].sort();
  for (const root of publicationRoots) {
    if (files.some((f) => f.path.startsWith(root))) continue;
    throw new Error(
      `[security-extract] declared publication root '${root}' matched ZERO supplied files. ` +
        'Either the caller did not walk it or the root is wrong — and an artifact that names a ' +
        'root nothing was read from overstates its own scope, which is the exact defect this ' +
        'check exists to refuse.',
    );
  }

  const scriptFiles = files.filter((f) => publicationRoots.some((r) => f.path.startsWith(r)));
  const publications = extractPublicationNodes(scriptFiles);
  assertCensusAgrees(
    publicationRoots.map((r) => `${r}**`).join(', '),
    publications.filesMatched,
    scriptFiles.filter((f) => PUBLICATION_LANGUAGES.some((ext) => f.path.endsWith(ext))).length,
    'build.ts#PUBLICATION_LANGUAGES over the root-filtered files',
  );
  scanScopes.push({
    scope: `${publicationRoots.map((r) => `${r}**`).join(', ')} (CI publication surfaces)`,
    filesMatched: publications.filesMatched,
    nodesEmitted: publications.nodes.length,
  });
  skipped.push(...publications.skipped);

  // WHAT WAS SEEN UNDER A SCANNED ROOT AND NOT READ.
  //
  // The scope report above now names only what was actually read, so the
  // remaining narrowing — everything under those roots that is not
  // JavaScript/TypeScript — has to be stated somewhere countable or it reads as
  // absence. A workflow YAML `run:` block and a `.sh` step publish to the same
  // PUBLIC Actions log a `console.log` does; this extractor does not lex either.
  for (const surface of input.unmodeledPublicationSurfaces ?? []) {
    if (surface.fileCount === 0) continue;
    skipped.push({
      subject: `${surface.root}** (${surface.extensions.map((e) => `*${e}`).join(', ')})`,
      reason:
        `${surface.fileCount} file(s) under a SCANNED root were seen and NOT read: this ` +
        'extractor lexes JavaScript/TypeScript only, so a workflow YAML `run:` block, a shell ' +
        'step or a Python script is outside the examined population even though it publishes to ' +
        'the same PUBLIC Actions log. C4 output therefore says nothing about these files. ' +
        'Recorded with a count so the narrowing is countable rather than inferred from a scope ' +
        'string — which is how the `.github/**` gap survived until 2026-08-24.',
    });
  }

  // THE INERT ARM, RECORDED AS A NUMBER.
  //
  // C4 has two arms: the spawn-stdio arm (fires when the child is not proven to
  // redact) and the expression arm (fires when a sink carries sensitive data and
  // is not wholly bounded). Measured by mutation on 2026-08-24: forcing
  // `carriesSensitive` to `false` did NOT move the C4 finding count (14 -> 14),
  // because the expression arm matched ZERO of the non-spawn sinks on this tree.
  //
  // That is not a reason to widen the rule — widening it over ~2,100 `console.log`
  // sinks would produce thousands of criticals and get the detector switched off.
  // It IS a reason to say so out loud: the expression arm is UNEXERCISED here, so
  // its correctness is untested by the real corpus, and a reader must not take
  // C4's output as evidence that no unbounded sensitive write exists.
  if (publications.sinkCounts.sensitiveNonSpawn === 0 && publications.sinkCounts.total > 0) {
    skipped.push({
      subject: 'C4 expression arm (carriesSensitive)',
      reason:
        `matched 0 of ${publications.sinkCounts.total - publications.sinkCounts.spawnStdio} ` +
        'non-spawn publication sink(s), so every C4 finding on this tree comes from the ' +
        'spawn-stdio arm. The expression arm is INERT here and its correctness is therefore ' +
        'unexercised by the real corpus — C4 output is not evidence that no unbounded ' +
        'sensitive write exists.',
    });
  }

  const nodes: SecurityNode[] = [...routes.nodes, ...publications.nodes];
  const edges = deriveEdges(nodes);

  const graph: SecurityGraph = {
    nodes,
    edges,
    annotations: {
      // C9 is not extracted, so no cluster size is DECLARED. An empty record is
      // the honest value: C9 reads `expectedPredicateClusterSize[key]` and skips
      // the size assertion when it is `undefined`, which is correct — asserting a
      // count nobody declared would manufacture a finding out of nothing.
      expectedPredicateClusterSize: {},
    },
    source: 'extracted',
  };

  const join = buildJoin(nodes);
  assertJoinCoversGraph(join, nodes);

  return {
    graph,
    join,
    meta: {
      generatorVersion: GENERATOR_VERSION,
      generatedAt: input.now.toISOString(),
      commit: input.commit,
      inputsDigest: inputsDigest(files),
      filesScanned: files.length,
      scanScopes,
      skipped,
    },
  };
}

/**
 * `calls` edges from a route's authorizer to the verdict calls in the same handler.
 *
 * Both node ids embed the source path and the HTTP method, so the pairing is
 * derived rather than guessed. This is the one edge relation the extraction
 * genuinely establishes; see the module docblock for why there are not more.
 */
function deriveEdges(nodes: readonly SecurityNode[]): SecurityEdge[] {
  const authorizers = new Map<string, SecurityNode>();
  for (const n of nodes) {
    if (n.kind !== 'authorizer') continue;
    authorizers.set(n.id, n);
  }

  const edges: SecurityEdge[] = [];
  for (const n of nodes) {
    if (n.kind !== 'verdict-call') continue;
    const hash = n.id.lastIndexOf('#');
    if (hash < 0) continue;
    const path = n.id.slice('sec:verdict-call:'.length, hash);
    const method = n.id.slice(hash + 1).split(':')[0];
    const authorizerId = `sec:authorizer:${path}#${method}`;
    if (!authorizers.has(authorizerId)) continue;
    edges.push({
      id: `sec-edge:calls:${authorizerId}->${n.id}`,
      from: authorizerId,
      to: n.id,
      kind: 'calls',
      provenance: 'declared',
    });
  }
  return edges;
}

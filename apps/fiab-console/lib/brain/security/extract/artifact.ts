/**
 * LOOM BRAIN — SECURITY EXTRACTION: refusing an artifact that cannot be trusted.
 *
 * ── THE STATE THIS FILE EXISTS TO MAKE REACHABLE ─────────────────────────
 *
 * `SecurityGraph.source` has exactly three members — `'modelled' | 'extracted' |
 * 'observed'` — and NONE of them means "there is no graph". So the type cannot
 * represent absence, and a producer that must nevertheless answer something has
 * only two honest options: return a real graph, or return a refusal in a wrapper
 * type that CAN say no. This file is the second.
 *
 * The failure it prevents is specific and this repo has shipped it: an UNKNOWN
 * reported as a NEGATIVE. A sweep over an empty or wrong-version graph produces zero
 * security findings, and zero findings renders identically to "we looked and the
 * estate is clean". The distinction is invisible downstream unless it is refused
 * HERE, before a detector ever runs.
 *
 * A live instance of exactly that pattern sits one directory away and is worth
 * naming so it is not copied: `lib/brain/live-graph.ts:215` hard-codes
 * `configured.collected: true` regardless of whether the env read actually
 * succeeded, which makes a NOT-EVALUATED state unreachable on that lane. Nothing
 * in this file may be written that way. Every refusal below is reachable, and
 * `__tests__/artifact.test.ts` reaches every one of them — a guard whose refusal
 * branch no test can enter is not a guard.
 *
 * ── WHY A ZERO-NODE GRAPH IS REFUSED RATHER THAN SWEPT ───────────────────
 *
 * Handing an empty graph to the detectors is TEMPTING and is nearly right: all
 * nine would synthesise `POP-population-integrity` findings reading "examined an
 * EMPTY population — green and blind", which is the correct sentiment. It is
 * still refused, because a consumer that filters to SECURITY findings — which
 * `securityFindingsOf()` exists to do, and which any "how many risks?" count will
 * do — gets zero, and zero is indistinguishable from clean. The refusal is not
 * redundant with the detectors' own contract; it covers the reader the detectors'
 * contract cannot reach.
 */

import type { SecurityGraph } from '../substrate';
import type { SecurityGraphArtifact } from './types';
import { GENERATOR_VERSION } from './build';
import { assertJoinCoversGraph } from './join';

/**
 * The seam's contract, restated structurally.
 *
 * Byte-compatible with `app/api/admin/brain/_lib/security-source.ts`'s
 * `SecurityGraphSource` (introduced by #3992), so that seam's
 * `loadSecurityGraph()` can `return loadExtractedSecurityGraph();` and change
 * nothing else. It is declared here rather than imported because that file lives
 * on the #3992 branch and not on `main` — importing it would make this package
 * depend on an unmerged PR.
 */
export type SecurityGraphSource =
  | { readonly available: true; readonly graph: SecurityGraph }
  | { readonly available: false; readonly reason: string };

/**
 * WHY THERE IS NO AGE REFUSAL ANY MORE (#4798).
 *
 * This module used to refuse an artifact whose committed `meta.generatedAt` was
 * over 90 days old. That timestamp is gone from the committed bytes: it differed
 * on every run, so every pair of PRs that regenerated the artifact conflicted on
 * it. Keeping it as "last regenerated" would not have saved the refusal either,
 * because a merge-stable artifact is only regenerated when a node, edge or
 * ledger entry moves — a correct artifact over a quiet stretch of the tree would
 * then be refused as STALE, and `generated-sweep.test.ts` (which resolves the
 * committed artifact against the real clock) would go red on a calendar date.
 *
 * What the age check stood in for is now established directly. `--check`, a
 * REQUIRED context on `main`, re-extracts and compares on every merge, so the
 * artifact inside an image built from `main` IS the extraction of that image's
 * own source. How far that image trails `main` is `deploy-integrity.md` R3's
 * question, surfaced by the deploy-status lane, not something an artifact
 * timestamp could answer.
 */

/** Shared prefix so every refusal reads as the same, deliberate state. */
const NOT_EVALUATED =
  'NOT EVALUATED — no risk verdict has been drawn, and this is NOT a clean result.';

/**
 * Decide whether an artifact may be swept, or why it may not.
 *
 * Never throws: a malformed artifact must degrade to an honest refusal on the
 * surface, not to a 500 that hides the reason.
 */
export function resolveSecurityGraph(artifact: SecurityGraphArtifact | null): SecurityGraphSource {
  if (artifact === null) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} No extracted security graph shipped with this build. The nine ` +
        'detectors in lib/brain/security run over a graph of the SOURCE (authorizers, verdict ' +
        'calls, publication sinks), and the console reads Azure Resource Graph, not the ' +
        'repository it was built from — so the graph has to be produced at build time by ' +
        '`scripts/brain/extract-security-graph.mjs` and committed. It was not, so nothing was ' +
        'examined.',
    };
  }

  // SHAPE CHECK BEFORE ANY FIELD READ.
  //
  // The artifact is a JSON file on disk. A cast at the import boundary says what
  // it SHOULD be, and says nothing about what it IS after a bad merge, a partial
  // write or a hand-edit. Reading `meta.generatorVersion` off a malformed
  // artifact throws, and an exception here becomes a 500 that hides the reason —
  // the opposite of the honest refusal this module exists to produce.
  if (
    typeof artifact !== 'object' ||
    artifact.graph === null ||
    typeof artifact.graph !== 'object' ||
    !Array.isArray(artifact.graph.nodes) ||
    artifact.meta === null ||
    typeof artifact.meta !== 'object' ||
    artifact.join === null ||
    typeof artifact.join !== 'object'
  ) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped artifact is malformed — it does not carry the graph, join ` +
        'and meta an extraction produces. It cannot be swept, and it is refused rather than ' +
        'partially read, because a partial read would report a smaller population as a complete one.',
    };
  }

  if (artifact.meta.generatorVersion !== GENERATOR_VERSION) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph was produced by extractor version ` +
        `${artifact.meta.generatorVersion}, and this build expects ${GENERATOR_VERSION}. The ` +
        'extraction semantics changed between them, so the facets this graph carries are not ' +
        "the facts today's detectors read. Re-run the extractor and commit the result.",
    };
  }

  if (artifact.graph.source !== 'extracted') {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph declares source '${artifact.graph.source}', not ` +
        "'extracted'. A 'modelled' graph is hand-authored from the taxonomy's described shapes " +
        'and is NOT an estate measurement; rendering one as a live verdict is the precise error ' +
        'deploy-integrity R7 forbids.',
    };
  }

  if (artifact.graph.nodes.length === 0) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph contains ZERO nodes. A sweep over it would report ` +
        'zero security findings, which is indistinguishable from a clean estate — so it is ' +
        'refused rather than swept. Either the extractor matched no files (check the scan ' +
        'scopes in the artifact meta) or its analyzers emitted nothing.',
    };
  }

  try {
    assertJoinCoversGraph(artifact.join, artifact.graph.nodes);
  } catch (e) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph's estate join does not account for every node: ` +
        `${e instanceof Error ? e.message : String(e)} A finding on an unaccounted node would ` +
        'render on no surface, so the artifact is refused rather than partially trusted.',
    };
  }

  return { available: true, graph: artifact.graph };
}

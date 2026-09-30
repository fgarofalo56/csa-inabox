/**
 * LOOM BRAIN — SECURITY GRAPH EXTRACTION: the artifact envelope.
 *
 * ── WHY AN ENVELOPE AND NOT JUST A `SecurityGraph` ────────────────────────
 *
 * `SecurityGraph` (../substrate.ts) is a closed shape: `nodes`, `edges`,
 * `annotations`, `source`. It carries no room for the three things a PRODUCER
 * must say and a CONSUMER must be able to refuse on:
 *
 *   1. WHICH EXTRACTOR produced it. A consumer must be able to refuse a graph
 *      whose facets were derived by different predicates than today's
 *      detectors read. -> {@link ExtractionMeta}. (When and from which inputs a
 *      run happened is {@link ExtractionRun}, which is deliberately NOT
 *      committed — see there for why, #4798.)
 *   2. WHICH ESTATE OBJECT each finding belongs to. The security side is keyed
 *      by SOURCE coordinates (`lib/api/route-toolkit.ts#withTenantAdmin`); the
 *      waste side is keyed by ARM ids (`azure:/subscriptions/...`). The two id
 *      spaces are disjoint, so a finding cannot be painted onto the estate
 *      without something minting a join. -> {@link SecurityGraphJoin}.
 *   3. WHAT WAS SCANNED, and what was deliberately not. Per ../population.ts
 *      the dominant measured evasion in this repo is falling outside the
 *      examined population. That applies to the EXTRACTOR at least as much as
 *      to the detectors: a detector reporting `ratio: 1.0` over a graph built
 *      from three files is not measuring the repo. -> {@link ScanScopeReport}.
 *
 * Extending `SecurityGraph` itself was the alternative and was rejected:
 * `substrate.ts` is not this lane's file, the detectors and their specs are
 * pinned to its exact shape, and a producer-specific field on a consumer-facing
 * type is the wrong direction of dependency. The envelope wraps; it does not
 * modify. `artifact.graph` is a plain `SecurityGraph` and every detector
 * consumes it unchanged.
 *
 * ── NOTHING IN HERE MAY CARRY AN ESTATE IDENTIFIER ────────────────────────
 *
 * This repo is PUBLIC and the artifact is COMMITTED. So the join records a
 * LOGICAL app name (`loom-console`) — the name the bicep gives the Container
 * App — and never a subscription id, resource group, tenant id or hostname.
 * Resolving `loom-console` to a live `azure:/subscriptions/...` node is the
 * RUNTIME's job, where the estate is actually known. That split is also what
 * makes the artifact cloud-neutral by construction: the same bytes are correct
 * in Commercial, GCC, GCC-High, IL5 and DoD because they name no cloud.
 * `__tests__/no-estate-identifiers.test.ts` asserts it rather than trusting it.
 */

import type { SecurityGraph } from '../substrate';

/** One source file handed to the extractor. The extractor never reads a disk. */
export interface SourceFile {
  /** Repo-relative, forward slashes, e.g. `apps/fiab-console/app/api/x/route.ts`. */
  readonly path: string;
  readonly text: string;
}

/**
 * A security node that WAS joined to a deployable unit.
 *
 * `deployedAs` is a LOGICAL name, never an ARM id — see the module docblock.
 */
export interface PaintedNode {
  readonly nodeId: string;
  /**
   * The waste-graph join key: `code:<lowercased repo-relative path>`.
   *
   * Byte-identical to what `lib/brain/graph/node-id.ts#codeModuleNodeId` mints
   * for the same path, so a consumer can look the module up in the waste graph
   * directly. That equality is ASSERTED by `__tests__/join.test.ts` against the
   * real `codeModuleNodeId`, not assumed — see `join.ts` for why this package
   * re-implements the canonicalization instead of importing it.
   */
  readonly codeModuleId: string;
  /** The logical app that serves this module, e.g. `loom-console`. */
  readonly deployedAs: string;
}

/**
 * A security node that could NOT be joined, with the reason.
 *
 * This is a first-class outcome, not a failure. A publication sink in
 * `scripts/ci/**` runs in GitHub Actions and has NO Azure estate presence at
 * all; painting it onto a Container App would be an invented edge. #3992
 * already renders an `unjoined` lane for exactly this, so the honest answer is
 * to populate it.
 */
export interface UnjoinedNode {
  readonly nodeId: string;
  readonly codeModuleId: string;
  readonly reason: string;
}

/**
 * The join, as a POPULATION rather than a list.
 *
 * `painted.length + unjoined.length` MUST equal the graph's node count.
 * `assertJoinCoversGraph` in `join.ts` enforces it, because a node that is
 * silently in neither bucket is a finding that exists in the graph and appears
 * on no surface — the same "fell outside the examined population" failure the
 * detectors are built to refuse, applied to the join.
 */
export interface SecurityGraphJoin {
  readonly painted: readonly PaintedNode[];
  readonly unjoined: readonly UnjoinedNode[];
}

/**
 * One declared scan scope, as COMMITTED: its name and nothing that counts.
 *
 * The counts live on {@link ScanScopeCount} in {@link ExtractionRun}, which is
 * never written to the committed file (#4798). A per-scope `filesMatched` moves
 * whenever ANY file is added under the scope, so two PRs that each add an
 * unrelated file both rewrote the same line and every open PR conflicted after
 * each merge. Worse, two PRs that each moved it by one merged CLEANLY to a value
 * that was wrong for both files together.
 */
export interface ScanScopeReport {
  /** e.g. `apps/fiab-console/app/api/**\/route.ts`. */
  readonly scope: string;
}

/** What one scan scope matched and produced on ONE extractor run. Never committed. */
export interface ScanScopeCount extends ScanScopeReport {
  readonly filesMatched: number;
  readonly nodesEmitted: number;
}

/**
 * A file the caller SAW under a scanned root and did NOT hand to the extractor,
 * because its language is not one the extractor reads.
 *
 * This exists because of a measured defect. Until 2026-08-24 the artifact
 * declared its publication scope as `scripts/**, .github/**` while the CLI
 * walked only `scripts/`: the `.github/` arm of the filter in `build.ts` and the
 * `.github/workflows/` entry in `join.ts` were both DEAD, and the committed
 * artifact carried 0 `.github` nodes and 0 `skipped` entries mentioning it.
 * `.github/scripts/deploy-notify-failure.mjs` — a failure notifier, i.e. exactly
 * the publication surface C4 exists to find — sat silently outside a population
 * the artifact's own scope report claimed to cover.
 *
 * `.github/**` is scanned for real now. What remains genuinely unread is
 * everything that is not JavaScript/TypeScript: a workflow YAML `run:` block, a
 * shell script, a Python script. Those publish to the same public Actions log,
 * so the narrowing is REPORTED with counts rather than left to be inferred from
 * a scope string. Per {@link SkippedSubject}: a gap that is recorded is a gap
 * that can be closed.
 */
export interface UnmodeledSurface {
  /** The scanned root, e.g. `.github/`. */
  readonly root: string;
  /** How many files under it were seen and not read. */
  readonly fileCount: number;
  /** The extensions involved, sorted, e.g. `['sh', 'yml']`. */
  readonly extensions: readonly string[];
}

/**
 * A subject the extractor saw and deliberately did not model.
 *
 * Mirrors `ExtractionResult.skipped` on the waste side. A gap that is recorded
 * is a gap that can be closed; a gap that is silently dropped reads as absence.
 */
export interface SkippedSubject {
  readonly subject: string;
  readonly reason: string;
}

/**
 * The COMMITTED meta. Every field here is a property of what the graph says, and
 * none is a tree-wide tally, a clock or a sha (#4798).
 *
 * The rule a new field must satisfy: two PRs that each add one unrelated file
 * under a scanned scope must leave it either untouched or changed on DIFFERENT
 * lines. A count over the whole scope fails that by construction, and belongs on
 * {@link ExtractionRun}.
 */
export interface ExtractionMeta {
  /**
   * Bumped whenever the extraction SEMANTICS change.
   *
   * The runtime refuses an artifact whose version it does not recognise, so a
   * graph produced by an older extractor cannot be silently rendered as if the
   * current predicates had run over it.
   */
  readonly generatorVersion: number;
  readonly scanScopes: readonly ScanScopeReport[];
  readonly skipped: readonly SkippedSubject[];
}

/**
 * What ONE extractor run measured. Printed by the CLI, used for the population
 * floor in `--check`, and NEVER written to the committed file (#4798).
 *
 * Until #4798 all of this sat in `meta`. `inputsDigest`, `generatedAt` and
 * `commit` differ on every run; `filesScanned`, the per-scope counts, the unread
 * file counts and the non-spawn sink total move whenever any file is added under
 * a scanned root. So every PR that touched the artifact conflicted with every
 * other one after each merge, and each resolution was a content push that
 * voided every review verdict on it.
 */
export interface ExtractionRun {
  /** ISO-8601 wall clock of this run. */
  readonly generatedAt: string;
  /** The commit the scan ran against, when the generator could determine one. */
  readonly commit: string | null;
  /** A digest over (path, text) of every scanned file. See `build.ts#inputsDigest`. */
  readonly inputsDigest: string;
  readonly filesScanned: number;
  readonly scanScopes: readonly ScanScopeCount[];
  /** What was seen under a scanned root and not read, WITH the counts. */
  readonly unmodeledPublicationSurfaces: readonly UnmodeledSurface[];
  /** Publication sinks that are not spawn stdio — the population C4's expression arm runs over. */
  readonly nonSpawnSinks: number;
}

/**
 * The committed, build-time artifact.
 *
 * `graph.source` is always `'extracted'` here. There is deliberately no way to
 * construct this envelope around a `'modelled'` graph: the whole point of the
 * provenance field is that a consumer can tell an extraction from a hand-authored
 * fixture, and a producer that can relabel one as the other erases the
 * distinction the type exists to carry.
 */
export interface SecurityGraphArtifact {
  readonly graph: SecurityGraph;
  readonly join: SecurityGraphJoin;
  readonly meta: ExtractionMeta;
}

/** The committed artifact plus what the run that produced it measured. */
export interface SecurityGraphExtraction {
  readonly artifact: SecurityGraphArtifact;
  readonly run: ExtractionRun;
}

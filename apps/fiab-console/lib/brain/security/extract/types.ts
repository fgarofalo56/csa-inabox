/**
 * LOOM BRAIN — SECURITY GRAPH EXTRACTION: the artifact envelope.
 *
 * ── WHY AN ENVELOPE AND NOT JUST A `SecurityGraph` ────────────────────────
 *
 * `SecurityGraph` (../substrate.ts) is a closed shape: `nodes`, `edges`,
 * `annotations`, `source`. It carries no room for the three things a PRODUCER
 * must say and a CONSUMER must be able to refuse on:
 *
 *   1. WHEN it was produced, from WHICH inputs. A graph baked into a container
 *      image describes the source tree as it was at image-build time. A
 *      consumer that renders a 200-day-old artifact as a current verdict is
 *      committing the stale-read defect, and nothing in `SecurityGraph` lets it
 *      even ask. -> {@link ExtractionMeta}.
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

/** What one scan scope matched and produced. */
export interface ScanScopeReport {
  /** e.g. `apps/fiab-console/app/api/**\/route.ts`. */
  readonly scope: string;
  readonly filesMatched: number;
  readonly nodesEmitted: number;
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

export interface ExtractionMeta {
  /**
   * Bumped whenever the extraction SEMANTICS change.
   *
   * The runtime refuses an artifact whose version it does not recognise, so a
   * graph produced by an older extractor cannot be silently rendered as if the
   * current predicates had run over it.
   */
  readonly generatorVersion: number;
  /** ISO-8601. The basis of the staleness refusal in `artifact.ts`. */
  readonly generatedAt: string;
  /** The commit the scan ran against, when the generator could determine one. */
  readonly commit: string | null;
  /**
   * A digest over (path, text) of every scanned file.
   *
   * Lets CI re-run the extractor and prove the committed artifact still matches
   * the tree — the drift check that keeps a stale artifact from surviving a
   * merge. The RUNTIME cannot recompute it (no checkout in the container), which
   * is precisely why the runtime falls back to the age check instead.
   */
  readonly inputsDigest: string;
  readonly filesScanned: number;
  readonly scanScopes: readonly ScanScopeReport[];
  readonly skipped: readonly SkippedSubject[];
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

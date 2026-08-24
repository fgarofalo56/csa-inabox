/**
 * LOOM BRAIN — the WIRE CONTRACT between the BFF and the visualizer.
 *
 * THE POINT OF THIS FILE IS THAT THERE IS EXACTLY ONE PAYLOAD.
 *
 * PRP §3.6: "the picture and the analysis are the same data, so they cannot
 * disagree." That is a claim about ARCHITECTURE, and it is only true if the
 * graph and the findings are computed from ONE graph build, in ONE request, and
 * shipped together. Two endpoints — `/graph` and `/findings` — would each build
 * their own graph from their own Resource Graph pull, taken seconds apart, and
 * would eventually disagree: a finding would name a node the canvas is not
 * drawing, or the canvas would draw a node no finding covers, and there would be
 * no way to tell which half was stale.
 *
 * So: ONE route, ONE `BrainSnapshot`. Findings reference nodes BY `NodeId`, and
 * `__tests__/ui/snapshot-coherence.test.ts` asserts that every id a finding
 * names is present in the node set of the same snapshot. That test is the
 * enforcement; this doc-block is only the reason.
 *
 * ── WHY THESE ARE NOT JUST THE `lib/brain` TYPES ───────────────────────────
 * `BrainNode` / `BrainEdge` are a discriminated union with branded ids and
 * `readonly` everything — excellent in the library, and they survive
 * `JSON.stringify` unchanged. What does NOT survive is the type-level
 * guarantee: after a round trip through HTTP the client holds `unknown`, and a
 * cast would re-assert P2 (dangling cannot carry a target) on the word of the
 * person writing the cast.
 *
 * These wire types therefore keep the DISCRIMINATORS as data — `resolution`,
 * `provenance`, `danglingReason` — and the client renders off those fields
 * rather than re-deriving reachability. The client NEVER recomputes "is this
 * node reachable"; the server states it, and the client draws it. One
 * computation, one answer.
 *
 * ── TYPE-ONLY IMPORTS, DELIBERATELY ────────────────────────────────────────
 * Client components import from this module. Every import below is `import
 * type`, so nothing from `lib/brain/graph` (or anything it pulls) is emitted
 * into the client bundle — the types erase at compile time.
 */

import type {
  Confidence,
  CostFigure,
  DanglingReason,
  EdgeEvidence,
  EdgeProvenance,
  FindingSeverity,
  IngressFacts,
  NodeKind,
  Population,
  RemediationProposal,
  ScaleFacts,
  SkippedSubject,
} from '@/lib/brain/graph';

/**
 * A node as the canvas draws it.
 *
 * `unreachable` and `alwaysOn` are SERVER-COMPUTED verdicts carried as data.
 * The client must not re-derive them: reachability is "zero inbound RESOLVED
 * edges of provenance `configured`", and a client that recounted edges from the
 * `edges` array would have to re-implement the resolved/dangling exclusion —
 * i.e. re-implement P2, in a second place, where it can drift. It is computed
 * once, on the server, by the library that owns the invariant.
 */
export interface WireNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly displayName: string;
  /** ARM type for azure-resource nodes; absent otherwise. */
  readonly resourceType?: string;
  readonly subscriptionId?: string;
  readonly resourceGroup?: string;
  readonly location?: string;
  readonly provisioningState?: string;
  readonly scale?: ScaleFacts;
  readonly ingress?: IngressFacts;
  /**
   * `null` means the tags could NOT be read — INDETERMINATE, not "no tags".
   * The visualizer renders that state differently from an empty tag set,
   * because a fail-open ownership read on this estate reaches 12 non-Loom
   * environments (PRP §1 decision 1).
   */
  readonly tags: Readonly<Record<string, string>> | null;
  readonly tagsError?: string;

  // ── server-computed verdicts ────────────────────────────────────────────
  /** Inbound RESOLVED edge counts, by provenance. Dangling edges are excluded. */
  readonly inboundByProvenance: Readonly<Record<EdgeProvenance, number>>;
  readonly outboundTotal: number;
  /**
   * Zero inbound resolved `configured` edges. THE founding verdict.
   *
   * Read `coverage.configured.collected` before believing it: over a graph with
   * no `configured` edges at all this is vacuously true of every node.
   */
  readonly unreachableConfigured: boolean;
  /** `scale.minReplicas > 0`. `false` when scale was NOT MEASURED — see `scaleMeasured`. */
  readonly alwaysOn: boolean;
  /** False means scale facts were absent: NOT MEASURED, never "zero replicas". */
  readonly scaleMeasured: boolean;
  /**
   * An `owns` edge names this node. With zero `owns` edges estate-wide (the
   * measured state on 2026-08-23) this is false for EVERYTHING, which is why it
   * is reported rather than assumed — see {@link OwnershipCoverage}.
   */
  readonly ownershipConfirmed: boolean;
  /** Dangling edges whose `intendedTo` is this node — the evidence chain. */
  readonly danglingIntendedFor: number;
}

/** An edge as the canvas draws it. The discriminator is DATA, not a cast. */
export interface WireEdge {
  readonly id: string;
  readonly provenance: EdgeProvenance;
  readonly from: string;
  /** `null` on a dangling edge — that is what excludes it from reachability. */
  readonly to: string | null;
  readonly resolution: 'resolved' | 'dangling';
  /** Present only when `resolution === 'dangling'`. */
  readonly danglingReason?: DanglingReason;
  /** Who the wire was MEANT to reach. `null` means the intent is unknown (R7). */
  readonly intendedTo?: string | null;
  readonly evidence: EdgeEvidence;
}

/**
 * Whether a provenance was actually COLLECTED, and what follows if it was not.
 *
 * THIS IS THE MOST IMPORTANT TYPE IN THE FILE. The deployed console can read
 * Azure Resource Graph; it cannot read the repository. So at runtime it produces
 * `configured` and `owns` edges and produces NO `declared` (bicep) or `imports`
 * (source) or `observed` (telemetry) edges.
 *
 * A query for "nodes with no inbound `declared` edge" over a graph containing
 * zero `declared` edges returns EVERY NODE, and every one of those answers is
 * vacuous. `Population.blind` does NOT fire there — the node set was not empty
 * — so a caller reading only `blind` would ship a screen full of confident
 * false findings.
 *
 * `collected: false` is therefore a hard stop: detectors that depend on the
 * provenance emit ZERO findings and say why, and the UI renders the gap.
 */
export interface ProvenanceCoverage {
  readonly collected: boolean;
  readonly edgeCount: number;
  /** What produced these edges, or — when `collected` is false — why nothing did. */
  readonly note: string;
}

/**
 * The ownership picture, reported rather than inferred.
 *
 * MEASURED 2026-08-23: ZERO of the container-tier resources carry
 * `loom-estate-id`. Present tags are `CSA_Loom`, `loom-next-level`, `csa-loom`,
 * `loom-band`, `loom-item` — none of them estate-scoped, so none of them can
 * tell two Loom estates apart, and none is a safe basis for recommending a
 * mutation.
 *
 * Do NOT "fix" this by widening the ownership key to match those tags. That
 * substitutes a guess for a measurement, and the blast radius of a wrong guess
 * here is 12 non-Loom Container App environments — the operator's blog,
 * Sentinel, two Atlas estates and more. The fix is the deploy stamping the tag.
 */
export interface OwnershipCoverage {
  /** Nodes carrying an `owns` edge. */
  readonly confirmed: number;
  /** Azure resource nodes considered. */
  readonly examined: number;
  /** Nodes whose tags could not be read at all — indeterminate, not unowned. */
  readonly indeterminate: number;
  /**
   * True when NOTHING is ownership-confirmed. Every cleanup proposal is
   * withheld in that state, and the UI says so.
   */
  readonly blind: boolean;
  readonly note: string;
}

/** A finding, with its evidence chain flattened for transport. */
export interface WireFinding {
  readonly id: string;
  readonly detector: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly subjects: readonly string[];
  readonly confidence: Confidence;
  readonly cost?: CostFigure;
  /** Pre-rendered via `formatCostFigure` so a derived number cannot reach the UI bare. */
  readonly costLabel?: string;
  readonly remediation: RemediationProposal;
  readonly population: Population;
  readonly evidence: {
    readonly nodes: readonly string[];
    readonly edges: readonly string[];
    readonly query: string;
    readonly notes: readonly string[];
  };
  /**
   * False when no `owns` edge covers the subjects. The finding is still
   * REPORTED (PRP §1 decision 4: reports cover all subscriptions) but its
   * remediation is NOT offered for approval, because a cleanup scoped by a
   * guessed owner is the failure mode the recommend-only decision exists to
   * prevent.
   */
  readonly ownershipConfirmed: boolean;
}

/** What one detector examined, including the subjects it could not evaluate. */
export interface WireDetectorRun {
  readonly detector: string;
  readonly findingCount: number;
  readonly population: Population;
  readonly skipped: readonly SkippedSubject[];
  /**
   * True when the detector declined to emit a verdict because the provenance it
   * queries was never collected. NOT the same as "found nothing" — and the
   * distinction is the whole reason this field exists.
   */
  readonly vacuous: boolean;
  readonly vacuousReason?: string;
}

/** What the Resource Graph pull actually read. Reported, never assumed. */
export interface CollectionReport {
  readonly rowsFetched: number;
  /** ARG's own `totalRecords`. A mismatch with `rowsFetched` means truncation. */
  readonly totalRecords: number | null;
  readonly pages: number;
  /** True iff `totalRecords` is known AND equals `rowsFetched`. */
  readonly complete: boolean;
  readonly subscriptionsSeen: number;
  readonly containerApps: number;
  readonly containerAppJobs: number;
  readonly managedEnvironments: number;
  /** Env entries read across all container apps; `secretRef` values are NOT readable. */
  readonly envEntriesRead: number;
  readonly envEntriesEmpty: number;
  readonly envEntriesSecretRef: number;
  readonly durationMs: number;
}

/**
 * THE SINGLE PAYLOAD. One graph build; the canvas and the recommendations are
 * two renderings of it.
 */
export interface BrainSnapshot {
  readonly generatedAt: string;
  readonly nodes: readonly WireNode[];
  readonly edges: readonly WireEdge[];
  readonly findings: readonly WireFinding[];
  readonly detectors: readonly WireDetectorRun[];
  readonly coverage: Readonly<Record<EdgeProvenance, ProvenanceCoverage>>;
  readonly ownership: OwnershipCoverage;
  readonly collection: CollectionReport;
  readonly nodesByKind: Readonly<Record<NodeKind, number>>;
  readonly edgesByProvenance: Readonly<Record<EdgeProvenance, number>>;
  readonly edgesByResolution: { readonly resolved: number; readonly dangling: number };
  /** Inputs an extractor could not parse or resolve. Never silently dropped. */
  readonly skipped: readonly SkippedSubject[];
  /**
   * Which cloud this snapshot describes, as the ARM endpoint reports it. Carried
   * so a Commercial receipt can never be read as a Gov one (`cloud-parity.md`).
   */
  readonly cloud: string;
}

/** Success envelope. Fields SPREAD next to `ok` — the repo's convention. */
export interface BrainSnapshotResponse {
  readonly ok: true;
  readonly snapshot: BrainSnapshot;
}

/**
 * The recorded outcome of a HUMAN review of a proposal.
 *
 * `approved` means A PERSON AGREED WITH THE PROPOSAL. It does NOT dispatch
 * anything: the Brain is recommend-only (PRP §1 decision 1), `RemediationProposal`
 * pins `mutatesAzure: false` in the type system, and
 * `__tests__/ui/no-mutation-controls.test.tsx` asserts no control on the surface
 * can reach an Azure write. Approval produces an AUDIT RECORD and a change the
 * operator applies themselves.
 */
export type ProposalDecision = 'approved' | 'dismissed';

export interface ProposalReviewRequest {
  readonly findingId: string;
  readonly decision: ProposalDecision;
  /** Free-text rationale. Recorded verbatim in the audit event. */
  readonly note?: string;
}

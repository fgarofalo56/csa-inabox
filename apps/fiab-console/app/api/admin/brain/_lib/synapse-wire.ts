/**
 * LOOM BRAIN — THE SYNAPSE LAYER'S WIRE CONTRACT.
 *
 * The synapse view (PRP §3.7) renders four layers over the architecture graph:
 * prune candidates, risk edges, hot paths, and edges that are NEW since the last
 * graph version. Three of those are answerable from the ESTATE snapshot the
 * sibling `./wire.ts` already ships. This file describes the two that are not:
 *
 *   RISK     comes from `lib/brain/security/**`, which runs over a SECURITY
 *            graph — authorizers, verdict calls, publication sinks, predicate
 *            implementations. That is a graph of the CODE, not of the estate.
 *   HISTORY  comes from graph versioning (W9, #3935), which stores a previous
 *            graph so "an edge that should not have formed" is a diff.
 *
 * ── WHY THIS IS A SECOND PAYLOAD, WHEN `wire.ts` ARGUES FOR EXACTLY ONE ────
 *
 * `wire.ts` argues — correctly — that the estate graph and the estate FINDINGS
 * must ship together, because two routes would each pull Resource Graph seconds
 * apart and could disagree about the same subject with no way to tell which half
 * was stale.
 *
 * That argument turns on the two halves DESCRIBING THE SAME SUBJECT. These do
 * not. A `SecurityGraph` node is `lib/api/route-toolkit.ts#withTenantAdmin`; an
 * estate node is a Container App. They cannot contradict each other about a
 * shared fact because they share no facts, so the staleness failure the single-
 * payload rule prevents cannot arise between them. Keeping them apart also keeps
 * the estate read — the expensive, permission-sensitive ARG pull — out of a route
 * whose job is pure analysis over source-derived data.
 *
 * ── R7: "NOT EVALUATED" IS A FIRST-CLASS STATE, NOT AN EMPTY ARRAY ────────
 *
 * Both types below are DISCRIMINATED UNIONS on `evaluated` / `available`, with no
 * default and no "empty means clean" member. That is the whole point. A risk lane
 * that returned `findings: []` when no extractor exists is indistinguishable from
 * a risk lane that examined the estate and found it safe, and this repo's own
 * measured history (`security/population.ts`, six instances) is that the second
 * reading is the one people take. The union makes the honest state impossible to
 * omit and impossible to mistake for a clean bill of health.
 */

import type {
  Confidence,
  FindingClass,
  Severity,
} from '@/lib/brain/security';

/**
 * One security finding, flattened for transport.
 *
 * Mirrors `Finding` from `lib/brain/security/substrate.ts` field-for-field. It is
 * restated rather than re-exported for the same reason `WireNode` restates
 * `BrainNode`: after a round trip through HTTP the client holds `unknown`, and a
 * cast would re-assert the library's invariants on the word of whoever wrote the
 * cast. `remediation` in particular keeps `requiresHumanApproval: true` as a
 * LITERAL, so a payload claiming a self-approving remediation does not typecheck
 * on either side of the wire.
 */
export interface WireRiskFinding {
  readonly id: string;
  readonly detectorId: string;
  readonly findingClass: FindingClass;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly title: string;
  readonly evidence: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
    readonly query: string;
    readonly facts: readonly string[];
  };
  /**
   * DATA ONLY. There is no `apply`, no `execute`, no handler — the security
   * substrate's `DraftedRemediation` declares none, and `assertAllInert` rejects
   * one at runtime before it ever reaches this shape.
   */
  readonly remediation: {
    readonly summary: string;
    readonly proposedCommands: readonly string[];
    readonly proposedPatchDescription: string | null;
    readonly requiresHumanApproval: true;
  };
}

/**
 * What one security detector examined.
 *
 * `judged` / `candidates` is carried per detector rather than only in aggregate
 * because the aggregate hides the case that matters: eight compliant detectors
 * and one that judged 1 of 15 average out to a comfortable ratio, and the one is
 * the finding. `security/population.ts` records that exact measurement.
 */
export interface WireRiskDetectorRun {
  readonly detectorId: string;
  /** The taxonomy section this implements, e.g. 'C1'. */
  readonly taxonomyClass: string;
  readonly title: string;
  readonly judged: number;
  readonly candidates: number;
  /** `judged / candidates`; 0 when nothing was a candidate. Anything below 1 is P0. */
  readonly ratio: number;
  readonly unjudged: readonly { readonly nodeId: string; readonly reason: string }[];
  readonly findingCount: number;
}

/** The registry entry for a detector that COULD have run. */
export interface WireRiskDetectorRegistration {
  readonly detectorId: string;
  readonly taxonomyClass: string;
  readonly title: string;
}

/**
 * The risk lane.
 *
 * `evaluated: false` is NOT an error and NOT an empty result — it is the
 * statement "no security graph was available to this deployment, so no verdict
 * of any kind was drawn". It still carries the full detector registry, so the
 * operator can see WHAT would have run and count it.
 */
export type RiskLayer =
  | {
      readonly evaluated: false;
      /** What was established, in the operator's words. Never a guess (R7). */
      readonly reason: string;
      /** Every detector that would have run. Rendered so "0 findings" cannot read as "0 risk". */
      readonly registry: readonly WireRiskDetectorRegistration[];
    }
  | {
      readonly evaluated: true;
      /**
       * How the security graph was produced. `'modelled'` means hand-authored —
       * a consumer that reads a modelled graph as an estate measurement is making
       * exactly the R7 error, so the provenance rides on the payload.
       */
      readonly graphSource: 'modelled' | 'extracted' | 'observed';
      readonly findings: readonly WireRiskFinding[];
      readonly detectors: readonly WireRiskDetectorRun[];
      readonly coverage: {
        readonly judged: number;
        readonly candidates: number;
        readonly ratio: number;
        readonly incompleteDetectors: readonly string[];
      };
    };

/**
 * The previous graph version, for the "new edge" lane.
 *
 * `available: false` says the deployment stores no history, so nothing on the
 * canvas may be labelled new — including, deliberately, labelling everything new
 * on a first run, which is the obvious implementation and is a false claim.
 */
export type EdgeHistory =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly previousGeneratedAt: string;
      readonly previousEdgeIds: readonly string[];
    };

/** Success envelope. Fields SPREAD next to `ok` — the repo's convention. */
export interface SynapseLayerResponse {
  readonly ok: true;
  readonly risk: RiskLayer;
  readonly history: EdgeHistory;
}

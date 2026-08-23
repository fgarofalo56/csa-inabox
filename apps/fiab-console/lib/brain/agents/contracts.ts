/**
 * LOOM BRAIN — the agent layer's own contract.
 *
 * PRP §3.3: four LLM agents that **explain, correlate and draft — never decide
 * alone and never act**. This module holds the shapes they share. It does NOT
 * redefine anything from `../types`; it imports and extends, because the graph
 * substrate's four build-checked invariants (P1 provenance, P2 dangling≠resolved,
 * P3 population-with-every-verdict, P4 proposals-cannot-self-approve) are the
 * whole reason the agent layer can be trusted to sit on top of it.
 *
 * ── WHY THE AGENT LAYER NEEDS ITS OWN POPULATION TYPE ──────────────────────
 * {@link Population} in `../types` ranges over `'nodes' | 'edges'`. An agent
 * does not examine nodes or edges — it examines FINDINGS, and a second question
 * matters just as much: **how many of them did the model actually see?**
 *
 * That second number is the agent-layer version of the failure this repo keeps
 * finding. A detector over an empty node set is green and blind. An agent layer
 * whose model call failed on 40 of 41 findings, and which silently emitted the
 * deterministic fallback for all of them, is *also* green and blind — and it
 * looks IDENTICAL to a healthy run unless the count is carried. So
 * {@link AgentPopulation} carries `modelConsulted` and `modelUnavailable`
 * alongside `examined`, and no agent can return a result without them.
 *
 * ── R7 APPLIES TO TOKEN COUNTS TOO ─────────────────────────────────────────
 * {@link AgentUsage} carries `source: 'reported' | 'estimated' | 'mixed'`. The
 * repo's `aoaiChatJson` primitive returns the PARSED OBJECT and discards the
 * response's `usage` block, so a client built on it cannot report real token
 * counts — it can only estimate them from character counts. Presenting an
 * estimate as a measurement is the same false claim as presenting a derived
 * dollar figure as a bill, so the field is required and there is no default.
 *
 * Nothing in this module performs I/O.
 */

import type {
  Confidence,
  CostFigure,
  Finding,
  RemediationProposal,
  SkippedSubject,
} from '../types';

// ---------------------------------------------------------------------------
// §Agents
// ---------------------------------------------------------------------------

/**
 * The four agents of PRP §3.3.
 *
 * The Critic is listed last but runs FIRST — see `./pipeline`. It is the gate,
 * not a post-processing step, because a finding that does not survive
 * adversarial review must never reach an operator's screen at all.
 */
export type AgentName = 'explainer' | 'correlator' | 'remediator' | 'critic';

export const AGENT_NAMES: readonly AgentName[] = [
  'explainer',
  'correlator',
  'remediator',
  'critic',
] as const;

// ---------------------------------------------------------------------------
// §Population — the agent-layer P3
// ---------------------------------------------------------------------------

/** What an agent ranged over. */
export type AgentPopulationSubject = 'findings' | 'groups';

/**
 * WHAT AN AGENT EXAMINED, and how much of it the model actually saw.
 *
 * `blind` is DERIVED from `examined === 0`, never passed in — the same discipline
 * as {@link makePopulation} in the graph module.
 *
 * `modelUnavailable > 0` is not an error state and does not fail a run: the
 * deterministic half of every agent still produces a correct, evidence-backed
 * result with no model at all. It IS, however, a number an operator must be able
 * to see, because "the Critic reviewed 41 findings" and "the Critic reviewed 41
 * findings and the model answered for 1 of them" are different claims.
 */
export interface AgentPopulation {
  readonly subject: AgentPopulationSubject;
  /** Subjects in scope BEFORE the agent ran. */
  readonly examined: number;
  /** Plain-English scope, e.g. "41 finding(s) from 3 detector(s)". */
  readonly scope: string;
  /** True iff `examined === 0`. A verdict over nothing establishes nothing. */
  readonly blind: boolean;
  /** Findings per detector within scope — the agent-layer `byProvenance`. */
  readonly byDetector: Readonly<Record<string, number>>;
  /**
   * Subjects whose OWN {@link Population} was blind. Carried forward rather than
   * absorbed: an agent that confidently narrates a finding produced over an
   * empty node set has laundered a blind measurement into readable prose.
   */
  readonly blindInputs: number;
  /** Subjects for which a model reply was received and accepted. */
  readonly modelConsulted: number;
  /** Subjects that fell back to the deterministic path (no/failed/rejected reply). */
  readonly modelUnavailable: number;
}

/**
 * Build an {@link AgentPopulation}. `blind` and `byDetector` are DERIVED from the
 * subjects, so a caller cannot describe an empty run as a confident one.
 */
export function makeAgentPopulation(args: {
  subject: AgentPopulationSubject;
  findings: readonly Finding[];
  scope: string;
  modelConsulted: number;
  modelUnavailable: number;
  /** Override the subject count when the subject is groups, not findings. */
  examined?: number;
}): AgentPopulation {
  const byDetector: Record<string, number> = {};
  let blindInputs = 0;
  for (const f of args.findings) {
    byDetector[f.detector] = (byDetector[f.detector] ?? 0) + 1;
    if (f.population.blind) blindInputs += 1;
  }
  const examined = args.examined ?? args.findings.length;
  return {
    subject: args.subject,
    examined,
    scope: args.scope,
    blind: examined === 0,
    byDetector,
    blindInputs,
    modelConsulted: args.modelConsulted,
    modelUnavailable: args.modelUnavailable,
  };
}

// ---------------------------------------------------------------------------
// §Usage
// ---------------------------------------------------------------------------

/**
 * Token spend for a run. `source` is REQUIRED — see the module header.
 *
 * `'estimated'` is the honest default for this layer today, because the shared
 * `aoaiChatJson` primitive parses the reply and drops the `usage` block. When a
 * client DOES report real counts (a stub in a test, or a future primitive that
 * surfaces `usage`), `source` becomes `'reported'`; a run that mixes both is
 * `'mixed'` rather than being rounded up to the more flattering label.
 */
export interface AgentUsage {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly source: 'reported' | 'estimated' | 'mixed';
  /** Per-tier split, so the cost model can price each tier at its own rate. */
  readonly byTier: Readonly<Record<string, { promptTokens: number; completionTokens: number }>>;
}

/** An empty usage accumulator. */
export function zeroUsage(): AgentUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, source: 'estimated', byTier: {} };
}

/**
 * Combine two usage records.
 *
 * The `source` merge is deliberately PESSIMISTIC: `reported + estimated` is
 * `'mixed'`, never `'reported'`. Rounding a partly-estimated total up to
 * "reported" is exactly the R7 failure — a claim the code cannot establish.
 * A zero-call record contributes nothing and does not drag the label.
 */
export function mergeUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const byTier: Record<string, { promptTokens: number; completionTokens: number }> = {};
  for (const src of [a.byTier, b.byTier]) {
    for (const [tier, v] of Object.entries(src)) {
      const cur = byTier[tier] ?? { promptTokens: 0, completionTokens: 0 };
      byTier[tier] = {
        promptTokens: cur.promptTokens + v.promptTokens,
        completionTokens: cur.completionTokens + v.completionTokens,
      };
    }
  }
  const source =
    a.calls === 0 ? b.source
    : b.calls === 0 ? a.source
    : a.source === b.source ? a.source
    : 'mixed';
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    source,
    byTier,
  };
}

// ---------------------------------------------------------------------------
// §The result envelope
// ---------------------------------------------------------------------------

/**
 * What every agent returns. NOT a bare array — the same reason
 * {@link DetectorResult} is not: returning an array makes the population
 * optional, returning this makes it structural.
 */
export interface AgentResult<T> {
  readonly agent: AgentName;
  readonly result: T;
  readonly population: AgentPopulation;
  readonly usage: AgentUsage;
  /** Subjects the agent could not process, and why. Never silently dropped. */
  readonly skipped: readonly SkippedSubject[];
}

// ---------------------------------------------------------------------------
// §Critic
// ---------------------------------------------------------------------------

/**
 * A deterministic refutation code. Each names a measurable defect in the
 * finding itself — no model is consulted to reach any of them, which is why a
 * model outage cannot turn the Critic off.
 */
export type RefutationCode =
  /** The finding's own `population.blind` is true. A verdict over an empty set. */
  | 'blind-population'
  /**
   * The finding asked about a provenance the graph holds ZERO edges of, so
   * "no inbound edge of that kind" is VACUOUSLY true of every node. The graph
   * module documents this trap explicitly: `blind` does not fire here, because
   * the node set was not empty.
   */
  | 'vacuous-provenance'
  /** `evidence.nodes` and `evidence.edges` are both empty — an assertion, not evidence. */
  | 'no-evidence'
  /** A cost was quoted for a subject whose scale facts were never measured. */
  | 'unmeasured-scale'
  /**
   * The finding proposes a change to a resource whose OWNERSHIP is not
   * established. PRP §1: 12 of the 13 container environments on this estate are
   * NOT Loom's. This is the guard that stands between a wrong inference and
   * someone else's production.
   */
  | 'ownership-unestablished'
  /** A `billed` cost figure whose basis does not name a Cost Management export. */
  | 'cost-presented-as-billed';

/**
 * How a refutation moves the verdict.
 *
 * `'indeterminate'` is a first-class outcome, not a pass. When the Critic cannot
 * evaluate a check — no graph supplied, a query string it cannot parse — saying
 * "I could not establish this" is R7; treating it as "the check passed" is the
 * fail-open that `2>/dev/null` produced on 2026-08-05.
 */
export type RefutationSeverity = 'refutes' | 'downgrades' | 'indeterminate';

export interface Refutation {
  readonly code: RefutationCode;
  readonly severity: RefutationSeverity;
  /** What was ESTABLISHED, in one sentence. Never speculation. */
  readonly statement: string;
  /** The exact field(s) read to reach it, so a reviewer can re-check by hand. */
  readonly establishedBy: string;
}

/**
 * An adversarial challenge from the model. ADVISORY ONLY.
 *
 * `wouldRefute` is the MODEL's assertion and is treated as exactly that: it can
 * lower a verdict to `'downgraded'`, and it can never produce `'refuted'` on its
 * own, because a model claiming a finding is wrong is itself an unverified
 * claim. Only a {@link Refutation} — something the code measured — refutes.
 */
export interface ModelChallenge {
  /** "What would make this finding wrong?" */
  readonly claim: string;
  /** The model's own view. Advisory; see above. */
  readonly wouldRefute: boolean;
  /** How a human could check the claim. Empty when the model gave none. */
  readonly checkable: string;
}

export type CriticVerdict = 'survives' | 'downgraded' | 'refuted';

export interface Critique {
  readonly findingId: string;
  readonly verdict: CriticVerdict;
  /** Measured. Drives the verdict. */
  readonly deterministic: readonly Refutation[];
  /** Model-supplied. Can only ever lower the verdict. */
  readonly modelChallenges: readonly ModelChallenge[];
  /**
   * The confidence the finding carries AFTER review. Never higher than the
   * finding's own — the Critic exists to subtract confidence, never to add it.
   */
  readonly resultingConfidence: Confidence;
  readonly modelConsulted: boolean;
}

// ---------------------------------------------------------------------------
// §Correlator
// ---------------------------------------------------------------------------

/**
 * A set of findings that share a root cause.
 *
 * MEMBERSHIP IS DETERMINISTIC. `members` is always a union of connected
 * components computed from shared evidence artifacts — the model names the root
 * cause and may propose merging two components, but it cannot add a finding that
 * shares no artifact with the group. A model that invents membership would
 * fabricate a correlation that reads exactly like a real one.
 *
 * The founding case (issue #3893): nine bicep findings that are ONE dead gate —
 * `modules/landing-zone/main.bicep` is never instantiated on any shipped params
 * file, making 24 module invocations and 146 resource declarations inert. All
 * nine cite that artifact, so all nine land in one component with no model at all.
 */
export interface CorrelationGroup {
  readonly id: string;
  readonly members: readonly string[];
  /** The artifacts every member shares. The deterministic reason they grouped. */
  readonly sharedArtifacts: readonly string[];
  /** The model's name for the root cause. `null` when no model answered. */
  readonly rootCause: string | null;
  readonly explanation: string | null;
  /** `'deterministic'` for a raw component; `'model'` when a merge was applied. */
  readonly mergeSource: 'deterministic' | 'model';
  readonly confidence: Confidence;
  /** True when no model reply was applied to this group. */
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// §Explainer
// ---------------------------------------------------------------------------

/**
 * An operator-readable narrative for one finding.
 *
 * `evidenceBlock` is built ENTIRELY from the finding's own fields and is present
 * on every narrative, including a fully degraded one. `modelProse` is the only
 * part a model wrote. Keeping them separate is what makes the guarantee
 * checkable: the evidence a reader sees is never something a model produced.
 */
export interface Narrative {
  readonly findingId: string;
  readonly headline: string;
  /** `modelProse` (when present) followed by `evidenceBlock`. */
  readonly body: string;
  /** Deterministic. Always present. Never model-authored. */
  readonly evidenceBlock: string;
  /** `null` when the model was unavailable or its reply was rejected. */
  readonly modelProse: string | null;
  readonly degraded: boolean;
  /**
   * Numeric tokens the model used that do NOT appear anywhere in the
   * established facts. A hallucinated count is the cheapest way for prose to
   * become a false claim, so it is surfaced rather than trusted.
   */
  readonly unverifiedNumbers: readonly string[];
}

// ---------------------------------------------------------------------------
// §Remediator
// ---------------------------------------------------------------------------

/**
 * A drafted fix. DATA, NOT A CALL.
 *
 * `proposal` is the substrate's {@link RemediationProposal}, built only through
 * its `proposal()` constructor, so `requiresHumanApproval: true` and
 * `mutatesAzure: false` are LITERAL types that no assignment can weaken (P4).
 *
 * `containsDestructiveCommand` does not block anything — nothing here executes,
 * so there is nothing to block. It exists so the surface rendering this draft
 * can warn before a human copies the text into a terminal.
 */
export interface RemediationDraft {
  readonly findingId: string;
  readonly proposal: RemediationProposal;
  readonly containsDestructiveCommand: boolean;
  readonly destructiveMatches: readonly string[];
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// §The report
// ---------------------------------------------------------------------------

/** One finding that survived the Critic, with everything the agents produced for it. */
export interface ReportedFinding {
  readonly finding: Finding;
  readonly critique: Critique;
  readonly narrative: Narrative;
  readonly remediation: RemediationDraft;
  /** The correlation group this finding belongs to, when it belongs to one. */
  readonly groupId: string | null;
}

/**
 * What one detector contributed to a run, INCLUDING when it contributed nothing.
 *
 * `blind` is the field that earns this type its place. A detector that returns
 * zero findings because the estate is clean, and one that returns zero findings
 * because it examined an empty node set, produce the SAME empty array — and if
 * the report only carried findings, they would be indistinguishable. Carrying
 * the detector's own population forward is how "0 findings" stays separable from
 * "0 data".
 */
export interface DetectorInputSummary {
  readonly detector: string;
  readonly findings: number;
  readonly examined: number;
  readonly edgesExamined: number;
  readonly blind: boolean;
  readonly scope: string;
  readonly skipped: number;
}

/** The agent layer's output. */
export interface BrainAgentReport {
  /** Survivors ONLY. A refuted finding is not here — see `refuted`. */
  readonly findings: readonly ReportedFinding[];
  /** Findings the Critic refuted, with the measurement that refuted them. */
  readonly refuted: readonly Critique[];
  readonly groups: readonly CorrelationGroup[];
  /** The run's overall population. */
  readonly population: AgentPopulation;
  /** Per-stage populations. Every stage reports what it examined. */
  readonly stages: Readonly<Record<AgentName, AgentPopulation>>;
  /** What each detector contributed, including the ones that examined nothing. */
  readonly detectors: readonly DetectorInputSummary[];
  readonly usage: AgentUsage;
  /**
   * What the run cost. ALWAYS `source: 'derived'` — token counts on this path
   * are estimated and the rate is a published list price, so it is an estimate
   * of a price, never a statement about a bill.
   */
  readonly cost: CostFigure;
  readonly skipped: readonly SkippedSubject[];
}

/**
 * LOOM BRAIN — the CRITIC. Adversarial review before a finding is ever shown.
 *
 * PRP §3.3: *"The Critic exists because the dominant failure in this repo is a
 * confident claim from a partial measurement. It is the agent-layer equivalent
 * of the mutation discipline."*
 *
 * ── THE ASYMMETRY THAT MAKES THIS WORK ─────────────────────────────────────
 * The Critic has two halves and they have DIFFERENT authority:
 *
 *   DETERMINISTIC ({@link Refutation}) — measured from the finding's own fields.
 *       Can refute. Cannot be turned off. Runs with no model, no network, no
 *       graph. This is the half that matters.
 *
 *   MODEL ({@link ModelChallenge}) — an LLM asked "what would make this wrong?"
 *       Can only ever LOWER a verdict. It cannot produce `'refuted'` on its own,
 *       it cannot clear a deterministic refutation, and it cannot raise
 *       confidence above what the finding already claimed.
 *
 * The asymmetry is the whole design. A model asserting "this finding is wrong"
 * is itself an unverified claim, and a Critic that accepted it would have
 * replaced one confident-unverified claim with another. A model asserting "this
 * finding is fine" is worse still: it would launder a blind measurement into an
 * endorsement. So the model may add doubt and may never remove it.
 *
 * ── THE SIX MEASURED CHECKS ────────────────────────────────────────────────
 * Each is a failure class this repo has actually shipped:
 *
 *   blind-population        a verdict over an empty set. Found repeatedly here.
 *   vacuous-provenance      "no inbound edge of kind K" over a graph holding
 *                           ZERO edges of kind K — true of everything, evidence
 *                           of nothing. `population.blind` does NOT fire on this
 *                           one, because the NODE set was not empty; the graph
 *                           module documents the trap and this is the check for it.
 *   no-evidence             a finding whose evidence chain is empty is an assertion.
 *   unmeasured-scale        a dollar figure quoted for a resource whose replica
 *                           counts were never read. Absent scale is NOT MEASURED.
 *   ownership-unestablished the guard between a wrong inference and someone
 *                           else's production. PRP §1: 12 of 13 container
 *                           environments on this estate are NOT Loom's.
 *   cost-presented-as-billed  a `billed` figure whose basis names no export.
 *
 * ── A CHECK THAT CANNOT EVALUATE SAYS SO ───────────────────────────────────
 * `'indeterminate'` is a first-class severity. When the Critic has no graph, it
 * does not silently pass the ownership check — it records that ownership could
 * not be established. Treating "I could not check" as "it checked out" is the
 * fail-open that turned a permission denial into a false claim on 2026-08-05.
 *
 * Pure except for the injected {@link BrainModelClient}, which is optional; with
 * no client the Critic still performs every measured check.
 */

import {
  EDGE_PROVENANCES,
  type Confidence,
  type EdgeProvenance,
  type Finding,
  type BrainGraphView,
  type NodeId,
  type SkippedSubject,
} from '../types';
import { LOOM_ESTATE_TAG_KEY } from '../graph';
import {
  makeAgentPopulation,
  mergeUsage,
  zeroUsage,
  type AgentResult,
  type Critique,
  type CriticVerdict,
  type ModelChallenge,
  type Refutation,
} from './contracts';
import { invokeModel, requestFor, type BrainModelClient } from './model-client';
import { usageForCall, usageForFailedCall } from './tokens';

// ---------------------------------------------------------------------------
// §Confidence arithmetic
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** One step down. `low` is the floor — there is nothing below it. */
function stepDown(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

/**
 * The lower of two confidences.
 *
 * Used everywhere a confidence is combined, so that no path through this module
 * can produce a value above the finding's own. The Critic subtracts confidence;
 * it has no operation that adds any.
 */
function floorAt(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// §The measured checks
// ---------------------------------------------------------------------------

/** A verdict over an empty subject set establishes nothing. */
function checkBlindPopulation(f: Finding): Refutation | null {
  if (!f.population.blind) return null;
  return {
    code: 'blind-population',
    severity: 'refutes',
    statement:
      `The finding's own population is BLIND: subject '${f.population.subject}' had ` +
      `examined=${f.population.examined}, edgesExamined=${f.population.edgesExamined}. ` +
      `A verdict over an empty set establishes nothing about anything.`,
    establishedBy: 'finding.population.blind, .examined, .edgesExamined',
  };
}

/**
 * Extract every edge-provenance literal named in a query string.
 *
 * Deliberately matches on quoted literals rather than parsing the call, because
 * the query is a human-readable record of an invocation, not a grammar. Both
 * argument positions of `hasInboundOnly(g, present, absent)` are collected: a
 * zero count on EITHER makes the result vacuous, in opposite directions — a
 * zero `present` means nothing could ever be returned, a zero `absent` means
 * everything is returned.
 */
function provenancesNamedIn(query: string): EdgeProvenance[] {
  const found: EdgeProvenance[] = [];
  for (const p of EDGE_PROVENANCES) {
    if (new RegExp(`['"\`]${p}['"\`]`).test(query)) found.push(p);
  }
  return found;
}

/**
 * "No inbound edge of kind K" over a graph with ZERO edges of kind K.
 *
 * This is the check `population.blind` cannot make. The node set was not empty,
 * so nothing looks wrong — but the answer is vacuously true of every node in the
 * graph, and the real finding is "the extractor for K did not run".
 */
function checkVacuousProvenance(f: Finding): Refutation | null {
  const named = provenancesNamedIn(f.evidence.query);
  if (named.length === 0) {
    return {
      code: 'vacuous-provenance',
      severity: 'indeterminate',
      statement:
        `Could not determine which edge provenance this finding queried: ` +
        `evidence.query = ${JSON.stringify(f.evidence.query)} names none of ` +
        `${EDGE_PROVENANCES.join('/')}. Vacuity was NOT checked — this is not a pass.`,
      establishedBy: 'finding.evidence.query',
    };
  }
  const zero = named.filter((p) => (f.population.byProvenance[p] ?? 0) === 0);
  if (zero.length === 0) return null;
  return {
    code: 'vacuous-provenance',
    severity: 'refutes',
    statement:
      `The graph in scope holds ZERO edges of provenance ${zero.map((p) => `'${p}'`).join(', ')}, ` +
      `which the query names (${f.evidence.query}). The result is VACUOUSLY true of every node ` +
      `examined, so it is evidence that the '${zero[0]}' extractor produced nothing — not evidence ` +
      `about these subjects. Counts: ` +
      EDGE_PROVENANCES.map((p) => `${p}=${f.population.byProvenance[p] ?? 0}`).join(' '),
    establishedBy: 'finding.population.byProvenance, finding.evidence.query',
  };
}

/** A finding with no evidence chain is an assertion, not a finding. */
function checkNoEvidence(f: Finding): Refutation | null {
  if (f.evidence.nodes.length > 0 || f.evidence.edges.length > 0) return null;
  return {
    code: 'no-evidence',
    severity: 'refutes',
    statement:
      `The evidence chain is empty: 0 node ids and 0 edge ids. Nothing about this finding ` +
      `can be re-derived or re-checked, so it is an assertion.`,
    establishedBy: 'finding.evidence.nodes, finding.evidence.edges',
  };
}

/** Azure subjects, identified by the `azure:` id prefix the node-id module mints. */
function azureSubjects(f: Finding): NodeId[] {
  return f.subjects.filter((s) => String(s).startsWith('azure:'));
}

/**
 * A dollar figure quoted for a resource whose replica counts were never read.
 *
 * `AzureResourceNode.scale === undefined` means NOT MEASURED. A cost derived
 * from a SKU nobody read is a number with no input, and it is the R7 failure in
 * its cheapest form.
 */
function checkUnmeasuredScale(f: Finding, graph: BrainGraphView | undefined): Refutation | null {
  if (!f.cost) return null;
  const azure = azureSubjects(f);
  if (azure.length === 0) return null;
  if (!graph) {
    return {
      code: 'unmeasured-scale',
      severity: 'indeterminate',
      statement:
        `A cost figure is attached (${f.cost.source}, $${f.cost.amountUsd}) but no graph was ` +
        `supplied, so whether the ${azure.length} Azure subject(s) had measured scale facts ` +
        `could NOT be checked.`,
      establishedBy: 'finding.cost (graph not supplied)',
    };
  }
  const unmeasured = azure.filter((id) => {
    const n = graph.node(id);
    return !n || n.kind !== 'azure-resource' || n.scale === undefined;
  });
  if (unmeasured.length === 0) return null;
  return {
    code: 'unmeasured-scale',
    severity: 'downgrades',
    statement:
      `A cost figure is attached (${f.cost.source}, $${f.cost.amountUsd}) but ` +
      `${unmeasured.length} of ${azure.length} Azure subject(s) carry NO scale facts — absent ` +
      `scale is NOT MEASURED, not minReplicas 0. The figure has an unread input.`,
    establishedBy: 'finding.cost, AzureResourceNode.scale on each subject',
  };
}

/**
 * OWNERSHIP. The guard between a wrong inference and someone else's production.
 *
 * Measured 2026-08-23 across all six subscriptions: **zero of 105 container-tier
 * resources carry `loom-estate-id`**, and the graph holds **0 `owns` edges**. So
 * on today's estate this check downgrades essentially every cleanup finding —
 * and that is the correct answer, not a bug in the check. An ownership-based
 * recommendation on an estate with no ownership signal is a guess, and 12 of the
 * 13 container environments visible here belong to the operator's blog,
 * Sentinel, two Atlas estates and more.
 *
 * The statement reports the guard's OWN population — how many `owns` edges exist
 * at all — so a reader can see that the check is blind rather than satisfied.
 */
function checkOwnership(f: Finding, graph: BrainGraphView | undefined): Refutation | null {
  const azure = azureSubjects(f);
  if (azure.length === 0) return null;
  if (!graph) {
    return {
      code: 'ownership-unestablished',
      severity: 'indeterminate',
      statement:
        `${azure.length} Azure subject(s) are named and a remediation is proposed, but no graph ` +
        `was supplied, so OWNERSHIP could NOT be established. This is not a pass.`,
      establishedBy: 'finding.subjects (graph not supplied)',
    };
  }
  const ownsInGraph = graph.edges.filter((e) => e.provenance === 'owns').length;
  let owned = 0;
  let tagged = 0;
  for (const id of azure) {
    if (graph.inboundEdges(id, 'owns').result.length > 0) owned += 1;
    const n = graph.node(id);
    if (n && n.kind === 'azure-resource' && n.tags && n.tags[LOOM_ESTATE_TAG_KEY]) tagged += 1;
  }
  if (owned === azure.length || tagged === azure.length) return null;
  return {
    code: 'ownership-unestablished',
    severity: 'downgrades',
    statement:
      `Ownership is NOT established for ${azure.length - Math.max(owned, tagged)} of ` +
      `${azure.length} Azure subject(s): ${owned} carry an inbound 'owns' edge and ${tagged} carry ` +
      `the '${LOOM_ESTATE_TAG_KEY}' tag. The graph holds ${ownsInGraph} 'owns' edge(s) IN TOTAL — ` +
      `at ${ownsInGraph} this check is blind, not satisfied. A cleanup recommendation on an ` +
      `unowned resource can reach an estate that is not Loom's.`,
    establishedBy: "inboundEdges(subject,'owns'), AzureResourceNode.tags, graph.edges",
  };
}

/** A `billed` figure whose basis names no export is a derived figure wearing a bill's label. */
function checkCostSource(f: Finding): Refutation | null {
  if (!f.cost || f.cost.source !== 'billed') return null;
  if (/cost management|export|invoice|billing period/i.test(f.cost.basis)) return null;
  return {
    code: 'cost-presented-as-billed',
    severity: 'downgrades',
    statement:
      `The cost figure claims source 'billed' but its basis names no Cost Management export: ` +
      `${JSON.stringify(f.cost.basis.slice(0, 160))}. Measured 2026-08-23, the Cost Management ` +
      `API returned HTTP 429 on 11 consecutive attempts, so a billed figure on this program ` +
      `needs an export to stand behind it.`,
    establishedBy: 'finding.cost.source, finding.cost.basis',
  };
}

/**
 * Every measured check, in order. No model, no network.
 *
 * Exported so a caller (or a test) can run the measured half alone and see that
 * it is complete without one.
 */
export function measuredRefutations(
  f: Finding,
  graph?: BrainGraphView,
): Refutation[] {
  return [
    checkBlindPopulation(f),
    checkVacuousProvenance(f),
    checkNoEvidence(f),
    checkUnmeasuredScale(f, graph),
    checkOwnership(f, graph),
    checkCostSource(f),
  ].filter((r): r is Refutation => r !== null);
}

// ---------------------------------------------------------------------------
// §Verdict
// ---------------------------------------------------------------------------

/**
 * Combine the two halves into a verdict.
 *
 * READ THE ORDER. `refutes` is decided ENTIRELY from the measured half, before
 * model challenges are looked at at all — so there is no expression in this
 * function through which a model reply could clear a measured refutation. The
 * model's only reachable effect is the `survives → downgraded` transition.
 */
export function verdictFor(
  deterministic: readonly Refutation[],
  modelChallenges: readonly ModelChallenge[],
): CriticVerdict {
  if (deterministic.some((r) => r.severity === 'refutes')) return 'refuted';
  if (deterministic.some((r) => r.severity === 'downgrades')) return 'downgraded';
  if (modelChallenges.some((c) => c.wouldRefute)) return 'downgraded';
  return 'survives';
}

/**
 * The confidence a finding carries after review.
 *
 * Floored at the finding's declared confidence in every branch — the Critic
 * cannot promote a `low`-confidence finding to `high` no matter what any model
 * says about it.
 */
export function confidenceFor(
  declared: Confidence,
  verdict: CriticVerdict,
): Confidence {
  if (verdict === 'refuted') return 'low';
  if (verdict === 'downgraded') return floorAt(stepDown(declared), declared);
  return declared;
}

// ---------------------------------------------------------------------------
// §The model half
// ---------------------------------------------------------------------------

const CRITIC_SYSTEM = [
  'You are the Critic in an Azure estate-analysis system. You are shown one finding that a',
  'deterministic detector produced. Your ONLY job is adversarial: state what would make this',
  'finding WRONG.',
  '',
  'Rules:',
  '- Do not restate the finding. Do not agree with it. Do not praise it.',
  '- Each challenge must be CHECKABLE: name the specific measurement, field or query that would',
  '  settle it.',
  '- Do not invent numbers, resource names, subscriptions or file paths. If you need a fact you',
  '  were not given, say that you were not given it.',
  '- Prefer challenges about what was NOT measured over challenges about what was.',
  '',
  'Reply with JSON only, in this exact shape:',
  '{"challenges":[{"claim":"...","wouldRefute":true,"checkable":"..."}]}',
  'Return between 1 and 4 challenges. wouldRefute is true only when the challenge, if it held,',
  'would make the finding false rather than merely weaker.',
].join('\n');

function criticUserPrompt(f: Finding): string {
  return [
    `detector: ${f.detector}`,
    `severity: ${f.severity}`,
    `declared confidence: ${f.confidence}`,
    `title: ${f.title}`,
    `summary: ${f.summary}`,
    `subjects: ${f.subjects.length}`,
    `query: ${f.evidence.query}`,
    `population scope: ${f.population.scope}`,
    `population blind: ${f.population.blind}`,
    `edges by provenance: ${EDGE_PROVENANCES.map((p) => `${p}=${f.population.byProvenance[p] ?? 0}`).join(' ')}`,
    `evidence node count: ${f.evidence.nodes.length}`,
    `evidence edge count: ${f.evidence.edges.length}`,
    `evidence notes: ${f.evidence.notes.length ? f.evidence.notes.join(' | ') : '(none)'}`,
    f.cost ? `cost: $${f.cost.amountUsd} source=${f.cost.source} basis=${f.cost.basis}` : 'cost: (none)',
  ].join('\n');
}

/**
 * Read challenges out of a model reply, DEFENSIVELY.
 *
 * Anything malformed is dropped rather than coerced. `wouldRefute` is accepted
 * only as a real boolean `true` — a truthy string like `"maybe"` becomes
 * `false`, because a coerced truthy read is exactly the shape that turned an
 * admin-bypass check into a bypass (#3891).
 */
export function parseChallenges(json: unknown): ModelChallenge[] {
  const raw = (json as { challenges?: unknown } | null)?.challenges;
  if (!Array.isArray(raw)) return [];
  const out: ModelChallenge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
    if (!claim) continue;
    out.push({
      claim: claim.slice(0, 600),
      wouldRefute: o.wouldRefute === true,
      checkable: typeof o.checkable === 'string' ? o.checkable.trim().slice(0, 400) : '',
    });
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §The agent
// ---------------------------------------------------------------------------

export interface CriticInput {
  readonly findings: readonly Finding[];
  readonly graph?: BrainGraphView;
  readonly client?: BrainModelClient;
}

/**
 * Review every finding. Returns one {@link Critique} per finding, in input order.
 *
 * The population reports `modelConsulted` / `modelUnavailable`, so a run in
 * which the model answered for none of the findings is visibly different from
 * one in which it answered for all of them — even though both produce a complete
 * set of critiques, because the measured half never depends on the model.
 */
export async function criticize(input: CriticInput): Promise<AgentResult<readonly Critique[]>> {
  const critiques: Critique[] = [];
  const skipped: SkippedSubject[] = [];
  let usage = zeroUsage();
  let consulted = 0;
  let unavailable = 0;

  for (const f of input.findings) {
    const deterministic = measuredRefutations(f, input.graph);

    const req = requestFor('critic', CRITIC_SYSTEM, criticUserPrompt(f));
    const outcome = await invokeModel(input.client, req);

    let modelChallenges: ModelChallenge[] = [];
    if (outcome.ok) {
      modelChallenges = parseChallenges(outcome.reply.json);
      consulted += 1;
      usage = mergeUsage(
        usage,
        usageForCall({
          tier: req.tier,
          system: req.system,
          user: req.user,
          replyJson: outcome.reply.json,
          reported: outcome.reply.usage,
        }),
      );
    } else {
      unavailable += 1;
      skipped.push({ subject: f.id, reason: `critic model unavailable: ${outcome.error}` });
      if (input.client) {
        usage = mergeUsage(
          usage,
          usageForFailedCall({ tier: req.tier, system: req.system, user: req.user }),
        );
      }
    }

    const verdict = verdictFor(deterministic, modelChallenges);
    critiques.push({
      findingId: f.id,
      verdict,
      deterministic,
      modelChallenges,
      resultingConfidence: confidenceFor(f.confidence, verdict),
      modelConsulted: outcome.ok,
    });
  }

  return {
    agent: 'critic',
    result: critiques,
    population: makeAgentPopulation({
      subject: 'findings',
      findings: input.findings,
      scope:
        `${input.findings.length} finding(s) reviewed against 6 measured checks` +
        (input.graph
          ? `; graph supplied (${input.graph.nodes.length} nodes, ${input.graph.edges.length} edges)`
          : '; NO graph supplied — ownership and scale checks are INDETERMINATE, not passed'),
      modelConsulted: consulted,
      modelUnavailable: unavailable,
    }),
    usage,
    skipped,
  };
}

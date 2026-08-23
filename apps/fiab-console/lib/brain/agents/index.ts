/**
 * LOOM BRAIN — the agent layer. Public surface.
 *
 * PRP §3.3: four LLM agents that **explain, correlate and draft — never decide
 * alone and never act.**
 *
 *   {@link criticize}          adversarial review. Runs FIRST, and gates.
 *   {@link correlate}          findings that share a root cause, grouped.
 *   {@link explain}            a finding, turned into readable prose.
 *   {@link draftRemediations}  a fix, drafted as data.
 *   {@link runBrainAgents}     all four, in order, with the gate applied.
 *
 * ── THE THREE PROPERTIES THIS LAYER GUARANTEES ─────────────────────────────
 *
 *   1. **A model can only ever subtract confidence.** The Critic's measured
 *      checks decide `refuted`; a model challenge can lower a verdict to
 *      `downgraded` and can do nothing else. No path through {@link verdictFor}
 *      or {@link confidenceFor} lets a model reply clear a measured refutation
 *      or raise a finding above its declared confidence.
 *
 *   2. **A model can never invent membership or evidence.** Correlation groups
 *      are connected components over shared evidence artifacts, computed with no
 *      model; the model names them and may merge whole components, never
 *      individual findings. Every narrative's evidence block is built from the
 *      finding's own fields, so nothing a reader is shown as evidence was
 *      authored by a model.
 *
 *   3. **Nothing here can act.** Every draft is a {@link RemediationProposal}
 *      built through the substrate's `proposal()` constructor, whose
 *      `requiresHumanApproval: true` / `mutatesAzure: false` are literal types.
 *      The output is inert JSON — see {@link isPureData} — and the only outbound
 *      call in the directory is a chat completion.
 *
 * ── AND ONE THING IT REPORTS RATHER THAN GUARANTEES ────────────────────────
 * Every stage carries an {@link AgentPopulation} with `modelConsulted` and
 * `modelUnavailable`. A run in which every model call failed still produces a
 * complete, correct, evidence-backed report — and says, in a number, that the
 * model saw none of it. A degraded run that looks identical to a healthy one is
 * the failure this layer is built not to have.
 */

export * from './contracts';

export {
  AGENT_MAX_COMPLETION_TOKENS,
  AGENT_TASK_CLASSES,
  AGENT_TIERS,
  aoaiBrainModelClient,
  invokeModel,
  requestFor,
  type BrainModelClient,
  type BrainModelReply,
  type BrainModelRequest,
  type ModelOutcome,
} from './model-client';

export { agentRunCost, estimateTokens, usageForCall, usageForFailedCall } from './tokens';

export {
  confidenceFor,
  criticize,
  measuredRefutations,
  parseChallenges,
  verdictFor,
  type CriticInput,
} from './critic';

export {
  applyProposals,
  artifactsOf,
  componentsOf,
  correlate,
  parseProposals,
  type Component,
  type CorrelatorInput,
} from './correlator';

export {
  evidenceBlock,
  explain,
  parseNarrative,
  unverifiedNumbers,
  type ExplainerInput,
} from './explainer';

export {
  DESTRUCTIVE_PATTERNS,
  destructiveMatchesIn,
  draftRemediations,
  isPureData,
  parseDraft,
  type RemediatorInput,
} from './remediator';

export { runBrainAgents, type BrainAgentInput } from './pipeline';

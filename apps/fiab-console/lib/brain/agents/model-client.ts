/**
 * LOOM BRAIN — the model port, and its adapter onto this repo's ONE LLM client.
 *
 * ── WHICH CLIENT, AND WHY THIS ONE ─────────────────────────────────────────
 * This repo has exactly one LLM egress path: `lib/azure/aoai-chat-client.ts`,
 * described in its own header as "the ONE unified Azure OpenAI chat-completions
 * client … the consolidation target for the ~18 call sites that each rolled
 * their own AOAI chat-completions fetch". Measured on this branch: `grep -c
 * anthropic apps/fiab-console/package.json` → **0**. There is no Anthropic SDK
 * in the console and no second client.
 *
 * So the agent layer rides that client rather than introducing a second one.
 * Three reasons, in order of weight:
 *
 *   1. `cloud-parity.md` is a die-hard rule: a capability that works in
 *      Commercial and not in Gov is INCOMPLETE. The shared client is
 *      Commercial- AND Gov-correct by construction — it resolves `cogScope`
 *      against `cognitiveservices.azure.us` in Gov and `.com` in Commercial,
 *      with no literal endpoint anywhere. A direct first-party API client would
 *      be reachable from Commercial and unreachable from a sovereign boundary,
 *      which is precisely the shape that rule forbids.
 *   2. It already owns managed-identity tokens, the APIM→direct fallback, the
 *      bounded fetch, the unsupported-sampling-param retry, per-workspace token
 *      budgets and real spend attribution. A second client re-earns every one of
 *      those or silently loses them.
 *   3. Claude models served through **Microsoft Foundry** are reachable over
 *      exactly this path — a Foundry deployment name is a deployment name. Model
 *      SELECTION is therefore a deployment/tier question, not a client question,
 *      and it is answered by the env vars the tier router already reads.
 *
 * If the operator wants first-party Anthropic egress instead, that is a
 * deliberate decision about a new egress path and a new credential in two
 * clouds — not something to smuggle in underneath a feature. It would slot in
 * as a second {@link BrainModelClient} implementation with no change to any
 * agent, which is the point of the port.
 *
 * ── TIER CHOICES, AND WHY ──────────────────────────────────────────────────
 * The repo already has the vocabulary for "cheap fast model" vs "stronger
 * model": `lib/foundry/model-tier-router`'s `ModelTier = 'mini' | 'standard' |
 * 'strong'`, wired to `LOOM_AOAI_MINI_DEPLOYMENT` / `LOOM_AOAI_STRONG_DEPLOYMENT`.
 * Using it means an admin retargets the Brain's models from the existing
 * Admin → Copilot & Agents → Model tiers surface, and the Brain's spend lands in
 * the existing per-tier cost view. Inventing a parallel `LOOM_BRAIN_MODEL_*`
 * scheme would fork both.
 *
 *   explainer  → mini      It REWRITES facts that are already established. The
 *                          evidence block is built deterministically and the
 *                          model contributes prose only, so the failure mode of
 *                          a weaker model is "flatter writing", not "wrong
 *                          answer". This is also the highest-volume agent — one
 *                          call per surviving finding.
 *   remediator → standard  Drafting a diff or an `az` invocation needs syntactic
 *                          competence, but the proposal is reviewed by a human
 *                          before anything happens and its literals are pinned by
 *                          the type system either way.
 *   correlator → strong    Relational reasoning ACROSS findings — "these nine are
 *                          one dead gate". Cheap models flatten this to keyword
 *                          overlap, which the deterministic component pass
 *                          already does better.
 *   critic     → strong    The most important agent (PRP §3.3) gets the best
 *                          model. Its job is to find the counterexample a
 *                          confident summary hides; that is the hardest reasoning
 *                          task in the layer and the one whose failures are least
 *                          visible.
 *
 * Volume note: `explainer` and `remediator` are per-finding; `critic` is
 * per-finding; `correlator` is per-COMPONENT (far fewer). So the strong tier is
 * dominated by the Critic, which is the deliberate place to spend.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * The only outbound call in this entire directory is a chat completion, and it
 * is made from this file alone. `lib/brain/__tests__/agents/no-azure-mutation.test.ts`
 * enforces that over the directory's source with an embedded control.
 */

import type { ModelTier, TaskClass } from '@/lib/foundry/model-tier-router';
import type { AgentName } from './contracts';

// ---------------------------------------------------------------------------
// §The port
// ---------------------------------------------------------------------------

/** One request to a model. Pure data — no client, no credential, no endpoint. */
export interface BrainModelRequest {
  readonly agent: AgentName;
  readonly system: string;
  readonly user: string;
  readonly tier: ModelTier;
  readonly taskClass: TaskClass;
  readonly maxCompletionTokens: number;
}

/**
 * One reply.
 *
 * `usage: null` means NOT MEASURED — it does not mean zero. The shared
 * `aoaiChatJson` primitive parses the reply and returns the object, discarding
 * the response's `usage` block, so the production adapter genuinely cannot
 * report real counts. Saying so is R7; substituting an estimate and calling it
 * a measurement is the failure R7 names.
 */
export interface BrainModelReply {
  /** The parsed JSON object the model returned. Never a raw string. */
  readonly json: unknown;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
}

/**
 * The port every agent depends on.
 *
 * A function type rather than an interface with methods, so a test stub is a
 * one-line arrow and there is no shape for a stub to accidentally under-implement.
 */
export type BrainModelClient = (req: BrainModelRequest) => Promise<BrainModelReply>;

// ---------------------------------------------------------------------------
// §Tier assignment
// ---------------------------------------------------------------------------

/** See the module header for the reasoning behind each row. */
export const AGENT_TIERS: Readonly<Record<AgentName, ModelTier>> = {
  explainer: 'mini',
  remediator: 'standard',
  correlator: 'strong',
  critic: 'strong',
};

/**
 * The task class each agent's turns are classified as, for the tier router's
 * own accounting. Deliberately consistent with {@link AGENT_TIERS} —
 * `DEFAULT_TASK_TIER_MAP` maps lightweight→mini, general→standard,
 * reasoning→strong, so these two tables agree row for row and the router never
 * silently re-routes an agent onto a tier this module did not choose.
 */
export const AGENT_TASK_CLASSES: Readonly<Record<AgentName, TaskClass>> = {
  explainer: 'lightweight',
  remediator: 'general',
  correlator: 'reasoning',
  critic: 'reasoning',
};

/** Token cap per agent. The Critic gets room to enumerate several challenges. */
export const AGENT_MAX_COMPLETION_TOKENS: Readonly<Record<AgentName, number>> = {
  explainer: 700,
  remediator: 1200,
  correlator: 900,
  critic: 1200,
};

/** Build a request with this agent's tier, task class and cap already applied. */
export function requestFor(agent: AgentName, system: string, user: string): BrainModelRequest {
  return {
    agent,
    system,
    user,
    tier: AGENT_TIERS[agent],
    taskClass: AGENT_TASK_CLASSES[agent],
    maxCompletionTokens: AGENT_MAX_COMPLETION_TOKENS[agent],
  };
}

// ---------------------------------------------------------------------------
// §Safe invocation
// ---------------------------------------------------------------------------

/** The outcome of one model call. Never a thrown exception. */
export type ModelOutcome =
  | { readonly ok: true; readonly reply: BrainModelReply }
  | { readonly ok: false; readonly error: string };

/**
 * Call a client and NEVER throw.
 *
 * Every agent in this layer has a deterministic half that produces a correct,
 * evidence-backed result with no model at all. An exception escaping a model
 * call would discard that work and take down the whole report — turning a
 * degraded run into no run. So the failure is converted into a value, the agent
 * records `modelUnavailable`, and the population makes the degradation visible
 * rather than silent.
 *
 * A `null`/non-object `json` is treated as a FAILURE, not as an empty answer:
 * a reply the agent cannot read is indistinguishable from no reply, and calling
 * it success would let a broken model path report full `modelConsulted` counts.
 */
export async function invokeModel(
  client: BrainModelClient | undefined,
  req: BrainModelRequest,
): Promise<ModelOutcome> {
  if (!client) return { ok: false, error: 'no model client supplied (deterministic-only run)' };
  try {
    const reply = await client(req);
    if (!reply || typeof reply !== 'object') {
      return { ok: false, error: 'model client returned a non-object reply' };
    }
    if (reply.json === null || typeof reply.json !== 'object') {
      return {
        ok: false,
        error: `model reply carried no JSON object (got ${reply.json === null ? 'null' : typeof reply.json})`,
      };
    }
    return { ok: true, reply };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// §The production adapter
// ---------------------------------------------------------------------------

/**
 * A {@link BrainModelClient} backed by the repo's unified AOAI chat client.
 *
 * The import is DYNAMIC and lives inside the returned function on purpose. A
 * static import would pull `aoai-chat-client` — and through it the orchestrator,
 * the credential chain, the APIM gateway and the token-budget subsystem — into
 * the module graph of every agent and every agent test. The agents would then be
 * untestable without stubbing an Azure stack they never touch. Deferring it
 * keeps `lib/brain/agents/**` pure at import time while still using exactly one
 * client at call time.
 *
 * `temperature: 0` on every call: these agents produce evidence-bearing output
 * that is diffed across runs, so sampling variance is a cost with no benefit.
 * (The shared client drops `temperature` automatically on the models that reject
 * it, so this is safe on every deployment.)
 *
 * Honest gate: when no AOAI deployment is configured the shared client throws
 * `NoAoaiDeploymentError`. That propagates to {@link invokeModel}, which turns it
 * into `modelUnavailable` — the run still produces every deterministic finding,
 * critique, group and proposal, and the report says how many findings the model
 * did not see.
 */
export function aoaiBrainModelClient(): BrainModelClient {
  return async (req: BrainModelRequest): Promise<BrainModelReply> => {
    const { aoaiChatJson } = await import('@/lib/azure/aoai-chat-client');
    const json = await aoaiChatJson<Record<string, unknown>>({
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      responseFormat: 'json_object',
      temperature: 0,
      maxCompletionTokens: req.maxCompletionTokens,
      tier: req.tier,
      taskClass: req.taskClass,
    });
    // `usage: null` — NOT MEASURED. `aoaiChatJson` returns the parsed object and
    // does not surface the response's `usage` block. See BrainModelReply.
    return { json, usage: null };
  };
}

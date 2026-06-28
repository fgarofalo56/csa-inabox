/**
 * aoai-model-contract — the SINGLE source of truth for the Azure OpenAI
 * chat-completions REQUEST body contract used by every Loom Copilot / agent
 * call path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The chat-completions body was built inline in three separate functions in
 * copilot-orchestrator.ts (the tool-loop `callAoai`, the text helper
 * `aoaiCompleteText`, and the JSON helper `aoaiCompleteJson`) plus a long tail
 * of other call sites. Each one re-implemented the same two load-bearing
 * details, and getting either wrong is a systemic outage:
 *
 *   1. **Token cap = `max_completion_tokens`, NEVER `max_tokens`.** The deployed
 *      o-series / gpt-5 / reasoning models REJECT `max_tokens` with a 400 — this
 *      was the systemic bug fixed in 38e6d5db. `max_completion_tokens` is also
 *      accepted by gpt-4o / 4o-mini on current api-versions, so it is the single
 *      forward-compatible cap for every deployment. This builder emits ONLY
 *      `max_completion_tokens` and there is a unit test that asserts `max_tokens`
 *      is never present.
 *
 *   2. **Temperature is OMITTED on the retry.** Newer reasoning deployments
 *      (o1/o3/gpt-5/MAI-*) reject any non-default `temperature` (and `top_p`)
 *      with a 400 (`isUnsupportedSamplingParam`). The correct move is to retry
 *      the SAME request without the sampling param — so `temperature` is an
 *      optional field here and the client omits it on attempt 2.
 *
 * PURE: this module has NO Azure-SDK / credential / network dependency, so it is
 * unit-testable on its own (aoai-model-contract.test.ts). The unified client
 * (aoai-chat-client.ts) owns the resolve/token/fetch/retry side-effects and
 * calls into this builder for the body.
 *
 * BYTE-IDENTICAL KEY ORDER
 * ------------------------
 * The keys are emitted in the canonical order
 *   messages, tools, tool_choice, temperature, max_completion_tokens,
 *   response_format, stream
 * (undefined fields omitted). That order is a SUPERSET that reproduces the exact
 * JSON.stringify output of all three legacy inline bodies, so flipping
 * LOOM_AOAI_CLIENT_V2 on yields byte-identical request payloads to the legacy
 * inline path. Do not reorder without re-verifying against the inline bodies in
 * copilot-orchestrator.ts.
 */

/**
 * A chat message in the AOAI chat-completions array. Intentionally permissive —
 * a superset of the orchestrator's internal `ChatMessage` so the tool-loop
 * (assistant turns carrying `tool_calls`, `tool` role turns carrying
 * `tool_call_id` / `name`) and the plain system/user helpers both pass through
 * unchanged. The builder never inspects these — it passes the array verbatim.
 */
export interface AoaiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * The `response_format` passthrough. Either the shorthand `'json_object'`
 * (expanded to `{ type: 'json_object' }`) or a full object already in the AOAI
 * shape (e.g. a json_schema response format). Anything else is passed through
 * verbatim.
 */
export type AoaiResponseFormat = 'json_object' | { type: string; [k: string]: unknown };

/** Parameters for {@link buildAoaiBody}. */
export interface AoaiBodyParams {
  /** The chat-completions messages array (passed through verbatim). */
  messages: readonly AoaiChatMessage[];
  /**
   * The token cap. Emitted as `max_completion_tokens` (NEVER `max_tokens`).
   * When omitted, no cap key is emitted (the tool-loop call sends no cap — it
   * relies on the deployment default, matching the legacy `callAoai`).
   */
  maxCompletionTokens?: number;
  /**
   * Sampling temperature. When omitted, NO `temperature` key is emitted — this
   * is exactly how the retry-after-unsupported-sampling-400 attempt is built.
   */
  temperature?: number;
  /** `response_format` passthrough (`'json_object'` shorthand supported). */
  responseFormat?: AoaiResponseFormat;
  /** Server-Sent-Events streaming flag. Emitted as `stream` when defined. */
  stream?: boolean;
  /** OpenAI-compatible tools array (function tools) for the agent tool loop. */
  tools?: readonly unknown[];
  /** `tool_choice` (e.g. `'auto'`). Emitted as `tool_choice` when defined. */
  toolChoice?: unknown;
}

/**
 * Build the Azure OpenAI chat-completions request body from the Loom model
 * contract. Pure — returns a plain object ready for `JSON.stringify`.
 *
 * Emits keys in the canonical byte-identical order documented above. Critically:
 *   - NEVER emits `max_tokens` (rejected by o-series/gpt-5) — only
 *     `max_completion_tokens`, and only when `maxCompletionTokens` is provided.
 *   - Omits `temperature` entirely when not provided (the retry shape).
 *   - Expands the `'json_object'` response-format shorthand.
 */
export function buildAoaiBody(p: AoaiBodyParams): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: p.messages };
  if (p.tools !== undefined) body.tools = p.tools;
  if (p.toolChoice !== undefined) body.tool_choice = p.toolChoice;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  // max_completion_tokens — the ONLY accepted token cap across o-series/gpt-5
  // and gpt-4o. `max_tokens` is intentionally never emitted (systemic 400 bug).
  if (p.maxCompletionTokens !== undefined) body.max_completion_tokens = p.maxCompletionTokens;
  if (p.responseFormat !== undefined) {
    body.response_format =
      typeof p.responseFormat === 'string' ? { type: p.responseFormat } : p.responseFormat;
  }
  if (p.stream !== undefined) body.stream = p.stream;
  return body;
}

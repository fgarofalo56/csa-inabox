/**
 * aoai-chat-client — the ONE unified Azure OpenAI chat-completions client.
 *
 * This is the consolidation target for the ~18 call sites that each rolled their
 * own AOAI chat-completions fetch. It owns every side-effect of a chat call:
 *
 *   1. **Target resolution** — reuses {@link resolveAoaiTarget} from
 *      copilot-orchestrator (tenant config → LOOM_AOAI_ENDPOINT/DEPLOYMENT env →
 *      Foundry hub discovery). A missing deployment throws
 *      {@link NoAoaiDeploymentError} so the caller surfaces the honest 503 gate.
 *   2. **Bearer token** — reuses {@link aoaiToken}, which mints a
 *      ChainedTokenCredential token for {@link cogScope} (`cognitiveservices.azure.us`
 *      in Gov, `.com` in Commercial). Combined with the endpoint suffix from
 *      `getOpenAiSuffix()` (already enforced by `validateEndpointCloud` inside
 *      resolveAoaiTarget) this makes the client Commercial- AND Gov-correct with
 *      no literal `cognitiveservices.azure.com` anywhere — fixing the Gov-scope
 *      401 that hard-coded clients hit.
 *   3. **Request contract** — builds the body via {@link buildAoaiBody}
 *      (aoai-model-contract): `max_completion_tokens` (never `max_tokens`),
 *      optional `temperature`, `response_format` passthrough, `stream`.
 *   4. **Sampling-param retry** — on a 400 whose body is the "model only supports
 *      the default temperature" rejection ({@link isUnsupportedSamplingParam}),
 *      retries ONCE without `temperature`.
 *   5. **Bounded fetch** — every round-trip goes through `fetchWithTimeout` with
 *      the LLM budget (`LLM_FETCH_TIMEOUT_MS`).
 *
 * NO new credential code: the credential / scope / target-resolution all reuse
 * the existing orchestrator + cloud-endpoints helpers.
 *
 * MIGRATION NOTE: the orchestrator's `callAoai` / `aoaiCompleteText` /
 * `aoaiCompleteJson` delegate here ONLY when `LOOM_AOAI_CLIENT_V2 === 'true'`.
 * The public methods below reproduce those three legacy code paths
 * byte-for-byte (same target resolution, same body via the shared contract, same
 * retry, same error text), so the flag is a safe, reversible cut-over.
 *
 * No-vaporware: this performs the REAL AOAI data-plane call (and a real SSE
 * passthrough for {@link aoaiChatStream}); the only non-functional state is the
 * honest NoAoaiDeploymentError 503 gate when no deployment is configured.
 */

import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  resolveAoaiTarget,
  aoaiToken,
  isUnsupportedSamplingParam,
  describeFetchError,
  NoAoaiDeploymentError,
  type AoaiTarget,
} from './copilot-orchestrator';
import { buildAoaiBody, type AoaiChatMessage, type AoaiResponseFormat } from './aoai-model-contract';
import type { TenantCopilotConfig } from '../types/copilot-config';
import { routeTurnTier, DEFAULT_TASK_TIER_MAP, type ModelTier, type TaskClass } from '@/lib/foundry/model-tier-router';
import { resolveAoaiCallTarget, aoaiApimHeaders, type AoaiCallTarget } from './aoai-apim-gateway';

// Re-export so unified-client callers can `instanceof`-check the 503 gate
// without also importing the orchestrator.
export { NoAoaiDeploymentError } from './copilot-orchestrator';
export type { AoaiTarget } from './copilot-orchestrator';
export type { AoaiChatMessage, AoaiResponseFormat } from './aoai-model-contract';

/** AOAI host for logging without leaking the full URL/keys. Mirrors the private
 *  helper in copilot-orchestrator (kept local so the client owns its logging). */
function aoaiHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return endpoint; }
}

/** Build the chat-completions data-plane URL for a resolved target. */
function chatUrl(target: AoaiTarget | AoaiCallTarget): string {
  return `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
}

/**
 * HTTP-status error from an AOAI attempt (the response body has already been
 * read). Distinguished from a transport/connection failure so the M4 APIM→direct
 * fallback does NOT retry a real API error (a 400/404/5xx from the model), only a
 * genuine "gateway unreachable" outage.
 */
class AoaiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AoaiResponseError';
  }
}

/**
 * Run one AOAI attempt against a resolved call target, with automatic
 * APIM→direct fallback (M4). `attempt(call)` performs the full send (including
 * the unsupported-sampling-param retry) and returns the parsed result; it throws
 * {@link AoaiResponseError} for HTTP-status errors and lets transport failures
 * propagate as-is.
 *
 * When routing via APIM and the attempt fails with a TRANSPORT error (the Gov
 * "gateway down / LLM policies absent" case), this retries ONCE against the
 * direct AOAI endpoint with managed identity. When the flag is off
 * (viaApim=false) it is a single pass-through — byte-identical to the pre-M4
 * direct path (no extra try/catch on the hot path).
 */
async function withApimFallback<T>(
  base: AoaiTarget,
  attempt: (call: AoaiCallTarget) => Promise<T>,
): Promise<T> {
  const primary = resolveAoaiCallTarget(base);
  if (!primary.viaApim) return attempt(primary);
  try {
    return await attempt(primary);
  } catch (e) {
    if (e instanceof AoaiResponseError) throw e; // a real API error, not a gateway outage
    // APIM gateway unreachable → direct-with-managed-identity fallback.
    return attempt(resolveAoaiCallTarget(base, { apimAvailable: false }));
  }
}

/**
 * WS-1.1 — apply the Loom-native tier router to a resolved target on the SHARED
 * client path, so EVERY copilot / agent / data-agent turn is tier-aware (not
 * just the streaming orchestrator).
 *
 * Behavior:
 *   • An explicit pre-resolved `target` is the per-call override (Wave-4 model
 *     selector) — never re-routed.
 *   • An explicit `tier`/`taskClass` hint is always honored.
 *   • With NO hint, the turn is auto-classified from its `messages` (and whether
 *     it advertises `tools`) and — via {@link routeTurnTier}'s escalate-only
 *     guard — is upshifted to the STRONG (reasoning) deployment ONLY when the
 *     turn classifies hard AND a strong deployment is configured. A lightweight
 *     turn is never silently downshifted to mini. So the ~18 existing callers
 *     stay byte-identical unless a reasoning deployment is wired and the turn is
 *     hard (WS-1.1 / no-vaporware: real deployment resolution + real routing).
 *
 * The chosen tier is traced (`[tier-router]`) for server-side attribution; the
 * streaming orchestrator surfaces the tier on the SSE final step for the browser
 * transparency chip.
 */
function applyTierRouting(
  base: AoaiTarget,
  opts: {
    cfg?: TenantCopilotConfig | null;
    tier?: ModelTier;
    taskClass?: TaskClass;
    target?: AoaiTarget;
    messages?: readonly AoaiChatMessage[];
    tools?: readonly unknown[];
  },
): AoaiTarget {
  if (opts.target) return base; // explicit target = per-call override; never re-route.
  const sel = routeTurnTier({
    cfg: opts.cfg ?? null,
    tier: opts.tier,
    taskClass: opts.taskClass,
    messages: opts.messages as readonly { role?: string; content?: unknown }[] | undefined,
    hasTools: !!(opts.tools && opts.tools.length),
    baseDeployment: base.deployment,
  });
  if (sel.routed && sel.deployment && sel.deployment !== base.deployment) {
    try {
      console.debug(
        `[tier-router] tier=${sel.tier} taskClass=${sel.taskClass} deployment=${sel.deployment} base=${base.deployment}`,
      );
    } catch { /* trace only */ }
    return { ...base, deployment: sel.deployment };
  }
  return base;
}

/**
 * Model-strategy (M2) — the default `max_completion_tokens` cap for a turn,
 * scaled by the model tier the turn rides so reasoning answers are not truncated
 * (the AOAI `max_completion_tokens` truncation gotcha):
 *   • mini     → 2048  (short lookups / classification / greetings)
 *   • standard → 4096  (most chat + build requests)
 *   • strong   → 8192  (design / debug / multi-step / long-context reasoning)
 *
 * The tier is derived from an explicit `tier`, else the task class' default tier
 * mapping, else `standard`. Each cap is overridable via
 * `LOOM_AOAI_MAX_COMPLETION_TOKENS_{MINI,STANDARD,STRONG}` (a tuning knob — no
 * bicep wiring required). An explicit `opts.maxCompletionTokens` always wins over
 * this default (see the call sites).
 */
function defaultMaxCompletionTokens(opts: { tier?: ModelTier; taskClass?: TaskClass }): number {
  const tier: ModelTier = opts.tier ?? (opts.taskClass ? DEFAULT_TASK_TIER_MAP[opts.taskClass] : 'standard');
  const envName =
    tier === 'mini' ? 'LOOM_AOAI_MAX_COMPLETION_TOKENS_MINI'
    : tier === 'strong' ? 'LOOM_AOAI_MAX_COMPLETION_TOKENS_STRONG'
    : 'LOOM_AOAI_MAX_COMPLETION_TOKENS_STANDARD';
  const fallback = tier === 'mini' ? 2048 : tier === 'strong' ? 8192 : 4096;
  const override = Number(process.env[envName]);
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : fallback;
}

/** Parse an LLM JSON reply, tolerating ```json fences and surrounding prose.
 *  Byte-identical to the orchestrator's private parseJsonObject. */
function parseJsonObject<T>(raw: string): T {
  const cleaned = raw
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1)) as T;
    }
    throw new Error(`Model did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

// ── Public option shapes ─────────────────────────────────────────────────────

/** Options for {@link aoaiChat} / {@link aoaiChatStream}. */
export interface AoaiChatOptions {
  messages: readonly AoaiChatMessage[];
  /** Token cap — emitted as `max_completion_tokens`. When omitted the default is
   *  tier-scaled (mini 2048 / standard 4096 / strong 8192), derived from `tier`
   *  or `taskClass`; overridable via `LOOM_AOAI_MAX_COMPLETION_TOKENS_*`. */
  maxCompletionTokens?: number;
  /** First-attempt sampling temperature (dropped on the unsupported-param retry). */
  temperature?: number;
  /** `response_format` passthrough (e.g. `'json_object'`). */
  responseFormat?: AoaiResponseFormat;
  /** Tenant Copilot config — takes priority in target resolution when supplied. */
  cfg?: TenantCopilotConfig | null;
  /** Pre-resolved target. When supplied (e.g. a route that already called
   *  {@link resolveAoaiTarget} to surface its honest 503 gate), the client
   *  reuses it instead of re-resolving — avoiding a redundant second Foundry
   *  lookup per call. When omitted the client resolves via resolveAoaiTarget(cfg).
   *  Supplying a `target` also PINS the deployment: it is treated as the
   *  Wave-4-style per-call override and the AIF-12 tier router is skipped. */
  target?: AoaiTarget;
  /** AIF-12: force a specific model tier for this call (mini/standard/strong).
   *  Wins over the task-class mapping. Ignored when `target` is supplied. */
  tier?: ModelTier;
  /** AIF-12: task class for the tier router when `tier` is not forced. When both
   *  are omitted the tier router is a no-op (the resolved deployment stands). */
  taskClass?: TaskClass;
}

/** Options for {@link aoaiChatJson}. */
export interface AoaiChatJsonOptions extends AoaiChatOptions {
  /** Defaults to `'json_object'` when omitted. */
  responseFormat?: AoaiResponseFormat;
}

/** Options for the low-level {@link aoaiChatRaw} tool-loop primitive. */
export interface AoaiChatRawOptions {
  /** Pre-resolved target (the orchestrator loop resolves once and passes it in).
   *  When omitted the client resolves it via resolveAoaiTarget(cfg). */
  target?: AoaiTarget;
  messages: readonly AoaiChatMessage[];
  /** OpenAI-compatible function tools advertised to the model. */
  tools?: readonly unknown[];
  /** `tool_choice` (defaults to `'auto'`). */
  toolChoice?: unknown;
  /** First-attempt temperature (dropped on the unsupported-param retry). */
  temperature?: number;
  /** Optional token cap (the legacy tool loop sends none). */
  maxCompletionTokens?: number;
  cfg?: TenantCopilotConfig | null;
  /** AIF-12: force a model tier (ignored when `target` is supplied). */
  tier?: ModelTier;
  /** AIF-12: task class for the tier router when `tier` is not forced. */
  taskClass?: TaskClass;
}

// ── Text completion ──────────────────────────────────────────────────────────

/**
 * Single-shot chat completion → assistant message text.
 *
 * Reproduces the legacy `aoaiCompleteText` path byte-for-byte: resolves the
 * target (no cfg by default), mints a cogScope token, sends with `temperature`,
 * retries once without it on the unsupported-sampling 400, and returns
 * `choices[0].message.content` (or '').
 */
export async function aoaiChat(opts: AoaiChatOptions): Promise<string> {
  const { messages, temperature, responseFormat } = opts;
  const maxCompletionTokens = opts.maxCompletionTokens ?? defaultMaxCompletionTokens(opts);
  const target = applyTierRouting(opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null)), { ...opts, messages });
  const token = await aoaiToken();
  return withApimFallback(target, async (call) => {
    const url = chatUrl(call);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          buildAoaiBody({
            messages,
            maxCompletionTokens,
            temperature: withTemperature ? temperature : undefined,
            responseFormat,
          }),
        ),
      }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) res = await send(false);
      else throw new AoaiResponseError(`AOAI 400: ${t.slice(0, 300)}`);
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiResponseError(`AOAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    return String(j?.choices?.[0]?.message?.content ?? '');
  });
}

// ── JSON completion ──────────────────────────────────────────────────────────

/**
 * Single-shot chat completion → parsed JSON object.
 *
 * Reproduces the legacy `aoaiCompleteJson` path byte-for-byte: resolves the
 * target (honoring `cfg`), requests `response_format: { type: 'json_object' }`,
 * retries once without `temperature` on the unsupported-sampling 400, and parses
 * the reply (tolerating fences / surrounding prose).
 */
export async function aoaiChatJson<T = Record<string, unknown>>(opts: AoaiChatJsonOptions): Promise<T> {
  const { messages, temperature } = opts;
  const maxCompletionTokens = opts.maxCompletionTokens ?? defaultMaxCompletionTokens(opts);
  const responseFormat: AoaiResponseFormat = opts.responseFormat ?? 'json_object';
  const target = applyTierRouting(opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null)), { ...opts, messages });
  const token = await aoaiToken();
  return withApimFallback(target, async (call) => {
    const url = chatUrl(call);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          buildAoaiBody({
            messages,
            maxCompletionTokens,
            temperature: withTemperature ? temperature : undefined,
            responseFormat,
          }),
        ),
      }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) res = await send(false);
      else throw new AoaiResponseError(`AOAI 400: ${t.slice(0, 300)}`);
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiResponseError(`AOAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    const raw = String(j?.choices?.[0]?.message?.content ?? '').trim();
    return parseJsonObject<T>(raw);
  });
}

// ── Tool-loop raw completion ─────────────────────────────────────────────────

/**
 * Low-level chat completion that returns the FULL chat-completions JSON (with
 * `choices`, `usage`, `tool_calls`). This is the primitive the cross-item
 * orchestrator tool loop uses (`callAoai` delegates here under the flag).
 *
 * Reproduces the legacy `callAoai` path byte-for-byte: uses the pre-resolved
 * `target` when supplied, the same token-acquisition + fetch error wrapping
 * (`AOAI auth failed …` / `AOAI chat endpoint unreachable …`), the same
 * `{ messages, tools, tool_choice }` body (NO token cap), and the same
 * `AOAI chat-completions failed <status>: <body…>` (400-char) error text.
 */
export async function aoaiChatRaw(opts: AoaiChatRawOptions): Promise<any> {
  const { messages, tools, temperature, maxCompletionTokens } = opts;
  const toolChoice = opts.toolChoice ?? 'auto';
  const target = applyTierRouting(opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null)), { ...opts, messages, tools });
  let token: string;
  try {
    token = await aoaiToken();
  } catch (e: any) {
    console.error(
      `[copilot] AOAI token acquisition FAILED for host=${aoaiHost(target.endpoint)}: ${describeFetchError(e)}`,
    );
    throw new Error(`AOAI auth failed (could not acquire a managed-identity token): ${e?.message || e}`);
  }
  return withApimFallback(target, async (call) => {
    const url = chatUrl(call);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          buildAoaiBody({
            messages,
            tools,
            toolChoice,
            temperature: withTemperature ? temperature : undefined,
            maxCompletionTokens,
          }),
        ),
      }, LLM_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await send(true);
    } catch (e: any) {
      // Transport failure — let it propagate (NOT an AoaiResponseError) so the APIM
      // fallback can retry direct-with-MI when routing through the gateway.
      console.error(
        `[copilot] AOAI chat-completions fetch THREW for host=${aoaiHost(call.endpoint)} deployment=${call.deployment}: ${describeFetchError(e)}`,
      );
      throw new Error(`AOAI chat endpoint unreachable (${aoaiHost(call.endpoint)}): ${describeFetchError(e)}`);
    }
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) {
        res = await send(false);
      } else {
        throw new AoaiResponseError(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
      }
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiResponseError(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
    }
    return res.json();
  });
}

// ── Embeddings ───────────────────────────────────────────────────────────────

/** Options for {@link aoaiEmbed}. */
export interface AoaiEmbedOptions {
  /** One text or a batch of texts to embed (the AOAI `input` field). */
  input: string | readonly string[];
  /**
   * Embeddings deployment name. Defaults to `LOOM_AOAI_EMBED_DEPLOYMENT`,
   * then `text-embedding-3-large`. This is distinct from the CHAT deployment —
   * the endpoint + api-version are shared (resolved via {@link resolveAoaiTarget}),
   * only the deployment segment differs.
   */
  deployment?: string;
  /** Tenant Copilot config — forwarded to target resolution (endpoint/token). */
  cfg?: TenantCopilotConfig | null;
  /** Pre-resolved chat target — its endpoint + apiVersion are reused (the
   *  embeddings deployment is swapped in), avoiding a second Foundry lookup. */
  target?: AoaiTarget;
}

/** Result of {@link aoaiEmbed}: one vector per input, plus the token usage. */
export interface AoaiEmbedResult {
  vectors: number[][];
  /** The embeddings deployment that served the request. */
  model: string;
  usage?: { promptTokens: number; totalTokens: number };
}

/**
 * Real Azure OpenAI EMBEDDINGS data-plane call — the unified client's embeddings
 * primitive (used by the AI-functions `embed` / `similarity` operations).
 *
 * Reuses the SAME target resolution + `cogScope` bearer token as the chat path
 * (so it is Commercial- AND Gov-correct with no literal endpoint), then POSTs to
 * `/openai/deployments/<embeddingsDeployment>/embeddings`. Returns one vector per
 * input plus the real `usage` (prompt/total tokens) from the response.
 *
 * No-vaporware: a missing chat/embeddings deployment still surfaces the honest
 * gate — {@link resolveAoaiTarget} throws {@link NoAoaiDeploymentError} when AOAI
 * is unconfigured, and a 404 (embeddings model not deployed) throws an error that
 * names `LOOM_AOAI_EMBED_DEPLOYMENT` as the exact remediation.
 */
export async function aoaiEmbed(opts: AoaiEmbedOptions): Promise<AoaiEmbedResult> {
  const base = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const deployment = (
    opts.deployment || process.env.LOOM_AOAI_EMBED_DEPLOYMENT || 'text-embedding-3-large'
  ).trim();
  const token = await aoaiToken();
  return withApimFallback(base, async (call) => {
    const url = `${call.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${call.apiVersion}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) },
        body: JSON.stringify({ input: opts.input }),
      },
      LLM_FETCH_TIMEOUT_MS,
    );
    if (res.status === 404) {
      const t = await res.text().catch(() => '');
      throw new AoaiResponseError(
        `Azure OpenAI embeddings deployment "${deployment}" not found. Deploy a text-embedding model ` +
          `(e.g. text-embedding-3-large) on the Foundry hub and set LOOM_AOAI_EMBED_DEPLOYMENT. ${t.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AoaiResponseError(`AOAI embeddings ${res.status}: ${t.slice(0, 300)}`);
    }
    const j: any = await res.json();
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    const vectors: number[][] = rows
      .map((d) => (Array.isArray(d?.embedding) ? (d.embedding as number[]) : []))
      .filter((v) => v.length > 0);
    if (vectors.length === 0) throw new Error('AOAI embeddings returned no vectors.');
    const u = j?.usage || {};
    return {
      vectors,
      model: deployment,
      usage: u.total_tokens != null ? { promptTokens: u.prompt_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined,
    };
  });
}

// ── Streaming completion (SSE passthrough) ───────────────────────────────────

/**
 * Streaming chat completion → the raw `Response` with the AOAI SSE body intact,
 * for a BFF route to pipe straight to the browser (`return new Response(res.body, …)`).
 *
 * Resolves the target + token, sends `stream: true`, applies the same
 * unsupported-sampling-param retry-without-temperature, and on a non-OK status
 * throws an honest `AOAI stream <status>: <body…>` error. The caller owns the
 * SSE body — this function does NOT read it. A missing deployment still throws
 * {@link NoAoaiDeploymentError} (the 503 gate) before any fetch.
 */
export async function aoaiChatStream(opts: AoaiChatOptions): Promise<Response> {
  const { messages, temperature, responseFormat } = opts;
  const maxCompletionTokens = opts.maxCompletionTokens ?? defaultMaxCompletionTokens(opts);
  const target = applyTierRouting(opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null)), { ...opts, messages });
  const token = await aoaiToken();
  return withApimFallback(target, async (call) => {
    const url = chatUrl(call);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          buildAoaiBody({
            messages,
            maxCompletionTokens,
            temperature: withTemperature ? temperature : undefined,
            responseFormat,
            stream: true,
          }),
        ),
      }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) res = await send(false);
      else throw new AoaiResponseError(`AOAI stream 400: ${t.slice(0, 300)}`);
    }
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new AoaiResponseError(`AOAI stream ${res.status}: ${t.slice(0, 300)}`);
    }
    return res;
  });
}

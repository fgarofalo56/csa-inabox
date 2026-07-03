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
function chatUrl(target: AoaiTarget): string {
  return `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
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
  /** Token cap. Default 2048 — emitted as `max_completion_tokens`. */
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
   *  lookup per call. When omitted the client resolves via resolveAoaiTarget(cfg). */
  target?: AoaiTarget;
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
  const maxCompletionTokens = opts.maxCompletionTokens ?? 2048;
  const target = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const url = chatUrl(target);
  const token = await aoaiToken();
  const send = (withTemperature: boolean) =>
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
    else throw new Error(`AOAI 400: ${t.slice(0, 300)}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  return String(j?.choices?.[0]?.message?.content ?? '');
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
  const maxCompletionTokens = opts.maxCompletionTokens ?? 2048;
  const responseFormat: AoaiResponseFormat = opts.responseFormat ?? 'json_object';
  const target = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const url = chatUrl(target);
  const token = await aoaiToken();
  const send = (withTemperature: boolean) =>
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
    else throw new Error(`AOAI 400: ${t.slice(0, 300)}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const raw = String(j?.choices?.[0]?.message?.content ?? '').trim();
  return parseJsonObject<T>(raw);
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
  const target = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const url = chatUrl(target);
  let token: string;
  try {
    token = await aoaiToken();
  } catch (e: any) {
    console.error(
      `[copilot] AOAI token acquisition FAILED for host=${aoaiHost(target.endpoint)}: ${describeFetchError(e)}`,
    );
    throw new Error(`AOAI auth failed (could not acquire a managed-identity token): ${e?.message || e}`);
  }
  const send = (withTemperature: boolean) =>
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
    console.error(
      `[copilot] AOAI chat-completions fetch THREW for host=${aoaiHost(target.endpoint)} deployment=${target.deployment}: ${describeFetchError(e)}`,
    );
    throw new Error(`AOAI chat endpoint unreachable (${aoaiHost(target.endpoint)}): ${describeFetchError(e)}`);
  }
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) {
      res = await send(false);
    } else {
      throw new Error(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
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
  const maxCompletionTokens = opts.maxCompletionTokens ?? 2048;
  const target = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const url = chatUrl(target);
  const token = await aoaiToken();
  const send = (withTemperature: boolean) =>
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
    else throw new Error(`AOAI stream 400: ${t.slice(0, 300)}`);
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`AOAI stream ${res.status}: ${t.slice(0, 300)}`);
  }
  return res;
}

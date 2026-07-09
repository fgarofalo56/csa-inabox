/**
 * AI Functions client for Loom — Azure-native GPT-class text operations.
 *
 * This is the REAL backend for the data-science "AI Functions" surface. It is a
 * thin wrapper over the SAME live AOAI chat-completions deployment that the
 * cross-item Copilot and the data-agent test-chat resolve (resolveAoaiTarget),
 * so every function is genuinely live whenever an AOAI model is deployed on the
 * Foundry hub — no mock arrays, no fake echoes. When no model is deployed the
 * caller surfaces an honest gate (NoAoaiDeploymentError), exactly like the
 * data-agent run-steps route.
 *
 * Nine functions mirror Fabric's full AI Functions set:
 *   summarize · classify · sentiment · extract · translate       (chat)
 *   fix_grammar · generate_response                              (chat)
 *   embed · similarity                                           (embeddings)
 *
 * The seven chat functions map a single system prompt + a user message that
 * wraps `input`, run one chat-completions round-trip (with the reasoning-model
 * temperature fallback copied from data-agent-client.ts), and return the model
 * text plus the deployment + token usage. The two embeddings functions call the
 * SAME unified client's `aoaiEmbed` (Azure OpenAI embeddings data-plane):
 * `embed` returns the vector; `similarity` returns the cosine of two embeddings.
 * No Microsoft Fabric / Power BI dependency — pure Azure OpenAI.
 */
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { resolveAoaiTarget, NoAoaiDeploymentError } from './copilot-orchestrator';
import { aoaiEmbed } from './aoai-chat-client';
import { buildAoaiBody } from './aoai-model-contract';
import { cogScope } from './cloud-endpoints';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// Re-export so the BFF route imports the gate error from one place.
export { NoAoaiDeploymentError };

export type AiFn =
  | 'summarize'
  | 'classify'
  | 'sentiment'
  | 'extract'
  | 'translate'
  | 'fix_grammar'
  | 'generate_response'
  | 'embed'
  | 'similarity';

export const AI_FN_NAMES: readonly AiFn[] = [
  'summarize',
  'classify',
  'sentiment',
  'extract',
  'translate',
  'fix_grammar',
  'generate_response',
  'embed',
  'similarity',
] as const;

export function isAiFn(v: unknown): v is AiFn {
  return typeof v === 'string' && (AI_FN_NAMES as readonly string[]).includes(v);
}

export interface AiFnOptions {
  /** Max completion tokens (default 800). */
  maxTokens?: number;
  /** Candidate labels for `classify` (the model must return exactly one). */
  labels?: string[];
  /** Field names for `extract` (returned as a JSON object). */
  fields?: string[];
  /** Target language for `translate` (e.g. "Spanish", "fr-FR"). */
  targetLang?: string;
  /**
   * Second text for `similarity` — the cosine is computed between `input` and
   * this value's embeddings. Required for `similarity`.
   */
  compareTo?: string;
  /**
   * Embeddings deployment override for `embed` / `similarity`. Defaults to
   * `LOOM_AOAI_EMBED_DEPLOYMENT` then `text-embedding-3-large`.
   */
  embeddingDeployment?: string;
  /**
   * Admin-picked tenant Copilot config (Admin → Tenant settings → Copilot &
   * Agents). When supplied it is forwarded to `resolveAoaiTarget` so an
   * admin-selected Foundry account + chat deployment is honored even when the
   * `LOOM_AOAI_*` env vars are unset. Threaded by the BFF callers, which load
   * it via `loadTenantCopilotConfig(session.claims.oid)`. The library client has
   * no session of its own, so it relies on the caller to populate this.
   */
  tenantConfig?: TenantCopilotConfig | null;
  /**
   * FGC-19 model-tier: an explicit chat deployment name to run this function
   * against, overriding the resolved default. The Fast/default tier passes
   * nothing (uses the resolved deployment); the Advanced tier passes a
   * higher-reasoning deployment the user picked from the live deployments list.
   * Only the deployment segment of the resolved endpoint is swapped — the
   * endpoint host + api-version stay as resolved (same Foundry account).
   */
  deployment?: string;
  /**
   * FGC-19 reasoning-effort — passed through as `reasoning_effort` on the chat
   * body for reasoning-class deployments (o-series / gpt-5 / MAI-*). Ignored by
   * gpt-4o-class models; if a deployment rejects it with a 400 the client
   * retries once without it (same fallback shape as the temperature retry).
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface AiFnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiFnResult {
  result: string;
  model: string;
  usage?: AiFnUsage;
  /** Populated by `embed`: the embedding vector for `input`. */
  vector?: number[];
  /** Populated by `similarity`: cosine similarity in [-1, 1]. */
  similarity?: number;
}

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token for AI Functions');
  return t.token;
}

/**
 * Build the system prompt for a function. The `classify` / `extract` /
 * `translate` prompts incorporate their option values so the model's contract
 * is explicit (return only the label / only valid JSON / only the translation).
 */
function systemPromptFor(fn: AiFn, options: AiFnOptions): string {
  switch (fn) {
    case 'summarize':
      return 'Summarize the following text concisely in 2-3 sentences. Return only the summary, no preamble.';
    case 'classify': {
      const labels = (options.labels && options.labels.length)
        ? options.labels.join(', ')
        : 'positive, negative, neutral';
      return `Classify the following text into exactly one of these labels: ${labels}. Return only the label, nothing else.`;
    }
    case 'sentiment':
      return 'Classify the sentiment of the following text as positive, negative, or neutral. Return only the single label, nothing else.';
    case 'extract': {
      const fields = (options.fields && options.fields.length)
        ? options.fields.join(', ')
        : 'all salient fields';
      return `Extract the following fields as a JSON object: ${fields}. Return only valid JSON with those keys, no markdown fences and no commentary.`;
    }
    case 'translate': {
      const lang = options.targetLang?.trim() || 'English';
      return `Translate the following text to ${lang}. Return only the translation, no quotes and no commentary.`;
    }
    case 'fix_grammar':
      return 'Correct the spelling, grammar, and punctuation of the following text. Preserve the original meaning and tone. Return only the corrected text — no quotes, no commentary, and no explanation of the changes.';
    case 'generate_response':
      return 'You are a helpful assistant. Generate a clear, professional response to the following message or prompt. Return only the response text, with no preamble.';
    default:
      // Exhaustiveness guard — never reached for a valid AiFn (embed/similarity
      // are handled before the chat path and never call systemPromptFor).
      return 'Process the following text and return the result.';
  }
}

/**
 * Strip a leading/trailing markdown code fence the model sometimes wraps JSON
 * (or other output) in, so callers get clean text. Mirrors the fence handling
 * in data-agent-client.ts::parseAnswer.
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when
 * either vector has zero magnitude. Used by the `similarity` AI function.
 */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Run one AI function against the live AOAI deployment.
 *
 * Throws NoAoaiDeploymentError when no model is deployed (the route surfaces an
 * honest `{ok:false, code:'not_configured'}` gate). No Microsoft Fabric or
 * Power BI dependency — pure Azure OpenAI.
 *
 * `embed` / `similarity` use the unified client's `aoaiEmbed` (Azure OpenAI
 * embeddings data-plane); the other seven are single chat-completions calls.
 */
export async function callAiFn(
  fn: AiFn,
  input: string,
  options: AiFnOptions = {},
): Promise<AiFnResult> {
  // ── Embeddings-backed functions (no chat round-trip) ──────────────────────
  if (fn === 'embed') {
    const { vectors, model, usage } = await aoaiEmbed({
      input,
      deployment: options.embeddingDeployment,
      cfg: options.tenantConfig ?? null,
    });
    const vec = vectors[0] || [];
    return {
      result: `${vec.length}-dimension embedding`,
      model,
      vector: vec,
      usage: usage
        ? { promptTokens: usage.promptTokens, completionTokens: 0, totalTokens: usage.totalTokens }
        : undefined,
    };
  }
  if (fn === 'similarity') {
    const other = (options.compareTo || '').trim();
    if (!other) throw new Error('similarity requires a second text (options.compareTo).');
    const { vectors, model, usage } = await aoaiEmbed({
      input: [input, other],
      deployment: options.embeddingDeployment,
      cfg: options.tenantConfig ?? null,
    });
    if (vectors.length < 2) throw new Error('embeddings did not return two vectors for similarity.');
    const score = cosine(vectors[0], vectors[1]);
    return {
      result: score.toFixed(4),
      model,
      similarity: score,
      usage: usage
        ? { promptTokens: usage.promptTokens, completionTokens: 0, totalTokens: usage.totalTokens }
        : undefined,
    };
  }

  // ── Chat-completions functions ────────────────────────────────────────────
  return chatComplete(systemPromptFor(fn, options), input, options, `AI function "${fn}"`);
}

/** One row's result in a batch AI-function run. */
export interface AiFnBatchRow {
  /** The 0-based index of this input in the request array. */
  index: number;
  input: string;
  /** The model output for this row (empty string when `error` is set). */
  result: string;
  error?: string;
}

export interface AiFnBatchResult {
  rows: AiFnBatchRow[];
  model: string;
  usage: AiFnUsage;
  /** Number of rows that failed (error set). */
  failed: number;
}

/**
 * Run one AI function over an ARRAY of inputs with bounded concurrency — the
 * table/DataFrame ("per-column") batch mode reused by the Data Wrangler AI tab
 * (FGC-16) and the item-scoped ai-function BFF route. Each row is a real
 * `callAiFn` round-trip against the SAME live AOAI deployment; a per-row failure
 * is captured on that row (never aborts the batch). Token usage is summed across
 * rows so the caller can emit one aggregate chargeback receipt.
 *
 * Concurrency is capped (default 4) to stay within AOAI rate limits and the
 * Front Door / serverless time budget; callers should also cap the row count.
 */
export async function callAiFnBatch(
  fn: AiFn,
  inputs: string[],
  options: AiFnOptions = {},
  concurrency = 4,
): Promise<AiFnBatchResult> {
  const rows: AiFnBatchRow[] = new Array(inputs.length);
  const usage: AiFnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let failed = 0;
  let model = options.deployment || '';
  const limit = Math.max(1, Math.min(concurrency, 8));

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= inputs.length) return;
      const input = inputs[i] ?? '';
      // Empty cells pass through unchanged — never a wasted AOAI call.
      if (!input.trim()) {
        rows[i] = { index: i, input, result: '' };
        continue;
      }
      try {
        const r = await callAiFn(fn, input, options);
        rows[i] = { index: i, input, result: r.result };
        if (r.model) model = r.model;
        if (r.usage) {
          usage.promptTokens += r.usage.promptTokens;
          usage.completionTokens += r.usage.completionTokens;
          usage.totalTokens += r.usage.totalTokens;
        }
      } catch (e: any) {
        // A NoAoaiDeploymentError means NOTHING will succeed — rethrow so the
        // route surfaces the honest gate instead of N identical per-row errors.
        if (e instanceof NoAoaiDeploymentError) throw e;
        failed += 1;
        rows[i] = { index: i, input, result: '', error: e?.message || String(e) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return { rows, model, usage, failed };
}

/**
 * Shared chat-completions core for every text AI function AND the ai-enrichment
 * `custom_prompt` path. Resolves the AOAI target, applies the FGC-19 model-tier
 * deployment override + reasoning-effort, and runs a single round-trip with the
 * reasoning-model fallback (drops `temperature` + `reasoning_effort` on retry).
 */
async function chatComplete(
  systemPrompt: string,
  input: string,
  options: AiFnOptions,
  label: string,
): Promise<AiFnResult> {
  const target = await resolveAoaiTarget(options.tenantConfig ?? false);
  const token = await aoaiToken();
  // FGC-19 model-tier: swap ONLY the deployment segment when an explicit
  // Advanced-tier deployment is supplied (same endpoint host + api-version).
  const deployment = (options.deployment && options.deployment.trim()) || target.deployment;
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${target.apiVersion}`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: input },
  ];
  const reasoningEffort = options.reasoningEffort;

  const send = async (full: boolean) => {
    const body = buildAoaiBody({
      messages,
      maxCompletionTokens: options.maxTokens ?? 800,
      temperature: full ? 0 : undefined,
    });
    if (full && reasoningEffort) body.reasoning_effort = reasoningEffort;
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, LLM_FETCH_TIMEOUT_MS);
  };

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (/unsupported_value|does not support|Only the default \(1\) value is supported|reasoning_effort/i.test(t) && /temperature|top_p|reasoning_effort/i.test(t)) {
      res = await send(false);
    } else {
      throw new Error(`${label} failed (400): ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${label} failed (${res.status}): ${t.slice(0, 400)}`);
  }

  const j: any = await res.json();
  const content: string = j?.choices?.[0]?.message?.content || '';
  const u = j?.usage || {};

  return {
    result: stripFences(content),
    model: deployment,
    usage: (u.total_tokens != null)
      ? {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Run a user-authored custom prompt over one input value — the ai-enrichment
 * `custom_prompt` op. The prompt IS the content (the one allowed freeform field
 * per no-freeform-config); `input` is wrapped as the user message. Same live
 * AOAI deployment, model-tier override, and honest gate as `callAiFn`.
 */
export async function callCustomPrompt(
  systemPrompt: string,
  input: string,
  options: AiFnOptions = {},
): Promise<AiFnResult> {
  const prompt = (systemPrompt || '').trim();
  if (!prompt) throw new Error('custom_prompt requires a non-empty prompt.');
  return chatComplete(prompt, input, options, 'Custom-prompt enrichment');
}

/** Persona tag used for AI-function usage receipts in App Insights / the
 *  usage-chargeback + copilot-usage admin panels. */
export const AI_FN_PERSONA = 'ai-function';

/**
 * Fire-and-forget usage receipt for one AI-function call. Emits a
 * `copilot.usage` App Insights event (persona `ai-function`) carrying the REAL
 * prompt/completion tokens from the AOAI response, so the admin usage-chargeback
 * + copilot-usage panels meter AI-function consumption alongside the Copilot
 * personas. Never awaited on the hot path; never throws. No-op when App Insights
 * is unconfigured (honest gate inside emitCopilotUsage).
 *
 * `emitCopilotUsage` is imported lazily to keep this module's import graph light
 * for the callers that only need `callAiFn`.
 */
export async function emitAiFnUsage(
  fn: AiFn,
  usage: AiFnUsage | undefined,
  model: string,
  userOid: string,
): Promise<void> {
  if (!usage || usage.totalTokens <= 0) return;
  try {
    const { emitCopilotUsage } = await import('./copilot-orchestrator');
    await emitCopilotUsage(
      {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        aoaiCalls: fn === 'similarity' ? 2 : 1,
        toolCalls: 0,
      },
      model,
      `ai-function:${fn}`,
      userOid,
      AI_FN_PERSONA,
    );
  } catch {
    // Metering must never break the AI-function response.
  }
}

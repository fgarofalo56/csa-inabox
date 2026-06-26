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
 * Five functions mirror Fabric's AI Functions DataFrame APIs:
 *   summarize · classify · sentiment · extract · translate
 *
 * Each maps a single system prompt + a user message that wraps `input`, runs
 * one chat-completions round-trip (with the reasoning-model temperature
 * fallback copied from data-agent-client.ts), and returns the model text plus
 * the deployment + token usage.
 */
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { resolveAoaiTarget, NoAoaiDeploymentError } from './copilot-orchestrator';
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

export type AiFn = 'summarize' | 'classify' | 'sentiment' | 'extract' | 'translate';

export const AI_FN_NAMES: readonly AiFn[] = [
  'summarize',
  'classify',
  'sentiment',
  'extract',
  'translate',
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
   * Admin-picked tenant Copilot config (Admin → Tenant settings → Copilot &
   * Agents). When supplied it is forwarded to `resolveAoaiTarget` so an
   * admin-selected Foundry account + chat deployment is honored even when the
   * `LOOM_AOAI_*` env vars are unset. Threaded by the BFF callers, which load
   * it via `loadTenantCopilotConfig(session.claims.oid)`. The library client has
   * no session of its own, so it relies on the caller to populate this.
   */
  tenantConfig?: TenantCopilotConfig | null;
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
}

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken('https://cognitiveservices.azure.com/.default');
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
    default:
      // Exhaustiveness guard — never reached for a valid AiFn.
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
 * Run one AI function against the live AOAI deployment.
 *
 * Throws NoAoaiDeploymentError when no model is deployed (the route surfaces an
 * honest `{ok:false, code:'not_configured'}` gate). No Microsoft Fabric or
 * Power BI dependency — pure Azure OpenAI.
 */
export async function callAiFn(
  fn: AiFn,
  input: string,
  options: AiFnOptions = {},
): Promise<AiFnResult> {
  const target = await resolveAoaiTarget(options.tenantConfig ?? false);
  const token = await aoaiToken();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;

  const messages = [
    { role: 'system', content: systemPromptFor(fn, options) },
    { role: 'user', content: input },
  ];
  const base: Record<string, unknown> = { messages, max_completion_tokens: options.maxTokens ?? 800 };

  // Single round-trip with the reasoning-model temperature fallback copied
  // verbatim from data-agent-client.ts::runChat.
  const send = async (withTemp: boolean) => fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(withTemp ? { ...base, temperature: 0 } : base),
  }, LLM_FETCH_TIMEOUT_MS);

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (/unsupported_value|does not support|Only the default \(1\) value is supported/i.test(t) && /temperature|top_p/i.test(t)) {
      res = await send(false);
    } else {
      throw new Error(`AI function "${fn}" failed (400): ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI function "${fn}" failed (${res.status}): ${t.slice(0, 400)}`);
  }

  const j: any = await res.json();
  const content: string = j?.choices?.[0]?.message?.content || '';
  const u = j?.usage || {};

  return {
    result: stripFences(content),
    model: target.deployment,
    usage: (u.total_tokens != null)
      ? {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * knowledge-base-model — pure composition helpers for binding an Azure OpenAI
 * model to an AI Search Knowledge Base (agentic retrieval / Foundry IQ), AIF-1.
 *
 * Wave 3 (#1729) shipped Knowledge Sources + Knowledge Bases with EXTRACTIVE
 * retrieval only: the create-base wizard collected name + sources +
 * reasoning-effort but never let the operator bind an AOAI model, so a base
 * could not be configured for `answerSynthesis` and the Retrieve pane's
 * "Synthesize a single answer" switch could never succeed. This module is the
 * pure, network-free logic that closes that gap — it turns an AOAI model-
 * deployment choice into the `KnowledgeBaseModel` the client/route already
 * accept, and validates the output-mode ↔ model pairing so a synthesis base is
 * never created without an LLM (per no-vaporware.md).
 *
 * Kept separate + pure so it is unit-testable without a live Search / AOAI
 * service. The real REST call stays in `aisearch-knowledge.ts`. No mocks, no
 * Fabric / Power BI dependency (per no-fabric-dependency.md) — the model is an
 * Azure OpenAI deployment resolved from the Foundry Cognitive Services account.
 */

import type { KnowledgeBaseModel } from './aisearch-knowledge';

/** Output mode the composer offers. Extractive is the GA default (no model). */
export type KbOutputMode = 'extractiveData' | 'answerSynthesis';

/**
 * An AOAI model-deployment choice for query planning / answer synthesis, as
 * surfaced by the model picker (fed by `/api/foundry/model-deployments`).
 * `resourceUri` is the Cognitive Services account endpoint (e.g. the account's
 * `.openai.azure.com` URI); `deploymentId` is the deployment NAME on that
 * account; `modelName` is the underlying model (e.g. `gpt-4o-mini`).
 */
export interface AoaiModelChoice {
  resourceUri: string;
  deploymentId: string;
  modelName?: string;
}

/**
 * Prefixes of Cognitive Services model families that are NOT chat-completion
 * models and therefore must NOT appear in the knowledge-base query-planning /
 * synthesis picker (embeddings, transcription, speech, image gen). Anchored at
 * the start of the model name; matched case-insensitively. Kept as a small
 * explicit denylist so a new chat family is included by default (allowlist-by-
 * omission would silently drop new gpt-* families).
 */
const NON_CHAT_MODEL_PREFIXES = [
  'text-embedding',
  'ada',
  'text-similarity',
  'whisper',
  'tts',
  'dall-e',
  'gpt-image',
] as const;

/**
 * True when a model deployment can serve query planning / answer synthesis for
 * a knowledge base (i.e. it is a chat-completion model, not an embedding /
 * audio / image model). Pure; anchored, backtracking-free string checks only.
 */
export function isChatCompletionModel(modelName: string | undefined | null): boolean {
  const m = String(modelName || '').trim().toLowerCase();
  if (!m) return false;
  for (const p of NON_CHAT_MODEL_PREFIXES) {
    // Anchored prefix comparison — no regex, so no ReDoS surface.
    if (m.startsWith(p)) return false;
  }
  return true;
}

/**
 * Build the `KnowledgeBaseModel` payload from a picked AOAI deployment.
 * Throws a plain Error (surfaced to the UI) when a required field is missing so
 * a malformed model reference never reaches the REST call. `modelName` falls
 * back to the deployment id when the deployment doesn't report an underlying
 * model name.
 */
export function buildKnowledgeBaseModel(choice: AoaiModelChoice): KnowledgeBaseModel {
  const resourceUri = String(choice?.resourceUri || '').trim().replace(/\/+$/, '');
  const deploymentId = String(choice?.deploymentId || '').trim();
  const modelName = String(choice?.modelName || '').trim() || deploymentId;
  if (!resourceUri) throw new Error('a query-planning / synthesis model requires the AOAI account endpoint (resourceUri)');
  if (!/^https:\/\//i.test(resourceUri)) throw new Error(`AOAI resourceUri must be an https endpoint (got "${resourceUri.slice(0, 60)}")`);
  if (!deploymentId) throw new Error('a query-planning / synthesis model requires a deployment');
  return {
    kind: 'azureOpenAI',
    azureOpenAIParameters: { resourceUri, deploymentId, modelName },
  };
}

/** Input for {@link composeKnowledgeBaseModels}. */
export interface KbCompositionInput {
  /** True when the operator chose a synthesized (LLM-formulated) answer. */
  synthesize: boolean;
  /** The picked model, or null when none selected. */
  model: AoaiModelChoice | null;
  /**
   * Reasoning effort beyond the service default also drives model-based query
   * planning; a low/medium effort benefits from (but does not require) a model.
   */
  reasoningEffort?: 'default' | 'minimal' | 'low' | 'medium';
}

/**
 * Result of composing the output-mode + model[] the create-base POST body needs.
 * `error` is a human-readable validation message when the pairing is invalid
 * (e.g. synthesis without a model); when set, the caller must NOT submit.
 */
export interface KbComposition {
  outputMode: KbOutputMode;
  models: KnowledgeBaseModel[];
  error?: string;
}

/**
 * Resolve the {@link KbOutputMode} + `models[]` for the create/update payload.
 *
 * Rules (grounded in the agentic-retrieval REST contract the client enforces):
 *   - `answerSynthesis` REQUIRES a model → error if none picked.
 *   - `extractiveData` (default) works with or without a model; a picked model
 *     is still forwarded so it drives query planning at higher reasoning effort.
 *   - A picked-but-malformed model surfaces its build error instead of the mode
 *     error, so the operator sees the specific field that's wrong.
 */
export function composeKnowledgeBaseModels(input: KbCompositionInput): KbComposition {
  const outputMode: KbOutputMode = input.synthesize ? 'answerSynthesis' : 'extractiveData';
  let models: KnowledgeBaseModel[] = [];
  if (input.model) {
    try {
      models = [buildKnowledgeBaseModel(input.model)];
    } catch (e: any) {
      return { outputMode, models: [], error: e?.message || String(e) };
    }
  }
  if (outputMode === 'answerSynthesis' && models.length === 0) {
    return {
      outputMode,
      models,
      error: 'Synthesized answers require a query-planning / synthesis model. Pick an Azure OpenAI chat deployment, or switch to Extractive grounding.',
    };
  }
  return { outputMode, models };
}

/** A one-line, human-readable summary of a base's answer behavior (for the UI). */
export function describeKbOutputMode(outputMode: string | undefined, hasModel: boolean): string {
  if (outputMode === 'answerSynthesis') return 'Synthesized answer (LLM)';
  return hasModel ? 'Extractive grounding (model-planned)' : 'Extractive grounding';
}

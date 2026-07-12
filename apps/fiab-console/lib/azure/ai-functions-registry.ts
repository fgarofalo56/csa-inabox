/**
 * AI-functions registry — client-safe metadata for the nine Loom AI functions.
 *
 * This module has NO server imports (no @azure/identity, no fetch client), so it
 * is safe to import from client components (the "Add AI column" dialog, the
 * Dataflow AI step) AND from the server route. It is the single source of truth
 * for the function list + which per-function options each needs + which support
 * a multimodal (vision) input, kept 1:1 with `AI_FN_NAMES` in
 * `ai-functions-client.ts` (per no-fabric-dependency.md — pure Azure OpenAI).
 */

/** The nine AI functions (kept in sync with AI_FN_NAMES on the server). */
export type AiFnKey =
  | 'summarize'
  | 'classify'
  | 'sentiment'
  | 'extract'
  | 'translate'
  | 'fix_grammar'
  | 'generate_response'
  | 'embed'
  | 'similarity';

export interface AiFnMeta {
  key: AiFnKey;
  label: string;
  desc: string;
  /** 'chat' = chat-completions; 'embed' = AOAI embeddings data-plane. */
  category: 'chat' | 'embed';
  /** Per-function option fields the UI must collect. */
  needs?: { labels?: boolean; fields?: boolean; targetLang?: boolean; compareTo?: boolean };
  /** True when the function can accept an image/document (vision) input column. */
  supportsVision?: boolean;
}

/** The canonical ordered registry — drives the function pickers + validation. */
export const AI_FN_META: readonly AiFnMeta[] = [
  { key: 'summarize', label: 'Summarize', desc: 'a concise 2–3 sentence summary', category: 'chat', supportsVision: true },
  { key: 'classify', label: 'Classify', desc: 'assign exactly one of your labels', category: 'chat', needs: { labels: true }, supportsVision: true },
  { key: 'sentiment', label: 'Sentiment', desc: 'positive / negative / neutral', category: 'chat' },
  { key: 'extract', label: 'Extract', desc: 'pull named fields out as JSON', category: 'chat', needs: { fields: true }, supportsVision: true },
  { key: 'translate', label: 'Translate', desc: 'translate the text to a target language', category: 'chat', needs: { targetLang: true } },
  { key: 'fix_grammar', label: 'Fix grammar', desc: 'correct spelling, grammar & punctuation', category: 'chat' },
  { key: 'generate_response', label: 'Generate response', desc: 'draft a reply to the text', category: 'chat' },
  { key: 'embed', label: 'Embeddings', desc: 'vector embedding of the text (AOAI)', category: 'embed' },
  { key: 'similarity', label: 'Similarity', desc: 'cosine similarity vs a second text (AOAI)', category: 'embed', needs: { compareTo: true } },
] as const;

/** All nine keys in canonical order. */
export const AI_FN_KEYS: readonly AiFnKey[] = AI_FN_META.map((m) => m.key);

export function aiFnMeta(key: string): AiFnMeta | undefined {
  return AI_FN_META.find((m) => m.key === key);
}

export function isAiFnKey(v: unknown): v is AiFnKey {
  return typeof v === 'string' && AI_FN_KEYS.includes(v as AiFnKey);
}

/** A field in a schema-builder extraction (G2 #6). */
export interface AiSchemaField {
  /** Output column name / JSON key. */
  field: string;
  /** Loosely-typed hint the model is asked to honor. */
  type: 'string' | 'number' | 'boolean' | 'date';
  /** Natural-language description of what to extract for this field. */
  prompt: string;
}

/**
 * Build the structured-extraction system prompt for a schema (G2 #6). One AOAI
 * pass returns a JSON object keyed by every field; the caller splits it into one
 * output column per field. Mirrors the `extract` prompt contract in
 * `ai-functions-client.ts` (return only valid JSON, no fences, no commentary).
 */
export function buildSchemaExtractPrompt(schema: AiSchemaField[]): string {
  const lines = schema.map(
    (f) => `- "${f.field}" (${f.type}): ${f.prompt || `the ${f.field}`}`,
  );
  return (
    'Extract the following fields from the text and return ONLY a single valid JSON ' +
    'object with exactly these keys (no markdown fences, no commentary):\n' +
    lines.join('\n') +
    '\nIf a field is not present, use null for its value.'
  );
}

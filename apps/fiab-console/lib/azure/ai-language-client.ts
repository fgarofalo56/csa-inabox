/**
 * Azure AI Language (Text Analytics) data-plane client.
 *
 * Real `:analyze-text` REST — synchronous 200 for the enrichment tasks the
 * pipeline needs: PII detection/redaction, sentiment, entity recognition, and
 * key-phrase extraction. Entra-auth only, sovereign-cloud aware.
 *
 * Powers the `LanguageAnalyzeText` AI-enrichment pipeline activity + preview
 * route. Unset endpoint → honest CognitiveNotConfiguredError naming
 * LOOM_LANGUAGE_ENDPOINT (no-vaporware.md).
 *
 * Ref: https://learn.microsoft.com/azure/ai-services/language-service/text-analytics-for-health/quickstart
 *      https://learn.microsoft.com/rest/api/language/text-analysis/analyze-text
 */

import {
  cognitiveToken,
  resolveCognitiveEndpoint,
  readCognitiveJson,
  fetchWithTimeout,
  CognitiveError,
} from './cognitive-common';

const LANGUAGE_API = process.env.LOOM_LANGUAGE_API_VERSION || '2024-11-01';
const SERVICE = 'Azure AI Language';

/** The synchronous analyze-text task kinds the activity form exposes. */
export const LANGUAGE_TASKS = [
  'PiiEntityRecognition',
  'SentimentAnalysis',
  'EntityRecognition',
  'KeyPhraseExtraction',
] as const;
export type LanguageTaskKind = (typeof LANGUAGE_TASKS)[number];

export interface LanguageResult {
  kind: LanguageTaskKind;
  /** Redacted text (PII task) — free text with entities masked. */
  redactedText?: string;
  /** Detected entities (PII / EntityRecognition). */
  entities?: Array<{ text: string; category: string; confidence?: number }>;
  /** Overall sentiment + per-class scores (SentimentAnalysis). */
  sentiment?: { label: string; positive?: number; neutral?: number; negative?: number };
  /** Extracted key phrases (KeyPhraseExtraction). */
  keyPhrases?: string[];
  raw: unknown;
}

export interface AnalyzeTextInput {
  kind: LanguageTaskKind;
  text: string;
  /** BCP-47 language (default en). */
  language?: string;
}

function endpoint(): string {
  return resolveCognitiveEndpoint(
    'LOOM_LANGUAGE_ENDPOINT',
    SERVICE,
    'https://<name>.cognitiveservices.azure.com',
  );
}

/** Build the :analyze-text request body for a task kind + single document. */
export function buildAnalyzeTextBody(input: AnalyzeTextInput): Record<string, unknown> {
  const language = (input.language || 'en').trim();
  return {
    kind: input.kind,
    parameters: input.kind === 'SentimentAnalysis' ? { opinionMining: false } : {},
    analysisInput: {
      documents: [{ id: '1', language, text: input.text }],
    },
  };
}

function shape(kind: LanguageTaskKind, raw: any): LanguageResult {
  const doc = raw?.results?.documents?.[0];
  const out: LanguageResult = { kind, raw };
  if (!doc) return out;
  switch (kind) {
    case 'PiiEntityRecognition':
      out.redactedText = doc.redactedText;
      out.entities = (doc.entities || []).map((e: any) => ({
        text: e?.text, category: e?.category, confidence: e?.confidenceScore,
      }));
      break;
    case 'EntityRecognition':
      out.entities = (doc.entities || []).map((e: any) => ({
        text: e?.text, category: e?.category, confidence: e?.confidenceScore,
      }));
      break;
    case 'SentimentAnalysis':
      out.sentiment = {
        label: doc.sentiment,
        positive: doc.confidenceScores?.positive,
        neutral: doc.confidenceScores?.neutral,
        negative: doc.confidenceScores?.negative,
      };
      break;
    case 'KeyPhraseExtraction':
      out.keyPhrases = Array.isArray(doc.keyPhrases) ? doc.keyPhrases : [];
      break;
  }
  return out;
}

/** Run a synchronous analyze-text task against a single free-text document. */
export async function analyzeText(input: AnalyzeTextInput): Promise<LanguageResult> {
  if (!input.text || !input.text.trim()) {
    throw new CognitiveError(400, null, `${SERVICE}: provide non-empty text to analyze.`);
  }
  const ep = endpoint();
  const tok = await cognitiveToken();
  const url = `${ep}/language/:analyze-text?api-version=${LANGUAGE_API}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildAnalyzeTextBody(input)),
  });
  const raw = await readCognitiveJson<any>(res, SERVICE);
  return shape(input.kind, raw);
}

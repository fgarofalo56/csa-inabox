/**
 * Azure AI Translator (Text Translation v3.0) data-plane client.
 *
 * Real `/translator/text/v3.0/translate` REST — synchronous 200. Neural machine
 * translation of one or more text segments into one or more target languages,
 * with optional source-language hint (auto-detected when omitted). Entra-auth
 * (Console UAMI, `Cognitive Services User`), sovereign-cloud aware.
 *
 * A single-region Translator resource requires the region be sent on the
 * `Ocp-Apim-Subscription-Region` header alongside the AAD bearer token; set
 * LOOM_TRANSLATOR_REGION to the resource region (e.g. `eastus`).
 *
 * Powers the `TranslateText` AI-enrichment pipeline activity + preview route.
 * Unset endpoint → honest CognitiveNotConfiguredError naming
 * LOOM_TRANSLATOR_ENDPOINT (no-vaporware.md).
 *
 * Ref: https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate
 */

import {
  cognitiveToken,
  resolveCognitiveEndpoint,
  readCognitiveJson,
  fetchWithTimeout,
  CognitiveError,
} from './cognitive-common';

const SERVICE = 'Azure AI Translator';

export interface TranslatedSegment {
  /** The source text for this segment. */
  source: string;
  /** One translation per requested target language. */
  translations: Array<{ to: string; text: string }>;
  /** Auto-detected source language (present when `from` was omitted). */
  detectedLanguage?: { language: string; score?: number };
}

export interface TranslateResult {
  segments: TranslatedSegment[];
  raw: unknown;
}

export interface TranslateInput {
  /** One or more text segments to translate. */
  text: string | string[];
  /** Target BCP-47 language codes (e.g. ['fr', 'de']). */
  to: string[];
  /** Optional source language; auto-detected when omitted. */
  from?: string;
}

function endpoint(): string {
  return resolveCognitiveEndpoint(
    'LOOM_TRANSLATOR_ENDPOINT',
    SERVICE,
    'https://<name>.cognitiveservices.azure.com',
  );
}

/** Build the `?api-version=3.0&to=..&to=..[&from=..]` query string. */
export function buildTranslateQuery(to: string[], from?: string): string {
  const params = new URLSearchParams();
  params.set('api-version', '3.0');
  for (const t of to) if (t && t.trim()) params.append('to', t.trim());
  if (from && from.trim()) params.set('from', from.trim());
  return params.toString();
}

function shape(inputs: string[], raw: any): TranslateResult {
  const rows: any[] = Array.isArray(raw) ? raw : [];
  const segments: TranslatedSegment[] = rows.map((row, i) => ({
    source: inputs[i] ?? '',
    translations: (row?.translations || []).map((tr: any) => ({ to: tr?.to, text: tr?.text })),
    detectedLanguage: row?.detectedLanguage
      ? { language: row.detectedLanguage.language, score: row.detectedLanguage.score }
      : undefined,
  }));
  return { segments, raw };
}

/** Translate one or more segments into the requested target languages. */
export async function translate(input: TranslateInput): Promise<TranslateResult> {
  const inputs = Array.isArray(input.text) ? input.text : [input.text];
  if (inputs.length === 0 || inputs.every((t) => !t || !t.trim())) {
    throw new CognitiveError(400, null, `${SERVICE}: provide non-empty text to translate.`);
  }
  if (!input.to || input.to.filter((t) => t && t.trim()).length === 0) {
    throw new CognitiveError(400, null, `${SERVICE}: provide at least one target language ("to").`);
  }
  const ep = endpoint();
  const tok = await cognitiveToken();
  const url = `${ep}/translator/text/v3.0/translate?${buildTranslateQuery(input.to, input.from)}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok}`,
    'content-type': 'application/json',
  };
  const region = process.env.LOOM_TRANSLATOR_REGION;
  if (region && region.trim()) headers['Ocp-Apim-Subscription-Region'] = region.trim();

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(inputs.map((t) => ({ Text: t }))),
  });
  const raw = await readCognitiveJson<any>(res, SERVICE);
  return shape(inputs, raw);
}

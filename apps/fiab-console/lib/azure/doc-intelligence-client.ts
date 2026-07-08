/**
 * Azure AI Document Intelligence (FormRecognizer) data-plane client.
 *
 * Real `documentModels/{modelId}:analyze` REST — submit a document (public URL
 * or base64 bytes), poll the async operation, and return the normalised layout
 * / prebuilt-model result. Entra-auth only (Console UAMI, `Cognitive Services
 * User`), sovereign-cloud aware via cognitive-common → cogScope().
 *
 * Powers the `DocumentIntelligenceAnalyze` AI-enrichment pipeline activity and
 * its "test on a sample" preview route. No mock — an unset endpoint throws
 * CognitiveNotConfiguredError so the UI shows an honest infra gate naming
 * LOOM_DOCINTEL_ENDPOINT (per no-vaporware.md).
 *
 * Ref: https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/layout
 */

import {
  cognitiveToken,
  resolveCognitiveEndpoint,
  readCognitiveJson,
  fetchWithTimeout,
  CognitiveError,
} from './cognitive-common';

const DOCINTEL_API = process.env.LOOM_DOCINTEL_API_VERSION || '2024-11-30';
const SERVICE = 'Document Intelligence';

/** The prebuilt models the activity form exposes as a typed dropdown. */
export const DOCINTEL_MODELS = [
  'prebuilt-layout',
  'prebuilt-read',
  'prebuilt-document',
  'prebuilt-invoice',
  'prebuilt-receipt',
  'prebuilt-idDocument',
  'prebuilt-businessCard',
  'prebuilt-tax.us.w2',
] as const;
export type DocIntelModel = (typeof DOCINTEL_MODELS)[number] | string;

export interface DocIntelKeyValue { key: string; value: string; confidence?: number }

export interface DocIntelResult {
  modelId: string;
  apiVersion: string;
  /** Full recognised text content of the document. */
  content: string;
  pageCount: number;
  tableCount: number;
  /** Prebuilt key/value pairs (layout + prebuilt-document). */
  keyValuePairs: DocIntelKeyValue[];
  /** Named fields extracted by a prebuilt model (invoice/receipt/…). */
  fields: Record<string, unknown>;
  /** The raw analyzeResult for callers that need the full payload. */
  raw: unknown;
}

export interface AnalyzeDocumentInput {
  /** Prebuilt / custom model id. Defaults to prebuilt-layout. */
  modelId?: DocIntelModel;
  /** A public (or SAS) URL to the source document. */
  urlSource?: string;
  /** Base64-encoded document bytes (alternative to urlSource). */
  base64Source?: string;
}

function endpoint(): string {
  return resolveCognitiveEndpoint(
    'LOOM_DOCINTEL_ENDPOINT',
    SERVICE,
    'https://<name>.cognitiveservices.azure.com',
  );
}

function shape(modelId: string, analyzeResult: any): DocIntelResult {
  const pages: any[] = Array.isArray(analyzeResult?.pages) ? analyzeResult.pages : [];
  const tables: any[] = Array.isArray(analyzeResult?.tables) ? analyzeResult.tables : [];
  const kvs: any[] = Array.isArray(analyzeResult?.keyValuePairs) ? analyzeResult.keyValuePairs : [];
  const docs: any[] = Array.isArray(analyzeResult?.documents) ? analyzeResult.documents : [];
  return {
    modelId,
    apiVersion: analyzeResult?.apiVersion || DOCINTEL_API,
    content: typeof analyzeResult?.content === 'string' ? analyzeResult.content : '',
    pageCount: pages.length,
    tableCount: tables.length,
    keyValuePairs: kvs.map((kv) => ({
      key: kv?.key?.content ?? '',
      value: kv?.value?.content ?? '',
      confidence: typeof kv?.confidence === 'number' ? kv.confidence : undefined,
    })),
    fields: docs[0]?.fields || {},
    raw: analyzeResult,
  };
}

/**
 * Analyze a document end-to-end: POST begin-analyze (async 202 +
 * operation-location), then poll GET until the operation succeeds/fails.
 */
export async function analyzeDocument(input: AnalyzeDocumentInput): Promise<DocIntelResult> {
  const modelId = (input.modelId || 'prebuilt-layout').trim();
  if (!input.urlSource && !input.base64Source) {
    throw new CognitiveError(400, null, `${SERVICE}: provide urlSource or base64Source.`);
  }
  const ep = endpoint();
  const tok = await cognitiveToken();
  const url = `${ep}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze?api-version=${DOCINTEL_API}`;
  const body = input.urlSource ? { urlSource: input.urlSource } : { base64Source: input.base64Source };
  const submit = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (submit.status !== 202 && !submit.ok) {
    await readCognitiveJson(submit, SERVICE); // throws CognitiveError with detail
  }
  const opLocation = submit.headers.get('operation-location');
  if (!opLocation) {
    // Some deployments return a synchronous result (rare) — try to read it.
    const sync = await readCognitiveJson<any>(submit, SERVICE);
    if (sync?.analyzeResult) return shape(modelId, sync.analyzeResult);
    throw new CognitiveError(502, null, `${SERVICE}: no operation-location header on the analyze response.`);
  }
  // Poll the async operation (bounded: ~90s at 2s intervals).
  const MAX_POLLS = 45;
  for (let i = 0; i < MAX_POLLS; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollTok = i === 0 ? tok : await cognitiveToken();
    const poll = await fetchWithTimeout(opLocation, {
      headers: { authorization: `Bearer ${pollTok}` },
    });
    const j = await readCognitiveJson<any>(poll, SERVICE);
    const status = String(j?.status || '').toLowerCase();
    if (status === 'succeeded') return shape(modelId, j?.analyzeResult ?? {});
    if (status === 'failed') {
      throw new CognitiveError(502, j, `${SERVICE}: analyze operation failed — ${j?.error?.message || 'unknown error'}.`);
    }
  }
  throw new CognitiveError(504, null, `${SERVICE}: analyze operation did not complete within the polling window.`);
}

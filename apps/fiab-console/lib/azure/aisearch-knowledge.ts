/**
 * aisearch-knowledge — Azure AI Search AGENTIC-RETRIEVAL data-plane client
 * (Knowledge Sources + Knowledge Bases / "Foundry IQ").
 *
 * This is the backend behind Loom's "Knowledge Bases" navigator group + the
 * retrieve-test pane. It targets the AI Search data-plane REST agentic-retrieval
 * surface on the SAME service the rest of Loom's AI Search editor uses:
 *
 *   - Knowledge sources:  GET/PUT/DELETE /knowledgesources[/{name}]
 *   - Knowledge bases:    GET/PUT/DELETE /knowledgebases[/{name}]
 *   - Retrieve:           POST /knowledgebases/{name}/retrieve
 *
 * Default API version is the GA `2026-04-01` (Commercial + GCC). The
 * `2026-05-01-preview` adds `messages` conversational input + answer synthesis;
 * we opt into it ONLY when the caller asks for synthesis, so the default path
 * stays on a GA contract per no-vaporware.md.
 *
 * This module is deliberately a NEW sibling of `search-index-client.ts` (it does
 * not restructure that file): it reuses that client's exported service-name
 * resolution + honest-gate + error types, and re-implements only the tiny
 * authenticated-call helper it needs. Same ChainedTokenCredential
 * (ACA-MSI → UAMI → DefaultAzureCredential) and same AAD scope
 * (https://search.azure.com/.default). No mocks, no Fabric, no Power BI —
 * pure AI Search REST (per no-fabric-dependency.md).
 *
 * Grounded in Microsoft Learn (Search Service REST, api-version 2026-04-01 GA /
 * 2026-05-01-preview):
 *   https://learn.microsoft.com/azure/search/agentic-retrieval-overview
 *   https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-search-index
 *   https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-create-knowledge-base
 *   https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-retrieve
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  searchServiceEndpoint,
  SearchDataError,
} from './search-index-client';
import { detectLoomCloud, type LoomCloud } from './cloud-endpoints';

/** GA agentic-retrieval REST version (knowledge sources + bases + extractive retrieve). */
export const KB_GA_API = '2026-04-01';
/** Preview version — adds `messages` conversational input + answer synthesis. */
export const KB_PREVIEW_API = '2026-05-01-preview';
const SEARCH_SCOPE = 'https://search.azure.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// Re-export the shared honest-gate types so the KB BFF routes share the exact
// `{ ok:false, code:'not_configured', missing }` 503 shape as every other
// AI Search route.
export { SearchDataError, SearchNotDeployedError } from './search-index-client';
export { isSearchConfigured, searchConfigGate } from './search-index-client';

// ----------------------------------------------------------------------------
// Sovereign-cloud honest gate
// ----------------------------------------------------------------------------

/**
 * Agentic retrieval (knowledge sources / bases) GA'd in the `2026-04-01` REST
 * API for Commercial + GCC (both run on Commercial Azure endpoints). It is NOT
 * yet confirmed GA in the GCC-High / DoD sovereign boundaries, and Web
 * knowledge sources are explicitly unsupported in sovereign clouds. Rather than
 * call an API version that may not exist in-boundary, we honest-gate those two
 * clouds with a precise MessageBar (no vaporware). Returns `null` when the
 * active cloud supports the feature.
 */
export function knowledgeGovGate(): { cloud: LoomCloud; reason: string } | null {
  const cloud = detectLoomCloud();
  if (cloud === 'GCC-High' || cloud === 'DoD') {
    return {
      cloud,
      reason:
        `Agentic retrieval (Knowledge Sources & Knowledge Bases) is generally available in the ` +
        `${KB_GA_API} Azure AI Search REST API for Commercial and GCC. It is not yet confirmed GA in ` +
        `${cloud}. Verify the ${KB_GA_API} api-version is available in your sovereign region before enabling; ` +
        `until then, use the classic Indexes / Indexers / Skillsets surfaces for RAG in this cloud.`,
    };
  }
  return null;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken(SEARCH_SCOPE);
  if (!t?.token) throw new SearchDataError(401, undefined, 'Failed to acquire AAD token for AI Search');
  return t.token;
}

/**
 * Parse a Response body as JSON, guarding on content-type (mirrors the
 * search-index-client helper). A non-JSON error page never throws an opaque
 * "Unexpected token <"; a bad status becomes a SearchDataError carrying the
 * real body. A 206 Partial Content is treated as a (partial) success by
 * callers — we surface it here as a normal JSON parse.
 */
async function readJsonGuarded(res: Response, ctx: string): Promise<any> {
  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json') || ct.includes('+json');
  if (res.ok || res.status === 206) {
    if (res.status === 204) return null;
    const t = await res.text();
    if (!t.trim()) return null;
    if (!isJson) return { _raw: t };
    return JSON.parse(t);
  }
  const t = await res.text();
  let body: unknown = t;
  if (isJson && t.trim()) { try { body = JSON.parse(t); } catch { /* keep text */ } }
  const detail = (body as any)?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
  throw new SearchDataError(res.status, body, `${ctx} failed (${res.status}): ${String(detail).slice(0, 240)}`);
}

interface CallOpts {
  service?: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  apiVersion?: string;
}

/** Issue an authenticated data-plane call to `path` (must start with `/`). */
async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const base = searchServiceEndpoint(opts.service); // throws SearchNotDeployedError when unset
  const tok = await searchToken();
  const params = new URLSearchParams({ 'api-version': opts.apiVersion || KB_GA_API, ...(opts.query || {}) });
  const url = `${base}${path}?${params.toString()}`;
  return fetchWithTimeout(url, {
    method: opts.method || 'GET',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

// ----------------------------------------------------------------------------
// Knowledge sources
// ----------------------------------------------------------------------------

/** A field reference — a bare `{ name }` per the REST contract. */
export interface FieldRef { name: string }

export interface KnowledgeSourceSummary {
  name: string;
  kind: string; // 'searchIndex' (the only kind Loom creates today)
  searchIndexName?: string;
  description?: string;
}

/** Input for {@link createKnowledgeSource} — wraps an EXISTING index. */
export interface CreateKnowledgeSourceInput {
  name: string;
  searchIndexName: string;
  /** Optional: the index's semantic config. Required by GA when the index has one. */
  semanticConfigurationName?: string;
  /** Fields whose values are returned as grounding (defaults to the semantic config's). */
  sourceDataFields?: string[];
  /** Fields to search over (defaults to the semantic config's). */
  searchFields?: string[];
  description?: string;
}

function summarizeKnowledgeSource(raw: any): KnowledgeSourceSummary {
  return {
    name: raw?.name,
    kind: raw?.kind || 'searchIndex',
    searchIndexName: raw?.searchIndexParameters?.searchIndexName,
    description: raw?.description || undefined,
  };
}

/** GET /knowledgesources — list every knowledge source (name + kind). */
export async function listKnowledgeSources(service?: string): Promise<KnowledgeSourceSummary[]> {
  const res = await call('/knowledgesources', { service, query: { $select: 'name,kind,searchIndexParameters,description' } });
  const j = await readJsonGuarded(res, 'list knowledge sources');
  return (j?.value || []).map(summarizeKnowledgeSource);
}

/** GET /knowledgesources/{name} — full definition. 404 → null. */
export async function getKnowledgeSource(name: string, service?: string): Promise<any | null> {
  const res = await call(`/knowledgesources/${encodeURIComponent(name)}`, { service });
  if (res.status === 404) return null;
  return readJsonGuarded(res, `get knowledge source ${name}`);
}

/**
 * PUT /knowledgesources/{name} — create-or-update a `searchIndex` knowledge
 * source that wraps an existing index. Real REST; no orphan objects created
 * (an existing index is referenced, not regenerated).
 */
export async function createKnowledgeSource(input: CreateKnowledgeSourceInput, service?: string): Promise<any> {
  if (!input?.name) throw new SearchDataError(400, input, 'create knowledge source requires name');
  if (!input?.searchIndexName) throw new SearchDataError(400, input, 'create knowledge source requires searchIndexName');
  const searchIndexParameters: any = { searchIndexName: input.searchIndexName };
  if (input.semanticConfigurationName) searchIndexParameters.semanticConfigurationName = input.semanticConfigurationName;
  if (input.sourceDataFields && input.sourceDataFields.length) {
    searchIndexParameters.sourceDataFields = input.sourceDataFields.map((n): FieldRef => ({ name: n }));
  }
  if (input.searchFields && input.searchFields.length) {
    searchIndexParameters.searchFields = input.searchFields.map((n): FieldRef => ({ name: n }));
  }
  const body = {
    name: input.name,
    kind: 'searchIndex',
    ...(input.description ? { description: input.description } : {}),
    searchIndexParameters,
  };
  const res = await call(`/knowledgesources/${encodeURIComponent(input.name)}`, { service, method: 'PUT', body });
  return readJsonGuarded(res, `create knowledge source ${input.name}`);
}

/**
 * DELETE /knowledgesources/{name}. The service rejects a delete while a
 * knowledge base still references the source (409) — the error body lists the
 * blocking bases, which we surface verbatim via SearchDataError.
 */
export async function deleteKnowledgeSource(name: string, service?: string): Promise<void> {
  const res = await call(`/knowledgesources/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete knowledge source ${name}`);
}

// ----------------------------------------------------------------------------
// Knowledge bases
// ----------------------------------------------------------------------------

/** A model reference for query-planning / answer-synthesis (optional; extractive by default). */
export interface KnowledgeBaseModel {
  kind: 'azureOpenAI';
  azureOpenAIParameters: {
    resourceUri: string;
    deploymentId: string;
    modelName: string;
  };
}

export interface KnowledgeBaseSummary {
  name: string;
  knowledgeSources: string[];
  outputMode?: string;
  reasoningEffort?: string;
  description?: string;
}

/** Input for {@link createKnowledgeBase} — composes one or more knowledge sources. */
export interface CreateKnowledgeBaseInput {
  name: string;
  /** Names of already-created knowledge sources to compose. */
  knowledgeSources: string[];
  description?: string;
  /**
   * Retrieval reasoning effort — 'minimal' | 'low' | 'medium' (GA). Higher
   * spends more model reasoning on query planning. Omit for the service default.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium';
  /**
   * 'extractiveData' (default, GA — returns grounding chunks) or
   * 'answerSynthesis' (preview — one LLM-formulated answer; requires a model).
   */
  outputMode?: 'extractiveData' | 'answerSynthesis';
  /** Optional LLM for query planning / answer synthesis. Omit for pure extractive. */
  models?: KnowledgeBaseModel[];
  retrievalInstructions?: string;
  answerInstructions?: string;
}

function summarizeKnowledgeBase(raw: any): KnowledgeBaseSummary {
  return {
    name: raw?.name,
    knowledgeSources: (raw?.knowledgeSources || []).map((k: any) => (typeof k === 'string' ? k : k?.name)).filter(Boolean),
    outputMode: raw?.outputMode?.kind || raw?.outputMode || undefined,
    reasoningEffort: raw?.retrievalReasoningEffort?.kind || undefined,
    description: raw?.description || undefined,
  };
}

/** GET /knowledgebases — list every knowledge base. */
export async function listKnowledgeBases(service?: string): Promise<KnowledgeBaseSummary[]> {
  const res = await call('/knowledgebases', { service, query: { $select: 'name,knowledgeSources,outputMode,retrievalReasoningEffort,description' } });
  const j = await readJsonGuarded(res, 'list knowledge bases');
  return (j?.value || []).map(summarizeKnowledgeBase);
}

/** GET /knowledgebases/{name} — full definition. 404 → null. */
export async function getKnowledgeBase(name: string, service?: string): Promise<any | null> {
  const res = await call(`/knowledgebases/${encodeURIComponent(name)}`, { service });
  if (res.status === 404) return null;
  return readJsonGuarded(res, `get knowledge base ${name}`);
}

/**
 * PUT /knowledgebases/{name} — create-or-update a knowledge base composing the
 * given knowledge sources. Defaults to GA extractive retrieval (no model
 * dependency). `answerSynthesis` requires a model reference; we validate that
 * pairing so a synthesis base is never created without an LLM (no vaporware).
 */
export async function createKnowledgeBase(input: CreateKnowledgeBaseInput, service?: string): Promise<any> {
  if (!input?.name) throw new SearchDataError(400, input, 'create knowledge base requires name');
  if (!Array.isArray(input?.knowledgeSources) || input.knowledgeSources.length === 0) {
    throw new SearchDataError(400, input, 'a knowledge base must reference at least one knowledge source');
  }
  const outputMode = input.outputMode || 'extractiveData';
  const models = input.models && input.models.length ? input.models : [];
  if (outputMode === 'answerSynthesis' && models.length === 0) {
    throw new SearchDataError(400, input, 'answerSynthesis output mode requires a model reference (models[]); omit it for extractive retrieval');
  }
  const body: any = {
    name: input.name,
    knowledgeSources: input.knowledgeSources.map((n) => ({ name: n })),
    models,
    outputMode: { kind: outputMode },
    ...(input.reasoningEffort ? { retrievalReasoningEffort: { kind: input.reasoningEffort } } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.retrievalInstructions ? { retrievalInstructions: input.retrievalInstructions } : {}),
    ...(input.answerInstructions ? { answerInstructions: input.answerInstructions } : {}),
  };
  // Answer synthesis is a preview-only capability; select the preview api-version
  // automatically so the create call targets a version that understands it.
  const apiVersion = outputMode === 'answerSynthesis' ? KB_PREVIEW_API : KB_GA_API;
  const res = await call(`/knowledgebases/${encodeURIComponent(input.name)}`, { service, method: 'PUT', body, apiVersion });
  return readJsonGuarded(res, `create knowledge base ${input.name}`);
}

/** DELETE /knowledgebases/{name}. */
export async function deleteKnowledgeBase(name: string, service?: string): Promise<void> {
  const res = await call(`/knowledgebases/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete knowledge base ${name}`);
}

// ----------------------------------------------------------------------------
// Retrieve (agentic retrieval)
// ----------------------------------------------------------------------------

export interface RetrieveTurn { role: 'user' | 'assistant'; text: string }

export interface RetrieveInput {
  /** The current user question. */
  query: string;
  /** Prior conversation turns (used only on the preview `messages` path). */
  history?: RetrieveTurn[];
  /** Restrict the query to a subset of the base's sources (defaults to all). */
  knowledgeSourceNames?: string[];
  /**
   * When true, request a single LLM-synthesized natural-language answer via the
   * preview `messages` API. Requires the base to be configured for synthesis
   * (a model + answerSynthesis output mode). Defaults to false → GA extractive
   * grounding via the `intents` API.
   */
  synthesize?: boolean;
}

/** One decomposed subquery the engine ran (from the response `activity` array). */
export interface RetrieveSubquery {
  source?: string;
  search?: string;
  count?: number;
  elapsedMs?: number;
  queryTime?: string;
}

/** One grounding citation (from the response `references` array). */
export interface RetrieveCitation {
  id?: string;
  docKey?: string;
  source?: string;
  activitySource?: number;
  title?: string;
  content?: string;
}

export interface RetrieveResult {
  /**
   * The answer text. On the GA extractive path this is a JSON-encoded string of
   * the top grounding chunks (`answerIsExtractive: true`); on the synthesis path
   * it is a natural-language answer.
   */
  answer: string;
  answerIsExtractive: boolean;
  subqueries: RetrieveSubquery[];
  citations: RetrieveCitation[];
  /** True when the service returned 206 Partial Content (some sources failed). */
  partial: boolean;
  /** The api-version used (for the UI to badge GA vs preview honestly). */
  apiVersion: string;
  /** The raw response for the deep-dive / debug view. */
  raw: any;
}

function extractAnswerText(raw: any): string {
  const resp = raw?.response;
  if (Array.isArray(resp)) {
    const parts: string[] = [];
    for (const msg of resp) {
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const c of content) if (typeof c?.text === 'string') parts.push(c.text);
      } else if (typeof content === 'string') {
        parts.push(content);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  if (typeof raw?.answer === 'string') return raw.answer;
  return '';
}

function parseSubqueries(raw: any): RetrieveSubquery[] {
  const activity = Array.isArray(raw?.activity) ? raw.activity : [];
  return activity
    .filter((a: any) => a?.searchIndexArguments || a?.type === 'searchIndex')
    .map((a: any) => ({
      source: a?.knowledgeSourceName,
      search: a?.searchIndexArguments?.search,
      count: a?.count,
      elapsedMs: a?.elapsedMs,
      queryTime: a?.queryTime,
    }));
}

function parseCitations(raw: any): RetrieveCitation[] {
  const refs = Array.isArray(raw?.references) ? raw.references : [];
  return refs.map((r: any) => ({
    id: r?.id,
    docKey: r?.docKey,
    source: r?.knowledgeSourceName || r?.type,
    activitySource: r?.activitySource,
    title: r?.sourceData?.title,
    content: typeof r?.sourceData?.content === 'string' ? r.sourceData.content.slice(0, 600) : undefined,
  }));
}

/**
 * POST /knowledgebases/{name}/retrieve — run agentic retrieval. Decomposes the
 * question into subqueries, queries each knowledge source, semantic-reranks, and
 * returns grounding (GA) or a synthesized answer (preview). Normalizes the
 * response into `{ answer, subqueries, citations, partial }`. A 206 Partial
 * Content is a success with `partial: true`.
 */
export async function retrieveKnowledge(name: string, input: RetrieveInput, service?: string): Promise<RetrieveResult> {
  if (!name) throw new SearchDataError(400, input, 'retrieve requires a knowledge base name');
  const query = (input?.query || '').trim();
  if (!query) throw new SearchDataError(400, input, 'retrieve requires a non-empty query');

  const sourceParams = (input.knowledgeSourceNames || []).map((n) => ({ knowledgeSourceName: n, kind: 'searchIndex' }));

  let body: any;
  let apiVersion: string;
  if (input.synthesize) {
    // Preview conversational path — full message history + current question.
    apiVersion = KB_PREVIEW_API;
    const messages = [
      ...(input.history || []).map((t) => ({ role: t.role, content: [{ type: 'text', text: t.text }] })),
      { role: 'user', content: [{ type: 'text', text: query }] },
    ];
    body = { messages, ...(sourceParams.length ? { knowledgeSourceParams: sourceParams } : {}) };
  } else {
    // GA extractive path — a single semantic intent.
    apiVersion = KB_GA_API;
    body = {
      intents: [{ type: 'semantic', search: query }],
      ...(sourceParams.length ? { knowledgeSourceParams: sourceParams } : {}),
    };
  }

  const res = await call(`/knowledgebases/${encodeURIComponent(name)}/retrieve`, { service, method: 'POST', body, apiVersion });
  const raw = await readJsonGuarded(res, `retrieve from ${name}`);
  return {
    answer: extractAnswerText(raw),
    answerIsExtractive: !input.synthesize,
    subqueries: parseSubqueries(raw),
    citations: parseCitations(raw),
    partial: res.status === 206,
    apiVersion,
    raw,
  };
}

/** Resolve the configured service name (throws SearchNotDeployedError when unset). */
export { resolveServiceName } from './search-index-client';

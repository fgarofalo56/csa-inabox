/**
 * knowledge-tools — agentic-retrieval Copilot tools (Foundry IQ) and the
 * Cosmos DB vector fallback.
 *
 * Registers `knowledge_base_retrieve` (+ a small `knowledge_base_list` helper)
 * into the cross-item Copilot tool registry so Loom's OWN Copilot grounds RAG
 * answers on agentic retrieval — query decomposition + semantic rerank across
 * one or more knowledge sources — instead of a flat single-shot vector search.
 *
 * ── TWO first-class RAG backends, selected automatically (#3351) ────────────
 * Azure AI Search agentic retrieval is the PREFERRED backend: it decomposes the
 * question and semantically reranks. But it is not deployed in every estate and
 * its agentic-retrieval api-version is not confirmed GA in every sovereign
 * boundary, and `cloud-parity.md` makes "Commercial-only" incomplete rather
 * than acceptable. So Cosmos DB for MongoDB (vCore) vector search is registered
 * as a SECOND first-class backend (`vector_store_retrieve`), and the AI Search
 * preflight ROUTES to it automatically when AI Search cannot answer.
 *
 * Both are registered by default and neither is a user-visible configuration
 * choice (`loom_default_on_opt_out`): the model picks the tool, and when the
 * preferred backend is unavailable the honest message names the one that IS.
 *
 * Every tool hits a REAL backend (per no-vaporware.md) — the AI Search
 * agentic-retrieval REST API via `aisearch-knowledge.ts`, or a genuine
 * `cosmosSearch` kNN aggregation via `cosmos-vcore-vector-client.ts`. When
 * neither is configured the tool returns an honest message string (never a fake
 * answer). No Fabric / Power BI dependency — both backends are Azure-native.
 */

import type { LoomToolRegistry } from '../azure/copilot-orchestrator';
import {
  listKnowledgeBases,
  retrieveKnowledge,
  knowledgeGovGate,
  isSearchConfigured,
} from '../azure/aisearch-knowledge';
import { cosmosVcoreGate } from '../azure/cosmos-vcore-vector-client';

const S_STRING = { type: 'string' } as const;
const S_NUMBER = { type: 'number' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/** True when the Cosmos vector backend is wired and can answer instead. */
function vectorFallbackAvailable(): boolean {
  return cosmosVcoreGate() === null;
}

/**
 * The sentence appended to an AI-Search-unavailable message so the model is
 * ROUTED to the working backend rather than told retrieval is impossible
 * (#3351: backend selection is automatic, not a user-visible choice).
 */
function fallbackHint(): string {
  return vectorFallbackAvailable()
    ? ' Cosmos DB vector search IS configured in this deployment — call vector_store_retrieve instead to ground this answer.'
    : ' The Cosmos DB vector backend (LOOM_COSMOS_VCORE_CONNECTION_STRING) is not configured either, so no retrieval backend can ground this answer — say so honestly rather than guessing.';
}

/**
 * Honest pre-flight shared by both AI Search tools: returns a message string
 * when agentic retrieval can't run in this deployment/cloud, or null when it
 * can. The message always names the missing AI Search setting AND, per #3351,
 * points at the Cosmos vector backend when that one can answer.
 */
function knowledgePreflight(): string | null {
  if (!isSearchConfigured()) {
    return 'Azure AI Search is not configured in this deployment (set LOOM_AI_SEARCH_SERVICE). Agentic retrieval is unavailable.'
      + fallbackHint();
  }
  const gov = knowledgeGovGate();
  if (gov) return gov.reason + fallbackHint();
  return null;
}

export function registerKnowledgeTools(r: LoomToolRegistry): void {
  r.register({
    name: 'knowledge_base_list',
    service: 'AI Search (Foundry IQ)',
    description:
      'List the Azure AI Search knowledge bases available for agentic retrieval, with the knowledge sources each composes. Call this first to discover a knowledge base name to pass to knowledge_base_retrieve.',
    whenToUse: 'Discover which knowledge bases exist before grounding an answer with agentic retrieval.',
    parameters: obj({}),
    handler: async () => {
      const pre = knowledgePreflight();
      if (pre) return { available: false, message: pre };
      const bases = await listKnowledgeBases();
      return {
        available: true,
        knowledgeBases: bases.map((b) => ({
          name: b.name,
          knowledgeSources: b.knowledgeSources,
          outputMode: b.outputMode,
        })),
      };
    },
  });

  r.register({
    name: 'knowledge_base_retrieve',
    service: 'AI Search (Foundry IQ)',
    description:
      'Run AGENTIC RETRIEVAL against an Azure AI Search knowledge base: decomposes the question into subqueries, queries each knowledge source, semantic-reranks, and returns grounding data (the top chunks) plus the subqueries and citations. Use this to ground answers on Loom\'s own indexed estate instead of a flat vector search. Prefer this over a single-shot search when the question is multi-part.',
    whenToUse: 'Ground a RAG answer on indexed content via query decomposition + semantic rerank (agentic retrieval).',
    parameters: obj(
      { knowledgeBase: S_STRING, query: S_STRING },
      ['knowledgeBase', 'query'],
    ),
    handler: async ({ knowledgeBase, query }) => {
      const pre = knowledgePreflight();
      if (pre) return { grounded: false, message: pre };
      const kb = String(knowledgeBase || '').trim();
      const q = String(query || '').trim();
      if (!kb || !q) return { grounded: false, message: 'knowledgeBase and query are both required.' };
      const result = await retrieveKnowledge(kb, { query: q });
      return {
        grounded: true,
        knowledgeBase: kb,
        partial: result.partial,
        // The extractive grounding string an LLM consumes to formulate its answer.
        grounding: result.answer,
        subqueries: result.subqueries,
        citations: result.citations.map((c) => ({ id: c.id, docKey: c.docKey, source: c.source })),
      };
    },
  });

  // ── Second first-class RAG backend: Cosmos DB vector search (#3351) ───────
  //
  // Registered UNCONDITIONALLY so the model can always reach it and the honest
  // gate is the tool's own answer, not a missing tool. That matters for the
  // sovereign boundaries, where AI Search agentic retrieval is the piece whose
  // GA status varies: `cloud-parity.md` treats a Commercial-only capability as
  // incomplete, and a Cosmos vCore cluster is available in every boundary Loom
  // supports.
  //
  // The heavy modules are imported INSIDE the handler on purpose: the vCore
  // client resolves the `mongodb` driver through a webpack-ignored dynamic
  // import, and the AOAI client is only needed on the embedding path. Keeping
  // both out of module scope means registering this tool costs nothing in an
  // estate that never calls it.
  r.register({
    name: 'vector_store_retrieve',
    service: 'Cosmos DB for MongoDB (vCore) vector search',
    description:
      'Run a REAL k-nearest-neighbour vector search over a Loom vector-store collection in Cosmos DB for MongoDB (vCore). The query text is embedded with the Azure OpenAI embeddings deployment and matched against the collection\'s cosmosSearch vector index. Use this to ground an answer when knowledge_base_retrieve is unavailable (no Azure AI Search in this deployment or boundary), or when the content you need lives in a Loom vector store rather than an AI Search knowledge base.',
    whenToUse: 'Ground a RAG answer on a Cosmos DB vector store — the fallback/second retrieval backend when AI Search agentic retrieval is not available.',
    parameters: obj(
      { collection: S_STRING, query: S_STRING, k: S_NUMBER },
      ['collection', 'query'],
    ),
    handler: async ({ collection, query, k }) => {
      const gate = cosmosVcoreGate();
      if (gate) {
        return {
          grounded: false,
          message:
            `Cosmos DB vector search is not configured in this deployment (set ${gate.missing}). ${gate.hint}`,
        };
      }
      const coll = String(collection || '').trim();
      const q = String(query || '').trim();
      if (!coll || !q) {
        return { grounded: false, message: 'collection and query are both required.' };
      }
      const topK = Number.isFinite(Number(k)) && Number(k) > 0 ? Math.min(Math.floor(Number(k)), 50) : 5;

      // Embed the question. Without an embeddings deployment there is no query
      // vector and therefore no search — say that, never invent a result.
      let vector: number[] | null = null;
      try {
        const { aoaiEmbed } = await import('../azure/aoai-chat-client');
        const emb = await aoaiEmbed({ input: q });
        vector = emb.vectors?.[0] || null;
      } catch (e: any) {
        return {
          grounded: false,
          message:
            'Could not embed the query, so no vector search was run: '
            + `${e?.message || String(e)}. Deploy a text-embedding model and set LOOM_AOAI_EMBED_DEPLOYMENT.`,
        };
      }
      if (!vector || vector.length === 0) {
        return {
          grounded: false,
          message:
            'The embeddings deployment returned no vector for this query, so no search was run. '
            + 'This is an embedding failure, not an empty knowledge store.',
        };
      }

      try {
        const { vcoreVectorSearch } = await import('../azure/cosmos-vcore-vector-client');
        const res = await vcoreVectorSearch({ collection: coll, vector, k: topK });
        const rows = res.value || [];
        return {
          grounded: true,
          backend: 'cosmos-vcore',
          collection: coll,
          matches: rows.length,
          // The rows themselves are the grounding data; the model reads their
          // scalar fields. No summarisation here — that is the model's job.
          results: rows,
        };
      } catch (e: any) {
        // R7 — report the failure as a failure. An empty result set and an
        // unreachable cluster are different facts and must not read the same.
        return {
          grounded: false,
          message:
            `The Cosmos DB vector search failed against collection "${coll}": `
            + `${e?.message || String(e)}. This is a backend failure, not an empty result.`,
        };
      }
    },
  });
}

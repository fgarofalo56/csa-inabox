/**
 * knowledge-tools — agentic-retrieval Copilot tools (Foundry IQ) and the
 * Cosmos DB vector fallback.
 *
 * Registers `knowledge_base_retrieve` (+ a small `knowledge_base_list` helper)
 * into the cross-item Copilot tool registry so Loom's OWN Copilot grounds RAG
 * answers on agentic retrieval — query decomposition + semantic rerank across
 * one or more knowledge sources — instead of a flat single-shot vector search.
 *
 * ── A SECOND RAG backend, selected automatically (#3351) ────────────────────
 * Azure AI Search agentic retrieval is the PREFERRED backend: it decomposes the
 * question and semantically reranks. But it is not deployed in every estate and
 * its agentic-retrieval api-version is not confirmed GA in every sovereign
 * boundary, and `cloud-parity.md` makes "Commercial-only" incomplete rather
 * than acceptable. So Cosmos DB for MongoDB (vCore) vector search is registered
 * as a second backend (`vector_store_retrieve`), and the AI Search preflight
 * ROUTES to it automatically when AI Search cannot answer.
 *
 * WHAT THIS DOES NOT YET CLOSE (R7 + cloud-parity, measured 2026-09-08). The
 * vCore backend reaches the official `mongodb` npm driver through
 * cosmos-vcore-vector-client.ts's `loadMongo()`, and that driver is NOT a
 * dependency of this app: `apps/fiab-console/package.json` does not list it,
 * `next.config.mjs` does not carry it in `serverExternalPackages`, and it is
 * absent from node_modules. So in the image that ships today
 * `vector_store_retrieve` can only return CosmosVcoreDriverError's honest
 * dependency gate — it cannot ground an answer in ANY boundary. The parity gap
 * AI Search leaves in the sovereign clouds is therefore NOT closed here, and
 * nothing in this file may say otherwise. Adding the driver (package.json +
 * serverExternalPackages + redeploy) is tracked separately; until then the
 * routing hint below states only what it can establish.
 *
 * Both tools are registered by default and neither is a user-visible
 * configuration choice (`loom_default_on_opt_out`): the model picks the tool,
 * and each tool's own answer is the honest gate.
 *
 * No tool here fabricates an answer (per no-vaporware.md): each either calls a
 * REAL backend — the AI Search agentic-retrieval REST API via
 * `aisearch-knowledge.ts`, or a genuine `cosmosSearch` kNN aggregation via
 * `cosmos-vcore-vector-client.ts` — or returns an honest message string naming
 * what is missing. Per the note above, the vCore path reaches its real
 * aggregation only in an image that carries the `mongodb` driver; in this one it
 * returns the dependency gate. No Fabric / Power BI dependency — both backends
 * are Azure-native.
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

/**
 * Does the `mongodb` driver actually RESOLVE in this image?
 *
 * This evaluates the SAME expression `loadMongo()` evaluates in
 * cosmos-vcore-vector-client.ts (`import('mongo' + 'db')`, runtime-computed and
 * webpack-ignored so `next build` never hard-resolves it). Keep the two
 * spellings identical: if they diverge, this probe stops describing the code
 * path it exists to predict.
 *
 * Only a SUCCESS is memoised. A failure is deliberately NOT cached — module
 * resolution is cheap, it is reached only on an already-degraded path, and a
 * permanently-remembered "no" is the failure shape this repo keeps re-learning.
 */
let _mongoDriverResolves = false;
async function vcoreDriverResolves(): Promise<boolean> {
  if (_mongoDriverResolves) return true;
  const pkg = ['mongo', 'db'].join('');
  try {
    await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg);
    _mongoDriverResolves = true;
    return true;
  } catch {
    return false;
  }
}

type VectorFallbackState = 'ready' | 'unconfigured' | 'driver-missing';

/**
 * What the Cosmos vector backend can actually do right now.
 *
 * R7 — `cosmosVcoreGate()` establishes ONE fact: that
 * LOOM_COSMOS_VCORE_CONNECTION_STRING is non-empty. That is not enough to claim
 * the backend can ground an answer, because `vcoreVectorSearch` still has to
 * resolve the `mongodb` driver and will throw CosmosVcoreDriverError when it
 * cannot. 'ready' is returned only when BOTH facts hold.
 */
async function vectorFallbackState(): Promise<VectorFallbackState> {
  if (cosmosVcoreGate() !== null) return 'unconfigured';
  return (await vcoreDriverResolves()) ? 'ready' : 'driver-missing';
}

/**
 * The sentence appended to an AI-Search-unavailable message. It ROUTES the
 * model to the second backend only when that backend has been shown to be able
 * to run (#3351: backend selection is automatic, not a user-visible choice) —
 * and otherwise names the specific reason it cannot, so the model is never sent
 * to a tool whose only reachable answer is a dependency error.
 */
async function fallbackHint(): Promise<string> {
  switch (await vectorFallbackState()) {
    case 'ready':
      return ' Cosmos DB vector search is configured in this deployment AND its driver loads in this image'
        + ' — call vector_store_retrieve instead to ground this answer.';
    case 'driver-missing':
      return ' The Cosmos DB vector backend is configured (LOOM_COSMOS_VCORE_CONNECTION_STRING is set) but the'
        + ' `mongodb` driver is not installed in this Console image, so vector_store_retrieve cannot ground an'
        + ' answer either — it would only return that dependency error. No retrieval backend can ground this'
        + ' answer: say so honestly rather than guessing.';
    default:
      return ' The Cosmos DB vector backend (LOOM_COSMOS_VCORE_CONNECTION_STRING) is not configured either, so no'
        + ' retrieval backend can ground this answer — say so honestly rather than guessing.';
  }
}

/**
 * Honest pre-flight shared by both AI Search tools: returns a message string
 * when agentic retrieval can't run in this deployment/cloud, or null when it
 * can. The message always names the missing AI Search setting AND, per #3351,
 * points at the Cosmos vector backend when that one can genuinely answer.
 */
async function knowledgePreflight(): Promise<string | null> {
  if (!isSearchConfigured()) {
    return 'Azure AI Search is not configured in this deployment (set LOOM_AI_SEARCH_SERVICE). Agentic retrieval is unavailable.'
      + await fallbackHint();
  }
  const gov = knowledgeGovGate();
  if (gov) return gov.reason + await fallbackHint();
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
      const pre = await knowledgePreflight();
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
      const pre = await knowledgePreflight();
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

  // ── Second RAG backend: Cosmos DB vector search (#3351) ──────────────────
  //
  // Registered UNCONDITIONALLY so the model can always reach it and the honest
  // gate is the tool's own answer, not a missing tool. The INTENT is the
  // sovereign boundaries, where AI Search agentic retrieval is the piece whose
  // GA status varies: `cloud-parity.md` treats a Commercial-only capability as
  // incomplete, and a Cosmos vCore cluster is available in every boundary Loom
  // supports.
  //
  // The intent is not the achievement. Until the `mongodb` driver is a
  // dependency of this app (see the header note), this tool's only reachable
  // answer is CosmosVcoreDriverError's dependency gate, in every boundary. It
  // is registered so the gate is discoverable and so the backend goes live the
  // moment the driver ships — not because the parity gap is closed.
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

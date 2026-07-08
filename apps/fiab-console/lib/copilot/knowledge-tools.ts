/**
 * knowledge-tools — agentic-retrieval Copilot tools (Foundry IQ).
 *
 * Registers `knowledge_base_retrieve` (+ a small `knowledge_base_list` helper)
 * into the cross-item Copilot tool registry so Loom's OWN Copilot grounds RAG
 * answers on agentic retrieval — query decomposition + semantic rerank across
 * one or more knowledge sources — instead of a flat single-shot vector search.
 *
 * Every tool hits the REAL Azure AI Search agentic-retrieval REST API via
 * `aisearch-knowledge.ts` (per no-vaporware.md). When AI Search isn't
 * configured, or the sovereign cloud hasn't confirmed the api-version, the tool
 * returns an honest message string (never a fake answer). No Fabric / Power BI
 * dependency — the backend is Azure AI Search.
 */

import type { LoomToolRegistry } from '../azure/copilot-orchestrator';
import {
  listKnowledgeBases,
  retrieveKnowledge,
  knowledgeGovGate,
  isSearchConfigured,
} from '../azure/aisearch-knowledge';

const S_STRING = { type: 'string' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/**
 * Honest pre-flight shared by both tools: returns a message string when the
 * feature can't run in this deployment/cloud, or null when it can.
 */
function knowledgePreflight(): string | null {
  if (!isSearchConfigured()) {
    return 'Azure AI Search is not configured in this deployment (set LOOM_AI_SEARCH_SERVICE). Agentic retrieval is unavailable — answer from other grounded tools or say so honestly.';
  }
  const gov = knowledgeGovGate();
  if (gov) return gov.reason;
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
}

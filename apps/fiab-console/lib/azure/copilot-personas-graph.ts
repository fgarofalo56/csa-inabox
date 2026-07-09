/**
 * copilot-personas-graph.ts — Graph editors inline Copilot builder config (G1).
 * NL → graph query (GQL / openCypher / KQL make-graph), grounded on the graph's
 * real source table captured in item.state.
 *
 * Azure-native (no-fabric-dependency.md): "Graph in Fabric" maps 1:1 to Azure
 * Data Explorer (ADX / Kusto) graph semantics (make-graph / graph-match /
 * openCypher) per the graph-adx memory. No Microsoft Fabric. The generated query
 * is saved as a Loom-native draft (item.state.copilotGqlDraft) with checkpoint/
 * restore; the editor's query pane loads it and runs it against the real ADX
 * cluster.
 */

import { makeQueryBuilderConfig, type QueryBuilderDoc } from '@/lib/azure/copilot-query-builder';
import type { CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

function grounding(state: Record<string, unknown>): string {
  const lines: string[] = [];
  const table = typeof state.sourceTable === 'string' ? state.sourceTable
    : typeof state.graphSourceTable === 'string' ? state.graphSourceTable : '';
  if (table) lines.push(`SOURCE EDGE TABLE (ADX): ${table}`);
  const backend = typeof state.backend === 'string' ? state.backend : '';
  if (backend) lines.push(`GRAPH BACKEND: ${backend}`);
  if (typeof state.database === 'string' && state.database) lines.push(`ADX DATABASE: ${state.database}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You author graph queries for a CSA Loom Graph over Azure Data Explorer (ADX / Kusto).
CSA Loom is its OWN Azure product; "Graph in Fabric" maps 1:1 to ADX graph semantics — never mention Microsoft Fabric.
Respond with a JSON object ONLY: { "summary": "<1 sentence>", "ops": [ { "kind": "set-query", "query": "<full query>" } ] }.
No prose, no code fence around the JSON.
RULES:
 - Default to KQL graph semantics: build the graph from the SOURCE EDGE TABLE with make-graph, then match with graph-match, e.g.
     <EdgeTable> | make-graph Source --> Destination | graph-match (a)-->(b) where ... project ...
 - openCypher (graph-match with a Cypher-like pattern) is acceptable when the request is clearly Cypher-style.
 - Reference ONLY the SOURCE EDGE TABLE in the LIVE ITEM CONTEXT. If none is listed, use "GraphSnapshot" and say so in summary.
 - The query MUST be read-only. Put the full query string in ops[0].query.`;

/** Graph editors share one builder; the item type differs (gql-graph is the
 *  ADX-native default, cypher-graph the openCypher surface). */
export function makeGraphBuilderConfig(itemType: 'gql-graph' | 'cypher-graph'): CopilotBuilderConfig<QueryBuilderDoc> {
  return makeQueryBuilderConfig({
    itemType,
    docKey: 'copilotGqlDraft',
    language: itemType === 'cypher-graph' ? 'Cypher' : 'GQL',
    systemPrompt: SYSTEM_PROMPT,
    grounding,
  });
}

export const GRAPH_BUILDER_CONFIG: CopilotBuilderConfig<QueryBuilderDoc> = makeGraphBuilderConfig('gql-graph');

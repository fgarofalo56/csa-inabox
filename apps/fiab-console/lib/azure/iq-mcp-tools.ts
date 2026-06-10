/**
 * IQ MCP tool catalog + dispatcher.
 *
 * Defines the MCP `tools/list` payload for the unified Fabric IQ surface and the
 * `tools/call` dispatcher that maps each tool to its real Azure-native backend
 * (see iq-mcp.ts). This is the SERVER side of MCP — the inverse of mcp-client.ts
 * (which is the CLIENT that calls EXTERNAL MCP servers). External agents
 * (Microsoft Agent 365, Azure AI Foundry, Copilot Studio) call THIS endpoint.
 */

import {
  getIqOverview,
  listIqOntologies,
  getIqOntology,
  listIqSemanticModels,
  getIqSemanticModel,
  listIqSignalTables,
  queryIqSignals,
  searchIq,
} from './iq-mcp';

export interface IqMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** The static MCP tool catalog this server exposes (tools/list). */
export const IQ_MCP_TOOLS: IqMcpTool[] = [
  {
    name: 'iq_overview',
    description:
      'Discover the full Fabric IQ surface for the organization in one call: every ontology (conceptual entity model), every semantic model (curated tables + measures), and whether the live-signals (Azure Data Explorer) layer is available. Call this first to orient.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'iq_search',
    description:
      'Search the conceptual + semantic layers for a term. Matches ontology entity names, semantic-model table names, and measure names (case-insensitive). Returns ranked hits with the owning item so the agent can drill in.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The search term (e.g. "customer", "revenue", "churn").' },
        limit: { type: 'number', description: 'Max hits to return (default 50).' },
      },
      required: ['term'],
    },
  },
  {
    name: 'iq_list_ontologies',
    description: 'List every ontology (conceptual entity model) the organization owns, with entity + data-binding counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'iq_get_ontology',
    description:
      'Get the full ontology: its entity types (classes) with descriptions, the IS_A relationship hierarchy, and the Lakehouse/Warehouse bindings that materialize entity instances.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The ontology item id (from iq_list_ontologies).' } },
      required: ['id'],
    },
  },
  {
    name: 'iq_list_semantic_models',
    description: 'List every semantic model (curated tabular layer) the organization owns, with table + measure + relationship counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'iq_get_semantic_model',
    description:
      'Get the full semantic model: its tables (with columns), measures (DAX expressions + descriptions), and relationships. Use this to ground numeric/aggregation answers in governed measures.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The semantic-model item id (from iq_list_semantic_models).' } },
      required: ['id'],
    },
  },
  {
    name: 'iq_list_signal_tables',
    description:
      'List the live-signal tables available on the Azure Data Explorer (eventhouse-equivalent) cluster. Use this to discover what real-time telemetry can be queried.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'iq_query_signals',
    description:
      'Run a read-only KQL query against the live-signals (Azure Data Explorer) cluster and return rows. Only SELECT-style KQL is permitted (no control/management commands). The result is auto-bounded with `take` when the query is unbounded.',
    inputSchema: {
      type: 'object',
      properties: {
        kql: { type: 'string', description: 'The read-only KQL query (e.g. "Telemetry | where ts > ago(1h) | summarize count() by region").' },
        database: { type: 'string', description: 'Optional ADX database name (defaults to the env-pinned database).' },
        maxRows: { type: 'number', description: 'Cap on rows returned (default 500, max 5000).' },
      },
      required: ['kql'],
    },
  },
];

/** MCP content-block result shape (text content with embedded JSON). */
function asContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Dispatch an MCP tools/call to the real IQ backend for a given tenant.
 * Throws on unknown tool or invalid args so the route can map to a JSON-RPC error.
 */
export async function callIqTool(
  toolName: string,
  args: Record<string, unknown>,
  tenantId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const a = args || {};
  switch (toolName) {
    case 'iq_overview':
      return asContent(await getIqOverview(tenantId));

    case 'iq_search': {
      const term = String(a.term ?? '');
      if (!term.trim()) throw new Error('term is required');
      const limit = typeof a.limit === 'number' ? a.limit : undefined;
      return asContent(await searchIq(tenantId, term, limit));
    }

    case 'iq_list_ontologies':
      return asContent(await listIqOntologies(tenantId));

    case 'iq_get_ontology': {
      const id = String(a.id ?? '');
      if (!id) throw new Error('id is required');
      const d = await getIqOntology(tenantId, id);
      if (!d) throw new Error(`ontology ${id} not found`);
      return asContent(d);
    }

    case 'iq_list_semantic_models':
      return asContent(await listIqSemanticModels(tenantId));

    case 'iq_get_semantic_model': {
      const id = String(a.id ?? '');
      if (!id) throw new Error('id is required');
      const d = await getIqSemanticModel(tenantId, id);
      if (!d) throw new Error(`semantic-model ${id} not found`);
      return asContent(d);
    }

    case 'iq_list_signal_tables':
      return asContent(await listIqSignalTables());

    case 'iq_query_signals': {
      const kql = String(a.kql ?? '');
      if (!kql.trim()) throw new Error('kql is required');
      const database = a.database ? String(a.database) : undefined;
      const maxRows = typeof a.maxRows === 'number' ? a.maxRows : undefined;
      return asContent(await queryIqSignals(kql, database, maxRows));
    }

    default:
      throw new Error(`unknown tool: ${toolName}`);
  }
}

/**
 * agent-tool-catalog — the shared, TYPED agent-tool registry (AIF-5).
 *
 * ONE catalog every agent surface (data-agent, operations-agent, foundry-agents,
 * prompt-flow) consumes so a tool is authored through typed pickers + config
 * forms, NEVER a freeform comma-separated / JSON box (loom_no_freeform_config).
 *
 * A tool is persisted as a structured `AgentTool` in the item's `state.tools[]`.
 * `toFoundryTool()` maps each typed tool to the Azure AI Foundry Agent Service
 * tool-catalog wire JSON (code_interpreter / file_search / function / mcp /
 * openapi / bing_grounding) so the SAME structured state drives both Loom's
 * Azure-native grounded run AND an opt-in publish to the Foundry Agent Service.
 *
 * Source grounding: Foundry Agent Service tool catalog + MCP tool schema
 *   https://learn.microsoft.com/azure/foundry/agents/concepts/tool-catalog
 *   https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol
 *
 * This module is PURE (no JSX, no React, no Azure SDK) so it is unit-tested
 * without the Fluent bundle (see __tests__/agent-tool-catalog.test.ts). The
 * per-kind Fluent glyph + the editing UI live in agent-tool-catalog-editor.tsx.
 *
 * No new env var, no bicep — data-plane only. Identical in Commercial & Gov;
 * the ONE gov-aware kind (bing_grounding) is honest-gated, never hard-wired.
 */

import type { CanvasNodeCategory } from '@/lib/components/canvas/canvas-node-kit';
import { REMOTE_BUILTIN_MCP_CATALOG } from '@/lib/mcp/catalog';

/** Every typed tool kind an agent can attach. */
export type AgentToolKind =
  // Loom-item-bound data tools (Azure-native grounded backends)
  | 'warehouse'
  | 'lakehouse'
  | 'kql'
  | 'search-index'
  | 'knowledge-base'
  // Weave ontology-object tool (WS-6): the agent reasons over TYPED object
  // instances resolved through the ontology graph, not raw tables.
  | 'ontology-object'
  // capability tools
  | 'code-interpreter'
  | 'function'
  | 'mcp'
  | 'openapi'
  | 'bing-grounding';

/** OpenAPI tool auth model (maps to the Foundry openapi tool `auth.type`). */
export type AgentToolAuthKind = 'anonymous' | 'api-key' | 'bearer';

/**
 * One structured tool on an agent. Only the fields relevant to `kind` are set;
 * the rest stay undefined. Persisted verbatim into `state.tools[]`.
 */
export interface AgentTool {
  /** Stable client id (list-key + canvas node id seed). */
  id: string;
  kind: AgentToolKind;
  /** Optional human label override (canvas node title / picker). */
  label?: string;
  description?: string;
  // --- item-bound kinds (warehouse / lakehouse / kql / search-index / knowledge-base) ---
  itemId?: string;
  itemName?: string;
  // --- ontology-object (WS-6) — itemId binds the ontology item; objectType names
  // the declared object type whose typed instances the agent grounds on. ---
  objectType?: string;
  // --- mcp ---
  /** Registry id of the bound MCP server (REMOTE_BUILTIN_MCP_CATALOG / registered). */
  serverId?: string;
  /** `server_label` on the wire — defaults to the server id. */
  serverLabel?: string;
  /** Resolved HTTPS Streamable-HTTP endpoint. */
  serverUrl?: string;
  /** Allow-list of tool names exposed from the server ([] / undefined ⇒ all). */
  allowedTools?: string[];
  // --- openapi ---
  specUrl?: string;
  authKind?: AgentToolAuthKind;
  /** Key Vault secret NAME holding the api-key / bearer (never the value). */
  authRef?: string;
  // --- function ---
  functionName?: string;
}

/** Static metadata describing one tool kind (drives the picker + canvas visual). */
export interface AgentToolKindMeta {
  kind: AgentToolKind;
  /** Picker + card label. */
  label: string;
  /** Short chip label used on the canvas node header. */
  short: string;
  /** One-line description shown under the picker. */
  description: string;
  /**
   * Loom item type to populate a binding Dropdown from
   * `/api/items/by-type?types=<bindItemType>`; `null` ⇒ no item binding.
   */
  bindItemType: string | null;
  /** Fluent glyph key resolved to an icon in agent-tool-catalog-editor.tsx. */
  icon: string;
  /** Canvas node category (accent + gradient) for AIF-6. */
  category: CanvasNodeCategory;
  /** Honest gov/infra gate copy (shown, never hard-blocking). */
  gate?: string;
  /** Kinds that only make sense once per agent (code interpreter). */
  singleton?: boolean;
}

/**
 * THE catalog. Order is the picker order. Every kind here is authored through a
 * typed config form — there is NO freeform tool entry anywhere.
 */
export const AGENT_TOOL_KINDS: readonly AgentToolKindMeta[] = [
  {
    kind: 'warehouse',
    label: 'Warehouse (SQL)',
    short: 'Warehouse',
    description: 'Query a Loom warehouse (Synapse dedicated SQL) with NL→SQL grounding.',
    bindItemType: 'warehouse',
    icon: 'warehouse',
    category: 'move',
  },
  {
    kind: 'lakehouse',
    label: 'Lakehouse (Delta)',
    short: 'Lakehouse',
    description: 'Query a Loom lakehouse (ADLS Gen2 + Delta / serverless SQL) via NL→SQL.',
    bindItemType: 'lakehouse',
    icon: 'lakehouse',
    category: 'move',
  },
  {
    kind: 'kql',
    label: 'KQL database (ADX)',
    short: 'KQL',
    description: 'Query a Loom KQL database / Eventhouse (Azure Data Explorer) via NL→KQL.',
    bindItemType: 'kql-database',
    icon: 'kql',
    category: 'move',
  },
  {
    kind: 'search-index',
    label: 'Search index (file search)',
    short: 'Search',
    description: 'Retrieve grounded passages from a Loom AI Search index (file_search).',
    bindItemType: 'ai-search-index',
    icon: 'search',
    category: 'move',
  },
  {
    kind: 'knowledge-base',
    label: 'Knowledge base',
    short: 'Knowledge',
    description: 'Agentic retrieval over a Loom knowledge base (multi-source knowledge source).',
    bindItemType: 'knowledge-base',
    icon: 'knowledge',
    category: 'move',
  },
  {
    kind: 'ontology-object',
    label: 'Ontology object',
    short: 'Object',
    description: 'Ground on TYPED instances of a Weave ontology object type (WS-6) — resolved through the ontology graph from its bound lakehouse / KQL / semantic sources.',
    bindItemType: 'ontology',
    icon: 'ontology',
    category: 'transform',
  },
  {
    kind: 'code-interpreter',
    label: 'Code interpreter',
    short: 'Code',
    description: 'Run sandboxed Python for data analysis / charting (Foundry code_interpreter).',
    bindItemType: null,
    icon: 'code',
    category: 'transform',
    singleton: true,
  },
  {
    kind: 'function',
    label: 'Function (BFF tool)',
    short: 'Function',
    description: 'Call a Loom BFF function tool by name (function calling).',
    bindItemType: null,
    icon: 'function',
    category: 'control',
  },
  {
    kind: 'mcp',
    label: 'MCP server tool',
    short: 'MCP',
    description: 'Bind a registered / built-in Model Context Protocol server as a tool source.',
    bindItemType: null,
    icon: 'mcp',
    category: 'external',
  },
  {
    kind: 'openapi',
    label: 'OpenAPI tool',
    short: 'OpenAPI',
    description: 'Call any REST API from an OpenAPI spec URL with a typed auth reference.',
    bindItemType: null,
    icon: 'openapi',
    category: 'external',
  },
  {
    kind: 'bing-grounding',
    label: 'Web grounding (Bing)',
    short: 'Web',
    description: 'Ground answers on live web results.',
    bindItemType: null,
    icon: 'web',
    category: 'external',
    gate: 'Bing grounding is not available in all Government regions. Set LOOM_BING_GROUNDING_CONNECTION to a Foundry Grounding-with-Bing connection; otherwise this tool stays inert.',
  },
] as const;

/** Look up a kind's metadata. */
export function agentToolKind(kind: AgentToolKind): AgentToolKindMeta | undefined {
  return AGENT_TOOL_KINDS.find((k) => k.kind === kind);
}

/** Canvas category for a kind (falls back to 'external'). */
export function toolCanvasCategory(kind: AgentToolKind): CanvasNodeCategory {
  return agentToolKind(kind)?.category ?? 'external';
}

/** Stable-ish client id for a new tool/node. */
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Construct a new tool of `kind` with sensible defaults. */
export function newAgentTool(kind: AgentToolKind): AgentTool {
  const meta = agentToolKind(kind);
  const base: AgentTool = { id: genId(kind), kind, label: meta?.label };
  if (kind === 'openapi') base.authKind = 'anonymous';
  if (kind === 'mcp') base.allowedTools = [];
  return base;
}

/** Options for the MCP-server binding Dropdown (from the remote-builtin catalog). */
export interface McpToolOption {
  id: string;
  label: string;
  endpoint: string;
  gate: string;
  optIn: boolean;
}

/**
 * Built-in MCP servers offered as tool sources. Derived from the remote-builtin
 * catalog (Microsoft-hosted / self-hosted-on-Azure). Endpoint may be '' when the
 * server isn't wired yet — the editor honest-gates it (no-vaporware).
 */
export function mcpToolOptions(): McpToolOption[] {
  return REMOTE_BUILTIN_MCP_CATALOG.map((e) => ({
    id: e.id,
    label: e.name,
    endpoint: e.endpoint || '',
    gate: e.gate,
    optIn: e.optIn,
  }));
}

/**
 * Normalize a persisted `tools` value into a clean `AgentTool[]`.
 *  - `AgentTool[]` ⇒ returned with ids/kinds validated.
 *  - a legacy comma string (operations-agent's old freeform box) ⇒ each token
 *    becomes a `function` tool named after the token.
 *  - `string[]` ⇒ same, one function tool per entry.
 * Anything else ⇒ [].
 */
export function migrateLegacyTools(raw: unknown): AgentTool[] {
  if (Array.isArray(raw)) {
    // Structured array already?
    if (raw.every((t) => t && typeof t === 'object' && typeof (t as any).kind === 'string')) {
      return (raw as AgentTool[])
        .filter((t) => AGENT_TOOL_KINDS.some((k) => k.kind === t.kind))
        .map((t) => ({ ...t, id: t.id || genId(t.kind) }));
    }
    // Array of plain strings (legacy tool names).
    return raw
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .map((name) => ({ ...newAgentTool('function'), functionName: name, label: name }));
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((name) => ({ ...newAgentTool('function'), functionName: name, label: name }));
  }
  return [];
}

/** Human-readable one-line summary of a tool's binding (picker + canvas body). */
export function describeAgentTool(tool: AgentTool): string {
  switch (tool.kind) {
    case 'warehouse':
    case 'lakehouse':
    case 'kql':
    case 'search-index':
    case 'knowledge-base':
      return tool.itemName || tool.itemId || '(pick an item)';
    case 'ontology-object':
      return tool.objectType
        ? `${tool.objectType}${tool.itemName ? ` · ${tool.itemName}` : ''}`
        : (tool.itemName || tool.itemId ? '(pick an object type)' : '(pick an ontology)');
    case 'mcp':
      return tool.serverLabel || tool.serverId || '(pick a server)';
    case 'openapi':
      return tool.specUrl || '(spec URL)';
    case 'function':
      return tool.functionName || '(function name)';
    case 'code-interpreter':
      return 'Sandboxed Python';
    case 'bing-grounding':
      return 'Live web results';
    default:
      return '';
  }
}

/** True when a tool has enough config to be usable (drives the "incomplete" badge). */
export function isAgentToolConfigured(tool: AgentTool): boolean {
  switch (tool.kind) {
    case 'warehouse':
    case 'lakehouse':
    case 'kql':
    case 'search-index':
    case 'knowledge-base':
      return !!tool.itemId;
    case 'ontology-object':
      return !!(tool.itemId && tool.objectType && tool.objectType.trim());
    case 'mcp':
      return !!tool.serverId;
    case 'openapi':
      return !!tool.specUrl;
    case 'function':
      return !!(tool.functionName && tool.functionName.trim());
    case 'code-interpreter':
    case 'bing-grounding':
      return true;
    default:
      return false;
  }
}

/**
 * Map a typed tool to the Foundry Agent Service tool-catalog wire JSON. Returns
 * `null` for a not-yet-configured tool so publish never emits a half-bound tool.
 */
export function toFoundryTool(tool: AgentTool): Record<string, unknown> | null {
  if (!isAgentToolConfigured(tool)) return null;
  switch (tool.kind) {
    case 'code-interpreter':
      return { type: 'code_interpreter' };
    case 'search-index':
      return {
        type: 'file_search',
        file_search: { loom_index_item: tool.itemId, name: tool.itemName || tool.itemId },
      };
    case 'knowledge-base':
      return {
        type: 'file_search',
        file_search: { loom_knowledge_base: tool.itemId, name: tool.itemName || tool.itemId },
      };
    case 'warehouse':
    case 'lakehouse':
    case 'kql':
      return {
        type: 'function',
        function: {
          name: `loom_${tool.kind}_query`,
          description: tool.description || `Query the Loom ${tool.kind} "${tool.itemName || tool.itemId}".`,
          parameters: {
            type: 'object',
            properties: { question: { type: 'string', description: 'The natural-language question to answer.' } },
            required: ['question'],
          },
        },
        loom_binding: { kind: tool.kind, itemId: tool.itemId, itemName: tool.itemName },
      };
    case 'ontology-object':
      return {
        type: 'function',
        function: {
          name: `loom_ontology_${(tool.objectType || 'object').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'object'}`,
          description: tool.description || `Resolve typed "${tool.objectType}" instances through the Weave ontology "${tool.itemName || tool.itemId}".`,
          parameters: {
            type: 'object',
            properties: { question: { type: 'string', description: 'The natural-language question to answer over the object instances.' } },
            required: ['question'],
          },
        },
        loom_binding: { kind: 'ontology-object', itemId: tool.itemId, itemName: tool.itemName, objectType: tool.objectType },
      };
    case 'function':
      return {
        type: 'function',
        function: {
          name: (tool.functionName || 'loom_tool').trim(),
          description: tool.description || undefined,
          parameters: { type: 'object', properties: {} },
        },
      };    case 'mcp':
      return {
        type: 'mcp',
        server_label: (tool.serverLabel || tool.serverId || 'mcp').trim(),
        server_url: tool.serverUrl || undefined,
        allowed_tools: tool.allowedTools && tool.allowedTools.length ? tool.allowedTools : undefined,
      };
    case 'openapi':
      return {
        type: 'openapi',
        openapi: {
          name: (tool.label || 'openapi_tool').trim(),
          spec_url: tool.specUrl,
          auth: { type: tool.authKind || 'anonymous', ...(tool.authRef ? { secret_ref: tool.authRef } : {}) },
        },
      };
    case 'bing-grounding':
      return { type: 'bing_grounding' };
    default:
      return null;
  }
}

/** Map a whole tool list to Foundry wire tools, dropping unconfigured ones. */
export function toolsToFoundryTools(tools: AgentTool[]): Array<Record<string, unknown>> {
  return tools.map(toFoundryTool).filter((t): t is Record<string, unknown> => t !== null);
}

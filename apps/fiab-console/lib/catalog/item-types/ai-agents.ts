import type { FabricItemType } from './types';

/**
 * AI & Agents — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const aiAgentsItems: FabricItemType[] = [
  // --- v3 — Cross-item Copilot orchestrator (AOAI via Foundry hub) ---
  { slug: 'cross-item-copilot',          displayName: 'Cross-item Copilot',          restType: 'CrossItemCopilot',          category: 'AI & Agents',
    description: 'Natural-language orchestrator across every wired Loom service: Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry. 25+ tools.',
    learnContent: {
      "overview": "The Cross-item Copilot is a natural-language orchestrator across every wired Loom service — Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry (25+ tools). In Loom it streams from POST /api/copilot/orchestrate via SSE and calls the same BFF actions the UI calls, with a full audit log.",
      "steps": [
        {
          "title": "Start a session",
          "body": "Open a session in the left rail; the right rail lists registered tools grouped by service."
        },
        {
          "title": "Ask in natural language",
          "body": "Describe the task; the orchestrator streams its plan and steps live via SSE."
        },
        {
          "title": "Watch tool calls",
          "body": "Each step calls the same BFF action the UI uses against real services."
        },
        {
          "title": "Audit every move",
          "body": "Review the full audit log of actions the Copilot performed."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview"
    } },
  // W9 — Agent flow: a standalone visual workflow that chains MCP tools, typed
  // data tools, and connected sub-agents into a FlowDag, then RUNS it through
  // the Azure-native connected-agents runtime (grounded AOAI orchestration).
  // No Microsoft Fabric / Foundry dependency on the default path (opt-in only).
  { slug: 'agent-flow', displayName: 'Agent flow', restType: 'AgentFlow', category: 'AI & Agents',
    description: 'Visual multi-agent workflow — chain MCP tools, grounded data tools (lakehouse/warehouse/KQL/AI Search), and connected sub-agents on a canvas, then run the flow against real Azure backends. Azure-native, no Fabric dependency.',
    learnContent: {
      "overview": "An Agent flow is a standalone, first-class version of Loom's visual multi-agent workflow designer. On one canvas you compose an orchestrator agent with grounded data-tool nodes (lakehouse / warehouse / KQL / AI Search — each bound to a real Loom item), capability tools (MCP servers, OpenAPI, functions, code interpreter), and connected sub-agents. Running the flow executes it through the Azure-native connected-agents runtime: the orchestrator answers over the grounded sources via the live Azure OpenAI deployment and delegates to each connected sub-agent (a real grounded run per sub-agent plus a synthesis pass). No Microsoft Fabric capacity or Foundry project is required — the Foundry / MAF agent runtime is an opt-in alternative.",
      "steps": [
        {
          "title": "Describe the orchestrator",
          "body": "Write the orchestrator's instructions — what the flow should do and how it should combine its tools and sub-agents."
        },
        {
          "title": "Add tools + sub-agents on the canvas",
          "body": "Drop grounded data tools (bind a lakehouse / warehouse / KQL database / AI Search index), capability tools (MCP server, OpenAPI, function), and connected sub-agents (other data or operations agents) as nodes wired from the orchestrator."
        },
        {
          "title": "Run the flow",
          "body": "Ask a question in the run pane. The flow grounds on the bound data items, delegates to each connected sub-agent, and returns a synthesized answer — with the tool + delegation trace shown."
        },
        {
          "title": "Review run history",
          "body": "Each run is recorded with its grounded-source, tool, and sub-agent counts, token usage, and status."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-services/agents/concepts/connected-agents"
    } },
];

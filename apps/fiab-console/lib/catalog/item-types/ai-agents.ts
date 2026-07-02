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
];

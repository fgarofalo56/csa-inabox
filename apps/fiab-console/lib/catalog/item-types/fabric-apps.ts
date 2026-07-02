import type { FabricItemType } from './types';

/**
 * Fabric Apps — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const fabricAppsItems: FabricItemType[] = [
  // Fabric Apps — Rayfin (Build 2026 preview)
  { slug: 'rayfin-app', displayName: 'Rayfin app', restType: 'RayfinApp', category: 'Fabric Apps', preview: true,
    templateOf: 'slate-app', templateId: 'rayfin-azure-stack',
    description: 'Backed template — scaffolds an Azure-native equivalent of the Fabric Rayfin stack: Azure Functions (user-data-function) + Cosmos DB (azure-cosmos-account) + a Static Web App (slate-app) you can actually run. No Fabric.',
    learnContent: {
      "overview": "Rayfin is Microsoft's open-source Backend-as-a-Service for Fabric (Build 2026 preview). The CSA Loom equivalent is a BACKED template that scaffolds the same shape with real Azure services: picking it INSTANTIATES three real, editable Loom items — a user-data-function item (the API tier on Azure Functions), an azure-cosmos-account item (the data store on Cosmos DB), and a slate-app item (the Static Web App web tier) — and wires them together so the web app calls the Functions route and the Functions item reads/writes the Cosmos store. Azure-native: no Fabric workspace required, and every scaffolded item is a runnable Loom item, not a stub. (The original code-first Rayfin SDK/CLI path — TypeScript + @microsoft/rayfin-core decorators deployed with `npx rayfin up` — remains available as an opt-in alternative.)",
      "steps": [
        {
          "title": "Pick workspace + name",
          "body": "Choose the target Loom workspace and a name for the app stack."
        },
        {
          "title": "Instantiate the stack",
          "body": "Loom creates a real user-data-function item (Azure Functions API), an azure-cosmos-account item (Cosmos DB store), and a slate-app item (Static Web App), then wires the web app to the Functions route and the Functions item to the Cosmos store."
        },
        {
          "title": "Land in the web app",
          "body": "You open the slate-app web tier, already bound to the Functions + Cosmos backend. Add widgets and queries over the live API."
        },
        {
          "title": "Author the backend",
          "body": "Open the user-data-function item to author the API (Python/TypeScript) and the azure-cosmos-account item to manage containers — all real, editable Loom items."
        },
        {
          "title": "Run it on your tenant",
          "body": "The stack runs on your tenant's Azure Functions, Cosmos DB, and Static Web Apps under your identity/network/governance; any unprovisioned runtime surfaces each editor's honest infra-gate while the full UI still renders."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/apps/overview"
    } },
];

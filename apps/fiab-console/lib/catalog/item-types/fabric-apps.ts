import type { FabricItemType } from './types';

/**
 * Loom Apps — item-type catalog slice (category displayName 'Loom Apps').
 *
 * The home for BUILDING and DISTRIBUTING apps on an Azure-native / OSS stack —
 * the CSA Loom answer to "Fabric apps" WITHOUT any Microsoft Fabric or Power BI
 * dependency (see .claude/rules/no-fabric-dependency.md). Two shapes of app,
 * mirroring what Fabric's Apps surface offers:
 *   • DATA apps — a data-driven application over your data (Azure Functions +
 *     Cosmos DB + Static Web Apps for the `loom-app`/data-app builders).
 *   • ORG apps — bundle existing workspace items (reports, dashboards,
 *     notebooks, …) into a distributable app with navigation + audiences.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are grouped by the item's `category` field and recomposed
 * into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel. Slugs and
 * restType are kept STABLE for back-compat with already-created items.
 */
export const loomAppsItems: FabricItemType[] = [
  // Loom app — org app: bundle workspace items into a distributable, audience-
  // scoped app. Azure-native (Cosmos-persisted definition + the existing item /
  // access model); no Power BI or Fabric workspace required.
  { slug: 'loom-app', displayName: 'Loom app', restType: 'LoomApp', category: 'Loom Apps',
    description: 'Bundle workspace items — reports, dashboards, notebooks and more — into a distributable app with navigation and audiences. Azure-native; no Power BI or Fabric workspace.',
    learnContent: {
      "overview": "A Loom app is an ORG app: it packages the items you already have in a workspace into a single, navigable, distributable experience for consumers — the CSA Loom equivalent of a Microsoft Fabric / Power BI org app, built entirely on Azure-native services with NO Power BI or Fabric workspace required. You pick the content (any workspace items — reports, dashboards, notebooks, semantic models, …), arrange it into navigation sections, define one or more audiences with their own access list and visible-content subset, then publish a consumer app view. The definition and audiences persist to Cosmos DB and the published view reuses Loom's existing per-item routes + access model, so every tile opens the real item under the consumer's identity and governance.",
      "steps": [
        { "title": "Add content", "body": "Pick items from this workspace to include — the content list is the real, live inventory of the app's workspace (Cosmos-backed), so reports, dashboards, notebooks and every other item type are eligible." },
        { "title": "Arrange navigation", "body": "Group content into named navigation sections and order the entries; this is exactly what consumers see in the app's left nav." },
        { "title": "Define audiences", "body": "Create one or more audiences, each with its own access list (users / groups) and, optionally, a subset of the content it can see — the Fabric org-app 'audiences' model, on Loom's access layer." },
        { "title": "Publish", "body": "Publish the app to mint a consumer app view at /apps/<id>. Each publish records a version; consumers who belong to an audience open the app and navigate to the real items." },
        { "title": "Open as a consumer", "body": "Open the published app view: it resolves the caller's audience membership, renders the navigation, and deep-links each tile to the live item under the consumer's identity, network and governance." }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/create-apps"
    } },

  // Data app (formerly 'Rayfin app') — backed template that scaffolds an Azure-
  // native data-app stack: Azure Functions + Cosmos DB + Static Web App. Now
  // creatable from the gallery (no longer Labs-hidden). Preview: Build-2026 shape.
  { slug: 'rayfin-app', displayName: 'Data app', restType: 'RayfinApp', category: 'Loom Apps', preview: true,
    templateOf: 'slate-app', templateId: 'rayfin-azure-stack',
    description: 'Backed template — scaffolds a runnable Azure-native data-app stack: Azure Functions (API tier) + Cosmos DB (data store) + a Static Web App (web tier), wired together. No Fabric.',
    learnContent: {
      "overview": "A Data app scaffolds a full-stack, data-driven application on Azure-native services — the CSA Loom equivalent of Fabric's Rayfin data-app shape (Build 2026), with NO Fabric workspace required. Picking it INSTANTIATES three real, editable Loom items — a user-data-function item (the API tier on Azure Functions), an azure-cosmos-account item (the data store on Cosmos DB), and a slate-app item (the Static Web App web tier) — and wires them together so the web app calls the Functions route and the Functions item reads/writes the Cosmos store. Every scaffolded item is a runnable Loom item, not a stub. (Fabric's open-source Rayfin SDK/CLI path — TypeScript + @microsoft/rayfin-core decorators deployed with `npx rayfin up` — remains available as an opt-in alternative for teams that specifically want it.)",
      "steps": [
        { "title": "Pick workspace + name", "body": "Choose the target Loom workspace and a name for the app stack." },
        { "title": "Instantiate the stack", "body": "Loom creates a real user-data-function item (Azure Functions API), an azure-cosmos-account item (Cosmos DB store), and a slate-app item (Static Web App), then wires the web app to the Functions route and the Functions item to the Cosmos store." },
        { "title": "Land in the web app", "body": "You open the slate-app web tier, already bound to the Functions + Cosmos backend. Add widgets and queries over the live API." },
        { "title": "Author the backend", "body": "Open the user-data-function item to author the API (Python/TypeScript) and the azure-cosmos-account item to manage containers — all real, editable Loom items." },
        { "title": "Run it on your tenant", "body": "The stack runs on your tenant's Azure Functions, Cosmos DB, and Static Web Apps under your identity/network/governance; any unprovisioned runtime surfaces each editor's honest infra-gate while the full UI still renders." }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/apps/overview"
    } },
];

/**
 * Back-compat alias: this slice used to be exported as `fabricAppsItems`.
 * The barrel (lib/catalog/fabric-item-types.ts) now imports `loomAppsItems`;
 * keep the old name as an alias in case any external importer referenced it.
 */
export const fabricAppsItems = loomAppsItems;

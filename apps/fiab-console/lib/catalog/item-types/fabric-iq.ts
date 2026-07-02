import type { FabricItemType } from './types';

/**
 * Fabric IQ — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const fabricIqItems: FabricItemType[] = [
  // Fabric IQ (preview)
  { slug: 'ontology', displayName: 'Ontology', restType: 'Ontology', category: 'Fabric IQ', preview: true,
    description: 'Define business entities, relationships, and condition-action rules.',
    learnContent: {
      "overview": "An Ontology defines business object types, link types, actions, and interfaces over your data (preview). In Loom it is a typed modeling surface — structured forms, no freeform JSON — whose instances live in a real graph backend, and whose object types can be backed by a Lakehouse / Warehouse datasource with per-property column mapping.",
      "steps": [
        {
          "title": "Define object types",
          "body": "On the Object types tab declare each business entity with the typed form — properties with base types, a title property, status, and color. No JSON textarea."
        },
        {
          "title": "Back a type with a datasource",
          "body": "Bind an object type to a Lakehouse / Warehouse table and map each ontology property to a source column — the editor browses the live Synapse schema so the column mapping is picked, not typed."
        },
        {
          "title": "Define link types and interfaces",
          "body": "Connect object types with typed link types (cardinality + properties), and declare Interfaces / Shared properties as contracts that object types implement."
        },
        {
          "title": "Create instances and links",
          "body": "Use the typed instance form to create real object instances and link instances between them — both persist to the graph backend (Apache AGE), and Actions execute as real graph transactions."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'graph-model', displayName: 'Graph model', restType: 'GraphModel', category: 'Fabric IQ', preview: true,
    description: 'Native graph storage + GQL queries for connected data.',
    learnContent: {
      "overview": "A Graph model is the schema definition for a property graph — node labels, edge types, allowed properties, indexes (preview). In Loom you author it on an interactive schema canvas and query it with GQL/openCypher translated to the ADX graph engine (make-graph / graph-match) — Cosmos Gremlin and GQL backends are also supported. No Microsoft Fabric required.",
      "steps": [
        {
          "title": "Model on the schema canvas",
          "body": "Add entities (node labels) on the interactive canvas — drag to arrange, double-click an entity to edit its properties in the side panel, and drag between two entities to add a relationship (edge type) pre-filled with from/to."
        },
        {
          "title": "Declare properties and indexes",
          "body": "Give each node label and edge type typed properties, and specify indexes on key properties to speed up traversals."
        },
        {
          "title": "Bind a backend",
          "body": "Map the model onto the ADX graph (GQL/openCypher over make-graph), Cosmos Gremlin, or a GQL backend."
        },
        {
          "title": "Query with the builder",
          "body": "Use the no-code query builder — pick a start entity, relationship, target, property filters, and returns — or write GQL/openCypher directly; both run the same translate-to-KQL path and render results as Table, Card, or Diagram."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'plan', displayName: 'Plan', restType: 'Plan', category: 'Fabric IQ', preview: true,
    description: 'Collaborative planning sheets with writeback and approvals.',
    learnContent: {
      "overview": "A Plan (preview) is the Fabric IQ EPM/CPM item: build budgets and forecasts across periods, branch what-if scenarios, and compare plan vs actuals. In Loom it is Azure-native — planning cells persist to Cosmos and write back to an Azure SQL database; actuals come from a bound semantic model. No Microsoft Fabric capacity required.",
      "steps": [
        {
          "title": "Add line items and periods",
          "body": "Define budget/forecast line items on the Planning sheet and the periods (months, quarters) to plan across."
        },
        {
          "title": "Branch scenarios",
          "body": "Create baseline, optimistic, pessimistic, and custom scenarios; each branch clones the source assumptions so you can model what-ifs side by side."
        },
        {
          "title": "Spread and breakback",
          "body": "On a roll-up parent cell, Spread evenly / by growth % / by weight allocates a total down to the child cells (with a preview table), and Breakback edits the parent's total and pushes the change proportionally back into the children."
        },
        {
          "title": "Flag driver rows",
          "body": "Mark assumption rows (headcount, price, growth rate) as Drivers — they sort first in the Formula builder's picker and the dependency-ordered recompute evaluates drivers before the formulas that consume them."
        },
        {
          "title": "Ask Plan Copilot",
          "body": "Open the Plan Copilot rail to explain a variance, draft a forecast, or sanity-check the budget — it grounds an Azure OpenAI chat on this plan's cells, variance, and model."
        },
        {
          "title": "Compare plan vs actuals",
          "body": "Turn on the variance overlay to see Δ and Δ% against actuals from the bound semantic model (or entered manually)."
        },
        {
          "title": "Write back to Azure SQL",
          "body": "Configure a backing Azure SQL database in Settings, then Write back to MERGE planning cells into dbo.loom_plan_cells for governed, queryable storage."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/iq/plan/overview"
    } },
  { slug: 'map', displayName: 'Map', restType: 'Map', category: 'Fabric IQ', preview: true,
    description: 'Geospatial visualization layered over Lakehouse, KQL, and Ontology data.',
    learnContent: {
      "overview": "A Map is a geospatial visualization layered over Lakehouse, KQL, and Ontology data. In Loom the map binds to a live Azure-native source — a Synapse Serverless table (Lakehouse), an Azure Data Explorer KQL query, or a Weave Ontology entity — and renders point, heatmap, cluster, and choropleth layers over the returned geo rows. No Power BI / Fabric required; the vector overlay renders offline and an optional Azure Maps raster basemap layers behind it.",
      "steps": [
        {
          "title": "Bind a geo-dataset",
          "body": "On the Data binding tab, pick Lakehouse / KQL / Ontology, map the lat/lon (and optional value/label) columns, and Run binding — Loom queries the real backend and folds the rows into the map."
        },
        {
          "title": "Add layers",
          "body": "Compose point, heatmap, cluster, or choropleth layers over the bound data; each can be weighted by a numeric value column/property."
        },
        {
          "title": "Style and color",
          "body": "Set color ramps and symbology so the geography reads clearly."
        },
        {
          "title": "Draw and measure",
          "body": "Toggle Draw / measure to sketch points, lines, polygons, rectangles, and circles directly on the map with a live spherical distance / area readout; drawn annotations persist with the map."
        },
        {
          "title": "Geocode addresses",
          "body": "Paste addresses (one per line) in the Geocode addresses box and Geocode & plot — Loom resolves them to lat/lon via Azure Maps Search and plots the points. Requires the Azure Maps account wiring; a missing account surfaces an honest gate."
        },
        {
          "title": "Embed it",
          "body": "Embed the map in a report or dashboard for consumers."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'data-agent', displayName: 'Data agent', restType: 'DataAgent', category: 'Fabric IQ',
    description: 'Conversational Q&A grounded in your data sources and semantic model.',
    learnContent: {
      "overview": "A Data agent is conversational Q&A grounded in your data sources — warehouse, lakehouse, KQL, AI Search, graph, and semantic models. In Loom the Build tab binds up to 5 sources, each scoped with a real schema tree; Test chat, Evaluate, Publish, Consume, and Monitoring round out the lifecycle. Azure-native — no Microsoft Fabric required.",
      "steps": [
        {
          "title": "Pick data sources",
          "body": "On the Build tab bind up to 5 sources — warehouse, lakehouse, KQL / Eventhouse, AI Search, graph, or semantic model — and give each instructions and example questions."
        },
        {
          "title": "Scope the schema",
          "body": "Expand each source's schema tree — real Tables / Views / Functions / Fields read live from the backend (Synapse INFORMATION_SCHEMA, ADX .show tables, AI Search index) — and check exactly which objects the agent may query. No freeform table strings."
        },
        {
          "title": "Draft with Config Copilot",
          "body": "The Config Copilot tab drafts instructions and source descriptions from your bound schema so grounding starts strong."
        },
        {
          "title": "Test questions",
          "body": "Use Test chat to ask sample business questions and verify the agent queries the right sources; the Run inspector shows each tool call and query."
        },
        {
          "title": "Evaluate and publish",
          "body": "Score the agent against a question set on Evaluate, then Publish and share the Consume endpoint; Monitoring tracks usage over time."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'operations-agent', displayName: 'Operations agent', restType: 'OperationsAgent', category: 'Fabric IQ', preview: true, hiddenFromGallery: true,
    description: 'Monitor real-time data and recommend actions via Activator + Power Automate.',
    learnContent: {
      "overview": "An Operations agent is an AI agent that watches your real-time operational data and proposes actions (preview). In Loom it is Azure-native: the agent's instructions, model, and tools are configured in the editor, it grounds on a bound Eventhouse (Azure Data Explorer) and Ontology, runs live test questions with tool traces, evaluates time / data-change triggers as real Azure Monitor rules, and drafts human-in-the-loop remediation proposals. Deploy to Foundry optionally publishes the agent to the Azure AI Foundry Agent Service — no Microsoft Fabric required.",
      "steps": [
        {
          "title": "Configure the agent",
          "body": "On the Configure tab set the instructions and model, and bind the Eventhouse (ADX) and Ontology the agent grounds on — dropdown pickers, no freeform ids. Deploy to Foundry optionally publishes the definition to the Azure AI Foundry Agent Service."
        },
        {
          "title": "Test / Run",
          "body": "Ask the agent a live operational question on the Test / Run tab; it queries the bound Eventhouse and Ontology and shows the per-tool run trace alongside the answer."
        },
        {
          "title": "Create triggers",
          "body": "On the Triggers tab wire time-based and data-change triggers — real Azure Monitor scheduled-query rules over the bound data — so the agent runs hands-off."
        },
        {
          "title": "Review proposals",
          "body": "The Proposals tab is human-in-the-loop: the agent drafts operational actions and you approve or reject each one before anything executes."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-services/agents/overview"
    } },
  // ── Palantir-class migration surfaces (audit-T29 / deep T50-T57) ──
  // Doc-only mappings in docs/migrations/palantir-foundry/ are superseded here
  // by built Azure-native item types. All default Azure-native (no Fabric / no
  // Power BI workspace) per .claude/rules/no-fabric-dependency.md.
  { slug: 'workshop-app', displayName: 'Workshop app', restType: 'WorkshopApp', category: 'Fabric IQ', preview: true,
    description: 'Operational low-code app bound to an Ontology — object views, link traversal, and write-back actions.',
    learnContent: {
      "overview": "Workshop is Palantir Foundry's low-code operational application builder. The CSA Loom equivalent (Atelier) binds an app to a Loom Ontology rather than to a database: pages render object views over the ontology's entity types, and actions write back to the bound Lakehouse/Warehouse. Azure-native — it runs on Azure Container Apps over the ontology's existing data bindings; no Microsoft Fabric workspace required.",
      "steps": [
        { "title": "Bind an ontology", "body": "Pick a saved Ontology in this workspace; its entity types become the app's object views." },
        { "title": "Add object views", "body": "Choose which entity types to surface as pages and which properties to show." },
        { "title": "Wire write-back actions", "body": "Define actions (create / update) that write back through the ontology's bound Lakehouse / Warehouse." },
        { "title": "Run an action", "body": "Test an action; Loom records a Thread edge from the app to the ontology so lineage stays accurate." }
      ],
      "docsUrl": "https://learn.microsoft.com/power-apps/maker/canvas-apps/getting-started"
    } },
  { slug: 'slate-app', displayName: 'Slate app', restType: 'SlateApp', category: 'Fabric IQ', preview: true,
    templateOf: 'workshop-app', templateId: 'slate-workshop-app',
    description: 'Backed template — scaffolds a real Workshop app + Data API (data-api-builder) stack over a query surface. Azure-native; deploys to Azure Static Web Apps. No Fabric.',
    learnContent: {
      "overview": "Slate is Palantir Foundry's pixel-perfect custom application builder. The CSA Loom equivalent is now a BACKED template: instead of only generating a copy-to-repo bundle, picking it INSTANTIATES two real, editable Loom items — a data-api-builder item (the query surface; Microsoft Data API Builder on Azure Container Apps, publishing REST/GraphQL through APIM) and a workshop-app item (the runnable low-code app) — and wires them together so the Workshop app is bound to the real Data API on first open. Azure-native: no Fabric workspace required. You can still emit a deployable Azure Static Web Apps bundle (HTML/JS) for the web tier when you want to ship the app outside Loom.",
      "steps": [
        { "title": "Pick workspace + name", "body": "Choose the target Loom workspace and a name for the app stack." },
        { "title": "Instantiate the stack", "body": "Loom creates a real data-api-builder item (the query surface) and a real workshop-app item, then wires the Workshop app's data binding to the Data API — both are fully editable, runnable Loom items, not stubs or a copied bundle." },
        { "title": "Author queries + widgets", "body": "Define queries (REST / KQL / SQL over Azure-native backends) and place widgets on the drag-resize canvas, previewing them bound to real data." },
        { "title": "Wire variables + interactions", "body": "Declare app variables and reference them anywhere with {{name}} interpolation, then wire widget interactions — click / row-select / load triggers firing effects like set a variable, refresh queries, navigate, or write back — executed live in Preview." },
        { "title": "Publish to Static Web Apps", "body": "Use the in-editor Publish action to provision a real Azure Static Web App and deploy the generated bundle one-click (versions are tracked); you can still download the index.html + app.js + staticwebapp.config.json bundle to ship it yourself." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/static-web-apps/overview"
    } },
  { slug: 'ontology-sdk', displayName: 'Ontology SDK', restType: 'OntologySdk', category: 'Fabric IQ', preview: true,
    description: 'Typed TypeScript / Python SDK + REST Data API generated over an Ontology’s object, link, and action types.',
    learnContent: {
      "overview": "Palantir's OSDK (Ontology SDK) generates a typed client over ontology objects, links, and actions. The CSA Loom equivalent points Microsoft Data API Builder (DAB) at an ontology's bound data source and generates a typed TS/Python client from the ontology's parsed entity types. Azure-native: DAB runs on Azure Container Apps and the REST/GraphQL endpoint publishes through APIM — no Fabric workspace required.",
      "steps": [
        { "title": "Bind an ontology", "body": "Pick a saved Ontology; its entity types + bound Lakehouse/Warehouse define the SDK surface." },
        { "title": "Generate the SDK", "body": "Loom emits real typed TypeScript and Python client source from the ontology's object / link / action types." },
        { "title": "Review the Data API", "body": "Inspect the generated DAB entity config (REST + GraphQL) that backs the SDK." },
        { "title": "Try it live", "body": "Use the Try it API Explorer to run real REST (OData) and GraphQL requests against the DAB runtime serving this ontology and inspect live rows before shipping the client." },
        { "title": "Publish", "body": "Publish the Data API through APIM so apps (incl. Slate) can call the typed endpoints." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-api-builder/overview"
    } },
  { slug: 'release-environment', displayName: 'Release environment', restType: 'ReleaseEnvironment', category: 'Fabric IQ', preview: true,
    description: 'Promotion / release orchestration across workspaces — Azure Deployment Environments + ARM deployment history.',
    learnContent: {
      "overview": "Palantir Apollo orchestrates promotion of artifacts across environments. The CSA Loom equivalent (Shuttle) models dev → test → prod stages over Loom workspaces, surfaces real Azure Resource Manager deployment history, and — when a DevCenter project is configured — provisions catalog-driven Azure Deployment Environments. Azure-native: it builds on the existing deployment-pipelines ARM + git backend; no Fabric required.",
      "steps": [
        { "title": "Define stages", "body": "Add the promotion stages (e.g. dev, test, prod) and map each to a Loom workspace." },
        { "title": "Review ARM history", "body": "See the real Azure Resource Manager deployments across the Loom resource groups for each stage." },
        { "title": "Configure environments", "body": "When LOOM_DEVCENTER_PROJECT is set, pick a catalog environment definition (Bicep) to provision per stage." },
        { "title": "Promote", "body": "Record a promotion between two stages; Loom tracks the promotion and the environment it targeted." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/deployment-environments/overview-what-is-azure-deployment-environments"
    } },
  { slug: 'health-check', displayName: 'Health check', restType: 'HealthCheck', category: 'Fabric IQ', preview: true,
    description: 'Data-freshness / SLA monitoring with real Azure Monitor scheduled-query alert rules.',
    learnContent: {
      "overview": "Palantir Foundry Health Checks watch pipelines and datasets for freshness and SLA breaches. The CSA Loom equivalent creates real Azure Monitor scheduled-query alert rules (scheduledQueryRules) over Log Analytics that fire when an item's data goes stale or a row-count / freshness threshold is crossed. Azure-native default (Fabric Reflex is opt-in via LOOM_ACTIVATOR_BACKEND=fabric) — no Fabric required.",
      "steps": [
        { "title": "Pick a check type", "body": "Browse the check-type gallery — 21 typed checks across the Time & freshness, Size & volume, Content & values, Schema, and Status & custom families (freshness, max age, row count, volume drop, nulls, duplicates, allowed values, column presence/type, heartbeat, custom KQL, and more)." },
        { "title": "Fill the typed wizard", "body": "Each check type opens a structured wizard (table, column, operator, threshold — no freeform JSON) with a live KQL preview of the exact condition; Run live sample executes it against the workspace before you commit." },
        { "title": "Set the schedule", "body": "Choose how often the rule evaluates and the lookback window (e.g. evaluate every 5 minutes over 15 minutes)." },
        { "title": "Wire notifications", "body": "The Notifications tab manages Azure Monitor action groups (email, SMS, webhook receivers) with a real test-fire so you can verify delivery." },
        { "title": "Create the rule", "body": "Loom creates the scheduledQueryRule on Azure Monitor, or shows exactly which env var / RBAC grant is missing." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#log-alerts"
    } },
  { slug: 'aip-logic', displayName: 'Spindle (AIP Logic & agents)', restType: 'AipLogic', category: 'Fabric IQ', preview: true,
    description: 'Spindle Studio — author typed AI logic AND tool-calling agents over the Weave ontology: typed input → ordered steps → typed output, grounded on the ontology, runnable on Azure OpenAI / Foundry.',
    learnContent: {
      "overview": "Palantir AIP Logic builds no-code typed LLM functions; Palantir AIP runs agents + logic over the ontology. The CSA Loom equivalent — Spindle Studio — covers both. Author the typed input schema and ordered steps with dropdowns (no freeform JSON), bind a Weave ontology so the function grounds on its entity types and Lakehouse/Warehouse data bindings, then invoke it as typed logic (one grounded turn) or as a multi-step tool-calling agent. The agent runtime reuses the production copilot orchestrator with the full Loom data-tool registry; the logic runtime writes real T-SQL/Spark-SQL that runs read-only on Synapse and cites real rows. You can also publish the logic as a real Azure AI Foundry Agent Service agent and inspect its run steps. Azure-native default — no Fabric required; honest gates name the AOAI env var (no model deployed) and the Foundry env vars (Agent Service unconfigured, e.g. in Azure Government).",
      "steps": [
        { "title": "Define typed inputs", "body": "Add named input parameters with types (string / number / boolean) using the field builder." },
        { "title": "Ground on the Weave", "body": "Bind a Weave ontology so Spindle runs against its entity types and Lakehouse/Warehouse data bindings (real Synapse queries)." },
        { "title": "Add ordered steps", "body": "Add LLM-prompt, extract, or branch steps from a dropdown — no freeform JSON." },
        { "title": "Define the output", "body": "Set the typed output shape the function returns." },
        { "title": "Invoke (logic or agent)", "body": "Toggle Logic (single grounded turn) or Agent (multi-step tool-calling). Both run against the live Azure OpenAI deployment; the agent returns a per-step run trace, or an honest remediation gate." },
        { "title": "Publish as a Foundry agent", "body": "Deploy the logic to Azure AI Foundry Agent Service, then run + inspect its steps — or use the Azure-native Invoke path where Agent Service is unsupported (Azure Gov)." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-services/openai/overview"
    } },
];

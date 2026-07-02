import type { FabricItemType } from './types';

/**
 * Power Platform — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const powerPlatformItems: FabricItemType[] = [
  // --- v3 — Power Platform (Environments, Dataverse, Power Apps, Power Automate, Power Pages, AI Builder) ---
  { slug: 'powerplatform-environment',   displayName: 'Power Platform environment',  restType: 'PowerPlatformEnvironment',  category: 'Power Platform',
    description: 'Power Platform environment surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, DLP summary.',
    learnContent: {
      "overview": "A Power Platform environment is surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, and DLP summary. In Loom it is read live via /api/powerplatform/environments. Each prod/dev/UAT gets its own environment.",
      "steps": [
        {
          "title": "List environments",
          "body": "The editor reads environments live from the BAP admin API."
        },
        {
          "title": "Inspect details",
          "body": "Review SKU, region, Dataverse domain, and security group."
        },
        {
          "title": "Check DLP",
          "body": "Read the DLP policy summary that governs connectors in the environment."
        },
        {
          "title": "Use as a scope",
          "body": "Pick an environment to scope Dataverse tables, apps, flows, and agents."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-platform/admin/environments-overview"
    } },
  { slug: 'dataverse-table',             displayName: 'Dataverse table',             restType: 'DataverseTable',            category: 'Power Platform',
    description: 'Dataverse EntityDefinition — schema, attributes, primary keys, custom vs system. Sourced from Dataverse Web API v9.2.',
    learnContent: {
      "overview": "A Dataverse table is an EntityDefinition — schema, attributes, primary keys, custom vs system — sourced from the Dataverse Web API v9.2. In Loom you pick an environment first, which drives the Dataverse base URL, then browse tables.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment; that sets the Dataverse base URL on the server."
        },
        {
          "title": "List tables",
          "body": "Browse EntityDefinitions, filtering custom vs system."
        },
        {
          "title": "Inspect attributes",
          "body": "Open a table to see its attributes and primary keys."
        },
        {
          "title": "Use downstream",
          "body": "Reference the table from apps, flows, and agents in the same environment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-intro"
    } },
  { slug: 'power-app',                   displayName: 'Power App',                   restType: 'PowerApp',                  category: 'Power Platform',
    description: 'Canvas or model-driven Power App in an environment — owner, last modified, play link. Sourced from the PowerApps admin API.',
    learnContent: {
      "overview": "A Power App is a canvas or model-driven app in an environment — owner, last modified, play link. In Loom it is sourced from the PowerApps admin API after you pick an environment.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list apps from."
        },
        {
          "title": "List apps",
          "body": "Browse canvas and model-driven apps with owner and last-modified."
        },
        {
          "title": "Open or play",
          "body": "Use the play link to launch the app."
        },
        {
          "title": "Track ownership",
          "body": "Use owner metadata to manage app lifecycle across the environment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-apps/powerapps-overview"
    } },
  { slug: 'power-automate-flow',         displayName: 'Power Automate flow',         restType: 'PowerAutomateFlow',         category: 'Power Platform',
    description: 'Cloud flow in Power Automate — state, trigger, run history, manual run. Sourced from the Flow admin API.',
    learnContent: {
      "overview": "A Power Automate flow is a cloud flow — state, trigger, run history, and manual run. In Loom it is sourced from the Flow admin API; you can list flows, inspect runs, and trigger a manual run.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list flows from."
        },
        {
          "title": "Inspect a flow",
          "body": "Review its state and trigger."
        },
        {
          "title": "Run manually",
          "body": "Trigger a manual run via /run and watch the result."
        },
        {
          "title": "Review run history",
          "body": "Read real run records from /runs to confirm success or diagnose failures."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-automate/getting-started"
    } },
  { slug: 'power-page',                  displayName: 'Power Pages site',            restType: 'PowerPagesSite',            category: 'Power Platform',
    description: 'Power Pages website (mspp_website / adx_website) — domain, status, type. Sourced from Dataverse Web API.',
    learnContent: {
      "overview": "A Power Pages site (mspp_website / adx_website) is a low-code public-facing website over Dataverse — domain, status, type. In Loom it is sourced from the Dataverse Web API.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment that hosts the site."
        },
        {
          "title": "List sites",
          "body": "Browse Power Pages sites with domain, status, and type."
        },
        {
          "title": "Inspect a site",
          "body": "Open a site to review its configuration."
        },
        {
          "title": "Manage access",
          "body": "Use Dataverse roles and web roles to govern who sees which pages."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-pages/introduction"
    } },
  { slug: 'ai-builder-model',            displayName: 'AI Builder model',            restType: 'AiBuilderModel',            category: 'Power Platform',
    description: 'AI Builder model (msdyn_aimodel) — prediction / extraction / classification / form-processing. State + status from Dataverse.',
    learnContent: {
      "overview": "An AI Builder model (msdyn_aimodel) is prediction, extraction, classification, or form-processing — with state and status from Dataverse. In Loom it is sourced from the Dataverse Web API after you pick an environment.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list models from."
        },
        {
          "title": "List models",
          "body": "Browse AI Builder models with their state and status."
        },
        {
          "title": "Inspect a model",
          "body": "Open a model to see its type (prediction, extraction, classification, form-processing)."
        },
        {
          "title": "Use in Power Platform",
          "body": "Call trained models from Power Apps and Power Automate."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/ai-builder/overview"
    } },
];

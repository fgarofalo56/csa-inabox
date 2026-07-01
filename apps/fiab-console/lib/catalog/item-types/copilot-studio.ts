import type { FabricItemType } from './types';

/**
 * Copilot Studio — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const copilotStudioItems: FabricItemType[] = [
  // --- v3 — Copilot Studio (Power Platform / Dataverse-backed agents) ---
  { slug: 'copilot-studio-agent',        displayName: 'Copilot Studio agent',        restType: 'CopilotStudioAgent',        category: 'Copilot Studio',
    description: 'Conversational agent stored in Power Platform Dataverse. Instructions, knowledge, topics, actions, channels — native in Loom.',
    learnContent: {
      "overview": "A Copilot Studio agent is a conversational agent stored in Power Platform Dataverse — instructions, knowledge, topics, actions, channels. In Loom it is wired live to Power Platform (BAP) and Dataverse via the BFF; tenant-gate errors surface as a MessageBar.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the Power Platform environment; that drives the Dataverse base URL."
        },
        {
          "title": "Create or open an agent",
          "body": "List, create, or open an agent and set its instructions."
        },
        {
          "title": "Add knowledge and topics",
          "body": "Attach knowledge sources for factual answers and topics for deterministic flows."
        },
        {
          "title": "Publish",
          "body": "Publish the agent so changes go live across its channels."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio"
    } },
  { slug: 'copilot-studio-knowledge',    displayName: 'Copilot knowledge source',    restType: 'CopilotKnowledgeSource',    category: 'Copilot Studio', hiddenFromGallery: true,
    description: 'Grounding source for an agent — URL, file, SharePoint site, or Dataverse table.',
    learnContent: {
      "overview": "A Copilot knowledge source grounds an agent — URL, file, SharePoint site, or Dataverse table. In Loom you pick an agent, then list and add sources via the Dataverse-backed BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent whose grounding you want to manage."
        },
        {
          "title": "Add a source",
          "body": "Add a URL, file, SharePoint site, or Dataverse table as a knowledge source."
        },
        {
          "title": "Verify grounding",
          "body": "Ask the agent factual questions to confirm it uses the source."
        },
        {
          "title": "Manage sources",
          "body": "Add or remove sources as the agent's scope changes."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/nlu-generative-answers"
    } },
  { slug: 'copilot-studio-topic',        displayName: 'Copilot topic',               restType: 'CopilotTopic',              category: 'Copilot Studio', hiddenFromGallery: true,
    description: 'Trigger-phrase-driven dialog flow authored in Copilot Studio YAML.',
    learnContent: {
      "overview": "A Copilot topic is a trigger-phrase-driven dialog flow authored in Copilot Studio YAML. In Loom you pick an agent, list topics, and edit trigger phrases plus the flow YAML via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent that owns the topics."
        },
        {
          "title": "Add trigger phrases",
          "body": "Define the phrases that route a user into this topic."
        },
        {
          "title": "Author the flow",
          "body": "Edit the dialog flow YAML for the deterministic conversation path."
        },
        {
          "title": "Test the path",
          "body": "Try the trigger phrases to confirm the topic activates correctly."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics"
    } },
  { slug: 'copilot-studio-action',       displayName: 'Copilot action',              restType: 'CopilotAction',             category: 'Copilot Studio', hiddenFromGallery: true,
    description: 'Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent.',
    learnContent: {
      "overview": "A Copilot action is a Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent. In Loom you pick an agent and manage its action list via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent to wire actions onto."
        },
        {
          "title": "Add an action",
          "body": "Bind a Power Automate flow, custom connector, or prebuilt action."
        },
        {
          "title": "Map inputs",
          "body": "Map the agent's collected inputs to the action's parameters."
        },
        {
          "title": "Test the write",
          "body": "Trigger the action from the agent to verify the write operation."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/authoring-actions"
    } },
  { slug: 'copilot-studio-channel',      displayName: 'Copilot channel',             restType: 'CopilotChannel',            category: 'Copilot Studio', hiddenFromGallery: true,
    description: 'Publish an agent to Teams, Web chat, Direct Line, Slack, or a custom channel.',
    learnContent: {
      "overview": "A Copilot channel publishes an agent to Teams, web chat, Direct Line, Slack, or a custom channel. In Loom you pick an agent and publish-to-channel via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent to publish."
        },
        {
          "title": "Choose a channel",
          "body": "Pick Teams, web chat, Direct Line, Slack, or a custom channel."
        },
        {
          "title": "Publish",
          "body": "Publish-to-channel makes the agent reachable on that surface."
        },
        {
          "title": "Share the link",
          "body": "Distribute the channel link or embed code to users."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels"
    } },
  { slug: 'copilot-studio-analytics',    displayName: 'Copilot analytics',           restType: 'CopilotAnalytics',          category: 'Copilot Studio', hiddenFromGallery: true,
    description: 'Sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default).',
    learnContent: {
      "overview": "Copilot analytics shows sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default). In Loom you pick an agent and view KPI cards sourced via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent whose analytics to view."
        },
        {
          "title": "Set the window",
          "body": "Default is the last 30 days; adjust as needed."
        },
        {
          "title": "Read KPI cards",
          "body": "Review sessions, resolution rate, escalation rate, and CSAT."
        },
        {
          "title": "Act on trends",
          "body": "Use weak topics or high escalation to target authoring improvements."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview"
    } },
  { slug: 'copilot-template-library',    displayName: 'Copilot template library',    restType: 'CopilotTemplateLibrary',    category: 'Copilot Studio',
    description: 'CSA-curated agent templates: data steward, contract analyzer, RFP responder, etc.',
    learnContent: {
      "overview": "The Copilot template library is a CSA-curated gallery of agent templates — data steward, contract analyzer, RFP responder, and more. In Loom templates are Cosmos-backed and Use template creates an agent in the selected environment.",
      "steps": [
        {
          "title": "Browse templates",
          "body": "Scan the CSA-curated gallery for a fitting starting point."
        },
        {
          "title": "Pick an environment",
          "body": "Choose the Power Platform environment the new agent should live in."
        },
        {
          "title": "Use template",
          "body": "Use template creates an agent from the template in that environment."
        },
        {
          "title": "Customize",
          "body": "Open the new agent and adapt its instructions, knowledge, and actions."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/template-fundamentals"
    } },
];

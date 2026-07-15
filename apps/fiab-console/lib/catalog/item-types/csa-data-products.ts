import type { FabricItemType } from './types';

/**
 * CSA Data Products — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const csaDataProductsItems: FabricItemType[] = [
  { slug: 'data-product',                displayName: 'Data product',                restType: 'DataProduct',               category: 'CSA Data Products',
    description: 'The governed, contract-bound unit consumers discover and subscribe to: dataset + semantic contract + access policy + owner. The one data-product creation path.',
    learnContent: {
      "overview": "A Data product is the governed, contract-bound unit consumers discover and subscribe to in the marketplace — a dataset plus its semantic contract, an access policy, and an owner. This is the ONE creation path: a template is a starting shape that stamps out a data product, and an instance is the deployed infra bundle a template produced; neither is the governed mesh entity that a Data product is. In Loom the Publish control POSTs a real product as an idempotent upsert.",
      "steps": [
        {
          "title": "Define the contract",
          "body": "Describe the dataset, its semantic contract, owner, and SLA."
        },
        {
          "title": "Set the access policy",
          "body": "Define who can subscribe and under what terms."
        },
        {
          "title": "Publish to APIM",
          "body": "Publish-to-APIM POSTs a real APIM product (idempotent upsert) fronting the data product."
        },
        {
          "title": "List in the marketplace",
          "body": "The product surfaces in the Purview / Loom catalog and the API marketplace for discovery."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
  // --- v3 — Push-button data-products library (CSA-curated templates + instances) ---
  { slug: 'data-marketplace',            displayName: 'Data marketplace',            restType: 'DataMarketplace',           category: 'CSA Data Products', coreSurface: true,
    description: 'Consumer discovery hub for Published data products — faceted search, governance-domain card grid, and access requests. Backed by Azure AI Search. Now a core surface under the unified Loom Marketplace (/marketplace).',
    learnContent: {
      "overview": "The Data marketplace is the consumer-facing discovery surface for the tenant's Published data products (F14/F18). It searches a dedicated Azure AI Search index (loom-data-products) that mirrors every Published data-product item, with faceted navigation over governance domain, type, owner, glossary terms, and critical data elements (CDEs). It is Azure-native — no Microsoft Fabric or Power BI dependency.",
      "steps": [
        {
          "title": "Discover",
          "body": "Search the live index. Wrap a term in double quotes for an exact-phrase match. Use the left facet panel to filter by domain, type, owner, glossary term, or CDE. Only Published products in your tenant appear."
        },
        {
          "title": "Explore by domain",
          "body": "The Domains tab shows a card per governance domain with a live product count from the index facet aggregate. Click a card to filter Discover to that domain."
        },
        {
          "title": "Publish",
          "body": "Producers create a data product (workspace, name, domain, type, owner, glossary terms, CDEs, SLA) and set it Published to make it visible to consumers. Draft and Deprecated products are hidden from consumer search."
        },
        {
          "title": "Request & track access",
          "body": "Request access from any result; the request is recorded durably. The My data access tab lists your requests and their status — owners grant access in Governance → Policies (real Azure RBAC)."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
  { slug: 'data-product-template',       displayName: 'Data product template',       restType: 'DataProductTemplate',       category: 'CSA Data Products', hiddenFromGallery: true,
    description: 'A starting shape that stamps out a Data product plus its backing infra (medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial). Browse it from "Start from a template", not as a separate item.',
    learnContent: {
      "overview": "A Data product template is a CSA-curated starting shape — medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial — that stamps out a governed Data product plus its backing infra. It is NOT a persisted item you create on its own: browse the template gallery, then Instantiate to spawn the underlying items and their parent Data product. To govern the result, open the Data product it produced. In Loom Instantiate POSTs to /api/items/data-product-template/[slug]/instantiate.",
      "steps": [
        {
          "title": "Browse the gallery",
          "body": "Templates render as a grid of CSA-curated patterns."
        },
        {
          "title": "Open a template",
          "body": "Click to see its components and estimated cost."
        },
        {
          "title": "Instantiate",
          "body": "Instantiate POSTs to the instantiate route, spawning the bundled items in your workspace."
        },
        {
          "title": "Manage the instance",
          "body": "Track the resulting data-product instance for status and health."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
  { slug: 'data-product-instance',       displayName: 'Data product instance',       restType: 'DataProductInstance',       category: 'CSA Data Products', hiddenFromGallery: true,
    description: 'The deployed infra bundle a template produced (pipelines, lakehouses, indexes). Born only from a template Instantiate — open its parent Data product to govern it.',
    learnContent: {
      "overview": "A Data product instance is the deployed infra bundle a template produced — the underlying items (pipelines, lakehouses, indexes) wired together in a workspace. It is never created directly: it is born only from a Data product template's Instantiate action, and it links back to the governed Data product you open to govern it. In Loom it shows the spawned components and a status table; health is best-effort from child items' updatedAt.",
      "steps": [
        {
          "title": "Review components",
          "body": "See the items spawned for this instance and their bindings."
        },
        {
          "title": "Check status",
          "body": "The status table summarizes each component's state."
        },
        {
          "title": "Read health",
          "body": "Health is best-effort, peeking at child items' updatedAt to flag staleness."
        },
        {
          "title": "Open a component",
          "body": "Drill into any underlying item (pipeline, lakehouse, index) to operate it."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
  // W10 — Data contract as a standalone, reusable item type: an output-port
  // schema + quantified SLAs + data-quality expectations, authored in a typed
  // designer (no free-typed JSON). Bind it to a data product to enforce
  // BR-CONTRACT-GATE at publish time. Azure-native (ADX quality checks), no
  // Fabric dependency.
  { slug: 'data-contract', displayName: 'Data contract', restType: 'DataContract', category: 'CSA Data Products',
    description: 'A formal, machine-checkable agreement a data product makes to consumers: output-port schema (typed columns + PII classification), quantified SLAs (freshness / availability / latency / retention), and data-quality expectations. Bind it to a data product to block publish when validation fails. Azure-native — no Fabric dependency.',
    learnContent: {
      "overview": "A Data contract is the formal, machine-checkable agreement a data product publishes to its consumers — the data-mesh / ODCS 'data contract' concept as a first-class Loom item. It captures an output-port SCHEMA (typed columns with semantics and PII classification), quantified SERVICE-LEVEL OBJECTIVES (freshness, availability, latency, completeness, retention, support response), and a set of data-quality EXPECTATIONS (not-null / unique / primary-key / accepted-values / range / regex / freshness / row-count) the product commits to. Everything is authored in a typed designer — never free-typed JSON. Bind a contract to a data product and its error-severity expectations are ENFORCED at publish time (BR-CONTRACT-GATE): if they fail against the bound Azure Data Explorer table, the publish is blocked. Azure-native — no Microsoft Fabric / Power BI dependency.",
      "steps": [
        {
          "title": "Define the output schema",
          "body": "List the columns the product guarantees — name, type, description, PII/PHI classification, nullability, and keys."
        },
        {
          "title": "Set the SLAs",
          "body": "Pick the freshness cadence, availability target, latency, completeness, retention, and support-response commitments."
        },
        {
          "title": "Add quality expectations",
          "body": "Add checks the product enforces (a not-null key, an accepted-values set, a range, a freshness window …), each bound to a column or the whole table, at error or warning severity."
        },
        {
          "title": "Validate + bind + enforce",
          "body": "Bind an ADX table and run the expectations to see the live pass/fail. Bind the contract to a data product; its error-severity expectations then block that product's publish if they fail (BR-CONTRACT-GATE)."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
];

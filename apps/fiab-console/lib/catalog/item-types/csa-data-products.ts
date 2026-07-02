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
    description: 'Data-mesh-aligned package: dataset + semantic contract + APIM API + access policy + owner. Listed in the marketplace.',
    learnContent: {
      "overview": "A Data product is a data-mesh-aligned package — dataset plus semantic contract, an APIM API, an access policy, and an owner — listed in the marketplace. In Loom the Publish-to-APIM button POSTs a real product as an idempotent upsert.",
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
  { slug: 'data-product-template',       displayName: 'Data product template',       restType: 'DataProductTemplate',       category: 'CSA Data Products',
    description: 'CSA-curated push-button template: medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial.',
    learnContent: {
      "overview": "A Data product template is a CSA-curated push-button bundle — medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial. In Loom Instantiate POSTs to /api/items/data-product-template/[slug]/instantiate to spawn the underlying items.",
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
  { slug: 'data-product-instance',       displayName: 'Data product instance',       restType: 'DataProductInstance',       category: 'CSA Data Products',
    description: 'Instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes).',
    learnContent: {
      "overview": "A Data product instance is an instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes). In Loom it shows the spawned components and a status table; health is best-effort from child items' updatedAt.",
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
];

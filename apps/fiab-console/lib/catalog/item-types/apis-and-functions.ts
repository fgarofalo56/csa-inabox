import type { FabricItemType } from './types';

/**
 * APIs and functions — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const apisAndFunctionsItems: FabricItemType[] = [
  // APIs and functions
  { slug: 'data-api-builder', displayName: 'Data API', restType: 'DataApi', category: 'APIs and functions',
    description: 'Data API builder — expose Azure SQL / PostgreSQL / Cosmos tables as secured REST + GraphQL.',
    learnContent: {
      "overview": "Data API builder (DAB) generates secured REST and GraphQL endpoints over a relational or Cosmos source from a single dab-config.json. In Loom the editor introspects the database schema, maps tables/views/SPs to entities with per-role permissions, relationships, and policies, emits the canonical dab-config.json, and (when a DAB runtime Container App is deployed) tests the live REST + GraphQL endpoints and publishes through APIM.",
      "steps": [
        { "title": "Pick a data source", "body": "Choose Azure SQL / PostgreSQL / Cosmos and the connection — the connection string is referenced via @env(), never stored as a literal." },
        { "title": "Add entities", "body": "Introspect the schema and map tables/views to entities with REST paths, GraphQL types, and field aliases." },
        { "title": "Secure with permissions", "body": "Grant per-role create/read/update/delete with field-level include/exclude and database policies." },
        { "title": "Preview and publish", "body": "Validate the config, test the live REST + GraphQL endpoints, then publish the API through API Management." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-api-builder/overview"
    } },
  { slug: 'graphql-api', displayName: 'API for GraphQL', restType: 'GraphQLApi', category: 'APIs and functions', hiddenFromGallery: true,
    description: 'Single GraphQL endpoint over Warehouse / Lakehouse / SQL DB / mirrored DBs.',
    learnContent: {
      "overview": "An API for GraphQL exposes a single GraphQL endpoint over Warehouse, Lakehouse, SQL DB, or mirrored databases. In Loom it auto-generates CRUD plus custom resolvers. Use it to give app developers one typed endpoint over your data.",
      "steps": [
        {
          "title": "Pick a data source",
          "body": "Point the API at a Warehouse, Lakehouse SQL endpoint, SQL DB, or mirrored database."
        },
        {
          "title": "Expose types",
          "body": "Select tables/views to expose; CRUD operations are auto-generated as a schema."
        },
        {
          "title": "Test in the explorer",
          "body": "Run queries and mutations against the endpoint to validate the schema."
        },
        {
          "title": "Secure access",
          "body": "Front the endpoint through APIM for auth, rate limiting, and observability."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/api-graphql-overview"
    } },
  { slug: 'user-data-function', displayName: 'User data function', restType: 'UserDataFunction', category: 'APIs and functions',
    description: 'Python functions (Azure Functions) with bindings to Azure data sources and external connections.',
    learnContent: {
      "overview": "A User data function is Python (or C#) server-side compute — Azure-native on Azure Functions — with bindings to Loom items and external connections, callable from notebooks, pipelines, and reports. In Loom it runs serverless with per-call billing; no Microsoft Fabric required.",
      "steps": [
        {
          "title": "Write the function",
          "body": "Author a Python function with input/output bindings to Loom items (lakehouses, warehouses, SQL) via Azure Functions bindings."
        },
        {
          "title": "Add connections",
          "body": "Bind external connections the function needs (databases, APIs)."
        },
        {
          "title": "Test invoke",
          "body": "Run the function with sample inputs to validate behavior."
        },
        {
          "title": "Call from items",
          "body": "Invoke it from notebooks, pipelines, or reports; billing is serverless per call."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/user-data-functions/user-data-functions-overview"
    } },
  { slug: 'variable-library', displayName: 'Variable library', restType: 'VariableLibrary', category: 'APIs and functions',
    description: 'Centralized variables with value sets per environment (dev / test / prod).',
    learnContent: {
      "overview": "A Variable library is a centralized name-to-value store with value sets per environment (dev/test/prod). In Loom it is workspace- or domain-scoped and used for pipeline, notebook, and SQL parameter substitution.",
      "steps": [
        {
          "title": "Define variables",
          "body": "Add named variables with a default value."
        },
        {
          "title": "Add value sets",
          "body": "Create per-environment value sets (dev/test/prod) that override defaults."
        },
        {
          "title": "Reference from items",
          "body": "Use variables in pipelines, notebooks, and SQL via parameter substitution."
        },
        {
          "title": "Promote across stages",
          "body": "Switch the active value set when deploying between environments."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview"
    } },
  // --- API-first surfacing: APIM is the runtime glue for every Loom-managed function, ML endpoint, and data product ---
  { slug: 'apim-api',                    displayName: 'APIM API',                    restType: 'ApimApi',                   category: 'APIs and functions',
    description: 'A versioned API on Azure API Management. Auto-imports OpenAPI / GraphQL / WSDL; ties to Loom items as backends.',
    learnContent: {
      "overview": "An APIM API is a versioned API on Azure API Management that auto-imports OpenAPI/GraphQL/WSDL and ties Loom items as backends. In Loom it is wired live to the deployed APIM instance; Save issues a real PUT.",
      "steps": [
        {
          "title": "Load or import",
          "body": "Load existing operations and spec, or import an OpenAPI spec to bootstrap operations."
        },
        {
          "title": "Edit API settings",
          "body": "Set display name, path, protocols, and whether a subscription is required; Save PUTs to APIM."
        },
        {
          "title": "Attach to products",
          "body": "Add the API to one or more products to control subscription and visibility."
        },
        {
          "title": "Add policies",
          "body": "Apply auth, throttling, or transformation policies at API or operation scope."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-key-concepts"
    } },
  { slug: 'apim-product',                displayName: 'APIM product',                restType: 'ApimProduct',               category: 'APIs and functions',
    description: 'Bundles APIs into a subscribable offering: rate limits, quotas, terms, publisher portal landing.',
    learnContent: {
      "overview": "An APIM product bundles APIs into a subscribable offering with rate limits, quotas, terms, and a publisher-portal landing. In Loom it is wired live to the deployed APIM; Save issues a real PUT.",
      "steps": [
        {
          "title": "Load the product",
          "body": "Open the product to edit its display name, description, and state."
        },
        {
          "title": "Set subscription rules",
          "body": "Configure whether subscription and approval are required and any quotas."
        },
        {
          "title": "Add APIs",
          "body": "Bundle one or more APIs into the product as a unit consumers subscribe to."
        },
        {
          "title": "Save",
          "body": "Save PUTs the product to APIM so it appears in the publisher portal."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-howto-add-products"
    } },
  { slug: 'apim-policy',                 displayName: 'APIM policy',                 restType: 'ApimPolicy',                category: 'APIs and functions',
    description: 'Inbound / backend / outbound / on-error XML policy: JWT validation, rate-limit, cache, transform, mock.',
    learnContent: {
      "overview": "An APIM policy is inbound/backend/outbound/on-error XML applied at a scope — JWT validation, rate-limit, cache, transform, mock. In Loom you load the policy XML for a scope, it validates well-formed XML client-side, and Save issues a real PUT.",
      "steps": [
        {
          "title": "Pick a scope",
          "body": "Choose the global, product, API, or operation scope whose policy you want to edit."
        },
        {
          "title": "Edit the XML",
          "body": "Author inbound/backend/outbound/on-error sections; the editor checks the XML is well-formed."
        },
        {
          "title": "Add common policies",
          "body": "Insert JWT validation, rate-limit, cache, transform, or mock policies."
        },
        {
          "title": "Save",
          "body": "Save PUTs the policy to the chosen APIM scope."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-howto-policies"
    } },
];

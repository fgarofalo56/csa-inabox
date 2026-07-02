import type { FabricItemType } from './types';

/**
 * Azure Graph + Vector — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureGraphVectorItems: FabricItemType[] = [
  // --- v3 — Graph + knowledge stores (Cosmos Gremlin, ADX graph, Cypher, GQL, vector stores) ---
  { slug: 'cosmos-gremlin-graph',        displayName: 'Cosmos Gremlin graph',        restType: 'CosmosGremlinGraph',        category: 'Azure Graph + Vector',
    description: 'Cosmos DB for Apache Gremlin — graph traversal queries over property graphs.',
    learnContent: {
      "overview": "A Cosmos Gremlin graph is Cosmos DB for Apache Gremlin — graph traversal over property graphs. In Loom queries run via /api/items/cosmos-gremlin-graph/[id]/query (the gremlin npm client with AAD or account-key auth); a 501 surfaces if the runtime isn't configured.",
      "steps": [
        {
          "title": "Connect the account",
          "body": "The query route uses the gremlin client with AAD or account-key auth against the Cosmos Gremlin account."
        },
        {
          "title": "Write a traversal",
          "body": "Author Gremlin steps (g.V().has(...).out(...)) over your property graph."
        },
        {
          "title": "Run the query",
          "body": "Submit to the real query route; results render in the force-directed graph view."
        },
        {
          "title": "Handle not-configured",
          "body": "If the runtime isn't configured the editor surfaces the 501 deferred message rather than faking data."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/cosmos-db/gremlin/introduction"
    } },
  { slug: 'cypher-graph',                displayName: 'Cypher graph',                restType: 'CypherGraph',               category: 'Azure Graph + Vector', hiddenFromGallery: true,
    description: 'openCypher dialect over Cosmos / Neptune-compatible / ADX graph plugin.',
    learnContent: {
      "overview": "A Cypher graph lets Neo4j-trained engineers use the openCypher dialect; in Loom it is translated to ADX make-graph/graph-match operators and dispatched via the KQL database query route — server-side, no Spark or Gremlin, millisecond-scale up to ~10M edges.",
      "steps": [
        {
          "title": "Load sample data",
          "body": "Run admin Load sample data (kind=graph) once to create SampleSocialGraph in the default Kusto DB."
        },
        {
          "title": "Write Cypher",
          "body": "Author Cypher patterns; (a)-[*1..3]->(b) maps to KQL graph-match (a)-[e*1..3]->(b)."
        },
        {
          "title": "Run via KQL backend",
          "body": "The translator emits make-graph + graph-match and dispatches to the KQL database query route."
        },
        {
          "title": "Use path operators",
          "body": "For shortest path use graph-shortest-paths; results render in the graph view."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators"
    } },
  { slug: 'gql-graph',                   displayName: 'GQL graph',                   restType: 'GqlGraph',                  category: 'Azure Graph + Vector',
    description: 'ISO GQL standard graph query language against the graph backend of record.',
    learnContent: {
      "overview": "A GQL graph uses the ISO/IEC 39075:2024 standard graph query language — vendor-neutral pattern matching. In Loom it is dispatched to the graph backend of record (ADX graph operators via the KQL query route).",
      "steps": [
        {
          "title": "Write GQL patterns",
          "body": "Author standard GQL MATCH patterns against your graph."
        },
        {
          "title": "Dispatch to backend",
          "body": "Loom routes the query to the graph backend of record (ADX graph via the KQL route)."
        },
        {
          "title": "Inspect results",
          "body": "Results render in the force-directed graph view."
        },
        {
          "title": "Know the standard",
          "body": "GQL is the ISO standard; use it when you want engine-neutral graph queries."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators"
    } },
  { slug: 'vector-store',                displayName: 'Vector store',                restType: 'VectorStore',               category: 'Azure Graph + Vector',
    description: 'Vector index — Cosmos vCore, AI Search, or PostgreSQL pgvector. Similarity search + RAG grounding.',
    learnContent: {
      "overview": "A Vector store is a backend-agnostic vector index — Azure AI Search, Cosmos vCore, PostgreSQL pgvector, or Cosmos DB for NoSQL — for similarity search and RAG grounding. In Loom you pick a backend, define an index spec, create the real index, upload documents, and run live k-NN similarity search against the selected Azure backend. AI Search (the default), Cosmos vCore, and pgvector each ship a live create + upload + similarity-search data plane; Cosmos DB for NoSQL (DiskANN) is the one config-only backend and surfaces an honest gate.",
      "steps": [
        {
          "title": "Pick a backend",
          "body": "Choose Azure AI Search (default), Cosmos vCore, pgvector, or Cosmos DB for NoSQL based on existing data gravity. AI Search, Cosmos vCore, and pgvector have a live data plane; Cosmos NoSQL (DiskANN) is config-only and honest-gated."
        },
        {
          "title": "Define the index",
          "body": "Set dimensions, distance metric, and fields in the create-index form."
        },
        {
          "title": "Create the index and search",
          "body": "Create / update index provisions the real vector index on the selected backend; upload documents, then run live k-NN similarity search from the search panel — a real backend call, not a mock. Save also persists the spec to item state."
        },
        {
          "title": "Ground RAG",
          "body": "Use the store for similarity search behind a prompt flow or data agent."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/cosmos-db/vector-database"
    } },
  { slug: 'tapestry',                    displayName: 'Tapestry (investigative graph)', restType: 'Tapestry',           category: 'Azure Graph + Vector', preview: true, labs: true,
    description: 'Investigative link-analysis + geospatial + timeline workspace over the ADX graph (make-graph / graph-match) and Azure Maps. The Azure-native equivalent of a Gotham-class investigation surface — no Microsoft Fabric required.',
    learnContent: {
      "overview": "Tapestry is an investigative analysis workspace that composes three coordinated views over the SAME materialized Node_*/Edge_* ADX tables the graph editors already query: a Link panel (force-directed graph from KQL make-graph + graph-match / graph-shortest-paths / graph-mark-components), a Geo panel (GeoJSON FeatureCollection projected from node lat/lon props, rendered with the keyless SVG GeoJsonMap and an optional live Azure Maps raster basemap when a key is configured), and a Timeline panel (KQL summarize count() by bin(timestamp, window) over Edge_* events). It is 100% Azure-native — the link + timeline engine is ADX (sovereign across every cloud) and the geo panel renders without any subscription. No Fabric capacity or workspace is required.",
      "steps": [
        {
          "title": "Seed an investigative dataset",
          "body": "Run admin Load sample data (kind=investigation) once to materialize Node_Person/Node_Org/Node_Location/Node_Event and Edge_Knows/Edge_LocatedAt/Edge_Attended into the default ADX database — people/orgs/events with timestamps and lat/lon."
        },
        {
          "title": "Run link analysis",
          "body": "On the Link tab, pick an analysis (pattern match, shortest path, or connected components) and a hop depth; the editor builds the make-graph prelude over Node_*/Edge_* and runs graph-match — results render in the force-directed canvas. Click a node to cross-filter the Geo + Timeline panes."
        },
        {
          "title": "Map the entities",
          "body": "The Geo tab projects every located node into a GeoJSON FeatureCollection and renders it; set NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY to layer a live Azure Maps basemap behind the vector overlay (the panel renders regardless)."
        },
        {
          "title": "Analyze the timeline",
          "body": "The Timeline tab bins Edge_* events by a chosen window (hour/day/week) and edge label; results render as a time-series grid so you can see how the relationships evolve over time."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview"
    } },
];

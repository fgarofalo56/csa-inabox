# GraphRAG grounding

> **Surface:** Data-agent editor test chat and published agent turns (`/items/data-agent/<id>`) — the **Graph grounding** toggle
> **Backend:** Apache AGE on the in-VNet Azure Database for PostgreSQL flexible server (the Weave ontology store) + the `loom-graphrag-index` Cosmos container
> **Kill-switch flag:** `n11-graphrag-grounding` (default ON)
> **Honest gate:** `LOOM_WEAVE_PG_FQDN` unset — the turn still runs, just without graph facts

A relational, multi-hop question ("which suppliers feed the parts on the delayed
orders in this region?") cannot be answered by retrieving rows from one table.
GraphRAG grounding makes a data agent retrieve over the **ontology you authored
in Weave** before it plans: it extracts seed entities from the question, walks
the real graph, attaches precomputed community summaries, and layers the
resulting facts and graph-path citations onto the planner and every execute
step.

## Why it exists

Table-only grounding answers lookup questions well and relational questions
badly. The agent either joins blindly or hallucinates a relationship nobody
declared. Loom already has a first-class ontology layer (Weave) where a customer
declares object types, link types and instances. GraphRAG closes the loop: the
thing you modelled becomes the thing the agent retrieves over, and every hop it
took is citable.

It is also the sovereign headline. Apache AGE runs on in-VNet PostgreSQL with
**zero external egress**, and the community summariser is the in-boundary Azure
OpenAI deployment (or a deterministic extractive fallback when no model is
deployed). The whole capability runs disconnected in a GCC-High / IL5 / air-gapped
enclave with no code-path change.

## How to use it end to end

1. **Author an ontology.** Open or create an **Ontology** item and declare your
   object types, their title property, and the link types between them. Load or
   create instances — GraphRAG reads the *real* instances off AGE, never a
   sample set.
2. **Build the GraphRAG index.** In the ontology editor run **Rebuild GraphRAG
   index**. The build reads every declared object type's instances and every
   link instance, detects communities by deterministic label propagation,
   summarises each community, and persists the result to the
   `loom-graphrag-index` Cosmos container partitioned by ontology id. Documents
   from an older build id are pruned, so the index can never drift from the
   graph.
3. **Attach the ontology to a data agent.** In the data-agent editor add the
   ontology (or a graph item bound to it) as a source. The agent picks up the
   declared object type api-names and their title properties.
4. **Check the Graph grounding toggle.** It is on by default; only an explicit
   opt-out turns it off for that agent.
5. **Ask a relational question** in the test chat. On the graph path the loop:
   - matches the question's content tokens against the declared object types and
     the real instances read off AGE;
   - expands breadth-first over the frontier, one Cypher statement per hop, so a
     two-hop retrieval is two round trips rather than N;
   - intersects the touched vertices with the community summaries so the agent
     sees the cluster-level story, not only local edges;
   - hands the planner a grounded context block plus a typed graph-path citation
     per discovered path.
6. **Open the receipt.** The graph paths flow into the
   [answer receipt](answer-receipts.md), so an auditor sees the exact traversal
   that grounded the answer alongside the SQL that was executed.

Default traversal depth is 2 hops. That is a code default, not a required
environment variable — there is nothing to configure for the common case.

## What the backend actually does

| Step | Backend |
|---|---|
| Seed entity match | `listObjects` / instance search over Apache AGE (in-VNet PostgreSQL) |
| Multi-hop traversal | One openCypher statement per hop across the whole frontier |
| Community summaries | `loom-graphrag-index` Cosmos container (PK `/ontologyId`) |
| Summary generation (build) | The standard-tier Azure OpenAI deployment via the shared chat client; falls back to a deterministic extractive summary with `modelGenerated: false` |
| Index rebuild audit | `_auditLog` row (`graphrag.index.build`) plus the SIEM fan-out |

One implementation note worth knowing if you are reading query logs: every
property predicate is applied in **JavaScript after the fetch**, never pushed
into Cypher. AGE's openCypher lacks the map/list machinery a generic property
predicate needs, and a server-side predicate built on it silently matches
nothing. Only `id(n) = <literal>` and label predicates go into Cypher.

## Honest gates

- **Weave / AGE not wired.** When `LOOM_WEAVE_PG_FQDN` is unset the retriever
  returns a gate naming the exact variable and the bicep module
  (`modules/deploy-planner/postgres-flexible.bicep`). The agent turn still runs
  and still executes real queries — it simply has no graph facts. Nothing is
  mocked.
- **No ontology attached.** Graph grounding is skipped silently and the agent
  behaves exactly as it did before this feature existed.
- **No index built yet.** Traversal still works; the community-summary layer is
  simply empty until the first rebuild.

## Kill-switch

`n11-graphrag-grounding` — default ON. Flipping it OFF on **Admin → Runtime
flags** reverts every data agent to table-only grounding on the very next turn.
The ontology, its instances and the GraphRAG index are untouched; they are
simply not consulted. No revision roll is required.

## Related

- [Answer receipts](answer-receipts.md) — where the graph-path citations surface
- [Verified queries and the semantic contract](verified-queries.md) — what runs *before* grounding
- [Self-healing NL2SQL](self-healing-nl2sql.md) — what happens when a grounded query still fails
- [Data Agents parity](../workloads/data-agents-parity.md)
- Editor guide — [Ontology](../tutorials/editor-ontology.md)

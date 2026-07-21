# ontology-over-everything — the ontology as the substrate every item binds to (WS-6 / BTB-1)

Source UI / concept: Palantir Foundry **Ontology as the semantic layer** — a
lakehouse table, a stream, and a metric are all *typed object instances* of the
same ontology object, and every downstream surface (Workshop, AIP, lineage,
security, the agents) reasons over the ontology, not the raw tables. Loom builds
this on **Azure-native** primitives — Apache-AGE object types + Synapse / ADX /
Azure-native DAX / WS-3.2 zero-copy shortcuts — with **no Fabric / Power BI
dependency** (Gov-safe). This is the un-copyable differentiator BTB-1: a
single-product vendor cannot promote *one* ontology over *all* workloads.

WS-6 depends on **WS-4.1** (object views), **WS-4.3** (object security), and
**WS-3.2** (shortcut `engineObject` for zero-copy bind), all merged.

## The substrate model

An **`ontologyBinding`** annotation on ANY item's Cosmos `state` declares that
the item's rows ARE typed instances of an ontology object type:

```
state.ontologyBinding = {
  ontologyId, ontologyName?, objectType,        // the object type rows resolve as
  columnMap?, keyColumn?, keyProperty?,         // source column → object property
  source: { kind, ref, database?, measure?, sourceItemId?, lakehouseId?, shortcutId? },
  boundAt?,
}
```

The binding is INVERTED from the ontology's own `entityBindings` (ontology →
data source): here EACH item points at an object type, so many items across many
backends resolve onto ONE object. Pure model + mapping + query builders live in
`apps/fiab-console/lib/foundry/ontology-binding.ts` (fully unit-tested,
injection-guarded); the I/O resolver in
`apps/fiab-console/lib/foundry/ontology-resolver.ts`.

## Feature inventory (Foundry "ontology-over-everything")

| Capability | Foundry behavior |
|---|---|
| Bind any dataset to an object type | A backing dataset materializes an object type; its columns map to object properties. |
| One object, many backing sources | Different backends can each supply instances of the same object type. |
| Resolver over the ontology | Queries resolve object → backing source(s) → rows, typed as instances. |
| Zero-copy binding | Binding over external / shortcut tables without copying bytes. |
| Copilot grounds through the ontology | The agent reasons over typed object instances, not raw tables. |
| Lineage through the ontology | The bind is a lineage edge (source → ontology). |
| Access policy through the ontology | Object/property/row security applies to resolved instances. |

## Loom coverage

| Row | Status | Loom implementation |
|---|---|---|
| Binding annotation on every item | ✅ built | `state.ontologyBinding` (`OntologyBinding`), authored by the **`bind-to-ontology` Weave** (`lib/thread/thread-actions.ts` → `app/api/thread/bind-to-ontology/route.ts`) on every `notebookAttachable` type **+ `semantic-model`**. Persisted via `updateOwnedItem`; object type validated ∈ declared types (409 otherwise). |
| Ontology resolver middleware | ✅ built | `resolveBindingInstances(binding, ot, {top,tenantId})` maps a source's rows → typed instances per the column→property map, coercing to the declared base types. `resolveOntologyObjectInstances(...)` merges MANY bindings onto ONE object type. |
| lakehouse-table source | ✅ built | Synapse Serverless SQL over Delta (`synapse-sql-client.executeQuery(serverlessTarget)`). |
| kql source | ✅ built | Azure Data Explorer (`kusto-client.executeQuery`). |
| semantic-measure source | ✅ built | Azure-native DAX (`tabular-eval-client.evalDax`, owner-scoped) — loom-native tabular over Synapse, AAS opt-in. No Power BI. |
| warehouse-table source | ✅ built | Synapse Dedicated SQL (`synapse-sql-client.executeQuery(dedicatedTarget)`). |
| Zero-copy shortcut source (WS-3.2) | ✅ built | Resolves the WS-3.2 `engineObject` from the `lakehouse-shortcuts` registry and `SELECT`s it on the Synapse Serverless engine — no byte copy. |
| azure-sql source | ⚠️ honest-gate | Named gate (`azure_sql_unwired`): bind via lakehouse-table / warehouse-table this slice. |
| shortcut over Databricks UC | ⚠️ honest-gate | Named gate: the Synapse-engine shortcut resolves today; UC-engine resolution is deferred. |
| Copilot grounds through the ontology | ✅ built | `resolveOntologyObjectForGrounding(ontologyId, objectType, tenantId, top)` powers the new `case 'ontology'` in `data-agent-execute.ts::executeSourceQuery` — a data-agent turn over an `ontology` source resolves the object → bound sources → typed instances the model re-prompts over. |
| Lineage through the ontology | ✅ built | The bind records a Thread edge (source → ontology) via `recordThreadEdge` (→ Weave lineage + Purview Atlas when configured). |
| Access policy through the ontology | ✅ built | The resolve route applies WS-4.3 `secureInstances` (row-filter + property-mask by Entra groups) to the resolved instances + `pdpCheck` item-level read. Masked values are dropped server-side, never serialized. |

Zero ❌.

## Backend per control

| Control / route | Backend called |
|---|---|
| `POST /api/thread/bind-to-ontology` | Cosmos `items` (persist `state.ontologyBinding`) + Thread-edge recorder (+ Purview). |
| `GET /api/items/ontology/[id]/resolve?objectType=` | Cosmos discovery of bound items → per-source: Synapse Serverless/Dedicated (TDS), ADX (KQL), Azure-native DAX, WS-3.2 engineObject → WS-4.3 security. |
| data-agent `ontology` source | `resolveOntologyObjectForGrounding` → the same per-source backends. |

## Acceptance (WS-6)

- **A lakehouse table, a KQL stream, and a semantic measure all resolve as typed
  instances of ONE ontology object.** Proven by
  `lib/foundry/__tests__/ontology-resolver.test.ts` → *"a lakehouse table, a KQL
  stream, and a semantic measure all resolve as Customer instances"* (3 real
  backends mocked, one merged `Customer` instance set, each carrying its
  `sourceKind`).
- **A copilot query grounds through the ontology graph.** The `ontology` branch
  in `data-agent-execute.ts` calls `resolveOntologyObjectForGrounding`, returning
  typed instance rows the model reasons over (tested end-to-end with a mocked
  Synapse backend + Cosmos discovery).
- **Lineage + access policy resolve through the ontology.** The bind records a
  lineage edge; the resolve route applies WS-4.3 object security to resolved
  instances (masked property test green).

## Sovereignty / no-Fabric

Every resolution path is Azure-native (Synapse / ADX / AAS / AGE / UC) — the
no-fabric grep over the new files is clean; no `api.fabric` / `api.powerbi` /
`onelake.dfs.fabric` host is reached. Works Commercial + Gov (GCC/GCC-High/IL5)
with the same OSS/Azure substitutions the underlying clients already carry.

## Env-config

No new editable runtime variable was introduced — resolution reuses the existing
`LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` / ADX cluster / AAS
semantic-backend vars. `EDITABLE_ENV` count is unchanged (140); `check-env-sync`
is green.

## Owed (Track-0)

**Browser-E2E receipt (G1):** bind a lakehouse table + a KQL stream + a semantic
measure to ONE ontology object via the "Bind to ontology" Weave, then
`GET .../resolve?objectType=<T>` returns typed instances from all three, and a
data-agent turn over the `ontology` source grounds through them — captured in a
minted-session walk. Not yet attached (no live Synapse+ADX+AAS backend in this
worktree).

## Related

`ui-parity.md`, `no-vaporware.md`, `no-fabric-dependency.md`, `ux-baseline.md`;
WS-4.1 `ontology.md`, WS-4.3 `ontology-object-security.md`, WS-3.2 lakehouse
shortcuts. This is BTB-1 — the substrate WS-7 (closed-loop) and WS-10 (time
machine / living marketplace) compose over.

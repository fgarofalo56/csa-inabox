# CSA Loom — Weave (Semantic Ontology) Epic

Weave is CSA Loom's Palantir-class semantic ontology: object types, link types,
and **write-back action types** with a real, durable graph instance store. This
doc covers Phase 1 (audit-T50): real object/link/action *instance* write-back on
**PostgreSQL + Apache AGE**, Azure-native + OSS, deployed BY DEFAULT via bicep.

## Why this exists (the gap Phase 1 closes)

Before Phase 1, the Loom "ontology" was **metadata-only** — a Cosmos item whose
`state.source` holds a DSL string (`ClassName : ParentClass -- description`).
Object/link/action *types* were derived from that DSL; there was **no instance
store** and **no write-back**. The Workshop "run-action" was read-only
(`SELECT TOP (n)` against a bound Synapse warehouse).

Phase 1 adds the missing **graph instance store** + **write-back execution**:

| Ontology concept | Type (declared) | Instance (Phase 1, NEW) |
|------------------|-----------------|--------------------------|
| Object type      | DSL class (`parseOntologyHierarchy`) | AGE **vertex** (label = object type) |
| Link type        | IS_A from class hierarchy / operator edge | AGE **edge** (label = link type) |
| Action type      | `state.actionTypes[]` (create/update/delete) | a cypher **transaction** (AGE is ACID) |

## Architecture

```
Ontology editor (phase4-editors.tsx → WeaveInstancePanel)
   │  POST /api/items/ontology/[id]/objects        (create object instance)
   │  GET  /api/items/ontology/[id]/objects        (list instances)
   │  POST /api/items/ontology/[id]/links          (create link instance)
   │  GET/POST /api/items/ontology/[id]/run-action (declared action write-back)
   ▼
lib/azure/weave-ontology-store.ts   (openCypher over ag_catalog)
   │  runCypher(stmt, columns) → SET search_path = ag_catalog,…;
   │                             SELECT * FROM ag_catalog.cypher('loom_ontology', $$ … $$) AS (…)
   ▼
lib/azure/postgres-flex-client.ts → executePostgresQuery(fqdn, db, sql)
   │  real `pg` wire protocol, Entra token auth (no stored password)
   ▼
Azure Database for PostgreSQL Flexible Server + Apache AGE
   modules/landing-zone/postgres-weave.bicep  (default-on)
```

### Object/link/action model

- **Object instance** — `CREATE (n:<ObjectType> {props}) RETURN n`. `ObjectType`
  MUST be a declared ontology class (`loom-no-freeform-config` — no freeform
  vertex labels). Properties are scalars (string/number/boolean), JSON-encoded
  into the cypher map (never string-concatenated — the cypher-injection guard).
- **Link instance** — `MATCH (a),(b) WHERE id(a)=.. AND id(b)=.. CREATE (a)-[r:<LinkType>]->(b)`.
  Both endpoint object types must be declared classes.
- **Action type** — declared on `state.actionTypes[]` as
  `{ name, objectType, kind: create|update|delete, params? }`. Running an action
  executes one cypher statement (a single PostgreSQL transaction). AGE inherits
  PostgreSQL ACID semantics → write-back is durable (the acceptance criterion).

### AGE schema (openCypher over ag_catalog)

Grounded in Microsoft Learn
(`azure/postgresql/azure-ai/generative-ai-age-overview`,
`azure/postgresql/extensions/concepts-extensions-considerations`):

1. **Server params (bicep)** — `shared_preload_libraries` must include `AGE`
   (else `ERROR: unhandled cypher(cstring) function call`) **and**
   `azure.extensions` must allowlist `AGE`. Setting `shared_preload_libraries`
   triggers an automatic server restart.
2. **One-time data-plane (bootstrap)** — `CREATE EXTENSION IF NOT EXISTS age CASCADE;`
   then `SELECT ag_catalog.create_graph('loom_ontology');`. Metadata lives in
   `ag_catalog.ag_graph` / `ag_catalog.ag_label`.
3. **Query** — `SELECT * FROM ag_catalog.cypher('loom_ontology', $$ MATCH (n) RETURN n $$) AS (n agtype);`
4. AGE on PG16 is version **1.6.0** (Preview) — the Weave editor surfaces tag a
   `Badge "Preview"` per `no-vaporware.md §preview`.

## Default-on bicep + bootstrap contract

Per `no-vaporware.md §Bicep sync` — `az deployment sub create` + the post-deploy
bootstrap must produce a working Weave with no manual steps:

- **`modules/landing-zone/postgres-weave.bicep`** (NEW, default-on via
  `weaveOntologyEnabled bool = true`): provisions a PG16 flexible server,
  Entra-only auth (passwordAuth disabled, Console UAMI as Entra admin), the two
  AGE `configurations` (`shared_preload_libraries`, `azure.extensions`), an
  Azure-services firewall rule, the `loom-weave` database, and diagnostic
  settings → LAW.
- **Orchestrator wiring**: `main.bicep` adds `weaveOntologyEnabled bool = true`,
  passes it through both single-sub and multi-DLZ module calls, and wires the
  Console env vars `LOOM_WEAVE_PG_FQDN` / `LOOM_WEAVE_PG_DATABASE` /
  `LOOM_WEAVE_GRAPH` (deterministic name over the DLZ RG, mirroring the Cosmos
  graph-vector pattern). `LOOM_POSTGRES_AAD_SCOPE` / `LOOM_POSTGRES_HOST_SUFFIX`
  are set per boundary (Commercial vs US-Gov). `loomPostgresAadUser` defaults to
  `loom-console`.
- **`scripts/csa-loom/bootstrap-weave-pg.sh`** + a step in
  `.github/workflows/csa-loom-post-deploy-bootstrap.yml`: waits for the server
  to report `Ready` (the preload restart), runs
  `pgaadauth_create_principal('loom-console', false, false)`,
  `CREATE EXTENSION age CASCADE`, `create_graph('loom_ontology')`, and grants the
  Console UAMI principal usage on `ag_catalog` + the graph schema.

## Per-cloud / sovereign notes

- PG Entra token scope is cloud-specific: `LOOM_POSTGRES_AAD_SCOPE`
  (Commercial `https://ossrdbms-aad.database.azure.com/.default`; Gov
  `…usgovcloudapi.net/.default`) and `LOOM_POSTGRES_HOST_SUFFIX`
  (`postgres.database.azure.com` vs `postgres.database.usgovcloudapi.net`) — set
  by the admin-plane per `boundary`, mirroring `LOOM_SYNAPSE_SQL_TOKEN_SCOPE`.
- AGE is a standard allowlisted extension on Flexible Server; confirm regional
  availability in GCC-High / IL5 at deploy time.

## Acceptance receipts (per no-vaporware.md §Validation per merge)

- **Object write-back**: `POST /api/items/ontology/<id>/objects`
  `{ "objectType": "Customer", "properties": { "name": "Acme" } }`
  → `201 { ok: true, object: { id: "844…", objectType: "Customer", properties: { name: "Acme" } } }`
  (the vertex is durably persisted in PostgreSQL — re-GET returns it).
- **Action write-back**: declare `{ name: "createCustomer", objectType: "Customer", kind: "create" }`,
  then `POST /api/items/ontology/<id>/run-action`
  `{ "action": "createCustomer", "params": { "name": "Globex" } }`
  → `{ ok: true, action: "createCustomer", kind: "create", objectType: "Customer", object: { id: "844…" } }`.
- **Honest gate** (LOOM_WEAVE_PG_FQDN unset): every route returns `503` with a
  `gate` naming `LOOM_WEAVE_PG_FQDN` + `modules/landing-zone/postgres-weave.bicep`;
  the editor renders the full Objects / Write-back actions surface with a Fluent
  `MessageBar intent="warning"`.
- **Azure-native default**: works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the
  store is PostgreSQL + AGE, never `api.fabric.microsoft.com`.

## Files

New:
- `apps/fiab-console/lib/azure/weave-ontology-store.ts`
- `apps/fiab-console/app/api/items/ontology/[id]/objects/route.ts`
- `apps/fiab-console/app/api/items/ontology/[id]/links/route.ts`
- `apps/fiab-console/app/api/items/ontology/[id]/run-action/route.ts`
- `platform/fiab/bicep/modules/landing-zone/postgres-weave.bicep`
- `scripts/csa-loom/bootstrap-weave-pg.sh`

Modified:
- `apps/fiab-console/app/api/items/_lib/palantir-crud.ts` (`loadOntologySurface` → `actionTypes`)
- `apps/fiab-console/lib/editors/phase4-editors.tsx` (`WeaveInstancePanel`)
- `platform/fiab/bicep/main.bicep`, `modules/landing-zone/main.bicep`, `modules/admin-plane/main.bicep`
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml`

## Roadmap (later phases)

- Phase 2: typed property schemas per object type (validate props against the
  ontology), link cardinality, traversal queries in the UI.
- Phase 3: action parameter schemas with typed inputs + a Workshop write-back
  binding (generalize workshop-app/run-action onto the AGE store).

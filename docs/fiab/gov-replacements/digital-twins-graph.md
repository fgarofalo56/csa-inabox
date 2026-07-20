# Digital Twins → ADX / AGE graph-twin (GCC-High replacement)

**Status:** design (net-new gate wiring; the graph-twin backend already exists)
**Gate:** `svc-digital-twins` (`LOOM_ADT_ENDPOINT`)
**Boundary:** GCC-High / IL5 / DoD — Azure Digital Twins (ADT) is **not** available.
**Rule basis:** `.claude/rules/no-fabric-dependency.md` (Azure-native default),
`no-vaporware.md` (real backend), `ui-parity.md` (Fabric Digital Twin Builder parity).

---

## 1. Why this exists

Azure Digital Twins (ADT) is not offered in the Azure Government (GCC-High / IL5 /
DoD) boundary, so `svc-digital-twins` honest-gates there on `LOOM_ADT_ENDPOINT`.
The operator directive (gov 89/89 provision drive, 2026-07-20) is to satisfy the
digital-twin surfaces with an **Azure-native graph-twin** rather than a real ADT
instance — exactly the posture the codebase already ships on the DEFAULT path.

**Key finding: the replacement backend is already built.**
`apps/fiab-console/lib/editors/digital-twin-model.ts` (and its BFF routes)
materialize the twin graph on the shared **Azure Data Explorer (ADX)** cluster,
NOT on ADT:

- ENTITY types → `DT_<key>_E_<entity>(id, props)` tables
- RELATIONSHIP types → `DT_<key>_R_<rel>(src, dst, props)` tables
- Built with the proven `.create-merge` + `.set-or-append` pipeline, then
  explored with the Kusto graph engine (`make-graph` / `graph-match`) — the same
  Azure-native default the `gql-graph` editor uses (memory: *Graph = ADX*).
- ADT is a **strict opt-in alternate** gated on `LOOM_ADT_ENDPOINT`; the default
  path uses ADX only (per the module header comment).

So this is **not** a from-scratch build — it is (a) a second graph-store option
using **Apache AGE** (Postgres) for deployments that prefer a relational graph,
and (b) the **gate wiring** so `svc-digital-twins` is recognized as satisfied by
the ADX-native default instead of demanding `LOOM_ADT_ENDPOINT`.

---

## 2. Model

Reuse the existing structured model in `digital-twin-model.ts`:

| Concept | Loom model | ADX materialization | AGE materialization |
|---|---|---|---|
| Entity type | `TwinEntityType` (typed props, 1:1 Kusto scalars) | `DT_<key>_E_<entity>` table | AGE vertex label `<entity>` |
| Relationship type | `TwinRelationshipType` (src/dst entity, props) | `DT_<key>_R_<rel>` table | AGE edge label `<rel>` |
| Source binding | mapping onto lakehouse Delta / Synapse / ADX table | `.set-or-append` from source query | `LOAD`/`INSERT` via `cypher()` |
| Exploration | graph query | `make-graph` / `graph-match` | `MATCH … RETURN` (openCypher) |

The AGE store mirrors the **Weave ontology store** already in the repo
(`apps/fiab-console/lib/azure/weave-ontology-store.ts`, backed by
`LOOM_WEAVE_PG_FQDN` + Apache AGE). A graph-twin on AGE is the same substrate
with a `DT_<key>` graph namespace instead of the ontology graph — reuse its
connection + `pgaadauth` token path (see memory: *Weave AGE store*).

---

## 3. Ingest

1. Author entity/relationship types + source-table mappings in the Digital Twin
   Builder editor (unchanged — already 1:1 with Fabric's RTI Digital Twin Builder).
2. On **materialize**, the BFF runs the generated KQL (`.create-merge` schema,
   `.set-or-append` from the bound source query) against ADX **or**, when
   `LOOM_TWIN_BACKEND=age`, the generated openCypher against the AGE graph.
3. Incremental refresh reuses the source watermark the mapping already carries;
   no ADT time-series ingestion pipeline is required.

---

## 4. API surface

No new external hosts. Everything runs on backends the Console already reaches:

- **ADX** via `apps/fiab-console/lib/azure/kusto-client.ts` (cluster from
  `LOOM_KUSTO_CLUSTER_URI`, Gov suffix `kusto.usgovcloudapi.net` resolved by
  cloud-endpoints) — the DEFAULT.
- **AGE** via a Postgres-flex + Apache AGE server (`LOOM_TWIN_PG_FQDN`, aliasing
  the Weave/pgvector Postgres) — the relational-graph OPT-IN. Note the GCC-High
  **Postgres quota** constraint (`LOOM_POSTGRES_QUOTA_AVAILABLE`, see
  `params/gcc-high.bicepparam`); the AGE option is only available once the
  operator has a Postgres Flexible Server quota grant.
- **ADT** via `LOOM_ADT_ENDPOINT` — Commercial-only opt-in, unchanged.

Backend selection: `LOOM_TWIN_BACKEND` (`adx` default | `age` | `adt`), matched
by the `/_BACKEND$/` allowlist pattern in `scripts/ci/check-env-sync.mjs`.

---

## 5. Gate wiring (the actual net-new work)

Make `svc-digital-twins` recognize the ADX-native default so it is not blocked in
Gov, mirroring the `svc-aas` → Loom-native recognition landed in this PR:

```ts
// lib/admin/env-checks.ts — svc-digital-twins
anyOf: [['LOOM_ADT_ENDPOINT', 'LOOM_KUSTO_CLUSTER_URI', 'LOOM_TWIN_PG_FQDN']],
// LOOM_KUSTO_CLUSTER_URI is emitted whenever ADX is deployed (adxEnabled=true
// in gcc-high.bicepparam), so the twin surface is backed by the ADX graph-twin
// with zero ADT dependency; LOOM_ADT_ENDPOINT stays the Commercial opt-in.
```

Remediation copy: "Digital twins run on the Azure Data Explorer graph-twin
(`make-graph`/`graph-match`) by default — no Azure Digital Twins required. ADT is
a Commercial-only opt-in (`LOOM_ADT_ENDPOINT`)."

**Do not** ship the gate change in the same PR as the 89/89 provision wiring —
this doc is the spec for the follow-on build item.

---

## 6. Bicep

- ADX cluster: already provisioned in Gov (`adxEnabled=true`,
  `modules/admin-plane/adx-cluster.bicep`). No new module.
- AGE option: reuse `modules/landing-zone/postgres-weave.bicep` (Apache AGE
  extension) gated on `postgresQuotaAvailable`; emit `LOOM_TWIN_PG_FQDN` next to
  `LOOM_WEAVE_PG_FQDN` in the console `apps[]` env.
- ADT (Commercial): `modules/deploy-planner/digital-twins.bicep` — unchanged.

## 7. Acceptance

Twin editor materializes an entity + relationship type and `graph-match` returns
rows **with `LOOM_ADT_ENDPOINT` UNSET** on a Gov deployment (ADX graph-twin
receipt), per `no-fabric-dependency.md` §"Verification per merge".

# Power Platform / ML / Geo / Graph family sweep

> Sweep deliverable, 2026-05-27.
> Branch: `sweep-pp-ml-geo-graph` → PR
> `feat(csa-loom): Power Platform / ML / Geo / Graph family — production-grade across 28 editors`

## Scope

28 editors across six sub-families:

| Family | Editors |
|---|---|
| Power Platform (6) | `powerplatform-environment`, `dataverse-table`, `power-app`, `power-automate-flow`, `power-page`, `ai-builder-model` |
| ML / Data Science (5) | `ml-model`, `ml-experiment`, `graphql-api`, `user-data-function`, `variable-library` |
| Fabric IQ (6) | `ontology`, `graph-model`, `plan`, `map`, `operations-agent`, `data-agent` |
| Geo (4) | `geo-map`, `geo-dataset`, `geo-query`, `geo-pipeline` |
| Graph + Vector (4) | `cosmos-gremlin-graph`, `cypher-graph`, `gql-graph`, `vector-store` |
| Data product + cross-item (3) | `data-product-template`, `data-product-instance`, `cross-item-copilot` |

## Done bar (per no-vaporware.md)

For every editor in scope:

1. **Real backend wired** — Power Platform BAP / PowerApps / Flow / Dataverse Web API; Azure ML workspace REST for ML; Azure Maps + ADX geo for geo; Cosmos Gremlin + Neo4j (or Cosmos Cypher equivalent) + AGE for graph; vector via Cosmos NoSQL or AI Search. No stubs.
2. **Vitest** — pure-logic utility coverage in `apps/fiab-console/lib/editors/__tests__/family-utils.test.ts` (8 helpers, 30+ cases).
3. **Playwright** — `apps/fiab-console/e2e/pp-ml-geo-graph.uat.ts` walks all 28 editor routes against the live Front Door, classifies render + family-marker results, emits per-editor screenshots, and asserts the family contract (every entry exists in the catalog).
4. **Docs** — parity-spec exists for every editor under `docs/fiab/<slug>-parity-spec.md`; this doc is the family aggregate.
5. **Bicep + deploy** — Power Platform tenant config script (`scripts/csa-loom/powerplatform-tenant-bootstrap.sh`); Azure Maps module (`platform/fiab/bicep/modules/admin-plane/azure-maps.bicep`); Cosmos Gremlin + vector containers module (`platform/fiab/bicep/modules/landing-zone/cosmos-graph-vector.bicep`); env vars wired in `admin-plane/main.bicep`.

## Per-editor grading (Phase 4.5 standard)

The implementation pre-sweep was already A or A+ on most editors (Cosmos persistence + Save/Ctrl+S, real REST round-trip, honest gates). This sweep moves the family to the **A+ row** by adding test + bicep coverage.

| Editor | Backend | UI grade | Test grade | Bicep grade | Final |
|---|---|---|---|---|---|
| `powerplatform-environment` | BAP admin REST | A (read-only registry) | Playwright | tenant script | **A+** |
| `dataverse-table` | Dataverse Web API | A (schema browser) | Playwright | tenant script | **A+** |
| `power-app` | PowerApps admin REST | A (registry + Play URL) | Playwright | tenant script | **A+** |
| `power-automate-flow` | Flow REST + run + runs | A+ (live Run + run history) | Playwright | tenant script | **A+** |
| `power-page` | Dataverse `mspp_website` | A (registry + site URL) | Playwright | tenant script | **A+** |
| `ai-builder-model` | Dataverse `msdyn_aimodel` | A (registry + status mapping) | Vitest + Playwright | tenant script | **A+** |
| `ml-model` | Azure ML workspace REST | A (registry view, Apply deferred) | Playwright | ai-foundry.bicep | **A+** |
| `ml-experiment` | Azure ML workspace REST | A (run table + properties) | Playwright | ai-foundry.bicep | **A+** |
| `graphql-api` | Cosmos + APIM publish | A+ (publish to APIM live) | Playwright | apim.bicep | **A+** |
| `user-data-function` | Cosmos + Function App picker | A (deploy deferred, picker live) | Playwright | container-platform.bicep | **A+** |
| `variable-library` | Cosmos with typed values | A (7 var types validated) | Vitest | cosmos.bicep | **A+** |
| `ontology` | Cosmos + materialize to graph-model | A+ (cross-item materialize) | Vitest | cosmos.bicep | **A+** |
| `graph-model` | Cosmos + ADX materialize | A+ (live KQL materialize) | Playwright | adx-cluster.bicep | **A+** |
| `plan` | Cosmos with progress badges | A (status + overdue + bar) | Playwright | cosmos.bicep | **A+** |
| `map` | Cosmos + Azure Maps static tile | A+ (live tile preview when key bound) | Vitest (bbox/zoom) | azure-maps.bicep | **A+** |
| `operations-agent` | Cosmos + Foundry agent deploy | A (deploy live, runtime deferred) | Playwright | ai-foundry.bicep | **A+** |
| `data-agent` | Cosmos + Foundry agent deploy | A (deploy live, chat deferred) | Playwright | ai-foundry.bicep | **A+** |
| `geo-map` | Cosmos + Azure Maps account | A (form persists, account-bound preview) | Playwright | azure-maps.bicep | **A+** |
| `geo-dataset` | Cosmos + ADLS container picker | A (path round-trips via util) | Vitest (split/join) | storage.bicep | **A+** |
| `geo-query` | KQL + Synapse Serverless | A+ (live query dispatch) | Playwright | adx-cluster + synapse | **A+** |
| `geo-pipeline` | Cosmos + ADF pipeline trigger | A (live ADF Trigger run) | Playwright | adf.bicep | **A+** |
| `cosmos-gremlin-graph` | Gremlin endpoint + query | A (live traversal, viz deferred) | Playwright | cosmos-graph-vector.bicep | **A+** |
| `cypher-graph` | KQL graph-match dispatch | A (live KQL execution) | Playwright | adx-cluster.bicep | **A+** |
| `gql-graph` | Fabric Graph / Gremlin / persist-only | A (3 backends + honest gate) | Playwright | cosmos-graph-vector.bicep | **A+** |
| `vector-store` | Cosmos NoSQL DiskANN + alternatives | A+ (index spec persists + create) | Playwright | cosmos-graph-vector.bicep | **A+** |
| `data-product-template` | Cosmos catalog | A (catalog + provision flow) | Playwright | cosmos.bicep | **A+** |
| `data-product-instance` | Cosmos + provisioning state | A (instance lifecycle) | Playwright | cosmos.bicep | **A+** |
| `cross-item-copilot` | Cross-tool dispatcher (32 tools) | A+ (all 32 tools registered) | Playwright | ai-foundry.bicep | **A+** |

## Bicep modules introduced

| Module | Backs | Notes |
|---|---|---|
| `platform/fiab/bicep/modules/admin-plane/azure-maps.bicep` | `geo-map`, `geo-pipeline`, `map` | Boundary-gated — Commercial/GCC only. Key Vault stores primary key. Console UAMI gets Azure Maps Data Reader. |
| `platform/fiab/bicep/modules/landing-zone/cosmos-graph-vector.bicep` | `cosmos-gremlin-graph`, `vector-store` | Two separate Cosmos accounts (Gremlin + NoSQL). Private endpoints wired. UAMI gets Data Contributor data-plane role. DiskANN index on `/embedding` (1536-dim cosine). |

## Tenant config script

`scripts/csa-loom/powerplatform-tenant-bootstrap.sh` automates as much as Microsoft's tenant gates allow:

1. Enumerates Power Platform environments visible to the Loom MSAL Web App SP.
2. Calls `dataverse-add-appuser.sh` for each env with Dataverse.
3. Probes the PowerApps + Flow admin REST surfaces with the SP token.
4. Prints the manual gates that cannot be automated (Power Platform Admin role, "Service principal access" tenant toggle, Default-env "Promote To Admin").
5. Emits a JSON report to `test-results/pp-tenant-bootstrap/report.json`.

Idempotent — safe to re-run after fixing a manual gate.

## Test commands

```bash
# Vitest unit tests (lib/editors/_family-utils.ts)
cd apps/fiab-console && pnpm test

# Playwright editor walkthrough against live Loom
cd apps/fiab-console && \
  SESSION_SECRET=<from KV> \
  pnpm exec playwright test e2e/pp-ml-geo-graph.uat.ts

# Bicep what-if for the new modules
az deployment sub what-if \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam

# Power Platform tenant bootstrap (dry-run first)
LOOM_MSAL_CLIENT_ID=<guid> \
  ./scripts/csa-loom/powerplatform-tenant-bootstrap.sh --dry-run
```

## Vaporware checks

`grep -rE "(return \[\]|return \{\}|useState\(\[\{)" apps/fiab-console/lib/editors/{powerplatform,phase4,geo,graph,data-product,cross-item-copilot}-editor*.tsx` → **clean** for this family. No stubs.

`grep -rE "(MOCK_|SAMPLE_DATA)" apps/fiab-console/lib/editors/{powerplatform,phase4,geo,graph,data-product,cross-item-copilot}-editor*.tsx` → only documented `SAMPLE_GREMLIN` / `SAMPLE_CYPHER` / `SAMPLE_GQL` / `SAMPLE_GEO_KQL` / `SAMPLE_GEO_TSQL` placeholder query strings (loaded into the Monaco editor on first render; user edits before Run).

## Open follow-ups

| Item | Why deferred | Tracked in |
|---|---|---|
| Force-directed graph viz (Cosmos Gremlin) | needs a non-trivial layout layer (Cytoscape/D3); JSON view is acceptable interim | `cosmos-gremlin-graph-parity-spec.md` |
| H3 UDF install in Synapse Serverless | requires DACPAC + assembly trust; tracked separately | `geo-query-parity-spec.md` |
| Cypher-to-KQL translation | preview Microsoft service; UI accepts both today | `cypher-graph-parity-spec.md` |
| Power App canvas editor | proprietary Microsoft client | `power-app-parity-spec.md` |
| GeoMap vector overlay | atlas.data.Source bundle; static tile preview works | `map-parity-spec.md` |

All deferred items surface in-product as Fluent UI MessageBars with the precise env var or admin action required (per the rule 4 vaporware allowance).

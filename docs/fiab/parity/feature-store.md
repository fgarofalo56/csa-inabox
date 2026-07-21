# feature-store — parity with Databricks Feature Store

**Source UI:** Databricks Feature Engineering in Unity Catalog — feature tables,
point-in-time lookups, online tables (Lakebase), feature-lookup-at-serving.
Learn: <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/>,
<https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/time-series>,
<https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/publish-features>

**Loom item:** `feature-table` (Data Science). **Editor:**
`lib/editors/feature-table-editor.tsx`. **Backend:**
`lib/azure/feature-store-client.ts` (+ `lib/azure/feature-store-item.ts`).
**Routes:** `app/api/items/feature-table/[id]/{route,pit-join,online,serve}.ts`.

**No-Fabric / sovereign:** the offline store is Unity Catalog (Databricks) on
Commercial or **OSS Unity Catalog + Azure Database for PostgreSQL** on the Gov /
sovereign path (`LOOM_FEATURE_STORE_BACKEND=postgres`, auto-selected when OSS-UC
is active or no Databricks workspace is bound). The online store is **Lakebase /
pgvector** (Azure Database for PostgreSQL). No Microsoft Fabric / Power BI on any
path.

## Databricks feature-store feature inventory → Loom coverage

| # | Databricks capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Create a **feature table** (entity/primary keys + timestamp key + typed feature columns) | ✅ Define tab — Save creates the real offline table | `createFeatureTable` → `buildFeatureTableDdl` → `runOfflineSql` (Databricks SQL warehouse `CREATE TABLE … USING DELTA` / Postgres `CREATE TABLE`) |
| 2 | UC governance (catalog.schema.table three-part name, USE/CREATE grants) | ✅ full three-part naming; UC-governed on the Databricks path, PG schema-qualified on the sovereign path | `executeStatement` (UC) / `executePostgresQuery` |
| 3 | Time-series / **point-in-time (AS-OF) lookup** onto a spine/training set | ✅ Point-in-time join tab — Preview SQL + Run, real rows + timing | `runPitJoin` → `buildPitJoinSql` (LEFT JOIN LATERAL, latest feature ≤ label time) → `runOfflineSql` |
| 4 | Carry label / passthrough columns into the training set | ✅ "Carry columns" input | `buildPitJoinSql` (spine `carryColumns`) |
| 5 | Typed feature columns (double/bigint/int/string/boolean/timestamp/date) | ✅ per-feature type dropdown | `sparkTypeFor` / `pgTypeFor` |
| 6 | **Publish to an online table** (materialize latest features per entity) | ✅ Online serving tab — "Publish latest features" | `publishOnline` → `buildLatestOfflineSql` (ROW_NUMBER latest-per-entity) read + `INSERT … ON CONFLICT` upsert into pgvector |
| 7 | **Feature-lookup-at-serving** (online read at inference) | ✅ "Look up + invoke" — real indexed SELECT then score | `lookupOnlineFeatures` → `buildOnlineLookupSql` (params-bound) |
| 8 | Enrich a model-serving scoring call with looked-up features | ✅ merges features into the payload and invokes a `model-serving-endpoint` (WS-1.2) | `mergeFeaturesIntoPayload` + `invokeServingEndpoint` (Azure ML online endpoint / Databricks Mosaic) |
| 9 | Reverse wire-in: feature lookup from the serving item's invoke path | ✅ `model-serving-endpoint/[id]/invoke` accepts `featureLookup` | shared `lookupOnlineFeatures` + `mergeFeaturesIntoPayload` |
| 10 | Delete / drop a feature table | ✅ `DELETE` drops offline + online backing tables | `dropFeatureTable` |
| 11 | Injection-safe SQL (identifiers validated, values bound) | ✅ every identifier validated + engine-quoted; entity values bound as `$n` / feature upserts via extended protocol | `assertIdent`/`assertFullName` + `DbxQueryParam` / `pg` params |
| 12 | Honest gate + inline Fix-it when a backend is unconfigured (G2) | ⚠️ honest gate `svc-feature-store` with Fix-it (offline) + online gate (pgvector) — full surface still renders | `featureStoreConfigGate` / `onlineStoreGate` + `HonestGate` |

**Grade:** every inventory row is built ✅ or an honest-gate ⚠️ — **zero ❌**, zero
stub banners.

## UX baseline

- Editor shell (`ItemEditorChrome`) with ribbon, right details panel, tabbed
  surface (Overview / Define / Point-in-time join / Online serving); Loom tokens,
  no hard-coded px/hex; badge rows use `flexWrap` + `minWidth:0`.
- G2 — the only non-functional state is the honest `svc-feature-store` gate with
  an inline Fix-it wizard (registered in `lib/gates/registry.ts` + the Admin gate
  page); a freshly created item opens clean (no red banner before touch).
- G1 — **Owed: browser-E2E receipt** (author a feature table → PIT-join to a
  training set → publish online → look up features at inference to score a
  serving endpoint, real data end-to-end). Tracked under Track-0.

## Verification

- `tsc -p tsconfig.build.json` — clean.
- `vitest run lib/azure/__tests__/feature-store-client.test.ts` — 24 pass
  (backend resolution, spec validation + injection rejection, DDL builders, PIT
  AS-OF join, online read builders, payload merge, honest gates).
- CI guardrails green: env-sync, route-guards, file-size, health-coverage,
  bff-errors.

# ui-wave2-data-streaming-apis — Wave 2 UI parity (real-time-hub / rti-hub-catalog / activators / mirroring / apis)

Source audit: `docs/fiab/audit/live-e2e-feature-surfaces-v2.md` §4 "UI Updates Needed".
Scope: the UI-update rows for the five data/streaming/API areas. Code-level
B-fixes (B1–B12) and their row-menu/branch UI shipped in PR #1418 and are NOT
re-done here — this wave builds on them.

Theme: Fluent UI v9 + Loom tokens, matching surrounding code. Every new control
calls a real BFF route (no dead controls, no mock data); where a backend is
genuinely absent the surface renders an honest gate per `no-vaporware.md`.

## real-time-hub

| Audit row | Change | Status | Backend |
|---|---|---|---|
| preview — DB/table picker | `StreamPreviewDrawer` replaced free-text DB/table `Input`s with real Fluent `Dropdown` pickers populated from `.show databases` / `.show tables`. | built ✅ | new `GET /api/realtime-hub/databases` → `listDatabases()` / `listTables(db)` (real Kusto control commands); `clusterUri` threaded for discovered ADX clusters; honest gate when `LOOM_KUSTO_CLUSTER_URI` unset |
| keyvault-certificates | When the mTLS vault is configured but has 0 certs, the cert picker now shows an honest empty-state with the vault host + a deep-link to the vault's Certificates blade (importing a cert needs KV Certificate Officer, so the parity action is the real vault, not a faked in-app upload). | built ✅ | `GET /api/realtime-hub/keyvault-certificates` (already returns `vaultUri`) |
| DELETE eventstream / RealTimeHubView row menu | Row-menu Delete + azure-native DELETE. | already done in #1418 — not re-done | — |

## rti-hub-catalog

| Audit row | Change | Status | Backend |
|---|---|---|---|
| connect-source — reject fabric-* | `connect-source` route now rejects `Fabric*` source types with 400 when `LOOM_EVENTSTREAM_BACKEND != fabric` (defense in depth) instead of silently creating an Azure-native item that can never produce those events. | built ✅ | `POST /api/realtime-hub/connect-source` |
| preview (cluster row) — carry real Kusto DB | Resolved by the DB/table picker: the drawer now lists the real databases on the discovered cluster, so the operator selects the correct DB instead of relying on the item-name default. | built ✅ | `GET /api/realtime-hub/databases?clusterUri=…` |
| eventstream events 409 CTA | `EventTestDrawer` already renders a "Not provisioned yet" MessageBar with an in-place "Provision ingest endpoint" CTA + editor link. | already present — verified | `…/eventstream/[id]/events` + `…/source` |
| data-explorer peek gate | `EventTestDrawer` already renders the AMQP-receive 501 gate while keeping Send enabled. | already present — verified | `/api/eventhubs/data-explorer` |
| Eventstream DELETE row menu | Shipped in #1418. | already done | — |

## activators

| Audit row | Change | Status |
|---|---|---|
| activator detail GET azure-native branch (B4) | Shipped in #1418. | already done — not re-done |
| DELETE action-group GC / quick-create sourceTable / new-rule wizard | Backend-heavy / out of this wave's UI-only scope; left for the activators backend wave. | deferred (noted) |

## mirroring

| Audit row | Change | Status | Backend |
|---|---|---|---|
| Cosmos start gate — drop server (ui-gap) | Wizard hides the Server field for Cosmos (database-only); verify gate no longer requires server for Cosmos; the engine's Start gate (`mirror-engine.ts`) now gates Cosmos on `database` only. | built ✅ | `mirror-source-wizard.tsx` + `mirror-engine.ts` |
| endpoint/shortcut pairing — Install CTA | The "no SQL analytics endpoint paired yet" caption is now an actionable MessageBar with an "Install & start mirror" button that runs the real Start (which provisions the Serverless pairing), then re-checks `sql-endpoint`. | built ✅ | `POST …/mirrored-database/[id]/state` + `GET …/sql-endpoint` |
| PostgreSQL start gate in wizard / open-mirror 404→NoNewFiles | Backend/wizard-flow scope; not in this UI pass. | deferred (noted) |

## apis

| Audit row | Change | Status | Backend |
|---|---|---|---|
| apim/gateways — empty caption | Empty Gateways tree node now explains Developer/Consumption tiers expose only the managed gateway and self-hosted needs Premium. | built ✅ | `/api/apim/gateways` |
| apim-api spec export — disable/explain | Spec-unavailable state is now an explanatory MessageBar ("No exportable spec" — link-imported APIs have no inline OpenAPI; Copy stays disabled). | built ✅ | `…/apim-api/[id]/spec` |
| apim-api test-call — master-key fallback | Backend already attaches `Ocp-Apim-Subscription-Key` by precedence (manual → subscription → master). UI now surfaces which key was used (`keySource` badge) so success OOTB via the master key is visible. | built ✅ (backend present) | `…/apim-api/[id]/test-call` → `testApiCall` |
| dab preview/publish — inline gate remediation | Already renders the env var + bicep path inline. | already present — verified | `…/dab/[id]/preview\|publish` |
| dab sources schema — SQL-login gate inline | Schema gate now surfaces the structured SQL-login remediation (`gate.remediation` = `CREATE USER … FROM EXTERNAL PROVIDER`) + `gate.missing`, instead of the raw driver string (ties to B3 503 from #1418). | built ✅ | `/api/dab/sources/[kind]/schema` |
| user-data-function invoke — gate hint | Already renders the publish-prerequisite hint inline on 409. | already present — verified | `…/user-data-function/[id]/invoke` |

## Backend per new control

- `GET /api/realtime-hub/databases` — `listDatabases()` / `listTables(db)` (real `.show databases`/`.show tables` over the AAD-token Kusto REST path); validates an optional discovered-cluster `clusterUri`; 200 honest-gate when no cluster configured.
- `kusto-client.ts` — `executeMgmtCommand` / `listDatabases` / `listTables` gained an optional `{ clusterUri }` so the picker can target discovered ADX clusters.

## Tests

`app/api/realtime-hub/__tests__/routes.test.ts` — 48 pass, including 5 new:
fabric-* rejection without opt-in, and the databases route (list dbs / list
tables / invalid clusterUri 400 / 401 unauth).

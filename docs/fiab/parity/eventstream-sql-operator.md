# eventstream-sql-operator — parity with Fabric Eventstream "Edit code" / Azure Stream Analytics multi-output query

Source UI:
- Fabric Eventstream code editor / "Edit code" (SAQL): https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/edit-eventstream
- ASA multiple outputs (one `INTO [alias]` per output): https://learn.microsoft.com/azure/stream-analytics/stream-analytics-parallelization
- ASA query editor + Test query: https://learn.microsoft.com/azure/stream-analytics/stream-analytics-test-query
- ASA outputs (Event Hub / ADLS Gen2 Blob / ADX): https://learn.microsoft.com/azure/stream-analytics/stream-analytics-define-outputs
- SAQL reference: https://learn.microsoft.com/stream-analytics-query/stream-analytics-query-language-reference

Fabric Eventstream is built on the Azure Stream Analytics runtime. Where the
**transform builder** (sibling parity doc) is a guided, no-freeform surface for
single operators, the **SQL operator** is the *code-first* surface: one Monaco
SAQL document that fans out to **multiple named sinks** via `SELECT … INTO
[alias]`. This matches Fabric's "Edit code" experience and ASA's multi-output
job model. Azure-native default — no Fabric tenant required. Backend is real ASA
ARM (`lib/azure/stream-analytics-client.ts`) via
`/api/items/eventstream/[id]/sql-operator`.

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | **Code-first query editor** | Free SAQL/T-SQL document with syntax highlighting |
| 2 | **Multiple outputs** | One `SELECT … INTO [output]` statement per named output |
| 3 | **Named output management** | Declare each output and bind it to a sink (EH / Blob / ADX) |
| 4 | **Compile / validate** | Validate the query without starting the job (real compiler diagnostics) |
| 5 | **Test query** | Run the query over sample input events and inspect produced rows |
| 6 | **Per-output inspection** | View the rows landing in one specific output |
| 7 | **Save query** | Persist the transformation onto the streaming job |
| 8 | **Apply outputs** | Create/update the output datasources the query writes to |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Code-first query editor | built ✅ | Monaco (`language="sql"`) in the **SQL operator** tab of `EventstreamEditor` |
| 2 | Multiple outputs | built ✅ | Multi-`INTO` query; undeclared aliases surfaced + one-click "＋ alias" to declare |
| 3 | Named output management | built ✅ | Named-sinks manager: per-row alias + kind (KQL/ADX, Lakehouse/ADLS Gen2, Event Hub, Activator) + kind-specific fields |
| 4 | Compile / validate | built ✅ | `action='compile'` → real ASA `compileQuery` (subscription-scoped action); receipt shows errors/warnings/outputs |
| 5 | Test query | built ✅ | `action='test'` → real ASA `testQuery` over the sample-events JSON |
| 6 | Per-output inspection | built ✅ | Test scopes the query to a single `INTO [alias]` and renders just that sink's rows in a grid |
| 7 | Save query | built ✅ | `action='save'` → persists to Cosmos **and** pushes the transformation to the ASA job (`saveTransformation`) |
| 8 | Apply outputs | built ✅ | `action='apply-sinks'` → `createOrUpdateOutput` per named sink (real ARM PUT) |

Honest infra-gate ⚠️ (not a stub): when ASA isn't provisioned the route returns
`501` with a hint naming `platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep`,
`LOOM_ASA_RG`, the "Stream Analytics Query Tester" role, and (for Test) the
`LOOM_ASA_TEST_WRITE_URI` SAS. The full UI still renders; the gate is shown in a
warning MessageBar. Compile remains available without test storage.

Zero ❌, zero stub banners.

## Backend per control

| Control | Endpoint / action | Real backend |
|---------|-------------------|--------------|
| Save | `POST /sql-operator { action:'save' }` | Cosmos `saveItemState` + ASA `saveTransformation` (Microsoft.StreamAnalytics/streamingjobs/{job}/transformations) |
| Compile | `POST /sql-operator { action:'compile' }` | ASA `compileQuery` (Microsoft.StreamAnalytics/locations/{loc}/compileQuery) |
| Test output | `POST /sql-operator { action:'test' }` | ASA `testQuery` (Microsoft.StreamAnalytics/locations/{loc}/testQuery) over Raw sample input, scoped to one `INTO` |
| Apply sinks | `POST /sql-operator { action:'apply-sinks' }` | ASA `createOrUpdateOutput` per sink → ADX (Microsoft.Kusto/clusters/databases), ADLS Gen2 (Microsoft.Storage/Blob), Event Hub (Microsoft.EventHub/EventHub) |
| Load | `GET /sql-operator` | Cosmos `loadKustoItem` (state.sqlOperator) |

## Env / bicep

Reuses the existing ASA wiring — **no new env vars, resources, or roles**:
`LOOM_ASA_RG`, `LOOM_ASA_SUB`, `LOOM_ASA_TEST_WRITE_URI`, `LOOM_KUSTO_CLUSTER_URI`,
`LOOM_ADLS_ACCOUNT`, `LOOM_ADLS_CONTAINER`, `LOOM_EVENTHUBS_NAMESPACE` are already
declared in `platform/fiab/bicep/modules/admin-plane/main.bicep` and provisioned
by `platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep`.

## Tests

`apps/fiab-console/lib/editors/__tests__/eventstream-sql-operator.test.tsx` —
renders the tab, asserts the named-sinks manager + per-output test surface, and
verifies Compile / Apply sinks / Test each POST the right action and render the
real receipt.

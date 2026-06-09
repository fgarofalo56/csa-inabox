# semantic-model · DirectQuery source binder — parity with Power BI / AAS DirectQuery storage mode

Source UI:
- Power BI Desktop "Get data" → **DirectQuery** connectivity mode + Model view "Storage mode" property
  (https://learn.microsoft.com/power-bi/connect-data/desktop-directquery-about)
- Azure Analysis Services tabular model — partition `mode = directQuery`, single DataSource
  (https://learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl,
   https://learn.microsoft.com/analysis-services/tmsl/datasources-object-tmsl)

The Azure-native default backend is **Azure Analysis Services** (no Microsoft Fabric / Power BI
capacity required — no-fabric-dependency.md). DirectQuery means no data is imported: every DAX query
generates a live query at the bound Azure source.

## Azure/Fabric feature inventory

| # | Capability (real Power BI / AAS surface) | Notes |
|---|---|---|
| 1 | Choose DirectQuery storage mode for a model/table | DQ partitions hold no cached data |
| 2 | Disable "Refresh now" for a DQ model (nothing to import) | Power BI greys out refresh; `isRefreshable=false` |
| 3 | Pick the source connector (SQL family / Kusto) | DQ supports SQL DW/Synapse, Azure SQL, ADX, etc. |
| 4 | Provide server + database connection details | TDS host / ADX cluster + db |
| 5 | Supply / reference credentials (managed identity or secret) | AAS DataSource credential |
| 6 | Test the connection before binding | "Connect" probe |
| 7 | Browse the source's tables (navigator) | pick tables to expose |
| 8 | Select which tables become DirectQuery partitions | one DQ partition per table |
| 9 | Apply the binding to the model (write TMSL) | `createOrReplace` DataSource + partitions |
| 10 | Confirm DQ server state (mode persisted) | model now queries source live |

## Loom coverage

| # | Status | Where |
|---|---|---|
| 1 | built ✅ | `isDqMode` derived from `targetStorageMode`; DirectQuery source tab |
| 2 | built ✅ | Refresh ribbon action + "Refresh dataset" button disabled when `isDqMode`, honest tooltip |
| 3 | built ✅ | `DqSourcePanel` source-type dropdown (4 Azure-native families, enum — no freeform) |
| 4 | built ✅ | Server / database fields (env-bound default for Synapse; required FQDN for Azure SQL) |
| 5 | built ✅ | KV secret-ref field (blank = Console UAMI); resolved via real KV data-plane read |
| 6 | built ✅ | "Test connection" → PUT `…/datasource {action:'test'}` → `SELECT 1` / `print 1` / ADX query |
| 7 | built ✅ | "List tables" → PUT `{action:'tables'}` → `INFORMATION_SCHEMA.TABLES` / `.show tables` |
| 8 | built ✅ | Table checklist (multi-select) |
| 9 | built ✅ | "Apply DirectQuery" → PUT `{action:'apply'}` → `aas-client.applyDqSource` (XMLA TMSL) |
| 10 | built ✅ | TMSL sets `mode:"directQuery"`, `dataView:"full"`; persisted to AAS model + item state |
| — | honest-gate ⚠️ | When `LOOM_AAS_SERVER/REGION/MODEL` unset → MessageBar names the exact var; full UI still renders |
| — | honest-gate ⚠️ | When a KV secret-ref is given but KV unconfigured / secret missing → MessageBar names it |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend (real) |
|---|---|
| Source-type dropdown | client-side enum → drives BFF dialect |
| Test connection (Synapse Serverless/Dedicated) | `synapse-sql-client.executeQuery` (TDS + UAMI) |
| Test connection (Azure SQL) | `azure-sql-client.executeQuery` (TDS + UAMI) |
| Test connection (ADX) | `kusto-client.executeQuery` (`/v1/rest/query`) |
| List tables (TDS) | `INFORMATION_SCHEMA.TABLES` via the TDS clients |
| List tables (ADX) | `kusto-client.executeMgmtCommand('.show tables')` |
| KV secret-ref resolve | `kv-secrets-client.getKeyVaultSecretValue` |
| Apply DirectQuery | `aas-client.applyDqSource` → XMLA `Execute` SOAP → AAS model (`…/models/{db}/xmla`) |
| Config persistence | Cosmos items container — `state.dqSource` (cross-partition lookup by item id) |

All hosts resolve through `cloud-endpoints` (`aasSuffix`, `synapseSqlSuffix`, `getSqlSuffix`, `kustoSuffix`,
`kvSuffix`) — gov-correct on Commercial / GCC / GCC-High / DoD.

## Verification

- `pnpm vitest run lib/azure/__tests__/aas-client.test.ts` — 11 green (TMSL shape, gov XMLA host, SOAP fault).
- `cloud-endpoints.test.ts` — `aasSuffix` row across all 4 clouds + `aasScope`/`aasServerBase` green.
- Live: with `LOOM_AAS_SERVER/REGION/MODEL` set + the Console UAMI an AAS server admin, bind a Synapse
  Serverless endpoint, select tables, Apply → AAS partitions go `mode:directQuery`; a DAX query returns
  live rows with no data copied (server state confirms DQ). With the env unset the tab honest-gates.

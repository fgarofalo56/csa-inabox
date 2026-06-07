# eventhouse-delta-endpoint — parity with Fabric RTI Eventhouse "Get data from OneLake / Delta" + ADX external tables

Source UI: **Microsoft Fabric Eventhouse** "Get data → OneLake" / shortcut flow,
and the **Azure Data Explorer** external-table + query-acceleration surface
(`https://dataexplorer.azure.com`). In Fabric an Eventhouse can surface a
OneLake/Delta source as a KQL-queryable shortcut; in stand-alone ADX the
equivalent is an **external table `kind=delta`** plus the **query_acceleration
policy**, which caches the Delta data for sub-second KQL latency. CSA Loom builds
the ADX-native path (no Fabric / OneLake dependency) into the **Eventhouse
editor** (`apps/fiab-console/lib/editors/phase3-editors.tsx → EventhouseEditor`),
"Manage → Bind Delta source".

Grounded in Microsoft Learn:

- External tables over Delta Lake (`.create-or-alter external table … kind=delta`):
  https://learn.microsoft.com/kusto/management/external-tables-delta-lake
- Query acceleration policy (`.alter external table … policy query_acceleration`):
  https://learn.microsoft.com/kusto/management/alter-query-acceleration-policy-command
- Show acceleration policy (`.show external table … policy query_acceleration`):
  https://learn.microsoft.com/kusto/management/show-query-acceleration-policy-command
- Managed-identity storage auth (`;managed_identity=system`):
  https://learn.microsoft.com/azure/data-explorer/external-tables-managed-identities
- `external_table()` query function:
  https://learn.microsoft.com/kusto/query/external-table-function

## Azure/Fabric feature inventory

| # | Capability (real ADX / Fabric Eventhouse) |
|---|---|
| 1 | Pick a target KQL database for the binding |
| 2 | Name the external table (KQL identifier) |
| 3 | Point at an ADLS Gen2 / OneLake Delta path (the `_delta_log` root) |
| 4 | Auto-infer schema from the Delta log (no manual schema) |
| 5 | Authenticate storage via the cluster managed identity (no keys) |
| 6 | Enable query acceleration with a hot-cache window (days) |
| 7 | Show the applied acceleration policy (receipt) |
| 8 | Query the Delta data via KQL (`external_table("T")`) within seconds |
| 9 | Create a clean KQL view wrapping the external table |
| 10 | List existing external Delta tables in the database |

## Loom coverage

| # | Capability | State | Control → backend |
|---|---|---|---|
| 1 | Target database select | ✅ | wizard `Select` over `state.databases` |
| 2 | External table name | ✅ | `Input` → `validIdent` guard |
| 3 | ADLS Gen2 Delta path | ✅ | `Input` (abfss://) → `abfss://` guard |
| 4 | Schema auto-infer | ✅ | `.create-or-alter external table kind=delta` (no schema param) |
| 5 | Managed-identity storage auth | ✅ | `;managed_identity=system` conn string |
| 6 | Query acceleration hot window | ✅ | `.alter external table … policy query_acceleration` |
| 7 | Show acceleration policy | ✅ | `.show external table … policy query_acceleration` → wizard receipt |
| 8 | KQL queryable | ✅ | `external_table("T")` (sample query surfaced) |
| 9 | KQL view function | ✅ | `.create-or-alter function T_view() { external_table("T") }` |
| 10 | List external Delta tables | ✅ | `GET …/continuous-export?database=` → `.show external tables` |

Zero ❌ — every inventory row is built and calls a real Kusto control command.

## Backend per control

- **POST `/api/items/eventhouse/[id]/continuous-export`** — orchestrates steps
  1-4 and returns `{ ok, externalTableName, accelerationPolicy, kqlViewName,
  sampleQuery, steps[] }`. Steps array is the per-command receipt.
- **GET `/api/items/eventhouse/[id]/continuous-export?database=<db>`** — lists
  Delta external tables via `.show external tables`.
- `lib/azure/kusto-client.ts` — `createExternalDeltaTable`,
  `setQueryAccelerationPolicy`, `showQueryAccelerationPolicy`,
  `createExternalTableView`, `listExternalTables` (all over
  `executeMgmtCommand` → `/v1/rest/mgmt`).

## No-Fabric / honest-gate notes

- Default path is **ADX-native** — no `fabricWorkspaceId`, no OneLake host, no
  Fabric capacity. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- The only infra prerequisite is **Storage Blob Data Reader for the ADX cluster
  MI** on the target ADLS account. Synced in bicep:
  `platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep`
  (`adxClusterPrincipalId`), threaded from the admin-plane ADX cluster output
  through `landing-zone/main.bicep → synapse.bicep`. When the grant is missing,
  ADX returns a storage-access error which the route surfaces verbatim with a
  precise remediation hint (no spinner, no mock) — honest gate per
  `no-vaporware.md`.

## Validation receipt

E2E to attach at merge (live cluster, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset):

1. POST `/api/items/eventhouse/<id>/continuous-export` with a real lakehouse
   Bronze Delta `abfssUri` → response `ok:true`, `steps[].create_external_table`
   ok, `accelerationPolicy` JSON present.
2. Query `external_table("<table>") | take 5` in the KQL editor → Delta rows
   returned within seconds.
3. GET `…/continuous-export?database=<db>` → the new external table listed.

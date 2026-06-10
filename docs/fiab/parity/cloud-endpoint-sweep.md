# cloud-endpoint sweep — sovereign-cloud hostname + RBAC audit

**Scope:** every new client / BFF route / provisioner / bicep module must resolve
Azure hostnames through `apps/fiab-console/lib/azure/cloud-endpoints.ts` (the
single sovereign-cloud truth table) — never a hard-coded literal. Every new Azure
dependency gets a bicep role assignment + a cloud-matrix unit test. Grounded in
the Azure Government endpoint parity table (Microsoft Learn:
`azure-government/compare-azure-government-global-azure`) and the Azure PowerShell
environment suffixes.

## Helpers (cloud-endpoints.ts)

| helper | Commercial / GCC | GCC-High / IL5 / DoD |
|--------|------------------|----------------------|
| `armBase()` | management.azure.com | management.usgovcloudapi.net (DoD: management.azure.microsoft.scloud) |
| `getCosmosSuffix()` | documents.azure.com | documents.azure.us |
| `synapseSqlSuffix()` | sql.azuresynapse.net | sql.azuresynapse.usgovcloudapi.net |
| `getSqlSuffix()` | database.windows.net | database.usgovcloudapi.net |
| `kustoSuffix()` | kusto.windows.net | kusto.usgovcloudapi.net |
| **`getAasSuffix()`** (new) | asazure.windows.net | asazure.usgovcloudapi.net |
| **`aasServerUri(region, name)`** (new) | `asazure://<region>.asazure.windows.net/<name>` | `asazure://<region>.asazure.usgovcloudapi.net/<name>` |

`getAasSuffix()` backs the optional Azure Analysis Services tabular backend for
semantic-model / report parity (Power BI / Fabric stay opt-in per
`no-fabric-dependency.md`). It keys off `isGovCloud()`, so GCC (Commercial Azure
endpoints) correctly yields the `.windows.net` suffix.

## Violations fixed (TypeScript — default code paths)

| file | before | after |
|------|--------|-------|
| `lib/azure/arm-endpoint.ts` | local `armBase()` with `management.azure.com` literal | re-export shim → `cloud-endpoints` |
| `lib/azure/iothub-client.ts` | local `armBase()` copy | `import { armBase }` from cloud-endpoints |
| `lib/azure/eventhubs-client.ts` | ARG_URL literal `https://management.azure.com/...` | `${armBase()}/providers/Microsoft.ResourceGraph/resources` |
| `lib/install/provisioners/workspace-monitor.ts` | `LOOM_ARM_ENDPOINT || 'https://management.azure.com'` | `armBase()` |
| `app/auth/sign-in/route.ts` | ARM_SCOPE + SQL_USER_SCOPE Commercial literals | `armBase()` + `getSqlSuffix()` |
| `app/auth/callback/route.ts` | ARM_SCOPE + sqlHost Commercial literals | `armBase()` + `getSqlSuffix()` |
| `app/api/dab/sources/route.ts` | `${ws}.sql.azuresynapse.net` ×4 | `synapseSqlSuffix()` |
| `app/api/dab/deploy-source/route.ts` | fallback `${server}.database.windows.net` | `${server}.${getSqlSuffix()}` |

## Violations fixed (Bicep)

| file | fix |
|------|-----|
| `admin-plane/main.bicep` | `LOOM_KUSTO_DATA_INGESTION_URI` now uses the existing `kustoSuffix` var instead of a `kusto.windows.net` literal |
| `admin-plane/network.bicep` | Cosmos private DNS zone is now `privatelink.documents.azure.${gov ? 'us' : 'com'}` |
| `landing-zone/synapse-auto-pause.bicep` | new `loomArmEndpoint` param → `armHost`/`armAudience` vars; Logic App HTTP actions + MSI audience are now sovereign-cloud aware. Wired from `landing-zone/main.bicep` off `boundary`. The `$schema` namespace is cloud-invariant and unchanged. |

## RBAC (new bicep module)

`admin-plane/iothub-rbac.bicep` — grants the Console UAMI **Reader** +
**Azure Event Hubs Data Receiver** on a bound IoT Hub so the Eventstream IoT Hub
source (`iothub-client.ts`) can resolve + receive from the hub's built-in
Event Hubs-compatible endpoint with the managed identity. Opt-in: only deployed
when `loomIotHubResourceId` names a hub (scoped to that hub's RG). When unset,
the editor surfaces an honest-gate MessageBar. Built-in role GUIDs are
cloud-agnostic.

## Tests

- `lib/azure/__tests__/cloud-endpoints.test.ts` — `getAasSuffix` added to the
  4-cloud table (Commercial / GCC / GCC-High / DoD).
- `lib/azure/__tests__/cloud-matrix.test.ts` — `getAasSuffix` + `aasServerUri`
  Commercial + Government rows; explicit GCC suffix assertions (AAS / Cosmos /
  Synapse) in the dispatch block. **100/100 pass.**

## Grep-gate scope

The acceptance grep targets executable endpoint **resolution** on default code
paths. Out of scope (not endpoint resolution): code comments, `__tests__`
expected-value strings, the cloud-invariant Logic App `schema.management.azure.com`
JSON namespace, content-bundle SAMPLE connection strings, UI placeholder/example
text (`placeholder=`, `<code>`, `e.g. https://<account>...`), and env-var-guarded
honest-gate message strings. `kusto.windows.net` was swept in a prior task and is
not a target of this sweep.

## No-fabric

No new `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric`
references introduced. The only Power BI host references live in
`cloud-endpoints.ts::getPbiGovHost()` — the Azure-Government-backed Power BI REST
host, explicitly permitted by `no-fabric-dependency.md`.

# kql-database-data-connections — parity with Fabric Eventhouse / Azure Data Explorer data connections

Source UI:
- Fabric: KQL Database → **Get data** → IoT Hub / Event Hub data connection wizard
- Azure: Azure Data Explorer cluster → Databases → **Data connections** → **Add data connection** → IoT Hub
  (https://learn.microsoft.com/azure/data-explorer/create-iot-hub-connection)

Azure-native backend (NO Fabric workspace required): `Microsoft.Kusto/clusters/{c}/databases/{d}/dataConnections`
via ARM REST `api-version=2023-08-15`. IoT Hub source = `Microsoft.Devices/IotHubs` (`api-version=2023-06-30`).

## Azure / Fabric feature inventory

| # | Capability (Azure ADX / Fabric Eventhouse) | Notes |
|---|--------------------------------------------|-------|
| 1 | Pick source kind (Event Hub / IoT Hub)     | ADX supports both |
| 2 | Pick the IoT Hub from the subscription      | Portal lists hubs in scope |
| 3 | Choose a shared access policy (ServiceConnect needed for ingestion) | Built-ins: iothubowner, service |
| 4 | Choose a consumer group (default `$Default`) | Built-in events endpoint |
| 5 | Choose data format (MULTIJSON/JSON/CSV/… — NOT RAW for IoT Hub) | ADX format set |
| 6 | Choose target table (+ optional mapping)   | Table must exist or be created |
| 7 | Create the connection (real ARM PUT)        | Returns provisioningState |
| 8 | List existing data connections              | ARM GET on the database |
| 9 | Delete a data connection                    | ARM DELETE |
| 10 | Device-to-cloud messages land as rows in the table | runtime ingestion driven by ADX |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | KqlDatabaseEditor "Add data connection" wizard — Source type Select |
| 2 | ✅ built | IoT Hub picker (Select) populated from `/api/azure/resources?type=Microsoft.Devices/IotHubs` (Resource Graph, per-user RBAC) |
| 3 | ✅ built | Shared access policy Select from `/api/azure/iothub/policies` (listkeys; names+rights only, never key material). Non-blocking fallback to built-ins |
| 4 | ✅ built | Consumer group Input (default `$Default`) |
| 5 | ✅ built | Data format Select (`DC_FORMATS`, RAW excluded) |
| 6 | ✅ built | Target table Input |
| 7 | ✅ built | POST `/api/items/kql-database/[id]/data-connections` `kind:'iothub'` → `createDataConnection` ARM PUT |
| 8 | ✅ built | GET same route → `listDataConnections`, rendered in the wizard table |
| 9 | ✅ built | DELETE same route → `deleteDataConnection` (trash icon per row) |
| 10 | ✅ runtime | ADX-driven once the connection is `Succeeded`; verify with `.show data connections` + `<table> | count` |

Honest gates (⚠️, full UI still renders):
- No IoT Hub visible to Loom → `MessageBar intent="warning"` naming the resource to provision / Reader grant.
- ADX cluster MI lacks `IotHubKeys/read` → POST returns code `mi_no_key_read`; editor surfaces the exact "IoT Hub Contributor" role grant.
- Identity can't enumerate policies → info MessageBar + curated built-in policy fallback (wizard stays usable).

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| IoT Hub / Event Hub picker | `GET /api/azure/resources` → Azure Resource Graph |
| Shared access policy | `GET /api/azure/iothub/policies` → `POST {arm}/{iotHubId}/listkeys` (2023-06-30) |
| Create / List / Delete | `POST|GET|DELETE /api/items/kql-database/[id]/data-connections` → `Microsoft.Kusto …/dataConnections` (2023-08-15) |
| Runtime ingestion | ADX-managed (cluster MI reads source keys; D2C → target table) |

Cloud portability: ARM host resolved via `lib/azure/arm-endpoint.ts` (`armBase()`/`armScope()`) from
`AZURE_CLOUD` / `LOOM_ARM_ENDPOINT` — Commercial, GCC-High/IL5 (`management.usgovcloudapi.net`), IL6
(`management.azure.microsoft.scloud`). This also fixed a pre-existing Commercial-only hardcode in
`kusto-arm-client.ts`.

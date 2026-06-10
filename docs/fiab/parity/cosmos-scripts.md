# cosmos-scripts — parity with Azure Cosmos DB Data Explorer (Stored Procedures / Triggers / UDFs)

Source UI: Azure portal Cosmos DB Data Explorer — the **New/Edit Stored
Procedure**, **New/Edit Trigger**, and **New/Edit User Defined Function** tabs
that open from a container's *Stored Procedures / Triggers / User Defined
Functions* nodes. Grounded in Microsoft Learn:

- ARM authoring (api-version `2024-11-15`):
  - https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts/sqldatabases/containers/storedprocedures
  - https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts/sqldatabases/containers/triggers
  - https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts/sqldatabases/containers/userdefinedfunctions
- Data-plane execute (stored procedures):
  - https://learn.microsoft.com/rest/api/cosmos-db/execute-a-stored-procedure

## Azure feature inventory

| Capability | Source UI behavior |
|---|---|
| New Stored Procedure | id field + Monaco JS editor seeded with a `getContext()/getResponse()` template; Save creates it |
| Edit Stored Procedure | open existing → id locked, body loaded; Save replaces |
| Delete Stored Procedure | removes the sproc |
| Execute Stored Procedure | partition-key input + positional params; runs the sproc, shows result + RU charge |
| New Trigger | id + **Trigger type** (Pre/Post) + **Trigger operation** (All/Create/Delete/Replace/Update) + Monaco JS body |
| Edit Trigger | open existing → metadata (type/operation) + body loaded; Save replaces |
| Delete Trigger | removes the trigger |
| New UDF | id + Monaco JS body seeded with a `userDefinedFunction(input)` template |
| Edit UDF | open existing → body loaded; Save replaces |
| Delete UDF | removes the UDF |
| List in tree | container's Stored Procedures / Triggers / User Defined Functions nodes show each script (read-only) |

## Loom coverage

| Capability | Status | Where |
|---|---|---|
| New Stored Procedure | built ✅ | `CosmosScriptEditor` → PUT `/api/cosmos/scripts` (kind `storedProcedure`) |
| Edit Stored Procedure | built ✅ | GET `?kind=storedProcedure&name=` loads body; Save PUTs (replace) |
| Delete Stored Procedure | built ✅ | DELETE `/api/cosmos/scripts?kind=storedProcedure&name=` |
| Execute Stored Procedure | built ✅ | POST `/api/cosmos/scripts/execute` (partition key + JSON params, result + RU inline) |
| New Trigger | built ✅ | Trigger type + Operation dropdowns + Monaco body; PUT (kind `trigger`) |
| Edit Trigger | built ✅ | GET pre-populates type/operation + body |
| Delete Trigger | built ✅ | DELETE (kind `trigger`) |
| New UDF | built ✅ | Monaco body + PUT (kind `udf`) |
| Edit UDF | built ✅ | GET loads body; Save PUTs |
| Delete UDF | built ✅ | DELETE (kind `udf`) |
| List in tree | built ✅ (pre-existing) | `CosmosTree` GET `/api/cosmos/scripts` list bundle |

Zero ❌. The only non-functional state is an honest gate: the env-not-wired
`not_configured` MessageBar (control plane) and the `dataplane_rbac` MessageBar
when Execute hits a missing Cosmos data-plane role — the full authoring surface
still renders in both cases.

## Backend per control

| Control | Backend |
|---|---|
| Save (sproc/udf) | ARM PUT `…/{leaf}/{id}` body `{ properties:{ resource:{ id, body }, options:{} } }` (`2024-11-15`) → `waitForProvisioned` |
| Save (trigger) | ARM PUT `…/triggers/{id}` body adds `triggerType` + `triggerOperation` |
| Load existing | ARM GET `…/{leaf}/{name}` → `{ properties:{ resource:{ id, body, … } } }` |
| Delete | ARM DELETE `…/{leaf}/{name}` (async 202 + poll) |
| Execute (sproc) | Data-plane POST `…/colls/{c}/sprocs/{name}` with `x-ms-documentdb-partitionkey` + JSON-array params (AAD auth via `cosmos-data-client`) |

## RBAC / cloud matrix

ARM authoring uses the navigator's existing **DocumentDB Account Contributor**
(`5bd9cd88-fe45-4216-938b-f97437e15450`) role — its `databaseAccounts/*`
wildcard covers `storedProcedures` / `triggers` / `userDefinedFunctions` PUT &
DELETE, so **no new role assignment is required**. Stored-procedure Execute is a
data-plane call and uses the same **Cosmos DB Built-in Data Contributor**
data-plane role the Items tab already requires (granted via
`scripts/csa-loom/grant-navigator-rbac.sh`, which assigns both the control-plane
DocumentDB Account Contributor and the data-plane Cosmos DB Built-in Data
Contributor to the Console UAMI at the account scope).

| Plane | Commercial / GCC | GCC-High / IL5 |
|---|---|---|
| ARM (`armFetch` → `armBase`) | `management.azure.com` | `management.usgovcloudapi.net` |
| Data plane (`cosmosDataEndpoint` → `getCosmosSuffix`) | `{acct}.documents.azure.com` | `{acct}.documents.azure.us` |

No cloud-specific code paths were added — both `armFetch()` and `dataFetch()`
resolve their endpoints through the existing `cloud-endpoints.ts` helpers, which
already branch on `LOOM_CLOUD` / `AZURE_CLOUD`.

## No-Fabric / Azure-native default

This surface targets a user-selected Azure Cosmos DB account (`LOOM_COSMOS_ACCOUNT`)
over ARM + the Cosmos data plane. It has no dependency on Microsoft Fabric and
works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Verification

- `pnpm test lib/components/cosmos/__tests__/cosmos-script-editor.test.tsx` —
  asserts the authoring toolbar renders (no "not yet wired" gate), Save PUTs the
  script with the right body, triggers expose the type/operation dropdowns, and
  editing GETs the existing body.
- Live: author + Save a stored procedure, then confirm it appears under the
  container's Stored Procedures node in the real Azure portal Data Explorer.

# Register a Unity Catalog table or OneLake item in Purview

This how-to drives the **Register in Purview** button on the Unified Catalog asset detail page. It is the cross-source bridge between Databricks Unity Catalog / Microsoft Fabric and Microsoft Purview Atlas.

## What it does

When you click **Register in Purview** on a Unity Catalog table, Loom calls:

```
POST /api/catalog/register
{
  "source": "unity-catalog",
  "host": "adb-xxxx.azuredatabricks.net",
  "fullName": "main.bronze.customers",
  "domain": "<purview-businessDomainId-guid>"   (optional)
}
```

The BFF route then:

1. Calls `getTable(host, fullName)` against the Unity Catalog REST API to confirm the table exists and to pull `comment`, `owner`, and `name`.
2. Composes a deterministic Atlas **qualifiedName**:

    ```
    https://{host}/api/2.1/unity-catalog/tables/{fullName}
    ```

    Because qualifiedName is the Atlas dedup key, repeated registrations are idempotent — re-running the action updates rather than duplicates the entity.

3. Calls `POST /datamap/api/atlas/v2/entity` with:

    ```json
    {
      "entity": {
        "typeName": "databricks_table",
        "attributes": {
          "qualifiedName": "...",
          "name": "customers",
          "comment": "..."
        },
        "contacts": { "Expert": [ { "id": "owner@contoso.com", "info": "Owner" } ] },
        "classifications": [ { "typeName": "MICROSOFT.PERSONAL.NAME" } ],
        "businessDomainId": "<guid>"
      }
    }
    ```

4. Reads `guidAssignments` from the response and returns the newly-assigned (or existing) Atlas guid, plus a deep link to the Purview Unified Catalog UI:

    ```
    https://{LOOM_PURVIEW_ACCOUNT}.purview.azure.com/main.html#/asset/{guid}
    ```

The OneLake variant is the same shape with `source: "onelake"` and `typeName: "fabric_lakehouse"` (or `fabric_warehouse`); qualifiedName becomes `https://onelake.dfs.fabric.microsoft.com/{workspaceId}/{itemId}`.

## Required configuration

| Variable / role | Where | Required for |
|---|---|---|
| `LOOM_PURVIEW_ACCOUNT` | Console env (wired by `admin-plane/main.bicep` when `purviewEnabled = true`) | Reaching the Purview data plane |
| **Data Curator** + **Data Product Owner** on the Loom UAMI | Purview portal → Governance domain | Atlas write surface |
| **Service principals can use Fabric APIs** | Power BI/Fabric admin portal | OneLake `getFabricItem` |
| Unity Catalog **METASTORE_ADMIN** for the Loom UAMI | Databricks admin via the helper script `scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh` | Reading UC table details |

If `LOOM_PURVIEW_ACCOUNT` is not set the BFF returns `501` with a structured `hint` payload pointing to the exact bicep module + roles needed; the UI surfaces this in a Fluent UI `MessageBar` rather than failing silently.

## Verification recipe

```bash
curl -s -X POST -H 'content-type: application/json' \
  -H "Cookie: loom_session=$(./scripts/csa-loom/mint-session.sh)" \
  -d '{"source":"unity-catalog","host":"adb-xxxx.azuredatabricks.net","fullName":"main.bronze.customers"}' \
  https://<console-host>/api/catalog/register
```

Successful response:

```json
{
  "ok": true,
  "source": "unity-catalog",
  "typeName": "databricks_table",
  "qualifiedName": "https://adb-xxxx.azuredatabricks.net/api/2.1/unity-catalog/tables/main.bronze.customers",
  "guid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "purviewDeepLink": "https://purview-csa-loom-eastus2.purview.azure.com/main.html#/asset/aaaaaaaa-..."
}
```

Click the deep link to confirm Purview shows the registered table.

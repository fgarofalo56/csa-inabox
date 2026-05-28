# Grant or revoke catalog permissions

This how-to drives the **Permissions** tab and is reachable from the **Permissions** card on any UC table or OneLake item detail page. Every grant produces a real `GRANT` / `REVOKE` against the upstream catalog — no fakes, no Cosmos-only state.

## Loom roles → backend privileges

| Loom role | Unity Catalog privileges | Fabric workspace role |
|---|---|---|
| Reader | `SELECT`, `USE_CATALOG`, `USE_SCHEMA`, `READ_VOLUME` | Viewer |
| Contributor | Reader + `MODIFY`, `REFRESH`, `WRITE_VOLUME` | Contributor |
| Admin | Contributor + `APPLY_TAG`, `EXECUTE` | Member |
| Owner | `ALL_PRIVILEGES` | Admin |

The mapping is enforced in `apps/fiab-console/app/api/catalog/permissions/route.ts`. Edit the constants there to extend.

## Grant a Reader on a UC table

```
POST /api/catalog/permissions
{
  "source":     "unity-catalog",
  "loomRole":   "Reader",
  "principal":  "data-team@contoso.com",
  "host":       "adb-xxxx.azuredatabricks.net",
  "secType":    "TABLE",
  "securable":  "main.bronze.customers"
}
```

The BFF route fans out via the REST permission graph (`PATCH /api/2.1/unity-catalog/permissions/table/...`). Set `useSQL: true` + `warehouseId: <id>` to instead issue a real `GRANT SELECT, USE_CATALOG, USE_SCHEMA, READ_VOLUME ON TABLE main.bronze.customers TO \`data-team@contoso.com\`` against a SQL warehouse — required for `EXECUTE ON FUNCTION` and row-filter / mask functions that the REST graph does not cover.

## Grant a Contributor on a Fabric workspace

```
POST /api/catalog/permissions
{
  "source":         "onelake",
  "loomRole":       "Contributor",
  "principal":      "<aad-group-or-upn>",
  "principalType":  "Group",
  "workspaceId":    "<fabric-workspace-id>"
}
```

The BFF calls Fabric `POST /workspaces/{ws}/roleAssignments` with role `Contributor`.

## Revoke

Identical body shape, use HTTP `DELETE` on the same route. The route preserves the same role → privilege mapping so the revoke removes exactly what the matching grant added.

## Required configuration

| Item | Where |
|---|---|
| Loom UAMI added to UC metastore as **METASTORE_ADMIN** or owner of the securable | `scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh` |
| Loom UAMI added as **Admin** on the Fabric workspace | Fabric portal → workspace → Manage access |
| (SQL mode) at least one running serverless SQL warehouse | Databricks → SQL warehouses |

The UI MessageBar surfaces the specific missing piece if any of these is unset.

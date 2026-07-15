# Module: `loom-item`

Creates and manages a CSA Loom item (any of the ~120 Azure-native item types)
inside a workspace.

| Path | Verb | Purpose |
|------|------|---------|
| `/api/workspaces/{workspaceId}/items` | `POST` | create |
| `/api/cosmos-items/{type}/{id}` | `GET` | read (drift detection) |
| `/api/cosmos-items/{type}/{id}` | `PATCH` | update |
| `/api/cosmos-items/{type}/{id}` | `DELETE` | destroy |

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workspace_id` | string | yes | The workspace to create the item in. |
| `item_type` | string | yes | The item type (e.g. `lakehouse`, `notebook`). |
| `display_name` | string | yes | Item display name. |
| `description` | string | no | Optional description. |

## Outputs

| Name | Description |
|------|-------------|
| `id` | The created item id. |
| `api_response` | The raw item object from the API. |

# Module: `loom-workspace`

Creates and manages a CSA Loom workspace via the Loom REST API.

| Path | Verb | Purpose |
|------|------|---------|
| `/api/workspaces` | `POST` | create |
| `/api/workspaces/{id}` | `GET` | read (drift detection) |
| `/api/workspaces/{id}` | `PATCH` | update |
| `/api/workspaces/{id}` | `DELETE` | destroy |

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Workspace display name. |
| `description` | string | no | Optional description. |
| `capacity` | string | no | Optional capacity binding id. |
| `domain` | string | no | Governance domain id (defaults to `default`). |

## Outputs

| Name | Description |
|------|-------------|
| `id` | The created workspace id. |
| `api_response` | The raw workspace object from the API. |

The `restapi` provider (uri + `Authorization: Bearer` header) is configured by
the root module and inherited here.

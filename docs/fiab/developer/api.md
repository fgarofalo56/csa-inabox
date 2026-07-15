# Loom REST API (OpenAPI 3.1)

The Loom API is the console's own Backend-for-Frontend. **Every capability in the
product UI is reachable programmatically** — the `loom` CLI, the Terraform
module, and any SDK you generate all ride on this exact surface.

- **Interactive reference (in-app):** `/developer/api`
- **Machine-readable spec:** `GET /api/openapi.json` (unauthenticated)

The server URL in the served spec is **your deployment**, so a generated client
targets the right cloud (Commercial or Government) automatically.

## Authentication

Two schemes cover the whole surface:

| Scheme | Header | Use |
|--------|--------|-----|
| Cookie | `Cookie: loom_session=…` | Browser / `loom auth login` sessions. |
| Bearer (PAT) | `Authorization: Bearer loom_pat_<id>_<secret>` | CI, scripts, Terraform, SDKs. |

Create a token in the console under **Settings → Developer → API tokens**. Scope
`read-only` permits GET/HEAD/OPTIONS; `read-write` permits mutations; `admin`
additionally reaches admin surfaces while the creator remains a tenant admin.

Verify a token:

```bash
curl -H "Authorization: Bearer loom_pat_…" https://<host>/api/v1/whoami
# → { "ok": true, "auth": "pat", "oid": "…", "scope": "read-write", … }
```

## Conventions

Success bodies are either a bare resource / array (the item + workspace routes)
or an `{ ok: true, … }` envelope. Failures are uniformly
`{ ok: false, error, code? }` with a matching HTTP status.

## Generate a client

Feed the spec to any OpenAPI generator:

```bash
openapi-generator-cli generate -i https://<host>/api/openapi.json -g python -o ./loom-py
openapi-generator-cli generate -i https://<host>/api/openapi.json -g typescript-fetch -o ./loom-ts
```

## Core routes

| Route | Verbs | Purpose |
|-------|-------|---------|
| `/api/v1/whoami` | GET | Identity + token scope probe. |
| `/api/workspaces` | GET, POST | List / create workspaces. |
| `/api/workspaces/{id}/items` | GET, POST | List / create items in a workspace. |
| `/api/cosmos-items/{type}/{id}` | GET, PATCH, DELETE | Typed item CRUD. |
| `/api/catalog/search` | GET | Federated Purview / Unity / OneLake search. |
| `/api/thread/edges` | GET | Loom Thread (Weave) lineage graph. |
| `/api/developer/tokens` | GET, POST | Manage API tokens (cookie-only). |
| `/api/scim/v2/{Users,Groups}` | CRUD | SCIM 2.0 provisioning (separate bearer). |

Azure-native by design — no Microsoft Fabric tenant is required.

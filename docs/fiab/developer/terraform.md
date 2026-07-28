# Terraform — Loom as code

Provision Loom **workspaces and items as code** using the Loom REST API. The
module set lives at [`tools/terraform`](https://github.com/fgarofalo56/csa-inabox/tree/main/tools/terraform).

## Scope

Loom ships a **real, `terraform`-consumable module** built on the community
[`Mastercard/restapi`](https://registry.terraform.io/providers/Mastercard/restapi/latest)
provider (full CRUD over any REST API). It is production-usable today:

| Module | Resource | Routes |
|--------|----------|--------|
| `loom-workspace` | a workspace | `POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/{id}` |
| `loom-item` | an item (lakehouse, notebook, …) | `POST /api/workspaces/{id}/items`, `GET/PATCH/DELETE /api/cosmos-items/{type}/{id}` |

A dedicated first-party **`terraform-provider-loom`** (a Go provider with typed
`loom_workspace` / `loom_item` resources, a `loom_workspace` data source, import
support and typed diagnostics) now exists at
[`sdk/terraform-provider-loom`](https://github.com/fgarofalo56/csa-inabox/tree/main/sdk/terraform-provider-loom).
It is **built from source, not published to the Terraform Registry** — see
[Native provider](#native-provider-terraform-provider-loom) below. The
`restapi`-backed module remains the zero-build path and is **not** a stub:
`terraform apply` against a live deployment creates real resources through the
real API.

## Authentication

Every call authenticates with a **read-write API token** (a PAT). Create one
under **Settings → Developer → API tokens**, then:

```bash
export TF_VAR_loom_token="loom_pat_<id>_<secret>"
```

## Quick start

```bash
cd tools/terraform/examples/workspace-and-item
terraform init
terraform plan  -var "loom_api_url=https://<your-loom-host>"
terraform apply -var "loom_api_url=https://<your-loom-host>"

terraform output workspace_id
terraform output lakehouse_id
```

The example provisions a workspace **and** a lakehouse item inside it, then
outputs their ids. `terraform destroy` removes both in dependency order.

## Provider configuration

The root module points the REST provider at your deployment and injects the
bearer token:

```hcl
provider "restapi" {
  uri                  = var.loom_api_url
  write_returns_object = true
  id_attribute         = "id"
  headers = {
    Authorization = "Bearer ${var.loom_token}"
    Content-Type  = "application/json"
  }
}
```

## Native provider (`terraform-provider-loom`)

Source: [`sdk/terraform-provider-loom`](https://github.com/fgarofalo56/csa-inabox/tree/main/sdk/terraform-provider-loom).
Built on `terraform-plugin-framework`, with a standard-library-only Loom API client.

| Address | Kind | Backing operations |
|---|---|---|
| `loom_workspace` | resource | `createWorkspace`, `listWorkspaces` |
| `loom_item` | resource | `createItem`, `getItem`, `updateItem`, `deleteItem` |
| `loom_workspace` | data source | `listWorkspaces` |

```hcl
provider "loom" {
  base_url = "https://<your-loom-host>"   # or $LOOM_BASE_URL
  token    = var.loom_api_token            # or $LOOM_API_TOKEN
}

resource "loom_workspace" "analytics" {
  name = "analytics"
}

resource "loom_item" "bronze" {
  workspace_id = loom_workspace.analytics.id
  item_type    = "lakehouse"
  display_name = "bronze"
}
```

!!! note "Built from source — not on the Terraform Registry"
    This repository does not publish the provider. Run `make build` in
    `sdk/terraform-provider-loom` and point Terraform at the binary with a
    `dev_overrides` block (see the provider README).

!!! warning "Honest lifecycle limitations"
    The API documents `GET`/`POST /api/workspaces` only — there is no workspace
    update or delete route. `loom_workspace` attributes are therefore
    `RequiresReplace`, `Update` errors explicitly, and `Delete` removes the
    resource from state **with a warning** that the workspace still exists in the
    deployment. `loom_item` has full CRUD.

Every route the provider calls is declared in
`internal/client/endpoints.go` and asserted against `sdk/openapi.json` by
`internal/client/contract_test.go`, so the provider cannot drift from the
contract. Acceptance tests run against a live deployment with
`TF_ACC=1 make testacc`; use **OpenTofu** (`TF_ACC_TERRAFORM_PATH=$(command -v tofu)`)
to keep the toolchain MPL-2.0.

## Regenerating the schema reference

The resource attribute tables are derived from the SAME OpenAPI document the API
serves, so they never drift:

```bash
node tools/terraform/generate-schemas.mjs   # → tools/terraform/GENERATED-SCHEMAS.md
node sdk/scripts/dump-openapi.mjs           # → sdk/openapi.json (native provider + Python SDK)
```

## Government

The module is cloud-agnostic — set `loom_api_url` to your Government deployment
host. The API token and every route behave identically; no Fabric dependency.
The native provider is equally cloud-agnostic: only `base_url` changes.

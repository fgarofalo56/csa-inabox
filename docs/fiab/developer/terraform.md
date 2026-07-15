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

A dedicated first-party `terraform-provider-loom` (a Go provider with typed
`loom_workspace` / `loom_item` resources) is on the
[roadmap](../roadmap/loom-sdk-terraform.md). Until it lands, the `restapi`-backed
module is the supported IaC path — **not** a stub: `terraform apply` against a
live deployment creates real resources through the real API.

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

## Regenerating the schema reference

The resource attribute tables are derived from the SAME OpenAPI document the API
serves, so they never drift:

```bash
node tools/terraform/generate-schemas.mjs   # → tools/terraform/GENERATED-SCHEMAS.md
```

## Government

The module is cloud-agnostic — set `loom_api_url` to your Government deployment
host. The API token and every route behave identically; no Fabric dependency.

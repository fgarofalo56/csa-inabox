# `terraform-provider-loom`

A Terraform provider for CSA Loom, built on
[terraform-plugin-framework](https://github.com/hashicorp/terraform-plugin-framework).
It manages Loom **workspaces** and **items** through the same public API the console
serves at `GET /api/openapi.json` — no Azure control-plane calls, no Microsoft Fabric
dependency, and **no cloud host baked in**: point `base_url` at your own Commercial or
Government deployment.

> **Not published.** B-N19b is packaging + CI only. This repository does not push the
> provider to the Terraform Registry; build it from source and use a `dev_overrides` block.

## Resources and data sources

| Address | Kind | Backing operations |
|---|---|---|
| `loom_workspace` | resource | `createWorkspace`, `listWorkspaces` |
| `loom_item` | resource | `createItem`, `getItem`, `updateItem`, `deleteItem` |
| `loom_workspace` | data source | `listWorkspaces` |

Every route the provider calls is declared in `internal/client/endpoints.go` and asserted
against `sdk/openapi.json` by `internal/client/contract_test.go`. Calling an undeclared
route, or keeping a row the API dropped, fails `go test ./internal/client/...`.

### Honest lifecycle limitations

Per the repo's no-vaporware rule, the provider does not pretend to do things the API has
no route for:

- **`loom_workspace` has no update or delete.** The API documents `GET`/`POST /api/workspaces`
  only. All configurable attributes are therefore `RequiresReplace`, `Update` returns an
  explicit error, and `Delete` removes the resource from state **with a warning** stating the
  workspace still exists in the deployment. When the API grows those routes, the contract
  test surfaces the change and the resource gains them.
- **`loom_workspace` read is a filtered list.** There is no `GET /api/workspaces/{id}`, so
  the provider filters `listWorkspaces` client-side rather than inventing an endpoint.
- **`loom_item.state_json` is only tracked when you set it.** Echoing the console's editor
  state into Terraform state would produce permanent drift for items a human edits in the UI.

## Usage

```hcl
terraform {
  required_providers {
    loom = { source = "csa-loom/loom" }
  }
}

provider "loom" {
  base_url = "https://csa-loom.example.gov"   # or $LOOM_BASE_URL
  token    = var.loom_api_token               # or $LOOM_API_TOKEN
}

resource "loom_workspace" "analytics" {
  name        = "analytics"
  description = "Managed by Terraform"
}

resource "loom_item" "bronze" {
  workspace_id = loom_workspace.analytics.id
  item_type    = "lakehouse"
  display_name = "bronze"
}
```

More in [`examples/`](examples/).

Import:

```bash
terraform import loom_workspace.analytics <workspace-id>
terraform import loom_item.bronze lakehouse/<item-id>     # <item_type>/<id>
```

## Building

```bash
cd sdk/terraform-provider-loom
make deps     # go mod tidy — resolves the plugin SDKs and writes go.sum
make build    # -> ./terraform-provider-loom
make vet test # go vet + unit/contract tests (no network, no Terraform CLI)
```

Then point Terraform at the local binary:

```hcl
# ~/.terraformrc  (or %APPDATA%\terraform.rc)
provider_installation {
  dev_overrides { "csa-loom/loom" = "/abs/path/to/sdk/terraform-provider-loom" }
  direct {}
}
```

### Why `go.sum` is not committed

The four plugin SDKs are pinned in `go.mod`; `go mod tidy` (run by `make deps` and by the
`sdk-contract` CI lane before every build) resolves the transitive set and writes `go.sum`.
Committing a lockfile generated on a machine that cannot reach `proxy.golang.org` would be
a fiction. For an air-gapped build, run `make deps && go mod vendor` on a connected host and
carry `vendor/` in.

## Acceptance tests

Unit + contract tests run everywhere. Acceptance tests apply real Terraform against a real
deployment and are opt-in:

```bash
export TF_ACC=1
export LOOM_BASE_URL=https://csa-loom.example.gov
export LOOM_API_TOKEN=loom_pat_<id>_<secret>       # read-write scope
export TF_ACC_TERRAFORM_PATH=$(command -v tofu)    # OpenTofu (MPL-2.0)
make testacc
```

They cover create → read → in-place update → import → destroy for `loom_item`, and
create → data-source lookup → import for `loom_workspace`.

**Use OpenTofu.** `terraform-plugin-testing` shells out to a Terraform-compatible CLI. The
HashiCorp `terraform` binary is BUSL-1.1 from 1.6 onward; OpenTofu is MPL-2.0, so
`TF_ACC_TERRAFORM_PATH=$(command -v tofu)` keeps the whole toolchain permissively licensed.

## Licensing

The provider itself is MIT (repo `LICENSE`). Its four build-time dependencies —
`terraform-plugin-framework`, `terraform-plugin-go`, `terraform-plugin-log`,
`terraform-plugin-testing` — are HashiCorp's, **MPL-2.0**, and are the only way to speak
Terraform's plugin protocol. None of them is baked into a Loom container image; the provider
is a developer artifact built from source. See
[`THIRD_PARTY_LICENSES.md`](../../THIRD_PARTY_LICENSES.md) for the recorded disposition.

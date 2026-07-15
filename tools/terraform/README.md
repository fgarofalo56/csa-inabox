# CSA Loom — Terraform

Provision CSA Loom **workspaces and items as code**, using the Loom public REST
API (`/api/openapi.json`).

## Scope (honest)

This directory ships a **real, `terraform`-consumable module** built on the
community [`Mastercard/restapi`](https://registry.terraform.io/providers/Mastercard/restapi/latest)
provider, which performs full CRUD over any REST API. It is production-usable
today:

- `modules/loom-workspace` — creates/reads/updates/deletes a Loom **workspace**.
- `modules/loom-item` — creates/reads/updates/deletes a Loom **item** (lakehouse,
  notebook, warehouse, … any of the ~120 Azure-native item types) in a workspace.
- `examples/workspace-and-item` — a working root module that provisions a
  workspace **and** a lakehouse item, then outputs their ids.

A **dedicated, first-party `terraform-provider-loom`** (a Go provider with typed
`loom_workspace` / `loom_item` resources, published to the Terraform Registry)
is on the roadmap — see
[`docs/fiab/roadmap/loom-sdk-terraform.md`](../../docs/fiab/roadmap/loom-sdk-terraform.md).
Until it lands, this `restapi`-backed module is the supported IaC path. This is
**not** a "coming soon" stub: `terraform apply` against a live Loom deployment
creates real resources through the real API.

Azure-native by design — no Microsoft Fabric tenant is required
(`.claude/rules/no-fabric-dependency.md`).

## Authentication

Every call authenticates with a **scoped API token** (a `read-write` PAT).
Create one in the console under **Settings → Developer → API tokens**, then:

```bash
export LOOM_API_URL="https://<your-loom-host>"
export TF_VAR_loom_token="loom_pat_<id>_<secret>"
```

## Quick start

```bash
cd examples/workspace-and-item
terraform init
terraform plan  -var "loom_api_url=$LOOM_API_URL"
terraform apply -var "loom_api_url=$LOOM_API_URL"
```

## Generated schema reference

`node generate-schemas.mjs` reads the OpenAPI document (`lib/openapi/spec.ts`)
and regenerates [`GENERATED-SCHEMAS.md`](./GENERATED-SCHEMAS.md) — the resource
attribute reference the modules are derived from. Run it after the API shape
changes so the docs stay in sync with the contract.

## Layout

```
tools/terraform/
├── README.md                       (this file)
├── generate-schemas.mjs            OpenAPI → GENERATED-SCHEMAS.md
├── GENERATED-SCHEMAS.md            generated resource reference
├── modules/
│   ├── loom-workspace/             workspace CRUD module
│   └── loom-item/                  item CRUD module
└── examples/
    └── workspace-and-item/         a working root module
```

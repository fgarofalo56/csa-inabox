# Loom SDK + Terraform provider — roadmap

> **Status: ROADMAP / not yet shipped.** This document describes *planned* work.
> Neither a language SDK (`packages/loom-sdk-*`) nor a Terraform provider
> (`terraform-provider-loom`) exists in the repository today. Nothing here is
> installable yet — it is the design and sequencing for the developer-platform
> Phase 7 (P7) of the [Fabric-parity PRP](../../../PRPs/active/fabric-parity/README.md).
> Per `.claude/rules/no-vaporware.md`, this is disclosed as roadmap, not
> presented as a working feature.
>
> **Update — the TypeScript SDK shipped.** `@csa-loom/sdk`
> ([`apps/loom-sdk`](https://github.com/fgarofalo56/csa-inabox/tree/main/apps/loom-sdk))
> is now a real, published-shape package: a typed `LoomClient` over the Loom REST
> API (workspaces / items / catalog / thread / tokens), cookie **or** scoped-token
> auth, built + unit-tested, released by `publish-loom-sdk.yml`. The **Python
> SDK** (`csa-loom`) and the dedicated Go **Terraform provider** remain the
> roadmap items below — until then, generate a Python client from the OpenAPI
> spec (`openapi-generator-cli -i <host>/api/openapi.json -g python`) and use the
> shipped `restapi`-backed Terraform module (`tools/terraform`).

Fabric ships a Python SDK-style surface (via the Fabric REST API + the
`fabric-cli`) and a community Terraform provider (`microsoft/fabric`). To reach
1:1 developer-experience parity — **Azure-native, no real Fabric tenant** per
`.claude/rules/no-fabric-dependency.md` — Loom needs the same two artifacts
layered on the Loom REST API (the Console BFF), which is the single source of
truth every client already targets.

## What already exists (the foundation these build on)

These are **shipped today** and are what the SDK / provider will wrap — the
roadmap below adds nothing new to the control plane, it re-packages it:

| Shipped artifact | What it gives us |
|---|---|
| **Loom REST API** — the Console BFF routes (`/api/items/*`, `/api/workspaces/*`, `/api/auth/cli-session`, …) | The complete workspace + item control plane, session/RBAC-validated, `{ok,data,error}` envelope. Every client (UI, CLI, SDK, Terraform) speaks this. |
| **`loom` CLI** (`apps/loom-cli`, bin `loom`, `@csa-loom/cli`) | Auth (device-code / SP-secret / SP-cert / MI), workspace + item CRUD, typed item-type taxonomy, `-o json` output. Parity doc: [`../parity/loom-cli.md`](../parity/loom-cli.md). |
| **`packages/loom-skills`** | Reusable agent/skill package — an existing publish target proving the `packages/*` workspace pattern. |

The CLI already implements auth + a typed REST client (`apps/loom-cli/src/client.ts`,
`credentials.ts`, `item-types.ts`). The SDK extracts that transport/auth core
into a reusable library; the CLI then depends on the SDK rather than duplicating
it.

## 1. Loom SDK (Python + TypeScript)

### Goal

Idiomatic, typed client libraries so an engineer can script Loom the way the
Fabric Python SDK scripts Fabric — create workspaces + items, drive editors'
backends (run a data-agent query, publish a report, trigger a pipeline), and
read run history — **without** a Fabric capacity.

### Package layout (planned)

```
packages/
  loom-sdk-ts/        # @csa-loom/sdk        — TypeScript/Node (wraps the same
                      #                         transport the loom CLI already has)
  loom-sdk-py/        # csa-loom (PyPI)      — Python, typed with dataclasses/pydantic
```

### Resource surface (planned, mirrors the BFF)

| SDK namespace | Wraps BFF routes | Parity with Fabric SDK |
|---|---|---|
| `client.auth` | `/api/auth/cli-session` (device-code, client-credentials, MI) | `fabric.auth` / token acquisition |
| `client.workspaces` | `/api/workspaces/*` (CRUD, role assignments) | workspace admin |
| `client.items` | `/api/items/{type}/{id}` (CRUD + typed `state`) | item CRUD across all types |
| `client.items.<type>` typed helpers | per-item action routes (e.g. `data-agent/{id}/chat`, `report/{id}/export`, `pipeline/{id}/run`) | item data-plane operations |
| `client.jobs` | run/schedule routes (P7 scheduler) | Fabric job scheduler API |
| `client.git` | `/api/git-integration/*` | Fabric Git integration |

### Approach

- **Generate, don't hand-write.** Emit an OpenAPI 3.1 description from the BFF
  route contracts (the routes already return the `{ok,data,error}` envelope),
  then generate the typed models for both languages. This keeps the SDK in lock-
  step with the API and avoids drift (a `no-vaporware` risk).
- **Reuse the CLI transport.** `@csa-loom/sdk` lifts `client.ts` /
  `credentials.ts` / `errors.ts` out of `apps/loom-cli`; the CLI then imports the
  SDK. One transport, one auth implementation, tested once.
- **Cloud-aware.** Base URL + auth authority resolved from config so Commercial /
  GCC / GCC-High / IL5 all work (the CLI already does this via `config.ts`).

### Sequencing

1. **P7.1** — Extract the CLI transport/auth into `@csa-loom/sdk` (TS); CLI
   consumes it. No new surface, pure refactor → lowest risk, immediate value.
2. **P7.2** — Emit the OpenAPI description from the BFF routes; add typed
   resource namespaces (`workspaces`, `items`) generated from it.
3. **P7.3** — Python SDK (`csa-loom` on PyPI) generated from the same OpenAPI.
4. **P7.4** — Typed per-item-type helpers + jobs/git namespaces; publish both
   packages (npm + PyPI) with CI release gates.

## 2. Terraform provider (`terraform-provider-loom`)

### Goal

Declarative, stateful management of Loom workspaces + items as
infrastructure-as-code — the analogue of the community `microsoft/fabric`
Terraform provider, but against the Loom REST API and Azure-native backends.

### Provider resources (planned)

| Terraform resource | Wraps | Fabric-provider analogue |
|---|---|---|
| `loom_workspace` | `/api/workspaces` | `fabric_workspace` |
| `loom_workspace_role_assignment` | workspace RBAC | `fabric_workspace_role_assignment` |
| `loom_item` (generic, typed by `type` + `state`) | `/api/items/{type}` | `fabric_*` item resources |
| `loom_lakehouse` / `loom_warehouse` / `loom_data_pipeline` / `loom_report` … (typed convenience resources) | per-item routes | per-type Fabric resources |
| `loom_git_integration` | `/api/git-integration` | `fabric_workspace_git` |
| data sources: `loom_workspace`, `loom_item`, `loom_workspaces` | GET routes | Fabric data sources |

### Approach

- **Terraform Plugin Framework (Go).** Standard provider scaffolding; the
  provider is a thin CRUD client over the same BFF REST API + `{ok,data,error}`
  envelope, authenticating with an SP or MI (identical to the CLI/SDK).
- **State = the item `state` document.** Loom items already persist a typed
  `state` in Cosmos; the provider maps HCL attributes ↔ that document, so
  `terraform plan` diffs against the real item.
- **No Fabric dependency.** The provider never calls `api.fabric.microsoft.com`
  — only the Loom BFF, which fans out to the Azure-native backends.

### Sequencing

1. **P7.5** — Scaffold `terraform-provider-loom` (Go, Plugin Framework) with
   `provider` config + auth against the BFF.
2. **P7.6** — `loom_workspace` + `loom_workspace_role_assignment` + the generic
   `loom_item` resource and matching data sources (the minimum useful set).
3. **P7.7** — Typed convenience resources for the high-value item types
   (lakehouse, warehouse, pipeline, report, data-agent).
4. **P7.8** — Publish to the Terraform Registry (or a private registry for
   Gov); acceptance test provisions a workspace + items end-to-end against a
   live Loom.

## Acceptance (per the PRP)

From `PRPs/active/fabric-parity/PHASES.md` (P7):

> `loom` CLI + SDK call the live BFF; a Terraform apply provisions a workspace +
> items against a live Loom (Azure-native backends, no Fabric on default).

Until those artifacts exist and pass that acceptance test, this remains a
roadmap item and the [parity ledger](../../../PRPs/active/fabric-parity/README.md)
row stays **❌ (roadmap)** — not claimed as built.

## Related

- [`../parity/loom-cli.md`](../parity/loom-cli.md) — the shipped CLI this builds on
- [`../../../PRPs/active/fabric-parity/PHASES.md`](../../../PRPs/active/fabric-parity/PHASES.md) — Phase 7 developer-platform scope
- [`../../../PRPs/active/fabric-parity/appendix-developer-platform.md`](../../../PRPs/active/fabric-parity/appendix-developer-platform.md) — developer-platform capability inventory
</content>
</invoke>

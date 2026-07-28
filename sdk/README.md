# `sdk/` — contract-generated clients for the Loom API

Two first-party clients, both generated from **one** artifact: the OpenAPI 3.1 document a
Loom deployment serves at `GET /api/openapi.json`.

| Path | What it is |
|---|---|
| [`openapi.json`](openapi.json) | The committed snapshot of `buildOpenApiSpec('')`. **Generated — do not hand-edit.** |
| [`scripts/dump-openapi.mjs`](scripts/dump-openapi.mjs) | Re-dumps the snapshot from `apps/fiab-console/lib/openapi/spec.ts`. `--check` fails on drift. |
| [`python/csa-loom/`](python/csa-loom/) | The `csa-loom` Python SDK. Core client generated; zero runtime dependencies. |
| [`terraform-provider-loom/`](terraform-provider-loom/) | The Go Terraform provider (workspace + item resources) on terraform-plugin-framework. |

Neither is published by this repository — packaging + CI only.

## The pipeline

```
apps/fiab-console/lib/openapi/spec.ts          single source of truth
  │  node sdk/scripts/dump-openapi.mjs
  ▼
sdk/openapi.json                               committed snapshot
  ├─ python sdk/python/csa-loom/scripts/generate_client.py
  │     └─ src/csa_loom/_generated/{models,api,contract}.py
  └─ read directly by the Go provider's contract test
        └─ internal/client/endpoints.go must match it
```

## Why drift cannot merge

Five independent gates, each of which fails CI on its own:

| Gate | Where | Catches |
|---|---|---|
| `sdk-snapshot.test.ts` | console vitest suite | API changed, snapshot not re-dumped |
| `dump-openapi.mjs --check` | `sdk-contract` CI lane | same, independently of the console suite |
| `generate_client.py --check` | `sdk-contract` lane + `tests/test_generator.py` | snapshot changed, Python client not regenerated |
| `tests/test_contract.py` | Python SDK | an operation exists on one side only, or a schema reference is dangling |
| `internal/client/contract_test.go` | Go provider | the provider calls a route the API no longer documents |

Plus an opt-in **live** check on both sides: set `LOOM_BASE_URL` and the Python suite
re-runs its coverage assertions against a running deployment's own `/api/openapi.json`
(the route is unauthenticated by design, so no credential is needed) — the post-roll
receipt that Commercial and Government both serve the contract these clients were built from.

## After changing the API

```bash
node sdk/scripts/dump-openapi.mjs                       # 1. refresh the snapshot
python sdk/python/csa-loom/scripts/generate_client.py   # 2. regenerate the Python client
# 3. if you added/removed a route the provider uses, update
#    sdk/terraform-provider-loom/internal/client/endpoints.go
```

Then run the gates:

```bash
cd sdk/python/csa-loom && python -m ruff check . && python -m mypy && python -m pytest
cd ../../terraform-provider-loom && make vet test
```

## Relationship to `tools/terraform/`

`tools/terraform/` holds the **HCL modules** (`loom-workspace`, `loom-item`) built on the
generic `Mastercard/restapi` provider — the zero-build path for teams that do not want to
compile a plugin. `sdk/terraform-provider-loom/` is the **native provider**: real schemas,
plan/diff, import, and typed diagnostics. Both ride the same API and are validated against
the same document; pick whichever fits the consuming team.

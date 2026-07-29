# Third-Party Licenses & NOTICE (LIC0)

This file is the distribution NOTICE manifest for the OSS that CSA Loom **ships**
(bundled into a container image, a wasm asset, or a deployed sidecar service).
It is enforced by `scripts/ci/check-license-inventory.mjs`, which fails CI if any
shipped OSS package carries a **BSL / SSPL / AGPL / GPL** license, or if a new
Python embed appears in a `requirements.txt` without a reviewed entry here.

> **Policy (loom-next-level LIC0, operator-decided 2026-07-22):** the Apache/MIT/
> BSD core set is ACCEPTED. **No BSL, SSPL, AGPL, or GPL in the distributed set.**
> The single opt-in carve-out is **Trino (N7e, Apache-2.0)**. The MinIO S3 gateway
> is **DROPPED** (AGPL-v3). The Univer spreadsheet lab is **gated on a module-level
> license review** before it may ship. Neither MinIO nor Univer is present in any
> shipped dependency list (verified).

The npm production dependency tree of `apps/fiab-console` is separately gated by
`scripts/ci/check-licenses.mjs` (allowlist of permissive SPDX ids; hard-block on
`/A?GPL-/`). This file additionally covers the **non-npm** shipped OSS the npm
checker cannot see: the Python sidecar services, the wasm asset, and the
container-baked engines/extensions.

## Node / npm — shipped in the console image

Full tree gated by `check-licenses.mjs`. Notable distributed OSS embed added by
Phase-4 openness:

| Package | Version | License | Ships as |
|---|---|---|---|
| `@duckdb/duckdb-wasm` | ^1.29.0 | MIT | self-hosted wasm asset under `public/duckdb` (N2a) |

## Python sidecar — `apps/loom-duckdb` (N2b/N3 serving tier)

| Package | Version | License | SPDX |
|---|---|---|---|
| fastapi | 0.115.5 | MIT | MIT |
| uvicorn[standard] | 0.32.1 | BSD-3-Clause | BSD-3-Clause |
| pydantic | 2.10.3 | MIT | MIT |
| duckdb | 1.1.3 | MIT | MIT |
| pyarrow | 18.1.0 | Apache-2.0 | Apache-2.0 |
| azure-identity | 1.19.0 | MIT | MIT |

## Python sidecar — `apps/loom-migrate` (M1 estate-assessment reader)

Source REST calls use the Python standard library (`urllib`) — no third-party
HTTP client — so every embed here is license-reviewed and permissive.

| Package | Version | License | SPDX |
|---|---|---|---|
| fastapi | 0.115.5 | MIT | MIT |
| uvicorn[standard] | 0.32.1 | BSD-3-Clause | BSD-3-Clause |
| pydantic | 2.10.3 | MIT | MIT |
| azure-identity | 1.19.0 | MIT | MIT |

## Python sidecar — `apps/loom-transform-runner` (N4 SQLMesh + dbt)

| Package | Version | License | SPDX |
|---|---|---|---|
| fastapi | 0.115.5 | MIT | MIT |
| uvicorn[standard] | 0.32.1 | BSD-3-Clause | BSD-3-Clause |
| pydantic | 2.10.3 | MIT | MIT |
| dbt-core | 1.8.9 | Apache-2.0 | Apache-2.0 |
| dbt-synapse | 1.8.2 | Apache-2.0 | Apache-2.0 |
| dbt-databricks | 1.8.7 | Apache-2.0 | Apache-2.0 |
| dbt-duckdb | 1.8.4 | Apache-2.0 | Apache-2.0 |
| dbt-fabric | 1.8.7 | Apache-2.0 | Apache-2.0 |
| sqlmesh | 0.132.1 | Apache-2.0 | Apache-2.0 |
| azure-identity | 1.19.0 | MIT | MIT |

## Python sidecar — `apps/fiab-dbt-runner` (dbt runner)

| Package | Version | License |
|---|---|---|
| fastapi | 0.115.5 | MIT |
| uvicorn[standard] | 0.32.1 | BSD-3-Clause |
| pydantic | 2.10.3 | MIT |
| dbt-core | 1.8.9 | Apache-2.0 |
| dbt-synapse | 1.8.2 | Apache-2.0 |
| dbt-fabric | 1.8.7 | Apache-2.0 |
| azure-identity | 1.19.0 | MIT |

## Python sidecar — `apps/fiab-wrangler-host` (data-wrangler host)

| Package | Version | License |
|---|---|---|
| fastapi | 0.115.5 | MIT |
| uvicorn[standard] | 0.32.1 | BSD-3-Clause |
| pydantic | 2.10.3 | MIT |
| pandas | 2.2.3 | BSD-3-Clause |
| numpy | 2.1.3 | BSD-3-Clause |

## Python sidecar — `apps/fiab-prpt-renderer` (document/report renderer)

| Package | Version | License |
|---|---|---|
| flask | >=3.0 | BSD-3-Clause |
| gunicorn | >=22.0 | MIT |
| reportlab | >=4.2.0 | BSD-3-Clause |
| openpyxl | >=3.1.5 | MIT |
| python-docx | >=1.1.2 | MIT |

## Container-baked engines & extensions (not a package manifest — deployed images)

Every row whose "Image" column is populated is enforced by
`check-license-inventory.mjs`: the `FROM` line of an `apps/*/Dockerfile` must resolve to a
repository listed in `REVIEWED_IMAGES` **and** appear here, or CI fails. Language/OS base
images (`node`, `python`, `debian`, `golang`, `rust`, `amazoncorretto`, `mcr.microsoft.com/*`,
`gcr.io/distroless/*`) are the runtime rather than a shipped OSS product and are governed by
the base-image CVE gate instead.

| Component | Image | License | Deployed by | Notes |
|---|---|---|---|---|
| Unity Catalog OSS ("Loom Unity" metastore + Iceberg REST catalog, N1/LU-1) | `unitycatalog/unitycatalog` | Apache-2.0 | `loom-unity-app.bicep`, `iceberg-catalog-aca.bicep` | bridges Delta+Iceberg; the Gov default UC backend |
| **Delta Sharing reference server ("loom-sharing", LU-9)** | `deltaio/delta-sharing-server` | Apache-2.0 | `loom-sharing-app.bicep` | open Delta Sharing protocol over the SAME ADLS Gen2 Delta tables the lakehouse writes. Image published by the upstream build itself (`build.sbt` `dockerUsername := "deltaio"`), so it is the same Apache-2.0 codebase — not a third-party redistribution. INTERNAL ingress only: the server has a single global bearer and cannot scope a caller to a subset of shares, so per-recipient authorization is enforced in the Console BFF (`/api/delta-sharing/*`). |
| RisingWave (streaming-SQL tier, N7a) | `risingwavelabs/risingwave` | Apache-2.0 | `loom-risingwave-aca.bicep` | single-node stateful streaming engine; consumes Event Hubs (Kafka endpoint), sinks Delta/Iceberg; runs in-boundary/air-gap-safe |
| Debezium Connect (CDC runtime) | `quay.io/debezium/connect` | Apache-2.0 | `apps/fiab-mirroring-engine` | source-database change capture into the bronze layer |
| tileserver-gl (sovereign OSS maps tier) | `maptiler/tileserver-gl` | BSD-2-Clause | `loom-maps-app.bicep` | self-hosted vector tiles; replaces Azure Maps where unavailable |
| DuckDB embedded binary (N2b) | — | MIT | `duckdb-aca.bicep` | single embedded engine |
| **s3proxy (S3-compatible ADLS gateway, N8)** | `andrewgaul/s3proxy` | Apache-2.0 | `s3-gateway-aca.bicep` | Upstream image `docker.io/andrewgaul/s3proxy:3.3.0`, built from github.com/gaul/s3proxy whose LICENSE reads "Licensed under the Apache License, Version 2.0". Deployed by DEFAULT (internal ingress, identity-based ADLS auth via DefaultAzureCredential, read-only, scale-to-zero). Nothing from it is bundled into a Loom-built image — it is pulled as an unmodified upstream artifact, so this is a NOTICE row, not a redistribution. It is the permissive replacement for the AGPL MinIO gateway below. |
| DuckDB embedded binary (N2b) | — | MIT | `duckdb-aca.bicep` | single embedded engine |
| DuckDB `azure` / `httpfs` / `delta` / `iceberg` / `postgres` / `ducklake` extensions | — | MIT | baked into `apps/loom-duckdb` image | in-boundary/air-gap-safe (no extension repo at runtime). `postgres` + `ducklake` back the N8 DuckLake catalog `ATTACH`. |
| Apache XTable / delta-rs (dual-metadata emit path, N1) | — | Apache-2.0 | Synapse Spark job (N1) | Delta↔Iceberg metadata |
| PostgreSQL JDBC driver (`org.postgresql:postgresql`, LU-1) | — | BSD-2-Clause | baked into `apps/loom-unity` image | Entra-only Postgres persistence for Loom Unity; pinned + SHA256-verified at build |

## Client SDKs — `sdk/` (B-N19b; NOT baked into any deployed image)

Both first-party SDKs are **developer artifacts built from source**. Neither is baked into a
Loom container image, a wasm asset, or a deployed sidecar, and this repository publishes
neither (no PyPI push, no Terraform Registry push). They are recorded here anyway so the
distribution posture of everything under version control is visible in one place.

### `sdk/python/csa-loom` — the `csa-loom` Python SDK

**Zero runtime dependencies.** The transport is `urllib` from the Python standard library, so
there is nothing to license-review and nothing to resolve on an air-gapped install.

| Package | Version | License | Role |
|---|---|---|---|
| _(none)_ | — | — | runtime dependency list is empty by design |

Dev-only tooling (`pip install -e ".[dev]"`, never distributed): `ruff` (MIT), `mypy` (MIT),
`pytest` (MIT), `hatchling` (MIT).

### `sdk/terraform-provider-loom` — the Go Terraform provider

Terraform's plugin protocol can only be spoken through HashiCorp's own SDKs; there is no
MIT/Apache-licensed alternative. All four are **MPL-2.0** — a file-level weak copyleft that is
outside the forbidden set (no AGPL/GPL/BSL/SSPL) and is the universal license for every
provider in the ecosystem. The provider binary is not distributed by this repository.

| Module | Version | License | Role |
|---|---|---|---|
| `github.com/hashicorp/terraform-plugin-framework` | v1.13.0 | MPL-2.0 | provider/resource/data-source implementation |
| `github.com/hashicorp/terraform-plugin-go` | v0.25.0 | MPL-2.0 | protocol v6 types (`tfprotov6`) |
| `github.com/hashicorp/terraform-plugin-log` | v0.9.0 | MPL-2.0 | structured provider logging |
| `github.com/hashicorp/terraform-plugin-testing` | v1.11.0 | MPL-2.0 | acceptance-test harness (test-only) |

The Loom API client inside the provider is standard-library only (`net/http`,
`encoding/json`) — the `sdk-contract` CI lane fails the build if any direct dependency
outside `github.com/hashicorp/terraform-plugin-*` appears in `go.mod`.

**CLI note:** the acceptance harness shells out to a Terraform-compatible CLI at test time.
The HashiCorp `terraform` binary is **BUSL-1.1** from 1.6 onward, so the documented and
recommended choice is **OpenTofu (MPL-2.0)** via `TF_ACC_TERRAFORM_PATH=$(command -v tofu)`.
No Terraform CLI is required to build, vet or unit-test the provider.

## Deliberately NOT shipped (license posture)

| Component | License | Disposition |
|---|---|---|
| MinIO S3 gateway | AGPL-v3 | **DROPPED** — the N8 S3-compat lab ships on the permissive path instead: `s3proxy` (Apache-2.0), deployed by default via `s3-gateway-aca.bicep` (see the container-baked table above). Not present in any requirements. |
| Univer spreadsheet | (module review) | **GATED** on a module-level license review before it may ship. Not present in any requirements. |
| Trino / Starburst (N7e) | Apache-2.0 | opt-in carve-out (heavy AKS tier); permissive, allowed. |
| HashiCorp `terraform` CLI (≥ 1.6) | BUSL-1.1 | **NOT bundled and NOT required.** Acceptance tests document OpenTofu (MPL-2.0) instead. |

---
_Regenerate the inventory tables from source with `node scripts/ci/check-license-inventory.mjs --list`; the guard
fails CI on any shipped package with a copyleft (A?GPL / BSL / SSPL) license or any un-reviewed new Python embed._

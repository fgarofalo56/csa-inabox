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

| Component | License | Deployed by | Notes |
|---|---|---|---|
| Unity Catalog OSS (Iceberg REST catalog, N1) | Apache-2.0 | `iceberg-catalog-aca.bicep` | bridges Delta+Iceberg; Loom already runs UC-OSS in Gov |
| DuckDB embedded binary (N2b) | MIT | `duckdb-aca.bicep` | single embedded engine |
| DuckDB `azure` / `httpfs` / `delta` / `iceberg` extensions | MIT | baked into `apps/loom-duckdb` image | in-boundary/air-gap-safe (no extension repo at runtime) |
| Apache XTable / delta-rs (dual-metadata emit path, N1) | Apache-2.0 | Synapse Spark job (N1) | Delta↔Iceberg metadata |
| RisingWave (streaming-SQL tier, N7a) | Apache-2.0 | `loom-risingwave-aca.bicep` | single-node stateful streaming engine; consumes Event Hubs (Kafka endpoint), sinks Delta/Iceberg; runs in-boundary/air-gap-safe |

## Deliberately NOT shipped (license posture)

| Component | License | Disposition |
|---|---|---|
| MinIO S3 gateway | AGPL-v3 | **DROPPED** — the N8 S3-compat lab proceeds only via a permissively-licensed path (e.g. `s3proxy` Apache-2.0) or is cut. Not present in any requirements. |
| Univer spreadsheet | (module review) | **GATED** on a module-level license review before it may ship. Not present in any requirements. |
| Trino / Starburst (N7e) | Apache-2.0 | opt-in carve-out (heavy AKS tier); permissive, allowed. |

---
_Regenerate the inventory tables from source with `node scripts/ci/check-license-inventory.mjs --list`; the guard
fails CI on any shipped package with a copyleft (A?GPL / BSL / SSPL) license or any un-reviewed new Python embed._

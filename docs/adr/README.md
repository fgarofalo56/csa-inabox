[Home](../../README.md) > [Docs](../) > **Architecture Decision Records**

# Architecture Decision Records (ADRs)

> Architects, platform engineers, auditors, federal customers preparing
> ATO packages

!!! note
    **Quick Summary**: This directory captures the *why* behind the core
    technology choices in CSA-in-a-Box. Each record follows the
    [MADR](https://adr.github.io/madr/) format. Records are immutable once
    accepted — revisions happen by adding a superseding ADR with an
    incremented number.

---

## Index

| # | Title | Status | Date | One-line summary |
|---|---|---|---|---|
| [0001](./0001-adf-dbt-over-airflow.md) | ADF (+ dbt) over Airflow as primary orchestration | accepted | 2026-04-19 | Managed Gov PaaS orchestrator with SQL-native transforms and Purview lineage. |
| [0002](./0002-databricks-over-oss-spark.md) | Azure Databricks over open-source Spark-on-AKS for heavy compute | accepted | 2026-04-19 | Managed Spark + Unity Catalog + Photon in Gov; OSS Spark on AKS is too operationally expensive. |
| [0003](./0003-delta-lake-over-iceberg-and-parquet.md) | Delta Lake over Iceberg and Parquet as canonical table format | accepted | 2026-04-19 | Delta is Databricks- and Fabric-OneLake-native with ACID MERGE and Purview lineage. |
| [0004](./0004-bicep-over-terraform.md) | Bicep over Terraform as primary IaC (for now; Terraform path planned) | accepted | 2026-04-19 | Day-one Azure API coverage, no state-file custody, aligned to Enterprise-Scale Landing Zone. |
| [0005](./0005-event-hubs-over-kafka.md) | Event Hubs over open-source Kafka for streaming ingestion | accepted | 2026-04-19 | Managed PaaS broker with Kafka-protocol endpoint, Capture to Bronze, Gov-GA. |
| [0006](./0006-purview-over-atlas.md) | Microsoft Purview over Apache Atlas for data catalog and lineage | accepted | 2026-04-19 | Gov-GA catalog with MIP label propagation and native Azure scanners. |
| [0007](./0007-azure-openai-over-self-hosted-llm.md) | Azure OpenAI over self-hosted LLM for AI integration | accepted | 2026-04-19 | FedRAMP High inference endpoint with Private Endpoints; self-hosted fallback remains open. |
| [0008](./0008-dbt-core-over-dbt-cloud.md) | dbt Core over dbt Cloud for transformations | accepted | 2026-04-19 | Open-source CLI keeps metadata inside the tenant boundary; no SaaS FedRAMP surface to clear. |
| [0009](./0009-sqlite-to-postgres-portal-db.md) | SQLite (portal dev) → Postgres (portal prod) phased database strategy | accepted | 2026-04-19 | Zero-install dev loop; managed Postgres PaaS in Gov for production durability. |
| [0010](./0010-fabric-strategic-target.md) | Microsoft Fabric as strategic target; current build as Fabric-parity on Azure PaaS | accepted | 2026-04-19 | Every primitive (Delta, Purview, dbt, Spark) maps forward into Fabric when Gov GA lands. |
| [0011](./0011-multi-cloud-scope.md) | Multi-cloud scope: OneLake shortcuts + Purview scans only; defer federated compute | accepted | 2026-04-20 | Honest scope — ships governance story for S3/GCS/Snowflake/BigQuery/Redshift; defers cross-cloud compute. |
| [0012](./0012-data-mesh-federation.md) | Data-mesh federation model: contract-driven, Purview-governed, portal-surfaced | accepted | 2026-04-20 | Contract-first in-monorepo mesh — `contract.yaml` → CI validates → Purview registers → marketplace surfaces; per-domain CODEOWNERS. |
| [0013](./0013-dbt-as-canonical-transformation.md) | dbt Core as the canonical transformation layer | accepted | 2026-04-20 | Deduplicates Bronze → Silver → Gold logic — dbt owns medallion transforms; Spark notebooks are deprecated for that path and reserved for exploration / provisioning / ML. |
| [0014](./0014-msal-bff-auth-pattern.md) | MSAL Backend-for-Frontend (BFF) auth pattern | accepted | 2026-04-20 | Phased CSA-0020 remediation — Phase 1 strict CSP + Trusted Types on the SPA; Phase 2 server-side Auth Code + PKCE flow with an httpOnly `csa_sid` session cookie. Tokens never reach the browser. |
| [0015](./0015-postgres-portal-persistence.md) | Portal persistence: StoreBackend protocol + SQLite (dev) + Postgres Flexible Server (prod) | accepted | 2026-04-20 | CSA-0046 implementation — dual-backend Protocol, managed-identity AAD tokens for Azure Database for PostgreSQL Flexible Server, Alembic migrations, SQLite kept as the zero-install dev loop. |
| [0016](./0016-async-store-backend.md) | Async `StoreBackend` canonical; sync layer transitional | accepted | 2026-04-20 | CSA-0046 follow-on — `AsyncStoreBackend` Protocol + `AsyncSqliteStore` (aiosqlite) + `AsyncPostgresStore` (asyncpg + SQLAlchemy AsyncEngine); FastAPI routers go `async def` via Depends; migration CLI ships; sync layer kept one release for backward compat. |
| [0017](./0017-rag-service-layer.md) | RAG pipeline service-layer extraction (CSA-0133) | accepted | 2026-04-20 | Split the 1,285-line `pipeline.py` god-class into six submodules behind a `RAGService` facade; legacy `pipeline` module is preserved as a compat shim for one release. |
| [0018](./0018-fabric-rti-adapter.md) | Fabric Real-Time Intelligence adapter (pre-GA, env-gated) | accepted | 2026-04-20 | CSA-0137 follow-on — ship `FabricRTISource` today behind `FABRIC_RTI_ENABLED`; raise-with-pointer when the flag is unset so Gov tenants fail loudly until RTI Gov-GA lands. |
| [0019](./0019-bff-reverse-proxy.md) | BFF reverse-proxy + HMAC-sealed MSAL token cache | accepted | 2026-04-20 | CSA-0020 Phase 3 — mount `/api/*` proxy behind `BFF_PROXY_ENABLED`; persist MSAL `SerializableTokenCache` to Redis with HMAC sealing so a Redis compromise is tamper-evident. Completes AQ-0012's long-term column — tokens never reach the browser. |
| [0020](./0020-portal-observability-and-rate-limiting.md) | Portal observability (OTel + Prometheus) and per-principal rate limiting | accepted | 2026-04-20 | CSA-0042 / CSA-0061 / CSA-0030 — OpenTelemetry with OTLP exporter + W3C trace-context, Prometheus `/metrics` on a private registry, per-principal sliding-window rate limiter on every write endpoint.  All three feature-flagged and lazy-imported so the portal still boots without the optional extras. |
| [0021](./0021-two-rate-limiters-not-duplicates.md) | Two rate limiters are intentional, not duplicates | accepted | 2026-04-23 | The portal write-path limiter (per-principal, sliding-window, observability) and the AI router limiter (per-IP, fixed-window, abuse-defense) protect orthogonal failure modes; do not collapse them. |
| [0022](./0022-copilot-surfaces-vs-docs-widget.md) | Copilot surfaces vs. docs-site widget are intentional, not duplicates | accepted | 2026-04-23 | The Azure Function (`func-csa-inabox-copilot-fg`) is the production chat backend; the docs-site widget (`docs/javascripts/copilot-chat.js`) is a thin client that talks to it. Two artifacts, one service. |
| [0023](./0023-release-please-status-bypass.md) | release-please PRs auto-pass required status checks | accepted | 2026-04-27 | GITHUB_TOKEN-created PRs don't trigger downstream workflows, leaving release PRs permanently BLOCKED. The release-please workflow itself posts `success` commit statuses for each required check on the PR head SHA, gated on a strict allow-list of three version-metadata files. |

---

## Format

All records follow [MADR 3.x](https://adr.github.io/madr/). Each ADR
has frontmatter (`status`, `date`, `deciders`, `consulted`, `informed`)
and these sections:

- Context and Problem Statement
- Decision Drivers
- Considered Options
- Decision Outcome
- Consequences (positive *and* negative)
- Pros and Cons of the Options
- Validation (how we'll know the decision was right)
- References (decision trees, concrete code, compliance-control mappings)

## Status lifecycle

```
proposed  →  accepted  →  deprecated
                   │
                   └──────→  superseded by NNNN
```

- **proposed** — open for comment on a PR.
- **accepted** — merged; the decision is in effect.
- **deprecated** — no longer in effect; no replacement chosen yet.
- **superseded by NNNN** — replaced by a newer ADR. The superseding ADR
  states what changed and why; the superseded ADR stays on disk as
  history.

ADRs are **immutable** once accepted. Corrections are made by authoring a
new ADR that supersedes the old one. Typos and broken links may be fixed
without superseding.

## Authoring a new ADR

1. Copy [`0001-adf-dbt-over-airflow.md`](./0001-adf-dbt-over-airflow.md)
   as a template.
2. Increment the number (4-digit, zero-padded).
3. Slugify the title (`NNNN-short-slug.md`).
4. Keep the frontmatter + section order identical to 0001.
5. Cite at least one concrete artifact in the repo and at least one
   compliance-control mapping from `governance/compliance/*.yaml` when
   the decision maps to a control family.
6. Link forward to any relevant decision tree under
   [`docs/decisions/`](../decisions/).
7. Open a PR. Reviewers from security, governance, and dev-loop are
   expected. Status stays `proposed` until the PR merges.

## Cross-references

- **Decision trees** (scenario-driven, "which option for what
  situation"): [`docs/decisions/`](../decisions/).
- **Architecture reference** (current-stack narrative):
  [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).
- **Compliance control matrices**:
  [`governance/compliance/`](../../csa_platform/governance/compliance/) —
  `nist-800-53-rev5.yaml`, `hipaa-security-rule.yaml`,
  `cmmc-2.0-l2.yaml`.

## Upstream references

- [MADR documentation](https://adr.github.io/madr/)
- [adr-tools](https://github.com/npryce/adr-tools) (CLI for managing ADRs)
- Michael Nygard's original ADR essay:
  ["Documenting Architecture Decisions"](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)

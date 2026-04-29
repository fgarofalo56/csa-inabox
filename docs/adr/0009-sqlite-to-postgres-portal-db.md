---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0009 — SQLite (portal dev) → Postgres (portal prod) phased database strategy

## Context and Problem Statement

The CSA-in-a-Box portal (`portal/`) maintains operational state: source
registrations, access requests, marketplace entries, and pipeline
metadata. Dev-loop experience matters — contributors should clone the
repo and have a running portal in minutes with zero Azure credentials.
Production, however, must be multi-writer, backed-up, durable, and
FedRAMP-authorized. We need a single ORM model that works across both
environments without divergent SQL.

## Decision Drivers

- **Dev-loop ergonomics** — fresh clone should run the portal locally
  without provisioning cloud infra or installing a database server.
- **Production durability** — multi-writer, PITR backups, HA, FedRAMP
  High inheritance.
- **ORM portability** — one schema, one set of migrations; no
  branch-by-environment SQL.
- **Azure Gov availability** — production DB must be PaaS in Gov.
- **Cost** — development should be free; production should scale with
  tenant size.

## Considered Options

1. **SQLite in dev → Azure Database for PostgreSQL Flexible Server in
   prod (chosen)** — Phased, ORM-portable, zero-install dev, managed Gov
   PaaS in prod.
2. **Postgres in every environment** — Uniform but requires Docker
   Postgres locally; raises the contributor friction floor.
3. **Azure SQL Database (and Azure SQL Edge locally)** — Microsoft-native,
   T-SQL features, but ORM differences vs. Postgres JSON types.
4. **Cosmos DB (NoSQL)** — Global distribution, schema-less, but the
   portal's data model is strongly relational.

## Decision Outcome

Chosen: **Option 1 — SQLite for local dev, Azure Database for PostgreSQL
Flexible Server for production**, with a single SQLAlchemy ORM + Alembic
migrations. Feature flags gate Postgres-only features (JSONB indexes,
`ltree`) with SQLite-compatible fallbacks.

## Consequences

- Positive: `pip install -e .` + `uvicorn` gives a working portal with no
  external dependencies — lowest-friction onboarding in the repo.
- Positive: Production runs on managed PaaS with HA, PITR, and FedRAMP
  inheritance.
- Positive: Single ORM model + Alembic migrations; no branch-by-env SQL.
- Positive: Matches the two-tier pattern already in use for
  `portal/shared/` (see `portal/shared/.env.example` for DATABASE_URL
  switching).
- Negative: SQLite lacks JSONB, arrays, and concurrent writers — feature
  parity requires discipline (and unit tests on both backends).
- Negative: Integration tests must run against Postgres to catch
  backend-specific behavior; SQLite-only CI is insufficient.
- Negative: Migration authors must test on both backends — a real tax on
  every schema change.
- Neutral: The choice does not preclude future moves to Azure SQL or
  Cosmos if the data model evolves; the ORM abstracts most differences.

## Pros and Cons of the Options

### Option 1 — SQLite dev → Postgres prod

- Pros: Zero-install dev; managed Gov PaaS in prod; single ORM; Alembic
  migrations; matches cloud-native FedRAMP inheritance.
- Cons: Feature disparity (JSONB, concurrency); requires dual-backend
  testing in CI.

### Option 2 — Postgres everywhere

- Pros: Uniformity; no feature gaps; simpler migration testing.
- Cons: Docker/Postgres required locally; higher contributor friction;
  slower cold starts on dev machines.

### Option 3 — Azure SQL Database

- Pros: Microsoft-native; T-SQL features; strong Azure integration.
- Cons: Weaker JSON support than Postgres; ORM ergonomics less favored
  in the Python community; no free local equivalent.

### Option 4 — Cosmos DB

- Pros: Global distribution; schema-less; multi-region writes.
- Cons: Wrong shape for the portal's relational data; no local-dev
  parity; cost profile is wrong for this workload.

## Validation

We will know this decision is right if:

- New contributors run the portal locally within 10 minutes of clone.
- Alembic migrations apply cleanly on both SQLite and Postgres in CI.
- If Postgres-only features become unavoidable (e.g. `ltree` for
  hierarchical glossary terms), we graduate to Option 2 (Postgres
  everywhere with `docker-compose`).

## References

- Decision tree: n/a (operational DB choice; see portal README)
- Related code: `portal/shared/.env.example`,
  `portal/shared/api/main.py`, `portal/shared/api/routers/access.py`,
  `portal/shared/api/routers/marketplace.py`,
  `portal/shared/api/routers/pipelines.py`,
  `portal/shared/api/routers/sources.py`,
  `portal/kubernetes/docker/.env.example`
- Framework controls: NIST 800-53 **CP-9** (Postgres PITR backups),
  **SC-28** (encryption at rest via storage-account CMK),
  **AU-9** (audit record protection — DB audit logs to Log Analytics),
  **AC-2** (account management — portal accounts stored in Postgres,
  federated with Entra ID). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- HIPAA Security Rule: §164.312(a)(2)(iv) (encryption and decryption at
  rest). See `governance/compliance/hipaa-security-rule.yaml`.
- Discussion: CSA-0087

---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security, governance, federal-architects
informed: all
---

# ADR 0011 — Multi-cloud scope: OneLake shortcuts + Purview scans only; defer federated compute

## Context and Problem Statement

Vision §1 names multi-cloud as a first-class capability of CSA-in-a-Box.
In reality the codebase is single-cloud (Azure) with an OSS-on-Kubernetes
Helm escape hatch. There is no AWS S3 / Glue / Redshift / EMR / SageMaker
story, no GCP BigQuery / Dataplex / Vertex AI story, and no cross-cloud
data contract. Federal and enterprise customers routinely have
multi-cloud footprints (S3, BigQuery, Snowflake) that need a governance
and read-federation story **without** a full re-platform. We must decide
a scope that is honest about what ships in v1 versus what is roadmap.

## Decision Drivers

- **Honest scope** — do not claim cross-cloud compute federation we have
  not built. Vision §1 must be defensible against a code walkthrough.
- **Governance-first** — catalog, classification, and lineage are what
  most federal customers actually ask for on the first call; cross-cloud
  compute is a second-order request.
- **Azure Government parity** — any capability we include must be
  available in Azure Government today, not forecast. This mirrors the
  constraint already in force for ADR-0001 (ADF), ADR-0005 (Event Hubs),
  and ADR-0006 (Purview).
- **Composability** — the chosen scope must compose cleanly into future
  federation work (Unity Catalog cross-cloud, Trino, Denodo) without
  forcing a rewrite.
- **Effort** — a full cross-cloud Unity Catalog / Denodo / Trino build is
  multi-session L/XL effort (12–18 months). OneLake shortcuts + Purview
  cross-cloud scans are deployable today on native Microsoft capability.

## Considered Options

1. **Full multi-cloud** — OneLake shortcuts + Purview cross-cloud scans
   + Unity Catalog federation + Trino or Denodo cross-cloud compute.
   Complete vision but 12–18 months of effort; most of the near-term
   federal-customer value is already covered by the first two items.
2. **Scoped multi-cloud (CHOSEN)** — OneLake shortcuts to S3 and GCS
   (read-only federation, no transformation) + Purview cross-cloud scans
   of Snowflake, BigQuery, and Redshift (catalog + classification; no
   compute). Ships the governance and read-federation story federal
   customers actually need today; defers cross-cloud compute federation
   to a future ADR.
3. **Single-cloud-only + migration playbooks** — drop multi-cloud from
   the vision entirely and rely on the four migration playbooks
   (Palantir, Snowflake, AWS, GCP) to onboard customers. Simpler but
   cuts off the "stay on multiple clouds while using CSA-in-a-Box as
   the governance plane" pattern that many federal tenants need.
4. **OSS escape hatch only** — keep the current state; position
   OSS-on-K8s (Trino + Atlas) as the multi-cloud answer and let
   customers own the operational burden. Shifts effort to the customer
   and contradicts the managed-PaaS posture of ADRs 0001, 0005, 0006.

## Decision Outcome

Chosen: **Option 2 — Scoped multi-cloud (OneLake shortcuts + Purview
cross-cloud scans)**.

The in-scope capabilities for v1 are:

- **OneLake shortcuts to S3 and GCS** — read-only federation. Objects
  in S3 or GCS are surfaced inside OneLake without copying. No
  transformation, no write-back.
- **Purview cross-cloud scans** — Purview connectors scan Snowflake,
  BigQuery, and Redshift for catalog metadata and classification. No
  compute federation; lineage is catalog-level only.

Explicitly **deferred** (roadmap, not committed in v1):

- Unity Catalog cross-cloud federation
- Denodo or Trino-based cross-cloud compute federation
- Cross-cloud write paths (any S3 or GCS write-back)
- AWS Glue / EMR / SageMaker and GCP Dataplex / Vertex AI integration

A follow-up ADR will be authored if and when federated compute is
promoted from roadmap to committed scope.

## Consequences

- Positive: **Honest scope** — vision §1 claims become defensible, and
  the codebase matches the narrative.
- Positive: **Governance-first** — matches the Purview-primary
  positioning already locked in by ADR-0006.
- Positive: **Gov-ready** — both chosen capabilities are available in
  Azure Government today, consistent with the Gov-first constraint.
- Positive: **Composable** — future cross-cloud compute federation
  (Unity Catalog, Trino) can sit on top of OneLake shortcuts and
  Purview metadata without requiring a rewrite.
- Positive: **Effort-bounded** — both capabilities are deployable in
  the current release window; no dependency on OSS clusters the
  customer must operate.
- Negative: **No cross-cloud compute in v1** — customers needing
  federated query across clouds must use the migration playbooks or
  wait for a future ADR on federated compute.
- Negative: **Writes are out of scope** — OneLake shortcuts are
  read-only; any write-back to S3 or GCS is not part of v1.
- Negative: **Deferred work must be tracked** — Unity Catalog
  federation, Denodo, and Trino stay open as roadmap items; this ADR
  explicitly does not close those doors but does not commit them.

## Pros and Cons of the Options

### Option 1 — Full multi-cloud
- Pros: Complete vision story; cross-cloud compute and governance both
  covered; maximum optionality for customers.
- Cons: 12–18 months of effort; requires standing up Unity Catalog
  cross-cloud or a Trino/Denodo plane; large Gov-parity risk because
  cross-cloud compute connectors vary in Gov availability.

### Option 2 — Scoped multi-cloud (OneLake shortcuts + Purview scans)
- Pros: Ships today on Gov-available capability; governance-first
  matches Purview primacy (ADR-0006); composes forward; covers the
  dominant federal-customer ask (read + catalog) without overcommit.
- Cons: No cross-cloud compute federation; read-only; cross-cloud
  write-back is out of scope.

### Option 3 — Single-cloud-only + migration playbooks
- Pros: Simplest scope; fully consistent with Azure-native posture;
  migration playbooks already exist.
- Cons: Cuts off the "multi-cloud governance plane" customer pattern;
  removes a stated vision §1 capability entirely; weakens the federal
  story where tenants keep AWS or GCP footprints for existing
  contracts.

### Option 4 — OSS escape hatch only
- Pros: No net-new Microsoft-stack work; positions OSS-on-K8s as the
  multi-cloud answer.
- Cons: Shifts operational burden to the customer; contradicts the
  managed-PaaS default; Atlas-over-Purview conflicts with ADR-0006;
  Trino/Spark HA ownership conflicts with ADR-0002.

## Validation

We will know this decision is right if:

- Federal customers asking for cross-cloud read governance ship
  successfully using OneLake shortcuts plus Purview cross-cloud scans,
  without blocking on federated compute.
- More than 30% of customer asks in the first six months require
  cross-cloud compute federation — at that point we revisit with a new
  ADR expanding scope (Unity Catalog cross-cloud or Trino/Denodo).
- Purview cross-cloud scan coverage for Snowflake, BigQuery, and
  Redshift matches the in-tenant Azure coverage within one quarter of
  GA in Azure Government.

## References

- Vision §1 (multi-cloud capability statement) — [`docs/VISION.md`](../VISION.md)
- Fabric primacy rewrite (CSA-0063) and ADR-0010 —
  [`./0010-fabric-strategic-target.md`](./0010-fabric-strategic-target.md)
- Purview catalog strategy — [`./0006-purview-over-atlas.md`](./0006-purview-over-atlas.md)
- Migration playbooks (Palantir, Snowflake, AWS, GCP) —
  [`docs/migrations/`](../migrations/)
- Fabric vs Databricks vs Synapse decision tree —
  [`docs/decisions/`](../decisions/)
- Framework controls: NIST 800-53 **CA-3** (system interconnections for
  cross-cloud scans), **AC-4** (information-flow enforcement across the
  S3/GCS shortcut boundary), **CM-7** (least-functionality — read-only
  federation). Mapped in
  [`governance/compliance/nist-800-53-rev5.yaml`](../../governance/compliance/nist-800-53-rev5.yaml).
- Finding: **CSA-0140** / approved ballot item **E11** / **AQ-0035**.

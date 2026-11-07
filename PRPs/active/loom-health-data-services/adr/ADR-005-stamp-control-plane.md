# ADR-005 — Stamp (cell) topology and the health control plane

Status: Proposed (operator decision 4 in the mandate fixes the stamp model; this ADR fixes its shape). Date: 2026-10-22.

## Context
"Scale by adding stamps; limit blast radius; no single giant database." The
largest customers (all VA, all IHS) are many organisations with regional
operational boundaries (VISNs, Areas).

## Decision
- **Stamp** = region + AKS + PostgreSQL Flexible Server + Blob accounts + Event
  Hubs + Key Vault + Log Analytics + private DNS + ingress + the engine
  Deployments, created by `platform/fiab/bicep/modules/health/stamp.bicep`
  (resource group `rg-csa-loom-health-<stamp>-<region>`), class S/M/L
  (`../CAPACITY-MODEL.md` section 5). Stamps are symmetrical; no stamp is special.
- **Tenant** = one organisation boundary; lives on one stamp; provisioned by
  `tenant.bicep` + control-plane API (database, containers, keys, quotas, DNS
  names). Creating the Loom `health-tenant` item does this (auto-bind).
- **Control plane** (regional service `apps/loom-health-cp`, backed by Loom's
  Cosmos for registries and a PostgreSQL for the MPI):
  - stamp registry (class, region, status: creating/healthy/draining/paused/
    evacuated, deploy SHA, engine versions),
  - tenant registry (stamp pointer, quotas, keys, policy bundle version, feeds),
  - routing map publisher (to APIM / ingress),
  - authorization server (ADR-010) and PDP bundle distribution (ADR-011),
  - MPI (ADR-006),
  - lifecycle operations (create/grow/drain/evacuate/pause/resume/destroy) as
    audited, idempotent jobs with receipts,
  - SLO and capacity aggregation for the admin surface.
  The control plane never holds clinical data; it holds identities, pointers,
  policy and telemetry. It is deployed per cloud (Commercial, GCC-High) and
  within a cloud can be multi-region active/active because its stores are
  Loom's existing Cosmos (multi-region) and a small PostgreSQL with a replica.
- **Alignment defaults**: VA = one stamp per VISN (18), tenants = VISNs
  (facilities as partitions); IHS = one stamp per 3 Areas (4), tenants = Areas;
  Commercial = one stamp per customer region. Decision D4 confirms.
- **Shared services across stamps**: only the control plane, the image registry
  (ACR, per cloud), the terminology package feed (Blob), and the SIEM.

## Consequences
More resource groups and accounts to manage; mitigated by bicep and the admin
surface. Cross-stamp queries are explicit control-plane operations, never
implicit joins. Cost per stamp has a floor (~$22-25 k/mo class M, Gov) so
small customers use class S or a shared Commercial stamp.

## Reversal cost
Low for the number and alignment of stamps (configuration); high for "no
stamps" (would require a different data architecture).

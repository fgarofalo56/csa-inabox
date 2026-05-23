# Compliance — DoD IL5 (v1.1)

> **CSA Loom v1 does NOT ship IL5 support.** IL5 lands in v1.1
> (+3 months from v1 GA). This page is the canonical place where
> IL5 specifics are documented as we approach v1.1.

## Audit posture (target for v1.1)

| Authorization | Held |
|---|---|
| FedRAMP High | ✅ |
| DoD IL5 | ✅ (Azure Government IL5 isolation OR US DoD regions) |
| CNSSI 1253 | ✅ (customer maps controls) |
| HIPAA BAA | ✅ |
| ITAR | ✅ |
| CMMC L3 | ✅ (via FedRAMP-High-as-baseline) |

## v1.1 IL5 dispatch deltas (vs GCC-H / IL4)

| Service | IL5 delta |
|---|---|
| Region | `usdodcentral` / `usdodeast` OR `usgov*` with IL5 isolation config |
| Catalog | **Self-hosted Apache Atlas on AKS** (Purview NOT in IL5 audit scope) |
| Storage | HSM-CMK required (`storageRequireCmk = true`); `requireInfrastructureEncryption = true` |
| Key Vault | Premium HSM with infrastructure encryption |
| Marketplace plan | Customer-managed only (publisher-managed not viable at IL5) |
| Foundry portal | Not available at IL5 (use classic Azure ML Hub) |
| Container compute | AKS (no Container Apps) |
| Power BI F-SKU | Available in IL5 regions |

## What changes from GCC-H

- **Catalog: Atlas-on-AKS instead of Purview.** Self-hosted stack:
  Solr + HBase + Kafka + JanusGraph + Atlas server. Heavier operational
  burden; documented in [Catalog governance](../governance/catalog.md).
- **HSM-CMK on every storage account.** Bicep parameter forces this.
- **No publisher-managed Marketplace plan.** Customer-managed only —
  fits federal preference of no persistent publisher access.
- **More restrictive egress.** Azure Firewall app rules tighter;
  CNSSI 1253 control mapping documented.

## CNSSI 1253 alignment

CSA Loom at IL5 aligns with CNSSI 1253 (Security Categorization and
Control Selection for National Security Systems):
- Confidentiality: HSM-CMK + double encryption
- Integrity: TLS 1.2+ everywhere; signed container images
- Availability: per-component DR + ADLS GRS within IL5 region pair

Per-control mapping documented in
`platform/fiab/bicep/compliance/cnssi-1253-mapping.md` (ships with
v1.1).

## Customer ATO checklist (v1.1)

- [ ] DoD IL5 ATO covers CSA Loom components (RMF Step 5)
- [ ] CNSSI 1253 control selection documented per workload
- [ ] HSM-CMK keys generated + rotation policy
- [ ] Atlas-on-AKS hardening per CIS Kubernetes Benchmark
- [ ] Sentinel rules tuned for DoD threat patterns
- [ ] [Defender AI workaround](defender-ai-workaround.md) deployed
- [ ] Per-workload classification labeling (CUI-NSS)
- [ ] Cross-cloud B2B disabled (typically required at IL5)
- [ ] Quarterly DR drill (with classified-data handling procedures)

## v1.1 timeline

Per [Build sequencing — LD-3](../adr/0001-fabric-feature-scope.md):
- v1 ship: weeks 20-24 from build start
- v1.1 ship: +3 months from v1 GA
- IL5 customers who need Loom today: deploy in GCC-H first; promote
  to IL5 via [boundary promotion runbook](../runbooks/boundary-promotion.md)
  when v1.1 GA'd

## Open items (resolve during v1.1 development)

- F-SKU regional availability at usdodcentral/east — verify with
  Microsoft federal
- Marketplace publisher engagement model for IL5 — federal team
- Atlas-on-AKS hardening profile — collaborate with security
  engineering

## Related

- ADR: [fiab-0003 Catalog layering](../adr/0003-catalog-layering.md), [fiab-0010 Container host](../adr/0010-container-host.md), [fiab-0011 Tenancy model](../adr/0011-tenancy-model.md)
- Runbook: [Boundary promotion](../runbooks/boundary-promotion.md)
- Parent: [Microsoft Fabric in Azure Government](../../fabric-in-gov-cloud.md), [Compliance — DoD IL4/IL5](../../compliance/dod-il4-il5.md)

# ADR-009 — Compute platform for stamps: AKS in every cloud

Status: Proposed. Date: 2026-10-22. Evidence: `../research/azure-gov-availability.md` (audit-scope rows for AKS and Container Apps).

## Context
Loom's admin plane runs on Container Apps (`platform/fiab/bicep/modules/admin-plane/container-platform.bicep`,
`containerPlatform` param) in every boundary param file today, including
GCC-High and IL5 (`params/gcc-high.bicepparam:123`, `params/il5.bicepparam:121`).
The research found Azure Container Apps in Azure Government listed for
FedRAMP High and DoD IL2 only, while AKS carries IL5 (and IL6) scope. The LHDS
mandate requires IL5/DoD to be configuration, not redesign, and the stamp runs
stateful-adjacent workloads (WildFly/LDAP, long-running jobs, large streaming
uploads) that need node-level control.

## Decision
- Stamps run on **AKS** in Commercial, GCC-High, IL5 and DoD: private cluster,
  Azure CNI overlay, availability zones, system + user node pools, KEDA
  (add-on where available per cloud; Helm-installed KEDA, Apache-2.0,
  otherwise — W0 confirms the add-on in Gov), workload identity, Azure Policy
  for AKS, Defender for Containers, image admission policy (cosign).
- The control-plane service follows the existing Loom `containerPlatform`
  switch (Container Apps in Commercial/GCC-High, AKS at IL5) so it stays
  consistent with the admin plane; no change to the admin plane.
- Jobs (conversion, de-id, export, sink, reindex) run as Kubernetes Jobs /
  KEDA ScaledJobs on the stamp, not as Container Apps Jobs or Azure Batch
  (keeps data inside the stamp VNet and one platform to operate).

## Consequences
- The repo's IL5 param comment claims ACA is GA in US Gov regions; GA-in-region
  and audit scope are different facts. This ADR records the discrepancy for
  the admin plane as an open item (`../RISKS-AND-OPEN-DECISIONS.md` R5) and
  does not change it here.
- Loom gains a second AKS pattern beside `loom-trino-aks.bicep` and the
  `atlas-aks` catalog option; the stamp module reuses their identity and
  private-cluster conventions.

## Reversal cost
Medium (Helm charts are portable; moving to Container Apps would drop IL5
scope).

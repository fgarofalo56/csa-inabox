# Compliance — GCC

GCC = M365 GCC tenant + Azure Commercial subscriptions. Identity
stays in GCC boundary; Azure resources are in Azure Commercial.

## Audit posture

Same as [Commercial baseline](commercial.md):
- FedRAMP High + DoD IL2 (Azure public)
- HIPAA BAA via Product Terms
- All Defender for Cloud plans available

## GCC-specific constraints

| Constraint | Impact |
|---|---|
| F-SKU not supported in Power BI for GCC | EM + P-SKU only; **no Direct Lake parity in GCC** (structural) |
| Azure Maps visual not available in Power BI | Use static maps or shape maps |
| BYO ADLS Gen2 storage in Power BI not available | Use default Power BI dataflow storage |
| Power BI Autoscale not available | Manual capacity scaling |
| M365 tenant identity isolation | All sign-ins via GCC tenant; Azure Commercial subs trusted to GCC tenant |

## Compliance attestations (GCC)

| Authorization | Held |
|---|---|
| FedRAMP High | ✅ (Azure public baseline) |
| DoD IL2 | ✅ |
| HIPAA BAA | ✅ |
| CJIS (with state addendum) | ✅ |
| IRS 1075 | ✅ |
| StateRAMP via FedRAMP-High-as-baseline | ✅ |
| CMMC L2 (via FedRAMP-High baseline) | ✅ (customer adds practice families) |
| ITAR | ❌ **GCC does NOT support ITAR** — use GCC-High for ITAR-eligible workloads |

## Why ITAR isn't in GCC

GCC runs on Azure Commercial. ITAR-eligible workloads require Azure
Government (GCC-High or DoD). Customers with ITAR workloads should
deploy CSA Loom in [GCC-High](gcc-high.md) instead.

## What's missing vs Commercial

Functionally identical for CSA Loom except for Power BI GCC feature
gaps (above). The Loom Console + Setup Wizard + parity services
behave identically.

## Workloads CSA Loom commonly serves in GCC

- Federal civilian agency analytics (non-classified CUI is fine in
  GCC)
- HIPAA workloads (HHS, VHA, IHS — both M365 GCC + GCC-High common)
- Federal contractor analytics where CUI is the maximum
  classification

## Customer responsibility checklist

- [ ] Map data to acceptable classifications (CUI maximum for GCC)
- [ ] Apply MIP sensitivity labels via Purview
- [ ] Configure conditional access for GCC tenant
- [ ] Document workload-level FedRAMP High control implementation
- [ ] Apply CIS benchmark hardening for Azure resources
- [ ] Quarterly access reviews via Entra ID
- [ ] Per-workload incident response plan

## Related

- [Feature × boundary matrix](feature-boundary-matrix.md)
- [GCC-High / IL4](gcc-high.md) — for ITAR + F-SKU / Direct Lake
- Parent: [Microsoft Fabric in Azure Government](../../fabric-in-gov-cloud.md)

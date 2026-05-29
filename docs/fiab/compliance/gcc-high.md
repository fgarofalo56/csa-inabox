# Compliance — GCC-High / IL4

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


GCC-High = Azure Government cloud + M365 GCC-High tenant. FedRAMP
High + DoD IL4 + ITAR-eligible.

## Audit posture

| Authorization | Held |
|---|---|
| FedRAMP High | ✅ (Azure Government P-ATO) |
| DoD IL2 | ✅ |
| DoD IL4 | ✅ |
| ITAR (workload-customer responsibility) | ✅ ITAR-eligible boundary |
| HIPAA BAA | ✅ via Product Terms (Gov scope) |
| CJIS | ✅ |
| IRS 1075 | ✅ |
| CMMC L2 / L3 | ✅ (via FedRAMP-High-as-baseline; customer adds practice families) |
| StateRAMP | ✅ |

## GCC-High-specific dispatch deltas (vs Commercial)

Per [Reference architecture §4.3](../architecture.md#per-boundary-dispatch-matrix):

| Service | GCC-High difference |
|---|---|
| Container host | AKS (Container Apps not at IL4+) |
| Functions host | Premium EP1 (Flex Consumption not in Gov) |
| APIM | Classic Premium (v2 not confirmed in Gov) |
| Catalog primary | Microsoft Purview (UC managed not yet in Gov) |
| Databricks | Classic clusters + Hive metastore (no UC, no SQL Warehouse) |
| SQL Warehouse | Synapse Serverless (Databricks SQL Warehouse not in Gov) |
| Agent orchestration | Microsoft Agent Framework + AOAI direct (Foundry Agent Service Gov-GA unconfirmed) |
| Foundry portal | Not available (use classic Azure ML Hub) |
| Defender for Cloud AI Threat Protection | **Commercial-only — see [workaround](defender-ai-workaround.md)** |
| OpenAI Batch API | Not in Gov |
| OpenAI Content Safety | Not at IL4 audit scope (use self-hosted Presidio) |

## ITAR considerations

For ITAR-eligible workloads:
- Mark ITAR-restricted data with sensitivity labels (Purview)
- Apply Purview ITAR classification rules
- Verify cross-cloud B2B is disabled or scoped per ITAR policy
- Configure Sentinel rules to detect ITAR-data egress
- See [ITAR extension page](itar-fiab.md)

## CUI handling

CSA Loom in GCC-High supports CUI (Controlled Unclassified
Information):
- Customer classifies CUI columns/tables via Purview sensitivity
  labels
- RLS / CLS enforces access at engine layer
- Per-DLZ network isolation prevents cross-domain CUI exposure
- Audit logs retained 1 year minimum (configurable per workload)

## Endpoint differences (vs Commercial)

| Service | Endpoint |
|---|---|
| ARM | `management.usgovcloudapi.net` |
| Storage | `*.core.usgovcloudapi.net` |
| Key Vault | `*.vault.usgovcloudapi.net` |
| Azure OpenAI | `*.openai.azure.us` |
| Databricks | `*.databricks.azure.us` |
| Purview | `*.purview.azure.us` |
| Entra login | `login.microsoftonline.us` |
| Microsoft Graph | `graph.microsoft.us` |

## Customer responsibility checklist

- [ ] FedRAMP High SSP includes CSA Loom components
- [ ] DoD IL4 boundary documented (and IL5 if planning v1.1 promote)
- [ ] ITAR boundary documented + customer ITAR policy applied
- [ ] CMMC L2 / L3 practice families implemented at workload level
- [ ] [Defender AI workaround pipeline](defender-ai-workaround.md) deployed
- [ ] Cross-cloud B2B policy documented (especially for hybrid Loom
      Gov + Fabric Commercial scenarios)
- [ ] Sentinel rules tuned for federal threat patterns
- [ ] Quarterly DR drill executed

## Related

- [Feature × boundary matrix](feature-boundary-matrix.md)
- [DoD IL5 (v1.1)](dod-il5.md) — promotion path
- [ITAR extension](itar-fiab.md), [CMMC 2.0 L2 extension](cmmc-2.0-l2-fiab.md), [HIPAA extension](hipaa-security-rule-fiab.md), [NIST 800-53 r5 extension](nist-800-53-rev5-fiab.md)
- [Defender AI workaround](defender-ai-workaround.md)
- Parent: [Azure Government](../../fabric-in-gov-cloud.md)

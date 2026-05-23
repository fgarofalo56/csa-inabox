# Tagging & Classification

CSA Loom uses three layers of tagging + classification:

## 1. Azure resource tags

Every Loom-deployed Azure resource carries:
- `csa-loom: true`
- `csa-loom-tier: admin-plane | data-landing-zone | workspace`
- `csa-loom-boundary: Commercial | GCC | GCC-High | IL5`
- `csa-loom-domain: <domain-id>` (DLZ + workspaces only)
- `csa-loom-workspace: <workspace-id>` (workspace resources only)
- `FedRAMP_Level: High` (Gov boundaries)
- `DISA_IL: IL4 | IL5` (Gov boundaries)
- `Data_Classification: Standard | CUI | CUI-NSS`
- Customer-supplied tags from `.bicepparam` (e.g., `CostCenter`, `Owner`)

Deployed via `platform/fiab/bicep/modules/shared/tagging.bicep` —
consistent across every module.

## 2. Catalog-layer tags

| Track | Mechanism |
|---|---|
| UC managed (Commercial / GCC post-Gov-GA) | UC tags applied to catalogs / schemas / tables / columns. ABAC policies bind to UC tags. |
| Purview-primary (Gov-IL4) | Purview classifications applied via automated scan rules + manual curation. |
| Atlas (IL5) | Atlas classifications + custom attributes. |

## 3. Sensitivity labels (MIP)

Microsoft Information Protection (MIP) sensitivity labels propagate
from M365 / Purview through to:
- Power BI semantic models + reports
- Excel / PowerPoint exports
- Console catalog UI (sensitivity-label chips on each item)
- Synapse Serverless query result audit log

Propagation pattern (Commercial / GCC / GCC-H):
- Author labels in Purview
- Reverse-sync job (Logic App + Function) applies labels to UC tags
- UC tags flow to Power BI semantic-model authoring + report-level
  sensitivity

At IL5 (Atlas-on-AKS), sensitivity-label propagation requires a
custom Atlas → Power BI sensitivity bridge (custom Logic App).
Documented in [`docs/fiab/compliance/dod-il5.md`](../compliance/dod-il5.md).

## Classification scheme defaults

Loom v1 ships defaults aligned with federal classification
expectations:

| Classification | Use case | Example data |
|---|---|---|
| `Public` | Open data sources | Census reference data, NOAA public datasets |
| `Internal` | Org-internal but non-CUI | Operational metrics, internal financials |
| `CUI` | Controlled Unclassified Information | PII, financial records, contracting data |
| `CUI-NSS` | CUI National Security Systems | DoD mission data; CNSSI 1253 |
| `PII-restricted` | Personally identifiable, restricted access | SSNs, full medical records |

Customers can extend with custom classifications.

## Auto-classification

| Track | Capability |
|---|---|
| UC managed | Tag-based ABAC; manual tag application + scheduled inference jobs (Databricks notebook) |
| Purview | Automated classification with built-in classifiers (PII, PHI, payment card) + custom regex classifiers |
| Atlas | Custom classifiers via Atlas REST API; less polished than Purview's auto-classification |

## Related

- ADR: [fiab-0003 Catalog layering](../adr/0003-catalog-layering.md)
- Catalog: [Catalog](catalog.md)
- Compliance: [DoD IL5](../compliance/dod-il5.md), [GCC-High / IL4](../compliance/gcc-high.md)
- Parent: [Microsoft Purview Setup Guide](../../governance/PURVIEW_SETUP.md)

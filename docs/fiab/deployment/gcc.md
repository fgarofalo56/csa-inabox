# For Azure Government (GCC)

**GCC = Microsoft 365 GCC tenant + Azure Commercial subscriptions.**
Identity stays in GCC boundary; Azure subs are in Azure Commercial.

## What "GCC" means here

| Layer | Where it lives |
|---|---|
| Microsoft 365 tenant | M365 GCC (community gov cloud) |
| Azure subscriptions | Azure Commercial (public Azure) |
| Compliance | FedRAMP High + DoD IL2 (Azure Commercial baseline) |

Per `docs/fabric-in-gov-cloud.md`, this is the **most-common federal
configuration** for customers who don't have strict DoD IL4/IL5
requirements. ITAR-eligible workloads should NOT use GCC — they
require GCC-High.

## Prerequisites

| Item | Notes |
|---|---|
| Azure Commercial subscription paired with your M365 GCC tenant | `az account show --query tenantId` should match your GCC tenant |
| Region | Any Azure Commercial US region (eastus, westus, eastus2, etc.) |
| Other prereqs same as Commercial baseline | See [Commercial deployment](commercial.md) |

> **Optional — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`.** Semantic models
> + reports run on the Azure-native tabular layer (Azure Analysis Services, which
> is available in GCC's Commercial regions) by default — **no Power BI capacity is
> required**. If you opt into the Power BI backend, GCC supports **P-SKU only
> (P1 minimum) — F-SKU is unavailable in GCC**, provisioned via the Power BI admin
> portal.

## Critical GCC limitations

Per `research/02-gov-boundary-availability.md §7.5`:

- ❌ **Power BI F-SKU not supported in GCC** — EM + P SKUs only
- ❌ **Direct Lake unavailable in GCC even when Fabric Gov ships** —
  structural gap (F-SKU is the gate)
- ❌ **Azure Maps visual** in Power BI not available
- ❌ **BYO ADLS Gen2 storage** in Power BI not available
- ❌ **Autoscale** in Power BI not available

Everything else works the same as Commercial (Azure stack is
identical).

## Deploy

**This page is a boundary reference, not a walkthrough.** Follow
[**Greenfield**](greenfield.md) or [**Brownfield**](brownfield.md) and substitute
`gcc.bicepparam`.

GCC subscriptions are in **Azure Commercial**, so the local `az` path is
available (unlike GCC-High / IL5, which are Actions-only). The install is still
**three phases**. Phase 1:

```bash
az deployment sub create \
  --name csa-loom-gcc-$(date +%s) \
  --location <region> \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/gcc.bicepparam \
  --parameters adminEntraGroupId=<group-guid> \
  --parameters deployAppsEnabled=false
```

then the image + app phase, then the post-deploy bootstrap with
`-f boundary=GCC`.

> **`deployAppsEnabled=false` on phase 1 is not optional** — the registry is
> created empty, so Container Apps cannot be created in the same pass. An
> earlier version of this page omitted it, and omitted the image and bootstrap
> phases entirely; the published command could not have produced a working
> Console on a fresh subscription.

> **The CI lane for this boundary is not a health signal.**
> `deploy-fiab-gcc.yml` concludes `success` while **skipping its entire deploy**
> when the `AZURE_GCC_*` secrets are absent — measured on its most recent run
> (2026-08-08): `Deploy + validate CSA Loom in GCC -> skipped`,
> `Post-deploy bootstrap (GCC) -> skipped`. See
> [when a green Gov run means nothing](greenfield.md#when-a-green-gov-run-means-nothing).
> No GCC install has been verified end to end.

`gcc.bicepparam` sets:
- `fabricEnabled = false` (no F-SKU)
- `directLakeEnabled = false` (no F-SKU)
- `powerBiSku = 'P1'` (or P2, P3 — EM/P only)
- `purviewUnifiedCatalogEnabled = false` (GCC cert lag)

Everything else matches Commercial.

## Direct Lake parity in GCC

**Not available.** Use one of:

1. **Power BI Premium P-SKU Import semantic model** — refreshed on
   schedule (not commit-triggered like Direct-Lake-Shim)
2. **Power BI DirectQuery** against Databricks SQL Warehouse — always
   live, slower DAX
3. **Composite TMDL** — Import for dims + DirectQuery for facts

The Direct-Lake-Shim service deploys but is **disabled** in GCC
(it requires F-SKU to refresh via XMLA-Direct-Lake-compatible
endpoint).

## Compliance posture

- FedRAMP High (Azure public baseline)
- DoD IL2 (Azure public baseline)
- HIPAA BAA via Microsoft Product Terms
- StateRAMP-aligned

Customer responsibility: workload-level compliance + audit (CIS
benchmarks, NIST 800-53 control implementation).

## Forward migration

When Fabric reaches GCC (Fabric Gov pair):
- F-SKU still unavailable in GCC; Fabric Gov F-SKU only in GCC-H/DoD
- Loom + Fabric Gov hybrid less compelling for pure-GCC customers
  (no Direct Lake either way)
- Consider migrating to GCC-High if Direct Lake matters

## Related

- [Commercial deployment](commercial.md) — same Azure stack as GCC
- [GCC-High deployment](gcc-high.md) — for ITAR / Direct Lake / F-SKU
- [Microsoft Fabric in Azure Government](../../fabric-in-gov-cloud.md)
- [Per-boundary dispatch](../architecture.md#per-boundary-dispatch-matrix)
- [Compliance — GCC](../compliance/gcc.md)

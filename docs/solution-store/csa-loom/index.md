# CSA Loom — Solution Store Accelerator

![CSA Loom — Microsoft Fabric parity in Azure Government](../../assets/images/hero/fiab/index.svg){ .architecture-hero loading="eager" }

CSA Loom is a productized Microsoft Fabric parity layer that deploys
into any Azure tenant where Fabric isn't yet generally available.
Federal, DoD, intelligence community, state + local, defense
industrial base, and regulated commercial verticals.

## What you get

- **Loom Console** — Next.js + Fluent UI v9 SaaS UI that mirrors the
  Microsoft Fabric workspace experience
- **Loom Setup Wizard** — conversational deploy with live `.bicepparam`
  preview backed by self-hosted Azure MCP
- **Parity services** that fill Fabric-only gaps (Direct-Lake Shim,
  Activator Engine, Mirroring Engine, Data Agents)
- **Two-tier deployment** — `azd up` CLI or "Deploy to Azure" button
- **Forward-migration tooling** — to Microsoft Fabric when your
  boundary reaches GA

## Quickstart

[60-minute Quick Start →](../../fiab/deployment/quickstart.md)

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox/platform/fiab/azd
azd init -t .
azd up
```

## Architecture

[Reference Architecture →](../../fiab/architecture.md)

## Per-boundary support

| Boundary | v1 (now) | v1.1 (+3 mo) |
|---|---|---|
| Azure Commercial | ✅ | — |
| GCC | ✅ | — |
| GCC-High / IL4 | ✅ | — |
| DoD IL5 | — | ✅ |

## Cost (Bicep-derived)

CSA Loom IP is **free in v1**. You pay only for Azure consumption underneath.
The sample monthly estimates below are **derived from the SKUs in the shipped
deploy parameters** (`platform/fiab/bicep/params/*.bicepparam`) — each line
traces to a real `param`, so the estimate moves with the deployment, not a
hand-waved figure.

### Commercial baseline — `commercial.bicepparam`

| Component | Bicep param → value | Approx. monthly (list) |
|---|---|---|
| API Management | `apimSku = 'PremiumV2'` (1 unit) | ~$2,800 |
| Azure Data Explorer (eventhouse/KQL) | ADX cluster (small prod / dev) | ~$400-900 |
| Databricks (Premium, jobs, scale-to-0) | `databricksSqlWarehouseEnabled = true` | ~$300-800 |
| Azure OpenAI | `openaiChatModel = 'gpt-4o'` (moderate use) | ~$200-600 |
| Container Apps + Functions | `containerPlatform = 'containerApps'`, `functionsHostSku = 'FlexConsumption'` | ~$200-450 |
| ADLS Gen2 + Delta, Cosmos, Key Vault, Monitor | base platform (1-5 TB) | ~$150-450 |
| **Base total (Loom-native)** | capacity baseline `capacitySku = 'F8'` | **~$3-5K / month** |
| *Power BI F-SKU (optional)* | `powerBiSku = 'F64'` — **not required**; Loom-native tabular layer is the default | *+~$5K if enabled* |

### GCC-High / IL4 — `gcc-high.bicepparam`

Higher because Gov substitutes pricier SKUs (no Container Apps / FlexConsumption
at IL4+):

| Component | Bicep param → value | Approx. monthly (list) |
|---|---|---|
| API Management | `apimSku = 'Premium'` (1 unit) | ~$2,800 |
| Compute platform | `containerPlatform = 'aks'` (Container Apps not at IL4+) | ~$500-900 |
| Functions | `functionsHostSku = 'EP1'` (Flex not in Gov) | ~$150-300 |
| Azure Data Explorer | ADX cluster (Gov region) | ~$400-900 |
| Azure OpenAI Gov | `openaiChatModel = 'gpt-4o'` (Gov endpoints) | ~$200-600 |
| ADLS + Cosmos + KV + Monitor | base platform | ~$150-450 |
| **Base total (Loom-native)** | `capacitySku = 'F8'` | **~$4-6K / month** |

!!! note "These are list-price approximations"
    Actual cost depends on data volume, query/agent usage, compute auto-scale,
    and your Azure agreement (MACC, reservations, EA discounts). Re-derive for
    your boundary by reading the SKUs in your chosen `.bicepparam` against the
    [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/),
    or run the deploy with `azd provision --preview` to enumerate billable
    resources. The **Loom-native path needs no Power BI / Fabric SKU** — Power BI
    is an opt-in line item, never a requirement.

[Detailed cost breakdown →](../../fiab/operations/cost.md)

> **Marketplace listing + pricing model deferred to backlog** (per AMENDMENTS A4).
> See [`docs/fiab/deployment/marketplace.md`](../../fiab/deployment/marketplace.md)
> for the future pricing roadmap placeholder.

## Resources

- [Documentation pillar](../../fiab/index.md)
- [Source code on GitHub](https://github.com/fgarofalo56/csa-inabox)
- [Epic / build roadmap](https://github.com/fgarofalo56/csa-inabox/issues/279)
- [5-day Cloud CoE workshops](../../fiab/workshops/index.md)
- [Marketing kit](../../fiab/marketing/pitch-deck.md)

## How CSA Loom relates to other CSA accelerators

The **API-First Data Strategy accelerator** (see [solution-store index](../index.md))
covers the integration layer (APIM + Dataverse + cross-platform
APIs). CSA Loom covers the analytics + lakehouse + BI layer for
audit-boundary-blocked customers.

Both pillars share the csa-inabox foundation (Bicep, Copilot
backend, MkDocs Material).

## Forward migration

CSA Loom forward-migrates 1:1 to Microsoft Fabric when Fabric
reaches your audit boundary. Delta tables via OneLake shortcut
(zero data movement); dbt + KQL port unchanged; semantic models
re-author for Direct Lake on OneLake. See
[forward-migration runbook](../../fiab/runbooks/forward-migrate-to-fabric.md).

# CSA Loom — One-Pager

Single-page (front + back) reference for trade shows + cold outreach.
PDF generated from this markdown via mkdocs-pdf workflow.

---

## Front page

# CSA Loom

**The Microsoft Fabric Experience in Your Azure Government Tenant**

CSA Loom is a productized, Azure-native parity layer for Microsoft
Fabric. Deploy it into any Azure tenant where Fabric isn't yet
available — federal, DoD, intelligence community, state + local,
defense industrial base.

### Why now

Microsoft Fabric is `Forecasted` in every US Government cloud and
not yet authorized at FedRAMP High, DoD IL4/IL5, or Top Secret.
Federal customers can't wait. Loom is the bridge.

### What you get

- **Loom Console** — Next.js + Fluent UI v9 application that gives
  you the Fabric workspace experience (12 panes covering lakehouse,
  warehouse, notebooks, semantic models, KQL, catalog, activator,
  data agents, monitoring, admin)
- **Loom Setup Wizard** — conversational deploy with live `.bicepparam`
  preview, backed by self-hosted Azure MCP
- **Parity services** that fill Fabric-only gaps:
  - Direct-Lake Shim (warm-cache materializer)
  - Activator Engine (Reflex parity)
  - Mirroring Engine (Open Mirroring publisher-contract compatible)
  - Data Agents (NL2SQL / NL2DAX / NL2KQL)

### Per-boundary support

| Boundary | v1 (now) | v1.1 (+3 mo) |
|---|---|---|
| Commercial | ✅ | — |
| GCC | ✅ | — |
| GCC-High / IL4 | ✅ | — |
| DoD IL5 | — | ✅ |
| IL6 / Top Secret | Out of scope | — |

### Deployment

- `azd up` CLI (60-100 min to working Console)
- "Deploy to Azure" button in README
- All into your own Azure subscription — pay only for consumption
- **CSA Loom IP is free in v1**

### Try it

| Item | URL |
|---|---|
| GitHub repo | github.com/fgarofalo56/csa-inabox |
| Epic (build roadmap) | github.com/fgarofalo56/csa-inabox/issues/279 |
| Documentation | fgarofalo56.github.io/csa-inabox/csa-loom/ |
| Quick start (60 min) | docs/fiab/deployment/quickstart.md |

---

## Back page

### Forward migration

When Microsoft Fabric reaches your audit boundary, Loom forward-
migrates 1:1:

| Loom artifact | Fabric equivalent | Effort |
|---|---|---|
| Delta tables (ADLS Gen2) | OneLake Delta tables | **Zero data movement** (OneLake shortcut) |
| dbt models | dbt in Fabric Data Factory | **Low** (dbt-fabric adapter) |
| Databricks notebooks | Fabric Spark notebooks | Medium (runtime swap) |
| TMDL semantic models | Direct Lake on OneLake | Medium (re-author for native Direct Lake) |
| ADX databases / KQL | Fabric Eventhouse | **Low** (same engine) |
| Activator rules | Fabric Reflex | Low-Medium (JSON port) |
| Data Agent configs | Fabric Data Agents | Low (config export/import) |
| Purview catalog | Fabric Purview | **Zero** (same engine) |

You are not trapped in Loom; you are bridged into Fabric.

### Hybrid topology

The most common federal pattern:
- **Fabric Commercial** for public datasets + cross-agency analytics +
  exec Power BI
- **CSA Loom Gov** for CUI / classified mission data + agency-internal
  workloads
- Cross-cloud B2B + APIM bridges between

### Compliance posture

| Boundary | Attestations |
|---|---|
| Commercial | FedRAMP High + DoD IL2 |
| GCC | FedRAMP High + DoD IL2 |
| GCC-High / IL4 | FedRAMP High + DoD IL4 + ITAR + HIPAA BAA |
| DoD IL5 (v1.1) | FedRAMP High + DoD IL5 + CNSSI 1253 |

### Cost (sample F8 deployment)

| Component | Approximate $/month |
|---|---|
| Power BI Premium F8 | $1,049 (Commercial) / ~$1,200 (Gov-H) |
| Databricks Premium | $500-2,500 |
| Azure Data Explorer | $500-600 |
| ADLS Gen2 (10 TB) | $200-250 |
| Azure OpenAI (50K TPM) | $200-600 |
| Misc (KV, LA, Search, Purview, Containers, Functions) | $700-1,200 |
| **Total** | **~$3,100-6,000/mo** |

CSA Loom IP itself is **free in v1**.

### 5-day workshop

Cloud Center of Excellence workshop available in two variants:
- Federal CoE (focus: FedRAMP / IL4 / IL5 / ITAR / CMMC)
- Commercial CoE (focus: regulated commercial verticals)

Five-day curriculum: Foundation → Ingest → Transform → BI + AI →
Operate + Forward-Migrate.

### Contact

| Channel | Where |
|---|---|
| Microsoft federal account team | `#csa-loom-federal` Teams channel |
| GitHub Issues | github.com/fgarofalo56/csa-inabox/issues |
| Documentation | fgarofalo56.github.io/csa-inabox/csa-loom/ |

---

## PDF generation

This markdown is rendered to PDF via mkdocs-pdf plugin. Front/back
layout uses CSS page-break rules.

**File**: `docs/fiab/marketing/one-pager.pdf` (auto-generated nightly)

## Related

- [Pitch deck](pitch-deck.md)
- [Battlecard vs Fabric Commercial](battlecard-fabric.md)
- [Seller playbook](seller-playbook.md)
- [Federal pitch variant](federal-pitch.md)

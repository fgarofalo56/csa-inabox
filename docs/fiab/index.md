# CSA Loom

![CSA Loom — Microsoft Fabric experience for Azure tenants where Fabric isn't yet available](../assets/images/hero/fiab/index.svg){ .architecture-hero loading="eager" }

!!! success "What's new — Release 2026-05-27"
    Six PRs landed today on the FedCiv DLZ deployment. All 10 CSA apps
    now install with full starter code + data drawn from
    `examples/<industry>/`. 175 ribbon buttons wired across 18 editor
    files with honest disabled-tooltips on the rest. New shared
    `<ComputePicker>` (state badges + Resume / Pause / Restart) and
    nine free-text Azure-resource Inputs swapped to backed `Select`
    pickers. Monaco self-hosted; CSP loosened for workers; Activator
    workspace dropdown corrected.

    **Live:** `loom-console--0000082` on image SHA `146d2158`. Smoke:
    10/10 apps, 85/85 editors, 23/23 services, 46/48 walkthrough.
    [Read the release notes →](releases/2026-05-27-apps-bundles-and-wiring-sweep.md) ·
    [Walk the test script →](TEST_SCRIPT_2026_05_27.md)

**CSA Loom** is the Cloud Scale Analytics platform that delivers the
Microsoft Fabric experience inside any Azure tenant where Fabric isn't
yet generally available — federal civilian, DoD, intelligence
community, state + local government, defense industrial base, and
regulated commercial verticals.

Loom is **Azure-native + open source under the covers** and ships as a
deployable pillar of Cloud Scale Analytics in a Box. You deploy it
into your own subscription; you pay only for what your Azure
consumption underneath uses; you migrate forward to Microsoft Fabric
one-for-one when Fabric reaches your audit boundary.

## What you get

<div class="grid cards" markdown>

-   :material-cube-outline: **One unified workspace experience**

    A Fluent UI v9 console that mirrors the Microsoft Fabric workspace
    layout — Lakehouse, Warehouse, Notebooks, Semantic Models,
    Real-Time Intelligence, Data Agents, Activator — over your existing
    Azure stack.

-   :material-rocket-launch: **Push-button deploy**

    `azd up` or the "Deploy to Azure" button stands the whole platform
    up in your tenant in 60–100 minutes. A conversational Setup Wizard
    guides you through capacity sizing, networking, and identity.

-   :material-shield-account: **Built for sovereignty**

    Designed from day one for FedRAMP High, DoD IL4, and DoD IL5 (in
    v1.1). Per-boundary `.bicepparam` files. Self-hosted everything;
    no commercial-cloud dependencies.

-   :material-arrow-right-bold: **Forward migration is the goal**

    When Microsoft Fabric reaches your audit boundary, your Delta
    tables become OneLake shortcuts. Your dbt models, KQL queries, and
    semantic models port 1:1. **You are not trapped in Loom; you are
    bridged into Fabric.**

</div>

## The pitch in one sentence

> *Any federal tenant whose audit boundary blocks Microsoft Fabric can
> deploy CSA Loom into its existing Azure Government tenant in under
> one day, give its domain teams a workspace experience that
> looks-and-feels like Fabric, and migrate forward to Fabric
> one-for-one when Fabric reaches Gov GA — with no rewrites to Delta
> tables, dbt models, semantic models, or runbooks.*

## Why "CSA Loom"

The name is two halves working together.

**CSA — Cloud Scale Analytics.** This is the broader Microsoft pattern
family this product ships under. Loom is one *pillar* of Cloud Scale
Analytics in a Box, alongside the data landing zones, the data
management zone, and the platform-as-a-product reference architectures.
Calling it `CSA <something>` keeps the lineage explicit: this is the
same platform philosophy customers already trust at scale, just shaped
for a different audit boundary.

**Loom — a weaving machine.** A loom is the device that takes many
parallel threads and produces a single integrated fabric. That is
exactly what this product does:

- **The threads** are your existing Azure-native services —
  Synapse Spark + Synapse Serverless SQL, Azure Databricks, Azure
  Data Explorer, Microsoft Fabric Foundry, Power BI Premium, ADF,
  APIM, Purview, AI Search, Azure OpenAI, Dataverse, Copilot Studio.
  Each one is a powerful primitive on its own.
- **The fabric** is a single Fluent UI workspace that *looks and feels
  like Microsoft Fabric* — Lakehouse, Notebook, Warehouse, Semantic
  Model, Real-Time Intelligence, Data Agents, Activator — sitting on
  top of those threads.
- **The loom itself** is the orchestration layer: the Cosmos-backed
  catalog, the BFF, the per-editor wiring, the OneLake-equivalent path
  conventions, the forward-migration manifests.

Three layers of meaning sit on top of that metaphor, all intentional:

1. **It rhymes with "Fabric" without colliding with it.** Fabric is a
   Microsoft product brand. Loom is what *makes* fabric. The name
   communicates "you get the Fabric experience" without overloading
   Microsoft's trademark — a requirement of the Microsoft brand-review
   process this product is going through ([LD-1](#locked-architecture-15-decisions)).
2. **It signals integration over invention.** A loom doesn't manufacture
   the thread, it weaves what's already there. Loom does not replace
   your Synapse or your Databricks; it weaves them into a single
   experience. This matters for customers who have spent years
   standardizing on those services and don't want a re-platforming
   project.
3. **It points at the forward-migration story.** A loom produces
   fabric. When Microsoft Fabric reaches your audit boundary, the
   thing your team has been weaving on Loom *is already a fabric* —
   your Delta tables, your dbt models, your TMDL semantic models,
   your KQL queries port forward 1:1.

The repo-internal nickname is `fiab` ("Fabric-in-a-Box") because that
was the working title during research wave 0 — you'll still see it in
folder paths, bicep modules, and image tags. **The public brand is
CSA Loom**; `fiab` is purely an implementation artifact.

So when you see "CSA Loom" on a slide, hear it on a call, or type
`azd up` against the bicep: read it as *the Cloud Scale Analytics
weave that produces the Fabric experience inside any Azure tenant*.

## Where to start

<div class="grid cards" markdown>

-   :material-help-circle: [**What is CSA Loom?**](what-is-csa-loom.md)

    Five-minute overview of what Loom is, who it's for, and why now.

-   :material-file-document: [**Parity matrix**](parity-matrix.md)

    Workload-by-workload table — what Loom delivers, where there are
    honest gaps, where parity is exact.

-   :material-sitemap: [**Reference architecture**](architecture.md)

    Per-layer diagram, tenancy model, per-boundary dispatch, catalog
    strategy.

-   :material-rocket: [**Deployment**](deployment/index.md)

    Quick start, per-path guides (azd CLI, Deploy-to-Azure button),
    per-boundary deployment.

-   :material-cog: [**Workloads**](workloads/index.md)

    One page per Fabric workload — how Loom delivers the parity, the
    honest gaps, the forward-migration path.

-   :material-school: [**Workshops**](workshops/index.md)

    5-day Federal CoE and Commercial CoE workshops to stand up your
    Loom Center of Excellence.

</div>

## Concepts

Short, accurate answers to the most common questions:

- [What is CSA Loom?](concepts/what-is-csa-loom.md) — five-minute
  overview with deployment, console, parity services, tenancy model,
  and Gov boundaries.
- [dbt in CSA Loom](concepts/dbt-in-csa-loom.md) — how the dbt job
  item type works, what backends it supports, and how dbt fits the
  medallion architecture.
- [Data Mesh on Azure](concepts/data-mesh-on-azure.md) — what data
  mesh is, how CSA Loom implements it (domains → DLZs, data products,
  Marketplace, federated governance), and step-by-step setup.
- [Federal Use Cases](concepts/federal-use-cases.md) — federal and
  government use cases including the FedRAMP Tracker, Federal Data
  Mesh, Multi-Agency Onboarding, and Sovereign AI Agents app bundles.

## Locked architecture (15 decisions)

| # | Decision | Locked value |
|---|---|---|
| LD-1 | Public brand | **CSA Loom** (repo-internal nickname: `fiab`) |
| LD-2 | Primary compute | Hybrid — Azure Databricks + Synapse Serverless + Azure Data Explorer + Power BI Premium |
| LD-3 | Cloud boundaries (v1) | Azure Commercial + GCC + GCC-High |
| LD-4 | Deployment shape | Two-tier (azd CLI + Deploy-to-Azure button); Marketplace listing deferred to backlog |
| LD-5 | Console framework | Next.js 14 + Fluent UI v9 + MSAL BFF |
| LD-6 | Tenancy | Single-sub + multi-sub modes |
| LD-7 | Direct Lake parity | Power BI Premium Import + warm-cache materializer |
| LD-8 | IL5 catalog (v1.1) | Apache Atlas on AKS |
| LD-9 | Mirroring engine | OSS Debezium + Spark Structured Streaming + Delta MERGE |
| LD-10 | ADX model | Shared cluster per Admin Plane; database-per-DLZ |
| LD-11 | Workshops | Federal CoE + Commercial CoE day-one |
| LD-12 | Industry examples | 8 in v1; 17 in v1.1 |
| LD-13 | Forward migration | Both directions + hybrid topology first-class |
| LD-14 | Copilot identity | OBO throughout |
| LD-15 | Per-boundary params | Separate `.bicepparam` files per boundary |

Full architectural decision records: [**ADRs**](adr/README.md).

## Status

| Item | Status |
|---|---|
| PRD | v1.0 — finalized 2026-05-22 |
| Public brand | CSA Loom (Microsoft brand-review submission tracked under PRP-01) |
| Build wave 0 | In progress (PRP-01 + PRP-19) |
| v1 GA target | weeks 20-24 (~6 months) |
| v1.1 target | +3 months — DoD IL5 |
| v2 target | +6 months — Fabric Databases (HorizonDB-equivalent). The **Fabric IQ family** (Ontology / Plan / Graph / Map / Data Agent / Workshop / Slate / OSDK / Release-environment / Health-check / AIP Logic) has **already shipped** with real Azure-native backends — see the [parity matrix](parity-matrix.md#fabric-iq-family-delivered-azure-native) |

## How Loom relates to Microsoft Fabric

Loom is **strictly Fabric-aligned, not Fabric-competing**. Every
primary design choice (Delta tables, OneLake-equivalent path layout,
TMDL semantic models, KQL queries, dbt models, Activator rule JSON,
Data Agent configs) is portable to Microsoft Fabric when Fabric
reaches your boundary. Customers who run Loom today are **investing
in a head-start, not a detour.**

For the side-by-side: [CSA-in-a-Box vs Microsoft Fabric](../comparison/csa-inabox-vs-fabric.md)
+ the new [CSA Loom vs Microsoft Fabric](../comparison/csa-loom-vs-fabric.md).

## Related

- **GitHub epic:** [#279 — CSA Loom v1 build roadmap](https://github.com/fgarofalo56/csa-inabox/issues/279)
- **Source documents:** [PRD](../../temp/fiab-prd/00-README.md), [Research wave](../../temp/fiab-research/), [PRPs](../../PRPs/active/csa-loom/PRP-00-README.md)
- **Existing context:** [Fabric in Azure Government](../fabric-in-gov-cloud.md), [CSA-in-a-Box vs Fabric comparison](../comparison/csa-inabox-vs-fabric.md), [ADR-0010 Fabric strategic target](../adr/0010-fabric-strategic-target.md)

# 60-minute architecture deep-dive — CSA Loom

Audience: customer architects + platform leads + (often) security
architect. The 30-min CIO pitch booked this meeting; this is where you
*earn* the technical buy-in.

Goal: leave with the architect team saying "yes, this fits our
architecture — let's book the 2-hour technical evaluation with our
infra team and run `azd up` against a test sub."

Use [pitch deck](../pitch-deck.md) slides 1-20 in full, plus the
[parity matrix](../../parity-matrix.md) and a live demo. Slides 1-4 in
under 5 minutes — assume they read the recap email.

---

## Agenda (60 min)

| Min | Topic | Materials |
|---|---|---|
| 0-5  | Recap + frame | Slides 1-4 |
| 5-15 | Architecture layers (per-layer walk) | Slide 5 + [architecture.md](../../architecture.md) |
| 15-25 | Per-workload parity matrix (the *deep dive*) | [parity-matrix.md](../../parity-matrix.md) |
| 25-35 | Custom parity services (Direct-Lake-Shim, Activator, Mirroring) | Slide 11 + [shim docs](../../adr/0005-direct-lake-shim-spec.md) |
| 35-40 | Live demo — Loom Console walkthrough | [demo-script.md](../../marketing/demo-script.md) |
| 40-45 | Forward migration story (with Delta → OneLake mapping) | Slide 13 + [forward-to-fabric](../../operations/forward-to-fabric.md) |
| 45-55 | Architect Q&A (15 most-likely + improv) | Q&A bank below |
| 55-60 | Next-step ask + 2-hour technical evaluation booking | — |

---

## Per-layer walk (Min 5-15)

For each layer, name the service, the boundary support, the audit
posture, and the forward-migration path.

### 1. Storage — ADLS Gen2 (boundary-native)

> "Storage is ADLS Gen2 with Hierarchical Namespace + Private
> Endpoints. The bicep deploys five containers — bronze / silver /
> gold / landing / metadata — with EventGrid system topic wiring so
> the Direct-Lake-Shim can react to writes."

Forward path: Delta tables on these containers become OneLake
**shortcuts** when Fabric GA hits the customer's boundary. No data
movement; zero downtime; one bicep edit.

### 2. Compute — Hybrid (Synapse Spark + Databricks + ADX + Power BI Premium)

> "Loom is intentionally hybrid. The decision is locked in [ADR-LD-2](../../adr/README.md):
> Databricks for primary Spark, Synapse Serverless for SQL-over-files,
> ADX for low-latency streaming, Power BI Premium for semantic models."

Architect challenge: *"Why not just Databricks?"* Answer: KQL +
sub-second streaming aren't natural Databricks workloads. ADX is the
right tool. Plus most customers have existing Synapse pools they
don't want to throw out.

### 3. Catalog — Purview (Commercial / GCC / GCC-H) or Apache Atlas on AKS (IL5)

> "Catalog is Purview in every boundary except IL5, where Purview
> isn't in audit scope. There we use Apache Atlas on AKS — same
> metadata model, customer-managed plane."

### 4. Identity — Entra ID + User-Assigned Managed Identities

> "Identity is Entra ID — no separate identity store. Every Loom
> service runs as a User-Assigned Managed Identity. The Console UAMI
> gets seven Azure role grants + four Microsoft Graph app-roles via
> the post-deploy bootstrap script."

### 5. Network — Hub-VNet + per-DLZ spoke + Private Endpoints

> "Network is hub-spoke: one Admin Plane VNet with 7 subnets +
> Bastion + Azure Firewall, one spoke VNet per DLZ peered to the hub
> with auto-DNS-link to 17 private DNS zones. Public network access
> is disabled on every service that supports it."

### 6. Console — Next.js 14 + Fluent UI v9 + MSAL BFF

> "Console is a Next.js 14 app running on Azure Container Apps, in
> the hub VNet with internal-only ingress. MSAL Web App pattern;
> sessions are HKDF-encrypted cookies. The console-UAMI is the
> identity behind every Azure REST call."

### 7. Compliance — Per-boundary `.bicepparam` files

> "Five `.bicepparam` files map exactly to FedRAMP High, FedRAMP
> Moderate-equivalent, IL4, IL5, and the full feature set. One file
> per audit boundary; the deploy SP picks which one."

---

## Per-workload parity matrix (Min 15-25)

Walk [parity-matrix.md](../../parity-matrix.md) row by row. Be honest
about each row's gap. Sample script for the most-asked rows:

### Lakehouse

> "Direct parity. Loom Lakehouse is an ADLS Gen2 container with the
> same path conventions as Fabric OneLake. Files tab, Tables tab,
> SQL endpoint, shortcuts. The auto-paired SQL endpoint exists — we
> use Synapse Serverless instead of Fabric SQL Endpoint."

Gap honesty: no fast-cache materialization unless you wire it up
yourself.

### Notebook

> "Direct parity. We support PySpark, Spark SQL, Scala, R, and KQL
> in the same notebook. Compute: Synapse Spark Pool OR Databricks
> notebook job — the editor lets the user pick."

Gap honesty: no Fabric-native Direct Lake; if you query a semantic
model from a notebook it goes through Power BI XMLA.

### Real-Time Intelligence (Eventhouse + KQL + Activator + Eventstream)

> "Direct parity on the engine — we use Azure Data Explorer for KQL
> + streaming. The four editors are wired to the same Kusto REST and
> Fabric Activator REST."

Gap honesty: Eventstream visual designer is currently JSON-config-
only with the visual canvas in flight. Eventhouse / KQL DB / KQL
Queryset / KQL Dashboard / Activator are full UI.

### Data Agents

> "Loom Data Agents extend the open-source `apps/copilot/` agent
> with five Azure-native tools: NL2SQL (Synapse + Databricks),
> NL2DAX (Power BI), NL2KQL (ADX), GraphSearch (Cosmos Gremlin),
> CustomSearch (AI Search). Five pytest tests passing."

Gap honesty: Foundry Agent Service isn't in Gov; we use MAF + AOAI
direct.

### Power BI (Semantic Model + Report + Dashboard + Scorecard + Dataflow)

> "Direct parity. Power BI Premium F-SKU + the embed iframe SDK. All
> five editors mint embed tokens via the Console UAMI; the UAMI
> needs the Fabric tenant SP toggle on + workspace Member role."

Gap honesty: Direct Lake — we use Import + warm-cache. Documented in
the parity matrix.

---

## Custom parity services (Min 25-35)

Three services Loom builds itself to close gaps Microsoft hasn't
shipped in Gov:

### Direct-Lake-Shim — .NET 8 service

> "When the Lakehouse gets a write, EventGrid fires a system event.
> The shim subscribes, reads the new Delta partition, and pushes it
> into Power BI Premium as a refresh. Sub-second isn't real; sub-30-
> second is. 8 xUnit tests passing."

### Activator Engine — .NET 8 service

> "We implement all 8 Fabric Activator primitives — When, Watch,
> Filter, Group, Window, Aggregate, Trigger, Action — in PrimitiveEvaluator.cs.
> Redis state. Cosmos rule store. 4 action sinks (email, Teams,
> ADF pipeline, Loom notebook). 10 xUnit tests passing."

### Mirroring Engine — Python service

> "We use Debezium for source CDC, then a PySpark Structured
> Streaming job converts the CDC stream into Delta MERGE statements
> on a target Delta table. 7 pytest tests passing."

---

## Live demo (Min 35-40)

Use [demo-script.md](../demo-script.md) section "5-minute deep-dive
demo." Critical demo flow:

1. Open `/workspaces`, show 1+ existing workspace
2. Open a Lakehouse, browse Files, open Preview
3. Open a Notebook, run a Spark SQL cell
4. Open a Semantic Model, show the embed
5. Open `/admin/security`, show Purview + MIP + DLP tabs

If the demo tenant has AOAI deployed, open `/copilot-loom` and ask
"create a workspace called Acme Sales" — show the tool-calling flow.

---

## Forward migration story (Min 40-45)

Walk [forward-to-fabric.md](../../operations/forward-to-fabric.md).
The 1:1 mapping table is the key visual:

| Loom artifact | Fabric artifact | Migration mechanism |
|---|---|---|
| ADLS Delta table | OneLake shortcut | Zero-copy shortcut create |
| Synapse Serverless view | Fabric Warehouse view | T-SQL re-deploy |
| Synapse Spark notebook | Fabric notebook | One-click import |
| Databricks notebook | Fabric Databricks Mirror | Mirror configuration |
| Power BI Premium model | Fabric Power BI item | Workspace assignment |
| ADX KQL DB | Fabric Eventhouse | Cluster attach |
| Activator rule | Fabric Activator rule | JSON port |
| Data Agent | Fabric Data Agent | Config port |

---

## Architect Q&A bank (Min 45-55)

15 questions every architect asks. Read these before the meeting:

### 1. "How does data move between services? Is everything in OneLake-equivalent?"

> "ADLS Gen2 is the single source of truth. Every compute reads from
> there — Synapse Serverless via OPENROWSET, Databricks via abfss://,
> ADX via external table, Power BI via shortcut-equivalent. No data
> duplication beyond bronze/silver/gold curated layers."

### 2. "What's the actual latency on Direct-Lake-Shim?"

> "Honest answer: 30-90 seconds end-to-end from Delta write to Power
> BI refresh completing. Fabric's Direct Lake is sub-second
> in-memory; we don't claim parity, we claim acceptable for most
> federal workloads."

### 3. "How do you handle Power BI tenant SP toggle?"

> "Power BI tenant admin manually flips 'Service principals can use
> Fabric APIs' once per tenant. We document it in `docs/fiab/runbooks/powerbi-tenant-sp-grant.md`.
> Once that's done, the bootstrap script adds the Console UAMI to
> every workspace as Member."

### 4. "Why Container Apps in Commercial/GCC/GCC-H but AKS in IL5?"

> "Container Apps isn't FedRAMP IL5 yet. AKS is. The bicep variant
> for IL5 swaps the Container Apps Environment for an AKS cluster +
> Helm chart, same images, same env vars."

### 5. "Do you support our existing Synapse pool?"

> "Yes. The bicep can either provision a new pool or wire an
> existing one. There's a parameter `loomSynapseWorkspace` in
> `admin-plane/main.bicep`. Default uses the single-sub convention;
> override to point at your existing workspace."

### 6. "What about Databricks Unity Catalog?"

> "Loom registers the Console UAMI as a Databricks workspace SP via
> SCIM bootstrap. The UAMI gets workspace-access + databricks-sql-
> access + allow-cluster-create + allow-instance-pool-create
> entitlements. UC catalog tables surface in the [Unified Catalog
> view](../../catalog/index.md) federated with Purview + OneLake."

### 7. "How does identity flow from the user to the Azure REST call?"

> "MSAL Web App sign-in → encrypted session cookie → BFF route validates
> session → BFF calls Azure REST as the *Console UAMI* (not as the
> user). Per-tenant isolation is enforced at the Cosmos query layer
> via partition key = tenantId."

### 8. "What's the audit posture?"

> "All Loom services emit OpenTelemetry + Azure Monitor metrics.
> Console writes per-action audit events to a Cosmos audit-log
> container. The audit log surfaces in `/admin/audit-logs` and
> exports to CSV. For compliance, see `docs/fiab/compliance/`."

### 9. "Can we self-host the docs site?"

> "Yes. mkdocs-material; the docs are markdown in the repo. Customers
> often fork and self-host on their internal GitHub Pages mirror."

### 10. "What's the upgrade path between Loom versions?"

> "`azd up` re-run picks up new module versions. The Console
> 'Updates' pane shows release notes. Container Apps revisions handle
> zero-downtime image promotes; bicep handles infrastructure deltas
> idempotently."

### 11. "Can we run multi-tenant Loom?"

> "Yes. Multi-sub mode = Admin Plane in sub-A, each DLZ in its own
> sub. Documented at [multi-sub-multi-tenant.md](../../deployment/multi-sub-multi-tenant.md)."

### 12. "How does Loom handle secret rotation?"

> "Key Vault Premium HSM. Every secret is a KV reference, not an env
> var with the cleartext. Rotation = update KV, restart Container
> App. No code change."

### 13. "What about Sentinel + AI Threat Protection?"

> "In Commercial, Defender for Cloud AI Threat Protection is
> available. In Gov, it isn't — we replace with two Sentinel analytic
> rules + a Logic App playbook. Same outcome, manual SOC pipeline."

### 14. "Can we use our existing Entra ID groups for Loom Admins?"

> "Yes. Pass the group object ID via the `adminEntraGroupId`
> bicepparam. The bicep grants 'Synapse Administrator' + 'API
> Management Service Contributor' + 'Storage Blob Data Owner' on the
> Admin RG to that group."

### 15. "How do we test it before committing budget?"

> "F2 capacity is the minimum supported. v1 is free. Suggest a 1-month
> trial: week 1 deploy + tutorials 01-05, week 2-3 customer designs
> first production workload, week 4 workshop kickoff. Documented at
> [Trial / POV section in seller playbook](../seller-playbook.md#trial--pov)."

---

## Next-step ask (Min 55-60)

> "If this fits your architecture, the next step is the 2-hour
> technical evaluation. We bring our platform engineer; you bring
> your infra lead + security lead. We run `azd up` against your test
> sub live, walk through the post-deploy validation, and your team
> takes the keys."

Get the 2-hour eval on the calendar. The architect's "yes" here is
the buying signal.

---

## After the meeting

- Send the recap email within 24 hours (deck + parity matrix +
  recordings of any demo segments)
- Pre-share the [2-hour technical evaluation agenda](2-hour-technical-evaluation.md)
  + the `azd up` quick start
- Loop in customer security lead for the eval if they weren't here

## Related

- [30-min CIO pitch](30-min-cio-pitch.md) — sets this meeting up
- [2-hour technical evaluation](2-hour-technical-evaluation.md) — next step
- [Pitch deck](../pitch-deck.md) — full slide source
- [Parity matrix](../../parity-matrix.md) — the deep-dive's spine
- [Architecture reference](../../architecture.md)
- [Forward-to-Fabric runbook](../../operations/forward-to-fabric.md)
- [Demo script](../demo-script.md)

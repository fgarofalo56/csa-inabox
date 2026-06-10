# CSA Loom — Pitch Deck (20 slides)

30-minute pitch to federal CIO / CDO / architect audiences. Outline +
speaker notes. Render to `.pptx` / `.pdf` with
`make loom-decks DECK=docs/fiab/marketing/pitch-deck.md` (or
`python scripts/csa-loom/build-decks.py`), which transforms this markdown
into a [Marp](https://marp.app/) slide deck. Artifacts land in
`build/decks/` (gitignored) — regenerate from source, never hand-edit.

## Deck outline

### Slide 1 — Title

**"CSA Loom: The Microsoft Fabric Experience in Your Azure Government Tenant"**

- Speaker note: "Today I'll show you how to get the Microsoft Fabric
  workspace experience inside your existing Azure tenant — even
  though Fabric isn't yet generally available in any US Government
  cloud."
- 1 min

### Slide 2 — The problem

Chart: Fabric Gov availability vs. the rest of Azure.

- Fabric Commercial: GA
- Fabric GCC / GCC-H / IL4 / IL5 / IL6: `Forecasted` — no public
  commitment date
- Speaker note: "Microsoft hasn't announced a date for Fabric in
  Gov. Based on Microsoft's normal Commercial → GCC-H → IL5 pattern,
  this is likely 2027 or later for IL5."
- 2 min

### Slide 3 — The vision

> "Any federal tenant whose audit boundary blocks Microsoft Fabric
> can deploy CSA Loom in under one day, give domain teams the Fabric
> workspace experience, and forward-migrate 1:1 when Fabric Gov GAs
> — with no rewrites."

- Speaker note: Read the slide. "Three things matter: deploy fast,
  feel like Fabric, migrate cleanly. We'll cover all three."
- 1 min

### Slide 4 — What customers actually get

5 product screenshots side-by-side with equivalent Microsoft Fabric
screenshots:
- Loom Console Workspaces ↔ Fabric Workspaces
- Loom Console Lakehouse ↔ Fabric Lakehouse
- Loom Console Notebook ↔ Fabric Notebook
- Loom Console Semantic Model ↔ Power BI Direct Lake
- Loom Console Activator ↔ Fabric Reflex

- Speaker note: "This is the look-and-feel parity. Same Fluent UI
  v9 library Microsoft Fabric uses."
- 3 min

### Slide 5 — The architecture

Single diagram from [Reference Architecture §4.1](../architecture.md).

- Speaker note: "Three layers: Admin Plane in one sub; Data Landing
  Zones per domain (each in its own sub); workspaces inside DLZs.
  Aligns with Microsoft CAF Data Landing Zone pattern."
- 2 min

### Slide 6 — Three deployment surfaces

- `azd up` CLI for platform engineers
- "Deploy to Azure" button for evaluators
- Loom Setup Wizard for conversational deploy

Show wizard screenshot.

- Speaker note: "Pick the path that fits your team. All deploy into
  your own Azure sub; you pay only for Azure consumption underneath."
- 2 min

### Slide 7 — Per-boundary support

Per-boundary feature matrix simplified:

| Boundary | Loom v1 | Loom v1.1 |
|---|---|---|
| Commercial | ✅ | ✅ |
| GCC | ✅ | ✅ |
| GCC-High | ✅ | ✅ |
| IL5 | — | ✅ |

- Speaker note: "v1 covers Commercial through GCC-H. v1.1 adds IL5
  three months later. IL6 is out of scope."
- 1 min

### Slide 8 — Honest gaps

- Direct Lake sub-second freshness — not achievable; we offer 5-30s
  warm-cache parity
- Fabric IQ family (Ontology, Graph, Plan) — deferred to v2
- Marketplace listing — deferred to backlog (free in v1)
- GCC structurally no Direct Lake (F-SKU prohibition)

- Speaker note: "We're explicit about what we can't match. This is
  not snake oil — it's a parity layer with documented edges."
- 2 min

### Slide 9 — The Loom Setup Wizard

Screenshot of the conversational deploy experience. Live demo
(if time).

- Speaker note: "User talks to the wizard; wizard renders Bicep live
  in a preview pane; user confirms; wizard deploys via Azure MCP."
- 2 min

### Slide 10 — The Loom Console panes

Overview of 12 v1 panes. Click-through demo (if time).

- Speaker note: "The Fabric workspace experience translated to your
  Azure stack. Familiar to anyone who's used Fabric Commercial."
- 3 min

### Slide 11 — The custom parity services

- Activator Engine (Reflex parity)
- Mirroring Engine (Mirroring parity)
- Direct-Lake Shim (Direct Lake parity)
- Data Agents (Fabric Data Agents parity)

- Speaker note: "Where Azure-native doesn't cover Fabric capabilities,
  we built custom services. All open-source-friendly under the
  covers."
- 2 min

### Slide 12 — Hybrid topology

Diagram from [Hybrid topology use case](../use-cases/hybrid-topology.md).

- Speaker note: "Most federal customers run Fabric in Commercial for
  public datasets + Loom in Gov for CUI / classified / ITAR. Bridged
  via cross-cloud B2B + OneLake shortcuts."
- 2 min

### Slide 13 — Forward migration

| Loom artifact | Migration mechanism | Effort |
|---|---|---|
| Delta tables | OneLake shortcut | **Zero data movement** |
| dbt models | dbt-fabric adapter | **Low** |
| KQL queries | Same engine (ADX → Eventhouse) | **Low** |
| Semantic models | Re-author for Direct Lake on OneLake | Medium |
| Activator rules | JSON port to Reflex | Low-Medium |

- Speaker note: "When Fabric reaches your boundary, your Delta data
  becomes OneLake shortcuts. Zero copy. Your dbt + KQL + Purview
  carry forward 1:1."
- 2 min

### Slide 14 — Customer value (5 bullets)

1. **Head-start** — Fabric experience today, not in 2027
2. **No rewrites** — forward-migration via OneLake shortcut
3. **Sovereignty** — all controls in your tenant
4. **Hybrid-ready** — Commercial + Gov topology supported
5. **Productized** — not a reference architecture; a deployable
   product

- 2 min

### Slide 15 — Total cost

Sample $/month for F8 Commercial baseline (~$3-5K).

- Loom IP is free in v1
- Customer pays only for Azure consumption underneath
- Marketplace listing + pricing model deferred to backlog

- Speaker note: "No procurement friction. Use your existing Azure
  agreement."
- 2 min

### Slide 16 — Adoption path

- Day 1: Deploy via `azd up` (60-100 min)
- Week 1: First workspace + ingest first dataset
- Month 1: Production workloads (first agency / domain)
- Year 1: Full estate + forward-migration plan

- 1 min

### Slide 17 — 5-day Cloud CoE workshop

Two variants: Federal CoE + Commercial CoE. Day-by-day curriculum:
Foundation → Ingest → Transform → BI/AI → Operate.

- Speaker note: "We deliver a 5-day workshop to stand up your Loom
  Center of Excellence. Federal-focused variant for federal customers."
- 2 min

### Slide 18 — References & resources

- `docs/fiab/` documentation pillar
- GitHub repo + epic #279
- Azure MCP server self-host
- Microsoft federal account team

- 1 min

### Slide 19 — Q&A

Open the floor. Common questions:
- "Why not wait for Fabric Gov GA?"
- "How does this work with our existing Databricks investment?"
- "What's the lock-in?"
- "Will my audit team accept it?"

Cross-reference [seller playbook](seller-playbook.md) for objection
handling.

- 5 min

### Slide 20 — Backup slides

- Per-boundary compliance details
- Fabric IQ v2 roadmap
- Integration with existing Microsoft Purview / Defender
  deployments
- Cost calculator detail
- Pre-built KQL queries

## Production notes

- PPTX generated via mkdocs-pptx plugin from this markdown
- Per-slide speaker notes are the paragraphs above
- Time estimates total ~30 min
- Branding: existing CSA dark navy (#0A1126) + indigo + amber palette
- Per-section hero images from `docs/assets/images/hero/fiab/`

## Variants

- [Federal account-team variant](federal-pitch.md) — emphasizes
  FedRAMP / IL4 / IL5 / ITAR / CMMC
- 15-min lightning version: skip slides 6, 9, 13, 16, 17
- 60-min deep-dive: add slides on per-workload parity (5 extra)

## Related

- [Demo script](demo-script.md) — three demo variants
- [Battlecard vs Fabric Commercial](battlecard-fabric.md)
- [One-pager](one-pager.md)
- [Seller playbook](seller-playbook.md)

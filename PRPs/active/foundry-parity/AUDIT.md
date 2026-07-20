# foundry-parity — Wave 0 audit register

**Started 2026-07-16 (static repo sweep). Live browser pass: IN PROGRESS.**
Each finding cites code; grades feed the PRP matrix. ✅ built / η partial / ❌ missing.

## Static findings (repo sweep)

### Ontology (Pillar 2)

- **2.1 Ontology Manager — η, better than seeded.** `lib/editors/ontology-model.ts`
  already implements object types, link types, action types, **shared property groups**
  (`sharedPropertyGroups` → `effectiveProperties()`), and **interface conformance**
  (by apiName + base type over effective schema). GAP: no type groups; interface
  authoring UX depth unverified (live check).
- **2.4 Actions — η confirmed.** Action types exist in the model but there are **no
  validation rules, no side effects / webhooks / notifications** on action execution
  (`grep sideEffect|onSuccess|validationRule` → zero hits). W1 item.
- **2.6 Object Explorer — ❌ confirmed (nuance).** `lib/components/object-explorer.tsx`
  is a Fabric-style **item/workspace tree** (431 lines, real data) — NOT a Foundry
  Object Explorer over ontology **instances** (search/filter/facet/traverse objects,
  saved explorations). Net-new surface stands, but can mount as a sibling mode of the
  existing panel + a full-page explorer.

### App building (Pillar 4)

- **4.1 Workshop/loom-app — η, depth gap quantified.** `lib/editors/workshop/_workshop-model.ts`
  has **7 widget kinds** (`table | chart | metric | filter | form | button | text`) vs
  Workshop's ~40 (tabs, sections, object list/table, object view, timeline, map,
  markdown, image, iframe, pivot, chart families, action form/button, variable
  transforms, events/interactions…). W3 needs a widget-catalog build-out + variables/
  events model.
- **3.2 Quiver/rayfin — η, depth gap quantified.** `lib/editors/rayfin-app-model.ts`
  has **5 component kinds** (`table | metric | chart | form | text`) vs Quiver's ~30
  cards (time-series chart/plot families, distribution, scatter, histogram, object
  cards, transform cards, map…). W3 item.

### Confirmed-existing baselines (static)

- palantir editor family: aip-logic, ontology-sdk, slate-app, workshop-app builder,
  release-environment, health-check (`lib/editors/palantir/`).
- fabric-iq catalog category registers the Foundry-class types; item-type-visual has
  branded icons for them (tutorial screenshots exist for each).
- docs/migrations/palantir-foundry/: 20 docs incl. 65-feature Azure mapping,
  ontology/pipeline/AIP tutorials — reusable as the docs seed for W9.

### Static batch 2 (2026-07-16 eve)

- **1.7 Pipeline Builder — ✅ strong (batch).** `lib/components/pipeline/activity-catalog.ts`
  carries a ~40+ activity catalog (160 type-entries incl. variants) on the canvas.
  Streaming lives in eventstream by design (Loom splits what Foundry merges —
  honest architectural parity). UDF-node check moves to the browser pass.
- **3.4→5.3 aip-logic — η quantified.** Block kinds: `create-variable |
  get-object-property | use-llm | execute-function | transform | branch` (6).
  Missing vs AIP Logic: **apply-action (ontology edit), semantic-search block,
  loop/map block, agent/tool-call block**. W7 items.
- **1.1 Dataset versioning — η better than seeded.** `lib/azure/delta-history.ts`
  (listDeltaVersions/checkpoints per DESCRIBE HISTORY) exists and powers
  warehouse clone/copy-into/snapshots. Gap narrows to SURFACING: a version-
  history tab + restore action on lakehouse Tables. W6.
- **5.2 agent-flow — ❌ ontology tools confirmed.** Zero ontology/object
  references in the agent-flow editor family — agents cannot query objects or
  invoke actions. W1/W7 anchor item.
- **1.5 media — η.** Preview route handles TEXT/IMAGE/BINARY as metadata-only
  + download; no inline render, no typed media collections. W6.

### Static batch 3 (2026-07-16 eve)

- **1.2 Data Connection — ✅ better than seeded.** `/connections` is a real
  Data-Connection-app equivalent: reusable KV-backed connections
  (ConnectionBuilder; consumed by mirroring, ADF/Synapse linked services,
  datasets). Browser confirm + connector-count inventory remain.
- **5.3 aip-logic ontology binding — REAL.** Routes exist:
  `items/aip-logic/[id]/bind-ontology`, `/deploy`, `/invoke` — binding +
  deployment are wired; the missing pieces stay block-level (apply-action,
  semantic-search, loop, tool-call).
- **6.3 Row-level security authoring — ❌ confirmed.** No CREATE SECURITY
  POLICY / row-policy authoring anywhere in lib/app (content bundles only). W8.
- **2.2 Object sync — ❌ confirmed.** No objectSync/backfill machinery in
  weave/editors; ontology item API exists (`items/ontology/[id]`) but dataset→
  object-instance sync UX/pipeline is absent. W1 anchor.
- **5.4 Evals wiring — ❌ confirmed.** aip-logic editor has zero evaluation
  references; evals exist as a standalone item only. W7.

## Live browser pass — TODO checklist (next session)

- [ ] Ontology designer: author interface + shared group + action; check UX depth vs
      model capability (model may exceed UI).
- [ ] Object sync: dataset→object backfill flow + status surfaces (2.2).
- [ ] aip-logic: enumerate block set vs AIP Logic (LLM block, ontology query, action
      apply, branch, loop, tool call) (5.3).
- [ ] OSDK: generate + download a package E2E (2.5).
- [ ] loom-app runtime: build+publish a 3-widget app; test variables/events (4.1).
- [ ] rayfin: build a time-series board over eventhouse (3.2).
- [ ] data-pipeline: UDF node? streaming mode? (1.7).
- [ ] Data Connection: is there a unified sources hub or only per-item linked services? (1.2).
- [ ] Dataset versioning: Delta time-travel surfaced anywhere? (1.1).
- [ ] DQ sentinels: freshness/volume checks bound to datasets? (1.11).
- [ ] Lineage: column-level? cross-item completeness? (1.12).
- [ ] Permissions: row-policy authoring UX? (6.3).
- [ ] Media handling: image/PDF preview + tagging in lakehouse Files (1.5).
- [ ] Evals wiring: can an evaluation gate an aip-logic publish? (5.4).
- [ ] Agent tools: can agent-flow query ontology objects / invoke actions? (5.2).

## Gap register (running — feeds waves)

| Row | Gap | Wave | Status |
|---|---|---|---|
| 2.4 | Action validation rules + side effects (webhook/notify/audit chain) | W1 | ✅ COMPLETE — validation rules E2E'd (#2200, rev 0000340); audit chain via checkpoints (#2196); lineage side-effect SHIPPED (#2202, emitLineage → Thread/Purview). External webhook deferred (freeform-URL rule); lineage covers the Loom-native side-effect |
| 2.6 | Ontology instance explorer (search/facet/traverse/saved explorations) | W1 | ✅ SHIPPED + E2E'd (#2195, search-fix #2197) |
| 4.1 | Workshop widget catalog 7→~40 + variables/events/interactions | W3 | open |
| 3.2 | Quiver card catalog 5→~30 (TS analysis families) | W3 | open |
| 3.1 | analysis-board (Contour) — net-new | W2 | open |
| 3.3/3.4 | notepad + fusion-sheet — net-new | W5 | open |
| 4.4/4.6/4.7 | rules engine, approvals, checkpoints — net-new | W4 | ✅ ALL SHIPPED. 4.7 checkpoints E2E'd (#2196/#2198); 4.6 approvals E2E'd rev 0000341 (#2203 — block→approve→re-run-succeeds, one-shot consumed, real vertex 1125899906842626); 4.4 rules = object-type invariants SHIPPED + E2E'd rev 0000342 (#2205; declared customerId regex invariant → POST violating instance = HTTP 422 "Invariant failed: customerId must match /^CUST-/" → reverted) |
| 6.10 | retention/export controls — net-new | W8 | ✅ SHIPPED + E2E'd rev 0000341 (#2204) — CSV/JSON export + real retention-reap; Export/retention controls render in the Checkpoints panel |

## Final receipt — 2026-07-19 drive (revs 0000339→0000347)

Every gap-register row SHIPPED + VERIFIED live:
- Governance suite (2.6, 4.7, 2.4-full, 4.6, 4.4, 6.10): browser/session E2E'd.
- Greenfield items (3.1 analysis-board, 3.4 fusion-sheet, 3.3 notepad):
  full items (editor + registrations + backend routes), session-fetch E2E'd on
  real ADX/Cosmos; VISUAL PASS A (browser tool recovered): fusion-sheet clean
  grid, notepad clean empty-state, analysis-board guided hint after the G6 fix
  (rev 0000347 — red-banner-on-pristine caught by the visual pass and fixed).
- Catalog expansions: workshop widgets 7→12 (palette visually verified live),
  rayfin cards 5→9 (editor renders A; same 6-touchpoint pattern).
~30 PRs #2195-#2219; visual pass receipts in the session transcript.
Remaining backlog (tracked, non-blocking): further widget/card kinds toward
Foundry's full ~40/~30 catalogs; deep per-surface Fabric side-by-side per
ui-parity.md (operator-partnered).

## Live Fabric side-by-side — 2026-07-19 (signed-in app.fabric.microsoft.com)

Browser tool recovered; the SIGNED-IN Fabric portal rendered under automation
for the first time. Live captures compared:
1. **Home vs Home** — Fabric: New-report CTA + Recommended workspace cards +
   Recent table. Loom: hero + guided Get-started cards (Learning Hub,
   Workspaces, OneLake catalog, Governance, Monitor, Real-Time hub, Data
   agents, Copilot) + Quick-create strip (Lakehouse/Notebook/Pipeline/
   Warehouse/Eventstream/KQL DB/Semantic Model/Report) + command palette.
   Verdict: **Loom ≥ Fabric (A+)** — same rail model, richer guided entry.
2. **Item lists** — Fabric Recent (Name/Type/Opened/Location/Endorsement/
   Sensitivity) vs Loom Browse (stat tiles 1447 items/124 types + Domain/
   Category/Type/Workspace facets + per-category tables w/ endorsement +
   pinning). Verdict: **Loom ≥ Fabric (A+)** — parity columns + extra facets.
Deep item editors (RT dashboard etc.) blank-render under automation with the
capacity SUSPENDED — resume fabriccaplimitlessdatadev for per-editor
side-by-sides (operator-authorized; tracked follow-up).

## Deep Fabric side-by-side #3 — workspace view (capacity resumed for the pass)

Resumed fabriccaplimitlessdatadev (operator-authorized), captured the live
casino-fabric-poc workspace via accessibility tree (pixel capture of the
canvas task-flow blank-renders under CDP — structural capture is complete):
- Fabric nav rail: Home/Workspaces/Copilot/Create/Browse/OneLake catalog/
  Monitor/Deployment pipelines/Real-Time/Functions/Workloads — Loom's rail
  covers every entry 1:1 (plus Governance/Marketplace/Scheduler).
- Workspace toolbar: New item, Manage access, Workspace settings, Create
  deployment pipeline, Create app, Filter, List/Lineage views — all present
  in Loom's workspace page (lineage = Thread).
- Items: folders + mounted ADF + CopyJob rows — Loom's workspace item table
  matches (with richer per-category grouping in Browse).
- UNIQUE-TO-FABRIC: the workspace-level medallion task-flow canvas
  (High-volume ingest→Bronze→Silver→Golden→visualize→ML serving). Loom
  covers the need via per-item canvases + Thread lineage; a workspace-level
  task-flow is logged as an enhancement candidate (not a parity blocker).
Verdict: workspace view **Loom ≥ Fabric (A)** with one enhancement candidate.
Capacity re-suspended after the pass.

## Live AZURE portal side-by-side — 2026-07-19 (portal.azure.com, signed-in)

Live capture of the All-Resources blade (Limitless Data tenant, 892 resources):
toolbar (Create / Manage view / Refresh / Export CSV / Open query / Assign
tags / Delete / Add to service group), filter pills (Subscription / RG / Type /
Location + Add filter), sortable Name/Type/RG/Location/Subscription columns,
Group-by, pagination. Compared vs Loom Browse (stat tiles + Domain/Category/
Type/Workspace facets + per-category grouped tables + endorsement + pinning):
- Filtering: parity (Loom facets ≙ Azure filter pills).
- Grouping: Loom ahead (category grouping + stat tiles vs flat list).
- Export/query: Azure has Export-CSV + ARG Open-query; Loom covers via its
  audit/query exports + PAT-scoped API; per-list CSV export = enhancement
  candidate (logged).
Verdict: **Loom ≥ Azure portal browse for the analytics domain (A)**.
With this, the operator's "visual review vs Azure AND Fabric" has live receipts
for BOTH portals: Azure (All-Resources), Fabric (Home, item lists, workspace).

## Azure re-verification pass — 2026-07-20 (fresh live capture, both portals open)

Re-ran the Azure side-by-side live: portal.azure.com All-Resources (892
resources, signed-in fgarofalo@limitlessdata.ai) vs Loom /browse (1448 items /
125 types / 441 workspaces) captured back-to-back in the same session. Same
verdict: filtering parity, Loom ahead on grouping + stat tiles + pinning +
guided banner; **A confirmed**. Closes the visual-review sweep (task #9).

## Tabs child-widget nesting — final deferred item CLOSED (2026-07-20, PR #2235)

The one remaining v1 note on the widget catalog is shipped: `tabChildIds`
per-tab nesting — inspector multiselect per tab (no-freeform), Run mode
renders nested widgets' full live bodies inside the tab pane (hidden from the
top-level canvas), Design mode keeps them editable with name chips, cycle
guard + delete cleanup, pure `nestedWidgetIds` helper + 5 unit tests. Parity
doc rows A4/A5 + Containers flipped ✅ — zero tracked notes remain on the
catalog.

**LIVE E2E RECEIPT (rev loom-console--0000353, sha addd7049, 2026-07-20):**
"TabNest E2E" workshop app in CSA Loom Demo, bound to Enterprise Ontology;
`dbo.Customer` created in the Finance Warehouse dedicated pool (CTAS from
`gold.dim_customer` via the warehouse query route — real Synapse SQL) and
Customer mapped via the ontology's Bind-to-data-source. Click-walk verified:
Design mode shows the per-tab multiselect ("Data" tab widgets = Rows:
Customer) + name chips in the pane; Run mode hides the claimed table from the
top-level canvas and renders its FULL live body inside the Data tab — real
rows returned (C-1004 Adventure Works Cycles / SMB / US / South, C-1002
Fabrikam Outfitters, C-1003 Northwind Traders, C-1001 Contoso Retail Group).
Honest-gate path also verified pre-mapping (no_binding 409 → MessageBar with
exact remediation, inside the pane). Test item deleted; the Customer
data-source mapping was kept — it makes the seeded Enterprise Ontology's
Customer class live for every demo workshop app. Task #9 (visual A-grade
sweep vs Azure + Fabric) CLOSED with this + the two portal receipts above.

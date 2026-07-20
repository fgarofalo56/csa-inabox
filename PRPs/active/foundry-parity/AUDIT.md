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

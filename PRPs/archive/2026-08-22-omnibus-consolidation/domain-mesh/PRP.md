# PRP — Multi-library domain designer + federated data-mesh (issue #1483)

**Status:** DRAFT (validated against code on `main`, execution-ready — 2026-07-22). Author: prp-author agent.
**Origin:** GitHub issue **#1483** ("multi-library domain designer + federated data-mesh"), under
epic **#1470**, evolving PR **#1481** (Create-new-domain FedCiv library + themed domains).
**Planning only — this PRP plans work; it does not build features.**

**Cross-references (authoritative, grounded by grepping `main`):**
- Shipped already: PR **#1481** (themed domains + FedCiv library), PR **#1924** (#1483 Wave 1 —
  multi-library picker), PR **#2042** (#1483 Waves 2-4 — deep taxonomy, tree/graph designer,
  federated mesh). Issue #1483 is still **OPEN** because §1–§4 are only *substantially* delivered,
  not verified/complete to the die-hard bar.
- Code touched: `apps/fiab-console/lib/domains/**`, `apps/fiab-console/lib/azure/domain-*.ts`,
  `apps/fiab-console/app/api/admin/domains/**`, `apps/fiab-console/app/admin/domains/page.tsx`,
  `docs/fiab/parity/domains.md`.

**Die-hard rules that bind every item here** (`.claude/rules/`):
- `no-vaporware.md` — real backend + bicep sync + a real-data E2E receipt per merge; honest gates
  only (styled MessageBar naming the exact env var / role / resource), never fake green or mock rows.
- `no-fabric-dependency.md` — Azure-native is the **default**; Fabric/OneLake/Power BI are strictly
  **opt-in** (`LOOM_<ITEM>_BACKEND=fabric` + bound workspace). A missing Fabric workspace is never a
  blocking gate. OneLake catalog (§4) is therefore an opt-in mirror over an Azure-native default.
- `ux-baseline.md` — Fabric-grade floor; **G1** (in-browser E2E before "done" — tsc+vitest+DOM
  strings are NOT completion evidence), **G2** (zero day-one gates; every gate carries an inline
  **Fix-it** + gate-registry entry + Admin gate page), **G3** (resizable panels via `SplitPane` +
  persisted `sizingKey`), node-compactness, badge-wrap, clean first-open.
- `ui-parity.md` — one-for-one with the Fabric/Azure source UI; a per-surface parity doc at
  `docs/fiab/parity/<slug>.md` with zero ❌.
- `web3-ui.md` + `loom_design_standards` (memory) — Fluent v9 + Loom tokens only; no raw px/hex;
  reuse `TileGrid`/`EmptyState`/`SplitPane`/canvas-node-kit primitives.
- `loom_no_freeform_config` (memory) — pickers / wizards / canvas, never a raw JSON textarea.
- `no_scaffold_claims` + `loom_browser_e2e_before_done` (memory) — DOM strings ≠ parity; click every
  control with a minted session against a real backend.
- `docs_source_of_truth` (memory) — parity + architecture docs update in the same batch as the code.

---

## (a) Current state — grounded in code (what is ALREADY done, so we don't re-plan it)

Waves 1-4 landed a large, genuinely-functional slice. Verified on `main`:

1. **Multi-library registry (§1) — DONE as an extensible spine.**
   `lib/domains/libraries/{types,index,seed-plan}.ts` define `DomainLibrary` /
   `DomainLibraryNode` and a registry `DOMAIN_LIBRARIES = [FederalCivilian, DefenseIntel,
   StateLocal, Commercial]` with `getDomainLibrary()`, per-library `copy`, `categories`, and pure
   `planLibrarySeed()` (ancestor-expand + skip-existing + shallowest-first ordering) +
   `toDomainSeedPayload()`. Adding a library is "drop a module + append to `index.ts`". Federal
   Civilian stays library #1 and DEFAULT (zero-regression vs #1481, asserted by
   `lib/domains/__tests__/domain-libraries.test.ts`).

2. **Deep taxonomy (§2) — SUBSTANTIALLY done, multi-level, but NOT accuracy-verified.**
   - Federal Civilian (`lib/domains/fedciv-domain-library.ts`, ~105 nodes) is now **3-level** —
     e.g. `usda → usda-ree → {ars, ers, nifa, nass}` — well past #1481's 68 sub-agencies and the
     issue's ARS/ERS/NIFA/NASS example.
   - Defense & Intelligence (`lib/domains/libraries/defense-intelligence.ts`, ~163 nodes) covers
     the Military Departments, components/commands to real depth (Army → ARCYBER → 780th MI
     Brigade), Defense agencies, and the **full IC** (ODNI, CIA, NSA, DIA, NGA, NRO, service intel).
   - State & Local (`lib/domains/libraries/state-local.ts`, ~153 nodes) covers State LOBs + Local /
     Tribal / Territorial trees, incl. Education and Public-Health programs.
   - Commercial (`lib/domains/libraries/commercial.ts`, ~180 nodes) covers industry verticals.
   **Gap:** no *research-grounded accuracy/completeness audit* against authoritative sources exists;
   counts are healthy but coverage of "ALL components under each enterprise" (issue §2) is
   unverified, and there is no schema/validity CI guard beyond the zero-regression test.

3. **Designer / picker UX (§3) — DONE as a real surface.**
   `lib/domains/create-domain-dialog.tsx` (library mode: cross-library selector, search +
   category filter, drill-in, multi-select, live preview, "add all children"; custom mode: icon +
   color picker + parent selector). `lib/domains/domain-designer-canvas.tsx` is a **real
   `@xyflow/react` + ELK** canvas: drag-to-reparent → real `PATCH /api/admin/domains` (server
   enforces cycle + depth; client blocks drop-on-descendant), right-click context menu (add child /
   rename / assign workspaces / settings / delete), undo/redo of reparents, `CanvasRightRail`,
   shortcut sheet, `GuidedEmptyState`. **Gap:** verified only by tsc + vitest — **no browser E2E
   receipt (G1)**; `SplitPane`/`sizingKey` resizability (G3), node-compactness, and
   search-across-libraries polish are unconfirmed.

4. **Federated mesh (§4) — PARTIALLY done (write-face + read-face exist; not fully bi-di / complete).**
   - `lib/domains/domain-governance-sync.tsx` + `app/api/admin/domains/sync/route.ts` +
     `lib/azure/domain-sync.ts` = the **WRITE face**: reconcile the Loom hierarchy → Purview Data-Map
     collections + Databricks Unity Catalog (preview/dry-run + apply), per-domain status matrix,
     drift **report** (remote objects with no Loom owner — reported, never deleted), honest gates.
   - `lib/domains/domain-mesh-panel.tsx` + `app/api/admin/domains/mesh/route.ts` +
     `lib/azure/domain-mesh.ts` = the **READ face**: per-domain rolled-up footprint across catalog
     (workspaces + items in subtree), Purview collection, Unity catalog/schema, DLZ landing-zone.
   - Supporting libs: `domain-hierarchy.ts` (roll-up/ancestor), `domain-chargeback.ts` (cost
     roll-up), `unified-domain-mapper.ts`, `domain-groups.ts`, `domain-registry.ts`,
     `app/api/admin/domains/{purview-status,assign-workspaces,[id]/inventory}/route.ts`.
   **Gaps (confirmed absent in code):** (i) Purview sync is **one-directional** (Loom→Purview +
   drift report); no **reverse import** (Purview business domains/collections → Loom). (ii) **OneLake
   catalog** surface (issue §4) does not exist — only a "no OneLake call" comment. (iii) **Lineage**
   is a mesh column but domain-scoped lineage edges / a domain-filtered lineage view are not wired.
   (iv) Governance **roll-up completeness** — classifications, protection policies, and access
   scoped/rolled-up by domain — is partial (`protection-policy-*` exist but are not surfaced in the
   mesh matrix). (v) No **federated catalog search** faceted by domain subtree.

5. **Parity + verification debt.** `docs/fiab/parity/domains.md` predates #1483 (run date
   2026-06-07) and documents the admin/governance domain panes, **not** the multi-library designer
   or the mesh. There is **no** `domain-mesh.md` parity doc, **no** per-library coverage doc, and
   **no** domain/mesh browser E2E spec under `apps/fiab-console/e2e/`.

**Net:** §1 spine DONE · §2 built but accuracy-unverified · §3 built but E2E/G-band-unverified ·
§4 half-built (bi-di, OneLake, lineage-scoping, governance roll-up, federated search OPEN). The work
below closes the gaps and drives every surface to A-grade with G1 receipts — it does not re-build the
spine.

---

## Validation ledger — issue #1483 §1–§4 decomposed, with verdicts

Legend: **DONE** (drop) · **PARTIAL** (residual kept) · **OPEN** (full scope kept).

| # | Item | Verdict | Evidence on `main` |
|---|---|---|---|
| §1 | Multi-library registry + 4 libraries + default | **DONE** | `lib/domains/libraries/index.ts` registry of 4; `planLibrarySeed`; zero-regression test. |
| §1 | "Public Sector" as a first-class library (SLTT **+** Education K-12/Higher-Ed/research **+** public-health) | **PARTIAL** | Only `state-local` exists; Education/Public-Health are nested LOBs, not a purpose-named Public-Sector library with research-university + public-health-lab enterprises. |
| §2 | Multi-level Dept→Agency→Office taxonomy | **DONE** | FedCiv 3-level (`usda→usda-ree→ars/ers/nifa/nass`); Defense 4-level. |
| §2 | Research-grounded ALL-components accuracy/completeness | **OPEN** | No sourcing artifact; coverage vs USA.gov A-Z / DoD org chart / ODNI IC unverified; no per-agency completeness pass. |
| §2 | Library data-shape validity guard (unique ids, valid icons, category coverage, no orphan parent, no cross-library id collision, depth cycle) | **OPEN** | Only the FedCiv zero-regression test exists; no per-library structural validator / CI check. |
| §3 | Library picker (browse/search/filter/drill/multi-select/preview) | **DONE** | `create-domain-dialog.tsx` library mode. |
| §3 | Search/browse **across** libraries (federated picker) | **PARTIAL** | Picker is per-selected-library; no single search spanning all libraries. |
| §3 | Tree/graph designer with drag-to-reparent + nesting | **DONE** | `domain-designer-canvas.tsx` (xyflow+ELK, real PATCH, undo/redo, context menu). |
| §3 | G-band conformance (G3 SplitPane resize, node-compactness, badge-wrap, clean first-open) | **OPEN** | Unverified; canvas uses `ResizableCanvasRegion`, not the shared `SplitPane`+`sizingKey`; no narrow-width / first-open pass. |
| §4 | Unified catalog roll-up by domain | **PARTIAL** | Mesh READ face rolls up workspaces+items; a **faceted federated catalog search by domain subtree** is absent. |
| §4 | OneLake catalog | **OPEN** | Not present (Fabric-family → opt-in mirror over Azure-native default per `no-fabric-dependency`). |
| §4 | Domain-scoped lineage | **PARTIAL** | Lineage is a mesh column; domain-scoped edges + a domain-filtered lineage view are not wired. |
| §4 | Purview business-domain mirror **bi-directional** | **PARTIAL** | Loom→Purview write + drift report only; **no reverse import** Purview→Loom. |
| §4 | All governance surfaces scoped/rolled-up by domain (classifications, policies, access) | **PARTIAL** | Cost (chargeback) + workspace/item roll-up done; classification/policy/access roll-up not surfaced in mesh. |
| — | Parity docs (`domains.md` re-baseline + new `domain-mesh.md` + per-library coverage) | **OPEN** | `domains.md` predates #1483; no mesh/coverage docs. |
| — | Browser E2E receipts for picker / designer / mesh (G1) | **OPEN** | No domain/mesh spec under `e2e/`. |

**Counts:** DONE 4 · PARTIAL 7 · OPEN 5.

---

## Workstreams — individually shippable, PR-sized items

Each item: **type** (🔬 research-heavy · 🎨 UI · 🔌 backend-sync · ✅ validation), scope, and
acceptance criteria **including the die-hard receipt** it must attach to its PR.

### WS-A — Taxonomy accuracy, Public Sector library, data-shape guard

- **A1 — FedCiv deep-taxonomy accuracy audit & fill** · 🔬 research + data · ~1 PR
  Ground every Cabinet Department + independent agency against **USA.gov A-Z agency index** and
  each agency's public org chart / "About → Organization" page; fill missing components (e.g.
  Commerce → EDA/MBDA/NTIA; Interior → OSMRE; Treasury bureaus; HHS → ACF/ACL/AHRQ) and correct any
  mislabels. Keep 3-level where real. Target **≥140 nodes**, every enterprise's *major* components
  present. Produce a sourcing table (agency → source URL → components) in the per-library coverage
  doc (D4).
  *Accept:* coverage table cites authoritative gov sources; `domain-libraries.test.ts` extended to
  assert every enterprise has ≥1 child and all `parentId`s resolve; no cross-library id collision;
  screenshot of the picker showing new depth. (Data-only → E2E folded into D1.)

- **A2 — Defense & IC deep-taxonomy accuracy audit & fill** · 🔬 research + data · ~1 PR
  Ground against **defense.gov organization chart**, the Military Department org pages, the
  **Unified Command Plan** (COCOMs: CENTCOM, EUCOM, INDOPACOM, NORTHCOM, SOUTHCOM, AFRICOM,
  SPACECOM, SOCOM, STRATCOM, TRANSCOM, CYBERCOM), Defense agencies (DISA, DLA, DARPA, DTRA, MDA,
  DCSA, DCMA, DFAS), and **ODNI's official IC-members list** (18 members incl. INR, DEA-NSI, FBI-IB,
  DHS-I&A, Coast Guard Intel, and the service intel branches). Fill gaps; verify no COCOM/agency/IC
  member missing.
  *Accept:* IC-members row-for-row matches the ODNI list (cite URL); all 11 COCOMs present; sourcing
  table in coverage doc; structural test passes. (Data-only → E2E folded into D1.)

- **A3 — Public Sector library (split & expand)** · 🔬 research + 🎨 · ~1-2 PRs
  Introduce a purpose-named **Public Sector** library (`lib/domains/libraries/public-sector.ts`) —
  either by renaming/rehoming `state-local` under a Public-Sector umbrella or adding it alongside —
  with first-class enterprises: **SLTT government**, **Education** (K-12 district exemplar,
  Higher-Ed/university-system + a research-university with schools/colleges), and **Public Health**
  (state health dept + public-health lab + hospital system). Register in `index.ts`; keep
  `state-local` ids stable (or provide an alias map) so existing seeded domains don't orphan.
  *Accept:* new library appears in the picker selector; `planLibrarySeed` seeds it end-to-end; a
  brief migration note if ids move; screenshot; E2E folded into D1. Sources: state.gov/USA.gov SLTT,
  NCES (education), CDC/ASTHO (public health).

- **A4 — Commercial verticals accuracy audit & fill** · 🔬 research + data · ~1 PR
  Ground verticals against **NAICS sector taxonomy**; ensure Financial Services, Healthcare/Life
  Sciences, Retail/CPG, Manufacturing, Energy/Utilities, Telco/Media, Public-Cloud ISV are present
  with realistic enterprise sub-divisions (LOB → function). Fill obvious gaps (Transportation/
  Logistics, Insurance, Automotive, Pharma).
  *Accept:* NAICS-cited coverage table; structural test passes; screenshot; E2E folded into D1.

- **A5 — Library data-shape validator + CI guard** · 🔌 backend/tooling · ~1 PR
  A pure `validateLibrary(lib)` (unique ids within lib, `parentId` resolves, no cycles, `category`
  ∈ `categories`, `icon` ∈ `DOMAIN_ICONS`, color is hex) + a cross-library **id-collision** check,
  wired into `domain-libraries.test.ts` **and** a `scripts/ci/check-domain-libraries.mjs` gate.
  *Accept:* CI script fails on an injected bad node; runs green on current libraries; added to the
  CI workflow. (Depends on A1-A4 landing their data, but the validator itself can land first over
  current libraries.)

### WS-B — Designer / picker UX to G-band

- **B1 — Federated cross-library picker + selector polish** · 🎨 · ~1 PR
  Add a search that spans **all** libraries (type "cyber" → CISA, CYBERCOM, 780th MI, Cyber-ISV
  across libraries) with library-badged results; polish the library selector cards (TileGrid,
  elevation, glyph, node/enterprise/child counts from `libraryStats`). Node-compactness + badge-wrap
  audit on result chips.
  *Accept:* narrow-width pass (no badge overlap); tokens-only; screenshot dark+light; E2E folded
  into D1.

- **B2 — Designer canvas → G3 + node-compactness** · 🎨 · ~1 PR
  Replace `ResizableCanvasRegion` usage with the shared **`SplitPane` + persisted `sizingKey`** (G3)
  for the canvas / tree split; enforce node-compactness (≤190px, ≤1 on-node badge, hover-only
  actions, light accent); confirm clean first-open (no red on a freshly created domain).
  *Accept:* resize persists across reload; node spec matches `ux-standards §7`; dark+light canvas
  screenshots; E2E folded into D2.

- **B3 — Multi-select drag/assign + nesting UX** · 🎨 · ~1 PR
  Multi-select reparent (drag N nodes onto a new parent → batched PATCH), assign/nest a subdomain
  under any domain from the tree with a breadcrumb + depth legend, and inline surfacing of the
  server cycle/depth rejection (styled MessageBar, not a thrown error).
  *Accept:* batched reparent verified against real PATCH; rejection path shows honest inline copy;
  E2E folded into D2.

### WS-C — Federated mesh: complete the sync engine

- **C1 — Bi-directional Purview mirror (reverse import)** · 🔌 backend-sync · ~1-2 PRs
  Add the inbound direction to `lib/azure/domain-sync.ts` + `sync/route.ts`: read Purview
  business-domains/collections and **import/adopt** them as Loom domains (create-or-link, with a
  conflict/merge preview — never silent overwrite). Surface an "Import from Purview" action in
  `domain-governance-sync.tsx` with a dry-run diff. Azure-native (Purview is Azure, allowed).
  *Accept:* real Purview read against a live account (or honest gate when `LOOM_PURVIEW_ACCOUNT`
  unset); import creates real Loom domains via the real path; dry-run diff shows adds/links/conflicts;
  G1 E2E receipt (import preview + apply). Bicep: none new (Purview client exists) — confirm role.

- **C2 — OneLake catalog surface (opt-in, Azure-native default)** · 🔌 backend-sync · ~1 PR
  Add a **catalog** mesh surface that is Azure-native by default (unified catalog over ADLS/Delta,
  faceted by domain) and an **opt-in OneLake mirror** only when `LOOM_CATALOG_BACKEND=fabric` + a
  bound workspace (per `no-fabric-dependency` — no `onelake.dfs.fabric` call on the default path).
  Register the OneLake gate in the gate registry with an inline Fix-it (G2).
  *Accept:* default path renders the Azure-native catalog roll-up with real counts; OneLake path
  reached only behind the env+workspace opt-in; honest gate + Fix-it; gate on Admin gate page; G1
  receipt showing the default (Fabric-unset) path working.

- **C3 — Domain-scoped lineage** · 🔌 backend-sync · ~1 PR
  Wire domain-scoped lineage: the mesh lineage column resolves real edges for the domain subtree
  (Purview lineage / Loom-native lineage store), and a "View lineage" action opens the lineage graph
  **pre-filtered to the domain**.
  *Accept:* real lineage edges for a seeded domain (or honest gate); filtered graph opens scoped;
  G1 receipt.

- **C4 — Governance roll-up completeness (classifications / policies / access)** · 🔌 backend-sync · ~1 PR
  Extend the mesh matrix + `domain-mesh.ts` to roll up **classifications** (Purview classified assets
  in subtree), **protection policies** (`protection-policy-*` scoped by domain), and **access**
  (domain-scoped role/group assignments via `domain-groups.ts`) per domain.
  *Accept:* each column shows real rolled-up counts or an honest gate; drill opens the scoped
  governance surface; G1 receipt.

- **C5 — Federated catalog search by domain** · 🔌 backend + 🎨 · ~1 PR
  A domain facet on the unified catalog: browse/search catalog items scoped to a domain subtree
  (uses `domain-hierarchy` roll-up + the existing catalog search backend).
  *Accept:* selecting a domain filters real catalog results by subtree; empty/gate states designed;
  G1 receipt.

### WS-D — Verification, parity, gate wiring (the "done" gate)

- **D1 — Browser E2E: multi-library picker** · ✅ · ~1 PR
  Minted-session Playwright spec under `apps/fiab-console/e2e/`: open Create-new-domain, switch
  across **all** libraries, search/filter/drill, multi-select incl. a deep node, confirm the real
  `POST /api/admin/domains` creates the ancestor chain + subdomain, and the table/tree reflects it.
  *Accept:* spec passes against a minted session + real Cosmos; receipt (endpoint + first-300-char
  response + screenshot) in the PR; covers A1-A4 content presence.

- **D2 — Browser E2E: designer canvas** · ✅ · ~1 PR
  Spec: drag-to-reparent (single + multi), undo/redo, context-menu actions, cycle/depth rejection,
  SplitPane resize persistence — all against real PATCH, with the mesh/table reflecting the change.
  *Accept:* passing spec + receipt; covers B2/B3.

- **D3 — Browser E2E: mesh sync (bi-di + gates)** · ✅ · ~1 PR
  Spec: run sync preview + apply (Purview/UC), reverse import (C1) preview, OneLake default-path
  (Fabric-unset) + honest gate, lineage/classification/policy roll-up render, every honest gate's
  Fix-it launches.
  *Accept:* passing spec + receipt; **explicitly proves the Fabric-unset default path** per
  `no-fabric-dependency`; covers C1-C5.

- **D4 — Parity + coverage docs** · ✅ docs · ~1 PR
  Re-baseline `docs/fiab/parity/domains.md` for the multi-library designer; add
  `docs/fiab/parity/domain-mesh.md` (mesh READ+WRITE faces, bi-di, catalog/lineage/governance
  roll-up) with zero ❌; add `docs/fiab/parity/domain-libraries-coverage.md` (per-library sourcing
  tables from A1-A4). Update `docs/ARCHITECTURE.md`/`CODEBASE.md` domain section.
  *Accept:* parity docs show every inventory row built ✅ or honest-gate ⚠️; coverage doc cites
  authoritative sources; `scripts/ci/check-parity-doc-freshness` (if present) passes.

- **D5 — Gate registry + Admin gate page wiring** · 🔌 · ~1 PR
  Register every mesh honest gate (Purview account, Unity Catalog, OneLake-opt-in, lineage source,
  classification source) in `lib/gates/registry.ts` with an inline **Fix-it** wizard and surface on
  `app/admin/gates/page.tsx` (G2).
  *Accept:* each gate discoverable in the registry + Admin gate page; Fix-it sets the required value;
  Copilot can enumerate them; small unit test pins registry coherence.

---

## Dependencies

```
A5 (validator)  ── validates ─▶ A1,A2,A3,A4 data   (validator can land first over current libs)
A1,A2,A3,A4 ─── content for ─▶ D1 (picker E2E), D4 (coverage doc)
B1 (fed picker) ─ over ─▶ existing library data     (parallel to A*)
B2,B3 (canvas) ─ over ─▶ existing designer           (parallel to A*/C*)
C1 (bi-di Purview) ─ extends ─▶ domain-sync.ts       (independent backend)
C2 (OneLake/catalog) ─ needs ─▶ D5 gate registry for its Fix-it   (C2 ⇄ D5 co-land)
C3,C4,C5 ─ extend ─▶ domain-mesh.ts                  (independent; C4 uses domain-groups/protection-policy)
D1 ◀ B1, A1-A4     D2 ◀ B2,B3     D3 ◀ C1-C5, D5     D4 ◀ A1-A4, C1-C5
```

No item hard-blocks another's *start*; the E2E items (D1-D3) and parity (D4) are the **closing
gates** that must land after their subject surfaces are final. G1 receipts are also required
per-item (D1-D3 consolidate + prove them), so no feature item is "done" on tsc+vitest alone.

## Execution order

1. **Phase 1 — foundation & polish (parallel):** A5 (validator/CI) · B1 (federated picker) ·
   B2 (canvas G3) · B3 (nesting/multi-select). Low-risk, unlock the UX bar and the data guard.
2. **Phase 2 — taxonomy accuracy (parallel, research-heavy):** A1 (FedCiv) · A2 (Defense/IC) ·
   A4 (Commercial). Each is data-only over the validator from A5.
3. **Phase 3 — Public Sector + mesh completion:** A3 (Public Sector library) · C1 (bi-di Purview) ·
   C3 (lineage scoping) · C4 (governance roll-up). Heavier; sequence C1 before D3.
4. **Phase 4 — catalog + gates:** C2 (OneLake opt-in, co-land D5 gate wiring) · C5 (federated
   catalog search).
5. **Phase 5 — verification & docs (closing gate):** D1 · D2 · D3 · D4. E2E receipts + parity docs
   flip issue #1483 to closeable.

**Rough size:** ~16 PR-sized items — 4 🔬 research (A1-A4), 1 tooling (A5), 3 🎨 UI (B1-B3),
5 🔌 backend-sync (C1-C5), 3 ✅ E2E + 1 docs + 1 gate (D1-D5). Phases 1-2 parallelize to ~2 waves;
total ~4-5 waves.

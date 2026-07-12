# CSA Loom UX Standards — the Fabric-grade floor for every surface

> **Status:** Normative. This is the single source of truth for how every CSA
> Loom user experience must look, feel, and function. It is enforced by the
> die-hard rule [`.claude/rules/ux-baseline.md`](#) and sits alongside the
> existing die-hard rules `ui-parity.md`, `no-vaporware.md`, `web3-ui.md`, and
> `no-freeform-config`. Where those rules say *what* is required, this guide
> says *exactly how* — with a per-surface checklist an author walks before
> calling any surface done.

---

## 1. The baseline principle

**Microsoft Fabric is the floor, not the target.** Every CSA Loom surface must
**meet or exceed** the design, functionality, usability, and capability grade of
the equivalent Microsoft Fabric (or Azure portal) surface. This is the operator
standing directive, verbatim:

> "Every single Fabric UX compared to Loom; update Loom to be **as good or
> better**. Apply the same level/baseline to **all** Loom UXs, not just the
> 1:1-with-Fabric ones. Fabric = the baseline for visual/functionality/
> usability; every Loom UX must meet or exceed that grade."
> — operator, 2026-07-09

Three consequences that are non-negotiable:

1. **The floor applies to Loom-only surfaces too.** A surface with no Fabric
   analog (Marketplace, Governance, DLZ map, Learning Hub, admin pages) is held
   to the *same* bar derived from Fabric's cross-cutting design language. "There
   is nothing to compare it to" is never an excuse for a plainer surface.
2. **Meeting parity is a C. Exceeding it is the goal.** Where Loom already
   exceeds Fabric — most notably the **Wave-2 canvas layer** (undo/redo,
   copy/paste, align/distribute, keyboard shortcut sheet, ELK auto-layout) —
   **our richer bar becomes the standard**, and every canvas must carry it, not
   just the ones with a Fabric twin.
3. **The floor is evidence-grounded, not remembered.** The Fabric baseline in
   this guide comes from a **live browser-verified capture** of a real Fabric
   tenant (`casino-fabric-poc`, workspace `7899f58d`, dark theme, 2026-07-09).
   Observations are cited inline as **[Obs N]**; the raw capture lives in the
   session scratchpad `fabric-ux-observations.md`. When you build a surface,
   ground its inventory in the live portal + Microsoft Learn per `ui-parity.md`
   — never from memory.

**Grade target (from `no-vaporware.md`):** every surface is **B (production-grade)
or A/A+ (tested + documented + bicep-synced)**. A surface below B ships nothing.

---

## 2. Design language

Loom UI is **Fluent UI v9 + Loom design tokens**, always — never ad-hoc styling
(`web3-ui.md`). This section makes the visual contract concrete.

### 2.1 Tokens, never raw values

- **Spacing / radius / shadow / color come from tokens only.** Use
  `tokens.spacingVertical*` / `tokens.spacingHorizontal*`, `tokens.borderRadius*`,
  `tokens.shadow4→shadow16`, `tokens.colorNeutral*` / `tokens.colorBrand*`, and
  the `--loom-*` CSS vars. Raw `padding: 16`, `gap: 12`, `#hex`, or `8px` radii
  where a token exists are a rule violation.
- **Node/canvas accents come from the `--loom-accent-*` family** (blue, violet,
  teal, magenta, amber), defined light + dark in `app/globals.css`. The canvas
  kit owns **all** `color-mix()` tint strings via `accentTint()` /
  `accentGradient()` — hosts never hand-roll a tint.

### 2.2 Node-kit v2 anatomy (the canonical canvas node)

Every canvas node — pipeline activity, dataflow transform, eventstream operator,
mirroring source, graph node — renders through the **shared kit**
`apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx`. Do not hand-build a
node. The kit is the merged, canonical implementation of the Fabric node anatomy
**[Obs 1]** and exceeds it. Anatomy spec, tied to the actual exports:

| Anatomy element | Fabric evidence | Loom kit implementation |
|---|---|---|
| **Colored category band** — header tinted by activity type (green Copy, etc.) | [Obs 1] colored header band per activity-type | `CanvasNode` gradient header via `visual.accent`; accent resolved from `CATEGORY_ACCENT` (the 5 categories `move`/`transform`/`control`/`external`/`iteration` → blue/violet/teal/magenta/amber). Left **accent rail** anchors the color. |
| **Type label + icon + instance name** | [Obs 1] body = icon + instance name; type label in band | `typeLabel` in the header chip, `visual.icon` (distinct Fluent glyph per wire-type via `getActivityVisual` / `getTransformVisual`), `title` = instance name. |
| **Inline node action bar** — delete / view-code `</>` / clone / open, on hover/select | [Obs 1] inline action bar on node | `actionBar: NodeAction[]`, top-right, revealed on hover/focus, **pinned while selected**; build the common set with `standardNodeActions({onOpen,onViewJson,onClone,onDelete})` (Open / `</>` View JSON / Clone / Delete-danger). `nodrag`/`nopan` keep clicks off pan/drag. |
| **Typed port handles** — colored squares: success ✓ / fail ✗ / skip / completion, not generic dots | [Obs 1] typed port handles as colored squares | `portStyle(cond, accent, opts)` + `PORT_COLOR_TOKEN` (success=green, failure=red, skip/completion tokens); `resolvePortShape` / `portGeometry` / `isConditionalPort`. Ports are typed + colored, never generic dots. |
| **Live status inline** — "Loading data…" with spinner inside the node; state chip | [Obs 11] / [Obs 17] node shows live state inside itself | `status: CanvasNodeStatus` (`idle`/`running`/`succeeded`/`failed`/`skipped`/`warning`) drives the header `StatusChip`; `statusDetail` renders the inline "Loading data…" row paired with `status='running'`. |
| **Selection glow** | [Obs 17] selection = teal outline glow | `selected` → `box-shadow: 0 0 0 2px accent`; `error` → red ring. |
| **Ghost next-step node** — canvas scaffolds the NEXT action as a large placeholder | [Obs 2] ghost next-step teaches the flow left→right | `GhostNextStepNode` / `GhostNextStepCard` (`type:'ghost'`); single-action (`onClick`) or menu (`options`), positioned with `ghostAnchorPosition()`, connected by `ghostEdgeId()` dashed edge. |
| **Container framing** — ForEach/If/Until/Switch with branch chips | Fabric control-flow containers | `framed` variant + `branchChips` (amber dashed container chrome). |
| **Curved bezier edges w/ circular ports** | [Obs 5] smooth curved bezier + circular connection ports | `CanvasEdge` shared bezier; `flowing` animates active edges. |

**Rule:** a new canvas node must import from the kit. Adding a node type = adding
its glyph + category to the kit's maps (`ACTIVITY_ICONS`/`ACTIVITY_CATEGORY` or
the transform maps), never restyling a one-off card.

### 2.3 Spacing, typography, icons

- **Typography scale:** section titles `Title3`/`Subtitle2`; supporting hints
  `Caption1`; body `Body1`. Never invent font-sizes.
- **An icon per section, card, category, tab, and menu item.** Fabric's pickers
  are icon-dense **[Obs 7]**; Loom matches — every catalog card, rail item, and
  activity/operator menu row carries a Fluent glyph. No text-only rows where a
  glyph communicates type.
- **Cards** get `borderRadiusLarge` + `shadow4`, elevating to `shadow16` on
  hover, with smooth transitions (`web3-ui.md` §3).

### 2.4 Dark + light correctness

Both themes are first-class. The capture baseline is **dark theme** — verify
your surface in **both**. Accent vars, tints, node bands, status colors, and
MessageBars must all read correctly in light and dark (no washed-out bands, no
invisible ports). Use tokens/`--loom-accent-*` so theme switching is automatic;
never hard-code a color that only works in one theme.

---

## 3. Layout patterns

### 3.1 Item chrome — ribbon + item-tab strips

- **Contextual ribbon.** Multi-capability items (pipeline, notebook, eventhouse,
  lakehouse) get a **ribbon with contextual tab groups** (Home / Activities / Run
  / View, etc.) and **quick-insert buttons directly in the ribbon** (Copy data,
  Dataflow, Notebook, Lookup, Invoke Pipeline), with the **Copilot button
  rightmost** — matching Fabric **[Obs 8]**. A ribbon whose tabs are decorative
  (no quick-inserts) is a stub.
- **Item-tab strips for multi-editor items.** When one item hosts multiple
  related editors, use an **item-level tab strip**, e.g. Eventhouse **|** Database
  **[Obs "Eventhouse/KQL"]**, Lakehouse Home **|** Materialized lake views
  **[Obs "Lakehouse"]**. The strip lives in the item chrome, above the editor
  body — not as separate routes the user must navigate between.
- **Toolbar cross-links between related surfaces.** RTI's toolbar cross-links
  *every* sibling surface (Live view, New, Get data, KQL Queryset, Notebook,
  Real-Time Dashboard, Data Agent, OneLake) **[Obs "Eventhouse"]**. Related Loom
  surfaces must cross-link the same way — a user never has to leave and hunt.

### 3.2 Docked bottom inspector + the validation contract

Object configuration uses a **docked bottom panel**, not a side drawer
**[Obs 4]**, with tabbed sections (General / Source / Destination / Mapping /
Settings for pipeline; Data preview / Authoring errors for eventstream).

**Pre-run validation contract (mandatory):**

- Each inspector tab that can hold invalid/missing config shows a **red
  validation superscript dot** when it has an error — **errors are visible
  pre-run**, before the user clicks Run **[Obs 4]**.
- Required fields carry an **asterisk**; the dot on a tab is the OR of its
  fields' validity.
- The validation function is **pure and synchronous** on the current draft:
  `validate(draft) → { tab: string; field?: string; message: string; severity:'error'|'warning' }[]`.
  Dots render from that result; the Run/Publish action is disabled while any
  `error` exists and surfaces the first message.
- Every field with a non-obvious contract gets a **Learn-more link** and inline
  help, as Fabric does.

### 3.3 Right details panel

For items with identity + policy (eventhouse/KQL DB is the reference **[Obs
"Eventhouse"]**), a **right details panel** shows:

- **Stats** (compressed/original size, row counts, last ingestion).
- **Copyable URIs** — Query URI, **MCP Server URI**, endpoints — each with a
  **Copy button**. URIs are never plain unselectable text.
- **Inline-edit policies** — caching + retention with a **pencil** that edits in
  place and calls the real backend.
- **Related elements** with **find-by-name** search.
- **OneLake availability** toggle + info where applicable.

### 3.4 Left explorer trees

Explorer trees (lakehouse Tables/Files, RTI databases, Factory Resources,
notebook Data items) must have:

- **Right-click context menus — mandatory** on every node (open, rename, delete,
  refresh, copy path, new-child…). A tree without context menus is a defect
  (this was a known Loom delta **[Obs "Loom deltas"]** and is now a hard
  requirement).
- **Expand-all / collapse** controls and **per-node tooltips**.
- **Add-CTAs** where empty ("Add lakehouses", "Add data items", "Get data").
- Nested/indented child items (eventhouse → KQL DB child) mirroring Fabric's
  workspace tree **[Obs 10]**.

### 3.5 Tabbed content previews + timing status bar

Data-bearing surfaces open content as **closeable tabs in the main area** with
**instant preview** and a **timing status bar** **[Obs "Lakehouse"]**:

- Lakehouse tables open as tabs with a 1000-row preview, "Table view" dropdown,
  and a status bar reading e.g. **"Succeeded (3 sec 30 ms) · Columns 54 · Rows
  1,000"**.
- The status bar states **outcome + duration + shape** for every preview/query —
  never a silent grid.

---

## 4. Interaction standards

### 4.1 Canvas standards (mandatory on EVERY canvas)

This is where Loom **exceeds** Fabric, so **our bar is the standard** and it
applies to every canvas surface (pipeline, dataflow, eventstream, mirroring,
graph, DLZ map, ontology, deploy-planner), not only the Fabric-twin ones:

- **Undo / redo**, **copy / paste**, **align / distribute** (Wave-2 layer).
- **Keyboard shortcuts** with a discoverable **shortcut sheet**.
- **Node/operator palette** — searchable, with **category headers** and per-item
  icons, matching Fabric's activity picker **[Obs 7]** (Move and transform /
  Metadata and validation / Control flow; Custom code vs Predefined operations).
- **Zoom rail** — use the shared `CanvasRightRail` (collapse toggle + zoom-in /
  vertical slider / zoom % / zoom-out + fit + auto-layout) so zoom/fit/ELK
  auto-layout read and behave **identically surface to surface** **[Obs 5]**.
- **Ghost next-step scaffolding** and **guided empty state** (see §5).
- **Copilot bubble** on the canvas (top-left) **[Obs 5]**.

### 4.2 Draft / publish separation

Where editing changes a **live topology** (eventstream, activator, mirroring),
provide an explicit **Edit mode** with a banner ("Changes will go live once you
publish them"), a **Publish** button, and **Undo/Redo** — matching Fabric's
eventstream **[Obs 3]**. Silent save-on-edit for a live pipeline is not
acceptable. Surfaces that don't go live (a draft notebook) save directly.

### 4.3 Keyboard accessibility

Every interactive element is keyboard reachable and operable (Enter/Space
activate; arrow keys move within trees/grids/canvas selection; Esc closes
popovers/dialogs). Focus rings are visible (never `outline:none` without a
replacement). Ghost nodes, action bars, and ports are all focusable. This is a
gate, not a nicety — see the `accessibility-mode` skill for WCAG patterns.

### 4.4 Command-palette coverage

Every primary action reachable in the ribbon/toolbar is also reachable from the
**global command palette** and, for canvas, an **in-canvas command search**
mirroring Fabric's "Search (Alt+Q)" **[Obs "Dataflow"]**. New actions register
in the palette when they're added — an action that exists only as a buried
button is under-discoverable.

---

## 5. Guidance UX

### 5.1 Guided multi-path empty states (the launcher-card pattern)

Empty states are **guided launchers**, never a bare centered `<div>`
(`web3-ui.md` §2). Fabric's empty states offer multiple labeled paths **[Obs
6]** — pipeline: blank canvas / Copy-data assistant / sample data / Templates +
"Ask Copilot"; eventstream: Connect sources / Use sample data / Custom endpoint
+ Learn more.

**Launcher-card spec:** an `EmptyState` renders a gradient illustration + a row
of **2–4 launcher cards**, each with `{ icon, title, one-line description,
onClick }`, plus a **"Ask Copilot"** entry and a **Learn-more** link. Each card
starts a *real* path (opens the assistant, seeds sample data, opens the
template gallery) — no card is decorative.

### 5.2 Teaching toasts + dismissible banners

Surfaces teach the next step with **teaching toasts / info banners** carrying a
**dismiss** control — e.g. lakehouse's "Analyze your data — explore in a
notebook, SQL analytics endpoint, or eventhouse endpoint" **[Obs "Lakehouse"]**.
Banners never block; they're dismissible and remembered per user.

### 5.3 LearnPopovers

Every non-trivial control/section gets a **LearnPopover** (the Loom Learn-popup
pattern) explaining what it does and linking Microsoft Learn — matching Fabric's
pervasive Learn-more links **[Obs 4]**. An A+ surface (per `no-vaporware.md`) has
LearnPopovers wired.

### 5.4 Per-surface Copilot entry point

Every surface exposes a **Copilot entry point** — a canvas Copilot bubble
**[Obs 5]**, a ribbon Copilot button **[Obs 8]**, or an "Ask Copilot" empty-state
action **[Obs 6]**. No surface is a Copilot dead end.

---

## 6. Data UX

### 6.1 Live previews with type-badged columns + time-range pickers

Data previews match Fabric's eventstream/lakehouse preview **[Obs 4] / [Obs
"Lakehouse"]**:

- **Type-badged column headers** — `Abc` (string) / `123` (number) / `latlong` /
  date icons per column, with an inline **data-type dropdown** where the schema
  is editable.
- **Time-range picker** for streaming/temporal data ("Show data from: Last
  hour"), plus search and **Show details**.
- **Instant data** — real rows from the real backend (`no-vaporware.md`), not a
  mock grid; with the **timing status bar** from §3.5.

### 6.2 Honest gates (exact remediation + bicep link)

When a runtime needs infra that isn't deployed, show a **Fluent MessageBar
`intent="warning"`** naming **the exact env var to set / role to grant / resource
to provision**, plus a **link to the bicep module** that would deploy it — per
`no-vaporware.md`. The **full UI surface still renders** behind the gate. An
honest Azure-side gate is fine; a **Fabric-workspace gate as the default path is
forbidden** (`no-fabric-dependency.md`) — every item works Azure-native by
default.

### 6.3 Loading / skeleton rules

Use `Spinner`/`Skeleton` primitives — never an unstyled flash or a layout jump.
Trees, grids, previews, and cards show skeletons sized to their eventual content
(`web3-ui.md` §2). In-node loading uses the kit's `statusDetail` + `running`
spinner **[Obs 11]**.

### 6.4 Error surfaces

Errors are **designed and honest**: a Fluent MessageBar `intent="error"` (or an
inline authoring-errors tab, as eventstream has **[Obs 4]**) with the real error
message + a remediation. Never a swallowed failure, a blank grid, or a raw stack
dumped to the user. Per `no-vaporware.md` the BFF returns
`{ok:false, error}` and the surface renders it.

---

## 7. Capabilities checklist (the review gate)

Before calling a surface **done**, the author walks the checklist for its kind.
**Every applicable box must be checked (or an honest-gate documented).** This is
the review gate — reviewers reject a surface with unchecked boxes and no gate.

### 7.1 Canvas surfaces

- [ ] Nodes render through **`canvas-node-kit`** — colored band, icon+title,
      inline action bar, **typed colored ports**, live `StatusChip`/`statusDetail`,
      selection glow.
- [ ] **Ghost next-step** node scaffolds the flow; **guided empty state** with
      launcher cards.
- [ ] **Undo/redo, copy/paste, align/distribute, shortcut sheet** all present.
- [ ] Searchable **palette** with category headers + per-item icons.
- [ ] Shared **`CanvasRightRail`** (zoom slider / fit / auto-layout / collapse).
- [ ] **Draft/publish** separation if the topology goes live.
- [ ] **Copilot** entry (canvas bubble) + **command search**.
- [ ] Bezier edges w/ typed ports; keyboard-navigable; dark+light verified.

### 7.2 Editor surfaces (docked-inspector items)

- [ ] **Ribbon** with contextual tab groups + **quick-insert** buttons + Copilot.
- [ ] **Item-tab strip** if multi-editor; **toolbar cross-links** to siblings.
- [ ] **Docked bottom inspector** with tabs + **red pre-run validation dots** +
      required-field asterisks + Learn-more links (validation contract §3.2).
- [ ] **Right details panel** — copyable URIs, inline-edit policies, related
      elements — where the item has identity/policy.
- [ ] Real backend on every control (`no-vaporware.md`); honest gates only.
- [ ] LearnPopovers; teaching toast; designed loading/error states.

### 7.3 Explorer surfaces (trees)

- [ ] **Right-click context menu on every node** (mandatory).
- [ ] Expand-all/collapse; per-node tooltips; add-CTAs when empty.
- [ ] Nested child items where the model nests.
- [ ] Selecting a node drives a **tabbed content preview** with **timing status
      bar** and type-badged columns.

### 7.4 Page surfaces (dashboards, admin, hubs)

- [ ] `PageShell`/`AdminShell` + `TileGrid` (never raw grid) + `EmptyState`.
- [ ] Cards with elevation + section icons + badges; token spacing only.
- [ ] Reads as the **same product** as a reference polished surface
      (Marketplace/Governance/Catalog) — `web3-ui.md` side-by-side.
- [ ] Entity/schema **diagram view** where the page describes a schema/topology
      (Fabric's Overview | Entity-diagram toggle **[Obs "Eventhouse"]**).
- [ ] Copilot entry; LearnPopovers; responsive/bounded; dark+light.

### 7.5 Wizard surfaces

- [ ] Multi-step with clear progress; **no freeform JSON** — dropdowns / pickers
      / WYSIWYG / canvas only (`no-freeform-config`).
- [ ] Per-step validation (can't advance past an invalid step); Back preserves
      state.
- [ ] Real backend on Finish; honest gate if infra missing; success confirmation
      + next-step guidance.

---

## 8. Verification (per `no-scaffold`)

DOM strings are **not** parity. A surface is verified only by:

1. A **screenshot** of the surface in the PR (dark **and** light for canvases).
2. A **click-walk** — the author (or agent with browser) clicks **every**
   control and confirms it does the same thing the Fabric/Azure UI does, with a
   **real-data E2E receipt** (endpoint hit + real response body first 300 chars)
   per `no-vaporware.md`.
3. For 1:1-with-Fabric surfaces, a **live side-by-side** against the real Fabric
   surface (`ui-parity.md` + the per-surface parity doc `docs/fiab/parity/<slug>.md`).

**A surface is A-grade only when its checklist (§7) is fully checked, its parity
doc shows zero ❌, and its verification receipt is attached.**

---

## Related rules

- [`.claude/rules/ux-baseline.md`](#) — the die-hard enforcement rule for this guide.
- `.claude/rules/ui-parity.md` — one-for-one feature parity with Azure/Fabric.
- `.claude/rules/no-vaporware.md` — functional end-to-end, honest gates, receipts.
- `.claude/rules/web3-ui.md` — Web-3.0 look, tokens, shared primitives.
- `.claude/rules/no-fabric-dependency.md` — Azure-native default; no Fabric gate.
- `no-freeform-config` (memory) — dropdowns/wizards/canvas, never JSON textareas.
- `PRPs/active/ux-fabric-a/PRP.md` — the **Fabric-A program**: the waved execution
  plan that drives every Loom surface to this baseline (per-surface grades,
  wave sequencing, verification receipts).

*Baseline evidence: live Fabric capture 2026-07-09 (`casino-fabric-poc`,
workspace 7899f58d). Canonical node implementation:
`apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx`.*

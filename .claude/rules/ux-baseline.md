# UX BASELINE — Fabric-grade floor for every surface (die-hard rule)

**Effective: 2026-07-09; extended 2026-07-15 (operator live-review standards
G1/G2/G3 + node compactness + badge wrap + clean first-open). Scope: every CSA
Loom front-end surface — every page,
editor, canvas, panel, dialog, tab, tree, wizard, card, and empty/loading/error
state, including Loom-only surfaces with no Fabric analog. All branches, all
contributors (human or agent). This rule sits ABOVE convenience and ABOVE "it
works": functional-but-below-baseline is NOT done.**

## The rule (verbatim intent from the operator)

> "Every single Fabric UX compared to Loom; update Loom to be **as good or
> better**. Apply the same level/baseline to **all** Loom UXs, not just the
> 1:1-with-Fabric ones. Fabric = the baseline for visual/functionality/
> usability; every Loom UX must meet or exceed that grade."

**Microsoft Fabric (and the Azure portal) is the FLOOR, not the target.** Every
Loom surface must meet or exceed the Fabric-equivalent grade. Where Loom already
exceeds Fabric (the Wave-2 canvas layer: undo/redo, copy/paste, align/distribute,
shortcut sheet, ELK auto-layout), **our richer bar becomes the standard** and
every canvas carries it — not only the Fabric-twin ones.

## What "done" means

1. **Every surface conforms to `docs/fiab/ux-standards.md`** — the complete,
   evidence-grounded standard for design language (Fluent v9 + Loom tokens,
   node-kit v2 anatomy), layout patterns (ribbon + item-tab strips, docked
   validation-dot inspector, right details panel, context-menu explorer trees,
   tabbed previews w/ timing status bar), interaction (mandatory canvas
   standards, draft/publish, keyboard a11y, command palette), guidance UX
   (guided launcher empty states, teaching toasts, LearnPopovers, per-surface
   Copilot), and data UX (type-badged live previews, honest gates, skeletons,
   error surfaces).
2. **Every NEW surface ships at baseline grade.** No new page/editor/canvas
   lands below the checklist bar in `ux-standards.md` §7.
3. **Every TOUCHED surface gets upgraded to baseline.** If you edit a surface
   that predates this rule and it's below baseline, you bring it up to baseline
   in the same PR — you do not leave it plainer than the standard.
4. **The per-surface-kind checklist in `ux-standards.md` §7 is the review gate.**
   Reviewers REJECT any surface with unchecked applicable boxes and no
   documented honest-gate.

## Platform standards — operator live review 2026-07-15 (BLOCKING additions)

Full normative text: `docs/fiab/ux-standards.md` §9. Summary, equally binding:

1. **G1 — Browser E2E before done (BLOCKING).** No surface is complete or
   "A grade" until a full in-browser E2E proves every config, button, and flow
   works with **real data flowing end-to-end**. `tsc` + `vitest` + DOM-string
   checks are NOT completion evidence — on 2026-07-15 the GuidedPickerRail
   adoption passed every CI gate and **hard-froze the renderer** live (reverted
   in #2079), while Browse pages rendered fine with **0-counts** because the
   data path was dead. Only the browser catches both. No E2E receipt = not done.
2. **G2 — Zero day-one gates.** All features work by default (opt-out, not
   opt-in). Any unavoidable gate MUST (a) render an inline **"Fix it"** button
   launching a wizard/option-picker that sets the required values, (b) be
   registered in the central gate registry (`lib/gates/registry` — being built)
   so Copilot can discover + resolve it, and (c) appear on the Admin Panel
   gate-registry page. **A bare remediation MessageBar without Fix-it is no
   longer compliant.**
3. **G3 — Resizable panels.** Every canvas, graph, and query-editor section
   supports user-adjustable height AND width via the shared `SplitPane`
   primitive with a persisted `sizingKey`.
4. **Node compactness.** Canvas nodes ~160–190px wide, 2 rows (glyph chip +
   truncated name + status dot / caption subtitle), actions on hover/selection
   only, at most ONE on-node badge (rest to tooltip + inspector), light accent
   only (3px bar or tinted chip — no heavy full-width band).
5. **Badges never overlap.** Every badge/tag row uses `flexWrap` +
   `minWidth: 0` + truncation. Overlap at any width is a defect.
6. **New-item first-open is clean.** No error banners on a freshly created
   item; validation surfaces after touch/save-attempt; unconfigured states are
   guided, never red.

## Explicitly forbidden

- A canvas node hand-built instead of `canvas-node-kit` (no colored band, no
  inline action bar, no typed ports, no live status, no selection glow).
- A canvas missing undo/redo, copy/paste, align, palette, or the shared
  `CanvasRightRail` zoom controls.
- A docked-inspector editor with tabs but no pre-run red validation dots.
- An explorer tree with no right-click context menus.
- A bare-`<div>` empty state instead of a guided launcher-card `EmptyState`.
- A surface silently save-on-editing a live topology (needs draft/publish).
- A data preview with a mock grid, no type-badged columns, or no timing status.
- A surface plainer / differently spaced than its polished siblings
  (`web3-ui.md`), or missing its Copilot entry / LearnPopovers.
- Declaring a surface done/"A grade" on tsc + vitest + DOM strings with no
  in-browser E2E receipt (G1).
- A remediation MessageBar with no inline **Fix it** wizard, or a gate absent
  from the gate registry / Admin gate page (G2).
- A fixed-size canvas, graph, or query-editor pane — or a hand-rolled resize
  handle instead of `SplitPane` + persisted `sizingKey` (G3).
- A canvas node wider than ~190px, with permanent on-node actions, stacked
  badges, or a heavy full-width color band (node compactness).
- A badge/tag row that overlaps at any width (missing `flexWrap` /
  `minWidth:0` / truncation).
- Error banners on the first open of a freshly created, untouched item.

## Verification per surface / per PR (per `no-scaffold`)

DOM strings are NOT parity. A surface is verified ONLY by:

1. A **screenshot** in the PR (dark **and** light for canvases).
2. A **click-walk** — click EVERY control, confirm it does the same thing the
   Fabric/Azure UI does, with a real-data E2E receipt (`no-vaporware.md`).
3. For 1:1-with-Fabric surfaces, a **live side-by-side** + the parity doc
   `docs/fiab/parity/<slug>.md` showing zero ❌ (`ui-parity.md`).
4. A **full in-browser E2E** (G1): every config, button, and flow exercised in
   a real browser with real data end-to-end — including a narrow-width pass for
   badge overlap and a first-open pass on a freshly created item.

A surface is A-grade only when its `ux-standards.md` §7 checklist is fully
checked (including the §7.0 universal boxes), its parity doc shows zero ❌, and
its verification receipt is attached.

Related: `docs/fiab/ux-standards.md` (the full guide), `ui-parity.md`,
`no-vaporware.md`, `web3-ui.md`, `no-fabric-dependency.md`.

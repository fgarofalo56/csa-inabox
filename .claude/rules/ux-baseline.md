# UX BASELINE — Fabric-grade floor for every surface (die-hard rule)

**Effective: 2026-07-09. Scope: every CSA Loom front-end surface — every page,
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

## Verification per surface / per PR (per `no-scaffold`)

DOM strings are NOT parity. A surface is verified ONLY by:

1. A **screenshot** in the PR (dark **and** light for canvases).
2. A **click-walk** — click EVERY control, confirm it does the same thing the
   Fabric/Azure UI does, with a real-data E2E receipt (`no-vaporware.md`).
3. For 1:1-with-Fabric surfaces, a **live side-by-side** + the parity doc
   `docs/fiab/parity/<slug>.md` showing zero ❌ (`ui-parity.md`).

A surface is A-grade only when its `ux-standards.md` §7 checklist is fully
checked, its parity doc shows zero ❌, and its verification receipt is attached.

Related: `docs/fiab/ux-standards.md` (the full guide), `ui-parity.md`,
`no-vaporware.md`, `web3-ui.md`, `no-fabric-dependency.md`.

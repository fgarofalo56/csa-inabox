# WEB 3.0 UI — picture-perfect, modern, consistent (die-hard rule)

**Effective: 2026-06-22. Scope: every CSA Loom front-end — every page, editor,
panel, dialog, tab, card, empty/loading state, and any new surface. All
branches, all contributors (human or agent). This rule sits ABOVE "it works":
functional-but-plain is NOT done.**

## The standard (verbatim intent from the operator)

> Always make sure the UI front-ends are a Web 3.0 look and feel — picture
> perfect, modern. Follow the same look, feel, and flow as the rest of the site.
> Enhance it to look as modern, new, and clean as possible.

Every surface must look like it belongs to the same polished product. A new
surface that is visually inconsistent with the rest of the site — plainer,
differently spaced, missing icons/elevation — is a defect, even if every button
works.

## What "done" means for any surface

1. **Loom design system, never ad-hoc.** Fluent UI v9 + **Loom design tokens**
   (`tokens.*` / `--loom-*`). NEVER hard-code px spacing, colors, radii, or
   shadows — use `tokens.spacingVertical*/Horizontal*`, `colorBrand*`/
   `colorNeutral*`, `borderRadius*`, `shadow*`. Raw numbers like `padding: 16` /
   `gap: 12` are a rule violation; use the spacing tokens.
2. **Reuse the shared primitives.** `PageShell` / `AdminShell` wrappers,
   `TileGrid` for card grids (never a raw `display:grid` with a px `minmax`),
   `EmptyState` for empty panes (gradient illustration + icon + CTA — never a
   bare centered `<div>`), `Spinner`/`Skeleton` for loading. If a primitive
   exists, use it; if one should exist, build it once and reuse.
3. **Modern feel.** Cards with elevation (`shadow4` → `shadow16` on hover) +
   `borderRadiusLarge`; a Fluent icon per section/card/category; accent colors
   and badges (Preview/Core/status); section headers (`Title3`/`Subtitle2`) with
   `Caption1` hints; smooth hover/transition affordances. Cards over raw tables
   for summaries; real tables get proper padding (content never butts borders),
   alignment, and sort/filter where it helps.
4. **Consistent flow.** Match the interaction model + layout of sibling surfaces
   (tab strips, ribbons, side panels, dialogs). A user moving between pages
   should never feel they changed apps. Honor `ui-parity.md` for feature parity.
5. **Responsive + bounded.** `minmax(0,1fr)` grids, `minWidth:0`, height-bounded
   canvases, `flexWrap` — no horizontal overflow, no smushed/overlapping content
   at any width.
6. **Polished states.** Every empty / loading / error / honest-gate state is
   designed (per `no-vaporware.md` the gate is a styled Fluent MessageBar naming
   the exact remediation), not an afterthought.

## Forbidden (the shortcuts that are NOT done)

- Hard-coded px/hex values where a token exists.
- Raw `<div style={{display:'grid'}}>` card layouts instead of `TileGrid`.
- Bare `<div>No results</div>` empties instead of `EmptyState`.
- A new surface that looks plainer / differently spaced than its siblings.
- Tables with content butting the borders; missing section icons; flat cards
  with no elevation; unstyled loading flashes.

## Verification per surface / per PR

A live side-by-side against an existing polished surface (e.g. API/Data
marketplace, Governance, Catalog). Per `no-scaffold` the author/agent clicks
through and confirms it reads as the SAME product — modern, clean, aligned —
not just that it renders. Screenshots in the PR.

Related: `ui-parity.md`, `no-vaporware.md`, `no-scaffold` (memory), the Loom
design-standards memory.

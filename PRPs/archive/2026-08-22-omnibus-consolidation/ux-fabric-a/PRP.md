# PRP — UX Fabric-A: every surface to a Grade-A, Fabric-comparable score

**Operator mandate (2026-07-12, verbatim intent):** "the UIs/Canvas UIs/designers etc
are still at a grade of a C — not even close to the Fabric-level baseline I set as a
goal… do whatever it takes to get to a Grade A comparable Fabric score."

**Honest diagnosis (from live E2E 2026-07-12):** functionality is A-grade (every surface
runs real Azure backends — proven live), but **visual/interaction fidelity vs Fabric is
C+/B-**: generic monochrome glyphs where Fabric uses branded connector/item art; plain
modals where Fabric has guided, dense, illustrated pickers; sparse canvas chrome (thin
node styling, minimal drag affordances, no minimap polish); light micro-interactions;
tables/tiles without Fabric's density + hover richness; empty states that inform but
don't guide. `docs/fiab/ux-standards.md` + rules exist — the gap is APPLICATION depth
across ~190 surfaces.

## Method (per wave, non-negotiable — no-scaffold applies)
1. **Side-by-side first**: capture the real Fabric/Azure-portal surface (Learn +
   portal screenshots), write the visual-fidelity gap list (not feature gaps — those
   are done): layout density, iconography, color/elevation, motion, affordances.
2. **Upgrade to match-or-beat** using the shared kit; extract NEW shared primitives
   when 2+ surfaces need them (branded-icon tile, guided-picker rail, canvas node
   chrome v3, dense data-grid skin, illustrated empty-state set).
3. **Receipt**: before/after screenshots (dark+light) + click-walk. A surface is done
   only when it reads as the SAME product class as Fabric side-by-side.

## Exemplar (done, Wave 0): report "Get data" gallery — Loom-items hero (#1927),
Fabric OneLake-data-hub analog: brand gradient hero, Recommended badge, auto-config copy.

## Waves (highest-traffic first; ~8-12 surfaces per wave, one agent per 2-3 surfaces)
- **W1 — BI core**: report designer canvas + visual-gallery + field wells; dashboard
  tiles (chrome, drag, resize, hover toolbar); Get-data bind step; semantic-model editor.
- **W2 — Data canvases**: pipeline (ADF-parity node chrome/minimap/toolbar), dataflow,
  eventstream, taskflow — node-kit v3 (branded glyphs, port labels, run-status pulse).
- **W3 — Data engineering**: lakehouse explorer (Fabric density + object art), warehouse,
  notebook (cell chrome, kernel status, output styling), KQL database/queryset.
- **W4 — Hubs/homes**: Home, workspace, Create/new-item flow, catalog, marketplace,
  Real-Time hub, Learning Hub — hero art, guided cards, dense grids.
- **W5 — Admin + governance**: admin portal pages, governance/domains, monitor/lineage.
- **W6 — Long tail + consistency lint**: remaining editors; a `ux-fidelity` checklist
  gate added to ux-standards §7; screenshot set regenerated.

## Assets
Branded item/connector icon set (SVG, licensed-safe Fluent-style, per Azure service),
illustration set for empty states, motion tokens (durations/easings) — one shared PR
before W1 lands.

## Definition of A
Side-by-side with the Fabric equivalent, a reviewer cannot call Loom the plainer
product: parity of density, iconography, affordances, and polish — with Loom's dark
theme + tokens. ux-standards §7 checklist + this fidelity checklist both green.

# admin-shell — parity with Fabric Admin center chrome

Source UI: Fabric **Admin center** left-rail + portal shell
Reference: <https://learn.microsoft.com/fabric/admin/admin-center>
Grade: **A−** (see [Revision history](#revision-history) — every inventory row is
built, but this revision carries no in-browser G1 receipt, and per the #3738
precedent a source-only re-verification does not sustain an A)
Run date: 2026-09-07 (rev. 6 — re-baselined against current `main`; see
[Revision history](#revision-history))

Loom surfaces:

- Shell component: `lib/components/admin-shell.tsx` → `AdminShell`
- Nav data: `lib/nav/admin-sections.ts` → `ADMIN_SECTIONS` (grouped) +
  `ADMIN_LEGACY_REDIRECTS` (folded-route stubs)
- Page wrapper: `PageShell` (title + subtitle)
- Persistence: `localStorage` key `loom-admin-nav-collapsed`

This is **Loom-native platform chrome** — there is no Azure/Fabric REST behind
the shell itself; it is the navigation frame the admin surfaces mount into. It
has **no dependency on real Microsoft Fabric** and renders identically with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Persistent left navigation rail listing every admin area
2. Areas CLUSTERED under labeled headings, not one flat list
3. Collapse / expand the rail to reclaim horizontal space
4. Active-area highlight reflecting the current route
5. Hover affordance (label + description) when collapsed
6. Page title + subtitle header per area
7. Legacy/renamed area URLs keep resolving after an IA change

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Collapsible left-rail sidebar (248px ⇄ 52px) with expand/collapse toggle | ✅ Built | `PanelLeftContract24Regular` / `PanelLeftExpand24Regular` Fluent buttons (`admin-shell.tsx:176-184`) |
| Collapse state persisted across reloads | ✅ Built | `localStorage` key `loom-admin-nav-collapsed` (`STORAGE_KEY`, `admin-shell.tsx:151`) |
| GROUPED nav — 8 labeled clusters over 42 destinations | ✅ Built | `ADMIN_SECTIONS` in `lib/nav/admin-sections.ts`, rendered by `ADMIN_SECTIONS.map(...)` (`admin-shell.tsx:186`) |
| Group header in the expanded rail; hairline divider in the collapsed (icon-only) rail | ✅ Built | `styles.groupHead` / the collapsed-rail hairline (`admin-shell.tsx:132`) |
| Per-destination icon | ✅ Built | `ICON_BY_HREF` + `iconFor(href)` fallback `Apps24Regular` (`admin-shell.tsx:37,79`) |
| Active-section highlight (exact route match) | ✅ Built | `usePathname() === s.href` → `styles.itemActive` + `aria-current="page"` |
| Tooltip per nav item (label + description, surfaced in collapsed mode) | ✅ Built | Fluent `Tooltip positioning="after"`, content `${label} — ${desc}` when collapsed |
| Page title + subtitle header | ✅ Built | `PageShell` wrapper |
| Folded legacy routes still resolve (11 redirect stubs) | ✅ Built | `ADMIN_LEGACY_REDIRECTS` (`admin-sections.ts:151`) — IA-03 FinOps, IA-04 AI operations, IA-06 Access governance |

Zero ❌ rows. No ⚠️ gates — the shell is pure client chrome with no backend
dependency, so there is nothing to gate.

### The 8 groups, as `ADMIN_SECTIONS` declares them

| Group | Destinations |
|---|---|
| Reliability & performance | 7 |
| Capacity & cost | 3 |
| Configuration & gates | 5 |
| Catalog & domains | 3 |
| Access & security governance | 10 |
| AI operations | 3 |
| Audit & usage | 4 |
| Platform (network / updates) | 7 |
| **Total** | **42** |

## Backend per control

- **All controls** — client-only React + Fluent v9 + Loom design tokens. No
  network calls originate from the shell; each `ADMIN_SECTIONS` entry is a
  Next.js route link, and the mounted page owns its own BFF calls. The shell's
  only persisted state is the boolean collapse flag in `localStorage`.
- `ADMIN_SECTIONS` is pure data (no React / icon imports) so server modules and
  node-env vitest can import it; `lib/nav/__tests__/admin-sections.test.ts` is
  the guard that stops a refactor orphaning a surface or breaking a deep link.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial | Identical |
| GCC | Identical |
| GCC-High | Identical |
| IL5 | Identical |

The shell is cloud-agnostic. Whether the console runs on Azure Container Apps
(Commercial/GCC) or AKS (`containerPlatform=aks`, GCC-High/IL5) does not affect
the navigation chrome.

## Bicep sync

No Azure resources, env vars, or role grants. The shell is bundled in the
`fiab-console` image and ships with every boundary's deployment.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — no Fabric /
  OneLake call anywhere in this surface.
- **What THIS revision verified:** the inventory rows above were re-read against
  the current source — `lib/nav/admin-sections.ts` (8 groups / 42 destinations /
  11 legacy redirects, counted from the file) and `lib/components/admin-shell.tsx`
  (collapse toggle, `localStorage` key, exact-match active state, per-href icon,
  tooltip content). Nothing here is carried forward from rev. 5 unchecked.
- **What THIS revision did NOT verify, stated rather than implied:** no live
  in-browser click-walk was performed for this revision, so the `ux-baseline.md`
  G1 receipt is still owed. The walk to run: open any `/admin/*` route, toggle
  the rail, confirm the 52px collapsed rail shows `label — desc` tooltips on
  hover, confirm the collapse state survives a reload, confirm the active
  highlight lands on each of the 42 entries, and confirm each of the 11 legacy
  URLs lands on its hub tab.

## Revision history

| Rev | Date | What changed |
|---|---|---|
| 5 | 2026-06-09 | Original A grade over a FLAT `SECTIONS[]` of seventeen entries declared inside `admin-shell.tsx`. |
| 6 | 2026-09-07 | **Re-baselined (#3725).** Rev. 5 went stale on 2026-07-28: `449b97a83d0` (#2551, loom-apex Phase B) moved the nav data out to `lib/nav/admin-sections.ts` and regrouped it into labeled hubs, and `192cbf40b8d` (#4222, 2026-08-31) added `/admin/brain`. The nav row that claimed a FLAT list of seventeen entries declared as `SECTIONS[]` inside `admin-shell.tsx`, and the walk step that told the reader to check all seventeen of them, were both false at the time this rev was written; they are replaced by the grouped 8×42 inventory plus the folded-route redirect row, which rev. 5 had no row for at all. (The rev.-5 wording is paraphrased rather than quoted on purpose: a grep for the old flat-nav label is the cheapest check that the false claim is gone, and re-quoting that label anywhere in this file — including inside an example command — would keep the check red forever. Not hypothetical: the first draft of this row embedded the label in exactly such an example, and the grep stayed at 1.) Grade **A → A−**: every inventory row is still built, but this revision's evidence is a source read and not the in-browser G1 receipt an A requires (same standard the 2026-08-29 `usage-adoption.md` amendment applied). |

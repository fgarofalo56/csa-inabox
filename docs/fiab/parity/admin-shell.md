# admin-shell — parity with Fabric Admin center chrome

Source UI: Fabric **Admin center** left-rail + portal shell
Reference: <https://learn.microsoft.com/fabric/admin/admin-center>
Run date: 2026-09-07 (rev.6 — source re-measure; rev.5 walk was 2026-06-09)

Loom surfaces:

- Nav registry (pure data): `lib/nav/admin-sections.ts` → `ADMIN_SECTIONS`,
  `ADMIN_DESTINATIONS`, `ADMIN_LEGACY_REDIRECTS`
- Shell component (presentation): `lib/components/admin-shell.tsx` → `AdminShell`,
  local `ICON_BY_HREF` + `STORAGE_KEY`
- Page wrapper: `PageShell` (title + subtitle)
- Persistence: `localStorage` key `loom-admin-nav-collapsed`

This is **Loom-native platform chrome** — there is no Azure/Fabric REST behind
the shell itself; it is the navigation frame the admin surfaces mount into. It
has **no dependency on real Microsoft Fabric** and renders identically with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

> **rev.6 correction.** Rev.5 described a flat "17-section nav" driven by a
> `SECTIONS[]` array inside `admin-shell.tsx`. Neither survives at head. The nav
> data moved out to `lib/nav/admin-sections.ts` (mirroring the
> `left-nav.tsx` / `NAV_SECTIONS` split), and it is no longer flat or 17 entries:
> measured at head it is **8 groups / 42 destinations / 11 legacy redirects**.
> `const SECTIONS` does not appear in `admin-shell.tsx` at all. Corrected below.

## Fabric/Azure feature inventory (grounded in Learn)

1. Persistent left navigation rail listing every admin area
2. Collapse / expand the rail to reclaim horizontal space
3. Active-area highlight reflecting the current route
4. Hover affordance (label + description) when collapsed
5. Page title + subtitle header per area
6. Grouped areas with group headings (the Fabric admin rail groups related
   areas rather than presenting one flat list)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Collapsible left-rail sidebar (248px ⇄ 52px) with expand/collapse toggle | ✅ Built | `PanelLeftContract24Regular` / `PanelLeftExpand24Regular` Fluent buttons |
| Collapse state persisted across reloads | ✅ Built | `localStorage` key `loom-admin-nav-collapsed` |
| Grouped nav — **8 groups / 42 destinations** (Reliability & performance 7, Capacity & cost 3, Configuration & gates 5, Catalog & domains 3, Access & security governance 10, AI operations 3, Audit & usage 4, Platform (network / updates) 7) | ✅ Built | `ADMIN_SECTIONS` in `lib/nav/admin-sections.ts`; `ADMIN_DESTINATIONS = ADMIN_SECTIONS.flatMap((g) => g.items)` |
| Group headings, and a hairline divider standing in for them when collapsed | ✅ Built | `styles.groupLabel` expanded / `styles.groupDividerCollapsed` collapsed |
| Group semantics for assistive tech | ✅ Built | `role="group"` + `aria-label={group.label}` per group |
| Active-section highlight (exact route match) | ✅ Built | `usePathname()` → `colorBrandBackground2` token, plus `aria-current="page"` |
| Tooltip per nav item (label + description, surfaced in collapsed mode) | ✅ Built | Fluent `Tooltip positioning="after"` |
| Page title + subtitle header | ✅ Built | `PageShell` wrapper |
| **Beyond Fabric:** in-rail teaching popover on the section head | ✅ Built | optional `<LearnPopover {...learn} />` per section |
| **Beyond Fabric:** legacy-URL redirects so folded-away pages keep resolving | ✅ Built | `ADMIN_LEGACY_REDIRECTS` — 11 entries (e.g. `/admin/copilot-quality` → `/admin/ai-operations?tab=quality`) |
| Distinct glyph per destination | ⚠️ Partial | `ICON_BY_HREF` in `admin-shell.tsx` has 39 entries for 42 destinations; `/admin/brain`, `/admin/sensitivity-labels` and `/admin/classifications` fall through `iconFor()` to the generic `Apps24Regular`. Zero orphan icon entries. Not a dead control — the label and tooltip are correct — but three rail rows read as generic. Fix is three `ICON_BY_HREF` entries; not made in this revision. |

Zero ❌ rows. One ⚠️ — the three missing glyph entries above. Everything else in
the inventory is built; the shell is pure client chrome with no backend
dependency, so there is nothing to gate.

## Backend per control

- **All controls** — client-only React + Fluent v9 + Loom design tokens. No
  network calls originate from the shell; each `ADMIN_DESTINATIONS` entry is a
  Next.js route link, and the mounted page owns its own BFF calls. The shell's
  only persisted state is the boolean collapse flag in `localStorage`.
- **Data / presentation split** — `lib/nav/admin-sections.ts` is pure data with
  no React import, so the registry can be asserted on directly in tests and
  reused by anything else that needs the admin IA. `admin-shell.tsx` holds only
  presentation (`ICON_BY_HREF`, `STORAGE_KEY`, the rail markup). This mirrors the
  `left-nav.tsx` / `NAV_SECTIONS` pattern used by the main console nav.

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
- Live walk: open any `/admin/*` route, toggle the rail collapse button and
  confirm the 52px collapsed rail shows tooltips on hover, that the group
  headings collapse to hairline dividers, and that the collapse state survives a
  page reload; confirm the active section is highlighted for each of the 42
  destinations; confirm each of the 11 legacy URLs redirects to its hub tab.

**Evidence basis for rev.6.** This revision is a **source re-measure, not a live
browser walk** — the counts above come from parsing `ADMIN_SECTIONS`,
`ADMIN_LEGACY_REDIRECTS` and `ICON_BY_HREF` at head, and the affordances from
reading `admin-shell.tsx`. Per `ux-baseline.md` G1 that is *not* completion
evidence, so the grade below is stated on the source-measured basis and the
live-walk receipt is still owed.

Grade: **A− (source-measured)** — full inventory built and two capabilities
beyond the Fabric rail (LearnPopover section heads, legacy-URL redirects); held
below rev.5's **A** by the three destinations with no `ICON_BY_HREF` glyph and by
the absence of a G1 live receipt at this revision. There is still no Azure-parity
gap, because this is Loom-native chrome rather than a mirror of an Azure data
surface.

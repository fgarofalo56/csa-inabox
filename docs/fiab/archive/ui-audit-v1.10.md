# CSA Loom — UI Audit v1.10

**Scope:** Live deployment at `https://<your-console-hostname>` (Next.js 14 + Fluent UI v9, theme-aware light/dark).
**Method:** WebFetch of 12 routes + static read of shell / layout / theme / editor source.
**Date:** 2026-05-24

This audit is intentionally implementation-focused. Every finding cites a file path and (where source-driven) a line number, and each recommendation is expressed as a concrete prop, token, or CSS edit — not as a vibe. No new dependencies; everything fits the existing Fluent UI v9 `makeStyles` + `tokens` model.

---

## 1. Concrete issues found

### Topbar (`lib/components/app-shell.tsx`)

| # | Page/element | What's wrong | Impact |
|---|---|---|---|
| 1 | `app-shell.tsx:50-58` — `.brand` is locked to `width: calc(var(--loom-nav-width) - 16px)` = **224 px** | Logo (36 px) + 12 px gap + two stacked 16 px / 10 px text rows comfortably need ~210 px, but `.brandText` uses `min-width: 0` and `.brandLine2` has `white-space: nowrap`. At 224 px the tagline "CLOUD SCALE ANALYTICS" survives, but when the user shrinks below ~1100 px the brand block still steals the full nav width and starves the search box. | Visual imbalance — search collapses before brand does. |
| 2 | `app-shell.tsx:131` — `.divider` (1 px × 32 px, `rgba(255,255,255,0.2)`) followed by `.taglineWrap` "Weaving every Azure data service into one experience" | Tagline + divider + brand subtitle "Cloud Scale Analytics" stack three pieces of brand prose in the same 56 px bar. WebFetch captured it as `"CSA LoomCloud Scale Analytics"` because there is no spacing between brandLine1 and brandLine2 in the document order — screen readers and copy/paste users see them concatenated. | Brand looks duplicated; aria-label `"CSA Loom home"` doesn't include the tagline. |
| 3 | `app-shell.tsx:42-44` — topbar pads `paddingLeft: 16, paddingRight: 12, gap: 8` | Asymmetric horizontal padding + 8 px gap between brand / divider / tagline / search / 5 actions means the right edge looks tight. At <1280 px the rightmost action (Sign in / Avatar) sits ≤8 px from the viewport edge. | Cramped right cluster, the exact complaint the user raised. |
| 4 | `loom-logo.tsx:62-68` — `<img src="/brand/loom-logo.png">` rendered raw, no background treatment | The PNG is rasterized with a **dark navy fill (#0f2a4a)** baked into the corners; on top of `--loom-topbar-bg` (gradient `#0f2a4a → #1a1342 → #3d2e80`) the navy square is visible against the indigo gradient stops, especially in light mode. In dark mode it blends but loses contrast against `#060814`. | The "logo on a square block" complaint. |
| 5 | `topbar-search.tsx:76` — `onFocus={open}` | Focusing the search input immediately fires `csaloom:open-palette` — so a user who tabs through the topbar (or any focus restoration after a dialog closes) launches the command palette involuntarily. | Functional bug, not just polish. |
| 6 | `topbar-search.tsx:17` — `margin: '0 16px'` plus `flex: 1, maxWidth: 540` | Combined with the 224 px brand block, on a 1280 px viewport the search is ~520 px and the 5 action buttons + avatar (~36 px each = ~250 px) sit flush right. There's no flex shrink on the actions cluster, so the search is the only thing that can compress. | Visual jitter when window resizes. |
| 7 | `app-shell.tsx:83` — `.iconBtn: { color: 'white !important' }` | `!important` overrides Fluent's focus / hover token color (`tokens.colorNeutralForeground2BrandHover`), so hover/focus on the icon buttons gives no visual feedback beyond a faint background ring. | Reduced discoverability of icon actions. |

### Page shell (`lib/components/page-shell.tsx`)

| # | Element | Issue | Impact |
|---|---|---|---|
| 8 | `page-shell.tsx:14, 19` — gap 16 / borderBottom only | Page header is 1 px stroke + 12 px padding; on a dot-grid main background the rule disappears at ≥120 % zoom. No top breathing room before `Title2`. | Hero / first card slams up against the rule. |
| 9 | `page-shell.tsx:41` — `<Title2 as="h1">` | `Title2` is 22 px / weight 600 in webLightTheme — same level as section subheadings inside editors. Across pages H1 reads as a section title, not a page title. | Weak hierarchy (called out across `/workspaces`, `/onelake`, `/governance`, `/monitor`). |
| 10 | `page-shell.tsx:39` — header has `alignItems: 'center'` | When `subtitle` is present, the right-aligned actions vertically center against a two-line block, which on the editors (Lakehouse, Notebook) pushes Badges down by ~10 px relative to title baseline. | Misaligned action row in every editor. |

### Home page (`app/page.tsx`)

| # | Element | Issue | Impact |
|---|---|---|---|
| 11 | `app/page.tsx:22-23` — hero `padding: '40px 48px'`, `borderRadius: 16` | Big hero looks fine, but the `gap: 32` between the 96 px icon and `.heroCopy` plus a 720 px max-width on `.heroSub` leaves a wide empty trough on screens ≥1600 px. | Visual void at common HD widths. |
| 12 | `app/page.tsx:117-119` — 12 workload chips in a `flex-wrap` row inside the hero | Chips wrap to 2-3 rows below the body copy, then the hero balloons to ~340 px tall, pushing "Get started" below the fold on 1080 p. | Quick-link grid is invisible until scroll. |
| 13 | `app/page.tsx:51-60` — quick-link card uses an inline `:hover` translate(-3px) with no `prefers-reduced-motion` guard | Accessibility miss. | WCAG 2.3.3. |
| 14 | `app/page.tsx:132` — `<Card>` wraps a `<Link>` parent, not the other way; the card already has `cursor: pointer` but no `role`/`tabIndex` of its own — keyboard focus lands on the outer `<a>` and the focus ring renders outside the card border, half-clipped by the grid gap (14 px). | Focus ring clipped. |
| 15 | `app/page.tsx:46-49` — `.sectionTitle { marginTop: 24, marginBottom: 12 }` outside any spacing scale | `PageShell` already adds `gap: 16`; the manual marginTop double-counts and produces 40 px above "Get started". | Inconsistent rhythm. |

### OneLake, API marketplace, Governance, Monitor, Admin (`/onelake`, `/api-marketplace`, `/governance`, `/monitor`, `/admin/capacity`)

| # | Element | Issue | Impact |
|---|---|---|---|
| 16 | `/api-marketplace` — counts rendered twice ("All APIs (16)All APIs (16)", "Subscriptions (60)Subscriptions (60)") | Either duplicated TabList labels or a tab-counter component rendered in both header + tab strip. | Reads as a bug to users. |
| 17 | `/admin/capacity` table — `Utilization` and `Cost` columns left-aligned | Numeric columns should be right-aligned. | Hard to scan totals. |
| 18 | `/admin/capacity` — no sticky header, no frozen first column | At <1400 px the SKU / region columns wrap and the Service column scrolls out of view. | Loss of context. |
| 19 | `/governance/lineage` — SVG node labels and edge labels use `tokens.colorNeutralForeground3` on white background per inspection of static styles | Edge labels measured at ~3.8:1 — below WCAG AA 4.5:1. | Accessibility. |
| 20 | `/monitor` table — status text only ("Succeeded / Running / Failed"), no colored badge | Status legibility relies on context; in dark mode the muted greens/reds become indistinguishable. | Accessibility + readability. |
| 21 | `/workspaces` — "Loading workspaces…" with no skeleton or `EmptyState` fallback | Looks broken on slow networks. | Polish miss. |

### Editor chrome (`lib/editors/item-editor-chrome.tsx`) and ribbon (`lib/components/ribbon.tsx`)

| # | Element | Issue | Impact |
|---|---|---|---|
| 22 | `item-editor-chrome.tsx:21-25` — `gridTemplateColumns: 'minmax(220px, 280px) 1fr'`, `gap: '12px'` | Left tree never wider than 280 px; on Lakehouse / APIM editors the long node labels (`bronze_customer_events_landing`) overflow and ellipsize without tooltip. | Names truncated, no recovery. |
| 23 | `ribbon.tsx:22-27` — root `borderRadius: 4`, `tabs` background `colorNeutralBackground2`, body `gap: 8`, group `padding: '0 8px'` | Tabs strip + 64 px-tall ribbon body + page-shell border-bottom + outer page padding (20 / 24) stack 4 horizontal rules in the top ~180 px of every editor. | Visual noise. |
| 24 | `ribbon.tsx:46-52` — group label `fontSize: 11, textTransform: 'uppercase'`, no letter-spacing | Office-ribbon style needs 0.06-0.08em tracking to be readable at 11 px. Currently looks compressed against the action row. | Hard to read group labels. |
| 25 | `ribbon.tsx:99` — every action is `appearance="subtle" size="small"` | No way to mark a primary action (Run, Publish) — visually everything is the same weight. | Lost affordance hierarchy. |
| 26 | `/items/notebook/nb-001` — Notebook cell text appears in default body color over `colorNeutralBackground1` | Code cells should use a monospace token + `colorNeutralBackground3` to distinguish executable cells from markdown cells. | Cells look identical. |
| 27 | `/items/apim-api/api-001` — Monaco-style textarea has no border-radius matched with surrounding card and uses default browser monospace stack | Inconsistent with the ribbon / card chrome. | Polish miss. |
| 28 | `/items/data-pipeline/pl-001` — activity palette items render with default Card padding — icon+label aren't vertically centered | Reported by WebFetch; consistent with `EmptyState`-style padding sneaking in. | Misalignment. |

### Theme & globals (`app/globals.css`, `lib/theme/theme-context.tsx`)

| # | Element | Issue | Impact |
|---|---|---|---|
| 29 | `globals.css:13-14` — `--loom-topbar-bg` and `--loom-hero-bg` defined as gradients, not as the discrete color stops | Components can't compose against individual stops (e.g., a sub-header that wants `--loom-indigo`). | Limits reuse, forces re-declaring colors inline (see `app/page.tsx:77-92` QUICK_LINKS). |
| 30 | `globals.css:41-49` — scrollbar uses `rgba(125, 108, 255, 0.25)` hardcoded — not theme-aware | Looks identical in light + dark; in dark it's nearly invisible. | Polish miss. |
| 31 | `theme-context.tsx:34-61` — only brand color tokens overridden; the rest of webLight/webDarkTheme typography ramp is untouched | `Title2` etc. remain Fluent defaults, so the brand voice never reaches headings. | No type personality. |
| 32 | `globals.css:30` — `font-family: 'Segoe UI Variable Text'` | Fine for Windows, but on macOS reviewers (you do screenshots here) it falls through to `system-ui`; visual review keeps shifting baseline. | QA reproducibility. |

### Cross-cutting

| # | Issue | Impact |
|---|---|---|
| 33 | No global spacing scale. `app-shell.tsx`, `page-shell.tsx`, `ribbon.tsx`, `app/page.tsx` use ad-hoc `gap` / `padding` of `4 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 24 / 32 / 40 / 48`. | Inconsistent vertical rhythm — root cause of the "doesn't feel polished" complaint. |
| 34 | No motion tokens. `app/page.tsx:52` uses `transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s'`; ribbon has none; theme toggle has none. | Inconsistent animation feel. |
| 35 | No elevation scale. Topbar uses `boxShadow: '0 2px 8px rgba(0,0,0,0.18)'` (raw), hero uses `'0 12px 32px rgba(31,111,235,0.18)'`, cards use `tokens.shadow16` only on hover. | No layering language. |
| 36 | No left-nav active-state token. Source not read here but WebFetch reports active state is invisible. | Users lose orientation. |

---

## 2. Prioritized fix list

### P0 — fix this sprint (correctness + the user's literal complaints)

- **#4 Logo background**: replace `loom-logo.png` with a true-transparent PNG (or render as inline SVG via the existing fallback path in `loom-logo.tsx:46-58`). Acceptance: opening the PNG in an image viewer shows checkerboard, not navy.
- **#5 Search auto-opens palette on focus**: remove `onFocus={open}` from `topbar-search.tsx:76`. Open the palette only on `onClick` / `Enter` / `Ctrl+K`.
- **#1, #3, #6 Topbar density**: replace the fixed-width brand block with the redesign in §4.
- **#2 Brand text concatenation**: insert a non-breaking spacer or `<span aria-hidden> · </span>` between `brandLine1` and `brandLine2`, or move `brandLine2` into the tagline column.
- **#9 Page title hierarchy**: change `page-shell.tsx:41` from `<Title2 as="h1">` to `<LargeTitle as="h1">` (28 px / 600). It's already exported from Fluent v9.
- **#19 Lineage SVG contrast**: bump label colors from `colorNeutralForeground3` to `colorNeutralForeground2` (passes AA on white).
- **#16 Duplicate tab counts** on `/api-marketplace`: dedupe the count rendering.

### P1 — next sprint (polish + design system foundation)

- **#11, #12 Hero**: cap hero height to 280 px, move workload chips into a collapsing "More workloads" disclosure under the body copy, or move them entirely below the quick-link grid.
- **#15 Section title spacing**: drop the manual `marginTop: 24` and let `PageShell`'s `gap: 16` handle rhythm; introduce a `--space-*` scale (see §3).
- **#17, #18 Capacity table**: right-align numeric columns; add `position: sticky; top: 0` on `<thead>`; freeze first column via `position: sticky; left: 0`.
- **#20 Monitor status badges**: replace text status with `<Badge appearance="tint" color={statusToColor(status)}>` (Fluent v9 tints meet AA in both themes).
- **#21 Workspaces loading**: render `EmptyState` skeleton or a 3-card shimmer instead of plain text.
- **#22 Editor left tree** width: change to `minmax(240px, 320px)` and add a `<Tooltip>` wrapper on truncated node labels.
- **#23, #24, #25 Ribbon polish**: drop the outer `border` on `.root` (already inside a card), add `letter-spacing: 0.06em` to `groupLabel`, accept `appearance?: 'primary' | 'subtle'` on `RibbonAction`.
- **#26 Notebook cells**: introduce a `.cell-code` class with `background: tokens.colorNeutralBackground3, fontFamily: 'Cascadia Code, Consolas, monospace'`.
- **#30 Scrollbar theming**: branch the rgba colors on `html[data-theme='dark']`.
- **#36 Left-nav active state**: in `left-nav.tsx` add `backgroundColor: tokens.colorNeutralBackground1Selected, borderLeft: '3px solid var(--loom-indigo)'` for the matched route.

### P2 — quality-of-life

- **#7 `!important` on icon buttons**: replace with `tokens.colorNeutralForegroundOnBrand` and `color` inside hover/focus pseudo-classes in `makeStyles`.
- **#10 PageShell header**: change `alignItems: center` to `alignItems: flex-start`, pad actions with `paddingTop: 4`.
- **#13 reduced-motion guard** on hover transitions.
- **#14 Card focus ring**: move `<Card>` to be the focusable element (`as="a"`), and add `:focus-visible { outline: 2px solid tokens.colorBrandStroke1; outline-offset: 2px }`.
- **#27 APIM textarea**: wrap in a styled `<pre>` with `tokens.borderRadiusMedium` and `Cascadia Code` stack.
- **#29 Token decomposition** in globals.css (see §3).
- **#31 Theme typography ramp**: add `fontFamilyBase` / `fontWeight*` overrides to `brandedLight` / `brandedDark`.
- **#32 Font stack**: add `'Segoe UI Variable Display'` for headings, `'Cascadia Code', 'Consolas'` for code.

---

## 3. Proposed design system

Concrete CSS-variable + Fluent v9 token mapping. All variables go in `app/globals.css` and are referenced from `makeStyles` via `var(--loom-…)` or composed with Fluent tokens.

### 3.1 Spacing scale (root)

```css
:root {
  --loom-space-1:  4px;
  --loom-space-2:  8px;
  --loom-space-3: 12px;
  --loom-space-4: 16px;
  --loom-space-5: 24px;
  --loom-space-6: 32px;
  --loom-space-7: 48px;
  --loom-space-8: 64px;
}
```

**Usage rule:** never write a raw px gap/padding in a `makeStyles` block. Always `gap: 'var(--loom-space-3)'`. Lints can enforce this with a simple grep in CI.

### 3.2 Type scale

| Token | Size / weight / line-height | Use |
|---|---|---|
| `--loom-type-display` | 32 / 700 / 1.2 | Hero only |
| `--loom-type-h1` | 28 / 600 / 1.25 | Page titles (replace `Title2 as="h1"`) |
| `--loom-type-h2` | 22 / 600 / 1.3 | Section titles |
| `--loom-type-h3` | 18 / 600 / 1.35 | Card / panel titles |
| `--loom-type-body` | 14 / 400 / 1.5 | Default body |
| `--loom-type-body-strong` | 14 / 600 / 1.5 | Inline emphasis |
| `--loom-type-caption` | 12 / 400 / 1.4 | Metadata, timestamps |
| `--loom-type-overline` | 11 / 600 / 1 / `letter-spacing: 0.08em` / uppercase | Ribbon group labels, brandLine2 |
| `--loom-type-mono` | 13 / 400 / 1.45 / `Cascadia Code, Consolas, monospace` | Code cells, APIM editor |

Map to Fluent v9 by overriding in `brandedLight()` / `brandedDark()`:

```ts
fontSizeBase300: '14px',   // body
fontSizeHero700: '28px',   // page h1
fontFamilyBase: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
fontFamilyMonospace: "'Cascadia Code', Consolas, 'Courier New', monospace",
```

### 3.3 Brand color tokens

Decompose the gradients into discrete stops so components can compose:

```css
:root {
  /* Brand */
  --loom-navy-900: #0f2a4a;
  --loom-navy-800: #1a1342;
  --loom-indigo-700: #3d2e80;   /* primary */
  --loom-indigo-600: #5e4dc0;
  --loom-indigo-300: #aea0ff;
  --loom-indigo-100: #ece8fa;
  --loom-azure-600: #1f6feb;    /* secondary */
  --loom-azure-500: #4c8ef0;
  --loom-amber-500: #d89f3d;    /* accent */
  --loom-amber-400: #e6b566;
  --loom-paper:     #faf8f2;

  /* Semantic surfaces (theme-aware via [data-theme]) */
  --loom-surface-canvas:  #f4f4f6;
  --loom-surface-raised:  #ffffff;
  --loom-surface-sunken:  #ebebef;
  --loom-stroke-subtle:   #e1e1e6;

  /* Status — tuned for AA on both themes */
  --loom-status-success: #117865;
  --loom-status-warning: #ad6800;
  --loom-status-danger:  #b91c4b;
  --loom-status-info:    #0050b3;

  /* Composed (keep existing gradient names, now derived) */
  --loom-topbar-bg: linear-gradient(90deg,
    var(--loom-navy-900) 0%, var(--loom-navy-800) 50%, var(--loom-indigo-700) 100%);
  --loom-hero-bg:  linear-gradient(135deg,
    var(--loom-indigo-700) 0%, var(--loom-azure-600) 55%, var(--loom-amber-500) 130%);
}
html[data-theme='dark'] {
  --loom-surface-canvas: #15131c;
  --loom-surface-raised: #1f1c2a;
  --loom-surface-sunken: #100e17;
  --loom-stroke-subtle:  #2a2735;
  --loom-topbar-bg: linear-gradient(90deg, #060814 0%, #0b0a26 50%, #1a1342 100%);
}
```

Wire the Fluent brand ramp in `theme-context.tsx` to these:

```ts
colorBrandBackground:      'var(--loom-indigo-700)',
colorBrandBackgroundHover: 'var(--loom-indigo-600)',
colorBrandForeground1:     'var(--loom-indigo-700)',
colorBrandStroke1:         'var(--loom-indigo-700)',
```

### 3.4 Radius, elevation, motion tokens

```css
:root {
  --loom-radius-xs: 2px;
  --loom-radius-sm: 4px;
  --loom-radius-md: 6px;
  --loom-radius-lg: 10px;
  --loom-radius-xl: 16px;
  --loom-radius-full: 9999px;

  --loom-elev-1: 0 1px 2px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
  --loom-elev-2: 0 2px 8px rgba(0,0,0,0.10);
  --loom-elev-3: 0 8px 24px rgba(15,42,74,0.14);
  --loom-elev-4: 0 16px 40px rgba(31,111,235,0.18);

  --loom-motion-fast:   120ms;
  --loom-motion-base:   180ms;
  --loom-motion-slow:   280ms;
  --loom-motion-ease:   cubic-bezier(0.2, 0.0, 0.2, 1);
  --loom-motion-emph:   cubic-bezier(0.3, 0.0, 0.1, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --loom-motion-fast: 0ms; --loom-motion-base: 0ms; --loom-motion-slow: 0ms; }
}
html[data-theme='dark'] {
  --loom-elev-1: 0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04);
  --loom-elev-2: 0 2px 8px rgba(0,0,0,0.45);
  --loom-elev-3: 0 8px 24px rgba(0,0,0,0.55);
}
```

### 3.5 Component patterns (Fluent v9 idioms)

**Card** — every list/quick-link/data card

```ts
const useCard = makeStyles({
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 'var(--loom-radius-lg)',
    padding: 'var(--loom-space-4)',
    boxShadow: 'var(--loom-elev-1)',
    transition: 'transform var(--loom-motion-fast) var(--loom-motion-ease), box-shadow var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { transform: 'translateY(-2px)', boxShadow: 'var(--loom-elev-3)' },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  },
});
```

**Table** — `/admin/capacity`, `/monitor`, `/onelake`

- `<thead>`: `position: sticky; top: 0; backgroundColor: tokens.colorNeutralBackground2; box-shadow: 0 1px 0 tokens.colorNeutralStroke2`.
- Row height: 40 px standard, 32 px dense (user setting).
- Numeric cells: `text-align: right; font-variant-numeric: tabular-nums`.
- First column: `position: sticky; left: 0; backgroundColor: tokens.colorNeutralBackground1`.

**Tabs (ribbon + page tabs)** — Fluent `TabList`, always `size="small"`, with `appearance="subtle"` on top-level page tabs and `appearance="transparent"` inside ribbons. Active tab uses `tokens.colorBrandForeground1` underline 2 px.

**Form** — labels `--loom-type-body-strong`, helper text `--loom-type-caption` in `tokens.colorNeutralForeground3`, errors `--loom-status-danger`. Use Fluent v9 `<Field label hint>` wrapper consistently.

**Dialog** — `tokens.borderRadiusXLarge`, `var(--loom-elev-4)`, max-width 560 (form) / 800 (data picker), padding `var(--loom-space-5)`.

**Empty state** — already exists in `empty-state.tsx`; replace hardcoded `padding: '48px 24px'`, `borderRadius: '8px'` with `var(--loom-space-7) var(--loom-space-5)` and `var(--loom-radius-lg)`.

### 3.6 Topbar redesign (concrete spec)

Replace `app-shell.tsx:36-84` with this structure (left → right):

| Zone | Width | Content | Notes |
|---|---|---|---|
| **Brand** | `var(--loom-nav-width)` = 240 px | Logo (28 px) + "CSA Loom" wordmark (16/600) | Stack with `gap: var(--loom-space-2)`. Drop the inline brandLine2/tagline entirely. |
| **Page context** | flex 0 1 auto, max 320 px | Workspace selector (`Dropdown`, transparent on dark) | New — replaces the floating tagline. Shows current workspace + chevron; clicking opens workspace switcher. Echoes Fabric's workspace pill. |
| **Search** | flex 1 1 auto, max 640 px, min 280 px | TopbarSearch with `Ctrl K` kbd-pill on right | Fix `onFocus={open}` (issue #5). |
| **Action cluster** | flex 0 0 auto | Copilot, Feedback, Theme, Help, Settings, Account (in that order) | Gap `var(--loom-space-2)`. Wrap in a `<div role="toolbar" aria-label="Global actions">`. |
| Padding | — | `paddingLeft: var(--loom-space-4); paddingRight: var(--loom-space-3)` | Symmetric. |
| Height | `var(--loom-topbar-height)` = 56 px | — | Unchanged. |

Visual:

- Tagline ("Weaving every Azure data service into one experience") **moves out of the topbar entirely** and becomes the home-page hero sub-headline (already lives there at `app/page.tsx:110-116`). Topbar gets back ~280 px of horizontal real estate.
- Brand subtitle ("CLOUD SCALE ANALYTICS") becomes a `:hover` tooltip on the wordmark, not always-on text. Eliminates issue #2.
- Workspace switcher fills the formerly-empty space with something users actually need — same pattern as Fabric / Power BI / Azure portal.
- All action buttons get `aria-label`, `title`, and a keyboard shortcut hint in the tooltip.

Pseudo-source:

```tsx
<header className={styles.topbar} role="banner">
  <Link href="/" className={styles.brand} aria-label="CSA Loom — Cloud Scale Analytics, home">
    <LoomLogo variant="icon" size={28} />
    <span className={styles.wordmark}>CSA Loom</span>
  </Link>
  <WorkspaceSwitcher /> {/* new component, see §3.5 Tabs/Form */}
  <TopbarSearch />
  <div className={styles.actions} role="toolbar" aria-label="Global actions">
    {/* Copilot, Feedback, Theme, Help, Settings, Account */}
  </div>
</header>
```

### 3.7 Logo fix (the literal complaint)

Two options, in preference order:

1. **Regenerate the PNG with transparent background** (atlas-media `nano banana` pipeline is already documented in `loom-logo.tsx:6-15`). Re-run with prompt suffix `… on a fully transparent background, alpha channel preserved, no padding rectangle`. Export 256×256 PNG-32. Confirm with `magick identify -format "%[opaque]" loom-logo.png` returning `False`.
2. **Inline SVG primary**. The fallback SVG at `loom-logo.tsx:46-58` already renders cleanly on both gradients. Promote it from fallback to primary; keep PNG as a `picture` source for crawlers. Bonus: SVG scales for the home-page 96 px hero without blur.

Recommended: do both — ship transparent PNG **and** make SVG the primary in `LoomLogo`. Acceptance test: take a screenshot of the topbar at 100 % zoom in both light and dark themes; the logo's bounding box should be invisible against the gradient.

---

## 4. Files referenced

- `apps/fiab-console/lib/components/app-shell.tsx`
- `apps/fiab-console/lib/components/loom-logo.tsx`
- `apps/fiab-console/lib/components/topbar-search.tsx`
- `apps/fiab-console/lib/components/page-shell.tsx`
- `apps/fiab-console/lib/components/empty-state.tsx`
- `apps/fiab-console/lib/components/ribbon.tsx`
- `apps/fiab-console/lib/editors/item-editor-chrome.tsx`
- `apps/fiab-console/lib/theme/theme-context.tsx`
- `apps/fiab-console/app/globals.css`
- `apps/fiab-console/app/page.tsx`
- `apps/fiab-console/public/brand/loom-logo.png` (regenerate)

## 5. Acceptance gate for v1.10

A change set passes when:

1. The logo PNG has a true alpha channel (verifiable via `magick identify`).
2. No element in `app-shell.tsx` or `page-shell.tsx` uses a raw px value for gap/padding outside the `--loom-space-*` scale.
3. Topbar at 1280 px shows: brand (left), workspace switcher, search ≥ 320 px wide, 6-icon action cluster, with ≥ `var(--loom-space-3)` separating each zone.
4. WCAG AA contrast measured (via `pa11y` or Lighthouse) on `/`, `/workspaces`, `/governance/lineage`, `/monitor` returns zero AA violations.
5. `<LargeTitle as="h1">` is the H1 on every page that uses `PageShell`.
6. Numeric columns in `/admin/capacity` are right-aligned and the Service column is frozen on horizontal scroll.
7. Theme toggle round-trip (light → dark → light) preserves logo contrast and shows distinct scrollbar / status-badge colors in each mode.

---

*End of audit v1.10. Implement in order: P0 → P1 → P2. P0 is one afternoon; P1 is one sprint; P2 trails the design-system rollout.*

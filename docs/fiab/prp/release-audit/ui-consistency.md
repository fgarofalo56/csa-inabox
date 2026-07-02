# Release audit — dimension: ui-consistency (Web 3.0 UI per `.claude/rules/web3-ui.md`)

Date: 2026-07-02 · Auditor: automated dimension agent · Scope: `apps/fiab-console/app` + `apps/fiab-console/lib`

## Method

- Grepped both trees for: hard-coded px paddings/gaps (`gap: N`, `padding: N`, `margin*: N` in inline `style={{}}` and makeStyles), inline hex colors (`#rrggbb`), raw `display:'grid'` card layouts vs `TileGrid`, bare empty-state divs vs `EmptyState`, tables vs `LoomDataTable`, and emoji glyphs vs Fluent icons.
- Sample-read 12 diverse surfaces: `app/governance/policies`, `app/governance/scans`, `app/governance/lineage`, `app/admin/updates`, `app/admin/usage-chargeback`, `app/admin/users`, `app/copilot`, `app/thread`, `app/learn`, `lib/panes/govern-admin.tsx`, `lib/editors/data-marketplace.tsx`, plus grep-level passes over `lib/components/admin/env-config-pane.tsx` and `lib/components/pipeline/manage-panel.tsx`.
- Checked shell adoption across all 90 App Router pages.

## Overall assessment

The console is in genuinely good shape against the web3-ui rule. The shared-primitive system is real and widely adopted, not aspirational:

- **Shells**: 77 of 90 `page.tsx` files use `PageShell`/`AdminShell`/`GovernanceShell`/`CatalogShell`. The 13 that don't are almost all intentional redirects (`app/api-marketplace/page.tsx`, `app/items/page.tsx`, `app/governance/domains/page.tsx`, etc., each ~10 lines calling `redirect(...)`) or item-editor hosts (`app/items/[type]/[id]/page.tsx`). `app/copilot/page.tsx` and `app/thread/page.tsx` own their layout but are fully tokenized and match the product's hero/gradient dialect.
- **TileGrid** imported/used in 40+ files, **EmptyState** in 60+ files, **LoomDataTable** in 60 files (all major admin + governance list pages).
- Hex colors are overwhelmingly legitimate: the sanctioned `var(--loom-accent-*, #fallback)` pattern (e.g. `lib/panes/onelake-catalog.tsx:83-87`, `lib/panes/govern-admin.tsx:352-355`), item-type/brand color registries (`lib/components/ui/item-type-visual.ts`, `lib/components/pipeline/activity-catalog.ts` — ADF activity brand colors with `fg:'#fff'`), third-party product logo SVGs (`lib/components/onelake/shortcut-wizard.tsx:815-866` — AWS/GCP/SharePoint brand fills), report theme palettes (`lib/editors/report/themes.ts` — Power BI themes are literally hex), and hero gradients consistent between home (`app/page.tsx:98-114`), copilot (`app/copilot/page.tsx:110-112`) and governance surfaces.
- Old admin pages have been swept: `app/admin/updates/page.tsx:27-57` is a model citizen (every rule on tokens, with comments explaining dark-mode-aware replacements); `app/admin/users/page.tsx:59-109` is fully tokenized with LoomDataTable.

What remains is a bounded tail of hygiene debt plus one real CSS bug. Nothing here embarrasses a public release; the worst items are a silently-dropped background color and one page that visually diverges from the shared lineage dialect.

**Grade: B** (production-grade look and consistency; a tail of token-hygiene debt and one visual defect keep it off A).

---

## Findings (full detail)

### F1 — Invalid CSS value silently drops the Governance Copilot chip background (fix, medium)

`lib/panes/govern-admin.tsx:241`:

```tsx
<span className={s.chip} style={{ backgroundColor: 'var(--loom-accent-violet, #8b5cf6)1f' }} aria-hidden>
```

The author attempted the hex-alpha-suffix trick (`#8b5cf6` + `1f`) on top of a `var()` expression. `var(--loom-accent-violet, #8b5cf6)1f` is not a valid CSS color, so the entire `background-color` declaration is dropped by the browser and the Sparkle chip renders with no tinted background — visibly plainer than its siblings that use the same chip pattern correctly. This is the only occurrence of the pattern in the repo (grep `var\(--loom-accent[^)]*\)[0-9a-fA-F]{2}` → 1 hit). Fix: `color-mix(in srgb, var(--loom-accent-violet, #8b5cf6) 12%, transparent)` or a pre-defined `--loom-accent-violet-soft` var.

### F2 — governance/lineage hand-rolls its own SVG graph instead of the shared LineageCanvas (consolidate, medium)

`app/governance/lineage/page.tsx`:
- Lines 47-51: its own status color map (`'in-sync': '#0e700e'`, `pending: '#bc4b09'`, …).
- Lines 77-90: its own item-type color map (`lakehouse: '#0078d4'`, `warehouse: '#5c2d91'`, … `'mirrored-database': '#666'`) — duplicating the shared registry in `lib/components/ui/item-type-visual.ts` (which the Thread page consumes via `itemVisual()`; grep for `itemVisual` in the lineage page = no matches).
- Line 309: arrow marker `fill="#666"`; line 324: edge `stroke={isHi ? '#0078d4' : '#aaa'}` — hard-coded grays that do not adapt to the dark theme.
- Line 296-301: empty state is a bare `<div className={s.empty}>` with text, not the `EmptyState` primitive.

Meanwhile the product already has a shared `LineageCanvas` (`lib/components/catalog/lineage-canvas.tsx`) used by `app/thread/page.tsx`, `lib/components/catalog/lineage-panel.tsx`, `lib/components/onelake/lineage-drawer.tsx`, and `lib/components/databricks/uc-lineage-panel.tsx`. A user moving from Thread → Governance Lineage sees two different lineage dialects (different node visuals, colors, interactions) — exactly the "changed apps" feel the rule forbids. Recommendation: port governance/lineage onto `LineageCanvas` + `itemVisual()`.

### F3 — governance/policies New-policy dialog: 16 raw px gaps (update, medium)

`app/governance/policies/page.tsx` — grep `gap: ?[0-9]` yields 16 hits, all inside the New-policy dialog and rules editor: lines 606, 615, 637, 651, 661, 672, 687, 689, 704 (also raw `maxHeight: 140`), 719, 780, 789, 854, 855, 900, 917. Additionally 19 total raw px inline styles per the broader pattern. E.g. line 606: `<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>`. The page otherwise uses `LoomDataTable` (line 592) and tokens. Per web3-ui, `gap: 12`/`gap: 8` are rule violations — should be `tokens.spacingVerticalM`/`spacingHorizontalS` via makeStyles.

### F4 — Systemic tail of raw px inline styles: 522 occurrences / 107 lib files + 40 / 5 app pages (update, medium)

Grep `style=\{\{[^}]*(gap|padding|margin(Top|Bottom)?): ?[0-9]+[,\s}]`:
- `apps/fiab-console/lib`: **522 occurrences across 107 files**.
- `apps/fiab-console/app`: **40 occurrences across 5 pages** (`governance/policies` 19, `governance/data-quality` 15, `governance/scans` 4, `admin/usage-chargeback` 1, `catalog/[source]/[id]` 1).

Hotspots in lib (worth a dedicated sweep, biggest first):
| File | Hits |
|---|---|
| `lib/components/pipeline/manage-panel.tsx` | 31 (e.g. `:484 gridTemplateColumns:'1fr 1fr', gap: 12, marginTop: 8`) |
| `lib/components/deployment/deployment-pipelines-pane.tsx` | 26 |
| `lib/components/admin/env-config-pane.tsx` | 25 (e.g. `:194 gap: 12`, `:207 gap: 8, marginTop: 10`) |
| `lib/components/ai-search/ai-search-tree.tsx` | 21 |
| `lib/components/admin/health-pane.tsx` | 19 |
| `lib/components/network/network-pane.tsx` | 18 |
| `lib/components/apim/apim-tree.tsx` | 17 |
| `lib/components/admin-security/dlp-panel.tsx` | 16 |
| `lib/components/pipeline/factory-resources-tree.tsx` | 14 |
| `lib/components/databricks/databricks-workspace-tree.tsx` | 13 |
| `lib/prompt-flow/flow-builder.tsx` | 13 |
| `lib/dialogs/share-item-dialog.tsx` | 12 |
| `lib/components/pipeline/synapse-workspace-tree.tsx` | 12 |
| `lib/components/business-events/business-events-view.tsx` | 11 |

These are visually harmless individually (mostly `gap: 8`/`marginTop: 8` matching the S/M token values) but are exactly the raw numbers the rule bans, and they will drift when the token scale changes. Recommendation: mechanical sweep (the values map 1:1 to `spacing*XS/S/M/L`), plus a CI guard extending `scripts/ci` (the repo already has `no-freeform`/`route-guards` CI checks) to fail on new `gap: <number>` inline styles.

### F5 — governance/data-quality page: 15 raw px inline styles (update, low)

`app/governance/data-quality/page.tsx` lines 75, 149, 157, 161, 170, 254, 275, 276, 311, 363, 370, 371, 374, 375, 391 — raw `marginBottom: 16/12`, `gap: 8`, `marginTop: 16/24` on TabList, MessageBars and section headers. Same fix as F3.

### F6 — governance/scans drawer: hard-coded fontSize + padding on run rows (update, low)

`app/governance/scans/page.tsx`:
- `:154` — `<code style={{ fontSize: 11, ... }}>` in the Endpoint column.
- `:263` — run row `style={{ fontSize: 12, padding: '2px 0', ..., gap: 8 }}`.
- `:254-255` — `marginBottom: 16, paddingBottom: 12`, `gap: 8, marginBottom: 6`.

Should be `tokens.fontSizeBase200`, `Caption1`, and spacing tokens. Page otherwise exemplary (GovernanceShell, LoomDataTable, honest MessageBar gates, Drawer).

### F7 — admin/usage-chargeback loading state: `padding: 48` (update, low)

`app/admin/usage-chargeback/page.tsx:271`: `<div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner .../></div>`. One raw value on an otherwise A-grade page (KPI cards, tabbed charts, honest Cost-Management-Reader gate at lines 257-268, tokens everywhere else). Use `tokens.spacingVerticalXXXL`.

### F8 — Leftover emoji glyphs in four editors (fix, low)

The web5 sweep converted emoji → Fluent icons, but four rendered-UI leftovers remain (grep UTF-8 `F0 9F` prefix):
- `lib/editors/phase3/activator-editor.tsx:880` and `:1105` — action-group summaries render `✉ ☎ 🔗 ⚙` counts inline.
- `lib/editors/phase4/data-agent-editor.tsx:802` — `🛠 Tools used ({tools.length})`.
- `lib/editors/pipeline-editor.tsx:254` — `💭 {step.content...}` in copilot step rows.
(`lib/editors/report/filters-pane.tsx` hits are code comments only — not user-visible, no action.)
Replace with `Mail16Regular`/`Call16Regular`/`Link16Regular`/`Settings16Regular`, `Wrench16Regular`, `Comment16Regular` per the loom-design-standards memory.

### F9 — Text-only empty states not using the EmptyState primitive (consolidate, low)

The `EmptyState` primitive exists and is used in 60+ files, but several list panes still render styled-text-only empties:
- `lib/editors/data-marketplace.tsx:612` — `<div className={styles.empty}>No data products yet. Create one to publish it to the marketplace.</div>` (styles.empty at `:70` is tokens-based padding/centering, but no icon/illustration/CTA).
- `lib/components/marketplace/my-access.tsx:103` — `<div className={s.empty}>No data-product access requests recorded.</div>`.
- `app/governance/lineage/page.tsx:296-301` — bare `s.empty` div (see F2).
Per web3-ui rule item 2 ("EmptyState for empty panes … never a bare centered div"). These are the exceptions in an otherwise well-adopted pattern; contrast `app/thread/page.tsx:94-102` which builds a proper designed empty canvas.

### F10 — Two coexisting card-grid dialects: TileGrid vs local `cardGrid` makeStyles (consolidate, low)

`grep minmax\([0-9]+px` shows ~80 locally-defined card/KPI grids (`repeat(auto-fill, minmax(200-320px, 1fr))`) across editors, panes and admin pages — e.g. `lib/editors/shared-styles.ts:40` (`cardGrid`), `lib/components/ui/admin-tab-styles.ts:107-113` (documented `statsRow`), `app/admin/capacity/page.tsx:124,189`, `app/governance/irm/page.tsx:69,92`, `lib/panes/govern-owner.tsx:63,86`. Mitigating: nearly all use token gaps and `1fr` minmax (responsive/bounded per rule item 5), and two of these are themselves shared primitives (`shared-styles.cardGrid`, `admin-tab-styles.statsRow`). So this is not the "raw px grid" anti-pattern in spirit — but the product now has three sanctioned grid dialects (TileGrid, shared-styles.cardGrid, admin-tab-styles.statsRow) plus dozens of local copies. Recommendation: no urgent action; when touching a surface, fold local `cardGrid`/`kpiGrid` defs onto one of the three shared ones. Not release-blocking.

### F11 — Home-page category tint gradients hard-coded per card (informational, low)

`app/page.tsx:98-114` defines 9 `linear-gradient(135deg, #hex, #hex)` tints inline per category tile. These are intentional accent art (consistent with the copilot hero and domain presets in `lib/components/domain-image-presets.tsx`), render identically in both themes, and match the product's visual language — recorded for completeness, not a defect. If the tenant-theme feature (`app/api/tenant-theme/route.ts`) ever needs to re-tint the home page, these would need to move to `--loom-accent-*` vars.

## Explicitly checked and clean

- **No raw `<div>No results</div>` unstyled empties** on any sampled page — all empties are at minimum token-styled text, most use `EmptyState` or MessageBar.
- **Honest gates** are consistently styled Fluent MessageBars naming exact env vars/roles (e.g. `app/admin/usage-chargeback/page.tsx:257-268`, `app/governance/data-quality/page.tsx:275,370`).
- **Tables**: all sampled admin/governance list pages use `LoomDataTable` (60 files); remaining raw Fluent `<Table>` uses (e.g. `data-marketplace.tsx:615`) are still design-system components with proper cells, not off-system HTML tables.
- **Responsiveness**: sampled grids use `minmax(...,1fr)` + `flexWrap` + `overflowWrap:'anywhere'` consistently (e.g. `app/admin/users/page.tsx:84-96`, `app/governance/scans/page.tsx:256`).
- **globals.css hex count (66)** is the token/theme definition layer itself — correct place for literals.
- **Shell-less pages** are all redirects or editor hosts; no orphaned plain page found.

## Suggested execution order

1. F1 (one-line CSS bug — fix immediately).
2. F8 (4-line emoji swap).
3. F3 + F5 + F6 + F7 (page-level token sweeps, ~1 hour combined).
4. F2 (governance/lineage → LineageCanvas port; the only structural item).
5. F4 (mechanical lib-wide sweep + CI guard, batchable).
6. F9, F10 (fold into any future touch of those surfaces).

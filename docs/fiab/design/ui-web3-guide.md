# CSA Loom — Web 3.0 UI Guide

> The shared design-system contract every Loom page follows. Page-sweep
> agents: read this before redoing a page. Do **not** reinvent tables, tiles,
> spacing, or icon/color logic — use the primitives in
> `apps/fiab-console/lib/components/ui/`.

The standard, in one line: **no smushed tables, nothing touching edges or
siblings, every collection is sortable / resizable / filterable, every item
has a color + icon, and search boxes are never full-width.**

---

## The primitives (import from `@/lib/components/ui/...`)

| Primitive | File | Use it for |
|-----------|------|-----------|
| `LoomDataTable` | `ui/loom-data-table.tsx` | Every data table. Sort + resize + per-column filter are built in. |
| `itemVisual(type)` / `iconUrl(type)` | `ui/item-type-visual.ts` | Icon + brand color + label for any item type. |
| `ViewToggle` | `ui/view-toggle.tsx` | Tile \| List switch at the top of a collection. |
| `ItemTile` + `TileGrid` | `ui/item-tile.tsx`, `ui/tile-grid.tsx` | The tile/card view of a collection. |
| `Section` + `Toolbar` | `ui/section.tsx` | Page layout: padded rounded card + heading + filter bar. |

---

## Spacing scale (never zero)

Use the Loom space tokens (CSS `--loom-space-*`, or the Fluent
`tokens.spacingHorizontal*/Vertical*` inside `makeStyles`). The primitives
already apply these; when you place them, respect the minimums:

| Token | px | Minimum use |
|-------|----|-------------|
| `s2` / `spacing*S` | 8 | gap between inline controls |
| `s3` | 12 | data-table cell padding (already applied) |
| `s4` / `spacing*L` | 16 | inner card padding, tile gap (already applied) |
| `s5` | 24 | between a heading and its content |
| `s6` / `spacing*XXL` | 32 | between stacked `Section`s |

Rules:

- **Never `padding: 0` inside a box.** Content must not touch a border.
- **Never `gap: 0` between cards/tiles.** `TileGrid` supplies `spacingHorizontalL`.
- **Page gutters:** wrap page content so it never butts the viewport edge —
  `Section` already gives a rounded, padded card. Stack `Section`s; the
  `marginBottom` keeps them apart.

---

## When to use Tile vs List vs LoomDataTable

- **Tile (`ItemTile` in a `TileGrid`)** — browsing a heterogeneous collection
  where recognition matters (workspace items, catalog, "New item" gallery).
  Color + icon chip carry the meaning.
- **List / Table (`LoomDataTable`)** — dense, scannable, comparable data:
  many rows, columns to sort/compare, metadata-heavy (run history, resources,
  query results, role assignments). This is the default for anything table-shaped.
- **Both** — give the user a `ViewToggle`. Default to `tile` for galleries,
  `list` for operational data.

```tsx
const [view, setView] = useState<LoomView>('tile');
// ...
<Section title="Workspace items" actions={<ViewToggle value={view} onChange={setView} />}>
  {view === 'tile'
    ? <TileGrid>{items.map((i) => <ItemTile key={i.id} type={i.type} title={i.name} subtitle={itemVisual(i.type).label} meta={`Modified ${i.modified}`} onClick={() => open(i)} />)}</TileGrid>
    : <LoomDataTable columns={cols} rows={items} getRowId={(r) => r.id} onRowClick={open} />}
</Section>
```

---

## Icon + color usage

- Always resolve visuals through `itemVisual(type)` — never hard-code an icon
  or color per page. It returns `{ icon, color, family, label }` and falls
  back to a neutral Document glyph for unknown types.
- The **color chip** behind an icon is a ~12% tint of the family color
  (`${color}1f`) with the icon in the full color — `ItemTile` does this for you.
- Color families: data-eng/factory = blue, warehouse/db = green, RTI =
  orange, science/ML/foundry = purple, governance/APIs/geo = teal, graph =
  violet, data-product = deep violet. Keep families consistent across pages.
- **Atlas Diag icons (optional):** `iconUrl(type)` returns a URL only when
  `NEXT_PUBLIC_LOOM_ICON_BASE` is set, else `undefined`. If you use it, you
  MUST still fall back to `itemVisual(type).icon`. There is no hard dependency.

---

## Data-table feature requirements (every table)

`LoomDataTable` gives these for free — do not ship a table without them:

1. **Sortable** — every column unless `sortable: false`. Click header to sort;
   numeric columns sort numerically, not lexically (set `getValue` returning a
   number).
2. **Resizable** — columns drag-resize (Fluent `resizableColumns`). Give a
   sensible `width` per column.
3. **Per-column filter** — a filter input row under the header; substring
   match per column, client-side. Set `filterable: false` to opt a column out.
4. **Sticky header**, row hover, subtle row separators (1px `Stroke3`) — **not**
   heavy grid lines.
5. **Empty + loading states** — pass `loading` and a human `empty` message.
6. **Generous cell padding** (10px vertical, `spacingHorizontalM`) so text
   never butts a border.

```tsx
<LoomDataTable
  columns={[
    { key: 'name', label: 'Name', sortable: true, filterable: true, width: 240,
      render: (r) => <strong>{r.name}</strong> },
    { key: 'type', label: 'Type', sortable: true, filterable: true, width: 160 },
    { key: 'size', label: 'Size', sortable: true, filterable: false, width: 120,
      getValue: (r) => r.bytes },
  ]}
  rows={items}
  getRowId={(r) => r.id}
  onRowClick={(r) => router.push(`/items/${r.type}/${r.id}`)}
  loading={isLoading}
  empty="No items in this workspace yet."
/>
```

---

## Search-box rule

Search/filter boxes are **never full-width**. Use `Toolbar` (search box capped
at `max-width: 360px`) or cap your own `SearchBox` the same way. A search box
that spans the whole page reads as a broken layout.

```tsx
<Toolbar search={q} onSearch={setQ} actions={<ViewToggle value={view} onChange={setView} />} />
```

---

## Before / after — anti-patterns to kill

| ❌ Anti-pattern (before) | ✅ Fix (after) |
|--------------------------|----------------|
| Bare `<table>` with 1px borders, no sort, text against the cell edge | `LoomDataTable` (sort + resize + filter + padded cells) |
| Buttons / toggles touching each other or the page edge | Wrap in `Section`; use `spacing*S` gaps; let `TileGrid` space tiles |
| Full-width `<input>` search spanning the page | `Toolbar` search (max-width 360px) |
| A grid of plain text rows with no icon/color | `ItemTile` + `TileGrid` with `itemVisual(type)` chips |
| `padding: 0` content butting a card border | `Section` card padding (`spacing*L`); never zero |
| Heavy full grid-lines making a table look "elementary" | Subtle row separators only (built into `LoomDataTable`) |

---

## Verification

Per `.claude/rules/no-scaffold-claims` and `ui-parity.md`: a page is not "done"
until you have clicked every control. For tables, confirm live: header click
re-orders rows, a filter narrows rows, columns drag-resize, and the empty +
loading states render. `LoomDataTable` is covered by
`lib/components/__tests__/loom-data-table.test.tsx` (render / sort / filter /
empty / loading) — keep it green when you extend the primitive.

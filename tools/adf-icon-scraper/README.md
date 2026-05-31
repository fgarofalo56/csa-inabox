# ADF Studio icon scraper

Extracts every icon used on Azure Data Factory Studio's visual authoring
surfaces — the **pipeline Activities palette**, **Mapping Data Flow
transformations**, and **Power Query / Data Wrangling** steps — into clean,
named `.svg` / `.png` files for a draw.io shape library or the CSA Loom
drag-and-drop node palettes.

## Why scrape (vs. download an icon pack)

Azure *service* icons ship in public packs (the Azure architecture icon set,
Fabric icons). But ADF Studio's **activity** glyphs (Copy data, Lookup,
ForEach, Set variable…) and **Mapping Data Flow transformation** glyphs
(Conditional Split, Aggregate, Derived Column, Surrogate Key…) are
Studio-internal assets that aren't in any published pack — so they have to be
pulled from the live UI.

## Install

```bash
cd tools/adf-icon-scraper
npm install            # installs playwright + tsx, then `playwright install chromium`
```

## Run

```bash
npm run scrape                  # full extraction → ./icons/**
npm run scrape -- --inspect     # first-run discovery: dump live DOM structure
npm run scrape -- --dry-run     # log what WOULD be saved, write nothing
```

Point at a specific factory's authoring view (recommended) so the panes render
without extra clicks:

```bash
ADF_URL="https://adf.azure.com/en/authoring?factory=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<name>" npm run scrape
```

### Auth (one-time, interactive — no secrets stored in the script)

The script opens a **headed** Chromium with a persistent profile at
`./.adf-profile` (gitignored). On first run:

1. Sign in to ADF Studio with SSO + MFA **by hand** in the opened window.
2. Open a data factory and click the **Author** (pencil) tab.
3. Return to the terminal and press **Enter** to resume extraction.

Reruns reuse the saved session — no re-login. The script never automates the
login and never reads or stores credentials.

## How it extracts (handles all four, they coexist in ADF)

| Strategy | What it catches |
|---|---|
| **a) inline `<svg>`** | serializes the node's `outerHTML` |
| **b) `<img src=*.svg\|*.png>`** | fetches bytes via the page's auth'd request context |
| **c) CSS `background-image: url()`** | resolves the computed URL and fetches it |
| **d) network responses** | a response listener pools every `image/svg+xml` / small `image/png` — catches sprite/atlas + lazy-loaded icons |

Collapsed palette groups are expanded and scrollable panes are scrolled so
lazy-rendered items mount before extraction. Selectors are **role/aria/text
first** because ADF Studio uses generated (hashed) CSS class names that change
between releases — see the commented group selectors in `scrape.ts` to patch
after a Microsoft UI update.

## Output

```
icons/
  pipeline/      pipeline activity glyphs   (copy-data.svg, lookup.svg, …)
  dataflow/      mapping-data-flow transforms (conditional-split.svg, …)
  wrangle/       power query / wrangling steps
  _unmatched/    network assets with no resolvable label (rename by hand)
  manifest.json  [{ surface, label, slug, file, sha256, source, ext, aliases }]
  unmatched.json list of network URLs saved to _unmatched
  _inspect/      (--inspect only) live DOM structure dumps to refine selectors
```

Files are deduped by **SHA-256** of the normalized bytes; when two labels map
to the same glyph, one file is kept and the other label is recorded under
`aliases` in the manifest.

## Notes / known fragility

- ADF lazy-loads surfaces; the script waits + scrolls, but if a pane is empty
  on a fast machine, bump the `waitForTimeout` values.
- The Data Wrangling surface isn't enabled in every factory/region — that pass
  fails gracefully and is reported in the summary.
- Run `--inspect` once after login and read `icons/_inspect/*.json` if the
  activity/transform selectors need updating for a newer Studio release.

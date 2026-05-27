# Parity gap — `/learn`

**Loom route:** `/learn` (rendered by `apps/fiab-console/app/learn/page.tsx`)
**Fabric reference:** No direct equivalent in Fabric. Loom-native learning library.
**Loom screenshot:** `temp/parity/page-learn-loom.png`
**Captured:** 2026-05-26

## What this surface is

Hand-authored quick-starts per item type. The same Learn content surfaces in each item editor's "Learn" drawer.

## Phase 3 — UI assessment

| # | Element | Status | Notes |
|---|---|---|---|
| 1 | Page header "Learn" with subtitle | present | "Hand-authored quick-starts for each item type. The same content surfaces in the editor's Learn drawer." |
| 2 | Card grid, one card per item type | present | 80+ item types registered in `KNOWN_TYPES` array |
| 3 | Per-card title + short description | present | Concise, accurate (verified visible cards: Eventstream, Eventhouse, KQL database, KQL queryset, KQL dashboard, etc.) |
| 4 | "Create →" deep-link to `/items/[type]/new` | present | Each card has Create link |
| 5 | "MS docs ↗" external link | present | Links to learn.microsoft.com for each item type |
| 6 | Hover state | present | Card hover lifts + brand border |
| 7 | Filter / search input | not visible | MINOR |
| 8 | Category grouping (Data Engineering / Real-Time / Power BI / etc.) | not visible — flat grid of all 80+ types | MINOR |
| 9 | Multi-step tutorials | partial — content is short quick-starts not full tutorials | MINOR |
| 10 | Video / interactive content | not present | MINOR |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Card render | Real registry `KNOWN_TYPES` with content from `getLearn()` per `lib/learn/content.ts` | OK — static but accurate |
| "Create →" link | Real route to `/items/[type]/new` | OK |
| "MS docs ↗" link | External anchor with `target="_blank"` to learn.microsoft.com URLs per type | OK |

## Honest grade

**Grade: B+**

Reasoning:
- This is a documentation surface — static content is appropriate.
- 80+ item types covered with hand-authored, concise content.
- Per-type Create + MS docs deep-links work.
- Content quality is good and brand-aligned (verified samples are accurate and well-written).

Not A because:
- No filter / search input (80+ cards = scroll-heavy).
- No category grouping — would benefit from tabs per workload category.
- Quick-starts are paragraph-long; deeper multi-step tutorials would help.
- No video / interactive guides.

## Recommended next actions

1. Add a filter input at the top.
2. Add category tabs: Data Engineering / Data Factory / Real-Time / Warehouse / Databases / Data Science / Power BI / Power Platform / Copilot Studio / Loom-native.
3. Expand short blurbs to 2-3 step quick-starts with copy-paste-able snippets.
4. Add a "Featured" row at the top (most-used 8 item types).
5. Link each card to a detail page `/learn/[type]` with a full tutorial.

# notepad — Loom-native surface (no Azure or Fabric analog)

**Source UI: NONE.** This is a deliberate, measured statement, not a shortcut.
`notepad` is a Loom-native item type: a "live-data document" — an ordered list of
narrative + KQL blocks whose query blocks execute against Azure Data Explorer
inline. It was built as Loom's answer to Palantir Foundry's Notepad
(Foundry-parity row 3.3), which is **not** a Microsoft product. There is no
Azure portal blade and no Microsoft Fabric item type that this surface is a
one-for-one twin of:

- It is **not** a Fabric/Synapse **Notebook** — no kernel, no session, no cell
  execution model, no Spark, no language switching. Grading it against
  `notebook` would be comparing two different products; the `notebook` item type
  exists separately in Loom and has its own parity doc.
- It is **not** a Fabric **Real-Time Dashboard / KQL Queryset** — no tiles, no
  parameters, no pinning, no dashboard pages. Those exist separately as
  `kql-dashboard` / `kql-queryset`.
- Microsoft Loop components / OneNote are documents, but they are M365
  collaboration surfaces with no query-execution model and are not part of the
  Azure data-platform estate Loom mirrors.

Per `ui-parity.md`, inventing a Microsoft product to compare against would
produce a fictional parity table. Per `ux-baseline.md` ("apply the same baseline
to **all** Loom UXs, not just the 1:1-with-Fabric ones"), the correct bar for a
Loom-only surface is the **`docs/fiab/ux-standards.md` §7 checklist**, and that
is what this document grades against.

**Surface file:** `apps/fiab-console/lib/editors/phase4/notepad-editor.tsx` (123 lines)
**Route:** `/items/notepad/[id]`

---

## Grade against the ux-baseline §7 checklist

This surface is an **editor** (§7.2) plus the §7.0 universal boxes.

| # | Baseline bar item | Status | Evidence / gap |
|---|---|---|---|
| U1 | Fluent v9 + Loom tokens, no hard-coded px/hex | ✅ | `makeStyles` throughout; every spacing/color/radius is a `tokens.*` read. No raw numbers. |
| U2 | Real backend on every control | ✅ | Load `GET /api/cosmos-items/notepad/:id`; save `PATCH /api/items/notepad/:id`; run `POST /api/items/notepad/:id/run-block` → real ADX. No mock arrays. |
| U3 | Honest gate surfaced when infra missing | ⚠️ | The run-block response's `gate.remediation` IS surfaced — but only concatenated into a plain `MessageBar intent="warning"` string (`:64`). It is **not** the shared `HonestGate` component, so there is **no inline "Fix it" button** and the gate is **not registered in the gate registry**. Under `ux-baseline.md` **G2** a bare remediation MessageBar "is no longer compliant" — this is a G2 defect, recorded as ⚠️ rather than ❌ only because the remediation text itself is honest and present. |
| U4 | Guided `EmptyState` (not a bare `<div>`) | ❌ | Empty document renders `<Caption1>No blocks yet — add a heading, text, or KQL query block.</Caption1>` (`:88`). `ux-baseline.md` explicitly forbids "a bare-`<div>` empty state instead of a guided launcher-card `EmptyState`". The `EmptyState` primitive exists at `lib/components/empty-state` and is not imported. |
| U5 | Skeleton / spinner on load | ❌ | The initial `GET` has **no** loading state at all — the effect at `:40-49` sets blocks on success and swallows every failure with `catch { /* keep empty */ }`. A slow or failing load is visually indistinguishable from an empty document. |
| U6 | Error surface is honest | ❌ | Same swallow: a 500 / 403 / network failure on load renders as "No blocks yet". This is the `unknown-reported-as-negative` failure class — the surface asserts "empty" when the truth is "I could not read it". |
| U7 | LearnPopover / teaching guidance | ❌ | No `TeachingBanner`, no `LearnPopover`. A one-line `<Body1>` description only. Sibling editors (`ai-red-team`, `data-quality`, `synthetic-data`) all carry `TeachingBanner`. |
| E1 | `ItemEditorChrome` shell | ❌ | **Not used.** The editor returns a bare `<div className={s.wrap}>`. It therefore has **no ribbon, no item-tab strip, no right details panel, no Copilot entry, no command palette registration, no dirty tracking**. Every sibling in this list (`ai-red-team`, `data-contract`, `data-quality`, `synthetic-data`, `feature-table`, `ducklake-catalog`, `s3-gateway`) wraps in `ItemEditorChrome`. This is the single largest gap on the surface. |
| E2 | Ribbon + contextual command groups | ❌ | Consequence of E1. Save is a loose `<Button>` in an ad-hoc toolbar row. |
| E3 | SC-9 command search (Ctrl+Q / Alt+Q) | ❌ | Consequence of E1 — no `useRegisterRibbonCommands`. |
| E4 | SC-2 right details panel | ❌ | Consequence of E1 — no `DetailsPanel`. |
| E5 | Per-surface Copilot | ❌ | Consequence of E1. |
| E6 | Draft/publish or explicit dirty state | ❌ | Edits mutate `blocks` state directly; nothing tells the user there are unsaved changes. Navigating away loses them silently. |
| E7 | Data preview: type-badged columns + timing status bar | ⚠️ | Timing IS shown (`{rowCount} row(s) · {executionMs} ms`, `:108`) — good. But results render through a hand-built `<Table>` (`:109-116`), **not** the shared `PreviewTable`, so there are **no type badges** and no refresh affordance. `ux-baseline.md` forbids "a data preview with … no type-badged columns". |
| E8 | G3 resizable panes (`SplitPane` + `sizingKey`) | ❌ | The query-block editor and its result grid are fixed-height. G3 requires user-adjustable height AND width via the shared `SplitPane` with a persisted `sizingKey`. Neither is present. |
| E9 | Keyboard a11y on the block list | ⚠️ | Move-up / move-down / remove are real `<Button>`s with `aria-label`s (good), but there is no keyboard reorder shortcut and no focus management after a block is removed. |
| E10 | Clean first-open (no red on a fresh item) | ✅ | A new notepad shows the "No blocks yet" caption — no error banner. (The caption is a U4 defect for a different reason, but it is not red.) |
| E11 | Badge rows wrap (`flexWrap` + `minWidth:0`) | ✅ | `s.bar` and `s.head` both set `flexWrap: 'wrap'`; `s.wrap` sets `minWidth: 0`. |
| E12 | Row-key stability | ⚠️ | Blocks are keyed by array index (`key={i}`, `:90`). Because `move()` swaps positions in place, React reconciles the *wrong* DOM node onto a moved block — a focused/scrolled textarea can retain the previous block's transient state after a reorder. Blocks have no id field to key on. |

**Totals: 4 ✅ · 4 ⚠️ · 10 ❌ (18 rows).**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Initial load | `GET /api/cosmos-items/notepad/:id` | Cosmos DB item state |
| **Save** | `PATCH /api/items/notepad/:id` body `{state:{blocks}}` | Cosmos DB |
| **Run** (query block) | `POST /api/items/notepad/:id/run-block` body `{kql}` | **Azure Data Explorer** via `kusto-client` |
| Add / remove / move block, edit content | client-side state only | — (persisted on Save) |

No mock arrays, no `return []` placeholders — `no-vaporware.md` §3 is satisfied.
No Fabric/OneLake/Power BI host is contacted — `no-fabric-dependency.md` is
satisfied (ADX is the Azure-native backend).

## Verdict

**Not A-grade.** The backend is real and the core value (narrative + live ADX
query in one document) genuinely works, but the surface predates the
`ItemEditorChrome` + `ux-standards.md` baseline and was never brought up to it.
The 10 ❌ rows are all *chrome and state-honesty* gaps, not missing features:

1. **E1 (no `ItemEditorChrome`)** is the root cause of five of the ten — fixing
   it closes E1-E5 in one change.
2. **U5/U6 (swallowed load failure)** is the one that can mislead: a failed read
   currently renders as an empty document.
3. **U4** (`EmptyState`) and **E7** (`PreviewTable`) are single-import swaps.
4. **U3** is a `ux-baseline.md` **G2** violation and needs the shared
   `HonestGate` + a gate-registry entry.

Recommended sequencing for the owning lane: E1 → U5/U6 → U4/E7 → U3 → E8 → E12.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` has been red since
  2026-08-04 (FINISHLINE C13) and GitHub Actions is degraded, so no G1 receipt
  can be produced today. When Actions recovers:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/notepad/<id>
  ```
  The walk must additionally cover: a narrow-width pass (badge wrap), a
  first-open pass on a freshly created notepad, and a run against a real ADX
  table.
- The grades above are read from source at
  `apps/fiab-console/lib/editors/phase4/notepad-editor.tsx`. They are **static**
  evidence; per `no_scaffold_claims` they are not a functional grade.

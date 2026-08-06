# ducklake-catalog — parity with a lakehouse metadata catalog (DuckLake spec; Preview lab)

**Source UI:** no first-party Microsoft surface. The comparators are:
- **DuckLake** (the OSS spec this implements) — <https://ducklake.select/>
- **Apache Iceberg REST Catalog** — Loom's own N1 catalog, the default alternative
- **Databricks Unity Catalog** browse — <https://learn.microsoft.com/azure/databricks/catalog-explorer/>
- **Microsoft Purview** Data Map (catalogs the lake but does not serve metadata to an engine)

Neither the Azure portal nor Microsoft Fabric ships a DuckLake surface; DuckLake
is an OSS specification (metadata in a SQL database rather than a metadata-file
tree). This surface is therefore graded primarily against the
`docs/fiab/ux-standards.md` §7 checklist plus a catalog-browse capability
inventory drawn from Unity Catalog's Catalog Explorer.

**Surface file:** `apps/fiab-console/lib/editors/ducklake-catalog-editor.tsx` (166 lines)
**Route:** `/items/ducklake-catalog/[id]` · N8 lab 1 · Tagged **Preview**.

## Scope honesty — this is a browse-only surface, and it says so

The editor lists tables registered in the DuckLake Postgres store. It does not
create, alter, or drop them. That is consistent with its stated role ("a Preview
lab offered ALONGSIDE the Iceberg REST Catalog") and with `no-vaporware.md`'s
"preview features must be tagged" allowance. Rows for write operations are still
listed as MISSING below, because a reader comparing against Catalog Explorer
needs to know they are absent — but they are absent by scope, not by defect.

## Capability inventory and Loom coverage

### Catalog browse

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| B1 | List registered tables | built | `GET /api/ducklake/catalog` renders `schema` + `name` through the shared **`PreviewTable`**. |
| B2 | Show the bound catalog identity | built | `Badge appearance="outline"` carrying `data.catalog` when configured. |
| B3 | Schema / namespace tree | **MISSING** | A flat two-column list. No expandable namespace tree, no grouping by schema — Catalog Explorer's primary navigation. |
| B4 | Table detail: columns and types | **MISSING** | You can see that a table exists and nothing about its shape. |
| B5 | Row count / size / last-modified | **MISSING** | No table statistics. |
| B6 | Data preview (sample rows) | **MISSING** | Cannot look at the data — even though the DuckDB tier that serves this catalog is the same one `sql-lab` queries, so the capability exists next door. |
| B7 | Search / filter tables | **MISSING** | No search box. Fine at 10 tables, unusable at 500. |
| B8 | Sort by column | partial | Whatever `PreviewTable` provides by default; not surfaced deliberately. |
| B9 | Register / drop a table | **MISSING** (by scope) | Registration happens outside Loom; the empty state says so plainly. |
| B10 | Snapshot / time-travel history | **MISSING** | DuckLake keeps snapshot metadata in Postgres; none of it is surfaced. |
| B11 | Copy the connect string / ATTACH snippet | **MISSING** | The `LearnPopover` explains that DuckDB ATTACHes the store, but gives no copyable snippet — unlike the sibling `s3-gateway` editor, which does render per-engine snippets. Cheap, obvious win. |
| B12 | Link to the equivalent Iceberg REST Catalog object | **MISSING** | The doc text positions the two as alternatives; there is no navigation between them. |

### Surface behaviour and gating *(this is the surface's strength)*

| # | Bar | Loom | Evidence |
|---|---|---|---|
| S1 | Runtime kill-switch with a guided off-state | built (exemplary) | Flag `n8-ducklake-catalog` off renders a full `EmptyState` naming the flag, the exact remediation (Admin → Runtime flags), and confirming that the Iceberg REST Catalog, the `/api/ducklake/**` routes and every other editor keep working. |
| S2 | Shared **`HonestGate`** for the unconfigured store | built | `<HonestGate gate={data.gate} surface="DuckLake catalog" onResolved={refetch}>` — **G2 compliant** (inline Fix-it, registry-backed). One of only two surfaces in this batch that is. |
| S3 | Gate is a **warning, not an error**, on first open | built | Explicitly commented at `:123-124` — a freshly opened item is never red (**ux-baseline G6**). |
| S4 | "Reachable but empty" distinguished from "did not answer" | built (exemplary) | Three separate states: `preview` (tables), `data.unreachable` (its own `EmptyState` carrying the reason), and genuinely-empty (its own `EmptyState` explaining how to register a table). This is `deploy-integrity.md` **R7** honoured — "I could not reach it" is never rendered as "there is nothing there". |
| S5 | Loading state | built | `Spinner` with a real label while the query is in flight. |
| S6 | `LearnPopover` explaining the design choice | built | Explains metadata-in-Postgres vs metadata-file-tree, and that it is offered *alongside* Iceberg — so a user can choose rather than guess. |
| S7 | Uses `useQuery` with `staleTime` and `enabled` gating | built | Flag-off short-circuits the fetch entirely. |
| S8 | `ItemEditorChrome` shell | built | |
| S9 | Ribbon actions | **MISSING** | `ribbon={[]}` — the chrome is present but carries **no commands at all**, not even Refresh. `q.refetch()` exists in code and is reachable only as a gate side-effect. |
| S10 | `TeachingBanner` | **MISSING** | Has `LearnPopover` (S6) but no dismissible teaching banner. |
| S11 | G3 resizable panes | **MISSING** | No `splitKeyPrefix`, no `SplitPane`. |
| S12 | `q.isError` branch | **MISSING** | `fetchCatalog` **throws** on `!res.ok` or `json.ok !== true` (`:61-64`), but the component renders only `q.isLoading`, `data.gate`, `data.configured`, and a `!data` fallback. There is **no `q.isError` branch** — a thrown fetch falls through to `Reading the DuckLake catalog…` (`:158-160`) and sits there forever. This is the **exact defect the sibling `s3-gateway` editor was fixed for** (apex A3, and `s3-gateway-error.test.tsx` exists to pin it). The fix was never propagated here — a textbook `guard-adoption-gap`. |

## Totals

**11 built (3 exemplary) · 1 partial · 12 MISSING — 24 rows.**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Table listing | `GET /api/ducklake/catalog` (`cache: 'no-store'`) | **DuckLake Postgres** metadata store, read via the N2 **DuckDB** tier; audited |
| Runtime flag | `useRuntimeFlag('n8-ducklake-catalog')` | Runtime-flag registry |
| Gate Fix-it | `HonestGate` → gate registry | Gate registry |

Real backend. No mocks. No Fabric host contacted — `no-fabric-dependency.md`
satisfied (Postgres + DuckDB + ADLS, all Azure-native/OSS).

## Assessment

**C+ on capability, B on honesty.** The state machine is genuinely well thought
through — four distinct, correctly-worded states, a registered gate with Fix-it,
and an off-state that reassures the user nothing else broke. S4 in particular is
the behaviour this repo keeps having to re-learn.

Two findings to escalate:

1. **S12 is a live defect, not a polish gap.** `fetchCatalog` throws, and no
   `q.isError` branch exists, so a 500 / 403 / network failure renders a
   permanent "Reading the DuckLake catalog…" with no error and no retry. The
   identical bug was found and fixed in `s3-gateway-editor.tsx` (apex A3) and is
   regression-pinned by `lib/editors/__tests__/s3-gateway-error.test.tsx` — but
   the fix was never carried across to this sibling. **This is a
   guard-adoption-gap and should go to the lane that owns A3.**
2. **B4/B6/B11 — the surface tells you a table exists and nothing else.** No
   columns, no preview, no connect snippet, on a *catalog* surface. The DuckDB
   tier that could answer all three is already wired for `sql-lab`.

**S9** (empty ribbon — not even Refresh) is a one-line fix.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); GitHub Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/ducklake-catalog/<id>
  ```
  The walk must include a run with `/api/ducklake/catalog` returning 500 — the
  expected (defective) result is a permanent loading message, which confirms S12.
- Coverage read from source; static evidence only (`no_scaffold_claims`).

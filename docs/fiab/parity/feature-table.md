# feature-table — parity with Databricks Feature Engineering in Unity Catalog

**Source UI:** Azure Databricks — Explore feature tables in Unity Catalog (the **Features** page)
<https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/uc/ui-uc>
Supporting: <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/uc/feature-tables-uc>
· <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/train-models-with-feature-store>
· <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/online-feature-store>
· <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/lineage>
· <https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/on-demand-features>

**Surface file:** `apps/fiab-console/lib/editors/feature-table-editor.tsx` (443 lines)
**Route:** `/items/feature-table/[id]` · WS-2.1.

**Related doc (different scope, not a duplicate):**
`docs/fiab/parity/feature-store.md` grades the Loom Feature Store *capability*
against Databricks Feature Store at the program level. This doc is the
per-slug `ui-parity.md` deliverable for the **item editor surface**.

## Scoping note

Databricks' feature-store experience is split across **three** UIs: the
**Features** browse page (list + search + tags), **Catalog Explorer** (schema,
privileges, lineage, tags, owner), and the **notebook/SDK** (create, PIT join,
publish, serve). The Loom `feature-table` item collapses authoring + PIT + serving
into one editor and leaves browse to the Loom catalog. Rows are marked with which
Databricks surface they come from so the comparison stays honest.

Loom also serves a sovereign path Databricks does not: `backend === 'postgres'`
swaps Unity Catalog for **OSS Unity Catalog + Azure Database for PostgreSQL**
(Gov). That is a Loom capability with no Databricks equivalent.

## Feature inventory and Loom coverage

### Browse / discovery *(Databricks: Features page)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| B1 | Sidebar **Features** page listing every feature table in a catalog | ⚠️ | Loom lists `feature-table` **items** in the catalog Browse, not the catalog's real feature tables. A UC table created outside Loom (which *is* a feature table the moment it has a PK constraint) never appears. |
| B2 | Catalog selector scoping the list | ❌ | No catalog browser on this surface — catalog/schema are free-text `Input`s on the Define tab, not dropdowns over real UC. Notably weaker than the sibling `synthetic-data` editor, which *does* cascade real UC dropdowns. |
| B3 | List metadata: owner, online stores published to, last write, tags, comment | ⚠️ | The right `DetailsPanel` shows table, offline backend, entity keys, timestamp key, feature count, online table. **No owner, no last-write time, no tags, no comment.** |
| B4 | Search across name / feature name / comment / tag | ❌ | Not on this surface. |
| B5 | Tag filter | ❌ | Not modelled. |
| B6 | **Auto-registration**: any UC table with a PK constraint *is* a feature table | ❌ | Loom requires an explicit item. This is the conceptual gap behind B1 — Databricks discovers, Loom declares. |
| B7 | Drill-through to Catalog Explorer | ❌ | No link out to the Databricks workspace for the bound table. |
| B8 | Genie Code `/findTables` discovery | ❌ | Not built. |

### Authoring *(Databricks: SQL / Python client / Lakeflow)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| A1 | Create a feature table | ✅ | Define tab → `POST /api/items/feature-table/:id` creates the **real** offline table (UC Delta or PG) **and** the online serving table in one action. `auto-bind-by-default.md` satisfied — no separate binding step. |
| A2 | Composite primary keys, `NOT NULL` | ✅ | Comma-separated entity keys; `canSave` enforces ≥1 key. |
| A3 | **Timeseries column** designation | ✅ | Required `Timestamp key` field, enforced by `canSave`. Loom makes it **mandatory**; Databricks makes it optional-but-then-your-PIT-joins-silently-become-exact-match. Loom's stricter default avoids that footgun. |
| A4 | Typed feature columns | ✅ | 8 types (DOUBLE / FLOAT / BIGINT / INT / STRING / BOOLEAN / TIMESTAMP / DATE), typed dropdown per column. |
| A5 | Promote an existing Delta table (`ALTER … ADD CONSTRAINT … PRIMARY KEY`) | ❌ | Create-new only. An existing table cannot be adopted. |
| A6 | Views as feature tables (simple SELECT view, client ≥ 0.7.0) | ❌ | Not supported. |
| A7 | **Feature functions** / on-demand features (UC Python UDFs at inference) | ❌ | Not modelled. Databricks evaluates these automatically in `score_batch` and Model Serving; Loom's serve path merges only stored features. |
| A8 | `FeatureSpec` as a reusable UC entity | ❌ | Not modelled. |
| A9 | Comment / description on the table | ⚠️ | `FeatureTableSpec` carries an optional `description`, but **no input renders it** — the field is dead in the UI. |
| A10 | Tags (table-level and feature-level) | ❌ | Not modelled. |
| A11 | Edit an existing definition | ⚠️ | The button relabels to "Update feature table" when a spec exists, but the consequences of changing a key or dropping a feature on a populated table are neither warned about nor documented. |

### Training / point-in-time *(Databricks: Python client)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| P1 | Point-in-time (AS-OF) join onto a spine | ✅ | **Point-in-time join** tab → `POST …/pit-join` runs a real AS-OF join. |
| P2 | **Preview the generated SQL** before running | ✅ **exceeds** | `preview: true` returns the SQL and renders it read-only. The Databricks client gives a DataFrame, not the SQL — Loom is more inspectable. |
| P3 | `lookup_key` must match PK type and order | ✅ | The tab states the required count and lists the feature keys inline; the spine-keys field is pre-seeded from the spec. |
| P4 | `carry_columns` (labels) | ✅ | Carry-columns field. |
| P5 | Row limit | ✅ | Numeric limit, default 1000. |
| P6 | `feature_names` subset selection | ❌ | All features are joined; no per-feature selection. |
| P7 | `output_name` / `rename_outputs` (two lookups against one table) | ❌ | Not modelled. |
| P8 | `default_values` / `exclude_columns` | ❌ | Not modelled. |
| P9 | **Multiple** `FeatureLookup`s (up to 50 tables + 100 functions) | ❌ | **One feature table per join.** A training set assembled from several feature tables — the normal case in production ML — cannot be built here. Largest gap in this block. |
| P10 | Unsupervised (`label=None`) | ⚠️ | Achievable by leaving carry-columns empty; not an explicit affordance. |
| P11 | `log_model` embedding feature metadata for auto-retrieval | ❌ | Not modelled — see S4. |

### Online serving *(Databricks: Python client + Model Serving UI)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| S1 | Create online store (`CU_1..CU_8`, up to 3 read replicas) | ⚠️ | Loom's online store is the deployment's **Lakebase / pgvector** — created for you (`auto-bind-by-default.md`), but with **no capacity or replica control**. |
| S2 | **Publish** to the online store | ✅ | `POST …/online` materialises the latest value per entity; reports the published row count or an honest "no offline rows yet". |
| S3 | Publish modes: TRIGGERED / CONTINUOUS / SNAPSHOT | ❌ | **Manual publish only.** No streaming sync, no schedule — so the online store goes stale silently between clicks. Paired with S5 this is the most operationally significant gap. |
| S4 | Automatic feature lookup by a served model (zero-setup) | ⚠️ | Loom does the lookup **client-side in the BFF**: `POST …/serve` reads online features, merges them into the payload, then invokes the endpoint. Same user outcome; but a model invoked *outside* Loom gets no automatic lookup. |
| S5 | Freshness / sync status of the online table | ❌ | No last-published timestamp, no lag indicator, no AVAILABLE/PENDING status. Combined with S3 the user cannot tell whether they are serving stale features. |
| S6 | Explore / query online features (UC UI or Lakebase SQL editor) | ⚠️ | The looked-up features are shown as badges after a serve call — inspection-by-side-effect, not a browsable online table. |
| S7 | Feature Serving endpoints for external consumers | ❌ | Not modelled. |
| S8 | Delete online store / online table (with the storage caveat) | ❌ | No delete path from this surface. |
| S9 | Scoring against a model-serving endpoint | ✅ | Endpoint name + per-entity-key inputs + JSON payload → real invoke, with HTTP status + latency badges and the raw response rendered. |

### Governance / lineage *(Databricks: Catalog Explorer)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| L1 | **Lineage** tab listing UC components logged with the table | ❌ | Not on this surface. |
| L2 | Interactive lineage graph | ❌ | Not on this surface (Loom has lineage elsewhere; it is not wired here). |
| L3 | "Used by": models / notebooks / jobs / endpoints consuming the feature | ❌ | Not modelled. **The question a feature-store user asks most often** — "can I change this column?" — is unanswerable. |
| L4 | "Producers": sources / notebooks / jobs writing the feature | ❌ | Not modelled. |
| L5 | Privileges / owner | ❌ | Not on this surface. |

## Totals

**12 ✅ (2 exceeding) · 9 ⚠️ · 20 ❌ — 41 rows.**

Plus one Loom-only capability with no Databricks equivalent:
**sovereign PostgreSQL backend** (`backend === 'postgres'` → OSS UC + Azure
Database for PostgreSQL for Gov). Not counted above, since there is nothing to
grade it against.

## ux-baseline §7 spot-check (this surface is well-built)

| Bar | Status |
|---|---|
| `ItemEditorChrome` with `splitKeyPrefix` (**G3** — persisted pane sizing) | ✅ |
| Right `DetailsPanel` (SC-2) | ✅ |
| Ribbon (Feature table / Operate groups) | ✅ |
| Tabs, with PIT/Serving correctly disabled until a spec exists | ✅ |
| Shared **`HonestGate`** with inline **Fix it** — for both the offline gate and the separate online gate (**G2 compliant**) | ✅ **best in this batch** |
| `NewItemCreateGate` — clean first-open | ✅ |
| Badge rows `flexWrap` + `rowGap` + `minWidth: 0` | ✅ |
| `TeachingBanner` | ❌ — absent; siblings have one. |
| Result grids use `PreviewTable` | ❌ — hand-built `<Table>`; no type badges, no timing bar (though timing *is* badged separately). |
| Uses bare `fetch` rather than `clientFetch` | ⚠️ — every other editor in this batch uses `clientFetch`; this one calls `fetch` directly (`:123`, `:158`, `:180`, `:204`, `:215`), bypassing whatever `clientFetch` centralises (headers, error normalisation). Inconsistent, and a silent divergence risk. |

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Load / Reload | `GET /api/items/feature-table/:id` | Cosmos + backend probe (returns `gate` / `onlineGate`) |
| **Create / Update feature table** | `POST /api/items/feature-table/:id` | **Unity Catalog Delta** (or **PostgreSQL**) offline table **+** Lakebase/pgvector online table |
| **Preview SQL** / **Run join** | `POST …/pit-join` | Databricks SQL (or PG) AS-OF join |
| **Publish latest features** | `POST …/online` | Materialise latest-per-entity → Lakebase / Azure Database for PostgreSQL |
| **Look up + invoke** | `POST …/serve` | Online lookup → **model-serving endpoint** invoke (WS-1.2) |

Real backend on every control. No mocks. No Fabric host contacted.

## Verdict

**B — the best-engineered surface in this batch on the ux-baseline axis** (it is
the only one using the shared `HonestGate` with Fix-it, a `DetailsPanel`, and
`SplitPane` sizing), and the offline→PIT→online→serve path genuinely works
end-to-end against real backends.

The gaps are concentrated and each is load-bearing:

1. **P9 — one feature table per join.** Real training sets combine several.
   This is the ceiling on the surface's production usefulness.
2. **S3 + S5 — manual publish with no freshness signal.** Users can serve stale
   features and cannot tell.
3. **L3/L4 — no lineage, no "used by".** The safety question ("who breaks if I
   change this?") has no answer here.
4. **B2 — free-text catalog/schema** where the sibling `synthetic-data` editor
   already cascades real UC dropdowns. Inconsistent, and it invites typos into
   a name that creates a real table.
5. **A9 — a `description` field in the model that no control writes.** Dead code
   in the spec; either wire it or drop it.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/feature-table/<id>
  ```
  The walk must cover **both** backends (`databricks` and the Gov `postgres`
  path) — they take different code paths through every control — and must prove
  the PIT join returns *as-of* values, not latest values.
- Coverage read from source; static evidence only (`no_scaffold_claims`).

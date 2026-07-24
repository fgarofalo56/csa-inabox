# sql-lab-duckdb — parity with an interactive lakehouse SQL tier (Databricks SQL / Fabric SQL analytics endpoint / Athena / Trino UI)

**Items:** N2a (in-browser duckdb-wasm tier) + N2b (`loom-duckdb` serving tier)
**Surfaces:** `/items/sql-lab/[id]` — **Query**, **Local analysis**, **Connect** tabs
**Backends:** embedded **DuckDB** on an internal-ingress Azure Container App
(`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`) reading Delta/Iceberg/Parquet **in place** on the
deployment's own ADLS Gen2 · **duckdb-wasm** (static, same-origin `.wasm`) in the browser · **Synapse
Serverless** as the honest fallback when `LOOM_DUCKDB_URL` is unset.

Source UI / spec this is measured against:

- Databricks SQL editor (query pane + results grid + timing/engine status bar)
- Microsoft Fabric SQL analytics endpoint (Fabric behaviour Loom matches Azure-natively)
- Amazon Athena / Trino web UI (interactive lake query, in-place read, no import)
- DuckDB extension docs — <https://duckdb.org/docs/stable/core_extensions/delta>, `azure`, `httpfs`, `iceberg`

---

## The problem N2 solves

Loom had two speeds: a preview grid capped at a few hundred rows, and a Spark session that costs **1–5 minutes**
to start. Everything in between — "filter this to the east region", "group by product", "how many nulls in
that column" — paid Spark's start-up price or was not possible at all. N2 adds the two cheapest tiers that
exist:

| Tier | Cold start | Marginal cost of the next query | Good for |
| --- | --- | --- | --- |
| **N2a** duckdb-wasm, in the browser | ~0 ms after the first fetch | **zero** — no server, no network | slicing / filtering / aggregating a result already fetched |
| **N2b** loom-duckdb, in the VNet | sub-second | one HTTP hop | interactive SQL over lake tables |
| Synapse Spark (existing) | 1–5 min | a session | large joins, writes, ML |

---

## Feature inventory → Loom coverage

### A. Query surface (Databricks SQL editor / Fabric SQL endpoint parity)

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| A1 | Monaco SQL editor with persisted sizing | ✅ `MonacoTextarea language="sql" sizingKey="sql-lab.query"` | client |
| A2 | Draggable query ↔ results divider | ✅ shared U6 `EditorResultsSplit editorKey="sql-lab"` | client (G3 `SplitPane` + `ResizableCanvasRegion`) |
| A3 | Run | ✅ `POST /api/duckdb/query` | `runSqlLabQuery` → loom-duckdb `/query`, or Synapse Serverless `executeQuery` |
| A4 | Type-badged results grid with search | ✅ shared `PreviewTable` | client over the real result |
| A5 | Timing / engine status bar | ✅ rows · engine ms · round-trip ms · **engine name** | measured on both legs; never a constant |
| A6 | Truncation disclosure | ✅ `truncated` badge + the applied `maxRows` | engine-reported, capped at `LOOM_DUCKDB_MAX_ROWS` |
| A7 | Read Delta in place | ✅ `delta_scan('abfss://…')` | DuckDB `delta` + `azure` extensions, managed identity |
| A8 | Read Parquet in place | ✅ `read_parquet('abfss://…/*.parquet')` | DuckDB `httpfs` + `azure` |
| A9 | Read Iceberg in place | ✅ `iceberg_scan('abfss://…')` — the tables N1's Interop tab publishes | DuckDB `iceberg` |
| A10 | EXPLAIN / physical plan | ✅ `POST /explain` on the serving tier | DuckDB `EXPLAIN` |
| A11 | Engine capability disclosure | ✅ version + loaded extensions badged from `GET /api/duckdb/capabilities` | real read; an unreachable tier says so |
| A12 | Refuse writes | ✅ default-deny read-only guard (`app/sqlguard.py`) **and** a Storage Blob Data **Reader** identity | structural, not advisory |
| A13 | Multi-statement scripts | ✅ admitted only when EVERY statement is a read; last result returned | `assert_read_only` + DuckDB |
| A14 | Cancel a running query | ⚠️ honest gap — the HTTP tier runs to completion or the request times out; the row cap + timeout bound the damage. Spark/Serverless surfaces keep their cancel. | tracked with N2b follow-up |

### B. Local analysis (N2a — beyond the source UIs)

No comparator ships this: Databricks SQL, Fabric and Athena all re-query the server for every refinement.

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| B1 | Fetch the result as Arrow IPC once | ✅ `POST /api/duckdb/query?format=arrow` (pure Arrow body, stats in `x-loom-*` headers) | loom-duckdb `fetch_arrow_table` → `pa.ipc.new_stream` |
| B2 | Register it as a queryable table in the tab | ✅ `insertArrowFromIPCStream` on duckdb-wasm | `lib/duckdb/wasm-loader` |
| B3 | Run further SQL locally | ✅ Monaco + Run, unlimited statements | duckdb-wasm |
| B4 | **Prove** it ran locally | ✅ timing bar: measured ms, **`0 network requests`**, source bytes/rows, amortized fetch ms, statements served | `LocalQueryStats` — measured, never asserted |
| B5 | Self-hosted engine assets (no CDN) | ✅ `public/duckdb/*` copied at build time by `scripts/copy-duckdb-assets.mjs` | same-origin static `.wasm` |
| B6 | Honest unavailability | ✅ informative (never red) note when the browser or assets can't host the engine, or when there is no Arrow source | the server tier already answered |
| B7 | Kill switch | ✅ FLAG0 `n2a-duckdb-wasm-preview` | `lib/admin/runtime-flags.ts` |

### C. Honest fallback + gate (no-vaporware / default-ON)

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| C1 | Works with the tier undeployed | ✅ the SAME statement runs on Synapse Serverless | `runSqlLabQuery` fallback branch |
| C2 | The UI never lies about which engine ran | ✅ `engine` + `note` on every response; badged and printed | route + status bar |
| C3 | Fix-it gate, full surface still rendered | ✅ `HonestGate gateId="svc-loom-duckdb"` inline; every tab reachable | gate registry + `/admin/gates` |
| C4 | Arrow transport refuses honestly when unavailable | ✅ `?format=arrow` 400s with `arrow_unavailable` and tells the caller to use the JSON path | never a fabricated empty stream |
| C5 | Kill switch | ✅ FLAG0 `n2b-sql-lab-duckdb` → guided notice, backend untouched | `lib/admin/runtime-flags.ts` |

### D. Security + audit

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| D1 | No anonymous path | ✅ `withSession` on every route (401 before anything else) | route toolkit |
| D2 | Every execution audited | ✅ `_auditLog` row + SIEM fan-out on success AND failure, awaited before the response | `logDuckDbAccess` |
| D3 | No keys / secrets | ✅ `CREDENTIAL_CHAIN` managed-identity Azure secret; nothing else configured | `duckdb-aca.bicep` |
| D4 | No egress at runtime | ✅ extensions baked at image build; `autoinstall/autoload` off + `lock_configuration=true` after setup | `app/engine.py` |
| D5 | Internal ingress only | ✅ the BFF is the sole door | `duckdb-aca.bicep` |

---

## Where Loom exceeds the comparators

- **A free tier below the server.** N2a serves refinement queries with zero server cost and zero network — no
  comparator has an in-browser tier at all.
- **Never a dead surface.** With nothing deployed SQL Lab still executes on Synapse Serverless. Databricks SQL
  without a warehouse and Fabric without capacity are both unusable.
- **Sovereign by construction.** DuckDB is one embedded OSS binary and the wasm is a static same-origin asset,
  so both tiers work air-gapped. Every comparator is a SaaS control plane.

## IL5 / sovereignty note

Fully in-boundary. The serving tier is a self-hosted OSS container on this deployment's own Container Apps
environment reading this deployment's own ADLS Gen2, with its extensions baked into the image (no extension
repository is reachable at runtime, by configuration). The in-browser tier is a static `.wasm` served from
Loom's own origin with no telemetry and no CDN. `LOOM_DEFAULT_FABRIC_WORKSPACE` is unset throughout and no
Fabric / OneLake / Power BI host is reachable from any code path.

## Verification

- `tests/loom_duckdb/test_sqlguard.py` — read-only admission control (default-deny, comment/literal smuggling).
- `lib/duckdb/__tests__/local-arrow-query.test.ts` — the REAL Arrow IPC fixture reaching the engine
  byte-for-byte, zero-network stats, statement counting, measured timing, bigint precision.
- `lib/arrow/__tests__/transport-policy.test.ts` — the JSON→Arrow switch and its before/after measurement.
- `app/api/duckdb/__tests__/duckdb-routes.test.ts` — auth, the Synapse fallback naming its engine, the Arrow
  leg's headers, and the audit row on success and failure.
- `lib/editors/__tests__/sql-lab-editor.test.tsx` — both engine states, the measured status bar, the FLAG0 notice.
- Browser E2E (G1) pending on a live deployment: run a `delta_scan` against a real Gold table with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, then re-slice it in the Local analysis tab and capture the timing bar.

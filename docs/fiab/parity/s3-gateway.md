# s3-gateway — parity with an S3-compatible object gateway over ADLS (Preview lab)

**Source UI:** no first-party Microsoft surface. Azure has **no S3-compatible
gateway product** — there is no portal blade, no Fabric item, and no Azure
service that fronts ADLS with an S3 API. The comparators are:
- **Apache s3proxy** (Apache-2.0) — the gateway Loom's docs prescribe deploying
- **AWS S3 console** — the API surface being emulated
- Loom's own **N1 Iceberg REST Catalog + native `abfss://`** path, which the
  surface itself argues is the better default
- **ADLS Gen2 / Blob** portal blade — <https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction>

MinIO's gateway is explicitly **not** used (AGPL). This surface is therefore
graded against the `docs/fiab/ux-standards.md` §7 checklist plus a
connect-surface capability inventory.

**Surface file:** `apps/fiab-console/lib/editors/s3-gateway-editor.tsx` (202 lines)
**Existing test:** `lib/editors/__tests__/s3-gateway-error.test.tsx` (2 cases, apex A3)
**Route:** `/items/s3-gateway/[id]` · N8 lab 3 · Tagged **Preview**.

## Scope honesty — this is a connect-info surface, not an object browser

The editor reports whether a gateway endpoint is wired and, if so, renders
per-engine connect snippets. It does **not** browse buckets or objects. That is
its stated scope. Object-browse rows are still listed as MISSING below so a
reader comparing against the S3 console knows they are absent, but they are out
of scope rather than defective.

## Capability inventory and Loom coverage

### Connect surface

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| C1 | Report whether a gateway is configured | built | `GET /api/s3-gateway/info` → `configured` drives an `endpoint set` success badge. |
| C2 | Show the endpoint | built | `Body1` with the endpoint in a `<code>`. |
| C3 | Per-engine connect snippets | built | `data.snippets[]` rendered as titled cards with a language badge and a `<pre>` block. |
| C4 | Copy-to-clipboard on each snippet | **MISSING** | Snippets are selectable text only — no copy button. On a surface whose *entire purpose* is handing the user a snippet, this is the most conspicuous omission. |
| C5 | Credentials / access-key guidance | **MISSING** | S3 clients need an access key and secret. The surface names the endpoint and nothing about authentication. A user following this page cannot actually connect. |
| C6 | Bucket / container mapping shown | partial | `lakeAccount` is in the response type; no control renders it. Dead field. |
| C7 | Region / signature-version hints | **MISSING** | s3proxy deployments commonly need `region` and `path-style` settings; not surfaced. |
| C8 | Test-the-connection action | **MISSING** | No way to verify the gateway actually answers from within Loom. |
| C9 | Browse buckets / objects | **MISSING** (by scope) | Not this surface's job. |

### Steering the user to the better default *(the surface's real strength)*

| # | Capability | Loom | Evidence |
|---|---|---|---|
| N1 | **Always** show the native no-gateway path | built (exemplary) | An `intent="info"` `MessageBar` rendered whenever `data.nativePath` exists — before and independently of any gateway config — carrying the Iceberg-REST-Catalog note and a concrete `abfss://` example. |
| N2 | Argue *against* deploying a gateway when unnecessary | built (exemplary) | The `LearnPopover` is titled "Most engines need no gateway" and names Trino, Spark, DuckDB and Snowflake as engines that should use the native governed+audited path instead. A surface that talks a user out of using itself when that is the right answer is the correct behaviour under `no-vaporware.md`, and it is rare. |
| N3 | Explain the licensing choice | built | States plainly that an Apache-2.0 s3proxy is the prescribed path and the AGPL MinIO gateway is not used. |
| N4 | Empty state that repeats the recommendation | built | "No S3 gateway wired — and most deployments don't need one", pointing back to the native path. |

### Surface behaviour and gating

| # | Bar | Loom | Evidence / gap |
|---|---|---|---|
| S1 | Runtime kill-switch with a guided off-state | built | Flag `n8-s3-gateway` off renders a full `EmptyState` naming the flag and confirming the Iceberg REST Catalog and native `abfss://` path keep working. |
| S2 | Shared **`HonestGate`** with inline **Fix it** | built | `<HonestGate gateId="svc-s3-gateway" missing={data.gate.missing} … onResolved={refetch}>` — **G2 compliant**. |
| S3 | Gate is a warning, never red on first open | built | Documented in the module header; the gate is for an *optional* capability. |
| S4 | **`q.isError` branch** with a Retry action | built (this is the A3 fix) | `intent="error"` `MessageBar` naming the failure, plus a **Retry** button, plus the reassurance that the native path is unaffected. Regression-pinned by `s3-gateway-error.test.tsx`. **This is the pattern its sibling `ducklake-catalog` is still missing.** |
| S5 | Loading state | built | `Spinner` with a label. |
| S6 | `ItemEditorChrome` shell | built | |
| S7 | Ribbon actions | **MISSING** | `ribbon={[]}` — no commands, not even Refresh (Retry exists only inside the error MessageBar). |
| S8 | `TeachingBanner` | **MISSING** | `LearnPopover` only. |
| S9 | G3 resizable panes | **MISSING** | No `splitKeyPrefix` / `SplitPane`. |
| S10 | Snippet block uses Loom tokens | built | `fontFamilyMonospace`, `colorNeutralBackground3`, `borderRadiusMedium`; `overflowX: 'auto'` so a long snippet cannot break the layout. |
| S11 | Badge rows wrap | built | `flexWrap: 'wrap'` + `minWidth: 0` on `toolbar`. |

## Totals

**14 built (3 exemplary) · 1 partial · 8 MISSING — 23 rows.**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Gateway info + snippets + native path | `GET /api/s3-gateway/info` (`cache: 'no-store'`) | Reads `LOOM_S3_GATEWAY_URL` + the lake account; generates real per-engine snippets |
| Runtime flag | `useRuntimeFlag('n8-s3-gateway')` | Runtime-flag registry |
| Gate Fix-it | `HonestGate` → `svc-s3-gateway` | Gate registry |
| Retry | `q.refetch()` | Same route |

No mocks. No Fabric host contacted.

## Assessment

**B on honesty, C on usefulness.** This surface has the best *editorial*
behaviour in the batch — it consistently steers the user toward the native
`abfss://` + Iceberg path and openly argues that most deployments should not use
a gateway at all. S4 (the A3 error branch with Retry) is the pattern the rest of
the codebase should adopt, and it is the one surface here with a dedicated
regression test.

Where it falls down is the one job it exists to do:

1. **C5 — no credential guidance.** An S3 client needs an access key and secret.
   The surface hands over an endpoint and stops. A user who follows this page
   end-to-end still cannot connect.
2. **C4 — no copy button on the snippets.** The surface's primary output is a
   snippet, and it cannot be copied in one action.
3. **C8 — no connection test.** Nothing verifies the configured gateway is alive;
   `configured` means only "an env var is set".
4. **C6 — `lakeAccount` is in the response type and never rendered.** Dead field.

Cross-surface finding for the owning lane: the A3 `q.isError` fix that this file
carries was **not** propagated to `ducklake-catalog-editor.tsx`, which has the
identical `useQuery` + throwing-fetcher shape and no error branch. See
`docs/fiab/parity/ducklake-catalog.md` S12.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); GitHub Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/s3-gateway/<id>
  ```
  The walk should confirm the three states (flag-off / unconfigured / configured)
  and that a snippet copied from the page actually connects a real s3 client.
- Coverage read from source; static evidence only (`no_scaffold_claims`). The
  `q.isError` branch (S4) **is** covered by a real unit test, which is stronger
  evidence than the rest of this table.

# loom-vscode — Spark job definition — parity

**Surface:** the CSA Loom VS Code extension's Phase-5 Spark job definition
commands — `Configure Spark job…`, `Upload Spark job file…`, `Run Spark job`,
`View Spark job runs` (on a `spark-job-definition` item), plus create/rename/
delete/open-definition from the Phase-1 item lifecycle.

**Source UI (Fabric):** Spark Job Definition authoring in VS Code — create (name,
referenced/default lakehouse), Files node, Lakehouse node, Run node (history +
status), submit a run, full CRUD — <https://learn.microsoft.com/fabric/data-engineering/author-sjd-with-vs-code>
(PRP §1.5 rows J1–J6).

**Governing rules:** `no-fabric-dependency.md` (Azure-native Synapse Spark +
ADLS, never OneLake), `no-vaporware.md` (real Livy batch or an honest gate — no
fake kernel, no synthetic runs), `loom_no_freeform_config` (guided spec, not a
JSON blob), `ui-parity.md`.

> Legend: ✅ built · ⚠️ honest gate · ❌ deferred (stated).

## Fabric feature inventory → Loom coverage

| # | Capability (Fabric) | Loom coverage | Status |
|---|---|---|---|
| J1 | **Create** an SJD + set its definition (main file, pool/lakehouse) | `Create item…` (P1) + `Configure Spark job…` — a guided pool + main file + language flow (never a freeform JSON blob) | ✅ |
| J2 | **Files** node — upload main definition + reference libraries | `Upload Spark job file…` — pick a local file + kind (main/reference); a `main` upload also records `spec.file` | ✅ |
| J3 | **Lakehouse** node — referenced lakehouses, default marked, relative paths | pool + main file are surfaced in `Configure` and run detail; a nested lakehouse-browser node is deferred (Azure-native: the SJD binds a Synapse pool + ADLS `abfss://` paths, not a OneLake lakehouse) | ⚠️/❌ |
| J4 | **Run** node — run history + per-run status | `View Spark job runs` — the real Livy batch history; per-run detail (state, appId, driver-log tail); a running batch can be **cancelled** | ✅ |
| J5 | **Submit** a run (real Livy batch) | `Run Spark job` — a real Synapse-Livy batch submit | ✅ |
| J6 | Full **CRUD** | create/rename/delete (P1 lifecycle) + edit definition (P1 `Open definition`) | ✅ |
| — | Pool / main file unset, or Synapse workspace not configured | the route's honest `400` (`spec.pool`/`spec.file`) with a **Configure Spark job** Fix-it, or `503 not_configured` naming `LOOM_SYNAPSE_WORKSPACE`; upload `adls_not_configured` offers pasting an `abfss://` URI | ⚠️ |
| A3 | Read-only PAT blocks writes | `guardWrite` on configure / upload / run / cancel | ✅ |

**Presentation note (honest, `ui-parity.md`):** the Files / Run surfaces are
command- and quick-pick-driven (upload command; a run-history quick-pick with
cancel + detail), matching the pattern Phase 2 already uses for notebook runs,
rather than nested expandable tree nodes. Every action calls the **real dedicated
SJD route** — no fake kernel, no synthetic run rows. J3's nested lakehouse
browser is the one row not built as a node; it is stated, not disguised.

## Backend per control (every command → a real route)

| Command | Route | Request / response |
|---|---|---|
| Configure Spark job | `GET` then `PUT /api/items/spark-job-definition/:id` | GET item → merge `{pool,file,language}` into `state.spec` → `PUT {state}` (no clobber of other state) |
| Upload Spark job file | `POST /api/items/spark-job-definition/:id/files` (multipart) | `{kind:'main'\|'reference', file}` → `{filename, abfssPath, size}` (201); ADLS `landing` write |
| Run Spark job | `POST /api/items/spark-job-definition/:id/submit` | body = persisted spec (or override) → `{pool, job:{id,state,…}}` real Livy batch |
| View Spark job runs | `GET /api/items/spark-job-definition/:id/runs?size=&from=` | → `{pool, sessions:SparkBatchJob[]}` (detailed Livy batches) |
| Cancel a run | `POST /api/items/spark-job-definition/:id/runs/:batch/cancel` | DELETE the Livy batch on the pool |

These are the **same** dedicated routes the Console's SJD editor uses — Synapse
Spark via Livy `/batches` (`submitSparkBatchJob` / `listSparkBatchJobs` /
`cancelSparkBatchJob` in `synapse-dev-client.ts`). No OneLake, no Fabric host.

## Honest gates (no fake kernel, no synthetic runs)

- Submit with no `spec.pool` / `spec.file` → route `400` surfaced verbatim + a
  **Configure Spark job** Fix-it.
- Synapse workspace unset → route `503 {code:'not_configured'}` naming the env
  var, surfaced verbatim.
- File upload with ADLS unset → `400 {code:'adls_not_configured'}` naming
  `LOOM_LANDING_URL`, with a paste-`abfss://`-URI fallback.
- No runs yet → an honest "no runs yet — use Run Spark job" message, never a
  fabricated history row.

## Verification

- `tsc --noEmit` → 0 · `vitest run` (`test/spark-job-def.test.ts`, 17 tests):
  pure request shaping (`buildSubmitBody`, `buildSpecUpdate` merge-without-clobber,
  `specFromState`), run normalization (`runState`/`isTerminalRun`/`runIcon`/
  `summarizeRun`/`runsFromResponse`), and transport (submit/runs/cancel/put URL +
  body shaping, an honest `400 spec.file` surfacing, and the multipart upload path
  incl. the `adls_not_configured` gate).
- G1 in-editor E2E (a real Livy batch id + state transition against a live pool)
  is pending — not runnable from the build worktree; the routes are the ones the
  Console SJD editor already exercises end-to-end.

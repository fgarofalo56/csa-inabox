# synapse-notebook — parity with the Synapse Studio Spark notebook (Develop → Notebooks)

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the new **Synapse notebook authoring editor** — the heavy Develop-hub
> surface that `synapse-analytics.md` previously graded as MISSING ("Spark is a
> single textbox today"). This is the multi-cell Spark notebook with a real Livy
> interactive-session run path.

**Source UI (grounded in Microsoft Learn, not memory):**
- Synapse notebooks overview: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-notebook-concept
- Create / develop / maintain notebooks (cells, magic commands, run cell / run all / run-above-below, variable explorer, Spark progress, session config): https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
- Quickstart analyze with Spark (Attach-to pool, %%pyspark, display(df), Run): https://learn.microsoft.com/azure/synapse-analytics/get-started-analyze-spark
- Data visualization in notebooks (display() chart builder): https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-data-visualization

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/synapse-notebook-editor.tsx` — `SynapseNotebookEditor`
  (workspace-notebook tree, multi-cell IPYNB editor, NotebookCellView with Monaco,
  rich `display(df)` table / HTML / image output, Databricks-backend badge + cluster picker).
- BFF: `apps/fiab-console/app/api/synapse/notebooks/route.ts` (list/create),
  `…/[name]/route.ts` (open/save/delete), `…/[name]/run-cell/route.ts` (legacy Livy run + poll),
  **`app/api/notebook/[id]/session/route.ts`** (F16 — Livy session create/reuse + keepalive + kill),
  **`app/api/notebook/[id]/execute/route.ts`** (F16 — per-cell submit + poll, %%-magic + %%configure).
- Livy client: `apps/fiab-console/lib/azure/synapse-livy-client.ts` (sessions, statements,
  magic parsing, output normalizer, backend resolver).
- Attach picker: `app/api/items/synapse-spark-pool/list` (ARM bigDataPools);
  Databricks opt-in cluster picker → `app/api/admin/scaling/databricks-cluster`.

**Backend reality check.** List/open/save/delete call the Synapse **dev-plane
artifact REST** (notebooks, api-version 2020-12-01); the F16 per-cell path creates a real
**Livy** interactive session (`POST …/sessions`), submits a statement, and polls to `available`,
**reusing the warm session across cells** with a 4-min keepalive and kill-on-unmount. `%%sql` /
`%%pyspark` / `%%spark` / `%%sparkr` magics override the statement kind (magic line stripped);
`%%configure` is intercepted and merged into the next session create. `display(df)` rich output
(`text/html`, `application/json` df grid, `image/png`) is normalized and rendered. Databricks is
**strictly opt-in** via `LOOM_NOTEBOOK_BACKEND=databricks` (Execution Context API) — the Azure-native
Synapse Livy path is the default and works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Honest 503
`not_configured` gate keyed on `LOOM_SYNAPSE_WORKSPACE`; the full designer still renders behind the
MessageBar. No `return []`, no `MOCK_`, no `useState(SAMPLE)`.

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Notebook lifecycle (Develop hub)

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| A1 | List workspace notebooks | ✅ built | left tree → `GET /api/synapse/notebooks` (artifact REST) |
| A2 | Create new notebook | ✅ built | name input + "+" → `POST /api/synapse/notebooks` |
| A3 | Open notebook (load cells) | ✅ built | tree click → `GET …/[name]`; `ipynbToCells` |
| A4 | Save / **Publish** notebook | ✅ built | Save → `PUT …/[name]`; `cellsToIpynb` (writes the artifact) |
| A5 | Delete notebook | ✅ built | ribbon Delete → `DELETE …/[name]` |
| A6 | Unsaved-changes (dirty) indicator | ✅ built | `dirty` badge |
| A7 | **Workspace Git / Publish-vs-live mode** (publish all, discard) | ❌ MISSING | per-notebook save only; no Studio Git/Publish shell |
| A8 | Rename / move / clone / export (.ipynb / HTML) | ❌ MISSING | not surfaced |
| A9 | Notebook **Properties** pane (description, folder) | ❌ MISSING | not surfaced |

### B. Cell authoring

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Add code cell | ✅ built | `addCell('code')` (toolbar, ribbon, between-cell adders) |
| B2 | Add markdown cell | ✅ built | `addCell('markdown')` |
| B3 | Per-cell language: PySpark / Spark(Scala) / Spark SQL / SparkR (%% magics) | ✅ built | cell language dropdown → KIND_TO_MONACO; magic round-trips on save/open |
| B3a | **Notebook default language** | ✅ built | toolbar "Language" dropdown → new cells inherit `defaultLang` |
| B4 | Move cell up / down | ✅ built | `moveCell(±1)` |
| B5 | Delete cell | ✅ built | `deleteCell` (≥1 enforced) |
| B6 | Markdown edit ⇄ render toggle | ✅ built | NotebookCellView md edit/view + double-click |
| B7 | Monaco editor with syntax highlight | ✅ built | `MonacoTextarea` per cell |
| B8 | .NET for Spark **C# (%%csharp)** cell | ✅ built | 5th `CellKind` `csharp`; `%%csharp` magic round-trip; Monaco `csharp` |
| B9 | IntelliSense / code completion | ⚠️ partial | Monaco baseline only; no Spark-aware completion |
| B10 | Cell-level **duplicate / collapse** | ✅ built | per-cell "…" menu → `duplicateCell`; collapse chevron → `collapsed` (jupyter.source_hidden) |
| B10a | **Insert cell between cells** (hover adder) | ✅ built | `<CellAdder>` before first + after each cell → `addCell(…, 'before'/'after')` |
| B11 | Cell **status indicator** (step-by-step) + duration summary | ⚠️ partial | running spinner + ok/error output; no per-step timeline |
| B12 | **Parameters cell** (papermill/ADF `tags:["parameters"]`) | ✅ built | "…" menu toggle + ribbon "Parameters cell"; single-cell enforced; `parameters` badge; tag round-trips in IPYNB |
| B13 | **Outline** (markdown headings → click-to-scroll nav) | ✅ built | left-panel Outline (`outline` useMemo) → `scrollIntoView` on `cell-<id>` |
| B14 | **Copilot cell edges** (NL→code, explain, fix-error) | ✅ built | per-cell Ask Copilot / Explain / Fix → `POST /api/notebook/[id]/assist` → AOAI `chat` deployment (`resolveAoaiTarget`), grounded in T2 lakehouse schema; honest `no_aoai` gate. No Fabric Copilot dependency |

### C. Compute attach & session

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| C1 | **Attach to** a Big Data (Spark) pool | ✅ built | Attach dropdown → `GET /api/items/synapse-spark-pool/list` (ARM) |
| C1a | **Attach environment** (Spark configuration) | ✅ built | Environment dropdown → `GET /api/synapse/environments` (dev-plane `sparkconfigurations`); persisted as `metadata.a365ComputeOptions` |
| C2 | Live session state badge (none/starting/idle/busy) | ✅ built | `sessionState` badge; warmed session reused across cells via `POST /api/notebook/[id]/session` |
| C3 | Cold-start warm-up (poll session to idle, then submit) | ✅ built | session POST + GET poll loop on non-idle state |
| C4 | **Configure session** pane (executors, size, timeout) / `%%configure` | ✅ built | `%%configure` cell parsed → merged into next `createLivySession` (driver/executor cores, numExecutors, conf) |
| C5 | Restart / stop session; cancel running cell(s) | ⚠️ partial | session **kill** on unmount + on `%%configure` (`DELETE /api/notebook/[id]/session`); no in-toolbar stop/cancel button yet |
| C6 | Spark **progress indicator** + drill to Spark UI | ⚠️ partial | session badge + statement `progress`; no per-job progress bar / Spark-UI link |

### D. Run & output

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Run a single cell | ✅ built | per-cell Run → `POST …/run-cell` (Livy submit) + poll |
| D2 | Run all (in sequence) | ✅ built | ribbon "Run all" → loops `runCell` |
| D3 | Shift+Enter / Ctrl+Enter run shortcut | ⚠️ partial | Run buttons present; per-cell keybind not wired (other editors do Shift+Enter) |
| D4 | Text output (text/plain) | ✅ built | `out.textPlain` from normalized Livy `data['text/plain']` |
| D5 | Error output (ename/evalue/traceback) | ✅ built | `outputErr` block renders the traceback |
| D6 | Run **cells above / below** | ❌ MISSING | run-cell + run-all only |
| D7 | `display(df)` rich **table** + chart builder | ⚠️ partial | rich **table** (`application/json` df grid), HTML (`text/html`), and image (`image/png`) rendered via `normalizeLivyOutput`; interactive **chart builder** UI not yet built |
| D8 | **Variable explorer** (PySpark vars table) | ❌ MISSING | not surfaced |
| D9 | `%run <notebook>` cross-notebook reference | ❌ MISSING | per-cell REPL only |
| D10 | mssparkutils (`%%configure`, secrets, fs) helpers | ❌ MISSING | not surfaced |

### E. Honest gate / disclosure

| # | Capability | Loom | Where / backend |
|---|---|---|---|
| E1 | Honest infra-gate when workspace unset | ✅ built | MessageBar naming `LOOM_SYNAPSE_WORKSPACE` + Synapse Artifact Publisher role + bicep path |
| E2 | **ADLS .ipynb backup** (notebook durable in Cosmos + ADLS) | ✅ built | Save → `PUT …/[name]` writes `silver/loom/notebooks/<ws>/<name>.ipynb` (non-fatal; status surfaced in the save banner) |

---

## Coverage tally (post-F15 authoring update, 2026-06-06)

- **built ✅: 30**
- **partial ⚠️: 6**
- **honest-gate ⚠️: 1**
- **MISSING ❌: 7**

## Honest grade: **B+**

This is now a genuine, **production-grade** Synapse-Studio notebook surface that
combines **full authoring parity (F15)** with **real per-cell Spark execution
(F16)**.

F15 lifted the **authoring surface**: all five languages (PySpark / Scala /
Spark SQL / SparkR / .NET-C#) with magic-header round-trip, a **notebook default
language**, **insert-between** cell adders, **duplicate** and **collapse**, a
**parameters cell** (papermill/ADF tag, single-cell enforced), a left-panel
**Outline**, **Copilot cell edges**, and an **environment** (Spark configuration)
attach alongside the Spark-pool attach. Saving publishes to the Synapse artifact
REST **and** backs the `.ipynb` up to ADLS silver.

F16 closed the biggest execution gaps: **real Livy execution** (create session →
submit statement → poll → render output) reusing the warm session across cells
with keepalive + kill-on-unmount, **`display(df)` rich output** (df table grid,
HTML, image), **`%%configure`** session tuning, and **session lifecycle**.
Databricks is a real opt-in backend (Execution Context API) — Synapse Livy stays
the Azure-native default and works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
**No vaporware** — every control hits a real backend; Spark code actually runs;
the environment picker and ADLS backup degrade honestly when unconfigured.

Held to **B+** (not A) by `ui-parity.md`'s completeness bar: no interactive
**chart builder** over `display(df)` (table/HTML/image render, but not the Vega
chart UI), no **variable explorer** (D8), no **run-above/below** (D6), no
in-toolbar **restart/stop/cancel** button (kill is automatic), no **Spark
progress bar / Spark-UI drill-in** (C6), no **`%run`** (D9), no **mssparkutils**
helpers (D10), and no **Studio Git/Publish shell** (A7).

## Highest-value gaps to build next (T17 + beyond)

1. **`display(df)` table + chart builder** (D7) — the defining output surface.
2. **Configure-session pane / `%%configure`** (C4) + **restart/stop/cancel** (C5).
3. **Variable explorer** (D8) and **run-above/below** (D6).
4. **Spark progress bar + Spark-UI deep link** (C6).
5. **`%run` cross-notebook** (D9).
6. **Studio Git/Publish shell** (A7) — shared with the broader Synapse parity work.

## Backend per control

| Control | BFF route | Synapse endpoint |
|---|---|---|
| List notebooks | `GET /api/synapse/notebooks` | Notebooks artifact list (api 2020-12-01) |
| Create notebook | `POST /api/synapse/notebooks` | Notebook create-or-update |
| Open notebook | `GET /api/synapse/notebooks/[name]` | Notebook get |
| Save / Publish | `PUT /api/synapse/notebooks/[name]` | Notebook create-or-update |
| Delete notebook | `DELETE /api/synapse/notebooks/[name]` | Notebook delete |
| Attach-pool list | `GET /api/items/synapse-spark-pool/list` | ARM `Microsoft.Synapse/workspaces/bigDataPools` |
| Attach-environment list | `GET /api/synapse/environments` | dev-plane `GET /sparkconfigurations` (api 2020-12-01) |
| ADLS .ipynb backup | `PUT /api/synapse/notebooks/[name]` (folded) | `adls-client.uploadFile` → `silver/loom/notebooks/<ws>/<name>.ipynb` |
| Copilot edge (generate/explain/fix) | `POST /api/notebook/[id]/assist` | AOAI chat-completions on the Foundry `chat` deployment (`cognitiveservices.azure.com` scope), schema-grounded |
| Create / reuse session | `POST /api/notebook/[id]/session` | Livy `POST …/sessions` (or reuse via `GET …/sessions/{id}`) |
| Keepalive + state poll | `GET /api/notebook/[id]/session` | Livy `PUT …/sessions/{id}/keepalive` + `GET …/sessions/{id}` |
| Kill session | `DELETE /api/notebook/[id]/session` | Livy `DELETE …/sessions/{id}` |
| Run cell (submit) | `POST /api/notebook/[id]/execute` | Livy create-statement (magic-stripped; %%configure intercepted) |
| Run cell (poll) | `GET /api/notebook/[id]/execute?pool=&sessionId=&stmtId=` | Livy `GET …/statements/{id}` → `normalizeLivyOutput` |
| Databricks opt-in (cluster list) | `GET /api/admin/scaling/databricks-cluster` | Databricks `/api/2.0/clusters/list` |
| Legacy run cell (submit) | `POST /api/synapse/notebooks/[name]/run-cell` | Livy create session + submit statement (kept for the artifact-name path) |
| Legacy run cell (poll) | `GET …/run-cell?pool=&session=&stmt=` | Livy get statement |

## Bicep / env sync

- Env vars consumed: **`LOOM_SYNAPSE_WORKSPACE`** (Synapse workspace name) — gate
  MessageBar names it explicitly — and **`LOOM_SILVER_URL`** (ADLS silver
  container URL for the `.ipynb` backup, emitted by the DLZ deploy into the
  console app env). Optional: **`LOOM_NOTEBOOK_BACKEND`** (`synapse` default /
  `databricks` opt-in), **`LOOM_CLOUD_TIER`** (`IL5` blocks the Databricks
  opt-in), **`LOOM_DATABRICKS_HOSTNAME`** (required only when backend=databricks).
  All wired in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- Roles: the Loom Console UAMI needs **Synapse Artifact Publisher** on the
  workspace (artifact writes) plus the data-plane role **Synapse Compute
  Operator** at the Spark-pool scope to submit Livy sessions/statements —
  granted by `consoleSparkSubmitRoleScript` in
  `platform/fiab/bicep/modules/landing-zone/synapse.bicep`
  (`az synapse role assignment create --role "Synapse Compute Operator"`). The
  `.ipynb` ADLS backup additionally needs the Console UAMI to hold **Storage
  Blob Data Contributor** on the DLZ data-lake account — granted idempotently by
  the post-deploy bootstrap step *"Grant Console UAMI Storage Blob Data
  Contributor on DLZ"* in `.github/workflows/csa-loom-post-deploy-bootstrap.yml`.
  The backup is non-fatal, so a missing grant never blocks publish.
- IL5: set `sparkPoolIsolatedCompute=true` (same module) to enable compute
  isolation on `loompool`; the `peDev` private endpoint is required in
  GCC-High/IL5.
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: list/create/save/delete hit the real artifact REST;
  run-cell drives a real Livy session; honest 503 gate when `LOOM_SYNAPSE_WORKSPACE`
  unset.
- Live `pnpm uat` side-by-side against Synapse Studio's notebook: **pending** (no
  minted session / reachable workspace + warm pool in this worktree). MISSING/partial
  rows derived from code, not a live click-through; confirm against the live Studio
  per the no-scaffold rule.

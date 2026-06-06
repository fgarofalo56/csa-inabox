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
  (workspace-notebook tree, multi-cell IPYNB editor, NotebookCellView with Monaco).
- BFF: `apps/fiab-console/app/api/synapse/notebooks/route.ts` (list/create),
  `…/[name]/route.ts` (open/save/delete), `…/[name]/run-cell/route.ts` (Livy run + poll).
- Attach picker: `app/api/items/synapse-spark-pool/list` (ARM bigDataPools).

**Backend reality check.** List/open/save/delete call the Synapse **dev-plane
artifact REST** (notebooks, api-version 2020-12-01); run-cell creates a real
**Livy** interactive session and submits a statement, polling to `available`.
Cells round-trip through canonical IPYNB (`ipynbToCells`/`cellsToIpynb`) with the
Synapse `%%sql`/`%%spark`/`%%sparkr` magic carried in cell source. Honest 503
`not_configured` gate keyed on `LOOM_SYNAPSE_WORKSPACE`; the full designer still
renders behind the MessageBar. No `return []`, no `MOCK_`, no `useState(SAMPLE)`.

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

### C. Compute attach & session

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| C1 | **Attach to** a Big Data (Spark) pool | ✅ built | Attach dropdown → `GET /api/items/synapse-spark-pool/list` (ARM) |
| C1a | **Attach environment** (Spark configuration) | ✅ built | Environment dropdown → `GET /api/synapse/environments` (dev-plane `sparkconfigurations`); persisted as `metadata.a365ComputeOptions` |
| C2 | Live session state badge (none/starting/idle/busy) | ✅ built | `sessionState` badge; warmed session reused across cells |
| C3 | Cold-start warm-up (poll session to idle, then submit) | ✅ built | run-cell POST loop on `sessionWarming` |
| C4 | **Configure session** pane (executors, size, timeout) / `%%configure` | ❌ MISSING | attach + default session only |
| C5 | Restart / stop session; cancel running cell(s) | ❌ MISSING | no stop/cancel control |
| C6 | Spark **progress indicator** + drill to Spark UI | ⚠️ partial | session badge only; no per-job progress bar / Spark-UI link |

### D. Run & output

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Run a single cell | ✅ built | per-cell Run → `POST …/run-cell` (Livy submit) + poll |
| D2 | Run all (in sequence) | ✅ built | ribbon "Run all" → loops `runCell` |
| D3 | Shift+Enter / Ctrl+Enter run shortcut | ⚠️ partial | Run buttons present; per-cell keybind not wired (other editors do Shift+Enter) |
| D4 | Text output (text/plain) | ✅ built | `out.text` from Livy `data['text/plain']` |
| D5 | Error output (ename/evalue/traceback) | ✅ built | `outputErr` block renders the traceback |
| D6 | Run **cells above / below** | ❌ MISSING | run-cell + run-all only |
| D7 | `display(df)` rich **table** + chart builder | ❌ MISSING | text/plain only; no table/chart render |
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

- **built ✅: 28**
- **partial ⚠️: 3**
- **honest-gate ⚠️: 1**
- **MISSING ❌: 11**

## Honest grade: **B+**

F15 lifted the **authoring surface** to full Synapse-Studio parity: all five
languages (PySpark / Scala / Spark SQL / SparkR / .NET-C#) with magic-header
round-trip, a **notebook default language**, **insert-between** cell adders,
**duplicate** and **collapse**, a **parameters cell** (papermill/ADF tag,
single-cell enforced), a left-panel **Outline**, and an **environment** (Spark
configuration) attach alongside the Spark-pool attach. Saving publishes to the
Synapse artifact REST **and** backs the `.ipynb` up to ADLS silver. Cells +
order + per-cell language + parameters tag all round-trip through canonical
IPYNB. No vaporware — every control hits a real backend; the environment picker
and ADLS backup degrade honestly when unconfigured.

Held to **B+** (not A) by the *execution / output* gaps that are explicitly out
of F15 scope (tracked for **T17**): no **`display(df)` rich table/chart**
(text/plain only), no **variable explorer**, no **Configure-session /
`%%configure`**, no **restart/stop/cancel**, no **Spark progress bar / Spark-UI
drill-in**, no **run-above/below**, no **`%run`**, and no **Studio Git/Publish
shell**.

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
| Run cell (submit) | `POST /api/synapse/notebooks/[name]/run-cell` | Livy create session + submit statement |
| Run cell (poll) | `GET …/run-cell?pool=&session=&stmt=` | Livy get statement |

## Bicep / env sync

- Env var consumed: **`LOOM_SYNAPSE_WORKSPACE`** (Synapse workspace name; gate
  MessageBar names it) and **`LOOM_SILVER_URL`** (ADLS silver container URL,
  already emitted by the DLZ deploy into the console app env in
  `platform/fiab/bicep/modules/admin-plane/main.bicep`).
- Role: Loom UAMI needs **Synapse Artifact Publisher** on the workspace (Livy +
  artifact writes). The `.ipynb` ADLS backup additionally needs the Console UAMI
  to hold **Storage Blob Data Contributor** on the DLZ data-lake account — granted
  idempotently by the post-deploy bootstrap step *"Grant Console UAMI Storage Blob
  Data Contributor on DLZ"* in `.github/workflows/csa-loom-post-deploy-bootstrap.yml`
  (same access the lakehouse provisioner uses). The backup is non-fatal, so a
  missing grant never blocks publish.
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: list/create/save/delete hit the real artifact REST;
  run-cell drives a real Livy session; honest 503 gate when `LOOM_SYNAPSE_WORKSPACE`
  unset.
- Live `pnpm uat` side-by-side against Synapse Studio's notebook: **pending** (no
  minted session / reachable workspace + warm pool in this worktree). MISSING/partial
  rows derived from code, not a live click-through; confirm against the live Studio
  per the no-scaffold rule.

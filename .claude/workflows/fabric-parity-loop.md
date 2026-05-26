# Fabric-parity loop — multi-agent build workflow (v2, 2026-05-26)

> Iterative build pipeline for getting CSA Loom editors to true Fabric parity. Each UI runs through Catalog → Build → **4-phase Validate**, loops on fail until the **independent validator** approves with a real visual + functional verdict from a live browser.

## Why v2 of this exists (the false-positive incident)

v1 had a "validator" that grep'd the live DOM for marker strings and called any editor that returned 200 with the right strings an A. That gate produced systematic false-positive As — the user opened the live URL, found textareas instead of Monaco, dead History buttons, DAG views with no arrows, and called it out.

**The v1 validator graded the chrome, not the editor.** v2 replaces it with a 4-phase live-browser validator that opens Fabric AND Loom side-by-side, screenshots both, and clicks every button.

Mandatory reading before invoking this workflow: the `no-scaffold-claims` + `parity-validation-standard` memories. **Do NOT call any editor "shipped" / "in parity" / "A-grade" without the v2 validator passing.** If you only ran a DOM probe, the grade is C at best.

## Architecture

```
                       ┌──────────────────────────────┐
                       │  fabric-parity-tasks.json    │
                       │  (per-UI seed list)          │
                       └──────────────┬───────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │ For each UI in the list:    │                              │
        │                             ▼                              │
        │   ┌──────────────────────────────────────────┐             │
        │   │ Phase 1 — CATALOG (Explore agent)        │             │
        │   │  • Playwright → Fabric ref workspace     │             │
        │   │  • Open the real Fabric item             │             │
        │   │  • Screenshot every button, dropdown,    │             │
        │   │    side panel, ribbon, hover state       │             │
        │   │  • Output: docs/fiab/parity-specs/      │             │
        │   │    <ui-name>-spec.md                     │             │
        │   └──────────────────┬───────────────────────┘             │
        │                      ▼                                     │
        │   ┌──────────────────────────────────────────┐             │
        │   │ Phase 2 — BUILD (general-purpose agent)  │             │
        │   │  • Read the spec from Phase 1            │             │
        │   │  • Build Loom UI matching it             │             │
        │   │  • Wire to real Azure backend            │             │
        │   │  • Add bicep + bootstrap scripts so      │             │
        │   │    push-button deploy provisions any     │             │
        │   │    new dependency                        │             │
        │   │  • Build image, deploy v<n>, verify      │             │
        │   │  • Commit progress                       │             │
        │   └──────────────────┬───────────────────────┘             │
        │                      ▼                                     │
        │   ┌──────────────────────────────────────────┐             │
        │   │ Phase 3 — VALIDATE (v2 — 4 mandatory     │             │
        │   │           steps in a live browser)       │             │
        │   │  STEP 1: Fabric reference capture        │             │
        │   │    • Playwright → Fabric portal          │             │
        │   │    • Full-page screenshot →              │             │
        │   │      temp/parity/<ui>-fabric.png         │             │
        │   │  STEP 2: Loom under-test capture         │             │
        │   │    • Playwright → live Loom URL          │             │
        │   │    • Full-page screenshot →              │             │
        │   │      temp/parity/<ui>-loom.png           │             │
        │   │  STEP 3: Side-by-side gap doc            │             │
        │   │    • docs/fiab/parity-gap/<ui>.md        │             │
        │   │      with row-by-row matrix (Fabric      │             │
        │   │      element vs Loom: present/missing/   │             │
        │   │      different), severity                │             │
        │   │      BLOCKER / MAJOR / MINOR / COSMETIC  │             │
        │   │  STEP 4: Functional click-every-button   │             │
        │   │    • For every interactive control in    │             │
        │   │      Loom, click it; capture DOM         │             │
        │   │      change + network response.          │             │
        │   │    • A non-200 (excluding documented     │             │
        │   │      501-gates) = BROKEN.                │             │
        │   │  Honest grade per parity-validation-     │             │
        │   │  standard memory.                        │             │
        │   └──────────────────┬───────────────────────┘             │
        │                      ▼                                     │
        │   ┌──────────────────────────────────────────┐             │
        │   │  Approval gate                           │             │
        │   │   PASS (A or B): mark task complete,     │             │
        │   │                  move to next UI         │             │
        │   │   FAIL (C/D/F):  loop back to Phase 2    │             │
        │   │                  with the needs-rework   │             │
        │   │                  delta as input          │             │
        │   └──────────────────────────────────────────┘             │
        └────────────────────────────────────────────────────────────┘
```

## How to invoke (from this session or a future one)

In a Claude Code session, run:

```
/fabric-parity-loop <ui-name>
```

…or for parallel execution of multiple UIs:

```
/fabric-parity-loop notebook lakehouse data-pipeline
```

The slash command (defined in `.claude/commands/fabric-parity-loop.md`) does the orchestration. It:

1. Reads `docs/fiab/fabric-parity-tasks.json` to look up the UI's metadata (Fabric URL, target Loom routes, expected features)
2. For each UI passed as an argument, spawns three `Agent` calls **sequentially** (catalog → build → validate)
3. If validate returns FAIL, loops back to build with the failure delta as additional context
4. Maximum 3 iterations per UI before stopping and reporting "needs human review"
5. Marks task done in TodoWrite + appends to `docs/fiab/parity-progress.md` when all three pass

Multiple UIs run in parallel by spawning N independent sequential pipelines in a single message — Claude Code handles concurrency.

## Agent roles

| Phase | Agent type | Reason |
|---|---|---|
| **Catalog** | `Explore` | Read-only Playwright + filesystem; outputs a spec file. Cheap context. |
| **Build** | `general-purpose` | Has full tool access — code edits, builds, deploys, runs `az`/`gh`. Fresh context per UI, no pollution. |
| **Validate** | `verify-app` | Different agent; doesn't see what Build did. Only sees: Fabric live + Loom live + the catalog spec. **Must run all 4 v2 steps in a live browser via Playwright.** Brutal honest verdict. |

## Build phase contract (v2 — mandatory standards)

Every Build agent prompt MUST include these requirements:

### 1. Monaco editor with IntelliSense for every code/query/text editor

Replace `<textarea>` with `@monaco-editor/react` in any editor that displays code, query, or structured-text input. Required configuration per language:

| Editor | Monaco language | Required IntelliSense providers |
|---|---|---|
| Notebook code cells (pyspark/python) | `python` | completion + hover + signature help via `monaco.languages.registerCompletionItemProvider('python', …)` seeded with `spark.*`, `df.*`, `pyspark.sql.functions.*` snippets |
| Notebook code cells (sparksql) | `sql` | completion of T-SQL keywords + `OPENROWSET` + ADX `take/where/project` |
| Notebook code cells (scala) | `scala` | completion + Spark Dataset API hover |
| Notebook code cells (r) | `r` | completion + SparkR hover |
| KQL queries (kql-database / kql-queryset / cypher-graph / tracing) | `kusto` | use `@kusto/monaco-kusto` schema-aware completion provider |
| T-SQL (Synapse / warehouse / azure-sql-database / azure-sql-managed-instance / sql-server-2025-vector-index) | `sql` | completion of `SELECT/FROM/WHERE/JOIN/CTE/WINDOW` + table-name resolution from `INFORMATION_SCHEMA` if available |
| APIM policy (apim-policy / apim-api inline policies) | `xml` | XML schema validation for APIM policy XSD + completion of `<inbound>/<outbound>/<on-error>` blocks + `<validate-jwt>` etc. |
| GraphQL API (graphql-api) | `graphql` | GraphQL language service (schema + suggestions) |
| GeoJSON (map / geo-dataset) | `json` | JSON schema for GeoJSON RFC 7946 |
| Spark Job Definition / U-SQL translator output / dbt models / Power Query M / Pipeline JSON | corresponding language | Monaco's built-in highlighting at minimum; IntelliSense if available |
| Ontology source / Plan task descriptions / Cosmos Gremlin query | `plaintext` (Gremlin: register as `gremlin` and seed common steps) | Best-effort |

**Error squiggles** (red underline on syntax errors) MUST be enabled — Monaco's `setModelMarkers` with severity=Error for any parse failure detected client-side.

**Theme**: dark theme (`vs-dark`) to match Fabric / Synapse / Databricks default.

Validator probe (step 4 of Phase 3) must return TRUE for:
- `document.querySelector('[class*="monaco-editor"]')` exists
- The Monaco model has a registered language
- Ctrl+Space opens a completion popup
- Typing an obviously-invalid token produces a `[class*="squiggly-error"]` element

### 2. Cell-edge toolbars visible at rest (not only on hover)

Per the notebook-parity-spec, Fabric's cell toolbar (Lock / Maximize / Duplicate / Convert / More / Delete + Ask Copilot on right edge) is **always visible** on the cell header. Hide-on-hover is not parity.

### 3. Real status bar with live data

Bottom status bar must show real values, not placeholders:
- Compute session state (Spark session id + state from Livy/Databricks if attached)
- AutoSave toggle (real on/off)
- Selected Cell N of M (or row N of M for tabular editors)
- Document language

### 4. Output rendering

Every editor that produces tabular output (Spark DataFrame `.show()`, KQL query, T-SQL SELECT, etc.) must render results inline as a real `<table>` with sortable columns + a "Chart View" toggle that pivots to a basic line/bar/pie via a real charting lib (recharts works fine; do not invent a custom one).

### 5. Side panes

Per the parity spec, every required side pane must render. For notebooks: 3-tab Explorer (Data items / Resources / Connections). For pipelines: Properties / Parameters / Variables / Settings / Output. For semantic-model: Visualization / Data / Filters / Format. **Single combined pane is not parity.**

### 6. Auth-gated buttons surface honest MessageBars

Per `no-vaporware.md` — every action that requires backend env not deployed in this Loom instance MUST show a Fluent MessageBar with `intent="warning"`, the exact env var / bicep module / role grant required.

The Build agent commits with this contract on every PR. The Validate agent enforces it.

## Approval gate criteria (v2 — strict)

The Validate agent assigns ONE grade using the STRICTEST observation:

- **A+** — Phase 3 gap doc has ZERO BLOCKER + ZERO MAJOR rows. Phase 4 has ZERO BROKEN. Loom looks 95%+ like Fabric.
- **A**  — Phase 3 ≤ 2 MINOR. Phase 4 ZERO BROKEN.
- **B**  — Phase 3 ≤ 1 MAJOR + any MINORs. Phase 4 ZERO BROKEN on primary-action buttons.
- **C**  — Phase 3 has BLOCKER(s) (e.g. "no cell editor — uses textarea", "no DAG arrows — just text list"). OR Phase 4 has a BROKEN non-primary control.
- **D**  — Multiple BLOCKERs (e.g. "no Monaco", "no ribbon tabs", "no Explorer panes"). OR primary action BROKEN.
- **F**  — Vaporware: looks like data but isn't, crashes on click, returns 500.

The build phase re-runs only if grade < **B**. **No A unless verified live in a browser.** No exceptions.

**Mandatory checks the v2 Phase 4 runs:**

1. **Monaco + IntelliSense check** for any code/query/text editor: confirm the underlying editor element is Monaco (not a `<textarea>`) by probing for `[class*="monaco-editor"]` or `[data-uri*="inmemory:"]`. Confirm the language mode is set (`monaco-editor[data-language]`). Trigger Ctrl+Space and confirm `[role="listbox"]` completion popup appears. Type a known bad token and confirm `[class*="squiggly-error"]` underline appears. **Fail = BLOCKER.**
2. **Side-by-side ribbon comparison**: count visible ribbon buttons in both. Loom must have ≥ 70% of Fabric's count. **< 70% = MAJOR.**
3. **Pane parity**: every left/right side pane visible in Fabric must be visible in Loom (Data items / Resources / Connections / Outline / Output / etc.). **Missing = MAJOR.**
4. **Status-bar parity**: Fabric editors have a bottom status bar (Connected / AutoSave / Cell N of M / language); Loom must too. **Missing = MINOR.**
5. **Output rendering**: any editor that produces output (Run, Query, Materialize) must render the output inline (table / chart / text). **No rendering = BLOCKER for query editors.**
6. **Auth-gated controls**: any button that requires a backend not deployed in the env must show an honest MessageBar gate (per `no-vaporware.md`). Silently dead buttons = BROKEN.

If ANY of those checks is BLOCKER, the editor cannot get above C.

## Failure handling

- **Catalog phase fails** (e.g. Fabric login failed, Playwright timeout): retry once with a clean browser context. If still failing, mark UI blocked + ask human for MSAL re-auth.
- **Build phase fails** (TypeScript errors, deploy errors): the build agent has access to retry within its own context. If it stops without shipping, the orchestrator notes the failure + moves to next UI.
- **Validate phase fails 3x in a row**: stop, mark UI as `needs-deep-dive`, write a remediation plan to `docs/fiab/parity-specs/<ui>-stuck.md` for human review.

## Why this works better than what I was doing

- **Separation of concerns**: the same agent doing Build can't grade its own work. The Validate agent is fresh + only sees the artifacts, so it can't be talked into accepting partial work.
- **Forced reference capture**: Catalog is read-only and writes specs. The Build agent reads the spec instead of the live UI — eliminates "I'll just hack at this until something renders" pattern.
- **Brutal gate**: 3 iterations before declaring stuck means real issues get surfaced as blockers, not papered over.
- **Parallel-able**: pipelines per UI are independent. Two UIs in parallel ≈ same elapsed time as one.

## What's in this repo for the workflow

| File | Purpose |
|---|---|
| `.claude/workflows/fabric-parity-loop.md` | This doc (the workflow definition) |
| `.claude/commands/fabric-parity-loop.md` | Slash command that invokes the workflow |
| `docs/fiab/fabric-parity-tasks.json` | Seed list of UIs to build, with Fabric URLs + Loom routes + expected features |
| `docs/fiab/parity-specs/` | Generated catalog spec files (one per UI) |
| `docs/fiab/parity-specs/<ui>-needs-rework.md` | Validator output when a UI fails approval gate |
| `docs/fiab/parity-progress.md` | Running log of which UIs passed when |

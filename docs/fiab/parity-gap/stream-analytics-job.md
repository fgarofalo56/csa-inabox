# Parity Gap — Stream Analytics Job (v2 validator, 2026-05-26)

> Editor: `stream-analytics-job` (replaces `usql-job` — ADLA retired)
> Source: `apps/fiab-console/lib/editors/stream-analytics-editor.tsx` (265 lines)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration AND by the deployed Loom revision `loom-console--0000075` not yet containing this editor (the URL `/items/stream-analytics-job/new` returned 404 in Playwright, confirming the slug is in latest source but not in deployed bundle).

## Critical request checks

The request specifically asks several things about this editor — answers from source:

- **"Does the query editor have SAQL syntax highlighting + run state badges + start/stop buttons that actually toggle?"**
  - **SAQL syntax highlighting**: **NO** — query editor is a `<textarea>` (line 215). The editor source ITSELF admits this at line 216: `<Caption1>v3.28: textarea — Monaco + SAQL syntax highlighting + IntelliSense is queued per the parity-loop v2 build contract.</Caption1>` → **BLOCKER**
  - **Run state badges**: **YES** — `jobState` badge (line 184) with `stateColor` mapping (Started=success, Starting/Stopping=warning, Failed/Degraded=danger, else=subtle). Real state pulled from ARM.
  - **Start/Stop buttons that actually toggle**: **YES** — Start (line 187) and Stop (line 188) buttons both wired with `disabled` rules (can't Start a Started job, can't Stop a Stopped one) and call `setState('start')` / `setState('stop')` which POST to `/api/items/stream-analytics-job/[name]/state`. After 3s, auto-reloads detail.

- **"Stream Analytics editor: confirm it renders correctly (replaced usql-job in registry)"**
  - Registry confirmed (registry.ts line 75): `'stream-analytics-job': reg(() => import('./stream-analytics-editor'), 'StreamAnalyticsJobEditor'),` — wired.
  - Catalog confirmed (fabric-item-types.ts line 198): `{ slug: 'stream-analytics-job', displayName: 'Stream Analytics job', restType: 'StreamAnalyticsJob', category: 'Streaming analytics', ...` — wired.
  - **Deployed bundle does NOT have it** — 404 in Playwright. Latest source has it; latest deploy doesn't.

## Phase 1 (Fabric / portal reference)

Portal Azure Stream Analytics blade (`portal.azure.com → Stream Analytics jobs → <job>`):
- Overview, Activity log, Access control, Tags, Diagnose, Locks
- Topology: Inputs / Outputs / Query / Functions
- Configure: Storage account settings / Diagnostic logs / Locks
- Job Topology side rail
- Monitoring: Metrics + Alerts + Streaming Units burnt rate
- Job state pill at top (with Last output event time)
- **Query editor**: Built-in editor with SAQL syntax highlighting, samples inputs preview, test selection, test query, save
- **Start / Stop** buttons in toolbar
- Streaming Units (SU) slider in Scale blade

## Phase 2 (Loom capture)

Source rendering verified by inspection — actual deployed live capture not possible (404 in deployed bundle).

## Phase 3 (gap matrix)

| Fabric / Portal element | Loom | Severity |
|---|---|---|
| Job topology side rail (Inputs / Outputs / Query / Functions) | leftPanel shows ASA jobs list with one Button per job | C-present — different UX, present |
| **SAQL query editor (Monaco + SAQL grammar)** | `<textarea>` | **BLOCKER** ❌ (acknowledged in source caption) |
| **Run state badge** | ✓ `jobState` Badge with color mapping | **A-present** ✓ |
| **Start button** | ✓ wired (`setState('start')`) | **A-present** ✓ |
| **Stop button** | ✓ wired (`setState('stop')`) | **A-present** ✓ |
| Refresh | ✓ wired (`loadList + loadDetail`) | present |
| **Save query** | ✓ wired (`PUT /streamingjobs/{name}/transformations` via `/api/items/stream-analytics-job/[name]/query`) | **A-present** ✓ |
| Test selection (run partial query against sample input) | absent | MAJOR |
| Test query (input sample upload + run) | absent | MAJOR |
| Inputs tab (list + add) | List ✓ (table 3 cols), add absent | C-present |
| Outputs tab (list + add) | List ✓ (table 2 cols), add absent | C-present |
| Functions tab | absent | MAJOR |
| Monitoring tab (metrics graph) | Caption1 lines for State / Last output / SKU / SU | **D-present** — text only, no chart |
| Streaming Units slider | absent | MAJOR |
| Per-input authentication editor | absent | MAJOR |
| Per-output sink configuration (table / SQL / Power BI workspace picker) | absent | MAJOR |
| Storage account binding | absent | MINOR |
| Diagnostic logs | absent | MINOR |
| Activity log | absent | MINOR |
| Alerts | absent | MINOR |
| Job listing (left rail) | ✓ Buttons per job, primary appearance when selected | **B-present** |
| Honest gate when ASA not provisioned | MessageBar with hint (lines 192-200) | **A-present** ✓ |

## Phase 4 (click every button — source-grade)

| Button | Wired? |
|---|---|
| Refresh (toolbar) | ✓ loadList + loadDetail |
| Start | ✓ setState('start') with disabled when already Started |
| Stop | ✓ setState('stop') with disabled when already Stopped |
| Save query | ✓ PUT to query route, disabled when not dirty |
| Job-list buttons (per job) | ✓ setSelected |
| Tab switch (Query / Inputs / Outputs / Monitoring) | ✓ setTab |
| Ribbon "Start" / "Stop" / "Refresh" / "Save" / "Test selection" / "Inputs" / "Outputs" / "Functions" | **dead labels** — ribbon is `RIBBON` constant, no `onClick` |

5 wired buttons, 8 dead ribbon labels.

## Honest grade

- Phase 3: **1 BLOCKER** (textarea), **6 MAJOR** (no test selection, no test query, no functions tab, no monitoring chart, no SU slider, no input/output add forms), several MINOR
- Phase 4: **8 dead ribbon labels** = BROKEN per strict reading. The in-pane action buttons are all wired correctly.

Per parity-validation-standard rubric (strictest grade wins): **C** — Phase 3 has BLOCKER (no Monaco).

## Critical caveat: NOT DEPLOYED

The deployed Loom (`loom-console--0000075`) returns 404 for `/items/stream-analytics-job/new`. The source code shown is in `main` branch and the latest registry update; but the build that the public Loom serves does not contain this editor yet. **A user clicking the catalog tile today will hit 404.** This is itself an A→F downgrade until the next deploy. Recommended action: **deploy** before claiming "Stream Analytics ships replacing usql-job".

## Summary

| Editor | Source-grade | Deployed | Effective grade |
|---|---|---|---|
| stream-analytics-job | **C** | NOT DEPLOYED (404) | **F** for any user opening this today |

The `usql-job` removed → `stream-analytics-job` introduced refactor is correct in source. Deploy required before it lands.

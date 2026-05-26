# Fabric-parity loop — running progress

Live log of the multi-agent `fabric-parity-loop` workflow. Most recent at top.

## 2026-05-26 — Wave 3 catalog launched (12 UIs in 6 parallel agents)

**Wave 3 catalog kicked off** — 6 general-purpose agents running in parallel, each owning 1-3 UIs:

| Agent | UIs |
|---|---|
| `ab63f02fd92b935c8` | dashboard, paginated-report, scorecard |
| `a1402587cb2c6e0d7` | ml-experiment, ml-model |
| `a67c4b66eb7808477` | spark-job-definition, environment |
| `aa402e5fa7f4b0b6f` | graphql-api, user-data-function |
| `a22495e60e0256876` | kql-dashboard, activator |
| `a588b40b0dd792de0` | mirrored-database, dbt-job |

After wave 3 lands: **24 / 85 UIs cataloged**. Then Phase 2 (Build) waves.

**Catalog format change**: switched from read-only `Explore` agents to `general-purpose` agents so they can `Write` spec files directly (no more I-write-back-from-text). Faster end-to-end.

## 2026-05-26 — Wave 2 catalog COMPLETE (12 UIs cataloged total)

**Specs written** to `docs/fiab/<name>-parity-spec.md` for the next 10 Fabric UIs:

| UI | Agent | Status |
|---|---|---|
| eventstream | `a8260c3697beb6c69` | ✓ |
| eventhouse | `a8260c3697beb6c69` | ✓ |
| dataflow | `a30c2872e59523af4` | ✓ |
| copy-job | `a30c2872e59523af4` | ✓ |
| warehouse | `a25d745464518b765` | ✓ (rewritten — agent confused with eventhouse) |
| semantic-model | `a6112853cd6c023e5` | ✓ |
| report | `a6112853cd6c023e5` | ✓ |
| kql-database | `ad6a393dd34fd232c` | ✓ |
| kql-queryset | `ad6a393dd34fd232c` | ✓ |
| data-pipeline | `aff49f5c28912ff78` | ✓ (manually written from agent text; was read-only) |

**Cumulative**: 12/85 UIs cataloged. Notebook + Lakehouse from wave 1, plus the above 10.

## 2026-05-26 — Workflow scaffold + first parallel catalog run

**Workflow infrastructure shipped:**
- `.claude/workflows/fabric-parity-loop.md` — 3-agent pipeline design
- `.claude/commands/fabric-parity-loop.md` — slash command orchestrator
- `docs/fiab/fabric-parity-tasks.json` — 15-UI prioritized task list

**First parallel catalog run** (Phase 1 only, Phase 2 + 3 pending):

| UI | Agent | Status | Output |
|---|---|---|---|
| notebook | `af6f80e466901eecf` (Explore) | ✓ complete | Validated existing `notebook-parity-spec.md`; added 3 ribbon items (AutoML / Pipeline / VS Code), "Ask Copilot" on cell toolbar, execution count badge `[N]` |
| lakehouse | `a4f93461062e0e80c` (Explore) | ✓ complete | New `lakehouse-parity-spec.md` written — auto-paired SQL endpoint pattern confirmed, ribbon (Open notebook / Add to data agent / Manage OneLake security / Update all variables), 6 real bronze tables discovered |

**Build phase queued for next session:**
- `/fabric-parity-loop notebook` → cell-based editor rewrite, language picker, OneLake explorer panel
- `/fabric-parity-loop lakehouse` → auto-paired SQL endpoint + ribbon + data grid + Open-in-notebook flow

**Validate phase** runs immediately after each Build via the `verify-app` subagent.

---

## Known limitations the catalog agents surfaced

1. The Playwright MCP can't reliably navigate Fabric's portaled overlays (modals close before screenshot, kebab menus dismiss on focus loss). Specs are written from snapshot-tree inspection instead of pixel-perfect screenshots.
2. The Explore agent is read-only, so it documents findings in markdown rather than committing screenshots to git. Build agents read the markdown.
3. Fabric workspaces with F-capacity (like casino-fabric-poc F64) have ALL Fabric items enabled; specs derived from there are upper bound. Some items (like AutoML, VS Code integration) may not have full Loom equivalents in v1.

---

## Cumulative Loom shipping log (background)

| Loom v | Released | Key changes |
|---|---|---|
| v3.18 | 2026-05-26 | `/api/cosmos-items` fix for editor hydration bug + tab strip Fabric parity |
| v3.19 | 2026-05-26 | Dataverse-scope tokens route through MSAL Web App SP |
| v3.20 | 2026-05-26 | Power Pages schema fix + Copilot Studio gate + AppUser bootstrap |
| v3.21–22 | 2026-05-26 | `/api/loom/workspaces` + `/api/loom/compute-targets` + 4-editor Fabric→Loom swap |
| v3.23–24 | 2026-05-26 | Async notebook Run dispatch (beats FD 30s timeout) |
| v3.25 | 2026-05-26 | data-pipeline → ADF redirect, dataflow + mirrored to Cosmos, bicep Spark pool |

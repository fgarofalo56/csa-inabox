# Fabric-parity loop — multi-agent build workflow

> Iterative build pipeline for getting CSA Loom editors to true Fabric parity. Each UI runs through Catalog → Build → Validate, loops on fail until the **independent validator** approves. Designed to be invoked once per UI; multiple UIs run in parallel by spawning N agent calls in a single message.

## Why this exists

Earlier sessions exposed a recurring pattern: I'd ship an editor that *renders + calls a backend* and mark it "done", then the user would find that real Fabric UX (cells, hover toolbars, OneLake side panel, language picker, etc.) wasn't there. The smoke harness graded it A; honest UAT said D.

This workflow fixes the gap by forcing **three distinct passes** with a separate validator that doesn't know what the coder built — it only sees Fabric + Loom side-by-side and grades them.

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
        │   │ Phase 3 — VALIDATE (verify-app agent)    │             │
        │   │  • Open Fabric + Loom side-by-side       │             │
        │   │  • Compare every element from spec       │             │
        │   │  • Click every button in Loom            │             │
        │   │  • Brutal honest verdict: A/B/C/D/F      │             │
        │   │  • F-grade output writes to:             │             │
        │   │    docs/fiab/parity-specs/<ui>-          │             │
        │   │    needs-rework.md                       │             │
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
| **Validate** | `verify-app` | Different agent; doesn't see what Build did. Only sees: Fabric live + Loom live + the catalog spec. Brutal honest verdict. |

## Approval gate criteria

The Validate agent grades each UI on these criteria (graded ALL must be A/B):

1. **UX parity** — every element in the catalog spec exists in Loom (titlebar, ribbon, dropdowns, panels, cell types, hover states, status bar)
2. **Behavioral parity** — every button in Loom does what the same button does in Fabric (or surfaces a documented "not configured" gate)
3. **Wired to real Azure** — primary action hits a real deployed backend (Spark Livy / Databricks Jobs / ADF / etc.), not a stub
4. **Infrastructure codified** — any new Azure resource needed has matching bicep + post-deploy bootstrap step
5. **No regressions** — `editors-render-smoke.mjs` still passes 85/85

If ANY of these is below B grade, the build phase is re-invoked with the specific gap list as input.

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

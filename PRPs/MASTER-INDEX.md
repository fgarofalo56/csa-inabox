# PRP Master Index — run order and where things live

Rewritten 2026-11-14 by the PRP audit. The old hand-maintained rows (2026-10-05..29) cited paths that no longer exist and states that had moved
(canvas-docks shipped #5095; LHDS and apigw are on `main`). **Machine truth is `PRPs/INDEX.md`** (generated:
`python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py build --root .`; verify with `check`). Waves, dependency graph and paste-ready kickoff
prompts: [`reference/EXECUTION-PLAN-2026-11.md`](reference/EXECUTION-PLAN-2026-11.md). Shared files and the one-bicep-PR rule: [`reference/INTERLOCK.md`](reference/INTERLOCK.md).

**Repo is public: no secrets or sensitive detail here.** Anything sensitive stays in private GHSA drafts, referenced by id only.

## Programs, in priority order

| # | Program | Where | State (2026-11-14) |
|---|---|---|---|
| 1 | LHDS (health data services) | `active/loom-health-data-services/` | W00 shipped; W01 built, **merged, not deployed**; W01b (deploy + receipts) is the next gate; W13 full-scale test blocked on operator spend approval |
| 2 | API / AI gateway plane (apigw) | `active/loom-api-gateway-plane/` | W00, W01 merged (not deployed); W02..W09 todo; W07 waits for apim WA+WB1 |
| 3 | apim AI gateway (#4442) | `active/apim-ai-gateway/` | Greenlit; 9 wave PRPs; WA+WB1 first |
| 4 | Estate power receipts | `backlog/estate-power-receipts/` | Code merged; live receipts owed |
| 5 | Governance autopilot | `backlog/governance-autopilot/` | W0, W1 merged; W2..W10 split into wave PRPs |
| 6 | Per-workspace Spark identity | `backlog/per-workspace-spark-identity/` | W00 spike next |
| 7 | Loom brain | `backlog/loom-brain/` | Mostly built; ownership (#4255) and scan restore (#4721) first |
| 8 | Snowflake parity | `backlog/snowflake-parity/` | W0 decision record, then W1; later waves stay in the hub table |

## How to run one
1. Fresh session per PRP; the PRP file is the hand-off. 2. Sonnet by default; Opus only where the PRP names a step. 3. No polling.
4. Done = deployed and verified live; until then say "merged, not deployed". 5. Leftovers become GitHub issues, not more conversation.

## Not run from here
`finish-2026-10` (untracked local folder): PRP-01, 03, 04 are done; PRP-05 is the standing drain loop (`tools/drain/tick.py`); PRP-02 was rewritten as
`backlog/estate-power-receipts`. `finishline-retirement` moved to `archive/2026-11-14-finishline-retirement/`. Superseded and abandoned programs
(`drain-*`, `omnibus-*`, `zero-backlog`, `estate-pause-resume`) are under `abandoned/` and `archive/`.

# loom-next-level — DONE ledger

One row per landed item. Updated in the PR that lands the item (or the batch
integration PR). Phase boundaries additionally record the FRESH0 re-baseline
run. Receipts live in the PR bodies; this file is the program-level index.

| Item | PR | Date | Receipt summary |
|------|----|------|-----------------|
| — pre-work — roll gate (deploy-race fix, PRP gotcha) | #2395 | 2026-07-22 | `loom-roll-and-validate` resolves `:latest` → newest BUILT main SHA; accepts superseded-but-verified commits (ancestor-of-main). |
| R0 — bicep param-cap consolidation | (this PR) | 2026-07-22 | admin-plane/main.bicep 256 → 232 params (31 moved into typed bags aasConfig/adxConfig/eventsConfig/functionAppsConfig + 3 reserved bags); shim vars preserve defaults verbatim; warning profile identical to main (103=103); `check-bicep-param-cap.mjs` wired into loom-guardrails (warn 240 / fail 250); what-if A/B vs main identical. |

## Phase 0 remaining

X2 → R30 (serialized), FLAG0, V1, S1, S2, DR0, R1, R7, E1→E2, C1, L1, I1,
MIG1, U0, U10.

## Phase boundaries (FRESH0 runs)

| Boundary | Date | Result |
|----------|------|--------|
| (none yet) | | |

# SLO — Copilot turn latency (PSR-8)

**Status:** active · **Owner:** Platform / Copilot · **Scope:** every Loom
in-product Copilot turn (Azure OpenAI, no Fabric dependency).

The Copilot experience has two latency SLOs. PSR-1 already *measures* both
(`copilot-first-token` / `copilot-full-turn` in `lib/perf/perf-metrics.ts` and
the benchmark runner), and `perf-budgets.json` gates their p95 in CI. This SLO
is the *objective* half — the target a user-facing badge and the tier router's
latency-pressure protection read at runtime.

## Objectives

| SLO | Budget (per turn) | Objective | Source of truth |
|-----|-------------------|-----------|-----------------|
| Streaming first-token | ≤ **5,000 ms** | 95% of turns under budget | `LOOM_COPILOT_SLO_FIRST_TOKEN_MS` (default 5000) — matches `perf-budgets.json` `copilot-first-token` p95 ceiling |
| Full turn | ≤ **30,000 ms** | 95% of turns under budget | `LOOM_COPILOT_SLO_FULL_TURN_MS` (default 30000) — matches `perf-budgets.json` `copilot-full-turn` p95 ceiling |

`LOOM_COPILOT_SLO_OBJECTIVE` (default `0.95`) tunes the attainment objective for
both. Defaults are **default-ON** and deliberately match the CI budget ceilings
so the gate and the runtime SLO never disagree.

## Error budget & burn

For a 95% objective the allowed failure budget is 5% of turns. **Burn** =
(observed breach rate) ÷ (allowed breach rate):

- **burn < 1** — healthy, inside the error budget.
- **burn > 1** — breaching faster than the budget allows.

Burn is computed over a rolling window of the last 100 turns per replica
(`lib/perf/copilot-latency-tracker.ts`), reset with the process — the same
model as the in-process cache tier.

## Enforcement: latency-pressure tier protection

The full-turn burn feeds the AIF-12 model tier router
(`lib/foundry/model-tier-router.ts`, `selectTier` `latencyBurn`). When the SLO
is **breaching** (burn > 1) the router shaves **one tier** off a `general`,
non-overridden turn (standard → mini) so it answers faster and pulls latency
back inside budget. It **never** downshifts a `reasoning`-class turn or an
explicit per-call `overrideTier` — quality-critical work is never sacrificed for
latency. When burn ≤ 1 (or no samples) routing is byte-identical to before.

This is a deterministic, honest control — grounded in
[Azure OpenAI latency guidance](https://learn.microsoft.com/azure/ai-services/openai/how-to/latency)
and SRE error-budget practice — not a silent quality drop.

## Surfaces

- **/admin/performance → Copilot turn-latency SLO card** — live per-SLO
  attainment, budget, met/breaching, and burn (`copilot-slo-card.tsx` over
  `GET /api/admin/performance/copilot-slo`).
- **Per-turn metadata** — the tier the router chose (`routedTier`) and any
  SLO-protection downshift are surfaced on the final orchestrator step (CTS-16).

## Verification

- Unit: `lib/perf/__tests__/copilot-slo.test.ts` (objective evaluation + burn),
  `lib/foundry/__tests__/model-tier-router.test.ts` (latency-pressure downshift),
  `lib/perf/__tests__/copilot-latency-tracker.test.ts` (rolling window + burn).
- CI budget gate: `perf-budgets.json` `copilot-first-token` / `copilot-full-turn`
  via `lib/perf/compare-budgets.ts`.

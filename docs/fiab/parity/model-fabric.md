# model-fabric — Closed-Loop Model Fabric (WS-7 / BTB-6)

Source UI: no direct competitor analog — this is a burn-the-box differentiator.
Closest references: Databricks Mosaic AI Model Serving A/B traffic + Lakehouse
Monitoring, Azure ML online-endpoint traffic mirroring, and progressive-delivery
canary weight-shifting (Azure Well-Architected safe-deployments). Loom fuses the
eval + red-team + serving + SLO signals into ONE automatic promote/demote loop
no single-product competitor ships.

Admin surface: `/admin/model-fabric` → `lib/components/admin/model-fabric-panel.tsx`
Backends: `lib/admin/model-fabric.ts` (pure decider) + `lib/admin/model-fabric-loop.ts`
(signal reader + actuator) over WS-1.1 tier-router, WS-1.2 model-serving, WS-1.4
eval/red-team/SLO, the shared `env-apply` write path, and the Cosmos audit-log.

## Feature inventory → Loom coverage

| Capability | Loom | Backend per control |
|---|---|---|
| Continuous quality signal per model (LLM-judge eval, regression-vs-baseline) | ✅ | `evalSignalsByModel` — cross-partition read of `loom-agent-memory` docType `eval` (WS-1.4), grouped by model |
| Safety signal per deployment (red-team refusal / attack-success) | ✅ | `redTeamSignalsByDeployment` — `ai-red-team` item runs, `summarizeRedTeam` |
| Serving health signal (latency / 5xx) | ✅ | `getServingMetrics` — Azure Monitor `RequestsPerMinute` split by `statusCodeClass` (WS-1.2) |
| Global latency-SLO guard (pause actuation under incident) | ✅ | `recentCopilotSloEvaluations` (WS-1.4 copilot-slo) |
| Composite scoring + rank | ✅ | `compositeScore` (eval + safety − error, renormalized) |
| Auto-promote the live-eval winner (traffic-split) | ✅ | `decideModelFabric` → `setServingTraffic` (WS-1.2 real AML/Databricks traffic-split) |
| Auto-demote a regression / unsafe model | ✅ | `decideModelFabric` (regressed / refusal-floor / attack-ceil → demote) |
| Reasoning-tier promotion (best eval model → strong tier) | ✅ | `runTierPromotion` → `applyEnvChanges(LOOM_AOAI_STRONG_DEPLOYMENT)` (WS-1.1, shared env-apply write path) |
| Hysteresis / anti-flap (cooldown + margin + min-sample) | ✅ | `decideModelFabric` (`cooldownMs`, `marginThreshold`, `minEvalSamples`) |
| Approval mode: Auto-apply vs Propose-only | ✅ | `Switch` → `PUT /api/admin/model-fabric` → `setFabricMode` (Cosmos + audit) |
| Manual "run loop" trigger (on-demand / schedulable) | ✅ | `POST /api/admin/model-fabric/run` → `runModelFabricLoop` |
| Live traffic split + per-deployment signals view | ✅ | `GET /api/admin/model-fabric` (non-actuating dry run) |
| Decision history (promote/demote + why) | ✅ | `model-fabric` Cosmos container `history[]` |
| Every action audited | ✅ | `emitAuditEvent` (SIEM) + `audit-log` Cosmos row per promote/demote |
| Honest gate + Fix-it when serving/reasoning-tier unconfigured | ✅ (⚠️ gate) | `servingConfigGate` (svc-model-serving) + `svc-model-reasoning-tier`, inline "Fix it" → `/admin/gates` |
| Resizable inspector (G3) | ✅ | `SplitPane` `storageKey="model-fabric-endpoints"` |

Zero ❌. Sovereign: AML online endpoints + AOAI + Cosmos only — no Fabric /
Power BI dependency (works Commercial + Gov `*.openai.azure.us` / `*.api.ml.azure.us`).

## Owed (Track-0)
- **Browser-E2E receipt** — a live-eval winner auto-promotes in the traffic-split
  and a regression auto-demotes, captured in a real browser with real data
  (minted-session harness). tsc + vitest (27 tests) + the CI guardrails are green;
  the in-browser receipt is the remaining G1 evidence.

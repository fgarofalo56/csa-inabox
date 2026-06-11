# learning-hub-copilot — parity with an in-product tutorial assistant (Fabric "Help + Copilot" / Azure portal guided tutorials)

Source UI: Microsoft Fabric in-product Copilot + Learn pane (https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview),
Azure portal guided tutorials / "Diagnose and solve problems" (https://learn.microsoft.com/azure/azure-portal/).
Backed entirely by CSA Loom's own Azure-native services — no Microsoft Fabric / Power BI dependency
(see `.claude/rules/no-fabric-dependency.md`). Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Goal

A per-step-aware Help Copilot that (1) knows which tutorial step the user is on, (2) reads the open
item's run / provision receipts to auto-detect why a step failed, and (3) recommends or applies a fix —
recommendations from the receipt's `gate.remediation`, in-editor edits via an approval-gated Keep/Undo diff,
and actions via handoff to the cross-item Copilot at `/copilot`.

## Feature inventory (real source-UI capabilities) → Loom coverage → backend

| Capability (source UI)                                   | Loom coverage | Backend per control |
|----------------------------------------------------------|---------------|---------------------|
| Copilot is aware of the screen / object you're on        | ✅ built (pre-existing `pageContext`) | injected system message in `orchestrateHelp` |
| Copilot is aware of the **tutorial step** you're on      | ✅ built | `pageContext.tutorial` → 3rd system message; `csaloom:tutorial-step` CustomEvent from the LearnPane stepper |
| Step-by-step guided walkthrough with a "help" affordance | ✅ built | `LearnPane` stepper (`item-side-panel.tsx`) — per-step "Help with this step" button, content sourced from `lib/learn/content.ts` (no free-form authoring) |
| Auto-detect errors from run history                      | ✅ built | `readReceipts` tool → `gatherReceipts(source:'runs')` → ADF `listPipelineRuns`/`listActivityRuns` (Azure-native); honest gate via `adfConfigGate()` |
| Auto-detect errors from install/provision state          | ✅ built | `readReceipts(source:'provisioning')` reads Cosmos `state.provisioning` (status / gate.reason / gate.remediation / gate.link / error) |
| Auto-detect from recent activity/audit history           | ✅ built | `readReceipts(source:'audit')` queries `auditLogContainer()` (same query as the audit route) |
| Recommend a fix                                          | ✅ built | the agent leads with the receipt's `gate.remediation`; each receipt becomes a `Citation` |
| Apply an in-editor fix (gated)                           | ✅ built | `proposeFix` tool → `__proposedChange__` sentinel → `proposed_change` step → `CopilotDiff` Keep/Undo → `applyChange(target)` bridge. Targets constrained to `notebook-cell:<id>` / `query-editor:<id>` |
| Apply a fix that needs an ACTION (re-provision / re-run) | ✅ built | existing `handoff` → `/copilot` (the cross-item action orchestrator) — not duplicated here |
| Cite the source the answer reasoned over                 | ✅ built | docs/repo RAG citations (pre-existing) + receipt citations (new) |
| Honest config gate when a backend isn't wired            | ⚠️ honest-gate | `runDiagnostic` (AOAI/Search/Cosmos) + `readReceipts` runs-gate naming the exact missing ADF env var |

Zero ❌. Zero stub banners. Every control calls a real backend or surfaces an honest infra gate.

## Apply-fix safety contract

- The mutation fires **only** on the user's explicit **Keep** in the Monaco diff, **never** automatically
  (mirrors the cross-item Copilot's approval-diff contract; `apply-change.ts`).
- `proposeFix` targets are deterministic keys only (`notebook-cell:` / `query-editor:`) — no free-form,
  user-authored mutation paths (`.claude/rules/loom-no-freeform-config.md`).
- When the owning editor has closed, `applyChange` returns `false` and the widget says so honestly
  rather than pretending the edit applied (`.claude/rules/no-vaporware.md`).

## Per-cloud note (Azure-native default)

Run receipts use the Azure Data Factory monitoring REST (`listPipelineRuns` / `listActivityRuns`) which
the run routes already gate on (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`). The Fabric
pipeline run API is **never** called. Provisioning + audit receipts live in Cosmos and are cloud-agnostic.
AOAI scope resolution goes through the existing `resolveAoaiTarget` → env, honoring `AZURE_CLOUD`.

## bicep + bootstrap sync

No new Azure resource, env var, role assignment, or Cosmos container. `readReceipts` reuses the already
-provisioned `items` + `audit-log` Cosmos containers and the ADF env vars the run routes already require.
The help agent's model deployment resolves through the existing `tenantConfig.helpAgentDeployment` →
`resolveAoaiTarget`. Therefore there is nothing to add to `platform/fiab/bicep/` for this feature.

## Verification

- `npx tsc --noEmit` — clean for all touched files (pre-existing griffel style-token backlog excluded).
- `npx vitest run lib/azure/__tests__/help-receipts.test.ts lib/azure/__tests__/help-copilot.test.ts` —
  32/32 green: receipt shaping over provisioning/audit/ADF runs (incl. honest gate + error surfacing),
  the `readReceipts` tool (remediation gate + run citation + no-scope error), and the `proposeFix` tool
  (sentinel round-trip + deterministic-target rejection).

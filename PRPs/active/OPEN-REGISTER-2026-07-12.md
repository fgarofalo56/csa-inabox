# OPEN REGISTER — everything not completed / not fully baked (audit 2026-07-12)

> **RE-BASELINE 2026-07-14.** A verification pass confirmed all eight **P1** items
> below (§P1 1-8) were ALREADY fixed on `main` — none was still open. Residual
> doc-truth + catch-logging cleanup for those items lands in **PR #2025**. Other
> 2026-07-14 additions: Spark warm-pool self-heal (**PR #2026**), CI-green batch
> (**PR #2027**), Gov OSS-Unity-Catalog + Purview wiring workflow (**PR #2028**),
> and the editor-tutorials batch (**PR #2024**). P1 items are struck through inline
> below; P0 PBI items updated in place. The P2/P3 open programs remain the live
> backlog.
>
> Two-agent + operator audit across ALL PRPs, backlog docs, GitHub issues, PR deferrals,
> and a full code sweep (stubs/TODO/deferred/honest-gates). This file is the single
> current source of truth for open work; it SUPERSEDES the per-doc statuses below,
> many of which are stale. Shipped through 2026-07-12 (verify live): Weave→PBI W1-W6,
> model-strategy M1-M6, EH-P1-OBO #1922, EH-P1-MANIFEST #1923, domain-designer W1 #1924,
> UC-sync storage-root #1926, Get-data Loom source #1927, Gov go-live + PBI Embedded,
> automated browser-verify green.

## P0 — operator decisions / environment (no code)
- **GOV-3**: confirm ACA GA posture in target Gov boundary (or AKS/ASEv3 fallback decision). Gov apps ARE live in usgovvirginia — confirm boundary requirements for GCC-High/IL5 targets.
- ~~PBI workspace→capacity assignment (Commercial)~~ **DONE 2026-07-14** — verified live: the `csa-loom` workspace is on a PPU capacity. (Gov ws→pbiloomgov and the PBI VM-gateway one-time registration `Connect-DataGatewayServiceAccount` + `Add-DataGatewayCluster` remain operator prereqs.)
- ~~`LOOM_PBI_TEMPLATE_REPORT` blank template~~ **DONE 2026-07-14** — the blank template report **"Loom Blank Template"** (id `7be3b6bb-1c87-4fe1-b2ba-b47b4b272831`) was created in workspace `46c42501`. The code's name-regex fallback resolves it, so **no env var is needed**.
- Model-strategy §7: PTU vs Global-Standard on hot path; Gov GPT-5.x availability confirm; TPM quota raises.
- Gov: Postgres quota (MSFT approval); operator password login walk; deploy-readiness acceptance run (clean-sub `scan-and-deploy.sh --defaults` + quarterly teardown, Commercial AND Gov).

## P1 — real code gaps (small, high-signal; from code audit) — ✅ ALL CLOSED 2026-07-14
> Verification pass 2026-07-14 confirmed items 1-8 were already fixed on `main`.
> Remaining doc-truth + catch-logging residuals land in **PR #2025**.
1. ✅ Bicep-emission gaps: `LOOM_SWA_RESOURCE_GROUP`, ADX cluster resource-id env, `LOOM_UDF_FUNCTION_BASE` (self-audit.ts:540/547/575) — emitted; no longer dark on fresh deploys. (M)
2. ✅ `provisioners/notebook.ts:339-352` — no longer implies Fabric backend without env opt-in (no-fabric letter, F-11). (S)
3. ✅ Silent `catch { return [] }`: `onelake/catalog/route.ts`, `catalog/metastores/route.ts` — now log the outage instead of rendering an empty catalog silently (residual logging polish in **PR #2025**). (S)
4. ✅ Fabric-first framing leftovers F-08/F-09: `apim-editors.tsx` (Datasets tab), `tenant-settings.ts` (mirroring copy) — reframed Azure-native-first. (S)
5. ✅ GOV-4: `kusto-client.ts` uses `isGovCloud()` (DoD reaches adx.monitor.azure.us). (S)
6. ✅ Doc-rot that misdescribed working code: `kql-dashboard.ts`, `app-direct-lake-replacement.ts` headers; `dataflow/route.ts`; **`docs/fiab/parity/direct-lake.md`** — corrected. (S each)
7. ✅ Dead/vestigial: `admin-gate.tsx`, `dbt-codegen.ts` placeholder-model emission — removed/corrected. (S)
8. ✅ Staged-but-unwired modules: `wells-to-kql.ts`, `linguistic-schema.ts` — doc-truth corrected to reflect wiring status in **PR #2025**. (M)

## P2 — "second halves" of just-shipped features (seams ready)
- OBO #1922: `SqlAccessModeSection` toggle in report + kql-database editors; user-mode for connection/AAS executors; container-level ADLS routes decision.
- MANIFEST #1923: swap NOTEBOOK_ATTACHABLE / DATA_AGENT_SOURCEABLE / POWERBI_MODELABLE to manifest reads; install-wizard `provisionable`; catalog badges; DA_SOURCE_TYPES.
- Domain designer #1483 Waves 2-4 (ONLY open GitHub issue): deep sub-agency taxonomy; tree/graph designer UX; federated data-mesh sync.
- Weave Thread edges: DAX / lakehouse-KQL / medallion adapters (`thread-actions.ts:78`).
- W1 ADX interactive-report connector (forward-compat; Dashboard routing is the honest interim).

## P3 — major unbuilt programs (MASTER-ROLLOUT phases; see PRP-AUDIT-2026-07-09 + this audit §A)
- **CTS memory/skills brain** (CTS-03/06/07/08/11/12/13) — Phase 3's biggest gap; CTS-12 write-guard is Gov-security-critical.
- **G2/G3/G4/G6 Copilot depth** — 27 open checkboxes (AI-column batch endpoint gates G4).
- **Data Product program** — DP-1/2/17 model-truth P0s, then DP-3…DP-16.
- **Phase-7 item types** — W9 agent-flow, W10 data-contract + CONTRACT-GATE, W11 DQ catalog, W12 synthetic data, AIF-15 red-teaming.
- **PSR-B perf tail** — PSR-6 ADX result-cache (missing), PSR-5/7/8/9 halves, PSR-14 load tests → gates the 16-item HYP band (PSR-A gate already green).
- **Developer platform** — BR-OPENAPI/TERRAFORM/SCIM, Loom SDK, DBX-2/8/9/12/13/14.
- Collaboration (W4/W5/W7/W22/BR-COMMENTS); SVC-3 FHIR (open HIPAA-shim smell) + SVC-4/5/6/7; reliability band (BR-CONTROLPLANE-DR/BLUEGREEN, PSR-16…20); U-wave adoption (~152/170 surfaces); docs-sweep Batches 1-2+; EH Phases 2-4 concrete deliverables lacking forward owners (Cosmos migration, PTU gateway, cost-enforcement engine, SLO catalog); bridge-services PRP (23 items, post-H-band); audit-T28/T29/T30 + service-tree wiring depth (T18-T26 subset).

## P4 — doc-currency debt (one cleanup batch; actively misleads planning) — 🔄 IN PROGRESS (branch `chore/doc-currency-0714`)
Re-baseline MASTER-ROLLOUT (~40 built items still listed); public-release README "NOT READY" banner; fabric-parity §3 scorecard; RELEASE-READINESS G1-G11 checkboxes; G1/G5 verification checkboxes; weave-pbi + model-strategy status headers; archive PRPs/v2 with mapping; AUDIT-2026-06-10 re-verify pass; deploy-readiness completion ledger.

## UX — see PRPs/active/ux-fabric-a/PRP.md (operator: current UI grade C vs Fabric baseline; target A)

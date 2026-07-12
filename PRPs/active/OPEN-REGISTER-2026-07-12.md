# OPEN REGISTER — everything not completed / not fully baked (audit 2026-07-12)

> Two-agent + operator audit across ALL PRPs, backlog docs, GitHub issues, PR deferrals,
> and a full code sweep (stubs/TODO/deferred/honest-gates). This file is the single
> current source of truth for open work; it SUPERSEDES the per-doc statuses below,
> many of which are stale. Shipped through 2026-07-12 (verify live): Weave→PBI W1-W6,
> model-strategy M1-M6, EH-P1-OBO #1922, EH-P1-MANIFEST #1923, domain-designer W1 #1924,
> UC-sync storage-root #1926, Get-data Loom source #1927, Gov go-live + PBI Embedded,
> automated browser-verify green.

## P0 — operator decisions / environment (no code)
- **GOV-3**: confirm ACA GA posture in target Gov boundary (or AKS/ASEv3 fallback decision). Gov apps ARE live in usgovvirginia — confirm boundary requirements for GCC-High/IL5 targets.
- PBI workspace→capacity assignment (Commercial ws→existing capacity if desired; Gov ws→pbiloomgov). PBI VM-gateway one-time registration (`Connect-DataGatewayServiceAccount` + `Add-DataGatewayCluster`). `LOOM_PBI_TEMPLATE_REPORT` blank template.
- Model-strategy §7: PTU vs Global-Standard on hot path; Gov GPT-5.x availability confirm; TPM quota raises.
- Gov: Postgres quota (MSFT approval); operator password login walk; deploy-readiness acceptance run (clean-sub `scan-and-deploy.sh --defaults` + quarterly teardown, Commercial AND Gov).

## P1 — real code gaps (small, high-signal; from code audit)
1. Bicep-emission gaps: `LOOM_SWA_RESOURCE_GROUP`, ADX cluster resource-id env, `LOOM_UDF_FUNCTION_BASE` (self-audit.ts:540/547/575) — dark on fresh deploys. (M)
2. `provisioners/notebook.ts:339-352` — bound-Fabric-ws implies Fabric backend without env opt-in (no-fabric letter violation, F-11). (S)
3. Silent `catch { return [] }`: `onelake/catalog/route.ts:336`, `catalog/metastores/route.ts:96` — outage renders empty catalog. (S)
4. Fabric-first framing leftovers F-08/F-09: `apim-editors.tsx:3184` (Datasets tab leads OneLake), `tenant-settings.ts:146` (mirroring copy). (S)
5. GOV-4: `kusto-client.ts:150` uses `AZURE_CLOUD==='AzureUSGovernment'` not `isGovCloud()` (DoD misses adx.monitor.azure.us). (S)
6. Doc-rot that misdescribes working code: `kql-dashboard.ts:28`, `app-direct-lake-replacement.ts:28-63` headers; `dataflow/route.ts:8`; **`docs/fiab/parity/direct-lake.md`** (claims shipped T4-T6 missing). (S each)
7. Dead/vestigial: `admin-gate.tsx` (0 usages), `dbt-codegen.ts:188` placeholder-model emission. (S)
8. Staged-but-unwired modules: `wells-to-kql.ts`, `linguistic-schema.ts` (built + tested, no consumer). (M)

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

## P4 — doc-currency debt (one cleanup batch; actively misleads planning)
Re-baseline MASTER-ROLLOUT (~40 built items still listed); public-release README "NOT READY" banner; fabric-parity §3 scorecard; RELEASE-READINESS G1-G11 checkboxes; G1/G5 verification checkboxes; weave-pbi + model-strategy status headers; archive PRPs/v2 with mapping; AUDIT-2026-06-10 re-verify pass; deploy-readiness completion ledger.

## UX — see PRPs/active/ux-fabric-a/PRP.md (operator: current UI grade C vs Fabric baseline; target A)

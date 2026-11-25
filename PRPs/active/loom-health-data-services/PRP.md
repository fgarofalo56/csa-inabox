---
name: loom-health-data-services
status: active
allow_parallel: true
priority: P1
order: 1
depends_on: []
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
started: 2026-10-24
---
# PRP: Loom Health Data Services (LHDS) — program hub

**Status (2026-11-25): ACTIVE.** **Update 2026-11-25 later: A7, the RS256 id_token key (#5478, `3dcd21f0f`), is DEPLOYED on Commercial dev01. Its id_token receipt waits for the headed sign-in.**
- Live (05:40Z, after an ACR build and a restart of revision `loom-health-cp--0000030`): on 3 of 3 reads, the public JWKS serves the unchanged EC/ES384 key plus an RSA/RS256 key (3072 bits, no private members), and the tenant openid-configuration lists `RS256`. The baseline before the roll was `ES384` with the EC key only.
- ARM read-back: `lhds-as-idtoken-rs256` is `RSA-HSM`, non-exportable and sign/verify only. The CP created it itself at 05:40:13Z (runtime get-or-create, no bicep).
- NOT yet verified: a real id_token checked against the JWKS. id_tokens come only from user grants, so that receipt is the headed sign-in item.
- Measured during review: OPA 1.9.0 `verify_es384` still passes against the mixed JWKS. Follow-ups #5479.

**Update 2026-11-25: W1b-3a PR4 (#5469, the Apps tab) is DEPLOYED and VERIFIED on Commercial; all four W1b-3a PRs are now live.**
- The console roll had been refused since `0f27ffc40` (R1): `vitest (node 20)` was red on main. A non-hermetic test was fixed in #5474 (`9a7db052b`); the flake is #5475. Roll run 45530832458 succeeded, and Commercial and Gov both run `9a7db052`.
- G1 walk of the Apps tab passed: register, disable/enable, edit launch URL, launch without a patient, the not-permitted search state, and 768 px. Record: #5454 comment 7150939773. Defects: #5476 (R7 "tenant not found" while the tenant is `creating`; launch-dialog alignment).
- #5467 (sidebar collapse, #5468) passed its G1 walk and is closed.
- The Demo health-tenant item self-healed into tenant `demo-loom-hea-ab3844` on dev01 when it was opened (#5453 live). Operator decision 2026-11-25: keep it for the sign-in and Inferno items.
- Next, each a fresh session: the FHIR edge (bicep slot), then the headed sign-in (which also closes the A7 id_token receipt), then Inferno. RS256 is done (A7, above). #4972 (`full-app-deploy-commercial`, no success for 42 days) is a separate R1 item for its own session.

**Update 2026-11-24 evening: W1b-3a (#5454), the SMART AS features Inferno needs, is built as 4 PRs, all merged.**
- PR1-3 (#5461, #5462, #5464) are DEPLOYED and VERIFIED on Commercial dev01. Receipt: admin-contract probe 45484434459, 23/23.
- PR4 (#5469, the console Apps tab) is merged and its CP part is rolled. Its console roll and G1 walk are pending.
- The gap map against the Inferno kit (W01b, W1b-3a spec) found 9 gaps, not 4.
- W1b-3 (the Inferno run) is still BLOCKED, on three things: the FHIR edge, the RS256 key and an interactive sign-in receipt.
- **Operator decisions, late 2026-11-24:**
  - The FHIR edge now **jumps the bicep queue** ahead of apim-WA.
  - The RS256 key is a **go**.
  - Inferno runs on a **Proxmox VM, headed**.
  - The edge and the RS256 key are each a fresh session (W01b, W1b-3a spec).

**Earlier 2026-11-24: three non-bicep lanes are DEPLOYED and VERIFIED on Commercial dev01.**
- #5453 + #5457 (#5442): a new health tenant now auto-binds its FHIR engine (tenant.create chains fhir-tenant.create), and destroy tears the engine down. Engine-affecting jobs are serialized per tenant.
- #5452 (#5441): a NetworkPolicy beside each engine.
- #5451 (#5396): the whole CP vitest suite runs in CI.
- Receipts: CRUD probe 45319268679 7/7 and G1 45319272128 6/6. ARM shows 0 leftover tenant resources.
- W1b-3 Inferno is BLOCKED on #5454: the AS lacks the patient picker, the EHR launcher, FHIR-base discovery and public-client auth. Operator decision: spec these first, in a fresh session.
- New follow-ups: #5456 (console tsc) and #5458 (cross-replica job exclusion).
- GCC-High is not exercised (#5123).

**Update 2026-11-23: W2-2b B3 is DEPLOYED and VERIFIED on Commercial dev01. Tenant FHIR create, read and cross-tenant/scope denial pass live (CRUD probe 45264235830, 7/7) after six live-only fixes, #5444-#5449. GCC-High is not exercised (#5123). The bicep slot W2-2b held returns to apim-WA (operator queue order 2026-11-16); W3-2 still waits behind apim-WA/WB1.** **Update 2026-11-22: W2-2b jumped the bicep slot (#5422). B1, the stamp PDP, is DEPLOYED and VERIFIED on Commercial dev01 (deploy-health 45071967067): delivery through ARM runCommand, a CP-signed bundle through Front Door, and images through a stamp private endpoint to the hub ACR. Next: B2 (HAPI + Entra PostgreSQL) in a fresh session.** **Update 2026-11-21: W1b-2 rebuilt (#5410). The APIM edge had never been deployed and the stamp-FQDN issuer answered 502. The issuer is now served through the existing Front Door on `/auth/*` and token minting passes live (deploy-health 44947837477, mint-only 44946666808). Next: Inferno; the APIM edge (L3) waits behind apim-WA.** **Update 2026-11-20 evening: W1b-4 G1 passes all 5 steps live (run 44834983661; #5402 + #5403 deployed; #5392 and #5399 closed). Next: #5405 leaked-tenant destroy tool, edge probe, Inferno.** W00 merged. W01 merged. W01b in progress on Commercial: stamp TLS and the G1 grant seed are deployed and verified live (2026-11-18/19), and the W1b-1 BFF receipt passed (2026-11-19). The W1b-4 G1 walk now passes steps 1-3 live (2026-11-20, run 44753035218): a synthetic tenant is created, bound and read back on Commercial dev01. Step 4 fails on a 348 px narrow-width overflow (#5399), and destroy ends `shred_unverified` (#5392). The edge probe and Inferno have not been run. W02a: W2-1, W2-3 (+ follow-ups #5337), W2-5 and W2-2a (#5338, the non-bicep half of W2-2) merged, not deployed. W03a: W3-1 (+ hardening #5335) and W3-3 (#5336) merged, not deployed. The bicep halves W2-2b and W3-2 wait for the global bicep slot (apim-WA and apim-WB1 are ahead; operator kept queue order 2026-11-16). Operator decision 2026-11-16: FHIR audit fails closed before real PHI (#5339). (Status line updated 2026-11-17.) W13 (class-M characterisation) is blocked on an operator spend approval that has not been given.

| Field | Value |
|---|---|
| Created | 2026-10-22 |
| Decision source | Operator mandate 2026-10-22 (`README.md`), decisions in `OPERATOR-DECISIONS-2026-10-22.md`, spend decision 2026-11-14 (section 7) |
| Related rules | every file in `.claude/rules/` (section 6) |
| Related programs | `governance-autopilot`, `per-workspace-spark-identity`, `apim-ai-gateway` / `loom-api-gateway-plane` (bicep collision rule), PRP-02 estate power (pause contract) |
| Boundaries | Commercial, GCC-High (receipts); IL5, DoD supported-in-code, never exercised; GCC supported-in-code only, never exercised |

Evidence convention: repo claims carry a path + symbol, measured on `origin/main`; external claims carry a URL in `research/` with the retrieval date; anything not read in full is **UNVERIFIED**. This hub holds order and state only. Each wave file holds its own 16 sections. Shared design context lives in `ARCHITECTURE.md`, `TEST-STRATEGY.md`, `CAPACITY-MODEL.md`, `OPERATIONS-AND-BCDR.md` and the ADRs, linked and never repeated.

## Goal
A from-scratch, Azure-native health data platform (FHIR R4, DICOMweb, terminology, conversion, bulk export, de-identification, lakehouse sink) with no dependency on Azure Health Data Services or Fabric, the same capabilities in Commercial and GCC-High (`cloud-parity.md`), scaled by stamps (`CAPACITY-MODEL.md`), with provable tenant isolation, A-grade Loom surfaces and a never-a-certification evidence pack. Full goals G1-G6: `PRD.md`.

## Why
Operator mandate 2026-10-22: AHDS is not available in Azure Government; Loom Gov and Loom Commercial need the same health capabilities up to all-VA / all-IHS scale.

## Scope / Non-goals
Scope: the waves in section 1. Non-goals: `PRD.md` section 4. Out of scope until a fresh operator approval: full-scale (class-M, 1 M and 10 M patient) characterisation, which is W13 alone.

## Acceptance criteria
- [ ] Every wave file merged AND deployed-and-verified per cloud with a run id (`deploy-integrity.md` R2). Fails if any wave row in section 3 reads "merged" while its receipt line says "not deployed".
- [ ] `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root <repo>` exits 0. Fails on any wave file whose frontmatter `depends_on` names a stem that has no file.
- [ ] The W12 evidence pack exists per cloud; no page claims certification or authorization (needle scan is a guard; review is the check).
- [ ] W13 is either approved by the operator and done, or still blocked with its `blocked_by` text intact. It never runs by default.

## Read first
`README.md`, `ARCHITECTURE.md` section 6 (per-cloud table), `TEST-STRATEGY.md` section 9 (per-wave receipts), `RISKS-AND-OPEN-DECISIONS.md`, `W0-RECEIPT.md` section 8 (W0 pass bars carried forward), `PRPs/reference/INTERLOCK.md` (bicep ledger, written by the orchestrator; may not exist yet).

## Owns
`PRP.md`, `README.md`, `RISKS-AND-OPEN-DECISIONS.md`, and the wave files `W06a` .. `W13` of this directory. Lane A owns `W00`..`W05`, `W01b`, `CONTRACT-FREEZE-W2.md`.

## Must NOT touch
`PRPs/INDEX.md`, `PRPs/MASTER-INDEX.md`, `PRPs/REGISTER.md` (orchestrator-owned); the other lane's wave files.

## Consumes
Operator decisions (`OPERATOR-DECISIONS-2026-10-22.md`), the ADR set (`adr/ADR-001`..`ADR-018`), `.claude/rules/*.md`.

## Provides
The wave order, dependency graph, concurrency map and open-decision register that every wave session reads first.

## Steps
1. Open a fresh session per wave file, in the order of section 2. 2. Work only inside the file's Owns list. 3. Update the file's Execution state and section 3 of this hub in the wave's closing PR. 4. Anything merged but not rolled is reported as "merged, not deployed".

## Validation
`python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root E:/Repos/GitHub/csa-inabox` (exit 0). Per-wave receipts: the wave file's own Validation section. Common rules for every wave file are in section 5.

## Rollback
Per wave file; globally `healthEnabled=false` in `platform/fiab/bicep/health-params/*-health.bicepparam` stops new deploys; data stores are never deleted on rollback (crypto-shred is an explicit, confirmed offboarding job).

## Docs to update
`docs/fiab/health/**` per wave; the per-cloud table in `ARCHITECTURE.md` section 6 with run ids; this hub's section 3.

## Wave / Blocked-by / Branch / Worktree
Hub: `Wave: all · Blocked-by: none · Branch: docs/lhds-<topic> per docs PR · Worktree: E:/Repos/_lhds-hub`

## Hot files
This directory's docs only. `touches_bicep: no`.

## Kickoff prompt
```
You are working on the LHDS program (E:/Repos/GitHub/csa-inabox, PRPs/active/loom-health-data-services/).
Read PRP.md (this hub), then the wave file you were assigned, then the ADRs and docs it names.
Stay inside the wave file's Owns list. Fresh worktree per the file's Wave/Branch line.
Done = the wave file's Validation commands pass AND receipts per cloud; merged-not-deployed is reported in those words.
Prove with: python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```

## 1. Waves

Wave number = execution tier, not the file stem. Files in the same tier with different files owned may run at the same time, subject to the bicep rule. Order values are this lane's assignment. > ASSUMPTION: lane A uses orders 1-9 for W00..W05; if lane A differs, the orchestrator renumbers. Branch convention `feat/lhds-<stem lowercased>`; lane A's file wins where it names a different branch.

| Name | Order | depends_on | Wave no. | Concurrent with | Bicep? | Branch |
|---|---|---|---|---|---|---|
| W00-measurement-spike | 1 | [] | 0 | none | no | shipped (lane A file) |
| W01-control-plane-identity-stamp | 2 | [W00-measurement-spike] | 1 | W01b | yes | main (in progress) |
| W01b-close-deploy-receipts | 3 | [W00-measurement-spike] | 1 | W01 tail | see file | feat/lhds-w1b-close-receipts |
| W02a-fhir-core-build | 4 | [W01b-close-deploy-receipts] | 2 | W03a, W10 | see file | feat/lhds-w2a-fhir-build |
| W03a-dicom-core-a | 6 | [W01b-close-deploy-receipts] | 2 | W02a, W10 | see file | feat/lhds-w3a-dicom-core |
| W04-terminology | 8 | [W02a-fhir-core-build, W02b-fhir-core-ops] | 4 | W03b, W05 (health.ts appenders) | see file | feat/lhds-w4-terminology |
| W10-device-ingest | 14 | [W01b-close-deploy-receipts, W05-conversion-hl7v2-ccda] | 5 | W06a, W07, W08a | yes (tenant.bicep) | feat/lhds-w10-device-ingest |
| W02b-fhir-core-ops | 5 | [W02a-fhir-core-build] | 3 | none | see file | feat/lhds-w2b-fhir-ops |
| W03b-dicom-core-b | 7 | [W03a-dicom-core-a, W02b-fhir-core-ops] | 4 | W04, W05 (health.ts appenders) | see file | feat/lhds-w3b-dicom-ops |
| W05-conversion-hl7v2-ccda | 9 | [W02a-fhir-core-build, W02b-fhir-core-ops] (soft: W04 for enrichment acceptance) | 4 | W03b, W04 (health.ts appenders) | see file | feat/lhds-w5-conversion |
| W06a-bulk-export-import | 20 | [W02b-fhir-core-ops, W03b-dicom-core-b] | 5 | W07, W08a, W10 | no | feat/lhds-w06a-bulk-export-import |
| W07-search-performance-at-scale | 23 | [W02b-fhir-core-ops, W03b-dicom-core-b] | 5 | W06a, W08a, W10 | yes (ingress.bicep) | feat/lhds-w07-search-performance |
| W08a-labels-pdp | 24 | [W02b-fhir-core-ops, W03b-dicom-core-b, W04-terminology] | 5 | W06a, W07, W10 | no | feat/lhds-w08a-labels-pdp |
| W06b-deid | 21 | [W06a-bulk-export-import] | 6 | W06c, W08b | yes (engines.bicep) | feat/lhds-w06b-deid |
| W06c-lakehouse-sink | 22 | [W06a-bulk-export-import] | 6 | W06b, W08b | yes (engines.bicep) | feat/lhds-w06c-lakehouse-sink |
| W08b-breakglass-audit-siem | 25 | [W08a-labels-pdp] | 6 | W06b, W06c | yes (stamp.bicep) | feat/lhds-w08b-breakglass-audit |
| W09a-viewer-copilot | 26 | [W02b-fhir-core-ops, W03b-dicom-core-b, W06a-bulk-export-import, W06b-deid] | 7 | W11a | no | feat/lhds-w09a-viewer-copilot |
| W09b-editors-admin | 27 | [W04-terminology, W05-conversion-hl7v2-ccda, W06c-lakehouse-sink, W08b-breakglass-audit-siem, W09a-viewer-copilot, W10-device-ingest] | 8 | none | no | feat/lhds-w09b-editors-admin |
| W11a-chaos-dr | 28 | [W02b-fhir-core-ops, W03b-dicom-core-b] | 6 | W06b, W06c, W08b | no | feat/lhds-w11a-chaos-dr |
| W11b-hardening-bicep | 29 | [W11a-chaos-dr, W09b-editors-admin, W07-search-performance-at-scale] | 9 | none | yes (stamp.bicep) | feat/lhds-w11b-hardening-bicep |
| W12-compliance-evidence-pack | 30 | [W11b-hardening-bicep, W08b-breakglass-audit-siem, W09b-editors-admin] | 10 | none | no | feat/lhds-w12-evidence-pack |
| W13-class-m-characterisation | 99 | [W12-compliance-evidence-pack, W07-search-performance-at-scale] | 11 | none | yes (sandbox params) | feat/lhds-w13-class-m (blocked) |

## 2. Dependency graph, repairs and concurrency map

```
W00 > W01 / W01b > { W02a, W03a } concurrent
W02a > W02b ; W03a + W02b > W03b ; { W02a + W02b } > { W04, W05 }
W05 > W10 (W10 also needs W01b)
{ W02b + W03b } > { W06a, W07 } concurrent ; { W02b + W03b + W04 } > W08a
W06a > { W06b, W06c } ; W08a > W08b
W06a + W06b (+W02b, W03b) > W09a > W09b (also needs W04, W05, W06c, W08b, W10)
{ W02b + W03b } > W11a > W11b (also needs W07, W09b) ; { W11b + W08b + W09b } > W12 > W13 (blocked)
```

**Dependency repairs recorded 2026-11-14.** The previous graph chained waves that do not share data. The repairs, each checked against the old per-item `Depends on` columns:
- **W4 to W5 is a soft edge only (lane A's W05 file agrees).** W5-1 (converter), W5-4 (VistA/RPMS specs) and W5-5 (fixtures) need nothing from W4. Only W5-2's `$translate` enrich step needs W4-2. Lane A encodes that on the item, not the wave.
- **W7 to W10 is false.** W10 needs the FHIR write path (W2) and the Event Hubs eventing already in `platform/fiab/bicep/modules/health/eventing.bicep` (W1). Nothing in W10 reads a W7 output. > ASSUMPTION: W10's live Observation receipt needs a deployed W02a FHIR image; its code and fixture items do not, so W10 starts at the same tier as W02a and its live-verify item waits for W02a to be deployed.
- **W9's real data deps are W2/W3.** The viewer (W9-1) needs the DICOM viewer smoke from W3 (old W3-7), not W5 or W8. Copilot write tools (W9-4) need W6 export and de-id. The editor A-grade pass (W9-2) needs W4, W5 and W6 editors to exist. The old W8 edge into W9 is dropped: audit tabs are W08b's own surfaces.
- **W11 does not need W9.** Chaos, restore, evacuation and failover exercise W2/W3 stamps. Only W11-7's admin-page panels need the page W09b builds, so that edit is a serialized integration step.
- **W6 to W7 and W6 to W8 are dropped.** W7 and W8a need W2 + W3 (and W4 for labels), not W6.

**Concurrency map.**
- After W01b: W02a and W03a may run at once; they own different files. W10 moved to wave 5 (2026-11-14 pass 2): it edits `conversion-editor.tsx` and the conversion parity doc that W05 owns, so it depends on W05. W04 and W05 follow W02a and W02b (W02b owns the shared `lib/catalog/item-types/health.ts` and `lib/copilot/health-tools.ts`; later waves append as serialized integration steps) (lane A's files encode that, so W04 cannot run beside W02a as first suggested). Code work may start before W01b's live receipts exist; only live verification waits. Their bicep PRs serialize behind the single bicep ledger (section 5).
- W06a, W07, W08a and W10 (wave 5) may run at once; W06a and W07 start after W02b + W03b, W08a also needs W04. W06b, W06c and W08b start in the next tier.
- W09a, W09b, W11b and W12 are serial near the end (W11a runs beside W09a): they converge on `apps/fiab-console/lib/editors/health/**`, `lib/copilot/health-tools.ts` and the admin page, and W11b/W08b hold bicep slots. W09a and W11a have no shared files and may overlap.
- WIP <= 4 lanes at any time; ONE bicep-touching PR in flight across every program.

## 3. Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00-measurement-spike | merged | docs/lhds-w0-7-decision | sonnet | W0-7 #5118; DEV proof #5107; pass bars carried to W13 | 2026-11-14 |
| W01-control-plane-identity-stamp | in-progress | main | sonnet | W1 items merged, not deployed (#5122..#5287); detail in W01 file | 2026-11-14 |
| W01b-close-deploy-receipts | in-progress | feat/lhds-w1b-close-receipts | sonnet | 2026-11-16: loom-ui-verify fixed (#5318/#5319, green on main). G1 spec + destroy-on-delete DEPLOYED (#5321/#5323). CI-SP CP admin (#5320) and automation grant seed (#5327) merged, not deployed. 2026-11-17: deploy-health failed 2/2 (a deploymentScript cannot run under the MCAPS shared-key-off policy); #5355 (`99da651a9`) replaces it with control-plane-issued KV TLS, merged, not deployed (#5345, follow-ups #5356). 2026-11-18/19 LIVE on Commercial dev01: stamp TLS deployed + verified (#5361, deploy-health 44254176000, #5345); grant seed works (#5363 + #5367 targeted apply, bootstrap 44428712082, #5360); console health binding made durable across scheduled deploys (#5369 `d5fd4cf11`, merged, not yet observed through a scheduled run). G1 then stopped at a BFF→CP 502 (#5370), which is now fixed live and closed. 2026-11-19/20: W1b-1 receipt passed (deployed and verified). #5377 is fixed live (the stamp self-registers). #5381, #5383, #5384 and #5386 are deployed. 2026-11-20 later: #5395 (tenant.bicep dependsOn), #5394 (edge-403 retry; the 403 is a Microsoft edge page), #5397 (G1 finalise) and #5398 (destroy retain + crypto-shred, operator decision) are DEPLOYED. G1 run 44753035218 passes steps 1-3 (create + bind + readback live). NEXT: #5392 shred read-back poll → #5399 narrow overflow → G1 all 5 steps → re-destroy the 2 leaked synthetic tenants → edge probe → Inferno. W1b-5 Gov is blocked (#5123; the grant-seed Gov runner gap #5364 folds into it). 2026-11-21: W1b-2 rebuilt, issuer via Front Door + token mint DEPLOYED and VERIFIED (#5412/#5413/#5416/#5419; deploy-health 44947837477, mint-only 44946666808); APIM edge wiring (L3) waits behind apim-WA (#5410). Detail in the W01b file. | 2026-11-21 |
| W02a-fhir-core-build | in-progress | | sonnet | W2-1 #5290, W2-3 #5310 + #5337, W2-5 #5312, W2-2a #5338 merged, not deployed.
W2-2b holds the bicep slot (jumped apim-WA 2026-11-21, #5422). Its B1, the stamp PDP, is DEPLOYED and VERIFIED on Commercial dev01 (deploy-health 45071967067: the PDP rolled out with the CP-signed bundle). B2 (#5434, #5436, #5435, #5438, #5437; decisions 9-11) and B3 are DEPLOYED and VERIFIED on Commercial dev01 (2026-11-23). CRUD probe 45264235830 passed all 7 steps: metadata 200, no-token 401, writer create 201, read 200, cross-tenant 403, reader search 200, reader write 403. Cleanup destroyed and shredded both tenants. The live-only fixes were #5444-#5449; #5449 is the PDP url that had its decision path doubled, which caused the 503 on every token-bearing request. The probe exercises the W2-1 image, the W2-3 PDP interceptor and the W2-2a config live. The W2-3 audit path and the W2-5 sidecar are not separately verified. GCC-High is not exercised (#5123). Follow-ups #5439.
#5339 audit fail-closed: #5351 (`e755e0441`) merged; its live behaviour is not separately verified (writes pre-commit, reads before serialization; follow-ups on #5339).
2026-11-24, DEPLOYED and VERIFIED on Commercial dev01. CP `48ca82d65`, revision `--0000030` restarted 03:24Z.
- **Auto-bind (#5442).** #5453 `1fca52d49`: tenant.create chains fhir-tenant.create, ensure self-heals, and destroy tears the engine down with an `allowMissingEngine` escape hatch. #5457 `48ca82d65` serializes engine-affecting jobs per tenant.
  - The first live run found the double-submit `readback_mismatch` and a leaked G1 tenant, cleaned by destroy run 45314307119. #5457 fixed both.
- **NetworkPolicy (#5441).** #5452 `5581e3348`: a NetworkPolicy per engine. Live: `engine.probe ready=true` through the API-server proxy, and the CRUD probe from `aks-command` passes. The negative cross-namespace check has NOT been run.
- **Receipts:**
  - CRUD probe 45319268679: 7/7 (c 201, d 200, e 403, f_ctrl 200, f 403).
  - G1 45319272128: 6/6, including destroy.
  - ARM read-back: 0 leftover tenant resources.
- Follow-up: #5458 (the exclusion is in-process only; maxReplicas 2). | 2026-11-24 |
| W02b-fhir-core-ops | todo | | sonnet | | 2026-11-14 |
| W03a-dicom-core-a | in-progress | | sonnet | W3-1 #5313 + hardening #5335, W3-3 gateway #5336 merged, not deployed; W3-2 waits on the bicep slot; the gateway workload must set the pod label the #5335 NetworkPolicy admits (#5340); #5350 (`a5ce8e9df`) pins the NetworkPolicy port sets exactly (initContainer uid still unconfirmed, #5340) | 2026-11-17 |
| W03b-dicom-core-b | todo | | sonnet | | 2026-11-14 |
| W04-terminology | todo | | sonnet | | 2026-11-14 |
| W05-conversion-hl7v2-ccda | todo | | sonnet | | 2026-11-14 |
| W06a-bulk-export-import | todo | | sonnet | | 2026-11-14 |
| W06b-deid | todo | | sonnet | | 2026-11-14 |
| W06c-lakehouse-sink | todo | | sonnet | Q7 open (isolation fix deploy unconfirmed) | 2026-11-14 |
| W07-search-performance-at-scale | todo | | sonnet | small-scale only; Class-M moved to W13 | 2026-11-14 |
| W08a-labels-pdp | todo | | sonnet | | 2026-11-14 |
| W08b-breakglass-audit-siem | todo | | sonnet | | 2026-11-14 |
| W09a-viewer-copilot | todo | | sonnet | | 2026-11-14 |
| W09b-editors-admin | todo | | sonnet | | 2026-11-14 |
| W10-device-ingest | todo | | sonnet | | 2026-11-14 |
| W11a-chaos-dr | todo | | sonnet | | 2026-11-14 |
| W11b-hardening-bicep | todo | | sonnet | Gov second region unfunded (Q1/Q2) | 2026-11-14 |
| W12-compliance-evidence-pack | todo | | sonnet | | 2026-11-14 |
| W13-class-m-characterisation | blocked | | sonnet | spend NOT approved 2026-11-14 | 2026-11-14 |

Exercised so far: Commercial only. The dev01 stamp apply on #5151, plus the 2026-11-15 control-plane deploy and bootstrap; GCC-High has no LHDS receipt (W1b-5, blocked by #5123). IL5 and DoD are supported-in-code, never exercised; GCC is never exercised (`cloud-parity.md`).

## 4. Open decisions that gate waves

Full register: `RISKS-AND-OPEN-DECISIONS.md` section 5 (owner and decide-by lines live there). Gating now: Q7 (lakehouse isolation, W06c), Q8 (Gov Trivy/cosign lane #4584, first Gov image), the W1-4 Entra manual steps (before W02a live verify), and the Class-M spend approval (W13 only).

## 5. Common rules for every wave file

- **Bicep.** One bicep-touching PR in flight across all programs. LHDS bicep lives in `platform/fiab/bicep/modules/health/**` behind its own entrypoint `platform/fiab/bicep/health.bicep` (own 4 MiB ARM budget). Hot files, one owner per wave: `health.bicep`, `platform/fiab/bicep/health-params/*.bicepparam`, `engines.bicep`, `stamp.bicep`, `tenant.bicep`, `.github/workflows/build-fiab-images-acr-tasks.yml` (matrix row only), `apps/fiab-console/lib/copilot/health-tools.ts`, `apps/fiab-console/lib/gates/registry/*`.
- **Done** = deployed-and-verified receipts per cloud (Gov via a GitHub Actions run id, never local `az`); until then the phrase is "merged, not deployed" (`deploy-integrity.md` R2). No deploy-affecting merge while a deploy path is red (R1).
- **Assertions** name the value that would break them; any test claimed to catch a defect shows a mutation run on a sandbox copy (`assertion-design.md`).
- **UI** items need a live in-browser E2E (G1), Fix-it for any gate (G2), `SplitPane` (G3), and a parity doc at `docs/fiab/parity/<slug>.md` (`ui-parity.md`).
- **Cloud claims** name which clouds were verified (`cloud-parity.md`); IL5/DoD/GCC are supported-in-code until a run exists.
- **Cost.** Fresh session per wave file, Sonnet unless the item says Opus, <= 3 review rounds, PR bodies <= 3 KB.

## 6. How each die-hard rule is met

| Rule | How |
|---|---|
| `no-vaporware.md` | Every item has a real-backend verify command and a receipt; honest gates only where the platform genuinely cannot act (licence, tenant consent) |
| `no-fabric-dependency.md` | No Fabric or Power BI dependency; Fabric HDS is a UX reference only; AHDS is a model only |
| `cloud-parity.md` | Every wave ships Commercial + GCC-High receipts; IL5/DoD/GCC marked supported-in-code, never exercised |
| `auto-bind-by-default.md` | `health-tenant` create provisions stamp/tenant resources; names match; self-healing readback; no bind form |
| `deploy-integrity.md` | R1 broken deploy preempts; R2 merged is not done; R3 deploy SHA on the admin page; R4/R5/R8 greenfield + brownfield docs; R6/R7 truthful failures |
| `ui-parity.md`, `ux-baseline.md`, `web3-ui.md` | Parity doc per item type; G1-G3; Loom tokens and shared primitives |
| `assertion-design.md` | Named breaking value per assertion; mutation receipts |
| `session-end.md`, `task-tracking.md` | Native task list in-session; GitHub issues across sessions; close only on deployed-and-verified |

## 7. Spend decision (operator, 2026-11-14)

The W07 Class-M load test (about $25k per month for about 3 weeks) is NOT approved. W07 runs its code items plus a SMALL-SCALE functional test under the existing $4k cap (`OPERATOR-DECISIONS-2026-10-22.md` Q2). Full-scale characterisation is W13: blocked, last in order, requested only after all other work is done and verified. There is no default spend.

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
---
# PRP: Loom Health Data Services (LHDS) — master

| Field | Value |
|---|---|
| Status | DRAFT — design complete; W0 (measurement spike, no product code) may start immediately; everything else waits for W0's receipt or takes the recommended defaults in `RISKS-AND-OPEN-DECISIONS.md` |
| Created | 2026-10-22 |
| Decision source | Operator mandate 2026-10-22 (verbatim in `README.md`) and operator decisions 1-8 |
| Tracking issue | To be filed by the W0 session: "LHDS (PRP): Loom Health Data Services — W0 measurement spike" |
| Related rules | every file in `.claude/rules/` — section 8 says how each is met |
| Related programs | `governance-autopilot` (adds `backingStore`; LHDS adds rows), `per-workspace-spark-identity` and `apim-ai-gateway` (bicep collision rule), PRP-02 estate power (pause contract) |
| Boundaries | Commercial, GCC-High (receipts); IL5, DoD supported-in-code via params (DoD needs the enum, D3); GCC supported-in-code only, never exercised |
| Implemented by this PR | Nothing. Docs only |

Evidence convention: repo claims carry `file:line` measured on `origin/main`
at `2f7694b0e` (2026-10-22); external claims carry a URL in `research/` with
the retrieval date; anything not read in full is **UNVERIFIED**.

## 1. Goals

G1. A from-scratch, Azure-native health data platform (FHIR R4, DICOMweb,
terminology, conversion, bulk export, de-identification, lakehouse sink) with
no dependency on Azure Health Data Services or Fabric, same capabilities in
Commercial and Azure Government (`cloud-parity.md`).
G2. Scale by stamps to all-VA / all-IHS with the arithmetic in
`CAPACITY-MODEL.md` and measured receipts at 1 M patients per class-M stamp.
G3. Proven OSS engines (HAPI FHIR, dcm4chee-arc-light) inside Loom-owned
platform layers, each chosen by an ADR with a pass bar and a fallback.
G4. Provable tenant isolation, per-tenant CMK, private-only network, immutable
audit, consent/segmentation enforcement, PHI-free logs.
G5. First-class Loom product surfaces (item types, editors, Copilot, gates,
parity docs, greenfield + brownfield docs) at A-grade.
G6. An evidence pack an agency assessor can use; never a certification claim.

## 2. Non-goals
`PRD.md` section 4.

## 3. Waves overview

| Wave | File | Scope | Model notes | Review |
|---|---|---|---|---|
| W0 | `W00-measurement-spike.md` | Engine load tests, Gov availability closure, egress check, Synthea throughput, repo measurements, ADR fixing | Sonnet; **Opus** W0-7 decision pass | W0-3, W0-7 |
| W1 | `W01-control-plane-identity-stamp.md` | Stamp + tenant bicep, control plane, authorization server, PDP v1, routing, `health-tenant`, estate power, DoD enum, docs | Sonnet; **Opus** W1-4 scope-mapping design | bicep, auth |
| W2 | `W02-fhir-core.md` | HAPI per tenant, interceptors, outbox, scrubber, curated search, item/editor, Inferno | Sonnet | W2-2, W2-3, W2-8 |
| W3 | `W03-dicom-core-dicomweb.md` | dcm4chee, Blob layout, gateway, change feed/tags/partitions, lifecycle, item/editor, viewer smoke, load | Sonnet | W3-1, W3-2, W3-3, W3-8 |
| W4 | `W04-terminology.md` | Terminology service, bundled packages, licensed loader | Sonnet | none |
| W5 | `W05-conversion-hl7v2-ccda.md` | FHIR-Converter, ingest pipeline, item/editor, VistA/RPMS specs | Sonnet | W5-2, W5-4 |
| W6 | `W06-bulk-export-deid-lakehouse-sink.md` | `$export`/`$import`, de-id, Delta sink, DICOM export, `ImagingStudy`, items/editors | Sonnet; **Opus** W6-1 parallel export design | W6-1, W6-3, W6-4 |
| W7 | `W07-search-performance-at-scale.md` | Class M at 1 M, index v2, reindex/bulk ops, quotas, subscriptions, 10 M characterisation | Sonnet; **Opus** W7-2 index design | W7-2, W7-3 |
| W8 | `W08-consent-segmentation-audit.md` | Labels, consent PDP v2, break-glass, audit chain, SIEM, disclosures surface | Sonnet; **Opus** W8-2 policy design | W8-1..W8-4 |
| W9 | `W09-viewer-editors-copilot.md` | OHIF viewer item, editors to A-grade, admin page, Copilot write tools, docs | Sonnet | W9-4 |
| W10 | `W10-device-ingest.md` | MedTech-model device ingest | Sonnet | none |
| W11 | `W11-hardening-dr-scale-out.md` | Chaos, restore, evacuation, failover, 1->3 stamps, MPI, upgrades, measured SLOs | Sonnet; **Opus** W11-3 evacuation design | W11-2, W11-3, W11-4 |
| W12 | `W12-compliance-evidence-pack.md` | Evidence generator, control mappings, close-out | Sonnet; **Opus** W12-2 mapping pass | W12-1, W12-2 |

## 4. Dependency graph and run order

```
W0 ──> W1 ──┬──> W2 ──> W4 ──> W5 ──┐
            │                       ├──> W9 ──> W11 ──> W12
            └──> W3 ─────┐          │
                         ├──> W6 ──┬┴──> W8 ─┘
            W2 ──────────┘         └──> W7 ──> W10
```

Run order: W0; W1; then W2 and W3 in parallel (two lanes each, WIP <= 4);
W4 and W5 after W2; W6 after W2 + W3; W7 and W8 after W6; W9 after W8 + W5;
W10 after W7; W11 after W9; W12 last. FHIR core (W2) is first-to-ship; DICOM
(W3) is a parallel track from the moment W1 lands (operator decision 3).

## 5. Lanes, WIP and the bicep collision rule

- At most 4 concurrent lanes per wave; each wave file names its lanes.
- `platform/fiab/bicep/**` is shared with spark-identity, apim-ai-gateway and
  the drain: **one bicep-touching PR in flight at a time across programs**.
  LHDS bicep lives in `modules/health/**`; the only shared edits are the
  `main.bicep` health block, `admin-plane/main.bicep` env rows, the `boundary`
  enum (D3, its own PR) and params. Each bicep item is a small PR.
- Multi-owner files (`health-tools.ts`, `tenant.bicep`, `engines.bicep`,
  editor files) are edited additively in the order the wave tables give.
- No deploy-affecting merge while a deploy path is red (`deploy-integrity.md`
  R1).

## 6. Cost rules (from `MASTER-INDEX.md` / `finish-2026-10`)

Fresh session per wave; Sonnet default; Opus only for the named steps above;
lean briefs (`temp/brief_common.md`, `temp/review_protocol.md`); one reviewer
per round on sensitive paths, zero elsewhere on green CI, at most 3 rounds;
PR bodies <= 3 KB; no sleep-polling (queue PRs in `temp/automerge_queue.txt`).
Azure spend per wave is estimated in each wave file; W0 is capped (Q2).

## 7. Verification and "done"

A wave is done only on deployed-and-verified receipts per cloud (never on
merge: "merged, not deployed" is the phrase), with the receipt list in
`TEST-STRATEGY.md` section 9, mutation evidence for tests that claim to catch
defects, and the per-cloud table in `ARCHITECTURE.md` section 6 updated with
run ids. The PRP is done when W12-4's close-out holds and every leftover is a
filed issue.

## 8. How each die-hard rule is met

| Rule | How |
|---|---|
| `no-vaporware.md` | Every item has a real-backend verify command and a receipt; honest gates only for the two genuine ones (licence, tenant consent) plus platform-blocking gates that state the true blocker; bicep sync per `LOOM-INTEGRATION.md` section 5 |
| `no-fabric-dependency.md` | No Fabric or Power BI dependency; Fabric HDS is a UX reference only; AHDS is a model only |
| `cloud-parity.md` | Every wave ships Commercial + GCC-High with Actions receipts; IL5/DoD are params, listed as supported-in-code until exercised; GCC never claimed; per-cloud table in every status |
| `auto-bind-by-default.md` | `health-tenant` create provisions stamp/tenant resources, names match, self-healing readback; editors never open on a bind form |
| `deploy-integrity.md` | R1 broken deploy preempts; R2 merged != done; R3 deploy SHA on the admin page; R4/R5/R8 greenfield + brownfield walkthroughs with discovery/offer/validate; R6/R7 truthful classified failures |
| `ui-parity.md` | Parity doc per item type against the AHDS blades / Fabric HDS; zero missing before A |
| `ux-baseline.md` | G1 browser E2E receipts, G2 Fix-it + registry, G3 SplitPane, badges, first-open; section 7 checklists attached |
| `web3-ui.md` | Loom tokens, shared primitives, side-by-side screenshots |
| `assertion-design.md` | Every verify names the value that breaks it; mutation receipts on defect-catching tests; positive controls on absence assertions |
| `session-end.md`, `task-tracking.md` | Native task list in-session; GitHub issues across sessions; close only on deployed-and-verified |

## 9. Rollback
Per wave file; globally `healthEnabled=false` in params stops new deploys;
data stores are never deleted on rollback (crypto-shred is an explicit,
confirmed offboarding job).

## 10. Decisions needed
`RISKS-AND-OPEN-DECISIONS.md` D1-D27 and Q1-Q10; execution proceeds on
defaults.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00-measurement-spike | merged | docs/lhds-w0-7-decision | sonnet | `W00-measurement-spike.md` (W0-3 #5092/#5094; W0-1/2/4/5 DEV function proof #5107, pass bars deferred to W7 on operator Q2 2026-10-24; W0-6 #5093; W0-7 decision #5118) | 2026-10-24 |
| W01-control-plane-identity-stamp | in-progress | feat/lhds-w1-3-cp-bicep | sonnet | `W01-control-plane-identity-stamp.md` (merged, not deployed: W1-1 #5122, W1-3 service #5121, W1-4 design #5127, W1-5 Rego v1 #5125; W1-3 bicep #5126 = c39c7a42f; W1-2 tenant bicep #5130 = 66668f51c, W1-4 server #5131 = 47147f167, deploy-health.yml param/hub fix #5132 = d6a284504; W1-5 finish #5137 = d8d5cff17, W1-7 #5139 = dcc211152 (not A-grade), W1-8 TS half #5138 = 7e51b25ac, W1-8 DoD bicep half #5146 = a31e9c45f (supported-in-code only, never exercised), W1-6 routing #5145 = 76301d1f9 (gaps #5149), W1-9 docs #5148 = 97ce3e5cb; all merged, not deployed, nothing exercised in any cloud (#5151); remaining W1-4 wiring + Inferno SMART, W1-5 per-stamp data + bundle publishing, W1-6 gaps, W1-7 A-grade, and the DEV What-If + synthetic tenant receipt. Live stamps on the DEV profile in both clouds, operator 2026-10-24; What-If UNMEASURED while the estate is paused and the Gov ADX is stopped, #5123) | 2026-10-26 |
| W02-fhir-core | todo | | sonnet | `W02-fhir-core.md` | 2026-10-22 |
| W03-dicom-core-dicomweb | todo | | sonnet | `W03-dicom-core-dicomweb.md` | 2026-10-22 |
| W04-terminology | todo | | sonnet | `W04-terminology.md` | 2026-10-22 |
| W05-conversion-hl7v2-ccda | todo | | sonnet | `W05-conversion-hl7v2-ccda.md` | 2026-10-22 |
| W06-bulk-export-deid-lakehouse-sink | todo | | sonnet | `W06-bulk-export-deid-lakehouse-sink.md` | 2026-10-22 |
| W07-search-performance-at-scale | todo | | sonnet | `W07-search-performance-at-scale.md` | 2026-10-22 |
| W08-consent-segmentation-audit | todo | | sonnet | `W08-consent-segmentation-audit.md` | 2026-10-22 |
| W09-viewer-editors-copilot | todo | | sonnet | `W09-viewer-editors-copilot.md` | 2026-10-22 |
| W10-device-ingest | todo | | sonnet | `W10-device-ingest.md` | 2026-10-22 |
| W11-hardening-dr-scale-out | todo | | sonnet | `W11-hardening-dr-scale-out.md` | 2026-10-22 |
| W12-compliance-evidence-pack | todo | | sonnet | `W12-compliance-evidence-pack.md` | 2026-10-22 |

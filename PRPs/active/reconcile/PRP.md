# PRP — Reconcile (2026-07-24)

**Purpose.** A single, prioritized backlog consolidating every **not-fully-implemented** item found by the
2026-07-24 four-way audit (PRP-completeness across all 14 active PRP areas, orphaned-pages, front-end coverage,
nav/IA reorg). This replaces "grep 14 PRPs to find what's left" with one ordered list. Each item cites its
source finding (`temp/audit/audit-results-part{1,2}.json`) and the evidence.

**Scope note.** This PRP RECONCILES; it does not re-spec. Where a gap belongs to an existing PRP's design
(e.g. loom-next-level N15–N20), the reconcile item points at that PRP's spec and schedules it — it does not
duplicate the spec. Other-PRP DRAFTS (domain-mesh, access-governance, geo-graph-ml, bridge-services) are
catalogued as **future programs**, not reconcile work, so they don't dilute the near-term list.

## Audit ground-truth (what is NOT a gap)

- **Front-end coverage is CLEAN.** All ~130 catalog item-type slugs have a registered, real editor
  (`lib/editors/registry.ts`, 137 entries); all 40+ `app/admin/*/page.tsx` delegate to substantial real panes
  (200–1281 LOC). The die-hard vaporware grep produced only legitimate hits (input placeholders, guard-clause
  `return []`, labeled SAMPLE_ template defaults, negation comments). **Zero vaporware findings.** (audit part2)
- **Zero true orphans / zero dead links** across all 129 pages — every non-rail page resolves to a real
  registration surface, except the two low-severity items below (`/data-products`, `/copilot/skills`). (part1)
- **No phantom-done** in loom-next-level: a code-level cross-check confirmed the claimed-done files exist
  (N1/N5/N9/N11/FLAG0/duckdb/answer-receipt). (part1)
- **Operator-gated ≠ gap:** I6/I7 per-workspace enforce, S2 FIC flip, one-time Graph `Application.Read.All`
  consents — deliberately operator-gated; tracked separately, NOT scheduled as reconcile work.

## Priority-ordered reconcile backlog

### P0 — compliance / deployment (do first)
| ID | Item | Status | Source |
|----|------|--------|--------|
| RC-LIC0 | LIC0 distribution-license inventory + NOTICE manifest + guard (the gate mandated to precede Phase-4 OSS embeds) | **DONE — PR #2506** (`THIRD_PARTY_LICENSES.md` + `check-license-inventory.mjs`; 19 embeds/5 sidecars reviewed, all permissive; hard-block A?GPL/BSL/SSPL; no MinIO/Univer). Closes LNL-LIC0 HIGH. | part1 LNL-LIC0 |
| RC-4B-ROLL | loom-next-level Phase-4b rolled + live-verified on Commercial | **DONE** — run 30065639891, `294ff1f1` live + UAT-green; receipt in loom-next-level DONE.md. Closes LNL-4B-ROLL HIGH (audit ran before the roll). | part1 LNL-4B-ROLL |
| RC-GOV | Everything validated in the **Gov** console too (the /goal WS-2 requirement) | **IN PROGRESS** — `gov-console-roll.yml` (self-contained server-side `az acr build` + roll on the Gov ACR `acrloomdcmt6cqoezlgs.azurecr.us`) + `gov-bff-verify.yml`. First dispatch failed at the Gov ACR build (transient — Commercial built the identical SHA fine); re-dispatched. | /goal WS-2 |

### P1 — loom-next-level remaining CORE (the north-star tail)
| ID | Item | Source |
|----|------|--------|
| RC-N7BCD | N7b CDC control plane + N7c reverse-ETL activation + N7d data-quality/data-diff | **IN PROGRESS — batch4** (wf_ec337237). part1 LNL-TAIL |
| RC-N7AE | N7a RisingWave streaming SQL + N7e Trino/Starburst federation (opt-in carve-out) | loom-next-level ws-north-star N7a/N7e |
| RC-N8 | N8 openness Tier-3 labs (DuckLake, Malloy/PRQL, s3-compat via permissive path — MinIO DROPPED) | ws-north-star N8 |
| RC-PILLAR3 | **Pillar-3 governed analytics (N15–N20):** N15 headless metrics layer (MetricFlow-spec, compiled natively) → N16 code-report BI-as-code item + N18 embedded-analytics SDK w/ RLS; L2→N17 OpenLineage incident console → N19g catalog interop; N19a–f; N20 labs. **Largest coherent unbuilt block; blocks the north-star three-way-metric proof.** | part1 LNL-PILLAR3 |
| RC-MIGRATION | **WS-M inbound migration (M1–M3):** M1 estate assessment/inventory importer (ship FIRST as the on-ramp) → M2 schema+data copy-in → M3 best-effort code translation. **PRE-CHECK:** confirm whether `lib/estate/*` (estate-planner/executor/model, estate-console.tsx) already satisfies M1 or is unrelated deploy tooling. | part1 LNL-MIGRATION |

### P2 — loom-next-level TAIL (absent from DONE ledger; verify-then-schedule)
`WS-O`: CH1 dependency-chaos, EXP1 workspace export/import/clone, CMK1 Cosmos CMK, SC1 supply-chain (cosign gate — only trivy.yml exists today). `WS-C`: C5 snapshot delivery. `WS-A`: A4 AAS-GA-in-Gov unblock, A14 real-time collab push transport (lib/collab is poll-based). `WS-L`: L5 column fan-out canvas/impact analysis. `WS-I`: I4 shadow UI, I8 limits doc. `WS-DR`: DR4 orchestration + Health hub tabs. `WS-U`: U2/U8/U9/U11/U12/U13. `WS-R`: route batches R4–R6/R10–R29 (many may be superseded — verify against the live route-toolkit ratchet before scheduling). *(part1 LNL-TAIL — each needs a one-line built/unbuilt grep before it enters a wave.)*

### P3 — nav / IA reorg (usability; from the nav audit, part2 IA-01..IA-13)
| ID | Change | Sev |
|----|--------|-----|
| RC-IA-01 | Group the flat 44-item admin sidebar (`admin-shell.tsx` SECTIONS) into ~8 labeled groups (mirror `GOVERNANCE_SECTIONS`) | HIGH |
| RC-IA-02 | Place `/data-products` (+`/new`) into NAV_SECTIONS Data (beside Marketplace) or DEMOTED_NAV_ITEMS — it's a true orphan today | HIGH |
| RC-IA-03 | Fold `/admin/usage-chargeback` + `/admin/chargeback` into `/admin/finops` tabs (FinOps already claims to absorb them); redirect old routes | HIGH |
| RC-IA-04 | Consolidate `/admin/{copilot-usage,agent-quality,copilot-quality,model-fabric,parity-autopilot}` into ONE "AI operations" hub (extend the copilot-quality tab pattern) | HIGH |
| RC-IA-05 | Disambiguate the 3-way "Catalog" naming collision: `/catalog`→"Search", `/governance/catalog`→"Governed data catalog", `/admin/catalog`→"External-engine federation (Iceberg)" | HIGH |
| RC-IA-06 | Group the 4 access-governance admin surfaces under one "Access governance" hub | MED |
| RC-IA-07 | Reconcile admin-overview `TILE_SPECS` (18) with the grouped SECTIONS after IA-01 (regenerate or re-document the contract) | MED |
| RC-IA-08 | Surface `/copilot/skills` in DEMOTED_NAV_ITEMS ("Skills Studio") so it's Ctrl+K/Copilot reachable | MED |
| RC-IA-09 | Move Scheduler out of rail "Analyze" into Build/operations (it schedules jobs, not analyses) | MED |
| RC-IA-10 | Split the overloaded rail "Build" group (8 items) — separate build canvases from platform-meta (Deployment/Workload hub) | MED |
| RC-IA-11 | Rename rail "OneLake catalog" to an Azure-native term ("Lakehouse catalog"/"Data lake") — Fabric-first framing (also `no-fabric-dependency` framing hygiene) | MED |
| RC-IA-12 | Drop `/admin/autopilot` from DEMOTED_NAV_ITEMS (an /admin/* page belongs to the admin sidebar) | LOW |
| RC-IA-13 | Collapse the single-link "Govern" rail group into Data or make it an ungrouped hub entry | LOW |

### Housekeeping (docs + restructure — non-blocking)
| ID | Item | Source |
|----|------|--------|
| RC-DOC-FOUNDRY | Fix STALE `PRPs/active/foundry-parity/AUDIT.md` — marks RLS-authoring 6.3 + aip apply-action ❌ though both are built | part1 FOUNDRY-STALE |
| RC-DOC-COMPAUDIT | Fix STALE `loom-competitive-audit` PARITY-MATRIX/PRD — lists tier-router "no-op" + Feature Store as top P0 gaps, but `routeTurnTier` is wired and `feature-store-client.ts`/`feature-table-editor.tsx` exist | part1 COMPAUDIT-STALE |
| RC-R20-27 | loom-next-level R20–R27 `legacy/` restructure — one tree per PR, examples/ stays at root; pause instantly if CI destabilizes | loom-next-level housekeeping |

### Future programs (catalogued, NOT reconcile scope — each is its own initiative when prioritized)
- **domain-mesh** (16 items, execution-ready DRAFT; mesh §4 half-built) — part1 DOMAIN-MESH
- **access-governance** (entitlement-management breadth, W1–W4 DRAFT) — part1 ACCESS-GOV
- **geo-graph-ml** (GEO-2/3/4 unbuilt; GEO-1 partial) — part1 GEO-234
- **bridge-services** (4 control-plane services, 23 items, proposed) — part1 BRIDGE-SVC
- **next-waves** 8 large proposed PRPs + `enterprise-hardening` Phases 2–4 + OPEN-REGISTER §P3 — part1 NEXTWAVES-P3
  (each merits an item-level code sweep before promotion; catalogued in OPEN-REGISTER, not lost)

## Execution order (recommended)
P0 (LIC0 ✓, 4b-roll ✓, Gov validation) → P1 (finish N7 → pillar-3 → migration; the north-star spine) →
P3 nav/IA reorg (small, high-usability-ROI, can interleave) → P2 tail (verify-then-schedule) →
Housekeeping docs → future programs as separately prioritized.

**DONE = merged + rolled + live-verified on BOTH Commercial AND Gov** (per no-vaporware.md G1 and the /goal
WS-2 requirement), with the LIC0 gate green and zero new orphans/vaporware.

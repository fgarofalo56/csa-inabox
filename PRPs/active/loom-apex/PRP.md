# PRP — loom-apex (2026-07-24)

**The finishing program: drain everything, zero involuntary gates, page-perfect, help-complete,
Unity-parity on Gov, then a brutally-honest adversarial grading against the industry.**

Commissioned by the operator 2026-07-24 (mid-§P2-roll directive), synthesized from a 6-agent
evidence fan-out (wf_e79efea8). **Every claim below is grounded in [research/](research/) —
six reports, 1,427 lines, file:line-cited.** This PRP supersedes the residual sections of
`PRPs/active/reconcile/PRP.md` and closes out `loom-next-level`.

| Research report | Headline |
|---|---|
| [research/prps-audit.md](research/prps-audit.md) | All 15 PRP areas audited; core genuinely landed; **N14a–e over-claimed as done**; 30-row consolidated drain table |
| [research/canvas-resize.md](research/canvas-resize.md) | Pipeline resize IS wired but the grip clips unreachable; G3 width gap; 40/41 canvases already compliant |
| [research/help-center.md](research/help-center.md) | Visual tutorials 0/188; 18 item guides + 15 app tutorials missing; every Phase-4 headline feature undocumented |
| [research/gates-zero.md](research/gates-zero.md) | 125 gates enumerated; involuntary tail = ~4 env/secret writes + 10 operator actions; 17 legacy codes lack Fix-it |
| [research/loom-unity.md](research/loom-unity.md) | Databricks-path UC parity largely built (2,856-line client); flagship = 9 Gov/OSS governance gaps via a license-clean overlay; **OSS UC currently runs auth-disabled in-VNet** |
| [research/page-errors.md](research/page-errors.md) | Per-page code defensive; real exposure = **deploy-skew ChunkLoadError with no recovery** + zero error.tsx/loading.tsx boundaries |

**Definition of DONE (unchanged, non-negotiable):** merged + rolled + live-verified on BOTH
Commercial AND Gov, guard suite green, G1 browser receipt, zero new vaporware/orphans, LIC0 clean.

---

## Phase A — platform integrity (FIRST; fixes what users feel today)

### A1 — deploy-skew / ChunkLoadError recovery  *(top candidate for "pages open with an error")*
No deploymentId + no ChunkLoadError handling (`next.config.mjs`; `error-boundary.tsx:66-96`):
after every roll, in-flight clients 404 old chunks and the boundary's "Try again" re-requests the
dead chunk forever. Build: Next `deploymentId` wired to the build SHA + a ChunkLoadError-aware
boundary that hard-reloads once (loop-guarded) + stale-client detection via the existing
`/api/version` VersionSkewGuard. Confirm post-fix via the RUM AppExceptions KQL in
[research/page-errors.md](research/page-errors.md). **Size M.**

### A2 — route error/loading boundaries
0 `error.tsx` / 0 `loading.tsx` / 0 `global-error.tsx` across 132 routes; `GlobalErrorBoundary`
wraps only page children (`app-shell.tsx:281`) — a crash in CommandPalette/CopilotPane/nav = raw
Next error page. Build: shell-chrome-preserving `error.tsx` + `loading.tsx` per route group +
`global-error.tsx`, styled per web3-ui. **Size M.**

### A3 — silent-failure surfaces (error rendered as healthy)
`/admin/incident-console` shows "all healthy" on transport failure (`incident-console.tsx:120,198-206`);
`/browse`, `/workload-hub`, `/apps` catch into empty arrays; `/admin/rum` + `s3-gateway-editor`
never render `isError`; `AskAffordance.tsx:279` un-tried await = stuck spinner. Fix each to an
honest error state. **Size S–M.**

### A4 — live page-by-page validation sweep
After A1–A3 roll: minted-session walk of ALL 132 pages + 49 admin panes on BOTH estates
(extend loom-ui-verify route-smoke to assert no error boundary/blank body/0-count-on-error),
plus the RUM top-error-pages pull. Every failure triaged to fix-or-gate. **Size M (mostly harness reuse).**

### A5 — canvas resize completion  *(the operator's pipeline complaint — root-caused)*
Per [research/canvas-resize.md](research/canvas-resize.md): resize IS wired but (1) the grip
clips unreachable — `top-tabs.tsx:20 overflow:hidden` + `useResizableHeight` clamps to 80vh of
*window* not the panel (`resizable-canvas.tsx:159-191`), so a height persisted on a tall monitor
strands the grip on a shorter/RDP window; (2) the data-pipeline palette is a fixed 248–288px
column (no width divider); (3) the visible 10px canvas/config splitter resizes ONLY the dock —
ADF's identical divider reallocates canvas space (model mismatch). Build: container-aware
(ResizeObserver) max clamp in the shared hook; ONE vertical SplitPane (`adf-data-pipeline.config-dock`)
replacing the region+dock stack; SplitPane-wrap the palette (`adf-data-pipeline.palette`);
then a width-divider policy pass over the 24 canvases that have height-only (user requirement:
height AND width everywhere a width makes sense). G1 receipt at a SHORT viewport with a large
persisted height. Nested-fullscreen-host defect already fixed (#2527). **Size M.**

### A6 — zero involuntary gates (config run, not code)
Per [research/gates-zero.md](research/gates-zero.md): 125 gates; the involuntary tail is
**~4 env/secret writes** (incl. `LOOM_PGVECTOR_HOST` which clears two gates at once) + the
17 legacy error codes lacking Fix-it mapping (code item). Execute the runnable checklist on
BOTH estates; keep the 5 by-design opt-ins (chaos, Trino, Fabric backends, tutorial capture,
Esri) documented-OFF. Acceptance: gate-registry page shows zero involuntary reds on both
estates. **Size S code + config run.**

### A7 — ledger/PRP truth reconcile  *(honesty debt found by the audit)*
- **N14a–e were over-claimed**: DONE.md's "N1–N18 fully landed" boundary is wrong for N14 —
  correct the ledger NOW and schedule the real builds (Phase B).
- access-governance W1–W4 is **BUILT** but its PRP reads DRAFT — flip it + move out of
  "future programs" in reconcile.
- N19c recert + N19f webhooks already built (mark; only N19c signed-evidence residual remains).
- PARITY-MATRIX still grades fine-tuning F though `fine-tuning-client.ts`/`fine-tuning-item.ts` exist.
**Size S (docs).**

## Phase B — drain (every remaining real gap, from [research/prps-audit.md](research/prps-audit.md) §consolidated table)

| ID | Item | Size |
|----|------|------|
| B-N14a | Embedding-pipeline item + hybrid retriever (AI Search ↔ pgvector via `LOOM_VECTOR_BACKEND`) | M |
| B-N14b | NL governance copilot over PDP + classifications + lineage (reuse N11 GraphRAG on the policy graph) | M–L |
| B-N14c | Contract-validating copilots (N6 check pre-proposal, violation in receipt) | M |
| B-N14d | A2A agent-card generator + formalized agent-memory service | M |
| B-N14e | Agent-designer publish surface (knowledge picker, publish-as-A2A + M365 manifest) | L |
| B-N19a | Reactive notebook mode (dep-DAG, reactive re-run, .py round-trip, deploy-as-app) | L |
| B-N19b | `csa-loom` PyPI SDK + terraform-provider-loom, contract-tested vs openapi.json | M–L |
| B-N19c′ | Signed evidence record on access-review close | S |
| B-N19d | Scheduled insights/anomaly digests via C5 subscriptions (extend, don't fork) | M |
| B-N19e | FOCUS cost-per-query attribution (serialize on cost-client) | M |
| B-N19g | DataHub/OpenMetadata interop (rides N17 OL export) | M |
| B-N20 | Tier-3 labs, preview-badged, opportunistic (Univer blocked on LIC0 module review) | S–L each |
| B-U12 | new-item-dialog px→tokens + dead color/fg fields | S |
| B-R10-14 | Decompose semantic-model-editor (3,025) + foundry-sub-editors (3,272) + R14 monoliths | M ×4-6 PRs |
| B-R15-17 | Typed client-map + `clientFetch` typed overload + known-route guard | M |
| B-X3 | `gov-workspace-identity.yml` CI lane (Gov E2E receipt for I1–I3) | S |
| B-SC1′ | Base-image CVE burn-down: bump node:20 / debezium / mcp-bridge base, then EMPTY `.trivyignore` | S |
| B-IA-03 | Fold chargeback + usage-chargeback into `/admin/finops` tabs + redirects | S–M |
| B-IA-04 | ONE "AI operations" hub (copilot-usage/agent-quality/copilot-quality/model-fabric/parity-autopilot) | M |
| B-IA-06 | Access-governance hub (4 pages → tabs) | S |
| B-FN | **Function fleet → ACA-jobs migration** (operator decision 07-23; Y1 structurally broken in this estate) — secret-expiry-monitor, copilot-evaluator, posture-refresh, access-sweeper et al. onto the proven ACA-job template; delete the Y1 fleet + its interim bypasses | M–L |
| B-FP′ | foundry residuals: widget-catalog last mile + WS-4.4 sync-backfill verify-first | S–M |

## Phase C — Loom Unity  *(flagship; full spec in [research/loom-unity.md](research/loom-unity.md))*

**Verdict from research:** the Databricks-path parity is largely BUILT (`unity-catalog-client.ts`,
2,856 lines, full surface). The flagship is closing the **Gov/OSS-path** governance gaps by
extending the already-deployed OSS Unity Catalog (Apache-2.0, license-clean) with a Loom-native
overlay — NOT rebuilding a catalog. Naming: **"Loom Unity"** (our platform, "Unity-Catalog-
compatible" in docs — avoids the Databricks trademark as a product name). All components
FedRAMP-High-postured: Azure Gov services, in-VNet, AAD-only, no external SaaS.

**LU-2 leads — a real security finding: the deployed OSS UC runs authorization-DISABLED,
anonymous-in-VNet** (unity-gov.md:48-52; bicep:174-180). Order: LU-1 → LU-2 → the rest.

| ID | Item | Size | Dep |
|----|------|------|-----|
| LU-1 | Postgres-by-default in Gov (AAD-only PG Flexible Server, PE, replicas>1) + image 0.5.1 + fix stale unity-gov.md | M | — |
| LU-2 | **AuthN/Z hardening**: OSS UC OIDC vs Entra; BFF bearer injection; ingress restricted to Console; KV secretref vending | M | LU-1 |
| LU-3 | BFF audit choke point for ALL UC calls → `_auditLog` + `LoomAudit_CL`; "Loom Unity system tables" pane (replaces the 501 gate) | M | LU-2 |
| LU-4 | Effective-permissions resolver (inheritance walk) — removes the effective-permissions gate | M | — |
| LU-5 | Governance overlay v1: tags/governed-tags/certification/attribute-groups on `uc:<fqn>` identities + Purview fold-in | M | — |
| LU-6 | ABAC engine-compile v1: policy-code → Synapse secure views + GRANTs, reconcile + drift report | M | LU-5 |
| LU-7 | ABAC engine-compile v2: Trino OPA rules + DuckDB secure views from the same policy set | M | LU-6 |
| LU-8 | OpenLineage emitters (Synapse Spark/pipeline) → unified-lineage; OSS-backend lineage tab shows the merged graph | M | — |
| LU-9 | loom-sharing: OSS delta-sharing reference server (Apache-2.0) on ACA over the same ADLS Delta; Marketplace re-pointed; AAD recipients | M/L | LU-2 |
| LU-10 | Workspace→catalog bindings (Cosmos, BFF-enforced) — bindings dialog un-gated on OSS | M | LU-4 |
| LU-11 | Foreign catalogs read-only (Trino catalogs + Linked Services in the Federation tab) | M | LU-7 |
| LU-12 | Semantic tier: OSS metric views (Preview) + vector-index securables + NL2SQL over metric views (Genie parity) | M | LU-5 |

Threat-model note per component (I9 pattern) + STRIDE row; LIC0 review for every new OSS embed.

## Phase D — Help Center deep expansion  *(matrix in [research/help-center.md](research/help-center.md))*

- **D1** Fix stale wiring NOW (S): 7 authored guides + PNGs not registered in
  `EDITOR_DOC_SLUGS`/`THUMB_SLUGS` (`content.ts:133,176`); 3 broken thumbnail slugs.
- **D2** 18 missing item-type editor guides (all recent-wave types: sql-lab, streaming-sql,
  code-report, data-contract, activation-sync, feature-table, ducklake-catalog, s3-gateway…). M.
- **D3** Feature deep-dives for every undocumented Phase-3/4/§P2 headliner: GraphRAG grounding,
  answer receipts (the IL5 compliance artifact!), verified queries, self-heal NL2SQL, prompt
  registry/budgets, Iceberg interop, Flight SQL, Trino, RisingWave, PRQL, dataflow debug,
  workspace portability, collab presence, chaos harness, column lineage, canvas fullscreen,
  KQL-dashboard pages, M1–M3 migration, FinOps hub. M–L.
- **D4** From-scratch→working deep-dive tutorial per APP: the 15 uncovered apps + 7 supercharge
  packs (117 notebooks) get guided paths; every app gets a Learn Gallery card. L.
- **D5** docs/learn refresh (stale since 06-02, pre-console) + corpus hygiene: stop masking
  user-doc gaps with engineering-ledger RAG hits (corpus source weighting/partition). M.
- **D6** Visual-tutorial captures: coverage lane says 0/188 — capture runs are OPERATOR-GATED
  (credentialed workflow + privacy review). Schedule batches with the operator; wire the
  17-feature + 142-item + 29-app targets. Operator-partnered.
- Acceptance: `check-tutorial-coverage` + a new help-coverage ratchet (items/apps/features with
  guides can never regress); corpus restaged; in-product LearnPopovers already strong (140/142).

## Phase E — validated A+ and the adversarial review  *(LAST, after everything above)*

1. Full G1 click-walk sweep (both estates) + per-surface §7 checklist re-grade; every surface A/A+.
2. **Brutally-honest adversarial review**: red-team panel graded per capability area vs
   **Microsoft Fabric, Databricks (incl. Unity/Genie/Mosaic), Palantir Foundry/AIP, Snowflake
   (incl. Cortex), plus the relevant buzzword field (dbt Cloud, Dataiku, Alteryx, Sigma)** —
   ETL/ELT, lakehouse/warehouse, streaming, BI, catalog/governance, lineage, AI/agents/RAG,
   MLOps, collab, marketplace, embedded, DevEx (SDK/CLI/IaC), Gov/sovereign posture, ops/SRE.
   Verdicts: grade per area, where Loom WINS, where it honestly LOSES and why, what it would
   take to flip each loss. Output: `PRPs/active/loom-apex/ADVERSARIAL-REVIEW.md` + a
   prioritized improvement backlog (which seeds the NEXT program).
3. FRESH0 strict + DONE ledger close-out + memory.

## Housekeeping (LAST, never blocking): R20–R27 `legacy/` restructure — one tree per PR; pause instantly if CI destabilizes.

## Explicitly OUT of apex scope (catalogued future programs — promote separately)
domain-mesh (~16 items, execution-ready), geo-graph-ml GEO-2/3/4 (GEO-1 built), bridge-services
(4 services / 23 items, XL), enterprise-hardening Phases 2–4 (re-scope first — several halves
already shipped), next-waves/OPEN-REGISTER P3 (item-level sweep at promotion).

## Operator-pending (surface, never block)
1. Entra CA exclusion for `svc-loom-synthetic@limitlessdata.ai` → V1 login probe online.
2. I6/I7 enforce flip — after I9 sign-off + clean-shadow window (~08-05).
3. S2 FIC flip on the prod app reg.
4. Visual-tutorial capture runs + privacy review (D6).
5. RisingWave image-tag confirm; Trino Helm install (opt-ins).
6. Esri license for GEO-2 (future program).
7. The 10 operator actions in the zero-gates checklist ([research/gates-zero.md](research/gates-zero.md)).

## Execution contract (unchanged)
Worktree workflow fan-outs; integrate every batch with tsc + FULL vitest + the 18-guard suite
before push; admin-merge on green required CI (run full vitest locally regardless); ONE
SHA-pinned roll per batch to BOTH estates (loom-roll-and-validate + gov-console-roll — both now
behind the SC1 cosign verify gate); FRESH0 re-baseline at every phase boundary; G1 receipts for
user-visible items; DONE ledger + memory at each milestone. Recommended order:
**A (integrity) → B (drain) ∥ C (Loom Unity, LU-1/2 first) → D (help) → E (review) → housekeeping.**

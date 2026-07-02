# CSA Loom — Enterprise-Hardening PRP (Master)

**Status:** Kickoff-ready · **Scope:** scale CSA Loom from a tens-of-users pilot to a
**100 → 60,000-user** enterprise platform across **Azure Commercial AND Azure Government
(GCC / GCC-High / DoD IL4–IL5)** without breaking the day-one-on, no-Fabric-dependency,
no-vaporware, Web-5.0 product principles.

This is the **master roadmap**. The deep, file-level design for each of the 12 domains lives
in the linked appendices — this document does **not** duplicate them; it sequences them,
states the cross-cutting law every design obeys, and grades current readiness.

- Phased, kickoff-ready execution plan: [`PHASES.md`](./PHASES.md)
- Per-domain deep designs: the 12 appendices linked in the scorecard below.

---

## 1. Executive summary

CSA Loom today is functionally rich but **architected for a single team, a single region, and a
single shared identity**. Three structural facts block 60k:

1. **One shared Console UAMI runs the entire data plane (~233 files).** Per-user isolation rests
   on app-layer checks + SQL session RLS, not native Azure per-user enforcement. A 60k,
   multi-domain, sovereign tenant needs **defensible, source-enforced** security — On-Behalf-Of
   (OBO) user tokens to Storage/Synapse/ADX/AAS, a real Policy Decision Point, and OneLake-style
   roles that materialize RLS/CLS down to the engine.

2. **The metadata + query + AI tiers are sized for tens, not tens of thousands.** Cosmos is
   **Serverless single-region** (5k RU/s/partition hard ceiling, no geo, no SLA); there is **no
   rate-limiter, no `middleware.ts`, no result cache, no query governor**; AOAI is **hand-rolled
   across ~18–27 callers** with no PTU, no spillover, no token budget. All four buckle well below
   60k.

3. **Two 18k-line editor monoliths and ~18 duplicated AOAI callers** are the highest-merge-contention
   files in the repo — they must be refactored **first** so every later workstream can land in
   parallel without constant conflicts, and so the systemic bugs (the `max_completion_tokens`
   contract drift, the Gov-scope 401) get one owner instead of 18.

The strategy therefore front-loads the **security foundation** (OBO data-plane + multi-domain ACL)
and the **unblocking refactors** (one AOAI client + editor split + item-type manifest), then builds
the **scale tier** (Cosmos provisioned/geo, query caching + governor, AOAI PTU, rate-limiting) on
that clean base, then layers **BCDR + cost-governance**, and finishes with **ops maturity** (SLOs,
load/soak, observability, the P0 token-refresh fix, startup hardening).

Everything stays **day-one-on but cost-governed**: features remain enabled by default, with a new
capacity/quota/enable-per-domain layer (budgets, token ledgers, per-domain RU/TPM caps) that makes
"everything on" affordable and safe at 60k. Every identity/refactor change ships **behind a feature
flag in observe→shadow→enforce order, fully reversible** — no big-bang.

---

## 2. Readiness scorecard

| # | Domain | Appendix | Readiness | Top gap (P0 unless noted) |
|---|--------|----------|-----------|---------------------------|
| 1 | **OBO data-plane** | [appendix-obo-data-plane.md](./appendix-obo-data-plane.md) | 🟡 partial | Report read path always runs as service/UAMI; no per-user token branch — the brief's first migration target |
| 2 | **Multi-domain ACL** | [appendix-multi-domain-acl.md](./appendix-multi-domain-acl.md) | 🟡 partial | No coherent Policy Decision Point; routes query each silo ad-hoc with no composed grant/deny precedence |
| 3 | **Scale: Cosmos data tier** | [appendix-scale-cosmos-data-tier.md](./appendix-scale-cosmos-data-tier.md) | 🔴 weak | Account is Serverless — 5k RU/s/partition ceiling, single region; cannot scale to 60k |
| 4 | **Scale: query concurrency + caching** | [appendix-scale-query-caching.md](./appendix-scale-query-caching.md) | 🔴 weak | No RLS-aware result cache and no concurrency governor / admission control (no `middleware.ts`) |
| 5 | **Scale: AOAI PTU + AI cost** | [appendix-scale-aoai-ptu.md](./appendix-scale-aoai-ptu.md) | 🔴 weak | No AOAI gateway chokepoint and no PTU; default 10K TPM serves tens not 60k |
| 6 | **Rate-limiting / quota** | [appendix-rate-limiting-quota.md](./appendix-rate-limiting-quota.md) | ⚫ absent | No runtime rate-limiter anywhere; 1,118 routes gate auth ad-hoc with no shared chokepoint |
| 7 | **BCDR / multi-region** | [appendix-bcdr-multi-region.md](./appendix-bcdr-multi-region.md) | 🔴 weak | Cosmos Serverless single-region = system of record cannot survive a region loss |
| 8 | **Capacity / cost governance** | [appendix-capacity-cost-governance.md](./appendix-capacity-cost-governance.md) | 🟡 partial | No per-domain cost attribution / metering / budget enforcement at 60k |
| 9 | **Refactor: editor split** | [appendix-refactor-editor-split.md](./appendix-refactor-editor-split.md) | 🟡 partial | `phase3-editors.tsx` (18k lines, 13 editors) unsplit — top merge-contention file |
| 10 | **Refactor: one AOAI client** | [appendix-refactor-aoai-consolidation.md](./appendix-refactor-aoai-consolidation.md) | 🟡 partial | No single AOAI chat client; ~18+ call sites rebuild credential/token/URL/param contract |
| 11 | **Refactor: item-type framework** | [appendix-refactor-itemtype-framework.md](./appendix-refactor-itemtype-framework.md) | 🟡 partial | Inlined DAX→SQL/Databricks RLS compiler not de-duped into canonical `rls-compiler.ts` |
| 12 | **Ops: SLOs / load-test / observability** | [appendix-ops-slo-loadtest.md](./appendix-ops-slo-loadtest.md) | 🟡 partial | P0 token-refresh bug: session `exp` pinned to ~1h access-token expiry though cookie + refresh token last 8h+ |

Legend: 🟢 production-ready · 🟡 partial · 🔴 weak · ⚫ absent.

---

## 3. Cross-cutting requirements (every design obeys these)

These are **law** for all 12 domains. A design that violates any of them is not "done."

1. **Dual cloud — Commercial AND Azure Government.** Every client resolves host/scope/authority via
   the existing `cloud-endpoints.ts` / `detectLoomCloud()` helpers. Name the Gov forms explicitly:
   `*.usgovcloudapi.net` / `*.azure.us` data-plane and ARM hosts (`database.usgovcloudapi.net`,
   `kusto.usgovcloudapi.net`, `dfs.core.usgovcloudapi.net`, `documents.azure.us`,
   `management.usgovcloudapi.net`), Entra authority `login.microsoftonline.us`. Where a managed
   service is **absent or degraded in Gov** (AOAI Model Router, native AOAI spillover, AOAI Batch,
   Managed-Redis-Enterprise, Power BI Embedded, Foundry Agents, Event Hubs geo-replication), the
   design ships an **OSS / app-layer substitute** (app-layer router + 429-retry spillover,
   p-limit batch queue, OSS Redis/KeyDB on AKS or Redis Stack on ACA, Loom-native / Grafana render,
   MAF Container App agent tier, Kafka MirrorMaker). **IL4/5 = private-endpoint-only + CMK** on every
   stateful resource; same-boundary region pairs only (GCC-High↔GCC-High, IL5↔IL5).

2. **Defensible security — native first, app-layer as defense-in-depth.** Prefer per-user OBO tokens,
   Azure RBAC, and **RLS/CLS enforced at the source engine** (Synapse `SECURITY POLICY`, ADX
   `row_level_security` / `current_principal()`, AAS `EffectiveUserName`, ADLS ACLs). App-layer
   owner-checks and the PDP are an additional layer, **never the sole boundary**. Cosmos stays UAMI
   by design (metadata, not user business data) with app-layer owner-scoping + partition-by-oid —
   documented so it is not mistaken for a gap.

3. **Scale target 100 → 60,000 users.** Size every design for the **60k upper bound**: hierarchical
   partition keys, autoscale/provisioned throughput, per-engine concurrency lanes under MS Learn
   ceilings (Synapse 128, ADX cores×10, AAS QPU), per-user/per-domain token buckets, PTU sizing
   (base hypothesis 300–600 PTU for 60k mean + PayGo peak), LRU-bounded per-user pools with honest
   429 shedding.

4. **Day-one-on but cost-governed.** Keep everything-enabled-by-default; add the capacity/cost layer
   that makes it affordable: per-domain metering ledger, Azure Consumption budgets + near-real-time
   run-rate enforcement (soft=throttle elastic drivers, hard=gate cost-class; data/governance never
   throttled), enable-per-domain feature toggles storing **only deviations** from default-ON, and
   chargeback via the `loom-domain` tag. A fresh tenant sees no change.

5. **Migration-safe — incremental + reversible.** Every refactor / identity change ships behind a
   feature flag in **observe → shadow → enforce** order, reversible by flag flip or `git revert`.
   Named flags include `LOOM_OBO_DATA_PLANE`, `LOOM_PDP_ENFORCE`, `LOOM_ITEMS_BACKEND`,
   `LOOM_AOAI_GATEWAY` / `LOOM_AOAI_CLIENT_V2`, `LOOM_RESULT_CACHE`, `LOOM_QUERY_GOVERNOR`,
   `LOOM_RATELIMIT_MODE`, `LOOM_COSTGOV_ENFORCEMENT`, `LOOM_COSMOS_HA_MIGRATION`,
   `LOOM_SESSION_SLIDING_ENABLED`, `LOOM_ITEM_MANIFEST_REGISTRY`. The editor split is reversible via
   a re-export barrel (`git revert <sha>` per editor) — never a big-bang.

6. **No-vaporware / Web-5.0 / no-freeform-config / no-fabric-dependency hold.** Every new surface is
   real-backend end-to-end with a real-data E2E receipt; styled with Fluent v9 + Loom tokens,
   `TileGrid` / `EmptyState` / cards-with-elevation; configured by dropdowns/sliders/wizards (no JSON
   textareas); and **100% functional on the Azure-native path with no Fabric/Power BI workspace** —
   Fabric backends are opt-in only.

---

## 4. Code vs tenant-admin split (what Loom ships vs what the operator must do)

A material fraction of "done" is **outside the codebase** — Entra admin consent, source-engine GRANTs,
PTU/quota requests, Policy assignments, purge-protection. These ship as **scripts/runbooks + an honest
in-product gate** (Fluent MessageBar `intent="warning"` naming the exact env var / role / resource),
never as a silent failure.

**CODE (Loom ships it):** the AOAI gateway/chat client, PDP `evaluate()`, the data-access-mode resolver,
per-user token stores, the result cache + query governor + `middleware.ts`, the rate-limiter, the
metering ledger + enforcement engine, all Web-5.0 admin surfaces (cost cockpit, rate-limits wizard,
AI-capacity pane, DR/residency wizard, SLO board), the editor split + manifest registry + `rls-compiler.ts`
de-dup, the `/api/health/deep` + sliding-session refresh, all bicep modules.

**TENANT-ADMIN (operator runbook + honest gate):** delegated API permissions + admin consent for
`user_impersonation` on Storage/ADX/AAS (extend `grant-sql-delegated-permission.sh`); mapping Entra
groups → Synapse contained users + GRANT, Storage Blob Data Reader + ACLs, ADX viewers + RLS; PTU /
provisioned-managed quota requests (`aka.ms/oai/stuquotarequest` Commercial, `aka.ms/AOAIGovQuota` Gov);
Cosmos Cost-Management Reader RBAC per sub; Azure Policy `Modify` tag-backfill assignment; Front Door /
AppGW WAF rate-limit rule; KV purge-protection (irreversible — operator-confirmed in the DR wizard);
foreign-sub managed-PE approval; Entra Conditional Access sign-in-frequency. Each is cross-referenced
from a `docs/fiab/runbooks/*.md` and `docs/fiab/v3-tenant-bootstrap.md`.

---

## 5. Strategy & sequencing (why this order)

The phases are **dependency-ordered**, not priority-ordered — though the two largely agree.

1. **Phase 0 — Refactor foundation (unblocks everything).** Land the **one AOAI chat client**, the
   **`rls-compiler.ts` de-dup**, the **editor-split shared-helper extraction + first editors**, and
   the **P0 ops fixes** (token-refresh, `/api/health/deep`). These are pure/low-risk, kill the systemic
   AOAI bugs, and stop the 18k-line monoliths from blocking every later PR. Doing them first means the
   scale + security work lands in parallel without merge wars and with one place to add budgets/cache/quota.

2. **Phase 1 — Security foundation.** OBO data-plane (data-access-mode resolver + per-user token stores
   + report read path) and the multi-domain ACL PDP (composed `evaluate()` + OneLake RLS/CLS reconciler
   + protection-policy reconciler with sovereign-rbac default). This is the **defensible-security**
   backbone; everything downstream (caching keyed on principal digest, per-domain budgets, audit) depends
   on a real per-user identity + a real authorization decision.

3. **Phase 2 — Scale tier.** Cosmos Serverless→Provisioned-autoscale + hierarchical PK + indexing/TTL +
   state-offload; RLS-aware result cache + query governor + source-side concurrency policies; AOAI PTU +
   spillover + routing + token budgets; the rate-limiter substrate (`middleware.ts` + Redis + Cosmos
   counters). Built on the clean refactor base and keyed off the real identity from Phase 1.

4. **Phase 3 — Resilience & economics.** BCDR multi-region (Cosmos geo + PPAF, multi-region ACA + Front
   Door failover, ADLS/ADX/Synapse redundancy, data-residency-per-domain, RTO/RPO + drill tooling) and
   capacity/cost-governance (per-domain attribution, metering, budgets + enforcement, showback, the
   cost cockpit + Cost Copilot). These reuse the Phase-2 Cosmos-provisioned + metering substrate.

5. **Phase 4 — Ops maturity.** SLOs/SLIs/error budgets + multi-burn-rate alerts, load/soak harness for
   the 60k profile, observability (custom spans, RED metrics, per-domain dimensions, sampling), ACA/AOAI
   right-sizing, and the runbook/on-call set. Validates and protects everything below it.

The item-type **manifest registry** (domain 11) lands at the **Phase 0/1 seam**: the `rls-compiler` de-dup
and naming quarantine go in Phase 0; the declarative `ItemManifest` (which makes the editor carve and the
per-item RBAC/cost/cloud descriptor mechanical) lands alongside Phase 1 so the scale + cost layers can read
`manifest.rbac` / `manifest.costTier` / partition affinity.

See [`PHASES.md`](./PHASES.md) for the full kickoff-ready breakdown of each phase.

---

## 6. How to use this PRP

- **Operators / leads:** read §1–§5 here, then drive execution from [`PHASES.md`](./PHASES.md). Each
  phase has a one-line "kick off with" note and is independently startable once its dependencies are green.
- **Implementing agents:** open the phase you're assigned in `PHASES.md`, then the linked appendix for the
  file-level design. Honor the cross-cutting law (§3) and the code-vs-tenant split (§4) in every PR. Attach
  the real-data E2E receipt (no-vaporware) and a Commercial-and-Gov build/smoke note to every PR.
- **Reviewers:** reject any PR lacking the receipt, the feature-flag/reversibility note, or the dual-cloud
  handling; reject any default-path Fabric/Power BI dependency (no-fabric-dependency rule).

# PRP — Fabric + Databricks 2026 Parity ("Rival"): match, then beat, both platforms — on MAC and MAG

**Status:** DRAFT (execution-ready — 2026-08-18). Author: Claude Code, operator-directed.
**Operator mandate (verbatim intent):** *"make sure you are very detailed and provide all features
needed, include any custom tools, or services that would need to be built or used so it can work in
both MAC and MAG and can do all features at or better than Databricks and Fabric... if you need to
build something new from scratch to add it into Loom for full capabilities please do so, just make
sure scope, and plan it and it is secure by design... I want CSA-Loom to rival MS Fabric and
Databricks."*

**Origin & provenance:** two web-research agents (2026-08-18) enumerated Fabric announcements
Feb–Aug 2026 (Build 2026, FabCon, monthly feature summaries, roadmap) and Databricks announcements
through the June 2026 Data+AI Summit + Azure Databricks release notes, then cross-checked every
candidate against the live catalog (`lib/catalog/fabric-item-types.ts`, 142 types), the 486 parity
docs, and open issues before classifying anything a gap. Databricks full writeup:
`temp/databricks-gap-analysis-2026-08-18.md` (repo temp, 25KB). Every gap below is filed as a
GitHub issue (#3762–#3778) — this PRP is the plan that sequences them plus the net-new services
that don't reduce to a single issue.

---

## 1. Strategic thesis — where Loom wins

The research produced one finding that shapes everything else: **against Fabric, Loom is already at
near-parity breadth** (the 2026-08-15 gallery cross-check found 2 item-type gaps out of 60+, both
preview features, both filed) **and nothing Fabric shipped in 2026 requires Fabric to build** —
every gap has an Azure-native backend. **Against Databricks, the 2026 agentic/ingestion wave opened
real product-surface gaps** (Agent Bricks, Genie, Lakeflow Connect) that are whole missing
experiences, not missing rows.

The winning strategy is therefore **not** symmetric parity-chasing. It is:

1. **Fast-follow Fabric** (Wave A) — cheap, bounded, mostly "add a source type to an existing
   picker" work. Keeps the "Fabric experience without Fabric" claim airtight.
2. **Leapfrog Databricks where they cannot go** (Waves B–F) — Agent Bricks, Genie, and Lakeflow
   Connect's managed connectors are **largely unavailable in Gov clouds**. Loom shipping those
   experiences on Azure-native services in GCC-High/IL5 is not parity — it is a capability the
   competitor structurally cannot offer that audience. Gov-first AI is the rivalry story.
3. **Compound the moats Loom already has** (Wave G) — one console over the whole estate (vs.
   Fabric + Databricks + ADF Studio + four portals), policy-as-code across five engines,
   FinOps/FOCUS chargeback, gate-registry honesty, MCP-native admin, and — new here —
   **governed cross-boundary sharing (MAC↔MAG)**, which neither competitor offers at all.

"At or better" is scored per-capability in each wave's DoD: **parity** = the Fabric/Databricks
workflow works in Loom on Azure-native; **better** = at least one axis (Gov availability, connector
count, governance depth, single-console integration, honesty of failure states) exceeds the
competitor, named explicitly and demonstrated in the receipt.

---

## 2. Binding rules (die-hard, from `.claude/rules/` — restated because every wave cites them)

- `no-fabric-dependency.md` — Azure-native is the DEFAULT path; Fabric/Power BI strictly opt-in.
  Nothing below may call `api.fabric.microsoft.com` on the default path.
- `no-vaporware.md` — real backend + real-data E2E receipt per merge; honest gates only; bicep
  sync; docs are product.
- `auto-bind-by-default.md` — zero user-performed plumbing the platform could do itself; pickers
  over typed IDs; one-click provision with the bind form as fallback, never the default.
- `ux-baseline.md` — G1 browser E2E before "done" (both clouds for this PRP), G2 every gate has a
  Fix-it + gate-registry entry, G3 resizable panels; Fabric is the UX floor, not the target.
- `loom-no-freeform-config` — wizards/pickers/canvas; raw JSON only in the 1:1 expression-builder
  exception.
- Cloud portability (rule 5 of `docs/fiab/prp/README.md`) — Commercial / GCC / GCC-High / IL5,
  sovereign endpoint resolution via the existing `cloud-endpoints` layer, never a hardcoded host.

---

## 3. Per-cloud doctrine — MAC + MAG, verify-first

**Definitions used throughout:** MAC = Azure Commercial (`csa-loom.limitlessdata.ai` estate).
MAG = Azure Government; the live Gov estate is GCC-High (`csaloom-gov.limitlessdata.ai`); IL5
posture inherits GCC-High decisions per the existing compliance docs
(`docs/fiab/compliance/dod-il5.md`).

**Deploy-chain status (load-bearing for this whole PRP):** the Gov continuous-deploy fix landed on
`main` 2026-08-18 (`049349a9`, closing the root cause of #3730 — every Gov lane was dispatch-only).
**Task 0 of every wave: confirm the Gov estate is current before running its MAG receipts** (the
`/admin/readiness` staleness banner + `check-deploy-staleness.mjs` are the instruments). A wave's
MAG receipt taken on a stale estate is void.

**Availability matrix.** ✅ = anchored (service GA in Azure Government, used by Loom today or by
its bicep). ⚠️ = verify at wave start against the live Gov catalog (`az provider list` /
marketplace check from the Gov subscription) — do NOT assume from docs. Failing ⚠️ triggers the
named fallback, not a scope cut.

| Capability this PRP needs | MAC | MAG | Fallback if ⚠️ fails in MAG |
|---|---|---|---|
| ADX, Synapse, ADF, Event Hubs, Event Grid, Cosmos, ADLS, Key Vault, Functions, Container Apps, AI Search, Log Analytics | ✅ | ✅ | — (all in current Gov bicep) |
| Azure Databricks (jobs, UC, SQL warehouses, Lakebase) | ✅ | ✅ | — |
| Azure OpenAI (chat + embedding tiers) | ✅ | ✅ reduced model set | Model gateway (#3777) routes to the best available Gov tier; honest-gate the absent tiers with the exact deployment remediation |
| AOAI vision / frontier reasoning tiers | ✅ | ⚠️ | Gateway fallback chain → best Gov AOAI tier → optional self-hosted OSS endpoint (AKS GPU pool, operator-provisioned, off by default) |
| Azure AI Foundry Agent Service | ✅ | ⚠️ (the AIF PRP already flags this) | OSS Microsoft Agent Framework tier per `PRPs/active/next-waves/PRP-azure-ai-foundry-integration.md` — same contract, self-hosted runtime |
| Azure SignalR Service (Wave A Live Push) | ✅ | ⚠️ | ACA-hosted WebSocket relay (self-managed) — same client contract, more ops burden; decide at A4's Task 0 |
| Content Safety | ✅ | ⚠️ | Gateway-enforced prompt/output screening via AOAI-Gov moderation-capable models; honest-gate the delta |
| Graph API (SharePoint/OneDrive sources) | ✅ | ✅ `graph.microsoft.us` | Endpoint resolver already models this — no new pattern |
| GCP/BigQuery egress (Wave A mirroring) | ✅ | ⚠️ tenant egress policy | Honest gate naming the firewall/private-egress requirement; the feature ships dark until the tenant approves egress |

**Doctrine:** every new service in this PRP ships with a per-cloud capability report on
`/admin/readiness` (reusing the workload-readiness pattern) so MAG operators see exactly which legs
are live, gated, or fallback-served — self-aware degradation, never silent.

---

## 4. Competitive scorecard snapshot (2026-08-18)

| Front | Verdict | Evidence |
|---|---|---|
| Fabric item-type breadth | **Near-parity** — 2 gaps in 60+, both preview, filed (#3535, #3536) | 2026-08-15 gallery cross-check (#3527 Round 4) |
| Fabric 2026 in-type capabilities | **12 bounded gaps** — mirror sources ×3, event-refresh, CDC tap, dbt activity, SP-auth, notebook ×4, P2 tail | #3762–#3770 |
| Fabric "requires Fabric" bucket | **Empty** — every 2026 feature has an Azure-native answer | research pass, per-item backend column |
| Databricks 2026 wave | **2 of 14 areas covered** — agentic + ingestion surfaces missing entirely | `temp/databricks-gap-analysis-2026-08-18.md` |
| Databricks in Gov | **Their weakness** — Agent Bricks / Genie / Lakeflow Connect managed connectors largely Commercial-only | research pass; the leapfrog opening |
| Loom-only capabilities today | Policy-as-code (6 engines), gate registry + readiness, FinOps FOCUS, 100+ item single console, MCP admin plane, DuckLake/S3-gateway/Tapestry/AIP items | `MASTER-SCORECARD.md`, catalog |

---

## 5. Wave A — Fabric fast-follow (filed: #3762–#3770)

Bounded extensions to existing surfaces. Each is its own issue with acceptance criteria; this wave
adds only sequencing and the shared-infrastructure calls.

| Task | Issue | Scope anchor |
|---|---|---|
| A1 | #3762 BigQuery mirror source | `mirrored-database` sourceType + ADF BigQuery connector |
| A2 | #3763 Oracle mirror source | ADF Oracle connector + SHIR honest-gate → existing IR manager |
| A3 | #3764 Azure Monitor Logs mirror | LA export→EH→Eventstream (fast lane) / ADF batch lane |
| A4 | #3765 **Loom Live Push** (new small service) | SignalR (⚠️ MAG → ACA relay fallback) + Event Grid; signal-only channel |
| A5 | #3766 Mirror change-feed → Event Hubs | mirror editor toggle + auto-provisioned EH |
| A6 | #3767 dbt in-canvas pipeline activity | must round-trip to the real orchestrator (the #3549/#3700 lesson is binding) |
| A7 | #3768 Data-agent UAMI binding | Identity tab; also a Wave C prerequisite |
| A8 | #3769 Notebook 2026 bundle | runtime/pool pickers (durable #3530 fix), EH streaming source, Diagnose action |
| A9 | #3770 P2 umbrella | grooming-only in this wave; sub-issues feed later sprints |

**Sequencing inside the wave:** A4 first (Live Push is a platform primitive A3's fast lane and
future dashboard work ride); A1–A3 parallel after (three sourceType additions to one editor —
**coordinate as one lane** to avoid tripled merge conflicts in `mirrored-database` files); A5–A8
independent. **Better-than markers:** A3's ADX fast lane lands log rows queryable in seconds
(Fabric's equivalent is batch-oriented); A4's push primitive is estate-wide, not dashboard-only.

---

## 6. Wave B — **Loom Connect** (new service; epic #3773) — beat Lakeflow Connect

**The largest gap and the clearest exceed.** Lakeflow Connect: ~30 managed connectors, largely not
in Gov. Loom Connect: productize ADF's 100+ connectors (present in BOTH clouds today) behind a
managed-ingestion experience.

### Architecture
- **`managed-ingestion` item type** — the user-facing object: source, objects, schedule, health.
- **Connector registry** (new module, `lib/connect/registry.ts` + Cosmos `connect-connectors`) —
  declarative per-connector spec: auth kind (OAuth / key / Entra), discovery endpoints, object
  model, CDC capability, **egress domains** (see security), wizard schema. Tier-1 specs are
  hand-polished; Tier-2 generated from ADF connector metadata.
- **Ingestion runtime** — no new compute plane: the wizard compiles to real ADF pipelines +
  triggers (auto-provisioned, tagged `loom-connect/<connectionId>`), CDC via ADF where the
  connector supports it. Run telemetry normalizes into the existing Monitor hub.
- **Connection health service** (ACA job, scheduled) — probes credential validity, rate-limit
  posture, schema drift vs. last sync; drift lands as a diff review, never a silent re-map.

### Task list
| Task | Deliverable |
|---|---|
| B1 | Registry + item type + wizard shell (no connectors yet); gate-registry entries; bicep |
| B2 | Tier-1 slice 1: Salesforce + ServiceNow end-to-end (auth → discover → select → schedule → Bronze rows + Monitor history) |
| B3 | Tier-1 slice 2: SharePoint/OneDrive (Graph, both cloud endpoints — subsumes P2 umbrella sub-item 1), SQL family, REST/OData |
| B4 | Tier-1 slice 3: SAP + Workday (SHIR-dependent; honest-gate to IR manager) |
| B5 | Tier-2 generic wizard over remaining ADF connector metadata (the 100+ count claim becomes real here — publish the honest count on the catalog page) |
| B6 | Health/drift service + per-connection panel |
| B7 | MAG pass: per-connector egress gates, Gov endpoint variants, G1 receipts on the Gov estate |

### Security-by-design (threat model summary)
Assets: SaaS credentials, ingested data, egress map. Threats → controls: credential theft → Key
Vault only, write-only from UI, per-connection KV secret with UAMI access, never in ADF linked
service as plaintext (KV-referenced); over-broad egress → per-connector **egress allowlist
rendered on the connection page** (Gov operators must see exactly which SaaS domains are reached)
and recorded in the audit row at creation; data exfil via connector misuse → connections are
workspace-scoped, creation is a PDP-checked + audited action, DLP labels applied at Bronze landing
per existing protection policies; supply-chain (Tier-2 metadata) → generated specs are reviewed
artifacts in-repo, not runtime-fetched.

---

## 7. Wave C — **Loom Agent Foundry** (new service; epic #3771) — beat Agent Bricks

**Prerequisite:** the multi-agent spine of
`PRPs/active/next-waves/PRP-azure-ai-foundry-integration.md` (typed tool catalog, connected
agents, Knowledge Bases, Gov OSS Agent Framework fallback). This wave is the **builder layer** on
top — do not duplicate the spine.

### The experience
`agent-foundry` item type: operator writes a task brief in NL → Foundry assembles a candidate
agent (model tier via #3777 gateway; tools from the typed catalog, **default-deny allowlist**;
grounding from Knowledge Bases / Analysis Space exemplars) → auto-generates an eval set into the
existing `evaluation` item → runs bounded optimize loops (prompt/config variants scored against
evals, spend-capped via the budgets surface) → presents a scored leaderboard → operator promotes
the winner through an approval gate to a callable, UAMI-bound (#3768) endpoint.

### Task list
| Task | Deliverable |
|---|---|
| C1 | Item type + brief-to-spec assembler (gateway-routed; spec is a reviewed artifact, never silently executed) |
| C2 | Eval-set generation → `evaluation` item (depends on #3508/#3543 fixes landing first — the evaluation surface must stop requiring freeform IDs before Foundry writes to it) |
| C3 | Optimization loop runner (ACA job; variant budget + spend cap enforced by the gateway; all runs audited) |
| C4 | Promotion gate + endpoint publishing (UAMI identity, tool allowlist frozen at promotion, versioned; rollback = repoint, previous version retained) |
| C5 | MAG pass: AOAI-Gov tiers via gateway; Agent Framework runtime where Foundry Agent Service is ⚠️; G1 receipts on Gov |

### Security-by-design
Prompt injection via grounded data → tool allowlist default-deny + Content-Safety/gateway screen on
tool outputs + grounding scoped by PDP before the model sees schema; runaway spend → hard caps at
the gateway per agent AND per optimize-run; privilege escalation → the agent's UAMI gets exactly
the grounding-source roles, assigned at promotion, revoked at retirement (audited); eval gaming →
optimize loop never edits its own eval set (generation and optimization are separate, versioned
artifacts). **Better-than marker:** available in GCC-High; Agent Bricks is not.

---

## 8. Wave D — **Analysis Spaces** (epic #3772) — beat Genie

New `analysis-space` item type over the EXISTING NL engines (warehouse NL→SQL A, Azure SQL copilot
A, KQL copilot, cross-item orchestrator A). No new inference path — the product is curation,
scoping, sharing, and measurement.

| Task | Deliverable |
|---|---|
| D1 | Item type + curator flow: grounding pickers, instructions, certified example Q&A |
| D2 | Consumer surface (chat room UX; org-app embeddable for share-out; audience via workspace roles) |
| D3 | Server-side scope enforcement (PDP + RBAC before schema reaches any prompt; negative test is a DoD item) |
| D4 | Feedback → exemplar store; benchmark via `evaluation`; score trend on AI-operations quality tabs |
| D5 | MAG pass via gateway tiers; G1 receipts both clouds |

**Better-than markers:** spaces span engines (SQL + KQL + lakehouse in ONE space — Genie is
SQL-warehouse-centric); Gov availability; benchmark scores surfaced on the same admin quality plane
as everything else instead of a separate tool.

---

## 9. Wave E — Governed semantics: metrics + ontology (issue #3774 + umbrella sub-item 5)

| Task | Deliverable |
|---|---|
| E1 | `metric-definition` governed item: guided builder (pickers + expression-builder exception), certification workflow, lineage registration |
| E2 | Compile targets: UC metric views (Databricks REST) + semantic-model measures — one definition, both engines |
| E3 | Metrics endpoint for agents — Foundry (C) and Spaces (D) ground on certified KPIs; "same number everywhere" is the DoD demo |
| E4 | Auto-ontology wizard from semantic models (umbrella #3770 sub-item 5 lands here — reviewed proposal flow, never silent write) |

**Better-than marker:** one governed definition compiles to Databricks UC *and* the BI layer *and*
the agent layer — Databricks' metrics stop at their own boundary; Fabric IQ's stop at theirs.

---

## 10. Wave F — Trust & platform primitives (issues #3775, #3776, #3777, #3778)

| Task | Issue | Notes |
|---|---|---|
| F1 | #3777 **Model gateway** | Build FIRST in this wave — C and D consume it; migrates one existing copilot as its proof; fixes the #3743 class structurally (model attribution mandatory); hard cloud-boundary check (Gov call never routes to a Commercial endpoint, fail closed) |
| F2 | #3776 Governed secrets | Key Vault-backed scopes; runtime helper; write-only UI; audited reads |
| F3 | #3775 **OpenSharing** | Delta Sharing OSS server on ACA both clouds + native UC shares where Databricks present; recipient tokens hashed at rest, immediate revocation, IP allowlists; **cross-boundary MAC↔MAG shares behind a two-person approval** — the capability neither competitor has |
| F4 | #3778 Lakebase GA re-audit | Doc-first; follow-ups sized from the GA inventory; fold #3521 into the GA shape |

---

## 11. Wave G — Beyond parity (the "bad ass" wave — differentiators neither competitor can match)

These are creative scope, deliberately sequenced last: each becomes real only after its supporting
waves land, and each gets groomed into issues at wave start rather than pre-filed.

- **G1 — Cross-boundary estate.** One pane showing an org's MAC *and* MAG Loom estates
  (readiness, cost, sharing posture) with OpenSharing (F3) as the governed data bridge between
  them. Federal story: "your Commercial data science and your GCC-High mission estate, one
  governed platform." Neither Fabric nor Databricks spans that boundary at all.
- **G2 — MCP-native everything.** Loom already runs an MCP admin plane; extend it so every major
  item type exposes a governed MCP surface (the Eventhouse-MCP gap from the research generalized),
  making Loom the estate any external agent framework can drive — with the same PDP/audit
  enforcement as the UI. Databricks and Fabric are both racing here; Loom's advantage is the
  single-console breadth of what one MCP plane can reach.
- **G3 — Air-gap/IL5 posture pack.** The availability-matrix fallbacks (self-hosted Agent
  Framework, ACA relay push, OSS sharing server) assembled into a documented, bicep-deployable
  "sovereign profile" — the fully-disconnected story Commercial SaaS competitors structurally
  cannot tell. Builds on `docs/fiab/compliance/dod-il5.md`.
- **G4 — Honest-operations as a feature.** Gate registry + readiness + FinOps + the G2 Fix-it
  program, marketed as a first-class differentiator: Loom tells you what is NOT working and how to
  fix it — the research pass repeatedly found both competitors' consoles optimizing for green.
  Deliverable is a positioning doc + demo path, not new code.

---

## 12. Security-by-design — cross-cutting mandatory controls (every wave, every service)

1. **Identity:** Entra-only; every new service runs as a UAMI with least-privilege roles declared
   in its bicep module; no connection strings, no local auth anywhere (estates run
   `disableLocalAuth` — the Event Hubs lesson from `MASTER-SCORECARD.md` is binding).
2. **Secrets:** Key Vault only; write-only from UI; runtime resolution via UAMI; the F2 secrets
   service is the ONLY user-secret path — no new env-var advice to users, ever.
3. **Network:** private endpoints for every new Azure resource in the Gov profile (bicep params,
   not post-deploy hand-work); per-connector/per-share egress allowlists rendered in the UI and
   recorded in audit.
4. **Data governance:** PDP checks before data reaches any model prompt or share manifest; DLP
   labels applied at landing (B) and carried in share manifests (F3); workspace delete cascades
   cover every new Cosmos collection this PRP adds (recycle/purge included).
5. **AI safety:** all inference through the F1 gateway (central content screen, spend caps, cloud-
   boundary enforcement, prompt/response hash audit); agent tools default-deny; optimize loops
   cannot modify their own evals.
6. **Auditability:** every create/grant/sync/promotion/revocation writes the standard audit row
   WITH `kind`/`key` populated (the #3750 lesson — new writers must not repeat it).
7. **Review gates:** each new service (Live Push, Loom Connect, Agent Foundry, gateway,
   OpenSharing) gets a threat-model section in its design doc reviewed BEFORE build starts, and a
   security-labeled review issue at PR time. Anything touching cross-boundary sharing (F3, G1)
   additionally requires explicit operator sign-off before first deploy — two-key, not routine.

---

## 13. Sequencing & dependencies

```
Wave 0 (external): deploy-chain health — Gov CD fix landed (049349a9, 2026-08-18);
                   remediation PRP Wave 0 (#3676/#3713/#3714) still gates trustworthy rolls
   ↓
Wave A (parallel lanes) ──────────────► A4 Live Push early (primitive)
   ↓                                    A1–A3 as ONE mirror lane
Wave F1 model gateway ──► Wave C Agent Foundry ──► needs AIF-PRP spine + #3508/#3543 + A7
                     └──► Wave D Analysis Spaces (independent of C; can precede it)
Wave B Loom Connect (independent of C/D; start after A stabilizes the Monitor-hub patterns)
Wave E metrics (after D exists to consume it; E2's UC leg independent)
Wave F2–F4 (F3 after B's KV/egress patterns exist; F4 doc-first anytime)
Wave G (groomed only after its supporting waves land)
```

Hard dependencies restated: **C blocks on** the AIF integration PRP's spine, the evaluation-surface
fixes (#3508/#3543 — in the remediation PRP), A7, and F1. **D blocks on** F1 only. **B blocks on**
nothing but should follow A's first merges. **Every MAG receipt blocks on** a current Gov estate
(readiness staleness banner green).

Relationship to other active programs: the **remediation PRP**
(`PRPs/active/vv-sweep-remediation-2026-08-18/PRP.md`) fixes what exists; THIS PRP builds what's
missing. Where they touch the same file (evaluation surface, budgets dialog, mirror editor), the
remediation fix lands first — building new capability on a surface with a known open defect is how
half-fixed sibling patterns (#3753) get minted. Register this PRP in the finishline register
(`PRPs/active/finishline/AUDIT-2026-08-06.md` successor) at kickoff so it's in the authority chain.

---

## 14. Definition of Done (per wave, binding)

A wave is done only when, for every task in it:
1. **Real backend, both clouds** — the capability works against real Azure services on MAC **and**
   MAG, or carries an honest per-cloud gate naming the exact remediation, registered in the gate
   registry with a Fix-it (G2).
2. **G1 receipts on both estates** — live browser E2E (real data, screenshot/trace) on Commercial
   AND the Gov estate (estate confirmed current first). `tsc` + vitest + DOM strings are not done.
3. **Bicep sync** — every resource/env/role in `platform/fiab/bicep/**` + params for all four
   cloud profiles; drift is a vaporware violation.
4. **Security checklist §12 green** — including the threat-model review for new services.
5. **Docs** — parity doc (new or rev'd) per surface; `MASTER-SCORECARD.md` addendum row;
   competitor-comparison row updated in `PRPs/active/loom-competitive-audit-2026-07-20/PARITY-MATRIX.md`.
6. **Better-than marker demonstrated** where the wave claims one (named axis, shown in the
   receipt, not asserted).

---

## 15. Non-goals

- **Not** re-scoping the AIF integration PRP (Wave C consumes it as a prerequisite, delta-only).
- **Not** fixing the V&V-sweep defects — owned by the remediation PRP; ordering rule in §13.
- **Not** building a Fabric-API compatibility layer — `no-fabric-dependency` stands; parity is
  experience-level, not API-level.
- **Not** committing to self-hosted GPU inference as default — the AKS GPU fallback is an
  operator-opt-in profile (G3), never silently provisioned (cost + security posture).
- **Not** pre-filing Wave G issues — groomed at wave start when their foundations exist.
- **Not** a security/dependency audit of the existing estate (the 9 Dependabot alerts remain
  flagged in the remediation PRP's non-goals — separate work).

---

## 16. Backlog index

- **Wave A (Fabric fast-follow):** #3762 #3763 #3764 #3765 #3766 #3767 #3768 #3769 · #3770 (groom)
- **Wave B (Loom Connect):** epic #3773 → B1–B7
- **Wave C (Agent Foundry):** epic #3771 → C1–C5 (prereqs: AIF PRP, #3508/#3543, A7/#3768, F1)
- **Wave D (Analysis Spaces):** epic #3772 → D1–D5 (prereq: F1)
- **Wave E (Governed semantics):** #3774 → E1–E4
- **Wave F (Trust primitives):** #3777 (F1, build first) #3776 (F2) #3775 (F3, two-key) #3778 (F4)
- **Wave G (Beyond parity):** G1–G4, groomed at wave start
- **Evidence comment:** #3719 (Lakeflow 2026 additions — re-baseline at grooming)
- **Research artifacts:** `temp/databricks-gap-analysis-2026-08-18.md`; Fabric findings summarized
  in §4 and the per-issue bodies

**Total filed this pass: 17 issues (#3762–#3778) + 1 evidence comment; 4 net-new services scoped
(Live Push, Loom Connect, Agent Foundry, Model Gateway) + 2 platform planes (OpenSharing, governed
secrets) + 4 beyond-parity differentiators.**

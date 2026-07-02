# Release audit — dimension: fabric-parity

**Date:** 2026-07-02 · **Auditor:** release-audit subagent (fabric-parity dimension)
**Scope:** completeness of CSA Loom's Microsoft-Fabric parity vs Fabric's CURRENT
(mid-2026) experience list, verified against code in `apps/fiab-console` (not
docs), grounded on Microsoft Learn "What's new in Microsoft Fabric" (June 2026)
and Build 2026 announcements.

**Method:** read `PRPs/active/fabric-parity/` (README + PHASES + appendices/audits)
and `docs/fiab/parity/MASTER-SCORECARD.md` (363 parity docs in the folder);
enumerated Fabric's mid-2026 feature list from Learn (whats-new + whats-new-archive)
and Build 2026 coverage; grepped/read the console source to confirm or refute
coverage claims. Every claim below carries file:line evidence I actually read.

---

## 1. Overall assessment

Loom's Fabric-parity breadth is genuinely large and mostly real: the 12-domain
PRP inventoried ~110 gaps honestly, and a striking number of the "❌/D" rows in
that PRP have **since shipped** (verified in code): the ADX-native Activator
runtime (`lib/azure/activator-monitor.ts:29-98`), UDF + DAB execution hosts
bicep-wired day-one (`platform/fiab/bicep/modules/admin-plane/main.bicep:1972-1996`),
materialized lake views (`lib/azure/materialized-lake-view-engine.ts` + model +
tests), OneLake security roles (`lib/azure/onelake-security-client.ts`,
`onelake-rls-reconciler.ts`, `lib/panes/onelake-security/`), Iceberg⇄Delta
virtualization (`lib/azure/spark-format-detect.ts`, mirror-source-wizard Iceberg
test), SharePoint/OneDrive shortcuts (`app/api/lakehouse/shortcuts/sharepoint/`,
`lib/azure/graph-drive-client.ts`), open mirroring (`lib/azure/mirror-engine.ts`,
`app/api/items/mirrored-database/verify/route.ts`), HTAP mirroring on Azure SQL
(`app/api/items/azure-sql-database/[id]/mirroring/`), workspace monitoring
provisioner (`lib/install/provisioners/workspace-monitor.ts`), deployment
pipelines incl. a Loom-native path (`app/api/deployment-pipelines/{loom,git,arm,create}`),
Git branch-out (`app/api/admin/workspaces/[id]/git/branch-out/route.ts`), task
flows (`lib/clients/taskflow-client.ts`), variable library
(`lib/editors/phase4/variable-library-editor.tsx`), workload hub
(`lib/catalog/workload-hub.ts`), Fabric IQ (ontology / graph-model / data-agent
editors under `lib/editors/phase4/`), protection policies
(`app/api/admin/protection-policies/route.ts`), managed private endpoints
(`app/api/network/managed-private-endpoints/`), trusted workspace access
(`lib/components/network/trusted-workspace-access.tsx`), workspace identity
(dormant-additive, `lib/azure/workspace-identity-client.ts`), Delta Sharing
marketplace, Eventstream Kafka/Service Bus/MQTT sources
(`lib/components/realtime-hub/source-catalog.ts:75,167-170`).

The residual parity risk splits into four buckets:

1. **One live no-fabric-dependency violation** (Scorecard = Power-BI-workspace-gated,
   see F1) — the only surface found where the DEFAULT path hard-requires a
   Fabric-family (Power BI) workspace.
2. **Tracked-open core capabilities** that Fabric ships GA and Loom still lacks:
   unified job scheduler, warehouse time-travel/CLONE/restore/COPY INTO/snapshots,
   Data Wrangler, PREDICT, 4-of-9 AI functions, Airflow day-one host, SDK/Terraform.
   All are honestly tracked in `PRPs/active/fabric-parity/` — flagged here only
   where they are release-notable.
3. **Untracked mid-2026 Fabric additions** the PRP (authored 2026-06-26) predates
   or missed: tabbed multitasking + object explorer (GA Apr 2026), workspace
   outbound access protection (GA Mar 2026), mirrored-DB change feed → Eventstream
   (Build 2026), DeltaFlow CDC transformation, OneLake catalog search API/MCP/CLI,
   data agents in M365 Copilot (GA Jun 2026), AI-functions cost transparency in
   capacity metrics.
4. **Stale parity ledger**: both the PRP README scorecard and
   `docs/fiab/parity/MASTER-SCORECARD.md` no longer reflect the code — in BOTH
   directions — so the release cannot use them as the parity source of truth
   without a re-baseline.

---

## 2. Findings

### F1 (HIGH, fix) — Scorecard item hard-requires a real Power BI workspace; catalog copy contradicts the code; parity appendix marks it built

- The registered `scorecard` editor (`lib/editors/registry.ts:99` →
  `ScorecardEditor` in `lib/editors/phase3/scorecard-editor.tsx`) keys its ONLY
  workspace picker on real Power BI groups: `usePowerBiWorkspaces()`
  (scorecard-editor.tsx:51-89, `fetch('/api/powerbi/workspaces')` at :60). With
  zero PBI workspaces the picker disables and renders *"No Power Bi workspaces —
  The Console service principal can't see any Power BI workspaces. Create one …
  in Power BI"* with an **Open Power BI** button (scorecard-editor.tsx:116-131).
  There is no Cosmos/Azure-native fallback path (grep for `loom-native|fallback`
  in the file: only comments, :7-9, :590).
- The BFF route is Power BI REST: `app/api/items/scorecard/route.ts:8`
  `import { listScorecards, PowerBiError } from '@/lib/azure/powerbi-client'`.
- `.claude/rules/no-fabric-dependency.md` explicitly says *"Power BI counts as
  Fabric-family — a 'real Power BI workspace' requirement is also a violation."*
  Contrast: the sibling `dashboard-editor.tsx` does this correctly — it loads a
  Cosmos overlay by Loom item id with "NO Power BI / Fabric workspace required"
  (dashboard-editor.tsx:8-9, :98-107) and only uses PBI for the opt-in embed/pin
  path.
- **Doc contradictions:** the catalog copy says the opposite of the code —
  `lib/catalog/item-types/power-bi.ts:108-111` declares `noRestApi: true` and
  *"no Fabric REST API for scorecards today, so in Loom this is metadata-only"*,
  while the route calls PBI REST; and
  `PRPs/active/fabric-parity/appendix-power-bi.md:76` marks row 33 "Scorecards +
  manual goals" ✅ built.
- **Fix:** give scorecard the dashboard-overlay treatment — Cosmos-native goal
  store + rollup/status engine as DEFAULT (the rollup math is already local per
  the editor header :7-9), with Power BI scorecard sync as the opt-in leg; align
  the catalog copy and the appendix row.

### F2 (HIGH, add — tracked P7 ❌, release-notable) — No unified job scheduler

Fabric's job scheduler (schedule any item, exit values, failure notifications —
Notebook Public APIs GA Mar 2026 lean on it) has no Loom equivalent. The whole
API tree has exactly two schedule surfaces:
`app/api/items/semantic-model/[id]/refresh-schedule/` and
`app/api/notebook/[id]/schedule/` (verified via `find app/api -type d -name "*schedule*"`).
Pipelines schedule via native ADF triggers, but there is no cross-item schedule
store, no "scheduled runs" view, no exit-value orchestration. Tracked as
`PRPs/active/fabric-parity/README.md:184` ("Unified Job Scheduler + schedule
store | ❌ | P7"). For a public release positioned as a Fabric replacement this
is the most conspicuous platform-primitive gap.

### F3 (HIGH, add — tracked P3, release-notable) — Warehouse lacks time travel, zero-copy CLONE, restore points, COPY INTO, snapshots

`app/api/items/warehouse/[id]/` contains only `cancel, iqy, model, query,
query-acceleration, schema, script-out` (directory listing verified) — none of
the PHASES.md Phase-3 warehouse routes
(`clone,history,restore-points,restore,copy-into,retention,snapshot,security,share,query-insights`,
PHASES.md:209) exist. These are GA Fabric Warehouse basics (CLONE TABLE and
restore points GA since 2024; MERGE GA Jan 2026 per Learn whats-new-archive;
warehouse snapshots GA 2025). Tracked at README.md:146-149 (all ❌ → P3). The
delta-side time travel exists in lakehouse surfaces
(`lib/editors/lakehouse/lakehouse-editor-shell.tsx`,
`lib/editors/components/delta-maintenance-dialog.tsx` matched
`TIMESTAMP AS OF|time.travel`), so the warehouse gap is the SQL-endpoint UX.

### F4 (HIGH, add — tracked P3/P5) — Data Wrangler absent entirely

`grep -riE "wrangler"` over `apps/fiab-console/{lib,app}` returns **zero files**.
Fabric's Data Wrangler (no-code EDA + PySpark/pandas codegen, in both DE and DS)
is a flagship, demo-defining surface. Tracked at README.md:141 (❌ → P3/P5) and
PHASES.md Phase-3/Phase-5. Not broken (nothing pretends to be it), but a
missing core capability for a parity-claiming release.

### F5 (MEDIUM, update) — The parity ledger is stale in BOTH directions; release cannot trust it without a re-baseline

- **Understates (shipped but still marked ❌/D):**
  README.md:170 marks "Workspace identity" ❌ — but
  `lib/azure/workspace-identity-client.ts:1-20` ships it (dormant-additive with
  bicep `landing-zone/workspace-identity.bicep`); README.md:176 marks
  "Protection policies" D — but `app/api/admin/protection-policies/route.ts:1-10`
  is a real sovereign-RBAC engine with reconcile; README.md:179 marks "Managed
  private endpoint self-service" ❌ — but `app/api/network/managed-private-endpoints/`
  exists; README.md:156 marks the Activator runtime D — but
  `lib/azure/activator-monitor.ts:29-98` has the ADX/Eventhouse path; README.md:183
  marks UDF execution D "no host" — but `admin-plane/main.bicep:1984-1996` deploys
  `udf-runtime` day-one and the invoke route resolves `LOOM_UDF_FUNCTION_BASE`
  (invoke/route.ts:1-24); same for DAB (main.bicep:1972).
- **Overstates (claims vs code):** F1's appendix-power-bi.md:76 ✅ scorecard row;
  and `docs/fiab/parity/MASTER-SCORECARD.md:491` is last-updated 2026-06-10
  (rev.6, "≈49% built") — roughly 70 console revisions ago per the memory ledger.
- **Fix:** run one re-baseline pass over `PRPs/active/fabric-parity/README.md` §3
  and `MASTER-SCORECARD.md` before release; the per-surface docs
  (`docs/fiab/parity/*.md`, 363 files) carry dated rev-notes and are the more
  trustworthy layer.

### F6 (MEDIUM, add — untracked) — Tabbed multitasking + object explorer (Fabric GA Apr 2026) has no Loom equivalent and is not in the PRP inventory

Fabric GA'd tabbed multitasking across items + a cross-workspace object explorer
pane (Learn whats-new-archive, April 2026). `grep -rE "multitask|openTabs|tabStrip"`
over `lib/components` finds nothing relevant (only global-job-toaster/pipeline
panels), and `grep -il multitask PRPs/active/fabric-parity/*.md` returns no file.
Loom's navigation is route-per-item; there is no way to hold several items open.
This is a platform-UX parity gap the PRP never inventoried.

### F7 (MEDIUM, add — untracked) — Workspace outbound access protection (OAP, Fabric GA Mar 2026) unbuilt and untracked

Fabric GA'd workspace-level outbound access protection for Warehouse (data-
exfiltration connector rules; Learn whats-new-archive March 2026).
`grep -il "outbound access" PRPs/active/fabric-parity/*.md` returns nothing; code
hits for `outbound|exfiltration` are unrelated networking surfaces
(`lib/clients/networking-client.ts`, `lib/components/network/network-pane.tsx`).
Loom has the *inbound* story (managed PEs, trusted workspace access) but no
workspace-scoped outbound allow-list. Azure-native equivalent would be NSG/
Firewall egress rules + Synapse outbound firewall surfaced per-workspace.

### F8 (MEDIUM, add — tracked P5) — AI functions still 5 of 9 (+ June 2026 additions unaddressed)

`lib/azure/ai-functions-client.ts:44-52`: `AiFn = 'summarize'|'classify'|
'sentiment'|'extract'|'translate'` — missing `ai.similarity`, `ai.fix_grammar`,
`ai.generate_response`, and embeddings. Fabric additionally GA'd (June 2026)
gpt-5-mini-default AI functions with usage/cost statistics. Tracked at
README.md:154 ("C (5/9) → P5").

### F9 (MEDIUM, update — tracked P1) — Airflow job is BYO-webserver only; Fabric provisions the Airflow environment for you

`app/api/items/airflow-job/[id]/connection/route.ts:1-9`: *"Persists the
tenant-supplied Airflow webserver URL"* — the item works only if the operator
already runs an Airflow somewhere. PHASES.md Phase-1 (:115-120) specifies the
OSS-Airflow-on-ACA day-one host (`airflow.bicep`), which does not exist yet
(no `airflow` module under `platform/fiab/bicep/modules/admin-plane/`). The
editor + DAGs/task-logs routes are real once connected
(`app/api/items/airflow-job/[id]/{dags,task-logs}/`), so this is an honest gate,
but it is NOT the day-one-ON bar the PRP set (README §2.3).

### F10 (MEDIUM, add — tracked P5) — PREDICT guided batch scoring absent

`grep -E "PREDICT|predict-wizard|batch.scor"` over `lib/editors` returns zero
files. Fabric's PREDICT (apply an MLflow model to a table from the model page)
is a core DS workflow. Tracked README.md:152 (❌ → P5). ml-model/ml-experiment
editors exist (memory: catalog drive 06-29) but no scoring wizard.

### F11 (MEDIUM, update — partially built) — Item "sharing" is share-LINK tokens; the Fabric grant-people-permissions dialog is only partially evidenced

`app/api/items/[type]/[id]/share/route.ts:1-9` implements signed read-only share
links (generate/list/revoke) — Fabric's "Share" additionally grants direct
user/group permissions with reshare/edit checkboxes. `lib/azure/item-permissions-client.ts`
and `item-permissions-model.ts` exist, so the grant plane may be wired elsewhere,
but I found no `[type]/[id]/permissions` route in the generic tree. PRP marks
item sharing D → P4 (README.md:178). Verify the people-grant dialog end-to-end
before claiming this row closed; otherwise the share affordance overstates.

### F12 (LOW, add — untracked, post-PRP) — Mirrored-database change feed → Eventstream connector (Build 2026) missing

Build 2026 shipped streaming a mirrored DB's Delta change feed into Eventstream.
`grep "changefeed|change-feed|changeFeed" lib/azure/mirror-engine.ts` → no hits.
Loom's mirror engine lands Bronze Delta but exposes no CDC-stream-out to the
Event Hubs/ASA eventstream path. Azure-native equivalent: Delta CDF read job →
Event Hubs producer.

### F13 (LOW, add — untracked) — DeltaFlow CDC-flattening Eventstream transformation (Mar 2026 preview) not present

Fabric Eventstream added DeltaFlow (flatten Debezium CDC JSON to tabular rows).
No `deltaflow|DeltaFlow` hits in the console (checked alongside F12 greps in
`lib/azure` + realtime-hub components). Loom's ASA-based operator set predates
it. Plausible-severity: preview feature, but it is the CDC-to-RTI glue.

### F14 (LOW, add — untracked) — OneLake catalog search API / MCP tool / CLI `fab find` equivalents unverified

Fabric (Mar 2026) shipped a cross-workspace catalog search REST API, an MCP
tool, and `fab find`. Loom has catalog/marketplace search UI and an IQ MCP
(`lib/azure/iq-mcp.ts`, `iq-mcp-tools.ts` — which does reference eventhouse/
kusto tools), plus `apps/loom-cli`, but I found no estate-wide item-search MCP
tool or CLI `find` command. Cheap to add over the existing Cosmos catalog
query.

### F15 (LOW, add — untracked) — Data agents publishable to Microsoft 365 Copilot (GA Jun 2026) has no Loom analogue

Loom's data-agent (`lib/editors/phase4/data-agent-editor.tsx`,
`lib/azure/data-agent-execute.ts`) answers in-console; Fabric data agents are now
consumable inside M365 Copilot with admin-managed publishing. Loom's
Copilot-Studio family covers external channels for Studio agents but the
data-agent item has no publish-to-Teams/M365 path. Low for a sovereign-first
release; note it as a roadmap row.

### F16 (LOW, add — tracked P7) — No published SDK or Terraform provider

`packages/` contains no `loom-sdk-*` (only `apps/loom-cli`, `apps/loom-skills`
exist). Tracked README.md:187 (❌ → P7). Fabric ships REST + fab CLI + Terraform
provider + Python SDK. Loom's REST + CLI exist; SDK/Terraform remain roadmap.

### F17 (LOW, informational) — GPU-accelerated Warehouse (Build 2026): Loom's positioning is Photon/Databricks SQL acceleration — document it

Fabric's headline Build-2026 warehouse feature is engine-level GPU acceleration.
Loom's equivalent lever is the query-acceleration path on Databricks SQL/Photon
(commit 17dde899 "report accel on Databricks SQL/Photon (Azure-native)";
`app/api/items/warehouse/[id]/query-acceleration/` exists). No action beyond
positioning docs — engine internals are not replicable — but the parity docs
should claim the equivalent honestly rather than staying silent.

---

## 3. Verified-built highlights (no action; regression baseline)

| Fabric capability (mid-2026) | Loom evidence (read) |
|---|---|
| Materialized lake views (preview '25) | `lib/azure/materialized-lake-view-engine.ts`, `-model.ts` + tests; catalog `item-types/data-engineering.ts` |
| OneLake security / data-access roles (GA May '26) | `lib/azure/onelake-security-client.ts`, `onelake-rls-reconciler.ts`, `lib/panes/onelake-security/`, `onelake-security-tab.tsx` |
| Iceberg ⇄ Delta / Iceberg shortcuts | `lib/azure/spark-format-detect.ts`, `lib/editors/components/__tests__/mirror-source-wizard-iceberg.test.tsx`, appendix-onelake.md:124 (UniForm) |
| SharePoint/OneDrive shortcuts (GA Build '26) | `app/api/lakehouse/shortcuts/sharepoint/`, `lib/azure/graph-drive-client.ts` |
| Open mirroring + mirroring breadth | `lib/azure/mirror-engine.ts`, `open-mirror-config.tsx`, `app/api/items/mirrored-database/verify/route.ts`; HTAP `azure-sql-database/[id]/mirroring` |
| CDC in Copy job (GA Jun '26) | copy-job E2E proven (memory 06-25); `mirror-engine.ts` CDC paths |
| Eventstream Kafka / Service Bus / MQTT (+mTLS KV certs) | `lib/components/realtime-hub/source-catalog.ts:75,167-170`, `app/api/realtime-hub/keyvault-certificates/route.ts` |
| Activator on real-time (Eventhouse) data | `lib/azure/activator-monitor.ts:29-98` ADX Run-KQL runtime |
| Workspace monitoring | `lib/install/provisioners/workspace-monitor.ts`, `app-workspace-monitoring.ts` bundle |
| Deployment pipelines + Git branch-out | `app/api/deployment-pipelines/{loom,git,arm,create,[id]}`, `app/api/admin/workspaces/[id]/git/branch-out/route.ts`, `lib/panes/git-integration.tsx` |
| Domains / task flows / folders / variable library / workload hub | `lib/azure/domain-registry.ts`, `lib/clients/taskflow-client.ts`, `lib/panes/folders.tsx`, `lib/editors/phase4/variable-library-editor.tsx`, `lib/catalog/workload-hub.ts` |
| Capacity metrics + chargeback + surge | `app/admin/usage-chargeback/page.tsx`, `lib/azure/cost-management-client.ts` (surge) |
| Fabric IQ: ontology / graph model / data agent | `lib/editors/phase4/{graph-model-editor,data-agent-editor}.tsx`, `lib/azure/weave-ontology-store.ts`, `iq-mcp-tools.ts` |
| UDF + GraphQL (DAB) execution day-one | `admin-plane/main.bicep:1972-1996` (dab-runtime, udf-runtime), `user-data-function/[id]/invoke/route.ts:1-24` |
| Protection policies / managed PE / trusted access / workspace identity | `app/api/admin/protection-policies/route.ts`, `app/api/network/managed-private-endpoints/`, `trusted-workspace-access.tsx`, `workspace-identity-client.ts` (dormant) |
| External data sharing (cross-tenant) | Delta Sharing marketplace (`app/api/marketplace/sharing/shares`, memory PR #1578) |
| Monitoring hub | `lib/panes/monitor-hub.tsx` (Schedule-failures handled via Alerts tab by documented decision, :18-21) |
| Digital twin builder | tracked partial → maps to ontology/Weave (appendix-real-time-intelligence.md:121,142) |

## 4. Grade rationale

**B.** Breadth is real and largely code-verified — including most of the
May/June-2026 Fabric GA list (OneLake security roles, Eventstream connectors,
CDC copy, materialized lake views, workload hub). The deductions: one live
no-fabric-dependency violation on a shipping item (Scorecard), several GA-in-
Fabric core capabilities still missing (job scheduler, warehouse time-travel/
clone/restore, Data Wrangler), a handful of untracked 2026 additions, and a
parity ledger stale enough that it can't serve as the release's evidence base
without a re-baseline pass.

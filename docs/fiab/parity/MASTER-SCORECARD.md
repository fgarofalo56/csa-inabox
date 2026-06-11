# CSA Loom -> Azure Parity Master Scorecard

> **Synthesized from 12 per-service deep-functional audits (2026-05-31).** Each
> source audit clicked every control on the live Loom surface and compared it
> feature-for-feature against the real Azure portal / Fabric UI per
> `.claude/rules/ui-parity.md`. Grades use the `no-vaporware.md` rubric
> (F vaporware / D stubbed / C functional-but-rough / B production-grade /
> A tested / A+ tested+documented+bicep-synced).
>
> **Note on filename:** the per-service Fabric metrics-scorecard parity doc
> already occupies `scorecard.md` in this folder; on a case-insensitive
> filesystem `SCORECARD.md` would clobber it, so this master synthesis lives at
> `MASTER-SCORECARD.md`.
>
> **Capability counts are honest, not aspirational.** "Built" = real control +
> real backend. "Partial" = renders but thin or read-only where Azure is rich.
> "Gated" = honest infra/preview MessageBar (allowed). "Missing" = the Azure
> capability has no Loom surface at all.

## Scorecard

> **⚠️ rev.2 (2026-06-01) — grades re-audited UPWARD against current code.**
> The rev.1 grades below the table's count columns predate a build wave that
> shipped 12 parity features (Databricks cluster/warehouse edit, SQL navigator,
> Cosmos Items Data Explorer, AI Search field designer + search explorer, ADX
> results grid + DB policies, APIM OpenAPI import + operations authoring, Event
> Hubs Send, AI Foundry Agents, Power BI governance, Power Platform env
> lifecycle). Each per-service doc was re-read against the real editor on
> 2026-06-01 and corrected (see each `<slug>.md` rev.2 note). **The Grade column
> is current. The Built/Partial/Gated/Missing count cells are NOT yet
> recomputed — trust the per-service docs for exact counts.** Two surfaces (AI
> Search field designer + search explorer; Cosmos Items Data Explorer) were
> additionally verified LIVE via Playwright against the deployed console with a
> real authenticated session (real index fields; real `2.25 RU` Cosmos
> data-plane request charge).

| Service | Grade (rev.2) | was | Top gaps still open (highest-impact first) |
|---|:--:|:--:|---|
| Azure Databricks | **A** | B | Unity Catalog is read-only (no create/GRANT/lineage); DLT/Lakeflow editor; Repos branch ops; cluster Policy + Access-mode (UC gate); Job Repair-run |
| Azure AI Search | **B** | C | Indexer scheduling + run history + field/output mappings; semantic-config & vector-profile *designers* (JSON-only today); scoring-profile/analyzer designers; Import-data wizard; service-stats panel; Keys/Identity/Networking/Monitoring admin |
| Azure Cosmos DB | **B-** | C | Stored-proc/trigger/UDF authoring + execute; account blades (Keys/Geo/Consistency/Backup/Networking); write-path Scale/Settings/Indexing editors; bulk upload; query save/multi-tab |
| Power BI / Fabric semantic | **B-** | C | Workspace content grid + Lineage view; sensitivity labels (honestly omitted — no public apply REST); Subscriptions; App publishing/capacity; data-source credential sign-in; in-browser report authoring |
| Azure API Management | **B-** | C | Form-based policy editor + effective-policy + fragments; subscription key reveal/regenerate + state; named-value secret reveal + KV refs; versions/version-sets; whole portal blades (Dev portal, Users, Groups, Certs, Monitoring, Networking) |
| Azure AI Foundry | **C+** | C | Fine-tuning (submit/monitor/deploy); templates gallery; observability/trace dashboards; 7-of-8 playgrounds deep-link only; agent depth (knowledge/memory/guardrails attach, publish/versioning, evals) |
| Azure Data Explorer (Kusto) | **C+** | C | Cluster lifecycle/scale/start-stop + create/delete; RBAC (cluster + database) principal mgmt; RLS authoring (tooltip-only); grid group-by/pivot/full-profile; Open-in-Excel / Query-to-Power-BI / share-link |
| Azure SQL Database | **C+** | C | Compute & storage scale (no update route); backups/PITR/geo-restore/LTR; copy/export-import bacpac + results export; Networking/TDE/Defender/Auditing + monitoring; geo-replication failover (add-only today) |
| Power Platform | **C** | C | Copy/Backup-Restore/Reset/Convert/History (honest admin-gates); Managed Environments + groups; 7-of-8 admin-center areas; all maker authoring (canvas/flow/Pages/table/connector — deep-linked, forbidden as parity); App Share |
| Azure Data Factory | **C** | C | Mapping Data Flow visual designer (flagship, absent — the React Flow canvas is pipeline-only); Copy Data Tool wizard; Add-Dynamic-Content expression builder; source control/Publish/ARM; connector galleries + Test Connection; factory Monitor hub |
| Azure Synapse Analytics | **C** | C | Synapse notebook authoring editor (absent); unified Studio shell + Publish/Git; data-flow visual designer; data-hub lake browser; Monitor-hub drill grids; SQL results export/chart; Manage-hub surfaces |
| Azure Event Hubs | **C** | D | Data Explorer View/receive (honest AMQP dependency-gate — allowed); SAS keys/connection-string copy; Capture authoring; Scale/Auto-inflate; namespace Overview blade + metrics; IAM/Networking/Geo-DR |

**Grade distribution (rev.2):** 1 × A, 4 × B/B-, 3 × C+, 4 × C. Zero D, zero F.
Up from rev.1's 1 × B / 10 × C / 1 × D. The shift is real built code (every ✅
flip was verified by reading the route handler back to a real Azure REST/data-
plane call), not re-scoring — but **every service still has genuine missing
breadth**, and no service is yet at the `ui-parity.md` A+ bar (full inventory
built). The headline gaps that remain are the heavy designers: ADF/Synapse
Mapping Data Flow + notebook authoring, Databricks Unity Catalog write surface,
and the per-service admin blades.

> The rev.1 capability counts (192 built / 102 partial / 31 gated / 255 missing
> across 580 inventoried) are preserved below for history but understate the
> current built total by ~40–60 capabilities (the 12 shipped features). A full
> recount is tracked as follow-up.

## rev.6 — Wave-8→11 re-audit + count recompute (2026-06-10, audit-T31)

> **This rev closes the standing parity-doc gap (audit-T31).** A full build
> cohort (PRs #1054–#1123) landed *after* both the 2026-05-31 per-service audits
> and the 2026-06-10 reconciliation (`docs/fiab/prp/AUDIT-2026-06-10.md`),
> implementing exactly the gaps those ledgers flagged as audit-T08…T28. Each
> per-service doc was re-read against the current editor/route/client and given a
> dated rev-note; the deferred Built/Partial/Gated/Missing recount (the rev.2
> "NOT yet recomputed" caveat) is done below. Every ❌→✅ flip was verified by
> reading the surface back to a real Azure REST / data-plane / ARM call (no
> commit-message trust); genuinely-remaining gaps stay ❌/⚠️ honestly.

### Wave-8→11 gap-closure map (audit-T → closing PR → verified surface)

| audit-T | Gap (from AUDIT-2026-06-10) | Closing PR | Verified surface |
|---|---|---|---|
| T08 | Cosmos stored-proc/trigger/UDF authoring + execute | #1062 | `cosmos-script-editor.tsx` (+ test) |
| T09 | APIM subscription state + key regen | #1063 | `apim-editors.tsx`, `apim-client.ts` (+ `apim-subscriptions.test.ts`) |
| T14 | Power BI paginated report in-place embed + export | #1068 | `phase3-editors.tsx` paginated embed |
| T16 | Azure SQL schema/object browser | #1070 | `azure-sql-editors.tsx` browser |
| T17 | EventhouseEditor "New dashboard" ribbon | #1072 | `phase3-editors.tsx` dashboard create |
| T18 | Databricks UC write-path + DLT/MLflow/Serving + lineage | #1073 | `databricks-client.ts`, `databricks-editors.tsx` |
| T19 | AI Foundry fine-tuning / evals / tracing / playgrounds | #1078 | `foundry-client.ts`, `foundry-cs-client.ts` |
| T20 | ADX cluster lifecycle + RBAC principal mgmt + RLS | #1076 | `kusto-client.ts` (+ `kusto-rbac-rls.test.ts`) |
| T21 | Event Hubs Capture / Geo-DR / SAS rotation / private endpoints | #1075 | `eventhubs-namespace-editor.tsx` + 4 routes |
| T22 | AI Search indexer scheduling + semantic/vector designers + debug | #1077 | `ai-search-tree.tsx`, `search-field-shapes.ts` (+ tests) |
| T24 | SQL DB keys & constraints inline designer | #1081 | `sqldb-tree.tsx`, scale tab #948 |
| T25 | Synapse KQL scripts + Spark job defs in workspace tree | #1084 | `synapse-workspace-tree.tsx` |
| T26 | ADF Change Data Capture (preview) REST | #1080 | `factory-resources-tree.tsx`, CDC editor |
| T27 | Cosmos conflict-resolution policy | #1083 | `cosmos-policy-editors.tsx` (+ test) |
| T28 | Power Platform maker authoring (canvas/flow/table) | #1086 | in-Loom Dataverse/BAP authoring |

### Re-graded 12-service scorecard (rev.6)

| Service | Grade (rev.6) | rev.2 | What moved it (verified PR) |
|---|:--:|:--:|---|
| Azure Databricks | **A** | A | UC-write asterisk cleared (#1073, #1040); UC sub-doc → B+ |
| Azure SQL Database | **B+** | C+ | scale (#948) + schema browser (#1070) + keys/constraints (#1081) + FT/vector (#1106) + migration (#1098) + Query Store dash (#938) |
| Azure Cosmos DB | **B+** | B− | scripts (#1062) + conflict-res (#1083) + container CRUD/scale (#944) + Gremlin (#952) + keys (#956) + metrics (#957) |
| Azure AI Search | **A−** | B | indexer scheduling + semantic/vector designers + debug (#1077); explorer B+ sub-doc |
| Azure API Management | **B** | B− | subscription state + key regen (#1063) |
| Azure Data Explorer (Kusto) | **B** | C+ | cluster lifecycle + RBAC + RLS (#1076) + Eventhouse dashboard (#1072) + AI tile (#1114) |
| Azure AI Foundry | **B−** | C+ | fine-tuning + evals + tracing + Images/Audio playgrounds (#1078) |
| Power BI / Fabric semantic | **B** | B− | paginated embed (#1068) + Model view (#934) + DAX measures (#980) + column editor (#984) + Direct-Lake (#969) |
| Azure Event Hubs | **B−** | C | namespace editor: Capture + Geo-DR + SAS reveal/rotate + private endpoints (#1075) |
| Azure Data Factory | **B−** | C | Mapping Data Flow sub-doc (B−) + CDC preview (#1080, #1108) |
| Azure Synapse Analytics | **B−** | C | notebook sub-doc (B−) + KQL/Spark-job-def tree (#1084) + datamart migration (#978) |
| Power Platform | **B−** | C | in-Loom maker authoring cures deep-link-as-parity (#1086) + attributes admin (#907) |

**Grade distribution (rev.6):** 1 × A, 1 × A−, 5 × B/B+, 5 × B−. **Zero C/C+,
zero D, zero F** — up from rev.2's 1 A / 4 B / 3 C+ / 4 C. Every per-service doc
now carries a dated rev-note and **the only remaining ❌ rows are genuine missing
breadth** (admin/management blades, the unified Synapse Studio shell, heavy
designer breadth), explicitly disclosed — not stale.

### Recomputed capability counts (supersedes the deferred rev.1 numbers)

The 14 closed audit-T gaps plus the rev.3 sub-surfaces add **≈ 95 newly-built
capabilities** to the rev.1 baseline of 192. Recomputed honest totals across the
~580 inventoried capabilities: **≈ 287 built (49%) / ≈ 78 partial (13%) / ≈ 33
gated (6%) / ≈ 182 missing (31%)**. Loom has moved from "roughly one-third built"
to **roughly half built**; the residual third is dominated by per-service
management blades (IAM/Tags/Locks/Metrics/Diagnostics) and a few flagship
designers (Synapse unified Studio, full ADF connector galleries). The
"backend-exists-but-UI-doesn't-call-it" quick-win backlog that dominated rev.2 is
now largely consumed by the Wave-8→11 wiring PRs.

### Companion doc sets (PRP-15/16/17/18) — verified complete

- **PRP-16 Deployment** (`docs/fiab/deployment/`): 11 pages incl. per-cloud
  `commercial.md` / `gcc.md` / `gcc-high.md`, `azd-cli.md`, `deploy-button.md`,
  `marketplace.md`, `multi-sub-multi-tenant.md`, `upgrade.md`, `quickstart.md`,
  `pipelines/`. Placeholder-clean. ✅
- **PRP-17 Operations** (`docs/fiab/operations/`): 9 pages incl. `monitoring.md`,
  `cost.md`, `capacity-management.md`, `disaster-recovery.md`,
  `app-install-provisioning.md`, `persistence-chargeback-multidlz.md`,
  `forward-to-fabric.md`, `upgrade-migration.md`. Placeholder-clean. ✅
- **PRP-18 Compliance** (`docs/fiab/compliance/`): 11 pages incl.
  `nist-800-53-rev5-fiab.md`, `cmmc-2.0-l2-fiab.md`, `dod-il5.md`, `itar-fiab.md`,
  `hipaa-security-rule-fiab.md`, `feature-boundary-matrix.md`, and per-cloud
  `commercial.md` / `gcc.md` / `gcc-high.md`. Placeholder-clean. ✅
- **PRP-20 Tutorials** (`docs/fiab/tutorials/`): 01–08 rewritten (#772, #779). ✅

These three companion sets need no authoring work; audit-T31's standing gap was
the per-service parity-doc staleness, closed by this rev.

---

## Deepened sub-surfaces (rev.3 — 2026-06-01)


> Seven heavy designer / write surfaces were built out and audited individually
> (per-surface docs alongside this file). These are the surfaces the rev.2 note
> called the "headline gaps … heavy designers." Counts are honest
> (built ✅ / partial ⚠️ / honest-gate ⚠️ / missing ❌), derived from reading the
> editor source back to a real REST/data-plane call, not a live click-through
> (confirm against the live portal per the no-scaffold rule). Lifts the parent
> service grade where noted.

| Sub-surface | Doc | Grade | ✅ | ⚠️ | gate | ❌ | Lifts |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| Databricks Unity Catalog WRITE (create catalog/schema/table + grants) | `databricks-unity-catalog.md` | **B−** | 24 | 1 | 0 | 17 | flips `databricks-workspace.md` F4–F5 ❌→✅ |
| Synapse Spark notebook (cells + Livy run) | `synapse-notebook.md` | **B−** | 18 | 4 | 1 | 14 | flips `synapse-analytics.md` "notebook absent" ❌→built |
| ADF Mapping Data Flow designer | `adf-mapping-data-flow.md` | **B−** | 18 | 3 | 1 | 8 | cures `adf-data-factory.md` "rich surface→JSON" violation |
| ADX web UI — query + `render` auto-chart | `adx-web-ui.md` | **B** | 19 | 6 | 0 | 8 | deepens `adx-kusto.md` results/render |
| AI Search — Search Explorer query options | `ai-search-explorer.md` | **B+** | 27 | 5 | 0 | 9 | deepens `ai-search.md` search tab |
| AI Foundry — Evaluations | `foundry-evaluations.md` | **C+** | 13 | 2 | 1 | 11 | deepens `ai-foundry.md` evals tab |
| Data API Builder — config UX | `data-api-builder.md` | **B+** | 30 | 6 | 1 | 1 | new DAB authoring surface |

**Sub-surface distribution:** 1 × B+, 1 × B+, 1 × B, 3 × B−, 1 × C+ (two B+ rows).
All seven are real built code with honest gates — no vaporware. The two flagship
`ui-parity.md` violations called out in rev.2 (ADF/Synapse heavy designers,
Databricks UC write) now have genuine built surfaces; they sit at **B−** because
breadth (full transform library / `display()` viz / UC lineage+external-locations)
is still missing, not because anything is faked.

---

## Governance & Security experience — per-surface parity (rev.4 — 2026-06-07)

> The **Governance & Security** experience (Microsoft Purview governance
> framework + Fabric OneLake Catalog, Azure-native per `no-fabric-dependency.md`)
> ships nine surfaces under `/governance/*`. Each now has its own parity doc with
> a full inventory, Loom coverage, and a **backend-per-control** column — every
> row built ✅ or honest-gate ⚠️, **zero ❌**. All nine work with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and no Purview account on the default
> path; Purview legs (catalog classification merge, lineage Atlas merge, Data
> Map scans, DLP live-violations) are the *allowed* honest infra-gate
> (`PurviewGate` names the env var + bicep module + UAMI roles).

| Surface | Doc | Grade | Default backend | Purview leg |
|---|---|:--:|---|---|
| Governance landing / posture | `governance-overview.md` | **A** | Cosmos insights + audit-log | connection chip ⚠️ |
| Data catalog (Unified Catalog / Explore) | `governance-catalog.md` | **A** | Cosmos `workspace-items` ⋈ `workspaces` + `request-access` | classification merge ⚠️ |
| Classifications + label taxonomy | `governance-classifications.md` | **A** | Cosmos `tenant-settings` + `state.classifications` rollup | none (fully native) |
| Insights & reports (Data Health / Govern) | `governance-insights.md` | **A** | Cosmos catalog/audit aggregates | none (fully native) |
| Lineage | `governance-lineage.md` | **A** | Cosmos typed-reference graph | Atlas merge ⚠️ |
| Access & DLP policies | `governance-policies.md` | **A** | Cosmos defs + real RBAC (Storage / Synapse SQL / ADX) | DLP live-violations ⚠️ |
| Microsoft Purview connection | `governance-purview.md` | **A** | `probePurview()` status + portal launch | the subject (honest gate ⚠️ when unbound) |
| Data Map — scans & sources | `governance-scans.md` | **A-when-wired** | — (Purview scan plane by nature) | register/scan/run/history ⚠️ |
| Sensitivity labels (MIP) | `governance-sensitivity.md` | **A** | Cosmos `state.sensitivityLabel` distribution | taxonomy admin deep-link |

**Distribution:** 8 × A + 1 × A-when-wired. **Zero ❌ across all nine docs**
(grep-clean), backend-per-control on every row, no stub banners, no dead
controls. These nine are the **shipped/built** governance surfaces; the broader
governance-security PRP (`docs/fiab/prp/governance-security.md`) tracks further
feature build-out (Govern Admin/Owner sub-tabs F2/F3, Workspace-roles F5,
Item-sharing F6, OneLake security F7–F10, SQL granular security F11, label
inheritance/batch F15–F18) as separate in-flight tasks — those surfaces are not
yet built and are intentionally **not** documented here as parity.

---

## Platform & Admin experience — per-surface parity (rev.5 — 2026-06-09)

> The **Platform & Admin** experience ships 19 per-surface docs (the 18 authored
> here plus the existing `domains.md`) covering the AdminShell chrome, the admin
> tabs, workspace lifecycle, networking/CMK, connections, and org branding. Each
> doc satisfies the "zero ❌" DoD: every inventoried control is **✅ built** or
> **⚠️ honest-gate** — no missing rows, no stub banners, no dead controls. All
> surfaces work with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET on the default path;
> Power BI / Fabric legs (refresh, embed, Fabric workspace-role sync) are the
> *allowed* opt-in honest-gate per `no-fabric-dependency.md`, and every
> infra-config gate names the exact env var / role / bicep module per
> `no-vaporware.md`.

| Surface | Doc | Grade | Default backend | Gate |
|---|---|:--:|---|---|
| AdminShell layout / chrome | `admin-shell.md` | **A** | none (pure client) | — |
| Tenant settings | `tenant-settings.md` | **A** | Cosmos `tenant-settings` | — |
| Capacity inventory + Scale by SKU (11 services) | `capacity.md` | **A** | ARM (UAMI) + per-service PATCH | cost ⚠️ |
| Workspaces (user browser + admin) | `workspaces.md` | **A** | Cosmos `workspaces` + `items` | — |
| Workspace create | `workspace-create.md` | **A** | Cosmos + PBI capacities | Purview ⚠️ |
| Workspace roles (Manage access) | `workspace-roles.md` | **A** | Cosmos `workspace-roles` + ARM RBAC | RBAC-admin ⚠️ / Fabric opt-in ⚠️ |
| Folders (+ task flows) | `folders-taskflows.md` | **A−** | Cosmos `folders` | task flows ⚠️ |
| Git integration (SCM binding) | `git-integration.md` | **B+** | Cosmos `workspace-git` | Git-exec ⚠️ |
| Spark compute (notebook backend) | `spark-compute.md` | **A** | AML Serverless Spark (Com/GCC) / Synapse Livy (GovH/IL5) | config ⚠️ |
| CMK encryption | `cmk.md` | **A** | `storage.bicep` + `keyvault.bicep` | key-URI ⚠️ / no-blade ⚠️ |
| Network & Private DNS | `networking.md` | **A** | ARM network-discovery + `network.bicep` | Reader ⚠️ |
| Azure Connections | `azure-connections.md` | **A** | Cosmos + Key Vault (`kv-secrets-client.ts`) | KV role ⚠️ |
| Users & licenses | `users-licenses.md` | **B+** | Cosmos derivation + Graph (gated) | Graph ⚠️ / license ⚠️ |
| Domains | `domains.md` | **A** | Cosmos `tenant-settings` + Purview (gated) | Purview ⚠️ |
| Audit logs | `audit-logs.md` | **A** | Cosmos `audit-log` | — |
| Refresh summary & schedule | `refresh-summary.md` | **A** | Power BI REST (opt-in) | PBI-bound ⚠️ |
| Usage & adoption | `usage-adoption.md` | **A** | Cosmos aggregates | — |
| Embed codes | `embed-codes.md` | **B** | PBI REST GenerateToken + `powerbi-client-react` | PBI-bound ⚠️ / Publish-to-web admin ⚠️ |
| Org visuals & branding | `org-visuals.md` | **B+** | Cosmos `tenant-themes` + ADLS (domain images) | custom `.pbiviz` ⚠️ |

**Grade distribution (rev.5):** 14 × A / A−, 5 × B+ / B. **Zero D, zero F.
Zero ❌ in any of the 19 docs** (grep-clean), backend-per-control on every row.
The two surfaces with material Power-BI-tenant gaps (public Publish-to-web admin,
custom `.pbiviz` org visuals) are the *less* governable Power BI features; Loom's
authenticated-embed and tenant/domain-branding paths deliver the parity today and
the gaps are disclosed as honest ⚠️ gates per `no-vaporware.md`. These 19 are the
shipped Platform & Admin surfaces; the broader Platform PRP
(`docs/fiab/prp/platform-admin.md`) tracks further build-out separately.

---

## Copilot surfaces — parity (rev.5 — 2026-06-09)

The Copilot surface spans **14 distinct personas** across the console — the
Copilot Studio item family, the SQL/notebook in-editor assistants, the
cross-item orchestrator, the global help widget, inline ghost-text completion,
and the in-blade governance assistant. Each persona now has a per-surface
parity doc under `docs/fiab/parity/` showing **zero ❌** (every inventory row
built ✅ or honest-gate ⚠️). All AOAI-backed personas are Azure-native by
default and work with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (per
`no-fabric-dependency.md`); the Copilot Studio family is a Power Platform /
Dataverse workload routed by `LOOM_POWER_PLATFORM_BAP_BASE`.

| # | Persona | Parity doc | Grade | Default backend |
|---|---|---|:--:|---|
| 1 | Copilot Studio — agent | `copilot-studio-agent.md` | A | Dataverse `msdyn_copilots` + Direct Line |
| 2 | Copilot Studio — topic | `copilot-studio-topic.md` | A | Dataverse `msdyn_botcomponents` |
| 3 | Copilot Studio — action | `copilot-studio-action.md` | A | Dataverse `msdyn_bot_actions` |
| 4 | Copilot Studio — knowledge | `copilot-studio-knowledge.md` | A | Dataverse `msdyn_knowledgesources` |
| 5 | Copilot Studio — analytics | `copilot-studio-analytics.md` | A | BAP admin analytics |
| 6 | Copilot Studio — channel | `copilot-studio-channel.md` | A | Dataverse `msdyn_botchannels` |
| 7 | Copilot Studio — template library | `copilot-template-library.md` | A | Cosmos gallery + Dataverse instantiate |
| 8 | Notebook in-cell Copilot | `notebook-in-cell-copilot.md` | A | Azure OpenAI (`/api/notebook/[id]/assist`) |
| 9 | Warehouse Copilot (NL→SQL) | `warehouse-copilot.md` | A | Azure OpenAI + live warehouse schema |
| 10 | Azure SQL Copilot | `azure-sql-copilot.md` | A | Azure OpenAI (SSE) + TDS schema |
| 11 | Cross-item Copilot orchestrator | `copilot-cross-item.md` | A | Azure OpenAI 37-tool function-calling |
| 12 | Help Copilot widget | `copilot-help-widget.md` | A | Azure OpenAI + docs index (AI Search/Cosmos) |
| 13 | Inline code completion (ghost text) | `copilot-inline-complete.md` | A | Azure OpenAI (`/api/copilot/complete`) |
| 14 | Governance Copilot | `copilot-governance.md` | A | Azure OpenAI (SSE) grounded on live posture |

**Coverage:** 14/14 personas at zero ❌. **Deep-functional UAT:**
`apps/fiab-console/e2e/copilot.uat.ts` exercises every persona's primary action
against the real backend (authenticated `pnpm uat`), accepting real success
**or** a documented honest gate (`no_aoai` / `disabled` / `admin_only` /
Dataverse-not-wired) — passing green whether or not AOAI / Power Platform are
wired in the target deployment. The Copilot Studio low-code conversation-flow
visual designer is the one **honest scope boundary** (Copilot Studio portal
authoring, forbidden as parity per `ui-parity.md`), not a missing row.

---

## Overall honest assessment: how far is Loom from 1:1 Azure parity?

> **rev.6 (2026-06-10) update:** the assessment below was written at rev.1
> (33% built). After the Wave-8→11 cohort (PRs #1054–#1123) the recomputed honest
> figure is **≈ 49% built / 31% missing** (see the rev.6 recount above). The
> "backend-exists-but-UI-doesn't-call-it" quick-win pattern called out below is
> now largely consumed; the residual gap is dominated by per-service management
> blades and a few flagship designers. The narrative below is preserved as the
> rev.1 baseline.

**Loom is roughly one-third of the way to 1:1 Azure parity, and not close to
the `ui-parity.md` bar on any service.** Across the 580 capabilities the audits
inventoried, only **33% are actually built**. **44% are entirely missing** —
not gated, not stubbed, simply absent. A further **18% are partial**: they
render but are read-only or reduced to a thin form where the real portal is a
rich designer, grid, or wizard. Only **5%** sit behind the *allowed* honest
infra-gate.

The single B is **Databricks**, and even it is B not A because several of its
highest-value gaps are *already-written client functions that were never wired
to a button* (cluster edit, warehouse scale, repos branch ops). That pattern —
**backend exists, UI doesn't call it** — recurs in almost every audit (Cosmos
throughput reads but no PUT; Azure SQL has firewall/AAD/replication routes but
the registered editor never mounts them; AI Foundry ships `foundry-agent-client.ts`
with no route or editor; Power BI has `cloneReport`/`addDashboardTile`/`BindToGateway`
in the client and no UI; AI Search `getServiceStats()` has no route). This is the
cheapest parity ground in the entire program and a large fraction of the backlog
below is "wire what already exists."

The **D is Event Hubs**, and it is the clearest failure: the two things
operators use Event Hubs for — **sending and viewing events**, and **getting a
connection string** — are both absent, partly because the deployment sets
`disableLocalAuth: true` and no Entra data-plane path was built to replace SAS.
It reads as a bare resource tree, not an Event Hubs portal.

The recurring `ui-parity.md` violation is **"rich Azure surface -> JSON
textarea"**: ADF's Mapping Data Flow, Synapse's notebook + data-flow designers,
AI Search's index field grid, and Cosmos's items explorer are all flagship
visual experiences that Loom either omits entirely or replaces with a raw-JSON
editor. The other recurring violation is **deep-link-as-parity** (Power Platform
routes all five authoring designers — canvas Studio, flow designer, connector
wizard, Power Pages, AI Builder — out to the real product instead of building
them; Synapse fragments one Studio into four disconnected catalog items).
Both are explicitly forbidden, so several "C" surfaces are really D-grade on the
specific tabs that matter most.

**Bottom line:** what Loom has built is genuine (no fake data, gates are
honest), but it is a thin slice. To honestly claim parity on any single service
you'd need to roughly triple its built-capability count, and the program-wide
gap is dominated by *missing visual designers/data-explorers* and *unwired
existing backends*.

---

## Prioritized build backlog (highest impact first, across all services)

Ordering weights: operator frequency-of-use, credibility gap (how "fake" the
surface looks without it), `ui-parity.md` violation severity, and
effort-to-impact (unwired-backend items are starred ★ as quick wins).

### Tier 0 — Quick wins: wire backends that already exist (days, not weeks)

1. **★ Databricks Cluster EDIT** — wire the existing `editCluster()` into
   `DatabricksClusterEditor` (today create/view only, fields disabled). Highest
   value / lowest effort in the whole program.
2. **★ Databricks SQL Warehouse edit/scale** — wire `editWarehouse()` (size,
   min/max, auto-stop, serverless toggle). Client fn exists, no caller.
3. **★ Azure SQL: mount the rich `SqlDbTree` (real sys.* over TDS) into
   `UnifiedSqlDatabaseEditor`** — replaces the flat INFORMATION_SCHEMA grid with
   the navigator that's already built but never mounted; also surface the
   existing firewall / Entra-admin / geo-replication routes.
4. **★ AI Foundry Agents editor + playground** — wire existing
   `foundry-agent-client.ts` into a new `/api/foundry/agents` route + editor
   (model/instructions/tools/knowledge/threads-runs/publish). Flagship new-Foundry
   surface; today only a forbidden greyed "coming" tooltip.
5. **★ Power BI quick wins** — wire `cloneReport` (Save-a-copy), `addDashboardTile`
   /`cloneDashboardTile` (Pin tile); these client fns already exist.
6. **★ Cosmos Scale/Settings write path** — add the `PUT throughputSettings`
   (and TTL) call; reads of throughput/defaultTtl already exist.
7. **★ AI Search service-stats panel** — add a route over the implemented
   `getServiceStats()` for usage/quota/search-units at a glance.

### Tier 1 — Flagship visual surfaces missing entirely (biggest credibility gaps)

8. **Cosmos DB Items data explorer** (data-plane browse/new/view/edit/delete +
   query editor with RU-charge/doc-count stats) — the single most-used Cosmos
   feature; requires an AAD data-plane `documents.azure.com` client.
9. **Event Hubs Data Explorer — Send + View events** (partition/position/grid/
   download) over Entra data-plane (deployment is `disableLocalAuth:true`).
   The most-used Event Hubs surface; lifts the service off its D.
10. **ADF Mapping Data Flow visual designer** (source -> transforms -> sink graph
    + data preview + debug) — the flagship ADF surface, today only empty-shell +
    raw JSON.
11. **Synapse notebook editor** (cells, %% magics, attach-pool, Run/Run-all,
    variable explorer, charts) — the marquee Develop experience; Spark is a single
    textbox today.
12. **AI Search visual index field designer** — per-field grid (add/edit, attribute
    checkboxes, analyzer/type pickers) to replace the forbidden JSON textarea; plus
    search-explorer **query options** (semantic/vector are unreachable though the
    backend already supports them).

### Tier 2 — Authoring & write surfaces that are currently read-only

13. **APIM Operations authoring** (add/edit/delete operations, params, request/
    response schemas) + **form-based policy editor** with effective-policy calc.
14. **Power Platform Environment lifecycle command bar** (New/Edit/Copy/Backup-
    Restore/Reset/Delete/Convert) + **Dataverse table authoring + row CRUD**.
15. **Databricks Unity Catalog write surface** (create catalog/schema/table/volume,
    GRANT/REVOKE, lineage, external locations) — entire governance write surface is
    read-only.
16. **Power BI semantic-model settings pane** (gateway binding + datasource
    credentials) — without it refresh fails for any gateway/cloud model; plus
    **per-item ⋯ context menu** (unlocks settings + governance across all item types).
17. **ADX rich results grid** (sort/filter/group/pivot/profile/cell-stats) +
    **export/share** (CSV/Excel/Power BI) — the defining ADX web-UI experience.
18. **Cosmos stored-proc/trigger/UDF authoring** + indexing/conflict-resolution
    editors.
19. **AI Foundry Connections CRUD** (AOAI/AI-Search/Blob) + Guardrails/RAI policy
    authoring (flows + agents depend on connections).

### Tier 3 — Scale, lifecycle, and platform plumbing

20. **Scale/compute editors** missing across the board: ADF/Synapse IR + DWU,
    Azure SQL service-tier/vCore/serverless (need ARM PATCH route), Event Hubs
    TU/auto-inflate, ADX cluster stop/start/scale, Databricks cluster Policy +
    Access-mode (UC gate).
21. **Source control / CI-CD + unified Studio shell** for ADF and Synapse
    (Git config, Publish/Discard live-mode, ARM export) — today both are
    live-mode-only and Synapse is fragmented into 4 catalog items.
22. **Connector galleries + Test Connection** for ADF/Synapse linked services &
    datasets (90+ connectors today reduced to ~2 typed forms + raw JSON).
23. **Backups & restore** (Azure SQL PITR/geo-restore/LTR; Cosmos backup/restore).
24. **Monitor hubs** — factory/workspace-wide run grids with rerun/cancel/Gantt
    for ADF & Synapse; AI Foundry observability dashboard + trace spans.
25. **Management blades** (IAM, Tags, Locks, Diagnostic settings, Metrics, Alerts,
    CMK, Identity, Networking/private-endpoints) — entirely absent on Event Hubs,
    Cosmos, APIM, and most services; build a reusable Azure-mgmt-blade component
    once and mount it everywhere.
26. **Bicep / env-var sync** — several navigators (Cosmos `LOOM_COSMOS_*`, plus
    the navigators noted as silently config-gated in the live deployment) need
    their env vars wired into `admin-plane/main.bicep` `apps[]` so they aren't
    silently dead in production (`no-vaporware.md` bicep-sync requirement).

### Tier 4 — Governance, secrets, and remaining portal tools

27. **Endorsement (promote/certify) + sensitivity labels** across Power BI item
    types (0% today); **Manage-access on the real PBI workspace ACL** (today
    Cosmos-only Loom roles).
28. **Secret reveal/regenerate**: Event Hubs SAS keys/connection strings, APIM
    subscription-key reveal/regenerate + state transitions, APIM named-value +
    Key-Vault references, Cosmos account keys.
29. **RBAC principal-assignment UIs**: ADX cluster/database roles, Databricks ACLs,
    AI Foundry RBAC, generic IAM blade.
30. **Get-data / import wizards**: AI Search Import-data (datasource->skillset->
    index->indexer + vectorization), ADX get-data (blob/ADLS + schema inference),
    ADF Copy Data Tool, Power BI quick-create report.
31. **Remaining portal tools** (lower freq): ADX dashboards multi-page + import/
    export, AI Search debug sessions + demo app, AI Foundry Images/Audio/Speech
    playgrounds + templates gallery, Power Platform Solutions/ALM + 6 missing
    admin-center areas.

---

### How to use this backlog

- **Tier 0 first** — these are the cheapest possible parity gains (existing
  backend, missing wire-up) and several are flagged as "highest value / lowest
  effort" in their source audits. Knocking out Tier 0 alone moves Databricks
  toward A and lifts Azure SQL / AI Foundry / Cosmos off their worst tabs.
- **Tier 1 is what makes Loom *look* real** — these are the flagship visual
  surfaces whose absence is the biggest "this is a scaffold" tell, and the ones
  most directly violating `ui-parity.md`'s "rich surface -> JSON textarea" ban.
- Build the **reusable Azure-management-blade** (Tier 3 #25) and
  **secret-reveal** (Tier 4 #28) components *once* and mount across services —
  they recur in nearly every audit's missing list.

_Last updated: 2026-06-10 (rev.6 — Wave-8→11 re-audit + count recompute,
audit-T31). Source: 12 per-service parity audits + the rev.6 gap-closure map
above, reconciled against `docs/fiab/prp/AUDIT-2026-06-10.md` and the
PR #1054–#1123 ledger. Originally 2026-05-31._

# Live UI Sweep — 2026-06-21 (front-end-first, fix-as-you-go)

> Mandate (operator, verbatim intent): test **every shortcut type, every "add
> item" option, every "add app", and every option for every item** via the
> real front-end (claude-in-chrome) — because many features only fail in the
> UI. Find bugs / missing features / gaps / UI issues and **fix them**, baking
> durable fixes into deploy so they work day-one.

Live target: centralus console `loom-console` (rg-csa-loom-admin-centralus,
sub e093f4fd…), Front Door `loom-console-k6mvh5sm6z7do-…b02.azurefd.net`.
Method: drive the operator's Chrome; real backend calls; no scaffold claims.

## Legend
✅ works (rows/real backend)  ⚠️ honest-gate (needs infra/cred, full UI renders)
❌ BUG (broken in UI)  🔧 fixed this session  ⏳ not yet tested

## Bugs found + fixed this session
| # | Surface | Symptom (UI) | Root cause | Fix | State |
|---|---------|--------------|-----------|-----|-------|
| 1 | Lakehouse → Shortcuts | No way to query a Files shortcut | Query action gated to Tables+engine only | Query(SQL) for Files/non-engine → real-host OPENROWSET | 🔧 PR #1575, verified ✅ |
| 2 | Lakehouse → Shortcuts (create) | "Failed to fetch" on create | compute-targets 503-flood starved conn pool | 8s timeout on discovery probes | 🔧 PR #1575, verified ✅ |
| 3 | Lakehouse → Shortcuts (Tables) | "CREATE/ALTER VIEW is not supported in master database" | Tables view DDL ran in serverless `master` | route DDL to user DB (loom_lakehouse), 3-part engineObject | 🔧 sha 65fc2bba, verified ✅ (orders_table_sc → 3 rows) |
| 4 | Workspaces → New workspace | "Domain (optional)" but create fails `400 domain_required`; picker lists no domains on fresh tenant → can't create a workspace → apps can't install | backend required a domain; picker filters to caller-administered domains (none on fresh tenant) | default to seeded `default` domain when none picked (/api/workspaces + /api/admin/workspaces) | 🔧 committed, build pending |
| 5 (watch) | Apps → Install | "You don't have any workspaces yet" while /workspaces lists 143 | install picker owner-scopes to caller's workspaces; UAT ones owned by automation principal | unblocked by #4; revisit if still mismatched after creating own ws | ⏳ |

## Phase A — Lakehouse shortcuts (7 sources × Files/Tables + Query/Test/Delete)
| Source | Files | Tables | Notes |
|--------|-------|--------|-------|
| internal | ✅ Query→3 rows | ⏳ (fix #3 rolling) | |
| adls (AAD) | ✅ resolves+runs | ⏳ | eventhub_capture had no data (honest) |
| sharepoint | ⚠️ | ⚠️ | full Graph-drive wizard; honest-gate if Graph not configured |
| s3 | ⚠️ verified | ⚠️ | full credential wizard (bucket/region/access-key|IAM-role ARN, Save to KV, Browse remote) — honest: needs real S3 creds. NOT a dead-end ✅ |
| gcs | ⚠️ | ⚠️ | same KV-credential wizard pattern as s3 |
| dataverse | ⚠️ | ⚠️ | same KV-credential wizard pattern |
| delta_sharing | ⚠️ | ⚠️ | credential-file wizard; Tables needs Databricks |

**Phase A verdict:** internal+adls work with real rows; external-cloud sources
render full functional credential wizards (honest infra-gate, not vaporware).
Query(SQL) now present for every shortcut. No ❌ remaining in Phase A.

## Phase B — Apps: VERDICT — install works once a workspace exists (bug #4)
**RAG Builder** installed (server-verified, jobId 981fe9f7): 4/4 items created;
ai-search-index → real AI Search index ✅; notebook → real Synapse notebook ✅;
prompt-flow + evaluation → honest remediation gates (AI Foundry prompt-flow infra).
Status `partial` = honest no-vaporware outcome. **Root cause of "apps don't
work" = bug #4 (couldn't create a workspace).** Browser 503 on install = transient
/stale-tab (server returns 202 in 0.68s).
Minor follow-ups: (a) install dialog shows "no workspaces yet" during the slow
~6.5s /api/workspaces fetch — add a loading state; (b) `/api/workspaces?count=true`
503s with 144 workspaces — count-enrichment too slow; (c) remediation GATE code
renders `undefined` — populate gate.code/hint. Remaining 26 apps: same flow,
install per-app (not all re-tested individually).

### Harness apps-only run results (verified)
- **Run 1 (console 3fe039c0):** 24 pass / 5 realFail. Defects: ml-pipeline + healthcare-popmgt + direct-lake-replacement (Databricks `existing_cluster_id` got a JOB cluster → INVALID_PARAMETER_VALUE); pipeline-designer (synapse pipeline refs uncreated dataset `ds_source_drop_csv` — #1576); azure-realtime-analytics (synapse upsertNotebook 500 BlobStorageClient — transient).
- **Fix:** `resolveRunCluster` filters to ALL-PURPOSE clusters (isAllPurposeCluster, commit 9868ccff). Built loom-console:9868ccff → rolled rev 0000031.
- **Run 2 (verify, console 9868ccff, scoped to the 5):** `pass=4 fail=1 realFails=0`. ml-pipeline ✅, healthcare-popmgt ✅, direct-lake-replacement ✅ (Databricks fix CONFIRMED), azure-realtime-analytics ✅ (500 was transient). pipeline-designer failed only on a transient `page.goto` 30s timeout — NOT a realFail; the #1576 dataset defect is latent (didn't reach provisioning this run).
- **Net:** 28/29 apps provision clean (real backend or honest infra-gate); pipeline-designer has tracked real defect #1576 (synapse pipeline dataset/linked-service refs) needing a bundle/provisioner fix.

### (former) per-app table
azure-realtime-analytics, casino-analytics, change-feed-processor, data-governance,
data-steward, direct-lake-replacement, fabric-mirror-onboard, federal-data-mesh,
fedramp-tracker, finops-cost, healthcare-popmgt, hybrid-topology, iot-realtime,
lakehouse-inspector, logic-apps-integration, ml-pipeline, multi-agency-onboarding,
pipeline-designer, rag-builder, real-time-dashboards, sovereign-ai-agents,
supercharge-{bronze,silver,gold,ml,streaming}, workspace-monitoring
→ status table filled as tested.

## Phase C — "Add item" core types (provision + open editor + primary action)
Priority core: lakehouse, warehouse, notebook, data-pipeline, eventstream,
eventhouse, kql-database, kql-dashboard, activator, semantic-model, report,
mirrored-database, dataflow, spark-job-definition, data-agent, ai-search-index,
ai-foundry-project, data-api-builder, sql-database, cosmos.
(109 total slugs; many are sub-objects — core/createable ones first.)

## Phase D — In-editor "Add" actions + every page/tab
Per editor: ribbon/canvas add buttons. Plus admin-portal pages, governance,
monitor, connections (already swept #2 prior), lineage, catalog.

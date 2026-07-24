# Zero-Gates Configuration Audit — full G2 registry enumeration + runnable checklist

Date: 2026-07-24 · Scope: `apps/fiab-console/lib/gates/registry/*.ts` + `apps/fiab-console/lib/admin/env-checks/*.ts` (ENV_CHECKS) · READ-ONLY audit, nothing changed.

---

## 1. Registry mechanics (how status is computed)

- **Single declarative source**: `ENV_CHECKS` is the merge of 10 per-domain fragments — `apps/fiab-console/lib/admin/env-checks/index.ts:41-52`. Fragment counts: identity 3, data-plane 21, permissions 2, azure-services 51, ai-copilot 8, enrichment 4, builders 18, catalog-governance 4, security 9, observability 5 → **125 gates total**.
- **Gate registry derives 1:1** from ENV_CHECKS and enriches with `GATE_META` (surfaces, fixit, loaders, legacyCodes) — `apps/fiab-console/lib/gates/registry/index.ts:65-76` (meta merge) and `:101-120` (GATES composition). Drift is test-blocked: `lib/gates/__tests__/registry.test.ts:20-36` asserts one gate per spec and an explicit GATE_META entry (surfaces + fixit) for every id — **no gate is missing a Fix-it entry at the registry level**.
- **Status evaluation is pure env-presence** (`evalEnv`, `lib/admin/env-checks/core.ts:438-474`): every `required` key present + every `anyOf` group satisfied → `pass`. Three softeners:
  - `optionalDefault: true` → a MISS still reports **pass** ("Built-in fallback active", core.ts:448-458). **28 gates** carry this.
  - `derived: true` → bicep auto-fills on push-button deploy; env-config shows "derived" (core.ts:405-410). **7 gates**.
  - `availability` (X2): a FAILING check in a cloud where the service is `unavailable` becomes `cloud-unavailable` — fallbackNote, **NO Fix-it by design** (`lib/gates/registry/index.ts:181-201`, `types.ts:114-135`).
- **Fix-it write path**: resolve goes through the ONE shared `env-apply` path (`lib/admin/env-apply.ts:102-122` `envWriteAvailability`, ACA-revision or AKS rolling update). Routes: `app/api/admin/gates/route.ts` (list+live status), `app/api/admin/gates/[id]/options/route.ts` (live ARM resource enumeration for pickers), `app/api/admin/gates/[id]/resolve/route.ts` (the write).

## 2. G2 admin gate-registry page shape

`app/admin/gates/page.tsx:1-127` — one row per registry entry with:
- LIVE status badge: `configured` / `blocked` / `cloud-unavailable` (page.tsx:57-65, sort blocked-first :116-120);
- required env chips (anyOf alias groups), owning surfaces, bicep `provisionedBy`, RBAC `role`;
- one-click **Fix it** → `GateFixitDialog` (imported from `lib/components/shared/honest-gate`, page.tsx:25) with real ARM options-loaders (`lib/gates/registry/types.ts:149-185` — 30 preset loaders: Synapse, ADX, EventHubs, Storage, AOAI deployments multi-step special, Grafana, AAS, APIM, PG flex, App Config…);
- filters by status/category/free text; `writeConfigured` honesty banner when the runtime env-write path is absent (page.tsx:86, route.ts:49-59).
- API response shape: `{ok, count, configured, blocked, gates[], platform, writeConfigured, writeError, cloud}` — `app/api/admin/gates/route.ts:51-61`.
- Copilot can read the same rollup (`lib/azure/copilot-orchestrator.ts:1021-1027`).

**Fixit kinds across the 125**: `env-picker`/`resource-picker` ≈ 101, `wizard` = 13 (entra-app identity.ts:18; usage-embed / govern-embed / svc-cost-anomaly-monitor / svc-dataverse azure-services meta :117,:122,:217,:379; svc-copilot-evaluator ai-copilot meta :81; svc-openlineage catalog-governance meta :34; svc-dr-restore-posture data-plane meta :39; svc-secret-expiry security meta :20; svc-workspace-identity security meta :86; svc-synthetic-login observability meta :29; svc-alerting observability meta :62), `role-grant` = 11 (svc-cost-management, svc-budgets-write, svc-powerplatform; graph-users, graph-group-sync, svc-m365-link, svc-sharepoint-shortcuts; domain-routing; svc-onelake-acl, svc-mip, svc-dlp).

## 3. Classification legend

- **(a) likely-green already** — every required var is emitted by `modules/admin-plane/main.bicep` apps[] env (verified against the 417-name emission set extracted from that file) or the spec is `optionalDefault`/`derived`. "Likely" because bicep emission can be conditional on a feature flag (e.g. `batchEnabled`) — §7 gives the live verification command.
- **(b) needs a CONFIG value** — var NOT in the bicep emission set; a pure env write (admin gates Fix-it / `PUT /api/admin/env-config`) or ACA secret.
- **(c) needs INFRA provisioned** — a bicep module must be deployed before the value exists.
- **(d) deliberately opt-in / OFF** — do NOT enable (chaos, Trino, Fabric-family, preview labs).
- **(e) operator-only** — tenant consent / RBAC grant / CA / FIC — cannot be an env write.

## 4. Full gate enumeration (125)

### identity (3) — all (a)

| Gate | Requires | Class | Evidence |
|---|---|---|---|
| session-secret | SESSION_SECRET | (a) | always set via secretRef `admin-plane/main.bicep:4440`; spec `env-checks/identity.ts:12-17` |
| entra-app | LOOM_MSAL_CLIENT_ID+SECRET, tenant | (a) | bicep emits (MSAL app-reg default-on); spec identity.ts:18-32; live login works on both estates (post-#2191 login-health preflight) |
| uami | LOOM_UAMI_CLIENT_ID | (a) | auto-derived, identity.ts:33-38 |

### data-plane (21)

| Gate | Requires | Class | Evidence |
|---|---|---|---|
| cosmos-config | LOOM_COSMOS_ENDPOINT | (a) | emitted; data-plane.ts:12-19 |
| subscription | LOOM_SUBSCRIPTION_ID + RG | (a) | emitted; :20-26 |
| svc-loom-onelake | LOOM_ONELAKE_URL | (a) pass (optionalDefault) | :32-38; H-band scale-out via `compute/hband-shared.bicep`+`loom-onelake-app.bicep` is OPTIONAL |
| svc-loom-directlake | LOOM_DIRECTLAKE_URL | (a) pass (optionalDefault) | :39-45 |
| svc-loom-duckdb | LOOM_DUCKDB_URL | (a) pass (optionalDefault) | :47-61; optional upgrade = `modules/data-plane/duckdb-aca.bicep` (out-of-band) |
| svc-flight-sql | LOOM_FLIGHTSQL_URL | (a) pass (optionalDefault) | :63-77 |
| svc-iceberg-catalog | LOOM_ICEBERG_CATALOG_URL | (a) pass (optionalDefault) | :79-93; optional = `iceberg-catalog-aca.bicep` |
| **svc-loom-trino** | LOOM_TRINO_URL | **(d) — THE opt-in carve-out; do NOT enable** | :94-114 — "OPT-IN by design (heavy AKS infra)… NOT optionalDefault: the /api/sql/trino route is honestly gated" → shows **blocked** on /admin/gates by design |
| svc-cosmos-control | LOOM_COSMOS_ACCOUNT | (a) | emitted; :115-121 |
| svc-medallion-layers | anyOf ADLS/silver/gold | (a) | LOOM_ADLS_ACCOUNT emitted; :122-128 |
| svc-redis-result-cache | LOOM_RESULT_CACHE_REDIS | (a) pass (optionalDefault, per-replica in-mem fallback) | :129-136 |
| svc-dr-restore-posture | anyOf cosmos/adls account | (a) | :138-149 |
| perf-spark-warm-pool-store | anyOf LEASE_CONTAINER/REDIS | (a) | LOOM_SPARK_POOL_LEASE_CONTAINER emitted; :150-156 |
| svc-spark-autorecover | LOOM_SPARK_AUTORECOVER_ENABLED | (a) pass (optionalDefault, default-ON behavior) | :162-175 |
| svc-spark-vcore-budget | budget/session-max | (a) pass (optionalDefault) | :181-194 |
| svc-spark-chaos-drill | LOOM_SPARK_CHAOS_ENABLED | **(d) OFF = correct posture** (optionalDefault pass) | :196-209 — "MUST stay off in production" |
| svc-dependency-chaos-drill | LOOM_DEPENDENCY_CHAOS_ENABLED | **(d) OFF = correct posture** (pass) | :211-224 |
| **svc-ducklake-catalog** | LOOM_DUCKLAKE_CATALOG_URL | **(d) Preview opt-in lab** — blocked by design | :229-241 (N8 lab 1; operator-provided PG) |
| **svc-s3-gateway** | LOOM_S3_GATEWAY_URL | **(d) Preview opt-in** — blocked by design | :248-260 (operator-deployed s3proxy) |
| **svc-loom-migrate** | LOOM_MIGRATE_URL | **(d) opt-in by nature** (only when migrating FROM an estate) — blocked by design | :266-278; infra if wanted = `modules/data-plane/loom-migrate-aca.bicep` |
| **svc-loom-risingwave** | LOOM_RISINGWAVE_URL | **(d) opt-in stateful streaming (~$150-300/mo)** — blocked by design | :285-305; infra if wanted = `loom-risingwave-aca.bicep` |

### permissions (2) — all (a)

| Gate | Class | Evidence |
|---|---|---|
| domain-routing | (a); multi-sub extra grants are (e) when domains are added | permissions.ts:11-25; `dlz-attach-itemcreate-rbac.bicep` |
| bootstrap-admin | (a) | LOOM_TENANT_ADMIN_OID/GROUP_ID emitted (deploy params); :27-33 |

### azure-services (51)

| Gate | Class | Evidence / action |
|---|---|---|
| svc-synapse, svc-adx, svc-eventhubs, svc-adls, svc-aisearch, svc-aoai | (a) | all vars bicep-emitted (landing-zone modules deployed on both estates); azure-services.ts:12-71 |
| svc-report-subscriptions | (a) env-green + **(e)**: authorize the Logic App's **Office 365 connection in the portal** (one-time) | :33-39 |
| svc-ai-enrich | (a) pass (optionalDefault — shared Foundry AIServices account) | :72-97 |
| svc-monitor-alerts | (a) | monitoring module + `monitoring-default-alerts.bicep`; :98-104 |
| svc-adf | (a) | anyOf LOOM_ADF_RG emitted; :105-111 |
| svc-posture-refresh | (a) if the post-deploy bootstrap ran (it did on both estates) | :112-118; `azure-functions/posture-refresh/deploy/main.bicep` |
| purview | (a) | LOOM_PURVIEW_ACCOUNT emitted (purviewEnabled); :119-125 |
| usage-embed / govern-embed | (a) likely (KIND=grafana default + Grafana vars from managedGrafanaEnabled); Gov=`limited` (info note only); IL5=`unavailable` (no Fix-it by design) | :127-158 |
| org-visuals, audit-la-workspace | (a) derived | :160-173 |
| svc-databricks | (a) Commercial; **verify Gov** (Databricks region-limited; `availability` on svc-databricks-sql :337-340) | :174-180 |
| svc-activator-adx-scope | (a) | LOOM_ADX_ALERT_SCOPE auto-emitted; :181-187 |
| svc-azure-maps | (a) | MAPS_BACKEND + CLIENT_ID emitted (azureMapsEnabled, enabled 2026-06-30); Gov = maplibre path emitted by Gov bicep; :188-203 |
| svc-loom-capacity-broker | (a) pass (optionalDefault) | :204-210 |
| svc-lcu-autopilot | (a) pass (optionalDefault; LOOM_AUTOPILOT_MODE='propose' emitted) | :211-231 |
| svc-cost-management | (a); RBAC bicep-granted (`cost-management-reader-rbac.bicep`); IL5 unavailable→CSV-ingest fallback | :232-253 |
| svc-cost-forecast | (a) pass (optionalDefault) | :254-278 |
| svc-cost-anomaly-monitor | (a) pass (optionalDefault; job bicep-provisioned `cost-anomaly-monitor-job.bicep`) | :279-305 |
| svc-budgets-write | (a) env-green; **(e) verify** the Cost Management Contributor grant landed (role 434105ed…; re-run deploy with skipRoleGrants=false on older estates) | :306-328 |
| svc-databricks-sql | (a) Commercial; Gov `limited` (Synapse covers) | :329-341 |
| svc-synapse-spark-pool | (a) | :342-348 |
| **svc-cosmos-vcore** | **(c) INFRA**: `modules/deploy-planner/cosmos-vcore.bicep` → KV secret → ACA secret LOOM_COSMOS_VCORE_CONNECTION_STRING. NOT bicep-emitted today → expected **blocked** on both estates. Optional (AI Search covers vector) — decide: deploy or accept as documented-optional | :349-355 |
| svc-eventgrid-topics, svc-iothub, svc-azure-sql, svc-apim(builders), svc-stream-analytics, svc-eventgrid | (a) | all satisfied via LOOM_SUBSCRIPTION_ID / DLZ_RG fallbacks; :356-377, :561-588 |
| svc-webhooks-eventgrid | (a) pass (optionalDefault — signed direct HTTPS default) | :363-370 |
| svc-digital-twins | (a) — satisfied by LOOM_KUSTO_CLUSTER_URI (ADX graph-twin default); ADT endpoint is the Commercial-only opt-in (d) | :378-406 |
| svc-postgres-flex | (a) | LOOM_POSTGRES_AAD_USER emitted (postgresEnabled); :407-413 |
| **svc-pgvector** | **(b) CONFIG**: LOOM_PGVECTOR_HOST NOT bicep-emitted. Set it to the existing PG flexible server FQDN (same server as LOOM_WEAVE_PG_FQDN) via /admin/gates Fix-it (env-picker) → apps[] env. Optional (AI Search covers vector) | :414-420 |
| svc-shir | (a) | SHIR VMSS vars emitted (`shir-vmss.bicep`, deployed 06-30); :421-427 |
| svc-rti-export | (a) | ADLS fallback; :428-434 |
| svc-eh-schema-registry | (a) | LOOM_EH_SCHEMA_GROUP emitted; :435-441 |
| svc-dataverse | (a) Commercial (S2S app wired 2026-07-20, secretRef emitted); **(e) Gov**: needs its own Gov PP app + operator grant (`grant-powerplatform-sp.sh`) | :442-448 |
| svc-lakebase | (a) Commercial (LOOM_DATABRICKS_HOSTNAME); verify Gov | :449-455 |
| svc-aas | (a) everywhere — anyOf includes LOOM_SEMANTIC_BACKEND, ALWAYS emitted (Loom-native default). AAS server itself = (d) opt-in fast path | :459-488 (note: STALE-DOC inside spec — availability says gccHigh/il5 'unavailable' while the PRP ground-truth says AAS IS GA in Gov; comment :475-483 tracks item A4 to flip it. Gate never blocks either way) |
| svc-aml | (a) | anyOf LOOM_AML_WORKSPACE / LOOM_FOUNDRY_NAME emitted; :489-495 |
| svc-model-serving | (a) | anyOf satisfied; :496-511 |
| svc-fine-tuning | (a) | anyOf LOOM_AOAI_ACCOUNT emitted; :512-529 |
| svc-feature-store | (a) Commercial (Databricks); **(b) Gov**: set LOOM_FEATURE_STORE_BACKEND=postgres if Databricks absent | :530-546 |
| svc-powerplatform | (a) env-green (keys on LOOM_UAMI_CLIENT_ID); **(e)**: PP admin must register the UAMI as a management app (`New-PowerAppManagementApp`; done Commercial 07-20; Gov pending) | :547-553 |
| svc-servicebus | (a) | emitted; :554-560 |
| **svc-postgres** | **(b) CONFIG**: anyOf LOOM_POSTGRES_HOST / LOOM_PGVECTOR_HOST — NEITHER emitted (bicep emits only LOOM_POSTGRES_HOST_SUFFIX). Set LOOM_POSTGRES_HOST to the flexible-server FQDN via Fix-it | :575-581 |
| svc-batch | (a) if batchEnabled was on in the estate params; else (c) `landing-zone` batch module | :589-595 |

### ai-copilot (8) — all (a)

| Gate | Class | Evidence |
|---|---|---|
| svc-model-reasoning-tier | (a) pass (optionalDefault; strong/mini emitted from `modules/ai/foundry-project.bicep`) | ai-copilot.ts:11-42 |
| svc-agent-mesh | (a) pass (optionalDefault; cloud-default profile) | :43-58 |
| svc-learning-hub | (a) | AOAI endpoints emitted; :61-71 |
| svc-mcp-catalog | (a) | LOOM_BUILTIN_MCP_URL emitted; :72-81 |
| svc-aoai-embeddings | (a) | LOOM_AOAI_EMBED_DEPLOYMENT emitted; :82-88 |
| svc-copilot-evaluator | (a) likely (functionAppsConfig.copilotEvaluatorEnabled default-ON; URL emitted); wizard fixit if absent | :89-113 |
| svc-graphrag-nl2sql-repair | (a) pass (optionalDefault tuning knobs) | :114-147 |
| svc-iq-mcp | (a) | LOOM_IQ_MCP_ENABLED emitted; :148-154 |

### enrichment (4) — env-green (a) but real function needs (e) Graph consents

| Gate | Env status | Operator action (e) | Evidence |
|---|---|---|---|
| graph-users | (a) LOOM_GRAPH_USERS_ENABLED emitted | Graph **Directory.Read.All** (application) consent on Console UAMI | enrichment.ts:12-19 |
| graph-group-sync | (a) pass (optionalDefault); note LOOM_GRAPH_GROUP_SYNC_ENABLED is NOT bicep-emitted → set =true when enabling | **Group.Read.All + GroupMember.Read.All** via `scripts/csa-loom/grant-identity-graph-approles.sh` | :20-27 |
| svc-m365-link | (a) emitted | **Group.ReadWrite.All** consent | :28-34 |
| svc-sharepoint-shortcuts | (a) emitted | **Files.Read.All** consent | :35-41 |

### builders (18)

| Gate | Class | Evidence |
|---|---|---|
| svc-mcp-deploy | (a) | ACA env id/domain emitted; builders.ts:14-23 |
| svc-warp-engine | (a) | Synapse/Databricks emitted; :24-33 |
| svc-swa-publish | (a) | all three alias groups emitted; :39-52 |
| svc-plan-writeback | (a) pass (optionalDefault; vars also emitted via `modules/shared/plan-backing-sql.bicep`) | :53-59 |
| svc-dab-runtime | (a) derived (dabRuntimeEnabled) | :60-66 |
| svc-udf-function | (a) | udfRuntimeEnabled default on; :67-73 |
| svc-airflow | (a) emitted, but VERIFY non-empty — `modules/deploy-planner/airflow.bicep` is a deploy-planner module; if no Airflow web app exists the value may be blank → then (c) | :74-80 |
| svc-copyjob-control | (a) | emitted; :81-87 |
| svc-weave-ontology | (a) | LOOM_WEAVE_PG_FQDN emitted (AGE store live since 07-19 fixes) | :88-94 |
| svc-dbt / svc-transform-runner | (a) likely — both URL vars emitted, but activation rides the `dbtRunnerImageReady`/`transformRunnerActive` switch (image must be in ACR); verify non-empty | :95-115 |
| svc-approval-logicapp | (a) | emitted (`approval-logicapp.bicep`); :116-122 |
| svc-sample-data / svc-csv-imports | (a) | ADLS fallback / emitted; :123-136 |
| **svc-feedback-forwarding** | **(b) CONFIG (ACA secret)**: LOOM_FEEDBACK_GITHUB_TOKEN NOT emitted — operator stores a fine-grained PAT as ACA secret `loom-feedback-github-token`. Optional (in-store inbox works) | :137-143 |
| svc-param-sources | (a) | KV/AppConfig emitted; :144-150 |
| svc-data-wrangler | (a) | LOOM_WRANGLER_ENDPOINT emitted (`wrangler-app.bicep`); :151-157 |
| svc-apim | (a) | anyOf LOOM_SUBSCRIPTION_ID; :158-164 |

### catalog-governance (4)

| Gate | Class | Evidence |
|---|---|---|
| svc-deploy-planner | (a) | cosmos anyOf; catalog-governance.ts:13-22 |
| svc-org-visuals | (a) derived | :23-33 |
| svc-purview-uc | (a) | LOOM_PURVIEW_UC_ENDPOINT emitted; :34-40 |
| svc-openlineage | (a) pass (optionalDefault); full Spark-lineage enable = **(e)** run `scripts/csa-loom/openlineage-pool-setup.sh` (per-pool credential + listener jar) | :46-56 |

### security (9)

| Gate | Class | Evidence |
|---|---|---|
| svc-pe-subnet | (a) derived | security.ts:11-17 |
| svc-onelake-acl | (a) emitted; role Storage Blob Data Owner bicep-granted | :18-24 |
| svc-audit-siem-stream | (a) pass (optionalDefault; DCR vars also emitted by `audit-stream.bicep`) | :25-39 |
| svc-mip | (a) env-green; **(e)** Graph InformationProtectionPolicy.Read.All consent for real labels | :46-52 |
| svc-dlp | (a) env-green Commercial + (e) Graph DLP roles; **Gov = cloud-unavailable by design** (Graph DLP API absent in GCC-High/IL5; no Fix-it — correct) | :53-66 |
| svc-workspace-identity | (a) pass (optionalDefault; mode off = the sole Phase-0 default-ON exception). shadow→enforce flip = **(e) operator-gated** (I6 hard gate: needs I9 sign-off + ≥2wk clean shadow — `PRPs/active/loom-next-level/DONE.md:176-178`) | :67-92 |
| svc-keyvault | (a) | LOOM_KEY_VAULT_URI emitted; :93-99 |
| svc-secret-expiry | (a) derived (action-group id); **(e)** one-time Graph **Application.Read.All** consent for the secret-expiry Function identity (`docs/fiab/runbooks/secret-rotation.md` §4; DONE.md:27) | :100-118 |
| svc-a2a-egress | (a) pass (optionalDefault — unset = sovereign fail-closed default; setting it is opt-in (d)) | :119-132 |

### observability (5)

| Gate | Class | Evidence |
|---|---|---|
| svc-synthetic-monitor | (a) | all 3 vars emitted (`synthetic-monitor-job.bicep` default-ON); observability.ts:11-25 |
| svc-synthetic-login | (a) pass (optionalDefault — J1 records honest SKIP); full enable = **(e)**: Entra automation account + KV secret `synthetic-login-secret` + **Conditional-Access named-location exception** (the pending "CA exclusion" — `ws-verification-dr.md:210`) | :27-46 |
| svc-client-rum | (a) pass (optionalDefault; vars emitted; App Insights conn string via telemetryEnabled, `admin-plane/main.bicep:616,3169`) | :48-70 |
| svc-alert-action-group | (a) derived | :71-84 |
| svc-alerting | (a) pass (optionalDefault); on-call webhook = **(e) optional** (KV secret `loom-alert-webhook-url` + observabilityConfig.alertWebhookEnabled) | :85-107 |

---

## 5. The runnable checklist — both estates to ZERO involuntary gates

An "involuntary gate" = status `blocked` that is NOT class (d). From the analysis, the expected blocked set on a current push-button estate is small:

### 5.1 Blocked-by-design — LEAVE ALONE (d)
- `svc-loom-trino` (AKS cost carve-out), `svc-ducklake-catalog` (Preview), `svc-s3-gateway` (Preview), `svc-loom-risingwave` (opt-in stateful streaming), `svc-loom-migrate` (only when migrating). Chaos gates (`svc-spark-chaos-drill`, `svc-dependency-chaos-drill`) already PASS with OFF as the intended default. Fabric/Power BI/ADT/AAS-server backends are opt-in alternates that never block their gates.

### 5.2 Involuntary candidates — resolve or accept (verify live first)
1. **svc-pgvector** — (b): Fix-it env-picker → set `LOOM_PGVECTOR_HOST` = the existing PG flexible server FQDN (the LOOM_WEAVE_PG_FQDN server) on BOTH estates. Zero new infra if pgvector extension is on that server.
2. **svc-postgres** — (b): same Fix-it action — set `LOOM_POSTGRES_HOST` (or it turns green with #1 since the anyOf includes LOOM_PGVECTOR_HOST — `azure-services.ts:577`). **One env write can clear both gates.**
3. **svc-cosmos-vcore** — (c): deploy `modules/deploy-planner/cosmos-vcore.bicep` → KV secret → ACA secret; OR accept as documented-optional (AI Search covers vector workloads, `azure-services.ts:352`). Recommendation: accept (cost); it will show blocked with an env-picker Fix-it.
4. **svc-feedback-forwarding** — (b): store a fine-grained GitHub PAT as ACA secret `loom-feedback-github-token` (issues:write) + env. Optional; one secret write per estate.
5. **svc-airflow / svc-dbt / svc-transform-runner / svc-batch / svc-copilot-evaluator** — (a-conditional): vars are emitted but may be EMPTY if the module flag/image switch was off at deploy. Verify (§7); remediation is a redeploy with the flag on (`airflow.bicep`, `dbt-runner-app.bicep` + image in ACR, `batchEnabled`, `functionAppsConfig.copilotEvaluatorEnabled`) — never a hand-typed URL.
6. **Gov-only**: `svc-feature-store` → set `LOOM_FEATURE_STORE_BACKEND=postgres` if Databricks isn't deployed there; `svc-databricks`/`svc-databricks-sql`/`svc-lakebase` → verify; `svc-dlp` shows **cloud-unavailable** (correct, not involuntary); usage/govern-embed show `limited` info note (not a gate).

### 5.3 Operator-only queue (e) — cannot be env writes
| # | Action | Gates cleared / capability lit | Where |
|---|---|---|---|
| 1 | Graph app-role consents on Console UAMI: Directory.Read.All, Group.Read.All+GroupMember.Read.All, Group.ReadWrite.All, Files.Read.All, InformationProtectionPolicy.Read.All, Purview DLP roles | graph-users, graph-group-sync, svc-m365-link, svc-sharepoint-shortcuts, svc-mip, svc-dlp (Commercial only for DLP) | `scripts/csa-loom/grant-identity-graph-approles.sh` + per-gate grantNotes (`lib/gates/registry/enrichment.ts:13-31`, `security.ts:55,60`) |
| 2 | Graph **Application.Read.All** consent for the secret-expiry Function identity | svc-secret-expiry full function | `docs/fiab/runbooks/secret-rotation.md` §4 |
| 3 | Power Platform: register Console UAMI as management app + Dataverse S2S app-user (**Gov estate still pending**; Commercial done 07-20) | svc-powerplatform, svc-dataverse | `scripts/csa-loom/grant-powerplatform-sp.ps1` |
| 4 | Authorize the report-subscription Logic App's Office 365 connection (portal, one-time) | svc-report-subscriptions delivery | azure-services.ts:36 |
| 5 | Synthetic login: create automation account, KV secret `synthetic-login-secret`, set SYNTHETIC_LOGIN_UPN/SECRET on the monitor job, **CA named-location exception** (the pending "CA exclusion") | svc-synthetic-login J1 probe | observability.ts:38; `ws-verification-dr.md:210` |
| 6 | **FIC flip** on the prod MSAL app reg (S2 decision: migrate to federated identity credential; operator-sensitive scheduled follow-up) | entra-app hardening (no gate change) | `docs/fiab/runbooks/msal-credential-strategy.md`; DONE.md:13 |
| 7 | I6 workspace-identity **enforce** flip — HARD-GATED: do NOT flip until I9 sign-off + 14-day clean shadow | svc-workspace-identity posture | DONE.md:176-178 |
| 8 | OpenLineage pool-setup script per Spark pool | svc-openlineage full Spark feed | `scripts/csa-loom/openlineage-pool-setup.sh` |
| 9 | Optional on-call webhook (KV `loom-alert-webhook-url` + bag flag) | svc-alerting page channel | `docs/fiab/runbooks/on-call.md` |
| 10 | svc-budgets-write: confirm Cost Management **Contributor** grant landed (re-run deploy skipRoleGrants=false on estates older than the C4 bicep) | budget CRUD | azure-services.ts:317-319 |

## 6. Fix-it coverage gaps (G2 compliance findings)

1. **REAL-GAP (minor): 17 bespoke `*_not_configured` codes emitted by live routes but NOT registered as any gate's `legacyCodes`** — `gateForLegacyCode()` (registry/index.ts:129-131) returns undefined for them, so an HonestGate raised from these errors cannot deep-link its registry Fix-it: `dab_not_configured` (app/api/items/ontology-sdk/[id]/query/route.ts), `dbx_not_configured`, `dspm_ai_not_configured`, `function_runtime_not_configured`, `geocode_not_configured`, `grafana_not_configured` + `usage_report_not_configured` (app/api/admin/usage/embed/route.ts, app/api/governance/govern/embed/route.ts), `lake_not_configured`, `materializer_not_configured`, `posture_not_configured`, `powerbi_not_configured`, `report_not_configured`, `serverless_not_configured`, `sharepoint_not_configured`, `swa_not_configured` (lib/azure/swa-publish.ts), `sync_not_configured`, `weave_not_configured` (app/api/items/ontology/[id]/{explore,links,objects}/route.ts). Most have an obvious owning gate (svc-dab-runtime, usage-embed, svc-swa-publish, svc-weave-ontology…) — a mapping-only PR closes this.
2. **By design, not a gap**: `cloud-unavailable` gates render NO Fix-it (registry/index.ts:181-192 — "you cannot provision the impossible"); `role-grant`/`wizard` fixits (24 gates, §2) surface grantNote + pre-filled fixScript instead of an env write — compliant with ux-standards G2.
3. **Registry-level completeness is test-enforced** — every gate has surfaces + fixit + remediation (`lib/gates/__tests__/registry.test.ts:29-43`); no gate lacks a Fix-it entry.
4. **STALE-DOC**: svc-aas `availability` still encodes gccHigh/il5 'unavailable' contradicting the PRP ground-truth (AAS IS GA in Gov); tracked as item A4 in-code (`env-checks/azure-services.ts:475-483`). Harmless (gate always satisfied via LOOM_SEMANTIC_BACKEND) but flip pending.

## 7. Verification (run per estate — read-only)

```bash
# 1) Live registry rollup (minted-session harness):
GET https://<console-fqdn>/api/admin/gates   # → {count, configured, blocked, gates[], writeConfigured}
# expect: blocked == exactly the (d) set {svc-loom-trino, svc-ducklake-catalog, svc-s3-gateway,
#         svc-loom-risingwave, svc-loom-migrate} (+ any of §5.2 not yet resolved/accepted)

# 2) Confirm emitted-but-possibly-empty vars:
az containerapp show -n loom-console -g <admin-rg> \
  --query "properties.template.containers[0].env[?name=='LOOM_AIRFLOW_ENDPOINT'||name=='LOOM_DBT_RUNNER_URL'||name=='LOOM_TRANSFORM_RUNNER_URL'||name=='LOOM_BATCH_ACCOUNT'||name=='LOOM_COPILOT_EVALUATOR_URL'||name=='LOOM_PGVECTOR_HOST'||name=='LOOM_POSTGRES_HOST']"

# 3) UI: /admin/gates → filter status=blocked; every row must show a Fix-it button
#    (or a cloud-unavailable fallback note in Gov).
```

**Bottom line**: 125 gates; ~92 evaluate green on a current push-button deploy (bicep-emitted / derived / optionalDefault), 28 of those via fully-functional optionalDefault fallbacks; 5 are blocked **by design** (leave OFF); the true involuntary tail is ≤4 env/secret writes (`LOOM_PGVECTOR_HOST`+`LOOM_POSTGRES_HOST` pair, feedback PAT, cosmos-vcore accept-or-deploy) plus a 10-item operator queue (Graph consents ×6, PP/Dataverse on Gov, O365 connection, synthetic-login+CA exclusion, FIC flip, I6 enforce — the last two intentionally deferred).

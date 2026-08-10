# GCC-High readiness — classification of the 16 blocked + 8 partial capabilities

**Measured:** 2026-08-10, `/api/admin/readiness` on the Gov (GCC-High) Console.
**Score:** 86/100 — 100 ready, 8 partial, 16 blocked, 84 config-only.
**Method:** static, from the repo (bicep + `lib/admin/env-checks/**` + workflows)
plus GitHub Actions run/workflow state. **No Azure CLI was run against Gov from
a workstation** (standing operator rule — Gov is verified only through Actions).
Every verdict carries `file:line` evidence; where the repo cannot settle a
question it says **UNKNOWN** and names the Actions lane that would.

---

## Headline

**12 of the 16 are fixable by wiring (bucket a). Only 3 are real gaps, and 1 is
not a gap at all — it is a gate reporting a defect the platform deliberately and
losslessly chose.**

| Bucket | Count | Items |
|---|---|---|
| **(a) DEPLOYED-BUT-UNWIRED** — value derivable at deploy time; `auto-bind-by-default.md` §5 violation | **12** | migrate, risingwave, aisearch, pgvector, batch, copilot-evaluator, m365-link, sharepoint-shortcuts, copyjob-control, weave-ontology, unity-authz, synthetic-monitor |
| **(b) GENUINELY NOT DEPLOYED in Gov** | **1** | airflow |
| **(c) OPT-IN FLAG that should default ON** | **1** | ducklake-catalog |
| **(d) CLOUD-PARITY GAP** (substitute already supplied) | **1** | databricks-sql |
| **Defective gate — no underlying gap** | **1** | purview-uc |

---

## Root cause behind 8 of the 12 (a)s: the GCC-High orchestrator lane is DISABLED

This is the single most important finding, and it is invisible to `gh run list`.

```
gh api repos/:owner/:repo/actions/workflows
  → deploy-fiab-gcch.yml   state = disabled_manually     # every other gov-* lane is "active"
```

`deploy-fiab-gcch.yml` is the **only** lane that runs
`az deployment sub create … -p params/gcc-high.bicepparam`
(`.github/workflows/deploy-fiab-gcch.yml:441`). Every `LOOM_*` env var on
`loom-console` is written by
`module appDeployments … if (containerPlatform == 'containerApps' && deployAppsEnabled)` —
the exact mechanism documented at `scripts/ci/deploy-trigger-policy.mjs:101-109`.
No orchestrator run ⇒ no env write.

**Last run that actually executed the Provision step: 2026-07-03** (run
`28659080726`, `schedule`, success). Since then:

| Date | Result | Note |
|---|---|---|
| 2026-07-14 → 2026-08-03 | **failure ×20** (all `schedule`) | 08-03 (`30815034083`) failed at **"Topology guard"** |
| 2026-08-03 → today | **no scheduled runs at all** | lane `disabled_manually`; cron `0 10 * * *` never fires |
| 2026-08-08 06:55 | "success" (`31245000009`) | `run_mode=whatif-only` — **"Provision (with full Gov dispatch)" step = `skipped`** (gated at `deploy-fiab-gcch.yml:410`) |

The topology guard has since been fixed to let a scheduled reconcile through
(`deploy-fiab-gcch.yml:246-249`, which names this incident: "RED on its 10:00 UTC
cron every day for 16 days"). **That fix is merged and cannot run, because the
workflow is disabled.** `deploy-integrity.md` R1 + R3.

**Consequence:** anything whose enabling param or emission landed after
2026-07-03 is inert on the Gov estate no matter what the code says. Measured
directly — `git log -L` on `params/gcc-high.bicepparam` dates
`aiSearchEnabled=true` (:301), `loomWorkspaceM365LinkEnabled=true` (:353) and
`loomSharepointShortcutsEnabled=true` (:357) to **2026-07-20 18:17**, seventeen
days after the last successful provision. Three merged "fixes" that have never
touched the estate.

### Out-of-band env patching is not durable

`gov-provision-aisearch.yml:119` wires the var directly:
`az containerapp update -n "$APP" … --set-env-vars "LOOM_AI_SEARCH_SERVICE=$SVC"`,
and it **succeeded 2026-07-21**. The gate is blocked again on 2026-08-10.
`gov-console-roll` ran 5× on 07-31/08-01 in between. `deploy-fiab-gcch.yml:253-256`
states the mechanism outright: *"An ACA template rewrite drops every env var it
does not declare."* Every value must come from the orchestrator; `gov-apply-env.yml`
and the `gov-provision-*` patches are a temporary poultice, not a fix.

---

## The 16 blocked

| # | Gate | Env var | Verdict | Evidence |
|---|---|---|---|---|
| 1 | `svc-ducklake-catalog` | `LOOM_DUCKLAKE_CATALOG_URL` | **(c)** | `admin-plane/main.bicep:1088` `ducklakeCatalogActive = … && postgresStoresAllowed`; `params/gcc-high.bicepparam:268` `postgresQuotaAvailable=false`. The param file itself (`:235-242`) cites Learn that **PostgreSQL Flexible Server IS a Gov service** — so not a cloud gap. `:263-267`: "on GCC-High the N8 DuckLake catalog store is SKIPPED by default". Held hostage by Airflow (see #11), not by its own defect. |
| 2 | `svc-loom-migrate` | `LOOM_MIGRATE_URL` | **(a)** | Emitted `admin-plane/main.bicep:4305`; `loomMigrateActive` (`:965`) = enabled && containerApps && deployAppsEnabled — all three true in `gcc-high.bicepparam:85,286`; image tag declared `:215`. Nothing gates it off in Gov. Never applied. |
| 3 | `svc-loom-risingwave` | `LOOM_RISINGWAVE_URL` | **(a)** | Emitted `:4323`; `risingwaveActive` `:983`; tag `gcc-high.bicepparam:216`. Identical to #2. |
| 4 | `svc-aisearch` | `LOOM_AI_SEARCH_SERVICE` | **(a)** | Emitted `:4483`; `aiSearchEnabled=true` `gcc-high.bicepparam:301` **added 2026-07-20**, after the last provision. Out-of-band wire succeeded 07-21 and did not survive (see above). |
| 5 | `svc-databricks-sql` | `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` | **(d)** | `gcc-high.bicepparam:113` `databricksSqlWarehouseEnabled = false // NOT in Gov`. Substitute already shipped and named in the spec's own availability matrix (`azure-services.ts:330-345`): Synapse dedicated SQL + the Kusto/Synapse DQ-monitor backends. Opt-in Gov lanes exist (`gov-provision-dbx-sql.yml`, `gov-provision-dbx-sql-invnet.yml`). **The gap is closed; the GATE is wrong to call it Blocked.** |
| 6 | `svc-pgvector` | `LOOM_PGVECTOR_HOST` | **(a)** | **No bicep anywhere emits this var** — grep over `platform/**` returns zero. The spec's `provisionedBy` names `modules/deploy-planner/postgres-flexible.bicep`, **a file that does not exist** (deploy-planner has `postgres.bicep`; the flexible-server module is `modules/landing-zone/postgres-flexible.bicep`). The server is deployed and pgvector allowlisted (`landing-zone/postgres-flexible.bicep:131`) and its FQDN is already derived for `LOOM_POSTGRES_HOST` (`main.bicep:1393`). Unclearable on **every** cloud. |
| 7 | `svc-batch` | `LOOM_BATCH_ACCOUNT` | **(a)** | `admin-plane/main.bicep:1297` `loomBatchAccount = byoExisting.?batchAccount ?? ''`; `main.bicep:1281` `batchAccount: (useSingleDlz && batchEnabled) ? … : ''`. See the `useSingleDlz` cliff below. `batchEnabled` is day-one default ON (`main.bicep:669`). |
| 8 | `svc-copilot-evaluator` | `LOOM_COPILOT_EVALUATOR_JOB_ID` | **(a)** | Emitted `:5505`; `copilotEvaluatorEnabled = … ?? true` (`:440`), `copilotEvaluatorActive` (`:7245`) satisfied by `gcc-high.bicepparam`. Never applied. |
| 9 | `svc-m365-link` | `LOOM_WORKSPACE_M365_LINK` | **(a)** | Emitted `:5128` under `loomWorkspaceM365LinkEnabled`, set `true` at `gcc-high.bicepparam:353` **2026-07-20**. Graph `Group.ReadWrite.All` consent is a separate, legitimately-gated tenant-admin step (`gov-provision-graph-grants.yml`). |
| 10 | `svc-sharepoint-shortcuts` | `LOOM_SHAREPOINT_SHORTCUTS_ENABLED` | **(a)** | Emitted `:5147`; `gcc-high.bicepparam:357`, same 2026-07-20 commit. Same Graph-consent caveat. |
| 11 | `svc-airflow` | `LOOM_AIRFLOW_ENDPOINT` | **(b)** | Emitted `:4265`; `airflowHostActive` (`:1036`) requires `airflowPostgresAllowed`, which rides the same `postgresQuotaAvailable=false`. `gcc-high.bicepparam:244-261` names **two real, fixable defects**: (1) `admin-plane/airflow.bicep` defaults `airflowImage` to an anonymous **docker.io** pull `apache/airflow:2.10.5-python3.12`, unmirrored — unpullable from a locked-egress Gov CAE, unscanned on the way in; (2) `admin-plane/main.bicep` invokes it with `privateEndpointsEnabled: false` ⇒ `publicNetworkAccess:'Enabled'` + a `0.0.0.0` firewall rule on its metadata Postgres. |
| 12 | `svc-copyjob-control` | `LOOM_COPYJOB_CONTROL_SQL_SERVER` | **(a)** | Emitted `:4019` from `param loomCopyJobControlSqlServer = ''` (`:2321`); the control module fires only `if (copyJobControlEnabled && !empty(loomCopyJobControlSqlServer))` (`:3197`). **No caller anywhere passes it.** The cited provisioner `modules/shared/plan-backing-sql.bicep` creates only a *database on an existing server* (module header `:12-15`) and is itself invoked only `if (!empty(loomPlanBackingSqlServer))` (`:7491`) — also never passed. Dead chain on every cloud. |
| 13 | `svc-weave-ontology` | `LOOM_WEAVE_PG_FQDN` | **(a)** | Emitted `:3882`; `main.bicep:1385` `loomWeavePgFqdn: (useSingleDlz && weaveOntologyEnabled) ? … : ''`, `weaveOntologyEnabled` default true (`main.bicep:452`). `useSingleDlz` cliff. Also starves GraphRAG grounding, which names this gate as its substrate (`ai-copilot.ts:131`). |
| 14 | `svc-purview-uc` | `LOOM_PURVIEW_UC_ENDPOINT` | **Defective gate** | `admin-plane/main.bicep:4976` emits it only under `(purviewEnabled && boundary == 'Commercial')`. The comment at `:4960-4975` states plainly: off-Commercial "we DO NOT wire this at all — the data-product factory ignores Unified Catalog there and uses Cosmos (`resolveDataProductBackend()` forces 'cosmos' when boundary != Commercial) … **no gate; 100% functional Azure-native**". Also `purviewEnabled=false` (`gcc-high.bicepparam:117`, reuse tenant Purview). The platform deliberately and losslessly declines to set it; the spec (`catalog-governance.ts:35-40`) lacks `optionalDefault` / boundary scoping, so it reports a defect that does not exist. Secondary note: `api.purview-service.microsoft.com` is a Commercial-only host — a Gov UC endpoint would be a genuine (d), but the substitute (classic Data Map via `LOOM_PURVIEW_ACCOUNT` + Cosmos data products) is already shipped. |
| 15 | `svc-loom-unity-authz` | `LOOM_UNITY_CLIENT_ID` | **(a)** | Emitted `:4347` `loomUnityActive ? effectiveMsalClientId : ''`; `loomUnityActive` (`:1166`) satisfied; `unity` image tag `gcc-high.bicepparam:222`. This is #2681's DEFAULT-ON change, which post-dates 2026-07-03. **This is the cloud-parity headline**: per `.claude/rules/cloud-parity.md`, Databricks UC does not exist in Azure Government, so Loom Unity + Iceberg/Trino *is* the Gov catalog and federation story — and it is inert on Gov because the lane is off. The old out-of-band path `gov-uc-purview-wire.yml` **failed 2026-08-06**. |
| 16 | `svc-synthetic-monitor` | `LOOM_SYNTHETIC_MONITOR_ENABLED`, `LOOM_UAT_RESULTS_ACCOUNT`, `LOOM_UAT_RESULTS_CONTAINER` | **(a)** | Emitted `:4081-4083`; `syntheticMonitorEnabled = … ?? true` (`:495`), `uatResultsStoreActive = syntheticMonitorEnabled` (`:6847`). `gcc-high.bicepparam` disables none of it, and `:6846` records the fix ("`LOOM_UAT_RESULTS_ACCOUNT` blank on every shipped bicepparam is gone"). Never applied. Honest caveat: *results* additionally need a tenant CA exclusion for the synthetic account (`observability.ts:20`) — that is a separate, legitimately-human step and does not gate these three vars. |

### The `useSingleDlz` derivation cliff (#7, #13 — and more)

`main.bicep:1067-1076`:

```bicep
var effectiveTopology   = empty(topology) ? deploymentMode : topology
var deployLandingZones  = effectiveTopology != 'tenant'
var useSingleDlz        = deployLandingZones && effectiveTopology == 'single-sub'
```

`gcc-high.bicepparam` sets `deploymentMode='multi-sub'` (`:74`) and
`topology='tenant'` (`:76`); `deploy-fiab-gcch.yml` passes
`topology="$CSA_LOOM_TOPOLOGY"` (`:445`) from `${{ inputs.topology || '' }}`.
**`useSingleDlz` is false on Gov under either resolution** — `'tenant'` makes
`deployLandingZones` false outright; `'multi-sub'` fails the `== 'single-sub'`
test. So `main.bicep` passes `''` for `batchAccount`, `loomWeavePgFqdn`,
`loomPostgresHost` (`:1393`), `amlDefaultCompute` (`:1268`) and
`serviceBusNamespace` (`:1260`) on every Gov deploy.

**How Gov differs from the Commercial finding — verified, not assumed.** On
Commercial the same line produced `''` because the estate is genuinely
*multi-subscription* and the lake / Databricks / Event Hubs lived in a different
subscription. That specific cause does **not** apply here: the Gov lanes
authenticate with a single `AZURE_GOV_SUBSCRIPTION_ID` and target one admin RG
(`gov-discover.yml:15-16`, `deploy-fiab-gcch.yml` login block), consistent with
the operator's statement that Gov is same-subscription. **The Gov reading is
therefore worse, not better:** the backing resource is in the *same subscription*
and the template still emits `''`, purely because no code path derives these
values outside `single-sub`.

**UNKNOWN, and honestly so:** in `tenant` topology `deployLandingZones` is false,
so this template deploys no DLZ at all — the DLZ arrives from a separate
`dlz-attach` pass. Whether the Batch account and the Weave Postgres server
actually *exist* in the Gov subscription cannot be settled from this repo or
from this host. **`gov-discover.yml` settles it** — it is read-only, Actions-only,
and exists precisely for this ("probe ARM existence and read the app-env values
needed to compose a pointer"). Dispatch it before committing to a fix for #7/#13.

**The mechanism to fix it already exists.** `dlzAttachS3Gateway`
(`main.bicep:2178`) deploys from the dlz-attach pass, emits `dlzS3GatewayUrl`
(`:2145`), and the pass re-applies it onto the already-running Console via
`az containerapp update --set-env-vars` (`:2098`). Exactly one variable uses this
path. Generalising it is the fix.

---

## The 8 partial

`partial` = the gate's live probe returned `warn` (`readiness.ts:351,359`;
`STATE_VALUE.partial = 0.5` at `:295`). `health-probes.ts:7-10` returns `warn`
for **both** "unconfigured" and "configured + broken", so *partial alone does not
distinguish the two* — none of these can be classified from the repo without a
probe run.

| Gate | Probe | Read |
|---|---|---|
| `svc-adx` | `probe-kusto` (`health-probes.ts:135`) | `adxEnabled=true` (`gcc-high.bicepparam:306`). **UNKNOWN** — reachability/PE vs unset. |
| `svc-adf` | `probe-adf` (`:220`) | `loomDataFactoryEnabled=true` (`:340`). **UNKNOWN**. |
| `svc-databricks` | `probe-databricks` (`self-audit.ts:286`) | `loomDatabricksEnabled=true` (`:339`) but UC **and** SQL warehouse both false (`:112-113`) — a deliberately partially-capable workspace. (d)-adjacent, expected. |
| `svc-aas` | `probe-aas` (`:537`) | `aasEnabled=false` (`:305`) with the comment *"Azure Analysis Services is NOT available in GCC-High"*. **This contradicts the recorded finding that AAS is GA in Gov** (memory `csa_loom_next_level_prp_2026_07_22`). One of the two is wrong and it flips the verdict between (d) and (c). **FLAG — verify against Learn; do not guess.** |
| `svc-aml` | `probe-aml` (`:565`) | `amlDefaultCompute` is another `useSingleDlz` casualty (`main.bicep:1268`). Same cliff as #7/#13. |
| `svc-powerplatform` | `probe-powerplatform` (`:343`) | Needs the BAP mgmt-app + environment app-user S2S grant. Genuine tenant-admin step (allowed per `auto-bind-by-default.md` §Allowed); `gov-dataverse.yml` exists. |
| `graph-users` | `probe-graph-directory` (`:316`) | Needs `Directory.Read.All` app-role consent → `gov-provision-graph-grants.yml`. Genuine tenant consent, but per `ux-baseline.md` G2 it must be a one-click in-product **Fix it**, not a paragraph. |
| `svc-dab-runtime` | `probe-dab-runtime` | `LOOM_DAB_PREVIEW_URL` is `derived: true` (`builders.ts:62`), emitted by `admin-plane/dab-runtime.bicep`. Same never-applied class as the (a) group. |

---

## Prioritised fix plan

### P0 — one action clears 8 of 16: re-enable and run the Gov lane

Re-enable `deploy-fiab-gcch.yml` and dispatch once with `run_mode=full` +
`allow_existing_hub=true`. On the code as it stands in `main` this re-applies
`admin-plane/main.bicep` to the Gov Console and should clear **#2 migrate,
#3 risingwave, #4 aisearch, #8 copilot-evaluator, #9 m365-link,
#10 sharepoint-shortcuts, #15 unity-authz, #16 synthetic-monitor (3 vars)** —
plus, very likely, `svc-dab-runtime` from the partials.

**Preconditions — verify before dispatch, or the deploy takes the estate down.**
A Container App PUT naming an absent manifest fails `MANIFEST_UNKNOWN` and aborts
the nested deployment. The image preflight (`deploy-fiab-gcch.yml:364-406`)
asserts only `loom-duckdb` and `loom-unity`; **`loom-migrate`, `loom-risingwave`
and `loom-trino` are NOT preflighted** even though `gcc-high.bicepparam:215,216,232`
all reference them. Current lane state: `gov-build-images` ✅ 2026-08-08,
`gov-provision-dataplane-images` ✅ 2026-08-07,
**`gov-provision-streaming-migrate` ❌ 2026-08-08 — must be green first.**

Also per `deploy-integrity.md` R3: a `disabled_manually` lane is invisible to
`gh run list`. Surface "deploy lane disabled" and "estate behind main" on
`/admin/readiness`, where the operator looks. (Precedent:
`csa_loom_red_lane_disabled_not_fixed`.)

### P1 — fix the `useSingleDlz` derivation cliff

One change clears **#7 batch + #13 weave** and simultaneously unblocks
`LOOM_POSTGRES_HOST`, the AML default compute and the Service Bus namespace on
every `tenant`/`multi-sub` estate in **both** clouds. Copy the `dlzAttachS3Gateway`
pattern (`main.bicep:2098, 2145, 2178`): derive from the dlz-attach pass and
patch the running Console. Gate on the `gov-discover.yml` result first.

### P2 — split `postgresQuotaAvailable`

It currently gates two unrelated hosts, so DuckLake is blocked by Airflow's
defects. Split into `catalogPostgresAllowed` and `airflowPostgresAllowed`; that
alone clears **#1 DuckLake** (the param file's own Learn citation says Postgres
Flexible Server is a Gov service). Then close **#11 Airflow** properly: mirror
`apache/airflow` **by digest** into `platform/fiab/images/upstream-images.json`
via `scripts/ci/mirror-upstream-images.sh` (the s3proxy precedent — that module
has no public-pull branch left) and give the metadata Postgres a private endpoint.

### P3 — gate-truth fixes (no infrastructure, no deploy)

- **#14 `svc-purview-uc`** → `optionalDefault: true` with an
  `optionalDefaultDetail` naming the classic Data Map + Cosmos data-product path.
  The unset state is the platform's deliberate, fully-functional choice
  off-Commercial. Cheapest false deduction on the Gov score.
- **#5 `svc-databricks-sql`** → `optionalDefault: true` naming Synapse dedicated
  SQL / Kusto as the shipped substitute, matching its own availability matrix.

A gate that reports Blocked for a state the platform chose on purpose, and that
loses no capability, is measuring the wrong thing.

### P4 — build the missing wiring

- **#6 pgvector** — emit `LOOM_PGVECTOR_HOST` from the same derived FQDN
  `LOOM_POSTGRES_HOST` already uses (`main.bicep:1393`).
- **#12 copy-job control** — either wire `loomCopyJobControlSqlServer` to the
  platform SQL server, or delete the gate. A gate no deploy path can ever
  satisfy is worse than no gate.

### P5 — stop patching env out of band

`gov-apply-env.yml` and the `gov-provision-*` `--set-env-vars` writes do not
survive a template rewrite (`deploy-fiab-gcch.yml:253-256`); #4 is the proof —
wired 2026-07-21, blocked again 2026-08-10. Every value must be produced by the
deploy (`auto-bind-by-default.md` §5).

---

## What this document does NOT establish

- **No live Gov verification was performed.** Everything above is repo evidence
  plus Actions run/workflow state. Whether each var is *actually* empty on the
  live Console, and whether the Batch/Weave resources exist, requires
  `gov-discover.yml` (read-only) and a post-fix `gov-selfaudit.yml`.
- **`merged ≠ deployed`** (`deploy-integrity.md` R2). Nothing here is fixed. The
  P0 action is the only step that can change what the operator sees, and it has
  not been taken.
- The `svc-aas` availability contradiction is **unresolved** and deliberately
  left open rather than guessed.

# IL5 / GCC-High full-stack deploy verification (A-4 / PMF-64)

**Scope:** the reproducible teardown → redeploy procedure for CSA Loom on Azure
Government (DoD IL5 and GCC-High / IL4), plus the live-endpoint checklist that
constitutes the acceptance evidence for "full-stack functionality on the gov
cloud endpoints," plus an honest register of what still blocks a fully-green
gov full-stack run.

This runbook is the procedure half; the deterministic half lives in
`platform/fiab/bicep/tests/test_bicep_modules.py` (the MAF + `copilotMafEnabled`
ARM-emission tests) and runs in CI on every PR.

---

## 1. What this verifies

| Layer | Gov-specific concern | How it is checked |
|-------|----------------------|-------------------|
| Template compiles | `main.bicep` + both gov `.bicepparam` build clean | `az bicep build` / `az deployment sub what-if` (CI + this runbook) |
| MAF tier wiring | `loom-copilot-maf` emits Gov AOAI-direct env | `test_bicep_modules.py::test_maf_bicep_wires_gov_aoai_direct` |
| `copilotMafEnabled` threaded | flag reaches the admin-plane from main.bicep as a real bool param | `test_bicep_modules.py::test_main_bicep_threads_copilot_maf_enabled` (gov params set it `false` today — see gap #1) |
| Teardown → redeploy | clean-sub idempotent redeploy | `scripts/csa-loom/redeploy-gov.sh --boundary <il5\|gcc-high>` |
| Live full-stack | Console/MCP/orchestrator/MAF reachable on Gov hosts | `.github/scripts/fiab-smoke-test.sh` (Tests 1-8) |
| Sovereign endpoints | every host resolves to `*.usgovcloudapi.net` / `*.azure.us` | §4 endpoint matrix |

---

## 2. Prerequisites (one-time, operator)

- `AZURE_GOV_CLIENT_ID/SECRET/TENANT_ID/SUBSCRIPTION_ID` GitHub secrets
  (the `limitlessdata_deploy` SP, Owner + User Access Administrator on the Gov sub).
- `FIAB_GOV_ADMIN_GROUP_ID` — the Gov-tenant FiaB-Admins Entra group GUID
  (overrides the `<replace-with-…>` placeholder in the `.bicepparam`).
- `LOOM_GOV_MSAL_CLIENT_ID` / `LOOM_GOV_MSAL_CLIENT_SECRET` — gov-tenant app reg.
- Container images pushed to the boundary-local ACR (`loom-console`, `loom-mcp`,
  `loom-orchestrator`, `loom-activator`, `loom-mirroring`, `loom-direct-lake-shim`,
  and — for the MAF tier — `loom-copilot-maf`).
- `az cloud set --name AzureUSGovernment && az login` (the script refuses to run
  on any non-Gov cloud — Phase 0 guard).

---

## 3. Teardown → redeploy

### Scripted (preferred)

```bash
# Validate only (Bicep + auth, no provisioning):
make redeploy-gov-il5 WHATIF=1
make redeploy-gov-gcch WHATIF=1

# Full teardown -> redeploy -> RBAC grants -> smoke (interactive confirm):
make redeploy-gov-il5
make redeploy-gov-gcch
# CI / non-interactive: append YES=1 (or pass --yes to the script).
```

`scripts/csa-loom/redeploy-gov.sh` runs four phases: Phase 0 guard rails
(cloud + sub confirmation), Phase 1 teardown (`fiab-teardown.sh`, purges
KV/HSM so names don't stay reserved), Phase 2 `az deployment sub create`
against the gov `.bicepparam`, Phase 3 idempotent Console RBAC grants
(`grant-console-rbac.sh`), Phase 4 `fiab-smoke-test.sh` on the live endpoints.

### CI

The `deploy-fiab-il5.yml` and `deploy-fiab-gcch.yml` workflows
(`workflow_dispatch`, `run_mode: full`) drive the same path behind the
`il5-deploy` / `gcc-high-deploy` manual-approval environment gates.

### Manual fallback

```bash
az deployment sub create \
  --name csa-loom-il5-$(date +%s) --location usgovvirginia \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/il5.bicepparam \
  --parameters adminEntraGroupId=$FIAB_GOV_ADMIN_GROUP_ID
```

### Evidence receipt (offline-safe, no Gov sub required)

`scripts/csa-loom/gov-verify-evidence.sh` collects the *verifiable* evidence and
emits the §7 receipt for a boundary in one shot — runnable on any dev box (it
does NOT need a Gov subscription):

```bash
make gov-verify-il5            # -> temp/gov-verify-receipt-il5-<ts>.txt
make gov-verify-gcch
make gov-verify-il5 LIVE=1     # additionally drives redeploy-gov.sh --what-if when on a Gov sub
```

It runs, and records as PASS/FAIL/SKIPPED/BLOCKED in the receipt:

1. the deterministic ARM-emission tests (`test_bicep_modules.py` MAF +
   `copilotMafEnabled` wiring) — proof the deployed template is correct;
2. the static sovereign-endpoint sweep (`cloud-matrix.test.ts` +
   `cloud-endpoints.test.ts`, 4-cloud) plus the read-only §4 host-matrix dump
   (`loom-endpoint-probe.sh`), asserting every host resolves to a Gov suffix;
3. the live teardown→redeploy line — **BLOCKED by gap #2** until the in-repo AKS
   workload deployment for the Loom apps exists; honestly recorded, never faked.

The IL5 deploy workflow (`deploy-fiab-il5.yml`) runs this and uploads the
receipt as a build artifact (`gov-verify-receipt-il5-<run_id>`) on every
dispatch, so the acceptance evidence is captured automatically in CI.

---

## 4. Sovereign endpoint verification matrix

Every backend host must resolve to a Gov suffix. `apps/fiab-console/lib/azure/cloud-endpoints.ts`
is the single source of truth; with `AZURE_CLOUD=AzureUSGovernment` (both IL5
and GCC-High set `loomAzureCloud='AzureUSGovernment'`) the helpers MUST return:

| Helper | Expected Gov value |
|--------|--------------------|
| `armBase()` | `https://management.usgovcloudapi.net` |
| `kvSuffix()` | `.vault.usgovcloudapi.net` |
| `dfsSuffix()` | `.dfs.core.usgovcloudapi.net` |
| `kustoSuffix()` | `.kusto.usgovcloudapi.net` |
| `cogScope()` | `https://cognitiveservices.azure.us/.default` |
| `getGraphHost()` | `graph.microsoft.us` (GCC-High) / `dod-graph.microsoft.us` (IL5) |
| `getPbiScope()` | `https://high.analysis.usgovcloudapi.net/...` |
| `isGovCloud()` | `true` |
| `assertFabricFamilyAvailable('fabric'\|'powerbi')` | throws honest-gate (Fabric family not on Gov) |

The string-level regression gate is `lib/azure/__tests__/cloud-matrix.test.ts`
(+ `cloud-endpoints.test.ts`). This runbook's §5 confirms the **live** hosts
match these strings.

MAF tier (`platform/fiab/bicep/modules/copilot/maf.bicep`) is wired to call Gov
AOAI directly: `AZURE_CLOUD=AzureUSGovernment`, `LOOM_AOAI_AUDIENCE=https://cognitiveservices.azure.us`,
`LOOM_CLOUD = IL5 ? 'GCC-High' : boundary` (IL5 collapses to GCC-High endpoints).

---

## 5. Full-stack functional checklist (acceptance evidence)

Run after a `full` redeploy and capture each as a receipt line:

- [ ] `az deployment sub show` → `provisioningState=Succeeded`.
- [ ] `consoleUrl` output is on `*.usgovcloudapi.net` and `/api/health` → 200.
- [ ] `/api/workspaces` unauth → 401/403 (auth gate intact).
- [ ] MCP `/.well-known/health`, orchestrator/activator/mirroring `/health` → 200.
- [ ] `/api/copilot/orchestrate` unauth → 401/403 (Test 8); record `copilotMafEndpoint`.
- [ ] If MAF active: an authed `POST /api/copilot/orchestrate` returns an SSE
      `OrchestratorStep` stream (proxied to `loom-copilot-maf` → Gov AOAI).
- [ ] Honest-gate surfaces render their warning MessageBar, not an error:
      Front Door (IL5 off), AI Foundry (IL5 off), AI Search (off), Content
      Safety (IL5 off — copilot moderation gated), Fabric/Power BI family
      (`assertFabricFamilyAvailable` throws → gated).
- [ ] `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — every item still installs +
      its editor works on the Azure-native backend (per `no-fabric-dependency`).

---

## 6. Honest gap register

The following are tracked, load-bearing facts discovered during verification.
They are disclosed here per `no-vaporware.md` rather than papered over.

1. **Compute-platform vs. MAF tier (MAF cannot run at IL4/IL5).** Both gov
   params set `containerPlatform = 'aks'`. The Loom apps — including the MAF
   `loom-copilot-maf` Container App — deploy only via `app-deployments.bicep` /
   `maf.bicep`, which are gated on `containerPlatform == 'containerApps'`. Azure
   Container Apps is **not** authorized at IL4/IL5 (gap #3), so MAF can never
   activate on a compliant gov compute path today. `copilotMafEnabled` is
   therefore set **`false`** on both gov params (honest, not a silent no-op):
   the Console `copilot-orchestrator.ts` uses Gov AOAI-direct, which is the
   real, working backend at these boundaries (line ~1511:
   `if (isGovCloud() && mafEndpoint)` → else Gov AOAI-direct fallback). The flag
   stays threaded through `main.bicep` (regression-tested) so the tier activates
   automatically the moment an AKS-workload deployment for the apps exists.

2. **AKS app-deployment path is not in-repo (blocks live full-stack on gov).**
   There is no Helm chart / k8s manifest for the Loom *apps* on AKS (only the
   OSS-alternatives charts under `csa_platform/oss_alternatives/helm/`). With
   `containerPlatform='aks'`, `az deployment sub create` provisions the platform
   (network, identity, storage, Cosmos, ADX, catalog, AKS cluster, …) but the
   `consoleUrl` output is only a **non-resolvable placeholder**
   (`https://loom-console.<location>.csa-loom.internal`), not a reachable host —
   so `fiab-smoke-test.sh` Tests 1-8 cannot pass. `redeploy-gov.sh` Phase 4
   detects this `.internal` sentinel and exits cleanly (`exit 2`) rather than
   curling an unresolvable host. **Because Container Apps is not IL4/IL5-
   authorized (gap #3), the only path to a green live full-stack gov run is to
   build an AKS workload deployment for the Loom apps** (Helm/manifest +
   workload-identity + ingress, wiring `consoleUrl` and the MAF endpoint). This
   is the single remaining blocker to the live acceptance receipt and is larger
   than the wiring/honesty fixes in this change.

3. **Container Apps is confirmed NOT authorized at IL4/IL5.** Per the Microsoft
   Learn [Azure Government services by audit scope](https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope#azure-government-services-by-audit-scope)
   table (last updated Feb 2026), **Azure Container Apps** carries **FedRAMP
   High ✅ and DoD IL2 ✅ only** — DoD IL4, IL5, and IL6 are blank (not in audit
   scope). The param comment "Container Apps not at IL4+" is therefore correct,
   and flipping `containerPlatform='containerApps'` for IL5/GCC-High is a
   compliance violation, not an option. Re-check the live
   [Products available by region](https://azure.microsoft.com/global-infrastructure/services/?products=all&regions=usgov-virginia)
   only if/when the audit-scope table changes.

4. **Template build-blockers fixed (recurring class).** `admin-plane/main.bicep`
   had, at various points, build-blocking errors that made `main.bicep` fail
   `az bicep build` entirely — i.e. *no* boundary could deploy:
   - two stray closing braces after the `aas` module (original fix);
   - a duplicated `mcpPrincipalId` property in the `keyvault` module call
     (BCP025) and a duplicated `mcpStorage` identifier where a leftover
     `module mcpStorage 'mcp-storage.bicep'` collided with the inline
     `resource mcpStorage` storage account + its non-existent `.outputs`
     (BCP028/BCP053) — the redundant module + duplicate env keys were removed,
     keeping the fully-wired inline `mcpStorage`/`mcpEnvStorage` path;
   - `admin-plane/main.bicep` exceeded the **256-parameter** Bicep/ARM limit
     (262 params → `max-params` Error). Six reserved-for-v3.x **unused**
     pass-through params (`functionsHostSku`, `capacitySku`, and the four
     `openai*`) were removed from the admin-plane module (their live consumers
     — landing-zone/capacity + ai-foundry — still receive them from the parent
     `main.bicep`); the module is now at exactly 256;
   - `landing-zone/main.bicep` used a module **output**
     (`databricks.outputs.ucSupported`) inside an `if`-condition (BCP177 — module
     outputs are not known at the start of deployment). Replaced with a local
     `dlzUcSupported` var computed from the `boundary` param (the same
     `Commercial || GCC` expression `databricks.bicep` uses internally).

   `main.bicep` now builds clean (0 errors) and all
   `test_bicep_modules.py` tests pass, so every boundary can deploy. The
   deterministic gate + the `gov-verify-evidence.sh` harness (§3) guard against
   regressions of this class.

---

## 7. Acceptance receipt template

```
Boundary:        IL5 | GCC-High
Deploy name:     csa-loom-<boundary>-redeploy-<ts>
provisioningState: <Succeeded>
consoleUrl:      <https://...usgovcloudapi.net>   (AKS path today: non-resolvable .internal placeholder — no app endpoint, see gap #2)
copilotMafEndpoint: <https://...> | (inactive — Container Apps not IL4/IL5-authorized; Gov AOAI-direct fallback, gap #1/#3)
Smoke result:    Passed N / Failed M   (paste fiab-smoke-test.sh summary)
Endpoint matrix: armBase/kvSuffix/cogScope/getGraphHost = <Gov hosts, §4>
Honest gates:    Front Door / AI Foundry / AI Search / Content Safety / Fabric-family rendered warning MessageBars
Bicep what-if:   <attached>
```

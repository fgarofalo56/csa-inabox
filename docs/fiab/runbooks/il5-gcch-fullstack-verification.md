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
| `copilotMafEnabled` threaded | flag reaches the admin-plane from the gov params | `test_bicep_modules.py::test_main_bicep_threads_copilot_maf_enabled` + `build-params` resolves `true` |
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

1. **Compute-platform vs. MAF tier (resolved-as-no-op on AKS).** Both gov
   params set `containerPlatform = 'aks'` (Container Apps was chosen against at
   IL4+ for compliance). The Loom apps — including the MAF Container App — only
   deploy via `app-deployments.bicep` / `maf.bicep`, which are gated on
   `containerPlatform == 'containerApps'`. `copilotMafEnabled` is now correctly
   threaded and set `true`, but `copilotMafActive` still requires `containerApps`,
   so on the AKS path MAF is a deliberate no-op and the Console
   `copilot-orchestrator.ts` falls through to Gov AOAI-direct (line ~1511:
   `if (isGovCloud() && mafEndpoint)` → else fallback). No broken deploy, no
   silent claim.

2. **AKS app-deployment path is not in-repo (blocks live full-stack on AKS).**
   There is no Helm chart / k8s manifest for the Loom *apps* on AKS (only the
   OSS-alternatives charts under `csa_platform/oss_alternatives/helm/`). With
   `containerPlatform='aks'`, `az deployment sub create` provisions the platform
   (network, identity, storage, Cosmos, ADX, catalog, AKS cluster, …) but emits
   no `consoleUrl`, so `fiab-smoke-test.sh` Tests 1-8 cannot pass. **A green
   live full-stack gov run today therefore requires one of:** (a) confirm Azure
   Container Apps is authorized in the target Gov region and flip
   `containerPlatform='containerApps'` (then apps + MAF deploy via the existing
   bicep, no new code), or (b) build an AKS workload deployment for the Loom
   apps (Helm/manifest + workload-identity + ingress). This is the single
   remaining blocker to the live acceptance receipt and is larger than the
   wiring fixes in this change.

3. **Container Apps Gov availability is unconfirmed.** Microsoft Learn does not
   list Azure Container Apps in the IL5 GA roadmap as of this writing; the param
   comment "Container Apps not at IL4+" reflects that. Do not flip option (a)
   above without re-checking
   [Products available by region](https://azure.microsoft.com/global-infrastructure/services/?products=all&regions=usgov-virginia)
   for the exact target region + impact level.

4. **Pre-existing template syntax error fixed.** `admin-plane/main.bicep` had
   two stray closing braces after the `aas` module (lines ~1102-1103) that made
   `main.bicep` fail `az bicep build` entirely — i.e. *no* boundary could
   deploy. Removed in this change; `main.bicep` now builds clean (0 errors).

---

## 7. Acceptance receipt template

```
Boundary:        IL5 | GCC-High
Deploy name:     csa-loom-<boundary>-redeploy-<ts>
provisioningState: <Succeeded>
consoleUrl:      <https://...usgovcloudapi.net>   (or: AKS path — no app endpoint, see gap #2)
copilotMafEndpoint: <https://...> | (inactive — Gov AOAI-direct fallback)
Smoke result:    Passed N / Failed M   (paste fiab-smoke-test.sh summary)
Endpoint matrix: armBase/kvSuffix/cogScope/getGraphHost = <Gov hosts, §4>
Honest gates:    Front Door / AI Foundry / AI Search / Content Safety / Fabric-family rendered warning MessageBars
Bicep what-if:   <attached>
```

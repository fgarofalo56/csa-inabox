# Release audit — DEPLOYMENT dimension (out-of-box deploy truth)

**Audit date:** 2026-07-02
**Worktree:** `E:/Repos/GitHub/csa-inabox/.claude/worktrees/fix-ui-wave2-a`
**Question:** would a clean `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` + the post-deploy bootstrap workflow produce a fully working Loom (the no-vaporware acceptance test)? Cross-checked against the infra inventory and the known manual live-fix list.

---

## Executive summary

The deployment machinery is unusually comprehensive: 126 bicep modules, a 444-var console env emission, a ~50-step post-deploy bootstrap workflow, what-if CI on four clouds, and merge-blocking env-sync/bicep-sync guards. **Most of the known manual live fixes have been made durable**: ADF managed VNet + managed IR + managed PE (GH task#7) is fully in bicep; Azure Maps (account + UAMI role + env vars + CSP) is wired end-to-end; the Event Hubs namespace deploys by default; the Synapse SQL Administrator grant is a bicep deploymentScript; the Synapse Spark managed-PE fix is a first-class bootstrap-workflow step (legitimately script-based — Synapse managed PEs are data-plane-only).

However, the audit found real out-of-box hazards: **the repo's own bicep-sync merge-blocker currently FAILS** (orphaned `notebook-compute-pool.bicep`); **two AAS modules PUT the same server name with different SKUs (S0 vs S1) on the default path**; the console env array **emits `LOOM_AAS_SERVER` five times with conflicting values** (the exact class of the June live "AAS gate = empty env var" incident); the **post-deploy bootstrap is Commercial-only** (hard-coded commercial login, legacy sub GUIDs, eastus2 defaults) which contradicts the all-Gov-day-one posture; the **Gov private-DNS zone list is half boundary-aware, half hard-coded commercial** (KV, ACR, Search, Event Grid, AML zones would be wrong in GCC-High/IL5); the **teardown script purges only KV/HSM** while KV has purge protection ON (purge cannot work → 90-day name reservation on a deterministic name), and Cognitive/AOAI + APIM + AAS soft-deletes are never purged; **AML workspace + default compute instance deploy only in single-DLZ topology** (the flagship tenant/dlz-attach topology ships notebooks gated); and the **self-hosted GH runner bicep module is dead code** that passes the orphan guard only because the guard's regex matches the module's own commented example.

Verdict: a clean Commercial deploy via the blessed multi-workflow chain (infra → build images → redeploy-with-apps → bootstrap) very likely lands a working Loom, but the acceptance test *as written in no-vaporware.md* (one command + bootstrap) is not satisfiable, Gov out-of-box is not complete end-to-end, and teardown→redeploy inside 90 days is blocked.

---

## A. Known manual live fixes — durable-in-repo verification

| Live fix | Durable? | Where |
|---|---|---|
| ADF managed VNet + managed AutoResolve IR + managed PE to lake (GH task#7) | ✅ bicep | `platform/fiab/bicep/modules/landing-zone/adf.bicep:151-192` (`managedVnet`, `managedAutoResolveIr` type `Managed`, `managedPeLake` groupId `dfs`, Gov-aware fqdn via `environment().suffixes.storage`) |
| AML compute instance + `LOOM_AML_*` env | ⚠️ single-DLZ only | `main.bicep:2075` (`if (useSingleDlz && mlWorkspaceEnabled)`), `main.bicep:1056/1078` gate `amlDefaultCompute`/`amlWorkspaceName` on `useSingleDlz`; `hub-console-dlz-env.bicep` has **zero** AML wiring (grep `aml` = no matches) |
| Azure Maps env + UAMI role + CSP | ✅ bicep + code | `modules/admin-plane/azure-maps.bicep:84-90` (Data Reader 423170ca), `admin-plane/main.bicep:3017-3018` (`LOOM_MAPS_BACKEND`/`LOOM_AZURE_MAPS_CLIENT_ID`), `apps/fiab-console/next.config.mjs:67-73` (atlas.microsoft.com in CSP), `main.bicep:808` `azureMapsEnabled=true` default |
| `LOOM_AAS_SERVER` | ⚠️ wired but conflicted | emitted 5× in one env array — see finding 5 |
| Synapse SQL Administrator RBAC (serverless CREATE DATABASE) | ✅ bicep deploymentScript | `landing-zone/synapse.bicep:626-650` (`consoleSqlAdminRoleScript`, Az PowerShell, app-id grant, "PROVEN LIVE" note); prerequisite Synapse Administrator grant covered by bootstrap step "Grant Console UAMI Synapse RBAC (in-VNET)" (`csa-loom-post-deploy-bootstrap.yml:535`) |
| Synapse Spark managed PE to PE-only lake | ✅ bootstrap workflow (not bicep — Synapse managed PEs are data-plane-only) | `csa-loom-post-deploy-bootstrap.yml:476-485` (public-runner attempt) + `:570-594` (`run-spark-storage-fix-invnet-job.sh` in-VNet ACA job); standalone re-run workflow `csa-loom-synapse-spark-fix.yml` |
| Event Hubs namespace | ✅ bicep | `landing-zone/main.bicep:390` (`module eventhubs`, `provisionEventHub`), `admin-plane/main.bicep:2729` (`LOOM_EVENTHUB_NAMESPACE = effEventHubNamespace`), `main.bicep:349` `loomEventHubEnabled=true` default |
| Self-hosted GH runner (gh-aca-runner) | ❌ manual script only | `modules/admin-plane/gh-runner-job.bicep` never invoked (see finding 7); `scripts/csa-loom/provision-gh-runner.sh` is the only provisioning path |

---

## Findings (full detail)

### 1. [HIGH] The repo's own bicep-sync merge-blocker FAILS on this branch (orphaned `notebook-compute-pool.bicep`)

Ran `node scripts/ci/check-bicep-sync.mjs` live in the worktree:

```
[bicep-sync] FAIL — these modules are never invoked by any `module` declaration
  - platform/fiab/bicep/modules/admin-plane/notebook-compute-pool.bicep
```

The module's own header (`notebook-compute-pool.bicep:22-31`) says "INTEGRATION PASS (a sibling wires the root/admin-plane main.bicep …)" — that integration never happened: grep for `notebookComputePool|notebook-compute-pool|LOOM_AML_PERUSER_ENABLED` in `admin-plane/main.bicep` + root `main.bicep` returns nothing. The guard is wired as a merge blocker in `.github/workflows/loom-guardrails.yml:36-37`, so this branch is CI-red on its own no-vaporware bicep-sync rule. Functional impact is soft (the console's `aml-client.ts:432-434` defaults the per-user CI policy on with sane values), but the tenant policy knobs (`LOOM_AML_PERUSER_ENABLED/CI_SIZE/CI_IDLE_TTL/CI_MAX`) are read by the console (`lib/azure/aml-client.ts:418-434`) and never emitted by any deployment — the module that was supposed to emit them is dead infra.

**Fix:** wire the module into admin-plane/main.bicep and append its four outputs to the console env (or delete it and emit the four vars directly). Effort S.

### 2. [HIGH] Default deploy PUTs the SAME AAS server from two modules with DIFFERENT SKUs (S0 vs S1)

With the default `aasEnabled=true` (`main.bicep:340`, forwarded at `:988`), admin-plane deploys **both**:
- `module aas 'analysis-services.bicep' = if (aasEnabled)` at `admin-plane/main.bicep:1910`, `serverName: 'aasloom${uniqueString(resourceGroup().id)}'` (line 1914), `skuName: aasSku` where `param aasSku string = 'S0'` (line 1357);
- `module aasServer 'aas-server.bicep' = if (aasEnabled && empty(existingAasServerName))` at `:2101`, default `serverName 'aasloom${uniqueString(resourceGroup().id)}'` (`aas-server.bicep:38`) with `skuName: aasSkuName` where `param aasSkuName string = 'S1'` (line 194).

The code COMMENT at 1927-1934 acknowledges both "resolve to the SAME physical AAS server" and handles the duplicate role-grant (skipRoleGrants dedupe from the pass-6 centralus incident) — but nobody reconciled the **SKU**: two parallel module deployments race to PUT the same `Microsoft.AnalysisServices/servers` resource, one asking S0, one S1. Outcome is order-dependent: either a transient ARM `Conflict` (another operation in progress) failing the deploy, or a nondeterministic final SKU (S1 is ~2× the cost of S0). Either way the out-of-box result is not deterministic.

**Fix:** single AAS module (or make one module the owner and pass the other only the existing name), one SKU param. Effort M.

### 3. [HIGH] `LOOM_AAS_SERVER` emitted FIVE times in one console env array with conflicting values

Inside the single `loom-console` `env: concat(...)` (starts `admin-plane/main.bicep:2391`; next app `loom-mcp` begins at 3916):
- lines **2630, 2646, 3061, 3077**: `{ name: 'LOOM_AAS_SERVER', value: loomAasServer }` — `param loomAasServer string = ''` (line 476) and root `main.bicep` never passes it (grep `loomAas` in root = zero hits) → **empty string, four times**;
- line **3183**: `aasEnabled ? [{ name: 'LOOM_AAS_SERVER', value: aas.outputs.serverFullName }] …` → **the real asazure:// name**.

`app-deployments.bicep:114-154` concatenates env arrays verbatim — no dedupe. So the deployed container gets five `LOOM_AAS_SERVER` entries, four empty and one real. Which one the ACA runtime honors is unspecified; the live June incident ("AAS gate = env-var misconfig — LOOM_AAS_SERVER empty while server aasloom<hash> exists", memory 2026-06-29) is exactly the observable symptom of the empty entries winning. `LOOM_AAS_MODEL` (2631 vs 3063) and `LOOM_AAS_DATABASE` (2647/3069/3078) have the same duplicate-emission pattern, and 3062-3063 additionally zero out REGION/MODEL whenever the *param* (not the deployed server) is empty.

**Fix:** compute one `var effectiveAasServer = !empty(loomAasServer) ? loomAasServer : (aasEnabled ? aas.outputs.serverFullName : '')` and emit each AAS var exactly once. Add a CI check for duplicate env names per app. Effort S-M.

### 4. [HIGH] Post-deploy bootstrap workflow is Commercial-only — Gov deploys cannot complete the mandatory bootstrap

`csa-loom-post-deploy-bootstrap.yml` is, per the no-vaporware acceptance test, half of "produce a working Loom" (~50 steps: MSAL app reg, Purview data-plane roles, subscription RBAC, Synapse RBAC + SQL grants, Spark managed PE, Databricks SCIM/UC/warehouse, Graph approles, Power Platform registration, AI Search index, governance seeding, Grafana dashboards, runtime verify). It:
- logs in with the **commercial** `AZURE_CLIENT_ID/SECRET` creds (line 97+) and never runs `az cloud set` (grep `az cloud|AZURE_GOV|usgov` = only one incidental comment at line 1438);
- defaults `REGION: eastus2` and hard-codes the legacy sub `<subscription-id>` as ADMIN_SUB/DLZ_SUB/SUB fallback (lines 44-50), a specific Databricks host `adb-<workspace-id>.19.azuredatabricks.net` (line 60), and live eastus2 Console-UAMI GUIDs (lines 70-71).

Meanwhile `deploy-fiab-gcch.yml` / `deploy-fiab-il5.yml` deploy Gov bicep but have no bootstrap counterpart, and `scripts/csa-loom/redeploy-gov.sh` covers phases teardown/redeploy/smoke — not the 50 RBAC/data-plane steps. Net: a Gov deploy ships with login (MSAL app reg), Synapse SQL grants, Spark storage access, Purview roles, Databricks SCIM etc. all missing — i.e. most editors broken — contradicting the "all-Gov day-one" positioning (FiaB pillar).

**Fix:** parameterize the bootstrap on cloud (login env + `az cloud set` + Gov secret set), or split cloud-agnostic steps into a reusable composite invoked by both. Effort L.

### 5. [HIGH] Teardown cannot actually purge the Key Vault (purge protection ON + deterministic name) — redeploy into the same RG blocked for 90 days

`admin-plane/keyvault.bicep:74-76`: `enableSoftDelete: true`, `softDeleteRetentionInDays: 90`, **`enablePurgeProtection: true`**; name `kv-loom-${uniqueString(resourceGroup().id)}` (line 61) is fully deterministic per sub+RG-name. `.github/scripts/fiab-teardown.sh:53-56` does `az keyvault delete` + `az keyvault purge … || true` — but **purge-protected vaults cannot be purged** (the CLI call fails and is swallowed by `|| true`). A teardown + redeploy of the same RG name in the same subscription then computes the same vault name and collides with the soft-deleted, unpurgeable vault ("name already in use / must be recovered") for 90 days. `keyvault.bicep` also has no `createMode: 'recover'` path (grep `createMode` = only Synapse pool). This is the memory-documented "KV recover" clean-deploy blocker, still not durable.

**Fix:** either a `createMode`/recover reconcile param in keyvault.bicep, or salt the KV name with a deploy-generation suffix, or drop purge protection for CI/test boundaries via param. Effort M.

### 6. [HIGH] Teardown never purges Cognitive Services (AOAI/Foundry), APIM, or AAS soft-deletes — deterministic names collide on redeploy

`fiab-teardown.sh` handles only KV + Managed HSM (lines 49-64); its own strategy comment (lines 7-9) promises "Key Vault, Cosmos restorable accounts" but there is no Cosmos handling either. Deterministically-named soft-deletable resources that redeploy re-creates with the identical name:
- `aoai-csa-loom-${location}` and `aifoundry-csa-loom-${location}` (`ai-foundry.bicep:237/93`) — Cognitive Services soft-delete requires `az cognitiveservices account purge` or `restore: true` on re-PUT (neither present; grep `restore|purge` in ai-foundry.bicep/apim.bicep = zero);
- `apim-csa-loom-<region>` — APIM soft-delete requires `az apim deletedservice purge`;
- AAS `aasloom${uniqueString(rg.id)}`.

This is the exact "Cognitive/APIM purge" class from the June clean-deploy memory, still not durable in the teardown path the workflow runs (`teardown-fiab-commercial.yml:40-41`). Fresh redeploy after teardown fails with `FlagMustBeSetForRestore` / name-reserved errors.

**Fix:** extend fiab-teardown.sh with `az cognitiveservices account list-deleted/purge`, `az apim deletedservice purge`, Cosmos restorable-account purge; or set `restore` params in bicep re-PUT paths. Effort M.

### 7. [MEDIUM-HIGH] AML workspace + default Compute Instance deploy ONLY in single-DLZ topology — tenant/dlz-attach (the flagship path) ships the notebook AML surface gated

Root `main.bicep:2075`: `module dpMlWorkspace … = if (useSingleDlz && mlWorkspaceEnabled)`. The console wiring is likewise gated: `amlDefaultCompute: (useSingleDlz && mlWorkspaceEnabled) ? … : ''` (line 1056), `amlWorkspaceName: (useSingleDlz && …) ? … : ''` (line 1078). The dlz-attach console-env patcher `landing-zone/hub-console-dlz-env.bicep` wires **no** LOOM_AML_* vars at all (grep `aml` = zero). In tenant topology `LOOM_AML_WORKSPACE` falls back to the Foundry hub name (`admin-plane/main.bicep:3696`) so per-user CIs *can* be created there on demand, but `LOOM_AML_DEFAULT_COMPUTE` stays empty and no CI exists day-one — reproducing the live 06-30 manual fix (create CI on the Foundry hub + set LOOM_AML_WORKSPACE/REGION/DEFAULT_COMPUTE) for every fresh multi-sub deploy. The deterministic `ci-loom-<uniqueString>` trick that closes this gate zero-touch exists only for single-DLZ.

**Fix:** deploy a default CI (or rely on and surface the per-user flow) on the Foundry hub in tenant topology; wire `amlDefaultCompute` for the tenant path too. Effort M.

### 8. [MEDIUM] `gh-runner-job.bicep` is dead code that defeats the orphan guard via its own comment; the GH runner remains manual-only

`modules/admin-plane/gh-runner-job.bicep` is never invoked: the only `module ghRunnerJob 'gh-runner-job.bicep'` string in the repo is **inside the module's own header comment** (line 25, "wire into admin-plane/main.bicep" example), and `docs/fiab/github-actions-runner.md:159` admits the TODO. `check-bicep-sync.mjs`'s `MODULE_DECL_RE = /module\s+[A-Za-z0-9_]+\s+'([^']+)'/g` does not strip comments, so the commented example self-references the file and the guard counts it as reachable — a guard bug that will hide any future orphan carrying a wiring example in its header. Provisioning today is `scripts/csa-loom/provision-gh-runner.sh` (manual, live-estate defaults). Impact is ops-infra (in-VNet CI runner), not end-user product, hence MEDIUM.

**Fix:** wire the module behind `deployGitHubRunner=false` param as its header describes, and make the guard strip `//` comments before matching. Effort S.

### 9. [MEDIUM] Gov private-DNS zone list is half boundary-aware, half hard-coded commercial — GCC-High/IL5 PE DNS broken for KV, ACR, Search, Event Grid, AML, ACA

`modules/admin-plane/network.bicep:372-390` (`var dnsZones`): entries for cognitiveservices/openai/documents/servicebus/azurewebsites/kusto/synapse/adf correctly branch on `boundary == 'GCC-High' || boundary == 'IL5'`, but these are hard-coded commercial names with no branch:
- `privatelink.vaultcore.azure.net` (Gov: `privatelink.vaultcore.usgovcloudapi.net`) — **Key Vault, load-bearing for everything**;
- `privatelink.azurecr.io` (Gov: `privatelink.azurecr.us`);
- `privatelink.search.windows.net` (Gov: `privatelink.search.windows.us`);
- `privatelink.eventgrid.azure.net` (Gov: `privatelink.eventgrid.azure.us`);
- `privatelink.azureml.ms` / `privatelink.api.azureml.ms` / `privatelink.notebooks.azure.net` (Gov: `privatelink.api.ml.azure.us` / `privatelink.notebooks.usgovcloudapi.net`);
- `privatelink.{location}.azurecontainerapps.io` (Gov ACA default domain is `.azurecontainerapps.us`);
- `privatelink.azconfig.io` (Gov: `privatelink.azconfig.azure.us`).

In GCC-High/IL5 the PEs would register into zones whose names never match the services' actual private FQDNs → resolution falls to public DNS → fails against `publicNetworkAccess=Disabled` resources. Given every Gov deploy currently defaults to `whatif-only` (deploy-fiab-gcch.yml run_mode default), this has plausibly never been exercised live.

**Fix:** apply the same boundary conditional to the remaining zones (verify each against Learn's Gov private-link DNS table). Effort S-M.

### 10. [MEDIUM] The no-vaporware acceptance test is unsatisfiable as written: first-run `deployAppsEnabled=true` references images in the not-yet-populated ACR

`params/commercial-full.bicepparam:224` sets `deployAppsEnabled = true`, and the container apps reference `'loom-console:${appImageTags.console}'` etc. on the deployment's own ACR (`admin-plane/main.bicep:2376, 3916-3996`) with no placeholder/bootstrap-image fallback. On a genuinely clean subscription the ACR is created by the same deployment, so the Container Apps steps fail on image pull. The working path is the multi-phase `full-app-deploy-commercial.yml` (resolve → open-acr → build → close-acr → redeploy-with-apps), and `deploy-fiab-commercial.yml` accordingly defaults `deploy_apps_enabled=false` ("Requires images already built/pushed"). The acceptance sentence in `.claude/rules/no-vaporware.md` ("az deployment sub create -f main.bicep -p params/commercial-full.bicepparam + the post-deploy bootstrap workflow must produce a working Loom") therefore cannot pass in one shot on a fresh sub.

**Fix:** either seed a public bootstrap image (mcr placeholder) with an auto-update step, or amend the acceptance test to name the full-app-deploy workflow as the canonical from-scratch path. Effort S (doc) / M (placeholder image).

### 11. [MEDIUM] Deploy and bootstrap are not chained, and bootstrap defaults are the operator's private estate

No workflow triggers `csa-loom-post-deploy-bootstrap` after a deploy (grep `bootstrap` in deploy-fiab-commercial.yml / full-app-deploy-commercial.yml = zero) — a fresh adopter must know to dispatch it manually with the right region/sub inputs. If they dispatch it with defaults, it targets `eastus2`, subscription `<subscription-id>`, a specific Databricks workspace host, and two hard-coded UAMI GUIDs (`csa-loom-post-deploy-bootstrap.yml:41-71`). For a public release this is both a foot-gun (silent grants attempted against someone else's coordinates → step-level failures masked by best-effort `|| true` patterns) and hygiene (private sub/UAMI/workspace identifiers published in the repo). The runtime "Resolve deploy coordinates" step (line 113) mitigates when inputs are given, but the baked defaults remain.

**Fix:** make `region` + subscription inputs required (no legacy fallbacks), or trigger bootstrap from the deploy workflow with computed inputs; scrub estate GUIDs. Effort S-M.

### 12. [LOW-MEDIUM] Bootstrap temporarily flips the PE-only Key Vault to `publicNetworkAccess=Enabled` from a public runner

`csa-loom-post-deploy-bootstrap.yml:190-214` (MSAL step): flips KV public with `--default-action Allow`, writes secrets, restores via `trap`. The trap covers most failure modes, but a runner kill (timeout/cancel at the GitHub level) skips it, leaving the vault public until the next run. Same pattern is used for Synapse/Databricks public-flip steps (lines 597, 748) with a "Restore … (safety net)" step — the KV flip has only the in-step trap. Also inherently widens the vault to the whole internet during the write window rather than scoping a firewall IP rule to the runner's egress IP.

**Fix:** use `az keyvault network-rule add --ip-address <runner-ip>` for the window, and add a standalone restore step (`if: always()`). Effort S.

### 13. [LOW] Gov gets no Azure Maps even though Azure Maps exists in Azure Government

`admin-plane/main.bicep:2298-2300` hard-gates the account (and `LOOM_AZURE_MAPS_CLIENT_ID` at 3018) to `Commercial || GCC`; `next.config.mjs:67-73` CSP allows only `atlas.microsoft.com` (Gov data plane is `atlas.azure.us`; `connect-src` would cover it via `*.azure.us` but `script-src/style-src/font-src` would not for SDK assets if served from a Gov host). BYO escape hatch `loomAzureMapsAccount` exists. Honest-gate per rules, but it's parity left on the table for Gov (finding is LOW because the gate is honest and documented).

### 14. [LOW] Stale orphan-allowlist entries in the bicep-sync guard

`scripts/ci/check-bicep-sync.mjs` allowlists `admin-plane/udf-runtime.bicep` as "TODO wire: … pending default" — but it IS wired (`admin-plane/main.bicep:1988 module udfRuntime 'udf-runtime.bicep' = if (udfRuntimeEnabled)` with `udfRuntimeEnabled` default true via `byoExisting`). Stale allowlist reasons erode trust in the guard's output. Also `landing-zone/azure-maps.bicep` is kept as a "legacy variant" orphan — dead code that a from-scratch deploy never creates; delete or wire.

### 15. [INFO / POSITIVE verifications]

- **ADF managed VNet + IR + managed PE (GH task#7): CLOSED durable.** `landing-zone/adf.bicep:151-192`, incl. Gov-aware dfs FQDN and RBAC for both the Console UAMI (Data Factory Contributor, line 234) and factory MI (Storage Blob Data Contributor, line 259).
- **Event Hubs namespace: durable.** `landing-zone/eventhubs.bicep` + `landing-zone/main.bicep:390`; console binding `admin-plane/main.bicep:2729` and dlz-attach path `hub-console-dlz-env.bicep:240`.
- **Synapse SQL Administrator: durable** via `consoleSqlAdminRoleScript` deploymentScript (`synapse.bicep:626`), gated on the hub console UAMI (`landing-zone/main.bicep:293/1417`) holding Synapse Administrator — granted by bootstrap step 535 or `csa-loom-grant-synapse-rbac.yml`.
- **Spark managed PE: covered by bootstrap** (`csa-loom-post-deploy-bootstrap.yml:570-594`) — correct home, since Synapse managed PEs cannot be expressed in ARM/bicep. The MSI Storage Blob Data Contributor half IS bicep (`synapse.bicep:324-363`).
- **Azure Maps (Commercial/GCC): durable end-to-end** — account, Data Reader role, uniqueId → `LOOM_AZURE_MAPS_CLIENT_ID`, KV key secret (`azure-maps.bicep:105-112`), CSP fixed in code.
- **Env-sync guard: PASSES** (re-ran `check-bicep-sync.mjs` env core: reads=494 emitted=444 missing=0). The 177 read-but-not-emitted vars are all allowlisted with reasons.
- **Teardown polls RG deletion with timeout** and picks up all `rg-csa-loom-*` RGs in the sub, not just the admin RG (`fiab-teardown.sh:38-43`).
- **Gov deploy workflows exist** for GCC/GCC-High/IL5 with correct sovereign login endpoint blocks and a "no second console" topology guard.

---

## Cross-check vs. the infra-inventory "watch items"

| Watch item | Audit outcome |
|---|---|
| LOOM_AAS_* | Wired but **conflicted** (findings 2, 3) — the live misconfig class is explained by the duplicate emission. |
| LOOM_EVENTHUBS_NAMESPACE | The console actually reads `LOOM_EVENTHUB_NAMESPACE` (singular; `eventhubs-client.ts:73`), which IS emitted (`admin-plane/main.bicep:2729`). One remediation string still names the plural form (`lib/install/provisioners/eventstream.ts:133`) — cosmetic mismatch. |
| Azure Maps | Durable Commercial/GCC (finding 15); Gov honest-gated (finding 13). |
| LOOM_AML_WORKSPACE / compute | Durable single-DLZ only; tenant/dlz-attach gap (finding 7). |

## Recommended release-gate order

1. Fix the CI-red orphan (finding 1) — the branch cannot merge cleanly otherwise.
2. Reconcile the dual-AAS SKU + dedupe `LOOM_AAS_SERVER` emission (findings 2-3) — default-path determinism.
3. Extend teardown purge + KV recover story (findings 5-6) — unblocks the quarterly teardown-redeploy validation the rules require.
4. Gov: boundary-complete the DNS zone list (finding 9) and produce a Gov-capable bootstrap (finding 4) before any Gov release claim.
5. Close the tenant-topology AML gap (finding 7) and wire/remove the runner + compute-pool dead modules (findings 1, 8).

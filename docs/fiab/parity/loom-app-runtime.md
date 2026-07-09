# loom-app-runtime — parity with Databricks Apps

Source UI: Databricks Apps (https://docs.databricks.com/en/dev-tools/databricks-apps/index.html) — deploy a framework app (Streamlit/Dash/Gradio/Flask/Node) backed by serverless compute with OAuth-scoped access to the operator's own data. DAIS 2026 Agent Bricks: "deploy any agent harness with horizontal autoscaling."

CSA Loom builds the **same capability on pure Azure** — Azure Container Apps + the Loom Azure Container Registry — with **zero Databricks/Fabric dependency** (no-fabric-dependency.md). Commercial + GCC on the Container Apps path; GCC-High/IL5 honest-gate to the GitOps-manifest path.

## Databricks Apps feature inventory → Loom coverage

| Databricks Apps capability | Loom coverage | Backend |
|---|---|---|
| Pick a framework (Streamlit/Dash/Gradio/Flask/Node) | ✅ Runtime template dropdown (5 real starter bundles) — no freeform | `loom-apps-runtime-templates.ts` (pure, tested) |
| Bring your own source | ✅ Edit starter code in Monaco, OR point at a **public** git repo | Source tab; ACR build from tar OR git `sourceLocation` |
| Build the app image | ✅ Real ACR quick-build (Console UAMI) — `listBuildSourceUploadUrl` → upload → `scheduleRun` → poll `runs/{id}` | `loom-apps-client.ts:buildApp` |
| Serverless compute + autoscale | ✅ ACA `minReplicas:0` autoscale-to-zero (~$0 at rest) — enforced in the body builder | `buildAcaAppBody` |
| OAuth-scoped access | ✅ Entra Easy-Auth wrapper (authConfigs/current, RedirectToLoginPage) via the Console's existing MSAL app reg | `buildAuthConfigBody` + `deployApp` |
| Live app URL | ✅ External ingress FQDN returned on deploy | `deployApp` → `https://<fqdn>` |
| OAuth-scoped access to the operator's own data (UC analogue) | ✅ **Bindings** tab injects allowlisted `LOOM_*` env vars so the app calls back into the operator's Synapse/ADX/AI Search/Cosmos | env allowlist (`LOOM_APP_ENV_NAME_RE`) |
| Secrets | ✅ KV-backed ACA `secretRef` (never plaintext) — Bindings row "Key Vault secret" type | deploy env `secretRef` |
| Start / Stop / Delete lifecycle | ✅ Real ACA start/stop action APIs + DELETE | `startApp`/`stopApp`/`deleteApp` |
| Logs | ✅ Live tail from Log Analytics (`ContainerAppConsoleLogs`) | `tailAppLogs` |
| Governance / disable | ✅ Per-app disable (Stop) + tenant-wide kill switch (`apps.runtimeEnabled` toggle + `LOOM_APPS_RUNTIME_ENABLED` env), default-ON/opt-out | `runtime-flag.ts` |
| Deploy any agent harness (Agent Bricks) | ⚠️ Foundation shipped (any container is deployable); the dedicated "Agent" template + Data-Agent compose-back is PRP item #2 (follow-up) | — |
| Private git source (PAT/OAuth) | ❌ Honest-gated (named follow-up) — only public https repos build today | `buildApp` rejects credentialed/private git URLs |

## Default-ON posture (operator directive)

Deploys are **default-allowed** for any user with workspace access — **no spend gate, no approval gate**. Cost is bounded structurally by `minReplicas:0`. Admin controls are opt-out: per-app Stop/Delete + the tenant-wide kill switch.

## Honest infra gate

When `LOOM_APPS_CAE_ID` / `LOOM_APPS_ACR_LOGIN_SERVER` (or the app UAMI) are unset, the editor renders fully and a MessageBar names the exact env vars + `platform/fiab/bicep/modules/admin-plane/main.bicep` (`deployAppsEnabled`) + the Console-UAMI role requirement. On AKS boundaries the runtime honest-gates to the GitOps-manifest path.

## Bicep

- `admin-plane/main.bicep` emits `LOOM_APPS_CAE_ID` / `LOOM_APPS_ACR_LOGIN_SERVER` / `LOOM_APPS_UAMI_ID` / `LOOM_APPS_RUNTIME_ENABLED` on `loom-console` (gated on `containerPlatform=='containerApps' && deployAppsEnabled`; **no new top-level params** — reuses the existing CAE + ACR + MCP UAMI).
- Adds an AcrPull role assignment for the app identity (`uami-loom-mcp`) on the Loom ACR so a deployed app pulls its private image (the ACR is PE-only). The Console UAMI already holds RG Contributor (build+push) + Managed Identity Operator (assign the app identity).

## Verification

- Unit: `lib/azure/__tests__/loom-apps-runtime.test.ts` (20) — templates, Dockerfile, build-context assembly, ustar tar, ACA body (env allowlist + scale-to-zero floor + PORT), authConfig, naming.
- Routes: `app/api/items/loom-app-runtime/__tests__/routes.test.ts` (6) — kill switch, read-only, env allowlist, happy-path build/deploy.
- Real-backend E2E receipt (per no-vaporware.md) to attach at first live roll: ACR build run id + ACA PUT response + the live `https://<app>.<region>.azurecontainerapps.io` returning HTTP 200 behind Entra + autoscale-to-zero confirmation.

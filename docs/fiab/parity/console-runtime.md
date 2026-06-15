# console-runtime — parity with Azure Container Apps runtime (probes, resources, telemetry)

Source UI / docs:
- Azure Container Apps health probes — https://learn.microsoft.com/azure/container-apps/health-probes
- Container Apps containers (CPU/memory allocation) — https://learn.microsoft.com/azure/container-apps/containers
- Azure Monitor OpenTelemetry (App Insights) — https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable

Domain: deploy-readiness for the **loom-console** Container App runtime — the
probes, resource sizing, and telemetry wiring that decide whether a *fresh*
deploy comes up healthy on first login. Codifies the live #1382 crash-loop fix
so the next clean deploy is correct without manual patching.

## Root cause (live centralus clean deploy, #1382)

| Symptom | Root cause | Fix (this domain) |
|---|---|---|
| Console crash-loop → Envoy "connection refused" | ACA probe `timeoutSeconds` **defaults to 1**; a slow Next.js cold start can't answer `/api/health` in <1s → Liveness fails → restart loop. Liveness also fired immediately (no boot grace) and there was **no Startup probe** (ACA only auto-injects defaults when *zero* probes are defined). | `app-deployments.bicep`: `timeoutSeconds=5` on every probe, `initialDelaySeconds=10` on Liveness, **new Startup probe** (failureThreshold 30 × periodSeconds 2 = 60s boot grace). |
| OOM | Console ran at the service default **0.5cpu / 1Gi**; Next.js SSR + OTel OOMs there. | Console tier right-sized to **1.0cpu / 2Gi** (valid ACA Consumption pair) via tier-aware `resources` fallback. |
| OTel SIGSEGV (post-boot native crash) | `@azure/monitor-opentelemetry` Live Metrics' native channel SIGSEGVs the Node process *after* boot — a `try/catch` cannot trap it. | `lib/telemetry/app-insights.ts`: **Live Metrics disabled**, init behind the `LOOM_CONSOLE_TELEMETRY_ENABLED` gate, plus a telemetry-scoped `uncaughtException`/`unhandledRejection` guard so a telemetry fault degrades telemetry instead of crash-looping the app. |

## Backend per control (default deploy — opt-out posture)

| Concern | Provisioned by default? | Wiring | Disable path |
|---|---|---|---|
| Console Container App (probes + sizing) | YES — `app-deployments.bicep` (gated `containerPlatform==containerApps && deployAppsEnabled`, true in all 4 bicepparams) | probe/CPU/memory params on `app-deployments.bicep` with WAF-aligned defaults (`probeTimeoutSeconds=5`, `consoleCpu=1.0`, `consoleMemory=2Gi`) | operator overrides the module defaults for slow sovereign regions |
| App Insights + Log Analytics (telemetry destination) | YES — `monitoring.bicep` (unconditional; the `/monitor` KQL + Copilot-usage panels read the workspace) | `APPLICATIONINSIGHTS_CONNECTION_STRING` wired into the console; `LOOM_CONSOLE_TELEMETRY_ENABLED='true'` env gate | `loomConsoleTelemetryEnabled=false` → conn-string withheld + env `''` → OTel SDK never loads; the workspace/account still exist |
| Console UAMI RBAC for telemetry | YES — Log Analytics Reader `73c42c96-874c-492b-b04d-ab87d138a893` + Monitoring Contributor `749f88d5-cbae-40b8-bcfc-e573ddc772fa` (`monitoring.bicep`) + sub-scope Monitoring Reader | n/a — **no new role GUIDs required** for this domain | n/a |

No new private endpoint / DNS for Commercial / GCC: App Insights public
ingestion is intended (`monitorPublicIngestionEnabled`). A boundary that
provisions an Azure Monitor Private Link Scope sets `publicIngestionEnabled=false`
in `monitoring.bicep` directly (an AMPLS is required first, or custom events are
silently dropped).

## Loom coverage

| Capability | State | Notes |
|---|---|---|
| Relaxed probe timeout (5s) on Liveness/Readiness/Startup | ✅ built | `app-deployments.bicep` |
| Liveness boot grace (`initialDelaySeconds`) | ✅ built | 10s |
| Startup probe (60s boot window) | ✅ built | new probe; ACA wouldn't auto-inject it alongside the existing two |
| Console right-size 1cpu/2Gi (tier-aware, other apps unchanged at 0.5/1Gi) | ✅ built | |
| Telemetry ON by default, crash-hardened (live-metrics off + crash guard) | ✅ built | `lib/telemetry/app-insights.ts` |
| Telemetry opt-out (`LOOM_CONSOLE_TELEMETRY_ENABLED`) | ✅ built (env gate) | wired as a `var` not a deploy `param` — see "param-cap note" below |
| CLI scan-and-choose (existing / new / disable + recommendation) | ✅ built | `scripts/csa-loom/scan-app-insights.sh` (sourceable by `scan-and-deploy.sh`) |
| Post-deploy health/drift guard | ✅ built | `scripts/csa-loom/verify-console-runtime.sh` + bootstrap step |
| Setup-Wizard observability card (per-deploy override) | ⚠️ deferred | telemetry override is a `var` today (param-cap); a wizard toggle would be a dead control (no-vaporware), so it's deferred until the param-object consolidation restores the deploy param |

## param-cap note (program-level deploy blocker surfaced here)

`platform/fiab/bicep/modules/admin-plane/main.bicep` was **already at 258
parameters on `origin/main` — over the hard ARM limit of 256** (a nested module
deployment has its own 256-parameter cap;
https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#general-limits).
That makes `az bicep build` fail and would block the deploy. This PR brings the
module back to **exactly 256** by converting two default-only, telemetry/console
params to `var` (`monitorPublicIngestionEnabled`, `loomConsoleBaseUrl` — both
never set in any `*.bicepparam`, so behavior-preserving) and implementing the
console telemetry opt-out as a `var` rather than a new param. Every other
deploy-readiness domain is *adding* opt-out params to this same module, so the
integrate step still needs a program-level **param→object consolidation** to
make room; once that lands, `loomConsoleTelemetryEnabled` should be promoted back
to a real deploy `param` + Setup-Wizard card.

## Verification

- `az bicep build --file platform/fiab/bicep/main.bicep` — error-free (admin-plane at 256 params).
- `npx tsc --noEmit` — `lib/telemetry/app-insights.ts` clean.
- Post-deploy: `ADMIN_RG=<rg> bash scripts/csa-loom/verify-console-runtime.sh` asserts Running+Healthy, ≥1cpu/2Gi, probe timeout ≥5s, and consistent telemetry wiring (run automatically by `csa-loom-post-deploy-bootstrap.yml`).

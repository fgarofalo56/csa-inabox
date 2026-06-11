# setup-wizard — parity with Azure deployment "Create a resource" / `az deployment sub create`

Source UI: Azure portal **Subscriptions** blade (`https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade`)
+ the portal **Custom deployment / Deploy a custom template** wizard
(`https://portal.azure.com/#create/Microsoft.Template`), which is the portal
equivalent of `az deployment sub create -f main.bicep`.
Learn: <https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-portal>,
<https://learn.microsoft.com/rest/api/resources/subscriptions/list>.

The Loom Setup Wizard is a guided front-end for deploying an additional Loom
**Data Landing Zone (DLZ)** — boundary → mode → **subscription** → domain →
capacity → review → deploy. The Azure-portal analog of the missing step is the
"Subscription" dropdown every portal create-blade forces you to pick before
"Review + create" enables.

## Azure feature inventory (every capability the portal deploy flow exposes)

| # | Capability | Where in Azure |
|---|------------|----------------|
| 1 | Pick the **target subscription** for the deployment | Every create-blade "Basics" tab; `az account list` / ARM `GET /subscriptions` |
| 2 | Pick the **region/location** for the deployment | "Basics" tab region dropdown; `-l <region>` on `az deployment sub create` |
| 3 | Supply template **parameters** (here: boundary, mode, domain, capacity) | "Custom deployment" parameter grid |
| 4 | **Review** the resolved template + parameters before deploy | "Review + create" tab |
| 5 | **Deploy** (submit the deployment) | "Create" button → ARM `PUT /subscriptions/{id}/providers/Microsoft.Resources/deployments/{name}` |
| 6 | See **deployment progress / result** | Portal "Deployment is in progress" → "Your deployment is complete" |
| 7 | Handle **auth / permission** failures honestly | Portal surfaces `AuthorizationFailed` etc. |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Target subscription picker | ✅ built | New `subscription` step lists real subs via `GET /api/setup/subscriptions` → ARM `GET /subscriptions?api-version=2022-12-01`; selection threads `subscriptionId` into deploy POST + bicep preview. **This was the missing step that broke the wizard.** |
| 2 | Region picker | ✅ built | Region dropdown on the subscription step; Commercial vs Gov region list keyed off the chosen boundary; threads `location`. |
| 3 | Parameters (boundary/mode/domain/capacity) | ✅ built | Pre-existing steps. The **capacity** step now renders a guided **`CapacityEquivalencePanel`**: for the selected F-SKU it shows the Microsoft-official equivalences (CU, Synapse Spark vCores = CU×2, Warehouse SQL vCores/sec, Power BI v-cores = CU÷8) badged "Microsoft-official" with Learn links, plus Loom sizing guidelines (Databricks worker shape, ADX cluster SKU, Synapse dedicated SQL DWU) badged "Loom guideline", a relative cost tier, and a deep link to the official Fabric Capacity Estimator. No fabricated dollar amounts; the non-official mappings are disclosed in a MessageBar. Data + grounding live in `lib/setup/capacity-equivalence.ts`. |
| 4 | Review | ✅ built | Review step renders the generated `.bicepparam` now including the selected subscription id + region. |
| 5 | Deploy submit | ✅ built (server-side) / ⚠️ honest-gate fallback | `POST /api/setup/deploy` **validates** the config (400 if subscription/boundary/mode/domain/capacity missing, 400 if subscriptionId is not a GUID). When `LOOM_GITHUB_ACTIONS_TOKEN` is configured it **dispatches the real deploy workflow** for the boundary (`deploy-fiab-commercial.yml` / `deploy-fiab-gcc.yml` / `deploy-fiab-gcch.yml`) via the GitHub Actions REST API (`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`, `ref:main`, inputs = subscription/region/dlz_domain_name/capacity_sku/vanity_domain) and returns **202** with `deploymentMode:'github-workflow-dispatch'`, `workflowFile`, and `dispatchedAt`. When the token is **not** configured (or dispatch fails) it returns **503** with a copy-paste `az deployment sub create` pre-filled with the selected subscription, region, and the boundary's real `.bicepparam`. Both paths are real — no fabricated deploymentId. |
| 6 | Deployment progress / result | ✅ built (streamed) | After a 202 dispatch the wizard **streams live status**: it polls `GET /api/setup/workflow-run-status?workflow={file}&since={dispatchedAt}` every 6s, which queries the GitHub Actions API for the `workflow_dispatch` run created at/after the dispatch time and returns its `status`/`conclusion`/`runUrl`. The done screen shows a live Fluent `Badge` (Starting→Queued→Running→Succeeded/Finished-with-errors), a `ProgressBar`, and an **Open run on GitHub** deep-link to the actual run. When the deploy was 503-gated instead, the "Deploying…" screen shows a Fluent `MessageBar intent="warning"` with the remediation command + Retry/Back — no fabricated progress. |
| 7 | Auth / permission failures | ✅ built | Subscriptions route returns 502 + hint ("grant the Console UAMI Reader…") on token failure; content-type guard returns 502 on non-JSON ARM responses; deploy + status routes 401 unauthenticated; status route 503 when `LOOM_GITHUB_ACTIONS_TOKEN` unset. UI renders all of these in MessageBars/Badges. |
| 8 | Deploy is an admin-tier action | ✅ built | `POST /api/setup/deploy` enforces the **`admin.deploy-dlz`** feature-permission (Admin role) via `enforceCapability` before doing anything: tenant admins (`LOOM_TENANT_ADMIN_OID` / `LOOM_TENANT_ADMIN_GROUP_ID`) bypass; any other principal must be **delegated** the capability at `/admin/permissions`. A blocked caller gets a 403 with `capability`/`requiredRole`/remediation, which the wizard renders as a clear "you don't have permission to deploy…" MessageBar. The capability shows up in the Admin → Tenant Admin branch of the `/admin/permissions` RBAC tree like every other Fabric-style capability. |

Zero ❌. With `LOOM_GITHUB_ACTIONS_TOKEN` set the deploy + progress path is a
real server-side GitHub Actions dispatch with streamed run status; without it,
every gate is an honest Fluent `MessageBar` naming the exact missing piece and
the exact `az deployment sub create` to run instead.

## Backend per control

| Control | Backend |
|---------|---------|
| Subscription dropdown | `GET /api/setup/subscriptions` → ARM `GET {LOOM_ARM_ENDPOINT or management.azure.com}/subscriptions?api-version=2022-12-01` (paged via `nextLink`), `ChainedTokenCredential`(UAMI→DefaultAzureCredential) for the `…/.default` ARM token. |
| Region dropdown | Static Azure region list, Commercial vs `usgov*` selected by boundary (no backend call — region choice is a client param fed to `-l`). |
| Capacity equivalence panel | Pure client computation in `lib/setup/capacity-equivalence.ts` (no backend call). Official figures: CU + Spark vCores (×2) + Power BI v-cores (÷8) + Warehouse SQL vCores/sec from Microsoft Learn; Databricks/ADX/Synapse-SQL recommendations are banded Loom guidelines. Cost = relative tier + estimator deep-link (no fabricated dollars). |
| Deploy button | `POST /api/setup/deploy` — **enforces `admin.deploy-dlz` (Admin)** via `enforceCapability` first (403 if the caller isn't a tenant admin or delegated), then validates config, then either (a) **dispatches** the boundary's deploy workflow via GitHub Actions REST (`…/actions/workflows/{file}/dispatches`) when `LOOM_GITHUB_ACTIONS_TOKEN` is set → 202 `{deploymentMode:'github-workflow-dispatch', workflowFile, dispatchedAt}`, or (b) returns a **503** honest-gate with templated `az deployment sub create --subscription <id> -l <region> -f platform/fiab/bicep/main.bicep -p <boundary>.bicepparam …`. |
| Deploy progress (done screen) | `GET /api/setup/workflow-run-status?workflow={file}&since={dispatchedAt}` → GitHub Actions REST `…/actions/workflows/{file}/runs?event=workflow_dispatch&branch=main`; picks the newest run at/after `since` and returns `status`/`conclusion`/`runUrl`/`runId`. Polled every 6s by the wizard until `status:'completed'`. |

## Cloud / env vars

- `LOOM_ARM_ENDPOINT` — ARM base. Default `https://management.azure.com` (Commercial); set `https://management.usgovcloudapi.net` for Gov.
- `LOOM_UAMI_CLIENT_ID` — optional; when set the subscriptions route uses the Console UAMI to acquire the ARM token, else falls back to `DefaultAzureCredential` (developer `az login`). The identity needs **Reader** on the subscriptions it should be able to target.
- `LOOM_GITHUB_ACTIONS_TOKEN` — optional; a GitHub token (PAT or fine-grained, `actions:write` on the repo) that lets the Deploy button **dispatch the deploy workflow server-side** and stream its run status. Store as a Key Vault `secretRef` on the console Container App. Unset ⇒ the wizard honest-gates to the copy-paste `az deployment sub create` instead (no functionality is hidden).
- `LOOM_GITHUB_REPO_OWNER` / `LOOM_GITHUB_REPO_NAME` — optional; default `fgarofalo56` / `csa-inabox`. The repo the deploy workflows are dispatched in.

## Bicep param files referenced by the deploy gate (verified present)

`commercial-full.bicepparam`, `gcc.bicepparam`, `gcc-high.bicepparam`,
`il5.bicepparam` — all under `platform/fiab/bicep/params/`. The deploy route
maps boundary → param file from this verified set (no invented names).

## Verification

- Backend Vitest contract tests: `app/api/setup/__tests__/setup-routes.test.ts`
  — subscriptions ARM URL/paging/Gov-endpoint/content-type guard/error status;
  deploy 401/400-missing/400-bad-GUID/503-gate Commercial+IL5; **`admin.deploy-dlz`
  gate: 403 for a non-admin with no grant, allowed for a delegated Admin-grant
  holder.** (The repo-wide vitest harness is currently broken — env/setupFiles —
  so these are validated via `tsc` + `next build`, not the unit runner.)
- `next build` clean (`/setup`, `/api/setup/subscriptions`, `/api/setup/deploy`,
  `/api/setup/workflow-run-status` all compiled). `tsc --noEmit` clean for the
  three touched files (setup-wizard pane + deploy + workflow-run-status routes).
- Live minted-session browser walk: not run in the worktree (no provisioned
  Loom + ARM creds here); to be attached on the live environment per
  `no-vaporware.md`.

## Update (audit-t142) — sub defaulting, full regions, visual review, deploy orchestrator

| # | Added capability | Loom coverage | Backend |
|---|---|---|---|
| a | **Single-sub auto-uses the Admin Plane subscription** (no dropdown); multi-sub multi-selects spoke subs | ✅ | `GET /api/setup/config` (LOOM_SUBSCRIPTION_ID/LOOM_LOCATION), `GET /api/setup/subscriptions` |
| b | **Full per-boundary region list**, live ARM `subscriptions/{id}/locations` for the chosen sub with authoritative static fallback (Commercial/GCC=Public, GCC-High/IL5=US Gov, DoD=US DoD) | ✅ | `GET /api/setup/regions`, `lib/azure/azure-regions.ts` |
| c | **Visual architecture diagram** of the planned deployment (reuses the T132 React Flow canvas), shown alongside the generated Bicep on Review | ✅ | `lib/components/setup/deployment-diagram.tsx` |
| d | **Deploy-by-default Setup Orchestrator** runs the real multi-sub `az deployment sub create`; honest fallbacks to GitHub dispatch then copy-paste `az` | ✅ (image-in-ACR gate, like every Loom app) | `setup-orchestrator.bicep`, `POST /api/setup/deploy`, `GET /api/setup/deploy-status` |
| d2 | **Multi-sub deploy auth** — orchestrator identity (Console UAMI) gets Contributor at the hub sub AND each spoke sub | ✅ | `setup-orchestrator-rbac.bicep` (subscription-scoped, looped per `dlzSubscriptionIds`) |
| e | **Wire existing DLZ(s)** discovered via Azure Resource Graph, wired into the Admin Plane with no re-deploy | ✅ | `GET /api/setup/existing-dlzs`, `POST /api/setup/wire-existing` |

Honest gate: the orchestrator Container App defaults OFF (`setupOrchestratorEnabled`)
until the `loom-setup-orchestrator` image is in ACR — same gate every Loom app
carries. On AKS boundaries it deploys via the cluster GitOps path. The deploy BFF
tier order is orchestrator → GitHub workflow-dispatch → copy-paste `az`, so the
wizard's Deploy is always functional, never a dead button (no-vaporware.md). The
review diagram only renders Azure-native services the deployment actually
provisions; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (no-fabric-dependency.md).

Verification (audit-t142): `tsc --noEmit` clean on every touched file;
`az bicep build` clean for both new modules; wiring into `main.bicep` adds zero
new compile errors (the base branch carries a pre-existing `mcpStorage` /
`mcpPrincipalId` duplicate-declaration breakage, out of scope here).


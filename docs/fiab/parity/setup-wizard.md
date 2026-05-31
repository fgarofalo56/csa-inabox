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
| 3 | Parameters (boundary/mode/domain/capacity) | ✅ built | Pre-existing steps; unchanged. |
| 4 | Review | ✅ built | Review step renders the generated `.bicepparam` now including the selected subscription id + region. |
| 5 | Deploy submit | ⚠️ honest-gate | `POST /api/setup/deploy` **validates** the config (400 if subscription/boundary/mode/domain/capacity missing, 400 if subscriptionId is not a GUID) then returns **503** with a copy-paste `az deployment sub create` pre-filled with the selected subscription, region, and the boundary's real `.bicepparam`. The browser-driven Setup Orchestrator service is not deployed in this environment; per `no-vaporware.md` we surface the exact command rather than fake a deploymentId. |
| 6 | Deployment progress / result | ⚠️ honest-gate | "Deploying…" screen shows a Fluent `MessageBar intent="warning"` with the remediation command + Retry/Back; no fabricated progress animation. On a real `{ok:true, deploymentId}` it advances to the success screen. |
| 7 | Auth / permission failures | ✅ built | Subscriptions route returns 502 + hint ("grant the Console UAMI Reader…") on token failure; content-type guard returns 502 on non-JSON ARM responses; deploy route 401 unauthenticated. UI renders all of these in MessageBars. |

Zero ❌. Every gate is an honest Fluent `MessageBar` naming the exact missing
piece (Setup Orchestrator service) and the exact command to run instead.

## Backend per control

| Control | Backend |
|---------|---------|
| Subscription dropdown | `GET /api/setup/subscriptions` → ARM `GET {LOOM_ARM_ENDPOINT or management.azure.com}/subscriptions?api-version=2022-12-01` (paged via `nextLink`), `ChainedTokenCredential`(UAMI→DefaultAzureCredential) for the `…/.default` ARM token. |
| Region dropdown | Static Azure region list, Commercial vs `usgov*` selected by boundary (no backend call — region choice is a client param fed to `-l`). |
| Deploy button | `POST /api/setup/deploy` — validates config, returns 503 honest-gate with templated `az deployment sub create --subscription <id> -l <region> -f platform/fiab/bicep/main.bicep -p <boundary>.bicepparam …`. |

## Cloud / env vars

- `LOOM_ARM_ENDPOINT` — ARM base. Default `https://management.azure.com` (Commercial); set `https://management.usgovcloudapi.net` for Gov.
- `LOOM_UAMI_CLIENT_ID` — optional; when set the subscriptions route uses the Console UAMI to acquire the ARM token, else falls back to `DefaultAzureCredential` (developer `az login`). The identity needs **Reader** on the subscriptions it should be able to target.

## Bicep param files referenced by the deploy gate (verified present)

`commercial-full.bicepparam`, `gcc.bicepparam`, `gcc-high.bicepparam`,
`il5.bicepparam` — all under `platform/fiab/bicep/params/`. The deploy route
maps boundary → param file from this verified set (no invented names).

## Verification

- Backend Vitest contract tests: `app/api/setup/__tests__/setup-routes.test.ts`
  (11 tests, all green) — subscriptions ARM URL/paging/Gov-endpoint/content-type
  guard/error status; deploy 401/400-missing/400-bad-GUID/503-gate
  Commercial+IL5.
- `next build` clean (`/setup`, `/api/setup/subscriptions`, `/api/setup/deploy`
  all compiled).
- Live minted-session browser walk: not run in the worktree (no provisioned
  Loom + ARM creds here); to be attached on the live environment per
  `no-vaporware.md`.

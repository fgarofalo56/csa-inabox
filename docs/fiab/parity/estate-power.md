# estate-power — parity with Fabric capacity pause/resume + idle auto-pause

Source UI: Microsoft Fabric capacity pause/resume
(<https://learn.microsoft.com/fabric/enterprise/pause-resume>) and the Azure
portal pause/stop/suspend blades of the backing services (Synapse dedicated SQL
pool, ADX, Analysis Services, scale sets, Databricks). Surface:
`/admin/scaling`, panel `EstatePowerPanel`
(`apps/fiab-console/lib/components/admin-scaling/estate-power-panel.tsx`).

PRP-02 step 3 (#4876) adds the idle signal, the auto-pause setting, and a
service-principal entry point for the Actions/CLI lane.

## Azure / Fabric feature inventory

| # | Capability in the source UI | Source |
|---|---|---|
| 1 | Pause a capacity / service from a single control with a confirmation | Fabric capacity blade, Azure portal |
| 2 | Resume it, with the state shown while it transitions | same |
| 3 | See current state (Active / Paused / transitioning) | same |
| 4 | See what the pause affects before confirming | Fabric pause dialog |
| 5 | Idle-based auto-pause / auto-suspend with a configurable idle time | Synapse auto-pause, Databricks auto-termination, ADX auto-stop |
| 6 | Last activity / last state change visibility | Azure activity log, Fabric capacity metrics |
| 7 | Drive pause/resume from automation (REST / CLI) | Azure REST pause/resume verbs |
| 8 | Scale-to-zero for Container Apps with per-app control | Azure portal Container Apps > Scale and replicas |
| 9 | A visible "capacity is paused" notice with a one-click resume wherever you are | Fabric capacity-paused banner |

## Loom coverage

| # | Loom | Status |
|---|---|---|
| 1 | Pause estate dialog, typed estate-id echo, drift `confirmToken` | built (pre-existing) |
| 2 | Resume estate, per-resource progress, RESUME_FAILED with remediation | built (pre-existing) |
| 3 | State badge RUNNING / PAUSING / PAUSED / RESUMING / RESUME_FAILED | built (pre-existing) |
| 4 | Dry-run preview table with owning tag, resume risk | built (pre-existing) |
| 5 | Auto-pause switch + idle-hours input (1 to 168, default on / 2 h), Save, Retry, Reset to defaults | built this PR (setting + UI). The pause action itself is the Actions lane (separate work item) |
| 6 | Last activity, idle-for, last paused, last resumed badges | built this PR; recorded via `withSession` |
| 7 | `POST /api/estate/power` with the deploy service principal | built this PR |
| 8 | Container Apps in the pause set by default; global and per-app opt-out in the panel; never-pause list shown with reasons | built 2026-10-22 ([guide](../admin/estate-idle-auto-pause.md)). Not exercised against a live app |
| 9 | Shell banner (count, names, when, by whom) with admin Resume / Retry resume; read-only text for others | built 2026-10-22. jsdom only, no in-browser walk (G1) |
| 10 | AKS, VMs, Databricks, Stream Analytics jobs and web sites discovered by the `loom-estate-id` tag (Resource Graph, every subscription the console identity can read), unioned with the manifest and Container Apps; "discovery incomplete" banner when the query fails or a configured subscription is unreadable; the AKS cluster hosting the console is never paused | built 2026-10-23 (#5099 phase A). Merged is not deployed: no live pause/resume walk, GCC-High receipt pending; IL5/DoD supported-in-code only |
| 11 | PostgreSQL and MySQL flexible servers (stop / start, `state` read-back), Application Gateway (stop / start, `operationalState`), Power BI Embedded (suspend / resume, `state`), all tag-discovered. A database is paused only when every consumer named by the `loom-estate-pause-consumers` tag is in the pause set (paused after them, resumed before them); no tag is held out as "consumers unknown", and a held-out server names the consumer that pins it. A gateway whose backend pools target the console, or whose config cannot be read, is held out. A flexible server Azure auto-restarts under a PAUSED estate (PostgreSQL 7 days, MySQL 30) leaves the estate PAUSED and is re-stopped by the idle lane unless a consumer is running again; the panel row discloses it. Console-critical web apps are stamped `loom-estate-pause=exempt` | built 2026-10-23 (#5099 phase B). Merged is not deployed: no live pause/resume walk, GCC-High receipt pending; IL5/DoD supported-in-code only. As stamped by bicep every stock server is pinned by the console or a never-pause app, so none is stopped until an operator changes a consumers tag |

| 12 | "Always on, not pausable" section: Azure Firewall, Bastion, VPN and ExpressRoute gateways, API Management, Redis, AI Search, Azure OpenAI / AI Services, Event Hubs, Purview, Front Door and Container Registry found by the `loom-estate-id` tag, each with name, type, a plain-words reason and a cost labelled actual month-to-date (Cost Management), estimate (list price, East US, Commercial only) or cost unknown; "inventory incomplete: <reason>" instead of an empty list when discovery fails; links to the existing hold-out list for held-out Container Apps and databases. No pause action for the Firewall (operator decision) | built 2026-10-23 (#5099 phase C). jsdom render tests only, live click-walk (G1) owed. Merged is not deployed; GCC-High receipt pending |
| 13 | Phase B review fixes: a database's consumers wait for the database to read Online on resume and are skipped when its start failed; a consumer's replicas are read back before its database is stopped; the App Gateway guard knows the console's custom hostnames and listener hosts; the re-stop gate has a test per input | built 2026-10-23 (#5099 phase C). Not exercised against a live database |

**Activity recording** is wired: `withSession` (lib/api/route-toolkit.ts) calls
`recordHumanActivity` fire-and-forget, throttled to one Cosmos write per 5 minutes
per replica. PAT sessions, health, session refresh, `/api/internal/*`, the state
poll, `/api/estate/power` and the banner's `/api/estate/paused` do not count. Routes that bypass the toolkit do not
count either; until none do, a null or stale `lastActivityAt` can under-report use,
so the contract still forbids auto-pausing on null.

## Backend per control

| Control | Route | Backing |
|---|---|---|
| State, preview, progress | `GET /api/admin/estate/state` | ARM reads of each resource, Cosmos snapshot (`maintenance-jobs`) |
| Pause | `POST /api/admin/estate/pause` | native ARM pause verbs via the orchestrator |
| Resume | `POST /api/admin/estate/resume` | native ARM resume verbs + data-plane probes |
| Auto-pause setting (incl. Container Apps opt-outs) | `GET/PUT /api/admin/estate/autopause` | Cosmos doc `estate-autopause:current` |
| Container Apps list + per-app fate | `containerApps` in the RUNNING state / preview response | ARM list of `Microsoft.App/containerApps` in `LOOM_ACA_RG` (else `LOOM_ADMIN_RG`) |
| Tag discovery + completeness (`discovery` in the RUNNING state / preview response) | `lib/estate/pause-tag-discovery.ts` | `POST {arm}/providers/Microsoft.ResourceGraph/resources` (the cloud's own ARM host, so `management.usgovcloudapi.net` in Gov), `$skipToken` paged, tier types except Container Apps, `tags['loom-estate-id'] ==` this estate id; plus a `resourcecontainers` probe that every configured subscription is readable |
| Database / gateway / Power BI verbs (phase B) | `lib/estate/pause-actuator-phase-b.ts` | `POST {id}/stop` or `/start` (PostgreSQL `2024-08-01`, MySQL `2023-12-30`, Application Gateway `2024-05-01`); `POST {id}/suspend` or `/resume` (Power BI `2021-01-01`); a start is preceded by a state read |
| Dependency guard + gateway guard | `lib/estate/pause-guards.ts`, `pause-set-guards.ts`, `pause-appgateway-guard.ts` | tags only for databases; one ARM GET of the gateway for its `backendAddressPools`, at plan time and again at act time |
| Re-stop of an Azure-restarted server | `lib/estate/pause-reassert.ts`, called from the state read of the idle lane | `POST {id}/stop`, only PostgreSQL / MySQL, only while the estate is PAUSED and armed |
| Always-on inventory + cost | `GET /api/admin/estate/always-on` (`lib/estate/estate-always-on.ts`) | Resource Graph (tag `loom-estate-id`, tier types listed in the guide) plus per-subscription Cost Management `MonthToDate` by `ResourceId`; list-price table for estimates (Commercial only) |
| Paused banner | `GET /api/estate/paused` (any signed-in user) | Cosmos pause snapshot only, no ARM call |
| Idle / last activity | in `power` of the state response | Cosmos doc `estate-activity:current` |
| Automation | `GET/POST /api/estate/power` | same handlers as the cookie routes |

## Service-principal contract (`/api/estate/power`)

Typed in `apps/fiab-console/lib/estate/estate-power-contract.ts`.

- Auth: `Authorization: Bearer <Entra access token>`, client-credentials, scope
  `api://<LOOM_MSAL_CLIENT_ID>/.default` (or `LOOM_ESTATE_POWER_AUDIENCE`).
  Verified with `verifyEntraBearer`: RS256 signature, issuer on the active cloud
  authority (login.microsoftonline.com or .us), audience, expiry, `tid` equal to
  the estate tenant, app role `Estate.Power` in `roles` (a delegated `scp` does
  not qualify). 401 bad credential, 403 valid but no role, 503 not configured.
- Request: `{ action: 'preview' | 'pause' | 'resume' | 'state', confirm?, confirmToken? }`.
  `GET` is `state`.
- Response: the repo envelope. `state` and `preview` carry `power`:
  `{ activity: { lastActivityAt, idleForSeconds, unreadable }, autoPause: { enabled, idleHours, source }, lastPausedAt, lastResumedAt }`.
- `pause` needs `LOOM_ESTATE_PAUSE_ENABLED`, `confirm` (= estate id) and
  `confirmToken`, service principal or not. `dryRun` is never read from the body.
- Caller rule: never auto-pause when `activity.lastActivityAt` is null,
  `autoPause.source` is `unreadable`, or `autoPause.enabled` is false.

## Deploy-lane stand-down (#5111)

The deploy lanes are a second reader of the `state` call above. `estate-pause-gate.yml`
runs `scripts/ci/estate-pause-state.mjs`, which POSTs `{ action: 'state' }` as the deploy
service principal and maps `state` to a decision: PAUSING / PAUSED stand the lane down;
RUNNING / RESUMING / RESUME_FAILED proceed; anything unreadable is `UNKNOWN`. On a
`schedule` run UNKNOWN, or a gate job that failed / timed out / was cancelled, **stands
the lane down (fail-closed)**; on `workflow_dispatch` (and, unchanged, `push` /
`workflow_run`) it proceeds with a warning (fail-open, so a console fault cannot freeze
a manual deploy). Only a
`workflow_dispatch` run with `override_estate_pause: true` can override a stand-down.
See the [guide](../admin/estate-idle-auto-pause.md#deploy-lanes-stand-down-while-the-estate-is-paused-5111)
for the per-lane list. Not yet verified live: no scheduled deploy has been observed
standing down during a live pause. The state body has no `pausedBy` field today.

## Cloud boundaries

Cloud-agnostic by construction (authority host from `AZURE_CLOUD`, ARM from
`armBase()`). Commercial and GCC-High are the intended callers. **Verified:**
unit tests only, including a Commercial issuer refused by a Gov console and the
`.us` issuer accepted. **Not verified:** no live Commercial or GCC-High call, no
live Entra token, no in-browser walk (G1). GCC and IL5/DoD are supported-in-code
only, never exercised.

Phase-B types (PostgreSQL / MySQL flexible, Application Gateway, Power BI Embedded) use
the same ARM transport. Per-cloud availability, with what Microsoft Learn does and does
not establish for Azure Government (MySQL flexible and the Power BI Embedded
suspend/resume verb are **not established** there), is in the
[guide](../admin/estate-idle-auto-pause.md#clouds). No phase-B verb has been run live in
any cloud.

Phase C (always-on section): Commercial shows actual month-to-date cost or a labelled
list-price estimate; GCC-High and DoD show actual cost or "cost unknown" (no Gov price
table); GCC and IL5 are supported-in-code, never exercised. No live run in any cloud.

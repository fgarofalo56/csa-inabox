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

## Cloud boundaries

Cloud-agnostic by construction (authority host from `AZURE_CLOUD`, ARM from
`armBase()`). Commercial and GCC-High are the intended callers. **Verified:**
unit tests only, including a Commercial issuer refused by a Gov console and the
`.us` issuer accepted. **Not verified:** no live Commercial or GCC-High call, no
live Entra token, no in-browser walk (G1). GCC and IL5/DoD are supported-in-code
only, never exercised.

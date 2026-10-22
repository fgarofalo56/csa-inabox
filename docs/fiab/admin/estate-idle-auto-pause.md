# Idle auto-pause for Container Apps

> **Surface:** `/admin/scaling` (Estate power panel) and the banner in the shared shell
> **BFF:** `app/api/admin/estate/{state,pause,resume,autopause}/route.ts`, `app/api/estate/paused/route.ts`
> **Lane:** `.github/workflows/estate-idle-autopause.yml` (every 30 minutes, per boundary)
> **Bicep dependency:** none new. The setting lives in the existing Cosmos `maintenance-jobs` container.

Since 2026-10-22 the idle auto-pause includes **Azure Container Apps by default**.
When nobody has used the console and no pipeline has run for the idle window
(2 hours unless you change it), the estate pauses: each eligible Container App is
scaled to zero replicas, and **resume restores the exact replica range recorded at
pause time**. Nothing is deleted.

## What changed, and why it was not already happening

The pause set used to come only from the deploy manifest, which names four things:
the Synapse dedicated pool, the ADX cluster, the Analysis Services server and the
SHIR scale set. Container Apps were allowed by the pause tier but nothing named
them, so the auto-pause lane could fire and leave every app billing. The console
now lists the Container Apps in its own resource group (`LOOM_ACA_RG`, else
`LOOM_ADMIN_RG`) and decides **per app**. An app joins only if it carries the
`loom-estate-id` tag for this estate. The resource-group name is never used as
evidence.

## Never paused

| App | Why (from the Bicep that deploys it) |
|---|---|
| `loom-console` and anything this process is, or that is tagged `loom-role=console` / `resume-surface` | It is the surface that resumes the estate and signs people in. If the console cannot be identified, **no** app is paused. |
| `loom-risingwave` | Holds materialized-view and meta state in process; scale-to-zero loses every MV. |
| `iceberg-catalog`, `loom-unity` | Cold start is 23-30 s against a hard 30 s Front Door ceiling, so the first call after a pause returns a 504; where the durable Postgres store is not wired, scale-to-zero also destroys the catalog. |
| `loom-redis-oss` | A shared cache that scales to zero loses every key. |
| `loom-capacity-broker` | HA-critical admission control (minReplicas 2). |
| `loom-onelake` | Namespace resolution is on the hot path. |
| `loom-duckdb` | The interactive serving tier is documented "never scale-to-zero". |
| any app tagged `loom-estate-pause=exempt` | Your own infrastructure-level exemption. |

The list is in code (`NEVER_PAUSE_CONTAINER_APPS` in `lib/estate/pause-guards.ts`),
checked at plan time, at act time and again in the ARM actuator. It is not a runtime
setting on purpose: lifting an entry means accepting the loss written next to it.

Apps that already scale to zero (`minReplicas 0`) are listed as "already scales to
zero" and are not touched: pausing them would save nothing.

## Opting out

Both switches are in the Estate power panel (Admin > Scaling) and are saved to the
existing auto-pause setting (`GET/PUT /api/admin/estate/autopause`):

- **Global:** "Include Container Apps in pause". Off leaves every Container App
  running; the data services still pause.
- **Per app:** one switch per app that can be paused. Unticked apps are stored in
  `containerApps.exempt` and never paused, by auto-pause or by the manual button.
- **Auto-pause itself** (all of it) is the existing "Auto-pause when idle" switch.

Every change writes an audit row and a SIEM event with the before and after values.
If the setting cannot be read, **no** Container App is paused until it can.

## How an app is paused and resumed

Pause order is the reverse of resume: apps first, then data services, then the
platform. Resume order is platform, then data services, then apps, so an app is never
started before what it depends on. Each step is read back: Loom reports a service
paused or running only after Azure confirms it. No app-to-app dependency exists in the
deploy wiring (every cross-app URL is console to app), so ordering is by type.

An app with ingress wakes on traffic even while "paused", because its minimum is 0
and its HTTP rule is unchanged. The panel then reports that app as running again
(drift); this is true, not a fault. Background workers (for example scheduled Airflow
DAGs, Activator rules, Mirroring) do **not** run while paused; exempt any app whose
schedule must keep running.

## The banner

While any service is paused, every page shows a banner: how many services, which,
when, and by whom (the identity is shown to administrators only; others see the kind
of actor). Administrators get a **Resume** button that calls the same resume route as
the panel, shows progress, and hides when the estate is running. If the resume fails
the banner turns red, names the services not confirmed back up, and keeps the button
as **Retry resume**. Everyone else sees "An administrator can resume them."

The banner reads the pause snapshot only (no Azure call per page) and its polling is
excluded from the idle signal, so it cannot keep the estate awake.

## How to resume

1. Click **Resume** in the banner, or **Resume estate** in the panel; or
2. run the `estate-power` workflow with `action: resume` for the boundary.

## Clouds

Same code path in every boundary: the GCC-High and IL5 parameter files also set
`containerPlatform = 'containerApps'`, and the ARM host comes from `armBase()`, so the
listing, the guard, the banner and the opt-outs behave identically. The one exception
is a deployment that sets `LOOM_CONTAINER_PLATFORM=aks`: there are no Container Apps
to list, the panel says so, and the AKS cluster stays in its own pause tier.

**Verified:** unit and component tests only (jsdom), with mutation runs for the
load-bearing arms. **Not verified:** no live pause or resume of any Container App in
any cloud, no in-browser walk (ux-baseline G1). GCC-High and IL5 are exercised only
through GitHub Actions, and have not been exercised for this change. GCC is
supported-in-code and has never been exercised.

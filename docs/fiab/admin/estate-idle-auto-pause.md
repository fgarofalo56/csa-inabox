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

### Other pausable types are found by tag (#5099)

AKS clusters, VMs, Databricks workspaces, Stream Analytics jobs, web sites and (phase
B, below) PostgreSQL / MySQL flexible servers, Application Gateways and Power BI
Embedded capacities are found with one Azure Resource Graph query: resources of those types whose
`loom-estate-id` equals this estate's id, in every subscription the console identity
can read. They are added to the manifest and Container Apps sets (nothing already
discovered changes). A resource with no tag, or another estate's tag, is not
discovered even when it sits in the same resource group. Tag a resource
`loom-estate-pause=exempt` to keep it running.

- **The AKS cluster that hosts the console is never paused** (`containerPlatform=aks`,
  `LOOM_AKS_CLUSTER_NAME`). If the console runs on AKS and cannot tell which cluster is
  its own, no cluster is paused.
- **A failed or partial discovery says so.** The panel shows "Discovery incomplete" with
  the raw reason when the Resource Graph query fails (403, 500, throttled) or when a
  subscription this console is configured for (`LOOM_SUBSCRIPTION_ID`,
  `LOOM_DLZ_SUBSCRIPTION_ID`, ...) is not readable by its identity. That is not
  "nothing to pause". A throttled query also blocks the pause (retry).
- **Container Apps outside the console's resource group are not covered yet**; they keep
  their own per-app policy above.
- Resources created by the console at run time (Stream Analytics jobs carry only
  `loomItemId`) or by bootstrap workflows (some function apps) are not tagged by the
  bicep and are therefore not discovered until their creators stamp the tag.

### Databases, Application Gateway and Power BI Embedded (#5099 phase B)

Four more types join the tag-discovered set. They stop and start with these ARM verbs
(Microsoft Learn REST reference, checked 2026-10-23):

| Type | Stop / start | Power read-back | Tier |
|---|---|---|---|
| PostgreSQL flexible server | `POST .../stop`, `.../start` (api `2024-08-01`) | `properties.state`: Ready, Stopped, Stopping, Starting, Updating | data |
| MySQL flexible server | `POST .../stop`, `.../start` (api `2023-12-30`) | `properties.state`, same values | data |
| Application Gateway | `POST .../stop`, `.../start` (api `2024-05-01`) | `properties.operationalState`: Running, Stopped, Starting, Stopping | platform |
| Power BI Embedded capacity | `POST .../suspend`, `.../resume` (api `2021-01-01`) | `properties.state`: Succeeded, Paused, Suspended, Pausing, Resuming | data |

The platform tier resumes first and pauses last; the data tier resumes before the apps
that use it and pauses after them. A stop is only reported as done after a fresh ARM
read shows it stopped, and a start reads the state first: Learn documents that starting
a server that is not Stopped fails (`ServerIsNotStopped`), so an already-running server
is reported as already running and no start is sent.

**A database is stopped only if every app that uses it is stopped too.** Most estate
Postgres servers back always-on apps (`loom-unity`, `loom-airflow`, `loom-duckdb`, the
console), and stopping one breaks the app. The consumers come from a tag stamped by
bicep, `loom-estate-pause-consumers=<comma-separated app names>`:

- **No tag, or an empty one: held out, "consumers unknown".** Nothing is guessed. The
  panel lists it under "deliberately NOT paused" with that reason.
- **A consumer on the never-pause list, the console, or an app that is not in this pause
  set (exempt, opted out, not tagged for this estate): held out.** The reason and a
  "pinned by" badge name the exact consumer.
- **Every consumer is in the set:** the server is stopped after them. At pause time the
  check is repeated against what actually happened: a consumer whose pause was skipped or
  rejected pins the server, which is then left running.
- `loom-estate-pause-consumers=none` is the one explicit way to say no running app uses a
  server. It is an operator decision; bicep stamps never write it. The shipped modules
  stamp their real consumers, so as deployed **none of the stock servers is stopped**
  (each is pinned by the console or a never-pause app). Each module exposes an
  `estatePauseConsumers` parameter; a redeploy rewrites the tag, so change it there, not
  by hand.

**Azure restarts a stopped flexible server on its own.** PostgreSQL after 7 days
(`how-to-stop-server`); MySQL after 30 days (`how-to-stop-start-server-portal`). The
estate stays PAUSED when that happens: `drifted` and the per-row state say the server is
running again, and the state never becomes an error or RESUME_FAILED. The idle auto-pause
lane reads the state every 30 minutes, and on that read Loom re-sends the stop for a
PostgreSQL or MySQL server (only those two types, only when the arming switch is on, only
for a server that was running before Loom paused it) unless one of its consumers is
running again, in which case the server is left running and the row names that consumer.
A panel poll never re-stops anything. The panel row says all of this.

**An Application Gateway fronting the console is never stopped.** Loom reads the
gateway's backend pools and holds it out if any pool targets the console (its app name,
its configured public host, any host containing "console"), targets an IP with no FQDN
(an IP cannot be shown not to be the console's), or if the console cannot be identified,
runs on AKS, or the config could not be read ("could not be established"). A throttled
read refuses the pause with a retry rather than counting as a hold-out. The bicep also
stamps the shipped gateway `loom-estate-pause=exempt`.

**The console's custom hostnames also hold a gateway out** (#5099 phase C). Besides the
app name and the configured public host, the console identity now includes
`LOOM_PUBLIC_URL`, `LOOM_SELF_BASE_URL`, `LOOM_VANITY_DOMAIN` and a comma-separated
`LOOM_CONSOLE_HOSTNAMES`, and a gateway listener whose host name is one of those holds the
gateway out too. A hostname that is in none of those is not known to the console, so a pool
on it is judged like any other app; list your Front Door or vanity hostnames in
`LOOM_CONSOLE_HOSTNAMES` if the gateway fronts them. With no console identity at all, the
gateway is still held out.

**Resume order for a database's consumers** (#5099 phase C). A database is started first,
and its consumers (the apps named in its consumers tag) are held until the database reads
Online; the state poll starts them then, and the estate is not reported RUNNING until each
one answers a real request. If the database's start request fails, its consumers are not
started: they are reported "database not started" and the resume ends RESUME_FAILED.
At pause time a consumer's scale-to-zero being accepted is not enough: its replicas must
read back as zero (or its state as stopped) within a bounded wait before the database is
stopped, otherwise the database is left running with that reason.

**Web apps.** The only `Microsoft.Web/sites` in the Loom bicep on a non-Consumption plan
is the deploy-planner App Service; it is stamped `loom-estate-pause=exempt`, as are the
two Function Apps the console calls synchronously (built-in MCP server, SCC labels).
Consumption (Y1) sites remain a disclosed no-op.

### Always on, not pausable, with what it costs (#5099 phase C)

Some resources the estate owns have no pause verb, or are deliberately never paused. The
panel lists them in an "Always on, not pausable" section, so a PAUSED estate does not hide
what is still billing. Ownership is the same `loom-estate-id` tag the pause set uses, read
with one Resource Graph query (`GET /api/admin/estate/always-on`, tenant admin only,
read-only). Each row has the name, type, a plain-words reason and a cost.

| Type | Why it is not paused |
|---|---|
| Azure Firewall | Never paused (operator decision): the console's outbound traffic routes through it, so a deallocated firewall would make a paused estate impossible to resume from Loom. There is no pause action for it. |
| Azure Bastion, VPN gateway, ExpressRoute gateway | Azure has no stop verb; the only way to stop the charge is to delete the resource, which Loom never does on its own. |
| API Management, Azure Cache for Redis / Managed Redis, Azure AI Search, Event Hubs, Purview, Container Registry | No stop verb; the resource bills while it exists (a registry's images are also needed to resume apps, and stopping Redis would discard the cache). |
| Azure OpenAI / AI Services | No stop verb; billed by use, so there is no idle charge to save. Only accounts of kind `OpenAI` or `AIServices` are listed. |
| Front Door | Never paused: it is the public path to the console. |

Container Apps and databases that are in the pause set but held out keep their reasons in
the existing "Loom-owned, but deliberately NOT paused" list; the new section links to it
rather than repeating them.

**Where each cost comes from** (a figure is never shown without its provenance):

- **actual month-to-date**: Azure Cost Management spend for that exact resource id
  (`MonthToDate`, grouped by `ResourceId`, one query per subscription). It needs Cost
  Management Reader and can lag by a day or more. Used whenever Cost Management returns a
  row for the resource.
- **estimate (list price, East US)**: otherwise, in Commercial only, a list price from a
  small SKU table in `lib/estate/estate-always-on.ts` (Azure Retail Prices API, East US,
  USD, read 2026-10-23). It covers Firewall, Bastion, ExpressRoute and Basic VPN gateway,
  API Management, Redis (Basic/Standard C0-C1, Premium P1), AI Search, Event Hubs
  (Basic/Standard), Front Door (Standard/Premium base fee) and Container Registry. It
  excludes data processing, ingress, egress, discounts and usage charges, so it is labelled
  an estimate on the badge and on the card, and a resource outside East US says it was
  priced at East US.
- **cost unknown**: any SKU not in the table, usage-priced types (OpenAI / AI Services,
  Purview, Managed Redis, classic Front Door), and every non-Commercial cloud without an
  actual row. No number is shown.

The totals keep actual and estimate separate and never add them. If Cost Management
cannot be read for a subscription the section says so and the affected rows fall back to a
labelled estimate or "cost unknown".

**Incomplete, not empty.** If the Resource Graph query fails, the console has no estate
id, or a configured subscription cannot be read, the section shows "inventory incomplete:
<reason>" and never "nothing is always on". The empty state appears only for a complete
inventory with zero rows.

## Never paused

| App | Why (from the Bicep that deploys it) |
|---|---|
| `loom-console` and anything this process is, or that is tagged `loom-role=console` / `resume-surface` | It is the surface that resumes the estate and signs people in. If the console cannot be identified, **no** app is paused. |
| `loom-risingwave` | Holds materialized-view and meta state in process; scale-to-zero loses every MV. |
| `iceberg-catalog`, `loom-unity` | Cold start is 23-30 s against a hard 30 s Front Door ceiling, so the first call after a pause returns a 504; where the durable Postgres store is not wired, scale-to-zero also destroys the catalog. |
| `loom-activator`, `loom-mirroring` | Background workers with no inbound traffic, pinned to minReplicas 1 on purpose (`admin-plane/main.bicep`). Pausing them silently stops Activator rules and Mirroring replication, and nothing wakes them. |
| `loom-airflow` | LocalExecutor runs the webserver and the singleton scheduler in one replica pinned to minReplicas 1 (`airflow.bicep`). Pausing it silently stops every cron DAG. |
| `loom-mcp`, `loom-mcp-bridge` | The console calls them synchronously on user request paths (agent flows, MCP server list and test-connection, the External-MCP panel) with a 5 s client timeout. Their wake time from zero is unmeasured, so the first call could report a false timeout; unverified wake time is treated as a reason to hold them out. |
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

An app with ingress wakes on traffic even while "paused", because its minimum is 0 and its HTTP rule is unchanged. The panel then reports that app as running again (drift); this is true, not a fault. Apps that do background work with nothing calling them are on the never-pause list for that reason; exempt any other app whose schedule must keep running.

## Crash safety

Before each app is scaled down, its exact replica range is written to the pause snapshot (record first, then patch). A process death or a Cosmos error mid-pause therefore leaves a PAUSING record that resume can restore from, and a re-pause cannot lose the original range. If the record cannot be written, that app is not touched. A pause in which every verb is rejected leaves no record behind. A service whose pause verb was rejected is shown in the banner as "failed to pause" and is not counted as stopped.

## The banner

While any service is paused, every page shows a banner: how many services, which,
when, and by whom (the identity is shown to administrators only; others see the kind
of actor). Administrators get a **Resume** button that calls the same resume route as
the panel, shows progress, and hides when the estate is running. If the resume fails
the banner turns red, names the services not confirmed back up, and keeps the button
as **Retry resume**. Everyone else sees "An administrator can resume them."

The banner reads the pause snapshot only (no Azure call per page) and its polling is
excluded from the idle signal, so it cannot keep the estate awake. While a pause or
resume is in flight it polls every 10 s, backs off while Azure throttles, and stops
after 10 minutes (pause) or 20 minutes (resume) with a visible notice and a
"Check again" link.

## How to resume

1. Click **Resume** in the banner, or **Resume estate** in the panel; or
2. run the `estate-power` workflow with `action: resume` for the boundary.

## Clouds

Same code path in every boundary: the GCC-High and IL5 parameter files also set
`containerPlatform = 'containerApps'`, and the ARM host comes from `armBase()`, so the
listing, the guard, the banner and the opt-outs behave identically. The one exception
is a deployment that sets `LOOM_CONTAINER_PLATFORM=aks`: there are no Container Apps
to list, the panel says so, and the AKS cluster stays in its own pause tier.

Phase-B types, per cloud (**none exercised live in any cloud**; the ARM path is the
cloud's own host via `armBase()`):

| Type | Commercial | GCC-High / DoD | GCC | IL5 |
|---|---|---|---|---|
| PostgreSQL flexible | supported-in-code | supported-in-code. Learn lists PostgreSQL flexible server availability in Azure Government regions | supported-in-code, never exercised | supported-in-code, never exercised |
| MySQL flexible | supported-in-code | supported-in-code. Azure Government availability **not established** on Learn in this pass | supported-in-code, never exercised | supported-in-code, never exercised |
| Application Gateway | supported-in-code | supported-in-code. The `/stop` and `/start` verbs are the same ARM operations; v2 SKU only | supported-in-code, never exercised | supported-in-code, never exercised |
| Power BI Embedded | supported-in-code | supported-in-code. Learn: Azure Embedded (F) capacities are supported in GCC High and DoD, only EM and P SKUs in GCC; whether `Microsoft.PowerBIDedicated` `suspend`/`resume` behaves the same there is **not established** | supported-in-code, never exercised | supported-in-code, never exercised |

The shipped `gcc-high` and `il5` parameter files do not stamp anything the Commercial
ones do not (the tags are in the modules), and every touched module compiles.

The always-on section (#5099 phase C) uses the cloud's own ARM and Cost Management hosts.
Commercial: estimates and actual cost. GCC-High / DoD: supported-in-code, actual cost or
"cost unknown" (no Gov price table exists), never exercised. GCC and IL5: supported-in-code,
never exercised. No live run in any cloud.

**Verified:** unit and component tests only (jsdom), with mutation runs for the
load-bearing arms. **Not verified:** no live pause or resume of any Container App in
any cloud, no in-browser walk (ux-baseline G1). GCC-High and IL5 are exercised only
through GitHub Actions, and have not been exercised for this change. GCC is
supported-in-code and has never been exercised.

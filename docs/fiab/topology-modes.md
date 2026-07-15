# CSA Loom — deployment topology modes (audit-t156)

`platform/fiab/bicep/main.bicep` deploys in one of three **explicit** topologies,
selected by the `topology` parameter. This replaces the old implicit behavior
where the admin plane (console + hub + all shared services) was deployed on
**every** run — which meant onboarding a new domain would create a *second* Loom
console. The legacy `deploymentMode` (`single-sub` / `multi-sub`) is still
honored and maps onto the new modes for back-compat.

## The three modes

| `topology`    | Admin plane (console, Front Door, Cosmos, hub, LAW, shared svcs) | Landing zone(s) | Use |
|---------------|------------------------------------------------------------------|-----------------|-----|
| `single-sub`  | ✅ deployed                                                       | ✅ one, in the same sub | dev / demo (the pre-t156 default, byte-identical) |
| `tenant`      | ✅ deployed (the **DMLZ**)                                        | ❌ none          | the one-console-per-tenant deploy; domains attach later |
| `dlz-attach`  | ❌ **skipped** (must already exist)                              | ✅ into the target sub(s) | onboard a domain landing zone wired to the existing hub |

**Back-compat mapping** (when `topology` is empty):
`deploymentMode='single-sub'` → `single-sub`; `deploymentMode='multi-sub'` →
legacy admin-plane + multi-sub DLZ fan-out (unchanged).

Derived gating booleans in `main.bicep`:
- `deployAdminPlane = effectiveTopology != 'dlz-attach'` — gates **only** the
  admin-plane RG (`adminPlaneRg`), the admin-plane module (`adminPlane`), and
  the admin-plane outputs (`consoleUrl`, `mcpServerUrl`, the Front Door / vanity
  URL outputs, etc.). It also *selects* where the `hub` var reads its
  coordinates — `adminPlane.outputs.*` when the admin plane is deployed in this
  run, `hubCoordinates` in `dlz-attach` — but it does **not** gate the
  subscription-scoped console-RBAC modules (see "Subscription-scoped RBAC runs
  in every topology" below).
- `deployLandingZones = effectiveTopology != 'tenant'`.
- `useSingleDlz` / `useMultiDlz` pick the in-sub `singleDlz` module vs the
  cross-sub `dlz[for]` fan-out over `dlzSubscriptionIds` / `dlzDomainNames`.
  `useSingleDlz` is what gates the 21 `dp*` deploy-planner modules, the
  single-sub AOAI-spark RBAC (`singleDlzAoaiSparkRbac`), and the single-sub
  access-policy RBAC; `useMultiDlz` gates the cross-sub DLZ fan-out, its
  access-policy RBAC, and the setup-orchestrator **spoke** RBAC. None of these
  are gated by `deployAdminPlane`.

### Subscription-scoped RBAC runs in **every** topology (including `dlz-attach`)

Four subscription-scoped console-RBAC modules are **not** gated by any topology
boolean. They deploy on every run and self-gate only on a **non-empty principal
id** (each module no-ops internally when its principal arrives `''`):

| Module | Role granted (subscription scope) | Principal source |
|--------|-----------------------------------|------------------|
| `consoleMonitoringReaderRbac` | Monitoring Reader | `hub.consolePrincipalId` |
| `consoleCostReaderRbac` | Cost Management Reader | `hub.consolePrincipalId` |
| `rtiHubRbac` | Reader (Azure Resource Graph cross-RG discovery) | `dpConsolePrincipalId` |
| `setupOrchestratorHubRbac` | Contributor (only when `setupOrchestratorEnabled`) | console UAMI |

This is **intentional and correct**. In `dlz-attach` the principal is the
**existing** central console UAMI (supplied via `hubCoordinates.consolePrincipalId`),
and the one console must gain Reader/Cost/Monitoring **at the attached spoke
subscription** so it can discover and observe resources across every domain sub
— exactly what the `rti-hub-rbac` module header documents. So a `dlz-attach` run
**does** create subscription-scoped grants on the target/spoke sub:

- **Monitoring Reader** — `/monitor` (metrics / activity / health / alerts) and
  the Activator run-history grid read live observability in the spoke sub.
- **Cost Management Reader** — `/admin/capacity` cost column (F5) and the
  `/monitor` Cost tab read live spend in the spoke sub.
- **Reader** — Azure Resource Graph returns the spoke sub's Event Hub
  namespaces / IoT Hubs / ADX clusters in the `/rti-hub` catalog.
- **Contributor** — only when `setupOrchestratorEnabled`: lets the orchestrator
  `az deployment sub create` into the spoke sub.

These grants reuse the existing console principal and do **not** require the
admin plane to be (re)deployed. Do **not** add a `deployAdminPlane` guard to
them — that would break cross-sub console visibility for attached domains. The
only thing `deployAdminPlane` truly skips in `dlz-attach` is the admin-plane RG,
the admin-plane module, and the admin-plane outputs.

## Hub coordinates for `dlz-attach`

In `dlz-attach` the admin plane is **not** deployed, so the DLZ + cross-sub RBAC
modules cannot read `adminPlane.outputs.*`. They read from the `hubCoordinates`
object param instead — the tenant (DMLZ) deployment's `topologyManifest.hub`
output. Required keys:

```
adminPlaneRgName, hubVnetId, lawId, appInsightsConnectionString,
privateDnsZoneIds { synapseSql, adf }, adxClusterPrincipalId,
consolePrincipalId, consoleUamiName, consoleUamiAppId, consoleUamiResourceId,
activatorPrincipalId, catalogEndpoint, aiServicesAccountName
```

These come from the cross-subscription `existing`/output flow per
[Bicep deploy-to-subscription scopes](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-to-subscription#deployment-scopes).
The orchestrator (audit-t157) stores them in the Cosmos `tenant-topology` doc at
tenant-deploy time and passes them back as params on each attach.

**Fail-fast (the "REQUIRED" contract is enforced).** Because the admin plane is
skipped in `dlz-attach`, an absent `hubCoordinates` would otherwise let every
`hub.*` field silently resolve to `''` and pass empty hub wiring into the
landing-zone + cross-sub RBAC modules. To prevent that, `main.bicep` refuses to
proceed: when `effectiveTopology == 'dlz-attach'` and any of the minimum hub
keys (`hubVnetId`, `lawId`, `consolePrincipalId`) are empty, the `hub` var's
`dlz-attach` branch dereferences a property that does not exist, which ARM
rejects at **validate / what-if / deploy** time. The error names the env vars
the operator must supply — `LOOM_HUB_VNET_ID`, `LOOM_HUB_LAW_ID`,
`LOOM_HUB_CONSOLE_PRINCIPAL_ID` (and the rest of `topologyManifest.hub`) from
the tenant (DMLZ) deploy outputs. The guard is consumed only by that branch, so
it never fires in `single-sub` / `tenant` / legacy modes.

## `topologyManifest` output

Every deployment emits a `topologyManifest` object output — a faithful record of
what was deployed where (per `no-vaporware.md`), for the console to ingest:

```jsonc
{
  "topology": "tenant",
  "deploymentMode": "single-sub",
  "boundary": "Commercial",
  "location": "eastus2",
  "adminPlaneDeployed": true,
  "adminPlaneSubId": "<guid>",
  "adminPlaneRgName": "rg-csa-loom-admin-eastus2",
  "landingZonesDeployed": false,
  "hub": { "hubVnetId": "...", "lawId": "...", "consolePrincipalId": "...", ... },
  "consoleUrl": "https://loom-console...",
  "dlzs": [ { "domainName": "...", "subscriptionId": "...", "resourceGroup": "..." } ]
}
```

Read it after a tenant deploy:

```bash
az deployment sub show -n <deploy-name> \
  --query properties.outputs.topologyManifest.value
```

## Reference parameter files (FedCiv estate — OPERATOR DECISION D1)

- `platform/fiab/bicep/params/tenant-dmlz.bicepparam` — `topology='tenant'`,
  console + shared services into the DMLZ sub (`e093f4fd-…`).
- `platform/fiab/bicep/params/dlz-attach.bicepparam` — `topology='dlz-attach'`,
  a domain landing zone into a bureau sub (`363ef5d1-…`), wired to the hub via
  `hubCoordinates` (env-backed, populated from the tenant deploy outputs).

## Deploy each mode

```bash
# 1) Tenant (DMLZ): the one console + shared services. NO landing zones.
az deployment sub create --subscription <DMLZ-sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/tenant-dmlz.bicepparam

# 2) Attach a domain landing zone into a bureau sub. NO second console.
#    Export the LOOM_HUB_* env vars from step 1's topologyManifest.hub first.
az deployment sub create --subscription <DLZ-sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/dlz-attach.bicepparam

# 3) Single-sub dev/demo (unchanged):
az deployment sub create --subscription <sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial.bicepparam
```

## Verify (what-if)

- `tenant` → what-if shows **no** landing-zone resources (no `singleDlz`/`dlz[*]`).
- `dlz-attach` → what-if shows **zero** console / Front Door / Cosmos / hub
  resources (the admin plane is skipped); only the landing-zone RG + its
  resources, wired to the existing hub.
- `single-sub` → identical to the pre-t156 deployment.

## Bootstrap + console sync

- `deploy-fiab-commercial.yml` / `deploy-fiab-gcc.yml` / `deploy-fiab-gcch.yml`
  gain a `topology` `workflow_dispatch` input → `CSA_LOOM_TOPOLOGY` → threaded
  into the deploy `--parameters topology=…` (only when non-empty).
- The Setup Wizard deploy route (`app/api/setup/deploy/route.ts`) validates
  `topology` against the enum (`loom-no-freeform-config`) and threads it into the
  GitHub workflow dispatch inputs **and** the honest 503 copy-paste command.

> The wizard first-run = `tenant` (+ optional first DLZ) and subsequent
> "Add landing zone" runs = `dlz-attach` only (no second console from the UI) is
> implemented in audit-t157.

## Who can deploy / attach a landing zone from the Console (identity + grants)

`POST /api/setup/deploy` (the Setup Wizard "Deploy" and the /admin "Add landing
zone" Attach) tries these tiers **in order**, each under a different identity —
so "authorized" means different grants depending on which tier serves the deploy:

| Tier | Identity that submits the ARM deployment | Required grant on the **target** subscription |
|------|------------------------------------------|-----------------------------------------------|
| 1. User-delegated ARM (day-one default) | The **signed-in operator** (delegated ARM token; falls back to the Console UAMI when the ARM scope wasn't consented at login) | **Contributor** (or Owner) for the operator — or for the Console UAMI on the fallback |
| 2. Setup Orchestrator (`LOOM_SETUP_ORCHESTRATOR_URL`) | The **orchestrator identity** (= Console UAMI, granted by `setup-orchestrator-rbac.bicep`) | **Contributor** per target subscription |
| 3. GitHub workflow dispatch (`LOOM_GITHUB_ACTIONS_TOKEN`) | The **deploy service principal** used by the workflow's `AZURE_*` secrets | **Contributor** (deploy SP is usually Owner-ish on Loom-owned subs) |
| 4. Copy-paste `az` gate (503) | Whoever runs the command | **Contributor** |

Additionally, every tier needs the caller to pass the Console's
`admin.deploy-dlz` feature-permission (tenant admins bypass; others must be
delegated at `/admin/permissions`), and the target subscription must have the
DLZ resource providers registered (`Microsoft.Storage`, `Microsoft.Kusto`,
`Microsoft.DocumentDB`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`,
`Microsoft.Network`).

The wizard runs an **in-flow pre-flight** on the chosen subscription (async
`/api/setup/deploy-preflight`, user-passthrough) and blocks submit only on a
definitive "cannot deploy", showing the exact grant:

```bash
az role assignment create \
  --assignee-object-id <operator-or-console-uami-object-id> \
  --assignee-principal-type User|ServicePrincipal \
  --role Contributor \
  --scope /subscriptions/<target-subscription-id>
```

### Anti-504 submit contract (Front Door)

The Console sits behind Azure Front Door, whose origin-response timeout turns
any BFF await longer than ~60s into an **HTML 504** the wizard cannot parse
("Deploy service returned non-JSON"). The deploy submit route therefore bounds
**every** hop and always answers structured JSON:

| Budget (env override) | Default | Bounds |
|---|---|---|
| `LOOM_DEPLOY_TOKEN_BUDGET_MS` | 10s | OBO / UAMI ARM-token acquisition |
| `LOOM_DEPLOY_PREFLIGHT_BUDGET_MS` | 15s | cold cross-sub permission + RP pre-flight (prediction only — skipped on timeout) |
| `LOOM_PREFLIGHT_FETCH_TIMEOUT_MS` | 20s | each pre-flight ARM round-trip |
| `LOOM_ORCH_SUBMIT_TIMEOUT_MS` | 15s | Setup Orchestrator submit POST (falls through when the orchestrator app is wedged/unreachable) |
| `LOOM_GH_DISPATCH_TIMEOUT_MS` | 15s | GitHub workflow dispatch |
| `LOOM_DEPLOY_SUBMIT_BUDGET_MS` | 40s | **total** route backstop → honest JSON 504 (never the edge's HTML page) |

The ARM submit itself was already bounded (8s early-return race + background
PUT, pollable via `/api/setup/deploy-status?mode=user-arm`).

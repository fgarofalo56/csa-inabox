# Brownfield deployment — adopting existing Azure infrastructure

**Brownfield** means: the target tenant already contains at least one Azure
resource CSA Loom could use — an existing Purview account, a shared AI Search
service, an ADLS Gen2 lake, an existing VNet — or an existing
`rg-csa-loom-admin-*` hub you are reconciling.

Brownfield is a **first-class supported path**, not a variation on greenfield.
It is verified independently (`deploy-integrity.md` R4): greenfield working
proves nothing about brownfield.

> **Read [Greenfield](greenfield.md) first if you have not.** Brownfield is
> greenfield plus a decision per service. The three-phase shape (infra →
> images → bootstrap) is identical, and every phase-1 caveat still applies.

---

## The rule this path exists to honour

Two behaviours are violations, not trade-offs:

1. **Silently deploying a second Purview next to your existing one.**
2. **Failing the deploy because one already exists.**

Loom's job is to discover what is there, tell you what it would use each thing
for and what it would change about it, and let you decide per service.

---

## Three decisions, per service

| Decision | Meaning | Effect |
|---|---|---|
| **Adopt** | Use the resource that already exists | The provisioning module is skipped; the Console binds to your resource; the Console managed identity is granted the role it needs on it |
| **Create** | Deploy a new one | Standard greenfield behaviour for that service |
| **Skip** | Neither | The dependent Loom surfaces render an honest gate naming the missing config. Not available for every service |

You mix these freely. A typical federal brownfield plan adopts the tenant
Purview and a shared AI Search, creates everything else, and skips Azure Maps.

---

## Step 1 — the multi-subscription analysis

Loom can inventory **every subscription you can read** and report what it could
adopt. It is a read-only Azure Resource Graph query — it reads resource names,
regions, SKUs and network configuration, and writes nothing.

### From the Console wizard

Open `/setup` → step **Scan & choose**. The wizard queries Resource Graph across
the tenant and returns, per service: the candidates it found, a recommendation,
and the reason Loom wants that service.

> **Limitation you must know about (2026-08-05).** `/setup` **redirects to
> `/admin/landing-zones` as soon as a Loom hub exists** in the tenant. On an
> estate that already has a hub — which includes any retry or reconcile — the
> Scan & choose step is unreachable from the Console. Use the CLI path below.
> See [Status](#status-what-the-wizard-does-and-does-not-implement).

### From the CLI (works on any estate)

```bash
# Read-only inventory across every subscription the signed-in principal can see,
# with ready-to-source EXISTING_* exports for each reusable resource.
bash scripts/csa-loom/discover-services.sh
```

```bash
# Interactive: scan, prompt adopt / create / skip per service, and write a
# drop-in parameter file plus the matching exports.
bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full
```

`byo-wizard.sh` writes `platform/fiab/bicep/params/<name>.generated.bicepparam`
and `temp/<name>.byo-exports.sh`.

> On an *adopt* pick it writes ONE entry into the `adopt` object bag —
> see [what the BYO wizard emits](#what-the-byo-wizard-emits-and-what-it-no-longer-emits).
> It no longer emits per-service `existing*` params: `main.bicep` stopped
> declaring them, and assigning one is a compile-time `BCP259`.

### What it scans

Sixteen service types today. The full list, with the ARM type queried, the
environment variables it emits and what Loom uses each service for, is in
[**Discovery and adoption**](discovery-and-adoption.md#what-is-scanned).

### Permissions the scan needs

| Need | Scope | Who | If absent |
|---|---|---|---|
| `Microsoft.Resources/subscriptions/read` | tenant | you | the subscription is not listed at all |
| `Reader` | each scanned subscription | you (CLI path) or the Console managed identity (wizard path) | that subscription's resources are invisible — Resource Graph trims by RBAC and returns no error |
| `Reader` on each adopted resource's subscription | resource | Console managed identity | the Console cannot read the adopted resource at runtime; grant it during the post-deploy RBAC pass |

> **Coverage caveat.** Resource Graph silently returns fewer rows when your
> principal lacks Reader — it does not tell you a subscription was invisible.
> The wizard's "N subscriptions scanned" counter is derived from subscriptions
> that produced a *match*, so a subscription with Reader but no adoptable
> resources is not counted, and a subscription with no Reader looks identical to
> one with nothing in it. **Confirm your subscription list independently**
> (`az account list -o table`) rather than trusting the counter. Fixing this so
> a per-subscription ledger distinguishes *scanned-and-empty* from
> *could-not-read* is in flight — see
> [Status](#status-what-the-wizard-does-and-does-not-implement).

---

## Step 2 — choose adopt or create, per service

This is the table that matters: it says, per service, what "adopt" actually
does to the deploy.

### Adopting suppresses creation — for every adoptable service

Set the `EXISTING_*` values (or hand the wizard a `reuse:` pick, or post a plan)
and the provisioning module is skipped. **Nothing else is required.**

`main.bicep` derives one gate per service:

```bicep
var provisionPurview = purviewEnabled && adoptMode(adopt, 'purview') == 'create'
```

so a decision of `adopt` suppresses the new resource on its own. The enable flag
stays TRUE — it is also the Console's binding mirror, and turning it off would
adopt your resource and then un-wire Loom from it.

| Service | Adopt via | Suppression gate | Notes |
|---|---|---|---|
| AI Search | `EXISTING_AI_SEARCH_SERVICE` (+ `_RG`, `_SUB`) | `provisionAiSearch` | |
| API Management | `EXISTING_APIM` (+ `_RG`, `_SUB`) | `provisionApim` | Adopting skips a ~30-minute Premium provision |
| ADX / Kusto | `EXISTING_KUSTO_CLUSTER` (+ `_RG`, `_SUB`) | `provisionAdx` | **See the ADX grant caveat below** |
| AI Foundry / AOAI | `EXISTING_AOAI` (+ `_RG`, `_SUB`, `_CHAT_DEPLOYMENT`, `_EMBED_DEPLOYMENT`) | `provisionFoundry`, `provisionAgentFoundry` | ONE decision now gates both the hub account and the agent project |
| Event Hubs | `EXISTING_EVENTHUB_NAMESPACE` (+ `_RG`, `_SUB`) | `provisionEventHubs` | |
| Stream Analytics | `EXISTING_ASA_JOB` (+ `_RG`, `_SUB`) | `provisionStreamAnalytics` | |
| Cosmos (Console metadata) | `EXISTING_COSMOS_ACCOUNT` (+ `_RG`, `_SUB`) | `provisionConsoleCosmos` | |
| Purview | `EXISTING_PURVIEW` (+ `_RG`, `_SUB`) | `provisionPurview` | Tenant singleton — the wizard DISABLES "create new" when one exists rather than offering it and failing `EnterpriseTenantAlreadyExists` |
| Azure Maps | `EXISTING_AZURE_MAPS_ACCOUNT` (+ `_RG`, `_SUB`) | `provisionMaps` | |
| Synapse | `EXISTING_SYNAPSE` (+ `_RG`, `_SUB`) | `provisionSynapse` | |
| Databricks | `EXISTING_DATABRICKS` (+ `_RG`, `_SUB`, `_HOSTNAME`) | `provisionDatabricks` | |
| Data Factory | `EXISTING_ADF` (+ `_RG`, `_SUB`) | `provisionAdf` | |
| Azure ML | `EXISTING_AML_WORKSPACE` (+ `_RG`, `_SUB`) | `provisionAml` | |
| Azure SQL (plan backing) | `loomPlanBackingSqlServer` (+ `loomSqlServerRg`) | *(reference-only)* | Adopt-only by design — Loom never creates this server, it only reads |

> **This replaced a class A / class B split.** Six services used to bind the
> Console WITHOUT suppressing creation, so an operator who named their Purview
> and forgot `-p purviewEnabled=false` got a second account and a hard
> `EnterpriseTenantAlreadyExists`. `scripts/ci/check-adoption-catalog-sync.mjs`
> byte-compares each `provision<Svc>` line against `main.bicep` and asserts the
> var actually reaches the module parameter that creates the resource, so the
> asymmetry cannot come back unnoticed.

### Class C — no adoption path exists today

There is no parameter, environment variable or wizard pick for these. They are
always created new by the deploy.

| Service | Consequence for a brownfield estate |
|---|---|
| **Hub VNet, subnets, NSGs** | Loom creates its own hub VNet. Choose a non-colliding `hubVnetCidr` (default `10.0.0.0/16`). You cannot point the hub at an existing VNet |
| **Spoke (DLZ) VNet** | Hardcoded `10.100.0.0/16` for every DLZ — the `spokeVnetCidr` parameter exists in the landing-zone module but is not threaded from the root template. **If `10.100.0.0/16` is in use in your estate, this collides** |
| **Private DNS zones** | Loom creates and links its own `privatelink.*` zones. A zone that already exists in the target resource group fails `PrivateDnsZoneAlreadyExists` on a re-deploy — see [Failure recovery](failure-recovery.md#config) |
| **Azure Firewall instance** | Created (or skipped with `loomFirewallEnabled=false` — **not** `firewallEnabled`, which is a different, deploy-planner-scoped firewall). The *policy* can be reconciled by fixed name in the same resource group, but not adopted by id |
| **Key Vault** | Always created new — deliberate, see [below](#what-loom-will-not-adopt-and-why) |
| **ACR, Container Apps Environment** | Always created new |
| **ADLS Gen2 lake storage** | Always created new. `EXISTING_STORAGE` is accepted by the discovery tooling but **no bicep parameter reads it** — the pick has no effect |
| **Log Analytics, App Insights** | Always created new |
| **PostgreSQL Flexible, Redis, Service Bus, Event Grid, Azure ML, Analysis Services** | Always created new (or skipped by flag where one exists) |

> **`EXISTING_STORAGE`, `EXISTING_POSTGRES`, `EXISTING_KEYVAULT`, `EXISTING_ADF`,
> `EXISTING_FIREWALL`, `EXISTING_MAPS` have no `.bicepparam` consumer.** Setting
> them does nothing at deploy time. `EXISTING_ADF` and `EXISTING_MAPS` do have
> effect through their alternate names (`existingAdfFactory` /
> `loomAzureMapsAccount`); the others do not. This is documented here rather
> than left for you to discover.

### The ADX grant caveat

When ADX is adopted, the module that grants the cluster's identity **Event Hubs
Data Receiver** and sets up the export RBAC is gated on the same
`empty(existingAdxClusterName)` condition as the cluster module — so it is
skipped too. **An adopted ADX cluster receives no grants and cannot ingest until
you grant them.** Run the post-deploy RBAC pass (below) and verify with the
Real-Time Intelligence editors before declaring it working.

---

## Step 3 — supply the values

Three input paths. They set the same underlying parameters.

### 3a. Environment variables + the stock parameter file (the supported path)

Every boundary parameter file reads `readEnvironmentVariable('EXISTING_*', '')`,
so exporting the variables before `az deployment sub create` is the whole
mechanism.

```bash
# Adopt the tenant Purview (cross-subscription is normal for Purview) and a
# shared AI Search; create everything else.
export EXISTING_PURVIEW=my-tenant-purview
export EXISTING_PURVIEW_RG=rg-shared-governance
export EXISTING_PURVIEW_SUB=<governance-sub-id>

export EXISTING_AI_SEARCH_SERVICE=my-shared-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
export EXISTING_AI_SEARCH_SUB=<sub-id>          # only when cross-subscription

az deployment sub create \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false \
```

`EXISTING_*` coverage per parameter file:

| Parameter file | `EXISTING_*` reads | Adoption available? |
|---|---|---|
| `commercial-full.bicepparam` | 35 | yes |
| `commercial.bicepparam` | 32 | yes |
| `gcc.bicepparam` | 36 | yes |
| `gcc-high.bicepparam` | 35 | yes |
| `il5.bicepparam` | 34 | yes |
| `tenant-dmlz.bicepparam` | 30 | yes |
| **`dlz-attach.bicepparam`** | **0** | **no — the add-a-landing-zone path cannot adopt anything at deploy time** |

### 3b. The generated parameter file

`byo-wizard.sh` writes a `.generated.bicepparam` with the values baked in, plus
an exports file for the post-deploy scripts:

```bash
bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full

az deployment sub create -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.generated.bicepparam \
  -p adminEntraGroupId="$GROUP_ID" -p deployAppsEnabled=false

source temp/commercial-full.generated.byo-exports.sh
bash scripts/csa-loom/grant-navigator-rbac.sh
```

Non-interactive form, for CI:

```bash
BYO_NONINTERACTIVE=1 \
  BYO_PURVIEW='reuse:my-tenant-purview:rg-shared-governance:<sub-id>' \
  BYO_APIM='reuse:my-apim:rg-apim:<sub-id>' \
  BYO_AISEARCH=new BYO_ADX=gate \
  bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full --non-interactive
```

Each `BYO_<KEY>` is `reuse:<name>[:<rg>[:<sub>]]` | `new` | `gate`.

#### What the BYO wizard emits (and what it no longer emits)

On a `reuse` pick `byo-wizard.sh` writes ONE entry into the `adopt` object:

```bicep
param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')), {
  purview: { mode: 'adopt', target: { name: 'my-tenant-purview', rg: 'rg-shared-governance', sub: '<sub-id>' } }
})
```

It does **not** write `param existingPurviewAccount = '<name>'`. `main.bicep`
stopped declaring those 36 scalars — ARM caps a template at 256 parameters and
`main.bicep` sat at 251/256, so no further service could be made adoptable at
all. Assigning one of the old names now fails to compile with

```
Error BCP259: The parameter "existingPurviewAccount" is assigned in the params
file without being declared in the Bicep file.
```

**You no longer add the disable flag yourself.** That was the class A / class B
split, and it is gone: `main.bicep` derives
`provisionPurview = purviewEnabled && adoptMode(adopt, 'purview') == 'create'`,
so an `adopt` decision suppresses the new resource on its own while the enable
flag stays true (the flag is also the Console's binding mirror — turning it off
would adopt your Purview and then un-wire Loom from it). Omitting a flag can no
longer produce `EnterpriseTenantAlreadyExists`.

A pure-greenfield run emits **no** adopt entries; every absent key resolves to
`create`.

### 3c. Live re-binding, without redeploying

An already-running estate cannot re-run `main.bicep` to change its Console
environment. Use the env-patch script instead — it honours the same
`EXISTING_*` names:

```bash
EXISTING_APIM=my-apim EXISTING_APIM_RG=rg-apim \
  bash scripts/csa-loom/patch-navigator-env.sh
```

This is also how non-deterministic values that Bicep cannot synthesize get
reconciled — the Databricks workspace URL, a cross-region ADX cluster URI.

---

## Step 4 — what is validated, per service

**Today, day-0 adoption validates existence only.** A candidate qualifies
because its ARM type matches. SKU, region, network reachability and RBAC are
**not** checked before the deploy runs on the adopt path.

The one place fitness *is* checked today is the **day-2 attach** flow —
`/admin/landing-zones` → *Attach existing service* — whose preflight checks
reachability, network posture, and emits the exact
`az role assignment create` when a grant is missing. That surface is
registry-level (it records an attachment and wires runtime env); it is not the
day-0 deploy input.

The blocking day-0 fitness suite is in flight. When it lands, each adopted
resource is checked against five criteria before any resource is created:

| Check | Establishes | Example failure |
|---|---|---|
| **C1 SKU / tier** | the SKU supports what Loom needs | AI Search **Free** has no index quota for Loom's four indexes |
| **C2 Region** | same region as the hub, or an accepted cross-region pair | Purview cross-region is supported via `purviewLocation`; ADX cross-region adds ingest latency |
| **C3 Network reachability** | the Console's Container Apps subnet can reach the resource's data plane | a private-endpoint-only resource in an unpeered VNet |
| **C4 RBAC** | the deploy identity holds — or can grant — the role the service needs | no `Microsoft.Authorization/roleAssignments/write` at that scope |
| **C5 Family-specific** | the service-specific precondition | ADLS **without hierarchical namespace**; a Databricks workspace already assigned to a *different* Unity Catalog metastore; an AOAI account with no chat/embed deployment |

Until that lands, **validate these yourself before you adopt.** The checks that
most often bite, and how to run them by hand:

```bash
# ADLS Gen2 must have HNS. This is create-time-only and cannot be turned on later.
az storage account show -n <name> -g <rg> --query "isHnsEnabled"

# AI Search tier — Free cannot host Loom's indexes.
az search service show -n <name> -g <rg> --query "sku.name"

# AOAI/Foundry: Loom needs a chat AND an embedding deployment to exist.
az cognitiveservices account deployment list -n <name> -g <rg> -o table

# Databricks must be Premium (Unity Catalog + SCIM require it).
az databricks workspace show -n <name> -g <rg> --query "sku.name"

# Network posture — public, IP-restricted, or private-endpoint only.
az resource show --ids <resource-id> --query "properties.publicNetworkAccess"
```

---

## Step 5 — what happens when validation fails

Today, an unusable adopted resource fails **during** the deploy, as an ARM error
on the module that tries to use it, leaving a partially-created estate. That is
the behaviour to plan around: take a snapshot of the target resource groups
before a first brownfield deploy.

Look the ARM code up in [**Failure recovery**](failure-recovery.md). The
brownfield-specific codes, and what each actually means:

| ARM code | Class | What it means | What to do |
|---|---|---|---|
| `EnterpriseTenantAlreadyExists` | config | A Purview account already exists in this tenant | Adopt it: `EXISTING_PURVIEW=<name>` (+ `_RG`, `_SUB`). No enable-flag override is needed — `provisionPurview` is already false for an `adopt` decision |
| `PrivateDnsZoneAlreadyExists` | config | The `privatelink.*` zone already exists — usually a re-deploy after a partial failure | Delete the conflicting zone, or deploy into a clean resource group. **There is no `existingPrivateDnsZones` parameter** — an earlier version of the runbook said there was; it does not exist |
| `VnetAddressRangeInUse` | config | The hub CIDR (or the hardcoded `10.100.0.0/16` spoke CIDR) collides | Set `hubVnetCidr` to a free `/16`. The spoke CIDR is not currently settable — see class C |
| `StorageAccountAlreadyTaken` | config | Global name collision | Change the deployment name prefix |
| `RoleAssignmentExists` | config | You are re-deploying and the grant is already there | Re-run with `skip_role_grants=true` |
| `AuthorizationFailed` on an adopted resource's scope | permission | The deploy identity has no rights in the subscription holding your existing resource | Grant it Contributor at that scope, or Reader + the specific role for that service |
| `LinkedAuthorizationFailed` | permission | The deploy is trying to write a role assignment on a resource it can read but not administer | The deploy identity needs `Microsoft.Authorization/roleAssignments/write` at that scope |
| `SkuNotAvailable` / `LocationNotAvailableForResourceType` | quota | The service or SKU is not offered in the target region | Pick another region, or adopt cross-region where supported (Purview), or disable that service |

---

## Mixing adopt and create

Nothing constrains the combination. The most common federal shape:

```bash
# Adopt: the tenant Purview (singleton), a shared AI Search, a shared APIM.
export EXISTING_PURVIEW=corp-purview
export EXISTING_PURVIEW_SUB=<governance-sub-id>
export EXISTING_AI_SEARCH_SERVICE=corp-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
export EXISTING_APIM=corp-apim
export EXISTING_APIM_RG=rg-shared-api

# Create: everything data-plane — lake, Databricks, Synapse, Event Hubs, ADX.
# Skip:   Azure Maps (region does not offer it) and the hub firewall.

az deployment sub create -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam \
  -p adminEntraGroupId="$GROUP_ID" \
  -p deployAppsEnabled=false \
  -p azureMapsEnabled=false \
  -p loomFirewallEnabled=false
```

> Note there is **no `-p purviewEnabled=false`**. `EXISTING_PURVIEW` is folded
> into the `adopt` bag by the boundary bicepparam, and `provisionPurview` is
> already false because the decision is `adopt`. `azureMapsEnabled=false` and
> `loomFirewallEnabled=false` are still here because those are *skip* decisions
> — "deploy nothing and bind nothing" — which is a different answer from *adopt*.

Then the phase-2 and phase-3 steps are identical to
[greenfield](greenfield.md#phase-2-build-the-images-and-bring-the-apps-up-1525-min),
plus one brownfield-only step:

```bash
# Grant the Console managed identity the per-service roles on the resources you
# adopted, in THEIR subscriptions. Reads the same EXISTING_* names.
source temp/<name>.byo-exports.sh   # or export them again
bash scripts/csa-loom/grant-navigator-rbac.sh
```

> `grant-navigator-rbac.sh` covers AI Search, APIM, AOAI, Cosmos, Event Hubs,
> Synapse and Data Factory. It does **not** grant ADX/Kusto, Databricks, Stream
> Analytics or Maps on an adopted resource — grant those manually (the role per
> service is in [Discovery and adoption](discovery-and-adoption.md#what-loom-changes-about-an-adopted-resource)).

---

## Adopting into an existing Loom hub

If the target subscription already contains an `rg-csa-loom-admin-*` resource
group, a **second Console cannot be stamped into it**. Two supported moves:

| Goal | How |
|---|---|
| Reconcile / retry a partially-deployed hub | `gh workflow run deploy-fiab-commercial.yml -f run_mode=full -f allow_existing_hub=true -f keep_resources=true -f deploy_apps_enabled=true` |
| Add another Data Landing Zone | `topology=dlz-attach` with `target_subscription=<new-sub-id>` — the DLZ lands in a **new** subscription |

> `allow_existing_hub` exists because the topology guard otherwise rejects
> `topology=tenant` when a hub is present. A `schedule`-triggered run supplies no
> inputs and therefore cannot set it.
>
> **`keep_resources` defaults to `false`, and in `full` mode that runs the
> teardown step on success** — it enumerates `rg-csa-loom-*` across the
> subscription and deletes every match, purging Key Vaults and Cognitive
> Services accounts. **Always pass `keep_resources=true` for a real install.**
> `deploy_apps_enabled` also defaults `false`, so without it no Container Apps
> are created.

`dlz-attach` cannot adopt any service at deploy time —
`dlz-attach.bicepparam` reads zero `EXISTING_*` variables. Adopt on that path
using the day-2 attach wizard (`/admin/landing-zones` → *Attach existing
service*) after the DLZ exists.

---

## What Loom will not adopt, and why

These are decisions with specific technical reasons, not gaps.

| Not adoptable | Why |
|---|---|
| **Key Vault (the platform vault)** | It is the trust root for MSAL secrets, data-plane credentials and signing material. `enableSoftDelete` / `enablePurgeProtection` are one-way settings that cannot be retroactively guaranteed, and adoption would mean Loom writes platform secrets into a vault whose access policies and network ACLs a third party mutates. Referencing a customer vault as a read-only *secret source* for connection strings is a different, narrower capability |
| **Container Apps Environment** | Its infrastructure subnet and `internal` ingress mode are **immutable after creation**. Loom requires an internal-ingress environment in a delegated subnet of a minimum size, and the environment is the unit of `.internal` FQDN resolution. An environment created `internal=false`, or in an undersized subnet, cannot be converted. Loom *can* be placed in an adopted VNet — that is the supported brownfield lever, and it is not built yet (class C) |
| **Azure Firewall instance** | Rule-collection-group priority bands collide destructively and there is no safe merge — Loom cannot know which of your existing collections it may renumber. Adopting the *policy* by id (Loom adding its own uniquely-named rule-collection-group in a reserved band) is the supportable form |
| **Anything cross-tenant** | Loom's identity model is single-tenant; the managed identity cannot hold a role in another tenant without a B2B/Lighthouse arrangement Loom does not model. Purview is tenant-scoped specifically |
| **A VNet with no free contiguous address block** | Loom cannot expand or renumber an existing VNet — address-space changes break every existing NIC. If there is no free space for the hub subnet roles, this is a hard stop |
| **A Databricks workspace already assigned to a foreign Unity Catalog metastore** | Metastore assignment is one per account per region and reassignment is destructive to existing UC objects |
| **ADLS Gen2 without hierarchical namespace** | `isHnsEnabled` is **create-time only**. A StorageV2 account without it cannot serve Delta through the Gen2 API. Not a warning — pick another account or let Loom create one |

---

## Azure Government brownfield

The decision model, the `EXISTING_*` mechanism and the adoption table are
identical — `gcc.bicepparam`, `gcc-high.bicepparam` and `il5.bicepparam` all
read the `EXISTING_*` variables. Two Gov-specific differences:

1. **Everything runs through GitHub Actions.** There is no local-CLI Gov path;
   set the `EXISTING_*` values as repository or environment variables consumed
   by the deploy workflow, not as shell exports on a workstation.
2. **Azure Maps is unavailable in GCC-High / IL5**, so the Maps decision does
   not arise. Purview is not in the IL5 audit scope; IL5 uses the Atlas-on-AKS
   catalog instead.

Gov brownfield has **not been verified end-to-end**. It is declared untested
here rather than implied working.

---

## Status: what the wizard does and does not implement

`deploy-integrity.md` R8 requires the docs and the wizard to agree. This section
is the disagreement list, measured against `main` on **2026-08-05**. Everything
above that is not listed here is the shipped behaviour.

### The wizard collects brownfield choices that the deploy discards

The Setup Wizard's *Scan & choose* step produces a real per-service
adopt/create/skip decision. That decision reaches the deploy on **one** path
only — the copy-paste `az` command the Console prints when every in-product
deploy tier is unavailable, and only for `topology=tenant`.

| Deploy tier | Carries your choices? |
|---|---|
| In-product ARM deployment (the default) | **No** — its parameter builder emits no `existing*` values |
| Setup Orchestrator service | **No** — the request model does not declare the field and drops it silently |
| GitHub workflow dispatch | **No** — the dispatch input list does not include it |
| Copy-paste `az` (the HTTP-503 fallback) | **Yes**, `topology=tenant` only |

**Consequence: if the in-product deploy succeeds, your adopt picks are ignored
and Loom provisions new resources.** Until this is closed, drive brownfield from
the CLI (§3a or §3b), not from the wizard.

### Other gaps, precisely

| Gap | Effect |
|---|---|
| `/setup` redirects to `/admin/landing-zones` once a hub exists | Scan & choose is unreachable on any estate with an existing hub — including every retry |
| No networking / Log Analytics / ACR / Key Vault in the scan or the parameters | You cannot bring your own VNet, subnets, DNS zones, firewall, workspace or registry (class C) |
| `EXISTING_STORAGE` / `_POSTGRES` / `_KEYVAULT` / `_FIREWALL` / `_MAPS` have no parameter consumer | Setting them does nothing |
| Stream Analytics and the hub firewall are absent from the wizard's parameter map; Event Hubs is mapped without its enable flag | A *skip* pick for those three is silently dropped |
| A *use existing* pick for storage, Postgres or Maps matches no branch | Silently emits nothing |
| The wizard reports Postgres as "ON by default" | `postgresEnabled` defaults to **`false`** in `main.bicep` |
| No day-0 fitness validation | An unusable adopted resource fails mid-deploy, not before it |
| No failure classification or bounded retry in the deploy path | A transient throttle and a deterministic quota denial are handled identically |
| `subscriptionsScanned` counts only subscriptions that produced a match | *Scanned and empty* is indistinguishable from *could not read* |

### In flight

Work is under way to collapse the six divergent service catalogues into one, to
replace the 36 `existing*` scalars with a single `adopt` object parameter (so
adoption always suppresses creation and networking becomes adoptable without
breaching the ARM 256-parameter cap — `main.bicep` is at **251/256** today), to
persist the plan so every deploy tier carries it, to add the blocking fitness
suite, and to add the failure-classification engine.

**None of that is on `main` as of 2026-08-05.** This page will be updated when
each lands, and the status table above is the contract in the meantime.

---

## Next

- [**Discovery and adoption**](discovery-and-adoption.md) — the full service reference: what is scanned, what Loom uses each service for, and what it changes about an adopted resource
- [**Failure recovery**](failure-recovery.md) — the failure taxonomy
- [**Bring-your-own services**](../bring-your-own-services.md) — the original per-service reuse reference
- [**Greenfield deployment**](greenfield.md)

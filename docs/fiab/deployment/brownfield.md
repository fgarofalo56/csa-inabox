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

## Verification status (`deploy-integrity.md` R4)

R4 requires greenfield and brownfield to be verified **independently**, per
cloud. This page states where that has happened and where it has not, rather
than letting the reader assume.

| Cloud | Status of this walkthrough |
|---|---|
| **Azure Commercial** | **Template-level only.** `az bicep build` + `az deployment sub validate` were run against a `byo-wizard.sh`-generated `.bicepparam` carrying a three-service adopt bag (Purview + Synapse + Databricks) and it validated. **No adopt-or-create deploy has been executed against a real populated Commercial estate**, so nothing past ARM's own validation is proven. |
| **Azure Government (GCC / GCC-High)** | **Not verified.** No Gov brownfield deploy has been run. `deploy-fiab-gcch.yml`'s three most recent runs all ended `failure` (2026-08-01, -02, -03). |
| **DoD IL5** | **Never executed.** `gh run list --workflow deploy-fiab-il5.yml` returns nothing. |

**What "template-level only" excludes.** Validation proves the template
compiles and ARM accepts the parameters. It does **not** prove that an adopted
resource is reachable, correctly permissioned, or that the Console binds to it
at runtime — and it does not exercise the `adopt` suppression logic against a
subscription that actually contains those resources. Treat a first brownfield
deploy as the test of that path.

Every disagreement between this page and the shipped code is listed in
[**Status**](#status-what-is-implemented-and-what-is-not) — including four
that are open defects with tracked issue numbers.

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

> **This is not the scanner with the coverage ledger (#3015).** `/setup` calls
> `POST /api/setup/scan-services`, which sends `options: { top: 1000 }` — and
> `top` is a **silent no-op** in Resource Graph; the real key is `$top`. That
> route has no `$skipToken` paging loop and does not set `allowPartialScopes`,
> so an estate with more than 1000 matching resources is truncated with nothing
> in the response to say so, and a subscription you cannot read is dropped
> silently. The honest scanner — three-step coverage probe, per-subscription
> ledger, real paging — is `POST /api/deploy/discovery`, described in
> [Discovery and adoption](discovery-and-adoption.md#2-the-part-that-matters-most-coverage).
> Use the CLI or that endpoint for anything larger than a small estate.

> **`/setup` no longer redirects away when a hub exists.** An earlier version of
> this page said it did; that redirect was removed and
> `scripts/ci/check-setup-entrypoints.mjs` fails the build if `redirect(`
> reappears in `app/setup/page.tsx`. The invariant it was standing in for lives
> where it belongs: `POST /api/setup/deploy` rejects `topology='tenant'` when a
> hub is already present.

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
[**Discovery and adoption**](discovery-and-adoption.md#what-it-scans-for).

### Permissions the scan needs

| Need | Scope | Who | If absent |
|---|---|---|---|
| `Microsoft.Resources/subscriptions/read` | tenant | you | the subscription is not listed at all |
| `Reader` | each scanned subscription | you (CLI path) or the Console managed identity (wizard path) | that subscription's resources are invisible — Resource Graph trims by RBAC and returns no error |
| `Reader` on each adopted resource's subscription | resource | Console managed identity | the Console cannot read the adopted resource at runtime; grant it during the post-deploy RBAC pass |

> **Coverage caveat.** Resource Graph silently returns fewer rows when your
> principal lacks Reader — it does not tell you a subscription was invisible.
> Verified against live Commercial ARG (`2022-10-01`): four readable scopes plus
> one unreadable returns **HTTP 200, four rows, `facets: []`, and no field
> naming the dropped scope**, even with `allowPartialScopes: true`.
>
> `POST /api/deploy/discovery` handles this — it establishes coverage from ARM
> and a container probe *before* the inventory query, and reports a per
> subscription status of `scanned` · `no-access` · `truncated`. **The `/setup`
> wizard's scanner does not** (#3015): its "N subscriptions scanned" counter is
> derived from subscriptions that produced a *match*, so a subscription with
> Reader but no adoptable resources is not counted, and one with no Reader looks
> identical to one with nothing in it. On the wizard path, confirm your
> subscription list independently (`az account list -o table`) rather than
> trusting the counter.

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

The grants an ADX cluster needs — **Event Hubs Data Receiver** on the DLZ Event
Hubs namespace, and **Storage Blob Data Contributor** on the DLZ lake for
continuous export — are **parameters of the `adx-cluster.bicep` module itself**
(`ehNamespaceName` / `ehNamespaceRg` / `adlsAccountName`, admin-plane
`main.bicep:2923-2952`), not a separate module. That module is gated:

```bicep
module adxCluster 'adx-cluster.bicep' = if (adxEnabled && empty(existingAdxClusterName))
```

An `adopt` decision for ADX makes `existingAdxClusterName` non-empty, so the
module is skipped — **and the grants go with it**. An adopted ADX cluster
receives no grants and cannot ingest until you grant them. Run the post-deploy
RBAC pass (below), then verify with the Real-Time Intelligence editors before
declaring it working.

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

`EXISTING_*` coverage per parameter file — **re-measured 2026-08-06** by counting
`readEnvironmentVariable('EXISTING_…')` occurrences and the distinct services
folded into `legacyAdoptFromEnv` in each file on `main`:

| Parameter file | `EXISTING_*` reads | Services foldable into `adopt` |
|---|---|---|
| `commercial-full.bicepparam` | 57 | 13 |
| `commercial.bicepparam` | 58 | 13 |
| `gcc.bicepparam` | 58 | 13 |
| `gcc-high.bicepparam` | 57 | 13 |
| `il5.bicepparam` | 57 | 13 |
| `tenant-dmlz.bicepparam` | 57 | 13 |
| `dlz-attach.bicepparam` | 57 | 13 |

> **Re-measure these rather than trusting them.** The counts published on
> 2026-08-05 were 60 / 60 / 61 / 60 / 59 / 58 / 58 — every one drifted within a
> day of the files being touched, which is exactly why the command is printed
> here instead of only the number:
>
> ```bash
> cd platform/fiab/bicep/params
> grep -o "readEnvironmentVariable('EXISTING_" commercial-full.bicepparam | wc -l
> ```
>
> The **13** is the number that carries meaning; the raw read count varies with
> incidental formatting (some services take `_RG` / `_SUB` / extra suffixes).

> **This table changed shape, and an earlier version of it was wrong.** Before
> the `adopt` bag each file carried a different, hand-maintained subset (the
> counts published then were 35 / 32 / 36 / 35 / 34 / 30 / **0**). Every file
> now folds the **same** 13 services through the shared `legacyAdoptFromEnv`
> block, so the counts differ only by incidental formatting.
>
> **`dlz-attach.bicepparam` is no longer "0".** It declares `param adopt`
> (`:162`) and folds the same 13 services through `legacyAdoptFromEnv` (`:147`).
> An earlier version of this page said the add-a-landing-zone path "cannot adopt
> anything at deploy time"; that is false as a statement about the parameter file.
> **What has *not* been established is whether the `dlz-attach` topology
> honours each entry** — that topology skips the admin plane, and the
> `provision<Svc>` vars gate admin-plane modules. No `dlz-attach` adopt deploy
> has been run. Treat adoption on that path as untested rather than as working
> or as unavailable, and prefer the day-2 attach wizard until it is exercised.

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

> **The day-0 fitness suite is written but NOT WIRED (#3014).**
> `apps/fiab-console/lib/deploy/fitness.ts` implements all five criteria below
> and exports a blocking gate, `assertPlanIsDeployable()`. Its own header says
> it "runs before a single resource is created". **It does not.** A repo-wide
> search for `assertPlanIsDeployable`, `evaluateFitness` and
> `AdoptionNotDeployableError` finds callers in exactly two files: `fitness.ts`
> and its own unit test. No deploy tier calls it.
>
> Do not read the presence of this module — or its passing tests — as
> protection. Until #3014 wires it, the checks below are **yours to run by
> hand**, and an unusable adopted resource still fails mid-deploy.

The five criteria, as implemented in `fitness.ts` and as they will apply once
that module is invoked:

| Check | Establishes | Example failure |
|---|---|---|
| **C1 SKU / tier** | the SKU supports what Loom needs | AI Search **Free** has no index quota for Loom's four indexes |
| **C2 Region** | same region as the hub, or an accepted cross-region pair | Purview cross-region is supported via `purviewLocation`; ADX cross-region adds ingest latency |
| **C3 Network reachability** | the Console's Container Apps subnet can reach the resource's data plane | a private-endpoint-only resource in an unpeered VNet |
| **C4 RBAC** | the deploy identity holds — or can grant — the role the service needs | no `Microsoft.Authorization/roleAssignments/write` at that scope |
| **C5 Family-specific** | the service-specific precondition | ADLS **without hierarchical namespace**; a Databricks workspace already assigned to a *different* Unity Catalog metastore; an AOAI account with no chat/embed deployment |

**Run these yourself before you adopt.** The checks that most often bite, and
how to run them by hand:

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
> service is in [Discovery and adoption](discovery-and-adoption.md#9-what-loom-changes-about-an-adopted-resource)).

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

`dlz-attach` **can** carry adopt decisions in its parameter file —
`dlz-attach.bicepparam` declares `param adopt` (`:162`) and folds the same 13
services through `legacyAdoptFromEnv` (`:147`). What is **not** established is
whether that topology honours them: it skips the admin plane, and the
`provision<Svc>` gates guard admin-plane modules. **No `dlz-attach` adopt deploy
has been run.** Until one is, treat adoption on that path as *untested*, and use
the day-2 attach wizard (`/admin/landing-zones` → *Attach existing service*)
after the DLZ exists.

> An earlier revision of this page said flatly that "`dlz-attach` cannot adopt
> any service at deploy time — `dlz-attach.bicepparam` reads zero `EXISTING_*`
> variables." That was false (the file contains 57 such reads) **and it
> contradicted [§3a](#3a-environment-variables--the-stock-parameter-file-the-supported-path)
> of this same page**, which had already corrected it. Recorded here because a
> doc that disagrees with itself is worse than one that is merely out of date —
> a reader has no way to tell which half to trust.

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

## Status: what is implemented, and what is not

`deploy-integrity.md` R8 requires the docs and the code to agree. This section is
the disagreement list, **measured against this branch on 2026-08-05** by reading
the code, not by reading the design. Everything above that is not listed here is
shipped behaviour.

> **An earlier version of this section was self-contradicting** and is corrected
> here. It said the adopt-object model, the catalog collapse, the fitness suite
> and the failure engine were "in flight" and that "none of that is on `main`",
> while §3b of the same page documented the `adopt` bag as current behaviour.
> Four of those five have since landed; the two rows below record what actually
> has not.

### Landed — these are shipped, not aspirational

| Capability | Evidence on this branch |
|---|---|
| One `adopt` object parameter replacing 36 `existing*` scalars | `main.bicep:504` `param adopt object = {}`; **zero** `^param existing` declarations remain; the template is at **216** params, down from 251 (cap 256) |
| Adoption always suppresses creation | `main.bicep:567-583`, one `var provision<Svc> = <enableFlag> && adoptMode(adopt, '<key>') == 'create'` per service — the class A / class B split is gone |
| Every emitter writes the bag, not the scalars | `byo-wizard.sh:364`, `scan-and-deploy.sh`, `app/api/setup/deploy/route.ts:971`, `lib/setup/service-choices-to-params.ts:79` |
| One adoption catalog, guarded | `lib/deploy/adoption-catalog.ts`; `scripts/ci/check-adoption-catalog-sync.mjs` runs in `loom-guardrails.yml` |
| `/setup` reachable on an estate that already has a hub | the redirect is removed; `scripts/ci/check-setup-entrypoints.mjs` fails the build if `redirect(` reappears |
| Failure classification + bounded retry | `lib/deploy/failure-taxonomy.json` + `scripts/ci/deploy-retry.mjs` — **on the Commercial deploy workflows only**, see below |

### Open — the deploy still discards your brownfield picks (#3016)

The *Scan & choose* step produces a real per-service adopt/create/skip decision.
`collectAdoptBag()` has **one** call site: the copy-paste `az` command builder.

| Deploy tier | Carries your choices? |
|---|---|
| User-delegated ARM submit — in-code the "PREFERRED, and now ALWAYS available" tier | **No.** `buildDlzDeploymentParameters()` (`lib/setup/user-arm-deploy.ts:116`) contains zero `adopt`/`existing` references |
| Setup Orchestrator | **No** — the request model does not declare the field |
| GitHub workflow dispatch | **No** — not in the dispatch input list |
| Copy-paste `az` (the HTTP-503 fallback) | **Yes**, `topology=tenant` only |

**Consequence: if the in-product deploy succeeds, your adopt picks are ignored
and Loom provisions new resources** — including a second Purview attempt, which
then fails `EnterpriseTenantAlreadyExists`. The tier most likely to run is the
one that drops the decision, silently. **Until #3016 lands, drive brownfield
from the CLI (§3a or §3b), not from the wizard.**

### Open — the rest, precisely

> **Four of these have fixes IN FLIGHT — open pull requests, not merged, not
> deployed** (checked 2026-08-06). Per `deploy-integrity.md` R2 an in-flight or
> merged change is **not** a fix until it is live on the estate, so every row
> below still describes what you will hit today.
>
> | Row | In-flight PR | State on 2026-08-06 |
> |---|---|---|
> | #3014 fitness gate inert | **#3062** — "wire the four inert deploy-plumbing paths: fitness gate, one scan engine, adopt-bag on every tier, Gov classified retry" | **OPEN** |
> | #3015 wizard scanner ≠ coverage scanner | **#3062** (same PR) | **OPEN** |
> | #3016 adopt-bag discarded by every tier but copy-paste | **#3062** (same PR) | **OPEN** |
> | #3017 no classified retry on Gov | **#3062** (same PR) | **OPEN** |
> | Purview `RequestDisallowedByPolicy` + APIM/VPN adopt-existing idempotency | **#3058** — "brownfield idempotency — adopt-existing singletons, policy-compliant Purview managed storage, per-ARM-leaf classification" | **OPEN** |
>
> **Re-check before relying on either state**, in this order — merged is not
> deployed:
>
> ```bash
> gh pr view 3062 --json state,mergedAt
> gh pr view 3058 --json state,mergedAt
> curl -s https://<your-console-hostname>/build-marker.txt   # what is actually LIVE
> ```
>
> When they land, re-run the "How to re-measure this section" commands below
> rather than deleting these rows on the strength of a merge.

| Gap | Effect | Tracked |
|---|---|---|
| Day-0 fitness suite exists but nothing calls it | An unusable adopted resource fails mid-deploy, not before it. The module's own "runs before a single resource is created" comment is untrue | **#3014** (fix in flight: PR #3062) |
| The wizard's scanner is not the one with the coverage ledger | `/api/setup/scan-services` sends the no-op `options:{top:1000}`, has no `$skipToken` loop and no `allowPartialScopes`: silent truncation past 1000 rows, and an unreadable subscription is indistinguishable from an empty one | **#3015** (fix in flight: PR #3062) |
| No classified retry on any Gov deploy path | `deploy-fiab-gcch.yml` does not invoke `deploy-retry.mjs` at all; the taxonomy and bounded retry are Commercial-only | **#3017** (fix in flight: PR #3062) |
| Purview managed storage rejected by tenant policy (`RequestDisallowedByPolicy`); APIM private-DNS re-link `Conflict`; VPN gateway created under a different name than the existing one | A brownfield re-apply fails on ARM leaves that adoption should have suppressed | **#3038** (fix in flight: PR #3058) |
| No networking / Log Analytics / ACR / Key Vault adoption | You cannot bring your own VNet, subnets, DNS zones, firewall, workspace or registry (class C above) | — |
| `EXISTING_STORAGE` / `_POSTGRES` / `_KEYVAULT` / `_FIREWALL` have no parameter consumer | Setting them does nothing at deploy time | — |
| `dlz-attach` adoption is unexercised | The parameter file folds all 13 services, but that topology skips the admin plane and no adopt deploy has been run on it | — |

### How to re-measure this section

Every row above is a command, not an opinion. Re-run these before trusting it:

```bash
grep -c '^param existing' platform/fiab/bicep/main.bicep        # expect 0
grep -c '^param ' platform/fiab/bicep/main.bicep                # expect < 256
grep -rn 'assertPlanIsDeployable' apps/fiab-console --include=*.ts | grep -v __tests__
grep -n 'collectAdoptBag' apps/fiab-console/app/api/setup/deploy/route.ts
grep -c 'deploy-retry' .github/workflows/deploy-fiab-gcch.yml   # expect 0 until #3017
```

---

## Next

- [**Discovery and adoption**](discovery-and-adoption.md) — the full service reference: what is scanned, what Loom uses each service for, and what it changes about an adopted resource
- [**Failure recovery**](failure-recovery.md) — the failure taxonomy
- [**Bring-your-own services**](../bring-your-own-services.md) — the original per-service reuse reference
- [**Greenfield deployment**](greenfield.md)

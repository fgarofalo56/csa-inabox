# Multi-subscription discovery — what Loom finds, and what it will not claim

**Audience:** whoever runs the deployment.
**Applies to:** brownfield *and* greenfield. Greenfield is simply the case where
discovery finds nothing to adopt — and that is a conclusion the scan is careful
to earn rather than assume.

Related: [Bring your own services](../bring-your-own-services.md)

> **Where this page sits.** The end-to-end walkthroughs are
> [**Greenfield**](greenfield.md) and [**Brownfield**](brownfield.md); this page
> is the service-by-service reference they both link into. Read a walkthrough
> first if you are actually deploying.

---

## 0. Two scanners exist. Only one has a coverage ledger.

Everything on this page describes the shared honest scan engine — the
three-step coverage establishment, real `$top`/`$skipToken` paging,
`allowPartialScopes`, and the per-subscription ledger. Three routes now run on
it (**#3015 — merged, not deployed until the next roll**):

| Route | Engine | Scope |
|---|---|---|
| `POST /api/deploy/discovery` | `lib/deploy/discovery-scanner` | explicit subscription list (consented) |
| `POST /api/setup/estate-scan` (wizard *Analysis scope → Reuse or deploy*) | `lib/setup/estate-scan` (shares `COVERAGE_QUERY` with the discovery scanner) | explicit subscription list (consented) |
| `GET /api/setup/discover-services` (the read-only networking panel on the wizard's *Review & deploy* step) | `lib/deploy/discovery-scanner` — the SAME module as `/api/deploy/discovery` | everything the identity can see |

The previous wizard-side scanners are gone: `GET /api/setup/scan-services`
(sent the no-op `top` key, no paging, no ledger, zero UI callers) is deleted,
and `discover-services` no longer runs its own raw Resource Graph query — it
delegates to the discovery scanner and reports `subscriptionsScanned` from the
LEDGER (subscriptions genuinely read), never from matched rows. Its response
now carries `coverage`, `ledger`, and `truncatedBy` alongside the service rows.

---

## 1. What the scan does

Before a deployment plan exists, CSA Loom offers to look across the
subscriptions you allow it to read and report **what already exists that Loom
could use instead of deploying new**. It is read-only: it runs Azure Resource
Graph queries and writes nothing.

```
POST /api/deploy/discovery
{
  "subscriptions": ["<guid>", "<guid>"],   // omit to scan every subscription you can see
  "hubRegion": "centralus"                  // optional; sharpens the recommendations
}
```

Requires the `admin.deploy-dlz` capability at Admin — the same gate as the
deploy itself, because the output drives a subscription-scoped plan.

### What it reads

Per resource: name, resource group, subscription id and display name, region,
SKU name and tier, `publicNetworkAccess`, the network-ACL default action, the
count of private-endpoint connections, ADLS hierarchical-namespace state, and
tags. Nothing else, and nothing is written.

### What it scans for

The ARM type list is **generated** from the adoption catalog
(`apps/fiab-console/lib/deploy/adoption-catalog.ts`), so a service cannot be in
the catalog without the scanner looking for it. `scripts/ci/check-adoption-catalog-sync.mjs`
fails the build if any code hard-codes a second list.

| Family | Services scanned |
| --- | --- |
| Governance | Purview |
| Analytics | Synapse, Azure Data Explorer, Databricks, Azure ML |
| Storage | Storage / ADLS Gen2 |
| Database | Cosmos DB, PostgreSQL Flexible Server, Azure SQL |
| AI | AI Foundry / Azure OpenAI, AI Search |
| Streaming | Event Hubs, Stream Analytics |
| Integration | Data Factory, API Management, Azure Maps |
| Platform | Log Analytics, Container Registry, Key Vault* |
| Networking | Virtual Network, Private DNS zone, Firewall policy, Azure Firewall* |

\* Key Vault and the Azure Firewall *instance* are discovered for reporting but
are never offered for adoption — see [§5](#5-what-loom-will-never-adopt-and-why).

---

## 2. The part that matters most: coverage

**A scan that could not read a subscription must never look like a scan that
read it and found nothing.** Those two states lead to opposite operator
actions, and Azure makes it easy to confuse them.

Measured against the live Resource Graph REST API (`api-version=2022-10-01`) on
2026-08-05:

> Pass Resource Graph a `subscriptions` array containing one subscription you
> can read and one you cannot, and it returns **HTTP 200 with rows for the
> readable one and no indication whatsoever that the other was skipped**.
> `allowPartialScopes: true` does not change this. Only when *every* requested
> scope is ineligible does it fail, with
> `BadRequest / NoValidSubscriptionsInQueryRequest`.

So a coverage report derived from the query's own results is untrue by
construction. Ask for 12 subscriptions, be unable to read 3, and those 3 look
exactly like "scanned, nothing found".

Loom therefore establishes coverage independently, in three steps:

1. **`GET /subscriptions`** — what this identity can see at all. A requested
   subscription absent from that list is `no-access`.
2. **A Resource Graph coverage probe** over `ResourceContainers` — which of
   those Resource Graph will *actually* read. It returns a row per readable
   subscription **including subscriptions that contain zero resources**, which
   is what lets a genuinely empty greenfield subscription be distinguished from
   an unreadable one. A requested, ARM-visible subscription missing here is
   `no-access`.
3. **The inventory query**, scoped to exactly the subscriptions step 2 proved
   readable — so nothing can be dropped silently.

### The ledger

The response carries one entry per **requested** subscription:

| Field | Meaning |
| --- | --- |
| `status` | `scanned` · `no-access` · `truncated` · `not-requested` |
| `matchedResources` | how many adoption candidates were found there |
| `credentialTier` | `user` (your delegated token) or `uami` (the Console identity) |
| `established` | **what the code actually observed to produce that status** |

`status: 'scanned'` with `matchedResources: 0` is a real and *different* answer
from `status: 'no-access'`. The summary line never merges them:

```
Requested 5 subscriptions. Read 4 of them, 4 containing something Loom could
adopt. 1 could NOT be read — those are unknown, not empty. Anything you own
there will not appear below.
```

Every `no-access` entry says how it was established, for example:

```
ARM GET /subscriptions did not return this subscription for the signed-in operator
```
```
ARM lists this subscription, but Azure Resource Graph did not return its
container row when explicitly scoped to it — Resource Graph cannot read it
with this identity
```

### When nothing at all could be read

The scan returns `ok: false` with `code: 'no_access'` (or `'arg_error'`) and a
message that says **the scan could not look** — never that your estate is
empty — plus an `established` field naming the failure per credential tier.

---

## 3. Which identity does the looking

| Tier | Credential | Used when |
| --- | --- | --- |
| 1 | the signed-in operator's delegated ARM token | always tried first |
| 2 | the Console user-assigned managed identity | tier 1 unavailable or saw nothing |

Tier 1 first is deliberate. At first run you are typically Owner across the
estate while the Console managed identity may not exist yet, let alone hold
Reader anywhere. The tier that answered is reported **per subscription**, so a
narrow result can be explained rather than mistaken for a bare estate: a
subscription answered on tier 2 is showing you what *Loom* can see, which may be
less than what you can see.

### Permissions you need

| Need | Scope | Who | If absent |
| --- | --- | --- | --- |
| `Microsoft.Resources/subscriptions/read` | tenant | you | the subscription is not offered as a scan target |
| `Reader` | each scanned subscription | you (tier 1) | that subscription reports `no-access` **by name** |
| `Reader` | each scanned subscription | Console UAMI (tier 2) | tier 2 sees less; reported per subscription |

No tenant-root or management-group Reader grant is required, and Loom does not
ask for one.

---

## 4. What comes back per service

For every catalog service — including ones with no candidates, so greenfield
renders the same shape:

| Field | Meaning |
| --- | --- |
| `candidates[]` | what was found: name, RG, subscription, region, SKU, network posture, private-endpoint count, HNS (storage), tags |
| `recommendation` | `adopt` · `create` · `adopt-required` |
| `recommendationReason` | a sentence, always present |
| `usedFor` | what Loom uses this service for |
| `mutations[]` | **what Loom would CHANGE about an adopted instance** |
| `noCandidateOutcome` | `none-exist` · `could-not-look` · `not-adoptable` |
| `uncertain` | true when "nothing found" is not a conclusion |

### `mutations` — read this before you adopt

Adoption is not passive. Each service declares what Loom does to it, and the
review step renders it verbatim. For example, adopting a Databricks workspace:

- assigns the workspace to a Unity Catalog metastore
- creates a SCIM service principal for Loom
- creates a SQL warehouse
- creates Loom catalogs / schemas in Unity Catalog

If that is not acceptable for a given production workspace, choose *create*.

### How the recommendation is decided

Deliberately decisive rather than heuristic:

- **`adopt-required`** — the service is a tenant singleton and one exists.
  Purview is the case, and it is capped **two** independent ways:

  | Cap | Scope | What ARM says when you hit it |
  | --- | --- | --- |
  | One **Enterprise-tier** account | per tenant | `EnterpriseTenantAlreadyExists` |
  | **5 accounts** | per tenant, **per region** | `2005 - The Tenant … with 5 resources has surpassed its resource quota 5 for resource type Account in <region> location` |

  Either way "create new" is not offered and then failed twenty minutes into a
  deploy — it is disabled with the reason.

  The second cap is the one that matters most in a sovereign boundary, and it
  was measured the hard way: `deploy-gov.yml` run 31917112453 was refused at
  preflight in `usgovvirginia` because the tenant already had five. A Gov tenant
  that already runs Purview is the normal case, so on that path "create a new
  one" was closer to always-broken than occasionally-broken. See
  [Azure Government](#azure-government) below.
- **`adopt`** — exactly one candidate, in the hub region.
- **`create`** — everything else. One candidate in the *wrong* region says so
  and names both regions. Several candidates says so and does not guess: picking
  among ambiguous instances in someone else's production estate is worse than
  deploying a clean one.

### Network posture

Derived from what the resource actually reports, using the same rules as the
day-2 attach preflight:

| Posture | Derived from |
| --- | --- |
| `private-endpoint` | `publicNetworkAccess: Disabled`, or private-endpoint connections present with no other signal |
| `service-endpoint` | `networkAcls.defaultAction: Deny` |
| `public` | `publicNetworkAccess: Enabled` |
| `unknown` | the resource platform reports neither |

`unknown` is a real answer and is never rendered as `public`. Guessing "public"
would let an unreachable resource be recommended and then fail at the first
data-plane call instead of at planning time.

Likewise storage: an *absent* `isHnsEnabled` is reported as unknown, not
`false`. Hierarchical namespace can only be set at account creation, so a wrong
`false` would reject an account that may in fact be usable.

---

## 5. What Loom will never adopt, and why

These are decisions, not gaps. Each is rendered to you with its reason.

| Not adoptable | Why |
| --- | --- |
| **Key Vault** (as the platform vault) | Loom's vault is the trust root for the MSAL secret, data-plane credentials and cosign material. `enableSoftDelete` / `enablePurgeProtection` are one-way and cannot be turned on retroactively in a way Loom can guarantee, and adoption would mean Loom writing platform secrets into a vault whose access policies and network ACLs a third party mutates. |
| **Azure Firewall instance** | Rule-collection-group priority bands collide destructively with no safe merge — Loom cannot know which of your collections it may renumber. Loom adopts the firewall **policy** by resource id instead, adding its own uniquely-named rule-collection group in a reserved priority band, and deploys its own firewall instance. |

Resources of these types are still *discovered* — you can see them — but they
are never offered as a choice, because offering a choice that does not exist is
worse than explaining why.

---

## 6. Limitations, stated

- **Management-group scoping is not implemented.** Resource Graph accepts a
  `managementGroups` scope, but the coverage ledger is subscription-keyed and
  expanding a group to its subscriptions is a separate path. The route
  **rejects** a management-group scope explicitly rather than silently scanning
  something else.
- **Networking candidates are reported as a flat list.** A VNet, DNS zone or
  firewall policy is adopted per instance and per zone name, not one-of-N, so
  the recommendation for those rows is coarse; the per-zone decision belongs to
  the deployment plan, not to discovery.
- **Truncation is estate-wide, not per subscription.** If the scan hits its
  paging budget, Resource Graph gives no way to attribute the shortfall to a
  particular subscription — so **every** scanned subscription is reported
  `truncated` rather than one of them being silently credited with a complete
  read. Every service with no candidate then reports `could-not-look`, not
  `none-exist`.
- **Fitness is not evaluated here.** Discovery answers *does it exist*. Whether
  an existing resource is *usable* — SKU, region, reachability from the Console
  subnet, and the RBAC the deploy identity holds or can grant — belongs to the
  deployment plan's validation step.
  **The blocking gate is now wired; the evaluator is not (#3014, merged, not
  deployed):** `POST /api/setup/deploy` calls `assertPlanIsDeployable()` before
  ANY deploy tier fires — a plan whose adopt decision carries an `unusable` or
  `unknown` fitness verdict is refused with 422 and the observed blocking
  checks, and structurally incoherent plans (adopt of a create-only service, a
  second tenant-singleton, a missing coordinate) are refused with 400. What
  still has no production producer is `evaluateFitness()` itself: no route yet
  reads the live resource and attaches a verdict to the plan, so an adoption
  nobody evaluated passes the gate un-checked (deliberately — refusing every
  un-evaluated adoption would dead-end brownfield). Until the evaluator lands,
  run the checks in §Step 4 of the brownfield walkthrough by hand for anything
  you adopt.

---

## 6a. Verification status (`deploy-integrity.md` R4)

| Cloud | Status |
|---|---|
| **Azure Commercial** | **Verified.** The coverage behaviours in §2 were measured against the live Commercial Resource Graph REST API (`api-version=2022-10-01`) on 2026-08-05: `options.top` returning 1000 for `{"top":5}`, `resultTruncated` staying `false` while a `$skipToken` is outstanding, and a 4-readable + 1-unreadable scope set returning HTTP 200 with four rows and no field naming the dropped scope. The receipt harness in §7 re-runs them. |
| **Azure Government** | **Not verified.** Gov is never scanned from a workstation and no Actions-hosted run of the discovery harness against a Gov tenant has been performed. The code is boundary-agnostic (it reads the ARM host from the cloud config), but that is an argument, not a measurement. |

---

## 7. Verifying the scan yourself

A live receipt harness runs the shipped scanner against a real tenant. CI never
runs it, and it fails rather than skips without a token, so a green run always
means Azure answered:

```bash
cd apps/fiab-console
export LOOM_LIVE_ARM_TOKEN="$(az account get-access-token \
    --resource https://management.azure.com --query accessToken -o tsv)"
node_modules/.bin/vitest run --config vitest.live.config.ts
```

It prints the coverage ledger and the per-service candidate counts, and asserts
that a subscription it cannot read is reported `no-access` rather than
scanned-with-zero.

Azure Government is never scanned from a workstation. Gov verification runs
through GitHub Actions.

---

## 8. Where the code lives

| Path | Role |
| --- | --- |
| `apps/fiab-console/lib/deploy/adoption-catalog.ts` | the one catalog: ARM types, classes, roles, `usedFor`, `mutations` |
| `apps/fiab-console/lib/deploy/discovery-model.ts` | pure: query generation, row mapping, recommendations, the coverage summary |
| `apps/fiab-console/lib/deploy/discovery-scanner.ts` | the three-step scan and the credential ladder |
| `apps/fiab-console/app/api/deploy/discovery/route.ts` | the BFF route |
| `scripts/ci/check-adoption-catalog-sync.mjs` | pins catalog names to `main.bicep` |
| `apps/fiab-console/scripts/live/discovery.live.ts` | the live-Azure receipt |
| `apps/fiab-console/lib/deploy/plan-model.ts` | the adopt-or-create plan type + validation |
| `apps/fiab-console/lib/deploy/plan-to-arm.ts` | the ONE serializer that turns a plan into the `adopt` ARM parameter |
| `apps/fiab-console/lib/deploy/fitness.ts` | the family fitness checks a candidate must pass |
| `scripts/ci/check-fitness-messages.mjs` | pins every fitness message to something observed |

---

## 9. What Loom changes about an adopted resource

Adoption is not read-only. Before you adopt a production resource, know what
Loom will do to it. Every row below is the `mutations` field of
`adoption-catalog.ts` — the same strings the review step renders verbatim.

| Service | What Loom changes | Role it needs |
|---|---|---|
| **AI Search** | Creates up to four indexes; enables Entra (AAD) authentication on the service | Search Service Contributor + Search Index Data Contributor |
| **APIM** | Publishes Loom's API products and policies | API Management Service Contributor |
| **ADX / Kusto** | Creates a database; enables streaming ingestion; adds an `AllDatabasesAdmin` principal assignment | Contributor (+ AllDatabasesAdmin) |
| **AI Foundry / AOAI** | Reads existing deployments; creates none. Loom **requires** a chat deployment and an embedding deployment to already exist | Cognitive Services Contributor |
| **Purview** | Registers data sources; creates collections; writes classifications and lineage; runs scans | Data Source Administrator + Data Curator (granted in the **Purview portal**, not by ARM) |
| **Azure Maps** | Reads the account key; creates nothing | Contributor |
| **Synapse** | Sets the Console managed identity as a **workspace SQL administrator**; creates Spark pools if the workload tiers are enabled | Contributor + Synapse Administrator (data plane) |
| **Cosmos** | Creates Loom's containers in the account. **Check for name collisions first** | DocumentDB Account Contributor + the Built-in Data Contributor data-plane role |
| **Data Factory** | Creates Loom's pipelines and linked services in the factory | Data Factory Contributor |
| **Event Hubs** | Creates hubs and consumer groups; grants the ADX cluster receive rights | Event Hubs Data Owner + Contributor |
| **Stream Analytics** | **Edits the job's query and inputs/outputs.** Adopting a *running* production job is destructive — stop it or use a different job | Contributor |
| **Databricks** | **Assigns the workspace to a Unity Catalog metastore**; creates a SCIM service principal for the Console; creates a SQL warehouse | Contributor |
| **Azure SQL (plan backing)** | Reads only — Loom never writes schema to it | per-server Entra admin |

### Granting the roles

```bash
# Reads the same EXISTING_* names and grants at the adopted resource's own
# subscription scope.
bash scripts/csa-loom/grant-navigator-rbac.sh
```

Two things to know:

1. **`_RG` is mandatory for a cross-resource-group or cross-subscription grant.**
   With only `EXISTING_<SVC>` set and no `_RG`, the script prints
   `set its _RG to grant cross-RG/sub — skipping` and grants nothing.
2. **Coverage is seven services**: Event Hubs, Cosmos, AI Search, AOAI, APIM,
   Synapse and Data Factory. **ADX/Kusto, Databricks, Stream Analytics and Maps
   are not covered** — grant those manually using the role in the table above.
   Purview's roles are data-plane and are granted in the Purview portal.

---

## 10. Supplying values by hand

Discovery is a convenience, not a requirement. You never need the scan to have
found something in order to adopt it — but note that **`main.bicep` no longer
declares 36 `existing*` scalar parameters.** It declares ONE `adopt` object
keyed by the service key, because ARM caps a template at 256 parameters and
`main.bicep` was at 251/256; a name/resource-group/subscription triple could not
be added for even one more service.

There are two supported ways in, and they compose:

**1. The `EXISTING_*` environment variables** (unchanged, and still the simplest).
The boundary `.bicepparam` files read them and fold them into the plan:

```bash
export EXISTING_AI_SEARCH_SERVICE=corp-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
export EXISTING_AI_SEARCH_SUB=<sub-id>
az deployment sub create -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam
```

**2. `LOOM_ADOPT_JSON`, or a generated `.bicepparam`** — the whole plan as one
document, produced by `planToArmParameters()` in `lib/deploy/plan-to-arm.ts`.
Every deploy tier uses that one serializer, so the wizard, the copy-paste `az`
command, `byo-wizard.sh` and `scan-and-deploy.sh` all emit the identical shape:

```bicep
param adopt = {
  purview: { mode: 'adopt', target: { name: 'corp-purview', rg: 'rg-gov', sub: '<sub-id>' } }
  aisearch: { mode: 'create' }
}
```

An explicit plan wins over the legacy environment reads, and an **absent key
means create-new** — so a pure-greenfield deploy emits no `adopt` assignment at
all and `adoptMode()` defaults every service to `create`.

| Environment variable | Plan key / `extra` field | Suppresses creation? |
|---|---|---|
| `EXISTING_AI_SEARCH_SERVICE` / `_RG` / `_SUB` | `aisearch` | yes |
| `EXISTING_APIM` / `_RG` / `_SUB` | `apim` | yes |
| `EXISTING_KUSTO_CLUSTER` / `_RG` / `_SUB` | `adx` | yes |
| `EXISTING_AOAI` / `_RG` / `_SUB` / `_CHAT_DEPLOYMENT` / `_EMBED_DEPLOYMENT` | `foundry` (+ `extra.chatDeployment` / `extra.embedDeployment`) | hub account yes; **agent project no** |
| `EXISTING_EVENTHUB_NAMESPACE` / `_RG` / `_SUB` | `eventhubs` | yes |
| `EXISTING_ASA_JOB` / `_RG` / `_SUB` | `streamanalytics` | yes |
| `EXISTING_COSMOS_ACCOUNT` / `_RG` / `_SUB` | `cosmos` | yes |
| `EXISTING_PURVIEW` / `_RG` / `_SUB` | `purview` | yes — `provisionPurview` now gates creation |
| `EXISTING_SYNAPSE` / `_RG` / `_SUB` | `synapse` | yes — `provisionSynapse` |
| `EXISTING_DATABRICKS` / `_RG` / `_SUB` / `_HOSTNAME` | `databricks` (+ `extra.hostname`) | yes — `provisionDatabricks` |
| `EXISTING_ADF` / `_RG` / `_SUB` | `adf` | yes — `provisionAdf` |
| `EXISTING_AZURE_MAPS_ACCOUNT` / `_RG` / `_SUB` | `maps` | yes — `provisionMaps` |
| `EXISTING_AML_WORKSPACE` / `_RG` / `_SUB` | `aml` | yes — `provisionAml` |
| *(none)* | `loomPlanBackingSqlServer` / `loomSqlServerRg` | adopt-only by design |

The `_SUB` value also flows into a `LOOM_<SVC>_SUB` Console environment variable
that the matching client reads at runtime, falling back to
`LOOM_SUBSCRIPTION_ID` when empty. Purview is the exception: its data plane is
reached by account host name and a portal-granted role, so it is
subscription-agnostic and has no `LOOM_PURVIEW_SUB` wire.

> **This closes the old class A / class B split.** Previously, naming an
> existing Purview/Synapse/Databricks/ADF/Maps did **not** suppress creation —
> you had to *also* set `purviewEnabled=false` and remember which flag went with
> which service, or Loom deployed a second one alongside yours. Every adoptable
> service now has a `provision<Service>` variable that is `false` whenever the
> plan says `adopt`.

### Azure Government

Everything above describes `platform/fiab/bicep/main.bicep`, the **Commercial**
orchestrator. Azure Government has a second one — `deploy/bicep/gov/main.bicep`,
which `deploy-gov.yml` submits — and it speaks the **same `adopt` bag**, keyed by
the same service keys, so a plan produced for one is understood by the other with
no translation.

It did not always. Until #3577 the Gov orchestrator created a Purview account on
`= if (deployDMLZ)` with no adopt path at all, so both halves of R5's prohibition
were live in one line: had quota allowed it would have deployed a sixth account
beside the customer's five, and because quota did not allow, it failed because
five exist. `scripts/ci/check-adoption-catalog-sync.mjs` now reads **both**
orchestrators — its population was one file while the repo had two.

Coverage today is **Purview only** on the Gov path. The other services that
orchestrator deploys (Synapse, Databricks, ADF, Event Hubs, ADX, storage) still
create unconditionally there. That is a real R5 gap and it is tracked, not
implied fixed — it is simply not deploy-blocking, because none of them carries a
per-tenant cap the way Purview does.

#### Greenfield (empty Gov subscription)

Nothing to do. Discovery finds no Purview account, emits an **empty plan**, and
`adoptMode()` defaults the key to `create` exactly as before. The greenfield path
is byte-identical to its pre-#3577 behaviour.

#### Brownfield (a tenant that already runs Purview)

Also nothing to do — this is the point. Dispatch `deploy-gov.yml` and leave
`purview_account` blank:

1. **Discover** — `scripts/csa-loom/discover-purview-adopt-plan.sh` enumerates
   `Microsoft.Purview/accounts` across every subscription the deployment identity
   can read, using core `az resource list` (no CLI extension, no Resource Graph).
2. **Present** — every candidate is printed with its region and subscription,
   followed by what Loom would *change* about an adopted account. That list is
   kept in step with the catalog's `mutations` array, so the operator reads it
   **before** the deploy.
3. **Choose** — an in-region account is preferred; failing that a cross-region
   one, with the crossing disclosed (Purview's Data Map is reached by account
   host, so cross-region works). The choice is **name-sorted**, not ARM list
   order, so two runs over the same estate bind the same account.
4. **Validate** — existence and real region are read from ARM. The template then
   binds through `modules/purview-existing.bicep`, a read-only `existing`
   reference that writes nothing to a resource Loom does not own.
5. **Record** — the deployment outputs carry `purviewBindingMode`
   (`created` / `adopted` / `none`), `purviewAccountName`, `purviewAccountId` and
   `purviewAccountLocation`, so the binding is inspectable rather than inferred.

| Want | Set |
| --- | --- |
| Discover and adopt automatically | `purview_account` blank *(default)* |
| Bind a specific account | `purview_account = <name>` (+ `purview_account_rg` if it is outside the readable subscriptions) |
| Force a brand-new account | `purview_account = NEW` |

#### When it cannot succeed

Asking for a new account in a region already holding five fails **before** ARM is
called, with the region, the count, the limit, and the two real options — adopt
one of the accounts it just listed, or raise the cap / pick another region.

If the quota is consumed by accounts the deployment identity cannot *read*, the
script says exactly that: its count is labelled a **lower bound**, not a tenant
total, and it proceeds rather than asserting room it did not measure. ARM then
refuses, and that refusal now classifies as `quota` — signal
`quota.tenant-resource-quota` — carrying the same remediation. Before #3577 it
classified as `defect` / not-remediable and told the operator to rebuild a
template that was perfectly valid.

---

## 11. Where the estate view lives

Discovery output is consumed inside the setup wizard and, once you confirm a
plan, **persisted** — `lib/deploy/plan-store.ts` writes it so every deploy
transport carries the same plan rather than only the copy-paste `az` fallback.

The `/admin/*` surfaces still show Loom's *own* resources
(`/admin/capacity`, `/admin/network`, `/admin/domains`) and its configuration
readiness (`/admin/readiness`, `/admin/gates`) — **not** the wider estate. A
dedicated `/admin/deployment` estate view showing the applied plan, its diff
against live, and each deploy path's last successful run is **not on this
branch**; the CLI inventory in §7 is the estate view until it lands.

---

## Next

- [**Brownfield deployment**](brownfield.md) — the walkthrough this reference supports
- [**Greenfield deployment**](greenfield.md)
- [**Failure recovery**](failure-recovery.md) — what to do when an adoption fails
- [**Bring-your-own services**](../bring-your-own-services.md) — the original reuse reference

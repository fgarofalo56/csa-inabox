# Multi-subscription discovery — what Loom finds, and what it will not claim

**Audience:** whoever runs the deployment.
**Applies to:** brownfield *and* greenfield. Greenfield is simply the case where
discovery finds nothing to adopt — and that is a conclusion the scan is careful
to earn rather than assume.

Related: [Bring your own services](../bring-your-own-services.md)

> The end-to-end greenfield and brownfield walkthroughs
> (`greenfield.md` / `brownfield.md`) are being written in a separate change and
> are **not** in the docs tree yet. This page is deliberately self-contained
> until they land, and does not link to them.

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
  Purview is the case: Azure permits one Enterprise Purview account per tenant
  and deploying a second fails at ARM with `EnterpriseTenantAlreadyExists`. So
  "create new" is not offered and then failed twenty minutes into a deploy — it
  is disabled with the reason.
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
  subnet, and the RBAC the deploy identity holds or can grant — is the
  validation step of the plan, not of the scan.

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

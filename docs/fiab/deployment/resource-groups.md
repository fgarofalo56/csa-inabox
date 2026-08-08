# Resource-group layout, naming and tags

This page is the reference both deployment walkthroughs point at. It covers what
resource groups a CSA Loom deploy creates, why their names are a **contract**
rather than a convention, what tags land on them, and what the planned CAF
function-RG split (**t169**) would change — including the fact that it is **not
built**.

Read it before you size RBAC scopes, write Azure Policy assignments, or plan a
teardown. It applies identically to
[greenfield](greenfield.md) and [brownfield](brownfield.md).

## Per-cloud status

| Cloud | Layout |
|---|---|
| **Azure Commercial** | As documented below. Measured from `platform/fiab/bicep/main.bicep` on 2026-08-08 |
| **GCC** (M365 GCC identity over Azure Public) | Identical — same template, same names, `gcc.bicepparam` differs only in SKUs and feature flags |
| **GCC-High / IL4** | Identical names; the admin plane hosts **AKS** instead of a Container Apps Environment |
| **DoD IL5** | Identical names by template. **Never deployed** — `deploy-fiab-il5.yml` has no run history, so this is read from the template, not from an estate |

---

## The two resource groups a deploy creates

A Loom deploy stamps **one resource group for the admin plane (hub)** and **one
per Data Landing Zone**. There is no finer split today — see
[t169](#not-built-the-caf-function-rg-split-t169).

| Resource group | Name pattern | Constructed at |
|---|---|---|
| Admin Plane (hub) | `rg-csa-loom-admin-<location>` | `main.bicep`, `var adminPlaneRgName` |
| Data Landing Zone — named domain | `rg-csa-loom-dlz-<domain>-<location>` | `main.bicep`, the multi-DLZ loop and every cross-scope `resourceGroup(subId, …)` reference |
| Data Landing Zone — single-sub | `rg-csa-loom-dlz-single-<location>` | `main.bicep`, `resource singleDlzRg` |
| DLZ being attached (`topology=dlz-attach`) | `rg-csa-loom-dlz-<attachDomainName>-<location>` | `main.bicep`, the attach branch |

`<location>` is the Azure region short name (`centralus`, `eastus2`,
`usgovvirginia`, …). `<domain>` is the landing-zone domain name you supply. So a
two-domain Commercial estate in `eastus2` has `rg-csa-loom-admin-eastus2`,
`rg-csa-loom-dlz-finance-eastus2` and `rg-csa-loom-dlz-hr-eastus2`.

Re-measure rather than trusting the table — line numbers drift every time the
template grows:

```bash
grep -n "rg-csa-loom-admin-\|rg-csa-loom-dlz-" platform/fiab/bicep/main.bicep
```

> **The names are a contract.** Bicep modules resolve cross-scope references by
> **constructing these strings** — `resourceGroup(subId, 'rg-csa-loom-dlz-…')` —
> rather than by passing a resource id. Renaming a resource group out of band
> therefore does not "rename" anything; it makes the next deploy target a group
> that does not exist and fail `ResourceGroupNotFound`. The only supported
> override is `hubCoordinates.adminPlaneRgName`, and only on a hub-attach where
> `deployAdminPlane` is false.

### The `single` / `default` trap — read this before you construct a name by hand

**The RG's domain segment and the workspaces' domain segment are not the same
string.** In the single-subscription branch the template creates the resource
group `rg-csa-loom-dlz-single-<location>` while passing `domainName: 'default'`
into the landing-zone module — so the workspaces inside it are named
`syn-loom-default-<location>`, `adb-loom-default-<location>`,
`evhns-loom-default-<location>`.

That mismatch is not cosmetic. It is what broke the post-deploy bootstrap:

- `dlz_domain` used to **default to `single`**, so the bootstrap constructed
  `rg-csa-loom-dlz-single-<region>` on every estate.
- On a multi-subscription estate the real group is
  `rg-csa-loom-dlz-default-<region>` — in a **different subscription**.
- Measured on run `31243230253`: **25 of 27 jobs green**, then
  `(ResourceGroupNotFound)`. Every image and every Container App had already
  deployed; only the day-one wiring died.

The fix — PR **#3140**, merged 2026-08-08 — removed the default and made the
bootstrap **discover** the landing zone from Azure Resource Graph across every
subscription the deploy identity can read. **Do not construct a DLZ resource
group name by hand.** Let discovery find it, and supply `dlz_domain` /
`dlz_subscription` only to disambiguate an estate that genuinely has several.

> **Citation warning.** Comments in `csa-loom-post-deploy-bootstrap.yml`, the
> four `deploy-fiab-*.yml` lanes and `full-app-deploy-commercial.yml` attribute
> this fix to **`#3143`**. That number was **never allocated to this work** — it
> was a forward reference to an issue that was not created, and GitHub has since
> assigned `#3143` to an unrelated pull request. **The fix is PR #3140.** Read
> any in-repo `#3143` in a deploy workflow as "the DLZ-discovery fix, PR #3140".

> **Consequence worth stating plainly:** because `dlz_domain` defaulted to a
> value that is wrong on every non-single-sub estate, the deploy's day-one
> wiring — MSAL app registration, Purview roles, Synapse SQL grants, Databricks
> SCIM, the Spark private-endpoint fix — **never ran as part of a deploy on a
> multi-subscription estate** until #3140. If you deployed one before that and
> never ran `csa-loom-post-deploy-bootstrap.yml` by hand, those grants are
> absent. Run it standalone; it is idempotent.

---

## What lives in each group

| Plane | Contents |
|---|---|
| **Admin Plane** — `rg-csa-loom-admin-<location>` | hub VNet + subnets + NSGs, Private DNS zones, Azure Firewall (optional), Key Vault, ACR, Container Apps Environment (AKS in IL5), Log Analytics + App Insights, AI Search, AI Foundry / AOAI, APIM, ADX, Purview (optional), Azure Maps (Commercial/GCC), Cosmos (Console metadata), the Console and its sibling Container Apps |
| **Data Landing Zone** — `rg-csa-loom-dlz-<domain>-<location>` | spoke VNet, ADLS Gen2 lake (HNS), Databricks Premium + Unity Catalog, Synapse (Serverless + Spark), Event Hubs, Stream Analytics, Data Factory, ADX database, Cosmos, and the parity services |

Key Vault, the Container Apps Environment and the Azure Firewall instance are
**always created new** and are never adopted — the reasons are per-resource and
are given in
[Brownfield → what Loom will not adopt](brownfield.md#what-loom-will-not-adopt-and-why).

---

## Tags

Every resource group carries the `complianceTags` object. It is a **required
parameter with no default** (`main.bicep`, `param complianceTags object`) and is
applied at each resource-group resource as well as threaded into the admin-plane
and DLZ modules, so it propagates to the resources inside.

Each boundary parameter file supplies it. Commercial
(`platform/fiab/bicep/params/commercial-full.bicepparam`):

```bicep
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
```

GCC-High (`gcc-high.bicepparam`) adds `DISA_IL: 'IL4'`,
`Data_Classification: 'CUI'` and `M365_Boundary: 'GCC-High'`.

**Add your own CAF tags — cost centre, owner, application, criticality — to that
block.** They propagate to every resource group the deploy creates. There is no
separate "customer tags" parameter; this is the extension point.

---

## The teardown blast radius keys off the `rg-csa-loom-` prefix

`deploy-fiab-commercial.yml` in `run_mode=full` with `keep_resources=false`
enumerates `rg-csa-loom-*` **across the whole subscription** and deletes every
match, then purges the Key Vaults and Cognitive Services accounts it finds.

Two consequences that follow directly from the naming contract:

1. **Anything you name with that prefix is in the blast radius** — including a
   resource group Loom did not create.
2. **Anything Loom needs that you name differently is outside the deploy's
   reach** — it will not be torn down, and it will not be reconciled either.

Since **#3028** that path is no longer reachable by accident: `keep_resources`
defaults to `true`, and a teardown additionally requires `confirm_teardown_rg`
to equal the resolved admin resource group (`rg-csa-loom-admin-<region>`)
**exactly**. A run whose inputs would tear down without that typed confirmation
is refused by the `Deploy input safety gate` step before anything reaches ARM.

Deliberate teardown of a disposable validation subscription is therefore:

```bash
gh workflow run deploy-fiab-commercial.yml \
  -f run_mode=full \
  -f region=<region> \
  -f keep_resources=false \
  -f confirm_teardown_rg=rg-csa-loom-admin-<region>
```

---

## Not built: the CAF function-RG split (t169)

A planned re-layout — plan item **t169** in
`docs/fiab/prp/audit-wave13b-deploy-unblock.md` — would split the admin mega-RG
into function resource groups and give each DLZ tiered groups:

| Proposed | Groups |
|---|---|
| Admin plane split | `rg-loom-console` · `rg-loom-network` · `rg-loom-shared-data` · `rg-loom-governance` · `rg-loom-observability` · `rg-loom-ai` |
| Per-DLZ tiers | `-core` · `-compute` · `-storage` · `-streaming` |
| Plus | CAF naming and tags on every group; module scopes realigned to the new groups |

**It is not built.** Measured 2026-08-08:

```bash
grep -rn "rg-loom-console\|rg-loom-network\|rg-loom-shared-data\|rg-loom-governance\|rg-loom-observability" \
  --include=*.bicep --include=*.md .
```

returns only the plan item and this page's own text — **no bicep hit at all**.
The admin plane is one resource group and each DLZ is one resource group, as
tabulated above.

This is stated so you size RBAC and Azure Policy scoping against what deploys
**today**, not against the plan. Concretely: you cannot grant an operator
`Contributor` on observability without also granting it on the Console, the
network and the AI resources, because they share a resource group. If your
governance model requires finer resource-group boundaries, that constraint is
real and current.

t169 is tracked as forward work (FINISHLINE `C11`), and is sequenced **after**
t166 in the plan because both touch `main.bicep` heavily.

---

## Related

- [**Greenfield deployment**](greenfield.md) — empty subscription to working Console
- [**Brownfield deployment**](brownfield.md) — adopting existing infrastructure
- [**Failure recovery**](failure-recovery.md) — `ResourceGroupNotFound` and the rest of the taxonomy
- [**Multi-subscription / multi-tenant**](multi-sub-multi-tenant.md)

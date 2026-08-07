# Greenfield deployment — empty subscription to working Console

**Greenfield** means: the target subscription contains no Azure resource CSA
Loom would adopt, and no existing `rg-csa-loom-admin-*` hub. Every backing
service is deployed new.

If your tenant already contains a Purview account, a shared AI Search service,
an existing VNet, or a previous Loom hub, you are on the
[**brownfield path**](brownfield.md) — read that instead. Greenfield working
proves nothing about brownfield, and the two are verified independently
(`deploy-integrity.md` R4).

> **How to tell without guessing.** Run the read-only inventory in
> [Discovery and adoption](discovery-and-adoption.md#7-verifying-the-scan-yourself).
> If it returns no candidates in any subscription you intend to use, you are
> greenfield.

## Verification status (`deploy-integrity.md` R4)

R4 requires each cloud to be verified independently. This page states where that
has happened and where it has not.

| Cloud | Status of this walkthrough |
|---|---|
| **Azure Commercial** | **Verified in part.** The three-phase path is the one CI exercises: `full-app-deploy-commercial.yml` and `deploy-fiab-commercial.yml` both run regularly (most recent runs include failures — check `gh run list` before assuming the lane is healthy). Template validation passes for `commercial-full.bicepparam`. **A from-scratch phase-1 → phase-2 → phase-3 run into a clean, empty subscription has not been performed for this revision of the doc.** |
| **Azure Government — GCC-High / IL4** | **Not verified for this revision.** `deploy-fiab-gcch.yml` exists and runs, but its three most recent runs all ended `failure` (2026-08-01, -02, -03). The workflow-input semantics below are read from the workflow definition, not from a successful run. |
| **DoD IL5** | **Never executed.** `gh run list --workflow deploy-fiab-il5.yml` returns nothing. |
| **Gov image build** | **Never executed.** `gh run list --workflow gov-build-images.yml` returns nothing. |

Where a step below has never been run, it says so inline. Do not read the
absence of a warning as a claim of success — read the table above.

---

## The shape of a greenfield deploy

CSA Loom ships as infrastructure-as-code and deploys in **three phases**. The
phase split is not optional and it is not a workaround — it is a consequence of
the container registry being created empty by the same deployment that needs to
pull from it.

<div class="grid cards" markdown>

-   :material-cube-outline: **Phase 1 — Infrastructure**

    `az deployment sub create` with `deployAppsEnabled=false`. Creates the hub
    VNet, Private DNS zones, ACR, Container Apps Environment, Key Vault, and
    every Azure backing service. **Creates no Container Apps.**

-   :material-docker: **Phase 2 — Images + apps**

    A workflow opens the private ACR, builds every app image server-side with
    `az acr build`, re-locks the registry, then brings the Container Apps up
    pointing at the images it just pushed.

-   :material-key-chain: **Phase 3 — Post-deploy bootstrap**

    The one-time grants Bicep cannot make: the MSAL app registration + admin
    consent, Synapse SQL admin, Purview roles, Databricks SCIM, the Spark
    private-endpoint fix. **Sign-in does not work until this runs.**

</div>

> **Why phase 1 must set `deployAppsEnabled=false`.** A fresh deploy creates an
> **empty** ACR. The Console and its sibling Container Apps reference
> `<newacr>.azurecr.io/loom-console:<tag>`. With `deployAppsEnabled=true` on a
> brand-new registry, ARM tries to create those apps before any image exists and
> the deploy fails with a manifest/pull error. That failure is **expected, not a
> bug** — the image build is a required phase. Every parameter file sets
> `deployAppsEnabled = true` for the steady-state case, so phase 1 overrides it
> on the command line.

---

## Prerequisites

| Item | How to verify |
|---|---|
| Azure subscription with **Owner** + **User Access Administrator** (the deploy writes RBAC role assignments) | `az role assignment list --assignee <upn> --scope /subscriptions/<sub-id> -o table` |
| Rights to **create an Entra group** in your tenant | `az ad signed-in-user show` |
| A **Global Administrator** (or Privileged Role Administrator) available for phase 3 — this is often a *second person* | — |
| `az` CLI ≥ 2.60 | `az --version` · `az bicep version` |
| A free `/16` for the hub (default `10.0.0.0/16`) — on a genuinely empty subscription this is free by definition | `az network vnet list -o table` |
| Regional quota for a **Databricks Premium** workspace and the Container Apps / ACR-task VM families | `az vm list-usage -l <region> -o table` |
| Azure OpenAI quota in the target region | Portal → Quotas |

> **No Microsoft Fabric and no Power BI Premium is required.** Loom is
> Azure-native by default; Fabric and Power BI are strictly opt-in
> (`no-fabric-dependency.md`).

**Resource-provider registration is not automatic on the path you are about to
run.** `lib/setup/deploy-preflight.ts` *reads* the registration state of the
required providers and **emits** the `az provider register --namespace <ns>
--subscription <sub>` lines for any that are missing — it does not register
them. Automatic registration exists only on the CI deploy path, where
`scripts/ci/deploy-retry.mjs --remediate` reads the namespace out of a
`MissingSubscriptionRegistration` failure, registers it and retries once (see
[Failure recovery → registration](failure-recovery.md#registration)). Running
`az deployment sub create` by hand, as below, gets neither: register up front or
expect a mid-deploy failure with the exact command to run.

---

## Azure Commercial

### Phase 0 — clone and authenticate

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox

az login
az account set --subscription <YOUR-SUBSCRIPTION-ID>
```

### Phase 0b — create the Loom Admins Entra group

The Console grants `/admin/*` to the members of one Entra group. Create it in
**your** tenant and capture its object id — this is the one value you must
supply on the command line.

```bash
az ad group create --display-name "Loom Admins" --mail-nickname "loom-admins"

GROUP_ID=$(az ad group show --group "Loom Admins" --query id -o tsv)
USER_ID=$(az ad signed-in-user show --query id -o tsv)
az ad group member add --group "$GROUP_ID" --member-id "$USER_ID"
echo "Loom Admins group: $GROUP_ID"
```

### Phase 1 — infrastructure (40–90 min)

```bash
# Preview first. This is cheap and it catches CIDR, quota and SKU problems
# before anything is created.
az deployment sub create \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false \
  --what-if

# Apply.
az deployment sub create \
  --name "csa-loom-$(date +%Y%m%d-%H%M)" \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false
```

`commercial-full.bicepparam` = Azure Commercial, single-subscription topology
(Admin Plane + one Data Landing Zone in the same subscription), F8 capacity
equivalence. Every other choice — boundary, deployment mode, region, capacity
SKU, topology — lives in that parameter file. Edit the file to change them.

**Region caveats that are decisions, not failures.** Some regions do not offer
every backing service. The deploy exposes each as a flag so you choose
explicitly rather than discovering it mid-deploy:

| Region gap | Flag | Consequence |
|---|---|---|
| Purview unavailable (e.g. `centralus`) | `purviewEnabled=false` | The Loom catalog falls back to its Azure-native backend (AI Search + Cosmos). You can attach a cross-region Purview later via `purviewLocation`. |
| Azure Maps unavailable | `azureMapsEnabled=false` | The Geo editors honest-gate. |
| You do not want hub egress filtering yet | `loomFirewallEnabled=false` | No hub Azure Firewall is created. Nothing else consumes it. **Not `firewallEnabled`** — that is a different, deploy-planner-scoped firewall which already defaults to `false`. |

> **`loomFirewallEnabled` and `hubFirewallEnabled` are conjunctive, not
> aliases.** `main.bicep:1395` passes `firewallEnabled: (loomFirewallEnabled &&
> hubFirewallEnabled)` into the admin plane, and both default to `true`. Setting
> **either** to `false` suppresses the hub firewall, which is why "either works"
> for disabling it — but they are two independent switches, and an earlier
> version of this page described `hubFirewallEnabled` as a deprecated alias.
> It is not one.

### Phase 2 — build the images and bring the apps up (15–25 min)

```bash
gh workflow run full-app-deploy-commercial.yml \
  -f region=eastus2 \
  -f enable_apps_after=true
```

This opens the ACR, builds every app image **server-side** (`az acr build` is the
only mechanism that reaches a registry with public network access disabled),
re-locks the registry to its private endpoint, scans and signs the images, and
rolls the Container Apps onto them.

> **Set `region` explicitly.** The workflow's `region` input has a default that
> may not match your deployment. A mismatch resolves a resource group that does
> not exist and the run dies early — see
> [Failure recovery → config](failure-recovery.md#config).

### Phase 3 — post-deploy bootstrap (10–15 min) — **required to sign in**

```bash
gh workflow run csa-loom-post-deploy-bootstrap.yml \
  -f boundary=Commercial \
  -f region=eastus2 \
  -f admin_subscription=<YOUR-SUBSCRIPTION-ID>
```

`region` and `admin_subscription` are **required** — every resource group,
workspace and managed-identity name derives from them; there are no estate
defaults. For a multi-subscription topology also pass `dlz_subscription` and
`dlz_domain`.

This performs: the MSAL app registration with the Console's Front Door redirect
URI, its Graph permission grants and admin consent (**the Global Administrator
step**), Synapse SQL admin for the Console UAMI, the Purview data-plane roles,
the Databricks SCIM service principal, and the Spark private-endpoint fix.

### Phase 4 — verify

```bash
CONSOLE_URL=$(az deployment sub show --name <deployment-name> \
  --query "properties.outputs.consoleUrl.value" -o tsv)

curl -sf "$CONSOLE_URL/api/health" && echo OK
```

Then open the Console in a browser and confirm:

1. Sign-in completes (proves phase 3 landed).
2. `/admin/readiness` renders with no **Blocked** capability.
3. `/admin/gates` shows zero unresolved day-one gates.

> A `curl` 200 is not a verification receipt. Per `ux-baseline.md` G1, a deploy
> is verified by a live in-browser walk, not by a health endpoint.

> **Steps 2 and 3 are the `ux-baseline.md` G2 target, not a measured
> guarantee.** A fresh greenfield install has not been measured against them for
> this revision of the doc. If your install shows Blocked capabilities or open
> gates, that is a defect to report — not something to work around — but do not
> read the steps above as a promise that it will not happen.

---

## The clean-subscription acceptance run

`no-vaporware.md` requires a periodic **teardown + one-button redeploy in a clean
subscription**, Commercial *and* Gov, as the recurring proof that the from-scratch
path still works. `deploy-integrity.md` R4 requires greenfield and brownfield to be
proven independently. This section is that **procedure**.

> ### ⚠ Status: NOT RUN
>
> **No clean-subscription acceptance run has been executed for this revision.**
> As of 2026-08-06 the most recent successful subscription-level infra deploy on
> the Commercial estate predates the current `main` by a wide margin, and the Gov
> lane has never had a green from-scratch run (see the verification table at the
> top of this page).
>
> This is an **operator-gated** activity — it consumes a real subscription, real
> quota and real spend, and the teardown leg is destructive. It is tracked in the
> FINISHLINE operator queue. Nothing below should be read as a claim that it has
> happened; the run's own receipts are the only thing that can say that.

### Before you start

| Prerequisite | Why |
|---|---|
| A subscription with **no** `rg-csa-loom-*` resource groups and no adoptable Loom services | Otherwise you are testing brownfield, not greenfield — and the two prove nothing about each other |
| Owner + User Access Administrator on it | The deploy writes role assignments |
| Quota confirmed in the target region: Databricks Premium, Container Apps, the ACR-task VM family, Azure OpenAI | Quota failures are deterministic — a retry cannot fix one |
| A Global Administrator available for phase 3 | Admin consent for the MSAL app registration |
| An agreed teardown decision **before** you begin | `keep_resources=false` in `full` mode deletes every `rg-csa-loom-*` in the subscription |

### The run

1. **Phases 0 → 4 exactly as documented above**, unmodified. If a step needs a
   change to succeed, that change is the finding — record it, do not silently
   apply it. Per R4 the customer must never have to troubleshoot a deployment.
2. **Record per phase:** the deployment name, start/end time, the exact command
   or `gh workflow run` dispatch, and its outcome. A phase that succeeded with a
   manual intervention is a **failure of that phase** for acceptance purposes.
3. **Acceptance checks — all must pass, in a browser, not by `curl`:**

   | Check | Bar |
   |---|---|
   | Sign-in | Completes (proves phase 3 landed) |
   | `/admin/readiness` | 10/10 workloads, **0 blocked** |
   | `/admin/gates` | 0 blocked; opt-ins **only** where policy-accepted |
   | `/admin/env-config` | Honest 100% — no `derived`-but-unset counted as configured |
   | Every catalog editor | Renders and executes its primary action against the fresh backing, **or** shows its documented honest gate. Anything else is recorded as vaporware and the surface leaves the catalog until fixed |
   | Container apps | All `Succeeded/Running` on current revisions |

4. **Teardown**, if the subscription is disposable: re-dispatch in `full` mode
   with `keep_resources=false`, then confirm no `rg-csa-loom-*` remains
   (`az group list --query "[?starts_with(name,'rg-csa-loom')].name" -o tsv`).
5. **Publish the receipts** — run URLs, the readiness/gates/env-config screenshots,
   and the per-editor verdict — against the tracking item. Per
   `deploy-integrity.md` R2 the run is not "done" on a green workflow; it is done
   on the observed estate.

### Azure Government

Identical in shape, and **Actions-only** — there is no local-CLI Gov path. Use
`deploy-fiab-gcch.yml` (`run_mode=full`, `topology=tenant`,
`keep_resources=true`) plus `gov-build-images.yml` for the image phase, and
verify with `gov-verify-facts.yml` + `gov-gates.yml`. Compare the result against
the recorded **Gov readiness ceiling**, not against Commercial — the Gov ceiling
is infrastructure-bound and legitimately lower. Note that both
`gov-build-images.yml` and `deploy-fiab-il5.yml` have **never been executed**, so
a Gov acceptance run is also the first run of those lanes.

---

## Status: what this page does not yet cover

`deploy-integrity.md` R8 requires the docs and the deploy to agree. The
greenfield-relevant disagreements, measured on this branch on 2026-08-05:

| Gap | Effect on a greenfield deploy | Tracked |
|---|---|---|
| No classified retry on any Gov deploy path | GCC-High / IL5 failures are unclassified; you triage by hand from [Failure recovery](failure-recovery.md) | **#3017** |
| The CI failure-handling guard is scoped by **filename** (`/(^\|[-_])(deploy\|build\|roll\|rollback)/i`) | 13 `gov-provision-*` workflows that mutate Azure are invisible to it, so a hand-rolled retry loop can land there unnoticed | **#3017** |
| Resource-provider registration is emitted, not performed, on the local-CLI path | Register up front or hit a mid-deploy `MissingSubscriptionRegistration` | — |
| `gov-build-images.yml`, `deploy-fiab-il5.yml` have never run | The Gov image phase and the whole IL5 path are unexercised | — |

Greenfield does **not** cover adopting anything that already exists — that is
[Brownfield](brownfield.md), which carries its own status list, including four
open defects.

---

## Azure Government (GCC-High / IL4 and DoD IL5)

**All Government deployment and verification runs through GitHub Actions.**
There is a standing prohibition on running Azure Government `az` commands from a
workstation, so the Gov path has no local-CLI form. The workflows carry the Gov
login endpoints and the `AzureUSGovernment` cloud switch internally.

Prerequisite: the `AZURE_GOV_CLIENT_ID` / `_SECRET` / `_TENANT_ID` /
`_SUBSCRIPTION_ID` repository secrets must be configured. If any is missing the
workflow emits a warning and skips rather than failing — see
[secrets bootstrap](../runbooks/secrets-bootstrap.md).

### GCC-High / IL4

```bash
gh workflow run deploy-fiab-gcch.yml \
  -f run_mode=full \
  -f topology=tenant \
  -f keep_resources=true
```

| Input | Why |
|---|---|
| `run_mode=full` | `whatif-only` (the default) validates Bicep and auth and **provisions nothing**. A `whatif-only` run that succeeds has deployed nothing. |
| `topology=tenant` | First-run hub install. |
| `keep_resources=true` | **Mandatory for a real install.** With `false` this workflow is the nightly validate-and-teardown ring: it provisions, smokes, and then destroys the estate. `true` also chains the post-deploy bootstrap (phase 3) automatically. |

The workflow requires manual approval on the `gcc-high-deploy` environment
protection rule before it touches the Gov subscription.

> **This lane is currently red.** `deploy-fiab-gcch.yml`'s three most recent
> runs all ended `failure` — 2026-08-01, 2026-08-02, 2026-08-03. Check
> `gh run list --workflow deploy-fiab-gcch.yml` before you dispatch, and expect
> to be debugging the lane rather than following a known-good procedure.
>
> **There is also no failure classification on this path (#3017).**
> `deploy-fiab-gcch.yml` does not invoke `scripts/ci/deploy-retry.mjs` — the
> eight-class taxonomy, bounded retry and `deploy-failure.json` artifact
> described in [Failure recovery](failure-recovery.md) are wired into the
> **Commercial** workflows only. A Gov deploy that hits a throttle or an Entra
> replication lag fails outright, unclassified, and you classify by hand.

**The Gov image phase.** `deploy-fiab-gcch.yml` runs an image-build job before
the deploy, because `gcc-high.bicepparam` sets `deployAppsEnabled=true` and the
Container Apps pull from the sovereign ACR. On a genuinely from-scratch Gov
subscription there is no ACR yet, so that job warns and exits 0, and the images
must be built in a separate pass:

```bash
gh workflow run gov-build-images.yml -f boundary=GCC-High
```

then re-dispatch `deploy-fiab-gcch.yml`. This is the Gov equivalent of the
Commercial phase-1/phase-2 split.

> **`gov-build-images.yml` has never been executed.** As of 2026-08-05,
> `gh run list --workflow gov-build-images.yml` returns nothing. Its own header
> says so. Treat your first dispatch as the test of that lane, not as a
> known-good step, and read its output rather than assuming success.

### DoD IL5

```bash
gh workflow run deploy-fiab-il5.yml -f run_mode=full -f keep_resources=true
```

IL5 uses `il5.bicepparam`, AKS instead of Container Apps, and the Atlas-on-AKS
catalog (Purview is not in the IL5 audit scope). The `LOOM_CONSOLE_TAG` default
for IL5 is `v3.0`, not `v0.1` — the image build must push that tag or the deploy
references an image that does not exist.

> **`deploy-fiab-il5.yml` has never been executed** either. It is declared
> untested here rather than implied working.

### Gov verification

Gov verification is also Actions-only:

```bash
gh workflow run gov-verify-facts.yml
gh workflow run gov-gates.yml
```

The Gov readiness ceiling is infrastructure-bound and lower than Commercial's —
a Gov estate that reports fewer green capabilities than Commercial is not
necessarily broken. Compare against the recorded Gov ceiling, not against
Commercial.

---

## What a greenfield deploy creates

| Plane | Contents |
|---|---|
| **Admin Plane** (`rg-csa-loom-admin-<region>`) | hub VNet + subnets + NSGs, Private DNS zones, Azure Firewall (optional), Key Vault, ACR, Container Apps Environment (or AKS in IL5), Log Analytics + App Insights, AI Search, AI Foundry / AOAI, APIM, ADX, Purview (optional), Azure Maps (Commercial/GCC), Cosmos (Console metadata), the Console + sibling Container Apps |
| **Data Landing Zone** (`rg-csa-loom-dlz-<domain>-<region>`) | spoke VNet, ADLS Gen2 lake (HNS), Databricks Premium + Unity Catalog, Synapse (Serverless + Spark), Event Hubs, Stream Analytics, Data Factory, ADX database, Cosmos, and the parity services |

Key Vault, the Container Apps Environment, and the Azure Firewall instance are
**always created new** — they are never adopted, for reasons documented in
[Brownfield → what is not adoptable](brownfield.md#what-loom-will-not-adopt-and-why).

### Resource-group layout and naming

Loom's resource-group names are a **contract**, not a convention: bicep modules
resolve cross-scope references by constructing these strings, so renaming a
resource group out of band breaks the next deploy. Measured from
`platform/fiab/bicep/main.bicep` on 2026-08-06:

| Resource group | Name pattern | Where it is constructed |
|---|---|---|
| Admin Plane (hub) | `rg-csa-loom-admin-<location>` | `main.bicep:1063` — overridable **only** on a hub-attach, via `hubCoordinates.adminPlaneRgName`, when `deployAdminPlane` is false |
| Data Landing Zone (named domain) | `rg-csa-loom-dlz-<domain>-<location>` | `main.bicep:1598`, and every cross-scope `resourceGroup(subId, …)` reference (`:1734`, `:1795`, `:1829`, `:1847`) |
| Data Landing Zone (single-sub) | `rg-csa-loom-dlz-single-<location>` | `main.bicep:1604`, `:1614` |
| DLZ being attached (`dlz-attach`) | `rg-csa-loom-dlz-<attachDomainName>-<location>` | `main.bicep:1870`, `:1877` |

`<location>` is the Azure region short name (`centralus`, `eastus2`, …) and
`<domain>` is the landing-zone domain name you supply — so a two-domain
Commercial estate in `eastus2` has `rg-csa-loom-admin-eastus2`,
`rg-csa-loom-dlz-finance-eastus2` and `rg-csa-loom-dlz-hr-eastus2`.

> **The teardown step keys off this prefix.** `deploy-fiab-commercial.yml` in
> `full` mode with `keep_resources=false` enumerates `rg-csa-loom-*` **across the
> subscription** and deletes every match. Anything you name with that prefix is
> in the blast radius; anything Loom needs that you name differently is outside
> the deploy's reach.

**Tags.** Every resource group carries the `complianceTags` object
(`main.bicep:346`, applied at `:1090`, `:1616`, `:1872` and threaded into the
admin-plane and DLZ modules). It is a **required parameter with no default** —
each boundary parameter file supplies it. Commercial
(`params/commercial-full.bicepparam:377`):

```bicep
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
```

Edit that block to add your own CAF tags (cost centre, owner, application) —
they propagate to every resource group the deploy creates.

> #### Not implemented: the CAF function-RG split (t169)
>
> A planned re-layout — `docs/fiab/prp/audit-wave13b-deploy-unblock.md` item
> **t169** — would split the admin mega-RG into function resource groups
> (`rg-loom-console` / `-network` / `-shared-data` / `-governance` /
> `-observability` / `-ai`) with per-DLZ tiers (`-core` / `-compute` / `-storage`
> / `-streaming`) and CAF naming + tags on each.
>
> **It is not built.** Measured 2026-08-06:
> `grep -rn "rg-loom-console\|rg-loom-network\|rg-loom-shared-data\|rg-loom-governance\|rg-loom-observability"`
> across `**/*.bicep` and `**/*.md` returns **one** hit — the plan item itself.
> The admin plane is one resource group and each DLZ is one resource group, as
> tabulated above.
>
> This is stated so you size RBAC and policy scoping against what deploys today.
> If your governance model needs finer resource-group boundaries, that constraint
> is real and current; t169 is tracked as forward work (FINISHLINE `C11`).

---

## If a step fails

Do not re-run blindly. Classify first:

```bash
az deployment sub list \
  --query "[?starts_with(name,'csa-loom')] | [?properties.provisioningState!='Succeeded'].{name:name,state:properties.provisioningState,code:properties.error.code}" \
  -o table

az deployment operation sub list --name <deployment-name> \
  --query "[?properties.provisioningState=='Failed'].{target:properties.targetResource.resourceType,code:properties.statusMessage.error.code,msg:properties.statusMessage.error.message}" \
  -o json
```

Then look the ARM code up in [**Failure recovery**](failure-recovery.md), which
is keyed to the same eight classifications the platform's failure engine uses.

The two greenfield-specific failures worth knowing in advance:

| What you see | Class | What it means |
|---|---|---|
| `MANIFEST_UNKNOWN` / image pull failure on a Container App | **config** | You ran phase 1 with `deployAppsEnabled=true` against an empty ACR. Re-run phase 1 with `false`, then phase 2. |
| `QuotaExceeded` on `standardDDSv5Family` (or another VM family) during the image build | **quota** | The ACR-task agent pool has no cores. This is deterministic — retrying cannot help. Raise the quota or use the poolless build. |

---

## Next

- [**Brownfield deployment**](brownfield.md) — deploying into an estate that already has services Loom can use
- [**Discovery and adoption**](discovery-and-adoption.md) — what Loom can find, and how to supply values by hand
- [**Failure recovery**](failure-recovery.md) — the failure taxonomy and remediations
- [**Upgrade lifecycle**](upgrade.md)

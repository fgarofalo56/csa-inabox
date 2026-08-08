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

Re-measured **2026-08-08**. Every row is `gh run list` output, not an estimate.

| Cloud | Status of this walkthrough |
|---|---|
| **Azure Commercial** | **Verified in part, and the app lane is RED right now.** `full-app-deploy-commercial.yml`'s three most recent completed runs all ended `failure` (all 2026-08-08). All three failed **at the chained post-deploy-bootstrap leg, after every image and Container App had already deployed** — see [phase 2](#phase-2--build-the-images-and-bring-the-apps-up-1525-min). Template validation passes for `commercial-full.bicepparam`. **A from-scratch phase-1 → phase-2 → phase-3 run into a clean, empty subscription has not been performed for this revision.** |
| **Azure Government — GCC-High / IL4** | **Partly exercised.** `deploy-fiab-gcch.yml`'s most recent run (2026-08-08) ended `success` — but its `build-gov-images` and `post-deploy-bootstrap` jobs were both **skipped**, so that green proves the what-if/validate path only. The three runs before it ended `failure`. Read [when a green Gov run means nothing](#when-a-green-gov-run-means-nothing) before you interpret any Gov result. |
| **DoD IL5** | **Never executed.** `gh run list --workflow deploy-fiab-il5.yml` returns nothing. |
| **Gov image build** | **Now executed — two `success` runs on 2026-08-08.** An earlier revision of this page said "never executed"; that is no longer true. It is still unexercised as part of an end-to-end from-scratch Gov install. |

Where a step below has never been run, it says so inline. Do not read the
absence of a warning as a claim of success — read the table above, and re-run
the measurement yourself:

```bash
for wf in full-app-deploy-commercial deploy-fiab-commercial deploy-fiab-gcch \
          deploy-fiab-gcc deploy-fiab-il5 gov-build-images csa-loom-post-deploy-bootstrap; do
  echo "== $wf"
  gh run list --workflow "$wf.yml" --limit 3 \
    --json conclusion,createdAt --jq '.[] | "\(.conclusion // "in-progress")  \(.createdAt)"'
done
```

A workflow that prints nothing has **never run**. That is the loudest signal on
this page, not a quiet pass (`deploy-integrity.md` R3).

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
  -f enable_apps_after=true
```

This opens the ACR, builds every app image **server-side** (`az acr build` is the
only mechanism that reaches a registry with public network access disabled),
re-locks the registry to its private endpoint, scans and signs the images, rolls
the Container Apps onto them — **and then runs phase 3 for you**.

> **Phase 3 is CHAINED into this workflow.** `full-app-deploy-commercial.yml`
> declares a `post-deploy-bootstrap` job that calls
> `csa-loom-post-deploy-bootstrap.yml` as a reusable workflow, gated
> `if: inputs.enable_apps_after && needs.redeploy-with-apps.result == 'success'`.
> So with `enable_apps_after=true` the bootstrap runs automatically and you do
> **not** normally dispatch phase 3 by hand. The standalone dispatch documented
> in [phase 3](#phase-3--post-deploy-bootstrap-1015-min--required-to-sign-in)
> exists to **re-run or repair** the bootstrap; it is idempotent, so running it
> again is safe.
>
> The chained call deliberately does **not** pass `admin_subscription` — a job
> output whose value equals a registered secret is scrubbed in transit, so it
> would arrive empty. The reusable workflow falls back to the boundary
> subscription secret instead. A **manual** dispatch has no such fallback, which
> is why `admin_subscription` is `required: true` on the dispatch form.

> **A red run here does NOT mean no images were built.** All three of this
> workflow's most recent failures (2026-08-08) failed at the
> `Post-deploy bootstrap (Commercial)` job — i.e. the build, the registry
> re-lock and the Container App roll had all already succeeded. Check **which
> job** failed before you re-run the whole thing:
>
> ```bash
> gh run view <run-id> --json jobs \
>   --jq '.jobs[] | select(.conclusion=="failure") | .name'
> ```
>
> If the failing job is the bootstrap, re-dispatch **phase 3 alone** rather than
> rebuilding every image.

> **`region` is optional here and is best left EMPTY (#3029).** The workflow's
> `region` input has **no default** — an earlier `eastus2` default pointed run
> `31028909702` at `rg-csa-loom-admin-eastus2`, which does not exist, and the run
> died reporting an unrelated registry-name error. With the field empty the
> `resolve` job asks Resource Graph which `rg-csa-loom-admin-*`/`acrloom*` exists
> in the subscription and targets that, failing loudly if there are none or more
> than one. Supply a region only to disambiguate a subscription that holds
> several admin planes.

#### The ACR firewall lease — one build at a time, and it needs a specific role

The registry rests locked (`publicNetworkAccess: 'Disabled'` in
`platform/fiab/bicep/modules/admin-plane/registry.bicep`). To build into it the
workflow takes a **firewall lease** — a mutual exclusion implemented as tags on
the registry resource (`scripts/csa-loom/acr-firewall-lease.sh`).

| Fact | Value | Why it matters to you |
|---|---|---|
| Lease TTL | 75 min (`LOOM_ACR_LEASE_TTL_MINUTES`) | The lease covers the whole build matrix |
| Bounded acquire wait | 25 min (`LOOM_ACR_LEASE_WAIT_MINUTES`), then **fails closed** | A second dispatch inside the window dies with `[acr-lease] TIMED OUT after 25m … holder = run <id>` |
| Permission to take a lease | `Microsoft.Resources/tags/write` on the registry | Included in **Contributor**; otherwise grant **Tag Contributor** scoped to the ACR |

**Do not dispatch this workflow twice concurrently.** The `concurrency` group is
a constant for exactly this reason; a second run cannot get the lease, and its
roll step would otherwise run against a half-built registry.

If the deploy identity lacks `Microsoft.Resources/tags/write`, the lease cannot
be taken. By default the script then falls back to **unleased (legacy) mode**
rather than failing — so builds still work, but the mutual exclusion that
prevents two runs from fighting over the registry is **not in effect**. Grant
the role rather than relying on the fallback:

```bash
az role assignment create \
  --assignee <deploy-identity-object-id> \
  --role "Tag Contributor" \
  --scope <acr-resource-id>
```

> **Known gap — a from-scratch registry is not left in the state the lease check
> expects.** `registry.bicep` sets `publicNetworkAccess: 'Disabled'` but does
> **not** set `networkRuleSet.defaultAction: 'Deny'`, while the lease's
> lock-verification requires **both**. `defaultAction=Deny` is only ever
> established imperatively, by the lease's own close step. So on an estate that
> has never taken and released a lease, the verification can report the registry
> as publicly reachable even though bicep considers it hardened. Compare
> `keyvault.bicep` and `catalog.bicep`, which do set both. This is a real
> inconsistency, recorded here rather than smoothed over; it does not block the
> build.

### Phase 3 — post-deploy bootstrap (10–15 min) — **required to sign in**

**On Commercial this already ran** as a chained job of phase 2. Dispatch it
standalone only to **re-run or repair** it — for example when phase 2 failed at
the bootstrap leg, or when the estate predates the DLZ-discovery fix below:

```bash
gh workflow run csa-loom-post-deploy-bootstrap.yml \
  -f boundary=Commercial \
  -f region=<region> \
  -f admin_subscription=<subscription-id>
```

`region` and `admin_subscription` are **required** on a manual dispatch — every
resource group, workspace and managed-identity name derives from them, and no
estate defaults ship in a public repo. The workflow is idempotent.

> **The Data Landing Zone is DISCOVERED, not supplied.** `dlz_subscription` and
> `dlz_domain` are optional overrides. The workflow reads Azure Resource Graph
> across every subscription the deploy identity can see and resolves the
> `rg-csa-loom-dlz-<domain>-<region>` group, its subscription, and the Synapse /
> Databricks workspaces inside it — so a **multi-subscription** estate needs
> nothing extra passed. It fails, loudly and with three distinct messages, when
> it finds none, finds more than one, or cannot read the estate at all; a
> failure to determine is never reported as an absence.
>
> `dlz_domain` used to default to `single`, which is one estate shape out of
> several. On any multi-sub / `dlz-attach` estate that produced a resource group
> that does not exist and the bootstrap died on `(ResourceGroupNotFound)` — after
> 25 of 27 jobs had gone green (**#3143**, fixed in PR **#3140**). Supply the
> overrides only to pick between several landing zones; an override that matches
> nothing now fails at discovery rather than reaching ARM. The naming trap that
> caused it is explained in
> [Resource-group layout](resource-groups.md#the-single--default-trap--read-this-before-you-construct-a-name-by-hand).
>
> **If your estate predates 2026-08-08 and is multi-subscription, this phase
> probably never ran.** Day-one wiring (MSAL app registration, Purview roles,
> Synapse SQL grants, Databricks SCIM, the Spark private-endpoint fix) would be
> absent. Dispatch it standalone using the command above.
>
> If discovery reports **no landing zone**, check in this order: was a DLZ ever
> deployed in that region (a hub-only `topology=tenant` deploy stamps none until
> `dlz-attach` runs); does the deploy identity hold **Reader on the DLZ
> subscription** (Resource Graph returns only subscriptions it can read, so a
> cross-sub DLZ silently drops out); and only then, is the group under a
> non-standard name.

> **Residual gap worth knowing.** The callers stopped asserting "the DLZ is in
> the admin subscription", but the reusable workflow's own `DLZ_SUB` environment
> variable still falls back to `admin_subscription`, and the callers always pass
> that. Discovery overwrites it on the success path, so the grants land
> correctly — but a few late steps that read the raw variable (the Iceberg lake
> lookup among them) still carry the admin-subscription assumption. Verify those
> resources exist after a cross-subscription install rather than assuming.

This performs: the MSAL app registration with the Console's Front Door redirect
URI, its Graph permission grants and admin consent (**the Global Administrator
step**), Synapse SQL admin for the Console UAMI, the Purview data-plane roles,
the Databricks SCIM service principal, the Spark private-endpoint fix, and the
Loom Unity unseal (below).

### What phase 2 does NOT update — Loom Unity, Iceberg and Trino

This is a genuine gap, not a caveat, and it is stated here because it changes
what a re-deploy means.

`full-app-deploy-commercial.yml` **builds** `loom-unity` and `loom-trino` in its
image matrix. It does **not roll** them. Its roll step names six apps —
`loom-console`, `loom-mcp`, `loom-setup-orchestrator`, `loom-activator`,
`loom-mirroring`, `loom-direct-lake-shim` — and that set is mirrored and
asserted both ways by `scripts/ci/deploy-image-roles.mjs`. No workflow anywhere
issues `az containerapp update --image` against `loom-unity`,
`iceberg-catalog`, or `loom-trino` on Commercial.

| App | Built by | Rolled by | Net effect |
|---|---|---|---|
| `loom-unity` | `full-app-deploy-commercial.yml`, `build-fiab-images-acr-tasks.yml`, `gov-build-images.yml` | **nothing** | A rebuilt image never reaches the running revision |
| `iceberg-catalog` (runs the `loom-unity` image) | — | **nothing**; created by the bootstrap **only if absent** | An existing one is frozen on whatever digest it first pulled |
| `loom-trino` | `full-app-deploy-commercial.yml`, `build-fiab-images-acr-tasks.yml` | **nothing on Commercial** (Gov has `gov-provision-trino.yml`) | Commercial has *less* of a path than Gov here |

The mechanism: the image tag is the **mutable** `v0.1`
(`appImageTags.?unity ?? 'v0.1'` in the admin-plane module — not a SHA), and
Container Apps pins the **digest** at revision-creation time. Re-pushing
`loom-unity:v0.1` therefore changes nothing until something forces a new
revision. `full-app-deploy-commercial.yml` deliberately does not run a full
`az deployment sub create`, so the only re-render path today is a full
admin-plane deploy.

On a **greenfield** install this is invisible — every app is created once, from
the images you just built, so it is correct on day one. It bites on the **second
and every later** deploy. Per `cloud-parity.md` it matters more than it looks:
Unity Catalog is not available in Azure Government, so Loom Unity *is* the
catalog story for sovereign customers, and an un-rollable catalog is a
sovereign-customer problem first.

Until a roll path exists, re-render those apps with a full admin-plane deploy
(the phase-1 command with `deployAppsEnabled=true`), and what-if first.

> A code comment in `full-app-deploy-commercial.yml` still says loom-unity is
> "deployed out-of-band, not by admin-plane". **That comment is false.**
> `admin-plane/main.bicep` deploys it (`module loomUnity … = if (loomUnityActive)`)
> and `commercial.bicepparam` declares its `appImageTags` key. It is recorded
> here rather than left to mislead the next reader.


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
| An agreed teardown decision **before** you begin | `keep_resources=false` in `full` mode deletes every `rg-csa-loom-*` in the subscription. It now also requires `confirm_teardown_rg=rg-csa-loom-admin-<region>`, and a run that would tear down without it is refused before anything reaches ARM |

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
   with `keep_resources=false` **and** `confirm_teardown_rg=rg-csa-loom-admin-<region>`
   (the confirmation must match exactly, or the run is refused before any ARM
   call — #3028), then confirm no `rg-csa-loom-*` remains
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
greenfield-relevant disagreements, **re-measured on this branch on 2026-08-08**:

| Gap | Effect on a greenfield deploy | Tracked |
|---|---|---|
| No automated roll path for `loom-unity` / `iceberg-catalog` / `loom-trino` on Commercial | Correct on day one; every later deploy leaves them on their original digest — see [above](#what-phase-2-does-not-update--loom-unity-iceberg-and-trino) | — |
| `registry.bicep` sets `publicNetworkAccess=Disabled` but not `networkRuleSet.defaultAction=Deny`, which the lease's lock check requires | A from-scratch registry can fail the lock verification it should pass | — |
| Resource-provider registration is emitted, not performed, on the local-CLI path | Register up front or hit a mid-deploy `MissingSubscriptionRegistration` | — |
| `deploy-fiab-il5.yml` has never run | The whole IL5 path is unexercised | — |
| The bootstrap's `DLZ_SUB` env still falls back to the admin subscription | A few late steps carry the admin-sub assumption on a cross-sub estate | **#3143** (follow-up) |

**Two rows that used to be on this list have been removed because they are no
longer true.** They are recorded here so the correction is visible rather than
silent:

- *"No classified retry on any Gov deploy path (#3017)."* **False as of #3062.**
  Measured: `deploy-fiab-gcch.yml` invokes `scripts/ci/deploy-retry.mjs` twice,
  and `deploy-fiab-gcc.yml`, `deploy-fiab-il5.yml` and `deploy-gov.yml` each
  invoke it too. Re-measure with
  `grep -c 'deploy-retry' .github/workflows/deploy-fiab-gcch.yml` (expect > 0).
  No Gov run has yet *exercised* the retry, which is a different and weaker
  claim than "it is not wired".
- *"The CI failure-handling guard is scoped by filename, so 13 `gov-provision-*`
  workflows are invisible to it."* **False.** `scripts/ci/check-deploy-failure-handling.mjs`
  now scopes by **what a workflow does** — any `az` command is treated as
  mutating unless provably read-only — with the filename pattern kept only as an
  OR arm, and an anti-collapse ratchet (`assertDiscoveryHealthy`) that exits 1 if
  the behavioural arm ever stops contributing workflows the filename arm misses.
  (The count was also wrong: the code records 11 `gov-provision-*`, not 13.)

Greenfield does **not** cover adopting anything that already exists — that is
[Brownfield](brownfield.md), which carries its own status list.

---

## Azure Government (GCC-High / IL4 and DoD IL5)

**All Government deployment and verification runs through GitHub Actions.**
There is a standing prohibition on running Azure Government `az` commands from a
workstation, so the Gov path has no local-CLI form. The workflows carry the Gov
login endpoints and the `AzureUSGovernment` cloud switch internally.

Prerequisite: the `AZURE_GOV_CLIENT_ID` / `_SECRET` / `_TENANT_ID` /
`_SUBSCRIPTION_ID` repository secrets must be configured — see
[secrets bootstrap](../runbooks/secrets-bootstrap.md).

### When a green Gov run means nothing

This is the single most important thing to know before you read a Gov result.
**A Gov deploy workflow can conclude `success` having changed nothing at all**,
in three distinct ways. Check which one you are in before believing a green
tick:

| Mode | Cause | How to spot it | Fix |
|---|---|---|---|
| **Secrets absent → whole deploy skipped** | The `precheck` job emits `::warning::AZURE_GOV_* secrets not configured — skipping` and sets `configured=false`; every downstream job is gated `if: needs.precheck.outputs.configured == 'true'`. A `::warning::` does not fail a job, so the run is **green**. Identical logic in `deploy-fiab-gcc.yml`, `deploy-fiab-gcch.yml` and `deploy-fiab-il5.yml` | The deploy job shows `skipped` | Configure the secrets |
| **`run_mode=whatif-only`** — *the default* | The `Provision`, `Smoke test` and `Teardown` steps are all gated `if: schedule || inputs.run_mode == 'full'`. A dispatch that changes nothing else validates Bicep and auth and **provisions nothing**, then logs "dry-run completion" | Run title / the `Note dry-run completion` step | Dispatch with `run_mode=full` |
| **`keep_resources=false`** — *the default* | On a `full` run the `Teardown` step fires on success and destroys what was just built, and `post-deploy-bootstrap` is gated on `inputs.keep_resources` so it never runs | The `Teardown` step ran; the bootstrap job shows `skipped` | Dispatch with `keep_resources=true` |

Verify with the job list, not the conclusion:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.name) -> \(.conclusion)"'
```

**Measured 2026-08-08.** `deploy-fiab-gcc.yml`'s most recent run concluded
`success` with `Deploy + validate CSA Loom in GCC -> skipped` and
`Post-deploy bootstrap (GCC) -> skipped` — mode 1, live, today. This is the
explanation for a lane that reports success daily while deploying zero Container
Apps (**#3078**). `deploy-fiab-gcch.yml`'s most recent run concluded `success`
with the deploy job green but `build-gov-images` and `post-deploy-bootstrap`
both `skipped` — mode 2.

> `deploy-gov.yml` is the exception: it has no `precheck` gate and fails closed
> when secrets are absent — though incidentally, via the login step erroring,
> rather than by an explicit check. It is also a different template lineage
> (`deploy/bicep/gov/main.bicep`) and is not a sibling of the three Loom lanes.

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
| `keep_resources=true` | **Mandatory for a real install.** With `false` (the default) this workflow is the nightly validate-and-teardown ring: it provisions, smokes, and then destroys the estate. `true` also chains the post-deploy bootstrap (phase 3) automatically. |

**All three matter, and all three differ from the defaults.** A dispatch that
changes only `run_mode` still tears the estate down.

> **On a `schedule` trigger the bootstrap can never run.** The
> `post-deploy-bootstrap` job is gated on `inputs.keep_resources`, and a
> scheduled run supplies no inputs. So the nightly ring has never performed
> Gov day-one wiring, by construction.

The workflow requires manual approval on the `gcc-high-deploy` environment
protection rule before it touches the Gov subscription.

> **Lane health, measured 2026-08-08.** The most recent run concluded `success`
> (validate path only — see the table above); the three before it ended
> `failure`. Check `gh run list --workflow deploy-fiab-gcch.yml` before you
> dispatch.
>
> **Classified retry IS wired on this lane** (`scripts/ci/deploy-retry.mjs`,
> landed in #3062) — an earlier revision of this page said it was not. What has
> **not** happened is a Gov run that exercised it. Merged is not proven
> (`deploy-integrity.md` R2).

**The Gov image phase.** `deploy-fiab-gcch.yml` runs an image-build job before
the deploy, because `gcc-high.bicepparam` sets `deployAppsEnabled=true` and the
Container Apps pull from the sovereign ACR. That job is itself gated on
`run_mode=full` (or a schedule). On a genuinely from-scratch Gov subscription
there is no ACR yet, so the images must be built in a separate pass:

```bash
gh workflow run gov-build-images.yml -f boundary=GCC-High
```

then re-dispatch `deploy-fiab-gcch.yml`. This is the Gov equivalent of the
Commercial phase-1/phase-2 split.

> **`gov-build-images.yml` has now run** — two `success` runs on 2026-08-08. An
> earlier revision of this page said it had never been executed; that is no
> longer true. It has still not been exercised as part of an end-to-end
> from-scratch Gov install, so treat the *sequence* as untested even though the
> workflow itself is not.

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

### Resource-group layout, naming and tags

A deploy stamps **one** resource group for the admin plane
(`rg-csa-loom-admin-<location>`) and **one per Data Landing Zone**
(`rg-csa-loom-dlz-<domain>-<location>`, or `rg-csa-loom-dlz-single-<location>` in
single-subscription mode). Those names are a **contract** — bicep constructs
them as strings to resolve cross-scope references, so renaming one out of band
breaks the next deploy.

Three things you need before you size RBAC or plan a teardown:

- the **`single` / `default` naming trap** that broke the post-deploy bootstrap,
- the **`rg-csa-loom-` teardown blast radius**,
- how to add your own **CAF tags** via `complianceTags`.

All three, with the measurement commands, are on the dedicated page:
[**Resource-group layout, naming and tags**](resource-groups.md).

That page also records that the planned **CAF function-RG split (t169)** —
`rg-loom-console` / `-network` / `-shared-data` / `-governance` /
`-observability` / `-ai` plus per-DLZ tiers — is **not built**, so you scope
policy against one admin RG and one RG per DLZ, not against the plan.

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

The greenfield-specific failures worth knowing in advance:

| What you see | Class | What it means |
|---|---|---|
| `MANIFEST_UNKNOWN` / image pull failure on a Container App | **config** | You ran phase 1 with `deployAppsEnabled=true` against an empty ACR. Re-run phase 1 with `false`, then phase 2. |
| `QuotaExceeded` on `standardDDSv5Family` (or another VM family) during the image build | **quota** | The ACR-task agent pool has no cores. This is deterministic — retrying cannot help. Raise the quota or use the poolless build. |
| `[acr-lease] TIMED OUT after 25m … holder = run <id>` | **config** | A second `full-app-deploy-commercial` dispatch is racing the first for the ACR firewall lease. Wait for the holder to finish; do not cancel it mid-push. |
| `could not write the lease tags on ACR …` / `Microsoft.Resources/tags/write` | **permission** | Grant the deploy identity **Tag Contributor** (or Contributor) scoped to the registry. |
| `(ResourceGroupNotFound) rg-csa-loom-dlz-…` during the bootstrap | **config** | The landing zone is not where the name was constructed. On a current build the bootstrap discovers it; if you pinned `dlz_domain`/`dlz_subscription`, drop the overrides and let discovery run. See [the naming trap](resource-groups.md#the-single--default-trap--read-this-before-you-construct-a-name-by-hand). |
| `'admin_subscription' is REQUIRED (no estate default)` | **config** | A manual bootstrap dispatch omitted `admin_subscription`. It is `required: true` on the dispatch form; only the chained caller may omit it. |

---

## Deploying greenfield from the Console wizard

This page is the **CLI + workflow** path, and it is the one that is exercised.
The Console also ships a `/setup` wizard whose all-`create` plan is the
greenfield path through the UI; its step-by-step walkthrough is in
[Deployment → the in-Console setup wizard](index.md#the-in-console-setup-wizard-step-by-step).

Two constraints that follow from the code and are easy to hit:

1. **The wizard is first-install-only.** It never submits a `topology`, so the
   deploy route defaults to `topology='tenant'` and returns **409** when a hub
   already exists in the tenant, directing you to
   `/admin` → *Add landing zone* (`topology=dlz-attach`) instead. That is the
   correct invariant — a second Console can never be stamped — but it means the
   wizard is not the tool for reconciling an existing estate.
2. **A plan containing any `adopt` decision cannot be deployed from the
   wizard today.** That is a brownfield concern; it is documented, with the
   measurement, in
   [Brownfield → the wizard cannot deploy an adopt plan](brownfield.md#blocking-defect-the-wizard-cannot-deploy-a-plan-containing-an-adopt-decision).
   A pure greenfield plan (every service `create`) is unaffected.

---

## Next

- [**Brownfield deployment**](brownfield.md) — deploying into an estate that already has services Loom can use
- [**Resource-group layout, naming and tags**](resource-groups.md) — the naming contract, the teardown blast radius, CAF tags, and t169
- [**Discovery and adoption**](discovery-and-adoption.md) — what Loom can find, and how to supply values by hand
- [**Failure recovery**](failure-recovery.md) — the failure taxonomy and remediations
- [**Upgrade lifecycle**](upgrade.md)

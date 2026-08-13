# Prerequisites and first deploy — start here

This is the **one authoritative page** for standing up CSA Loom: what you must
prepare, how to deploy, and how to confirm each step actually worked. Everything
else in this section is depth you reach for when you need it — this page is the
spine.

It exists because of a specific complaint: *the deploy should configure
everything for the user, and where prework genuinely is required it must be
called out, clear, and step by step with all the information needed to do it.*
Those are two different obligations, and this page keeps them separate.

- **What the platform can do, the platform does.** Per
  [`auto-bind-by-default.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/.claude/rules/auto-bind-by-default.md)
  §5, infrastructure prerequisites are *deployed*, not requested. If you find a
  step here that tells you to go set a value the deploy could have produced,
  that is a **defect to file**, not a chore to accept.
- **What genuinely cannot be automated** is listed below, in full, with the
  exact command and a verification for each.

---

## The short version

**Three things block a first deploy. Everything else is deployed for you.**

| # | Prerequisite | Why it cannot be automated | Time |
|---|---|---|---|
| 1 | [An Azure subscription and the rights on it](#p1--a-subscription-and-the-rights-on-it) | It is the entry condition. Nothing can grant itself a subscription. | 0–1 day (procurement) |
| 2 | [A deployment identity, as GitHub secrets](#p2--the-deployment-identity) | Chicken-and-egg: the identity that performs the deploy cannot deploy itself. | ~10 min |
| 3 | [An admin binding — who gets `/admin/*`](#p3--the-admin-binding) | A *policy* decision about which humans are administrators. The platform cannot invent it. | ~2 min |

A further set of **tenant consents is required only for specific feature
surfaces** — MIP/DLP, cross-subscription Connections, Power Platform. None of
them block the deploy or sign-in, and each is listed in
[post-deploy tenant consents](#post-deploy-tenant-consents-optional-feature-scoped).

!!! tip "If you only read one thing"
    Set `FIAB_TENANT_ADMIN_OID` to **your own** Entra user object id. It is the
    single most important value on this page, it is the one binding that has
    never depended on a claim that might not be emitted, and until now it was
    documented **nowhere**.

---

## What the platform does for you

Listed so you do not go looking for work that is already done. Every row below is
performed by the deploy or the post-deploy bootstrap — **you do not do any of
it.**

<div class="grid cards" markdown>

-   :material-cog-sync: **Backing services and their bindings**

    Every Azure backend Loom uses — ADLS, Synapse, Databricks, ADX, Event Hubs,
    Cosmos, AI Search, AOAI/Foundry, Key Vault, APIM, Purview — is provisioned
    and bound, with names derived deterministically from the estate. You never
    hand-map a Loom item to its Azure resource.

-   :material-key-variant: **Every `LOOM_*` environment variable**

    Rendered onto the Container Apps by the deploy. There is no list of env vars
    for you to set. A capability that reports Blocked because a value the deploy
    could have set was not set is a defect — file it.

-   :material-account-key: **Data-plane grants Bicep cannot make**

    The post-deploy bootstrap grants the Console identity Synapse Administrator,
    registers it with Databricks via SCIM, wires APIM, assigns Microsoft Graph
    application roles, grants Foundry and Content Safety roles, and registers the
    Power Platform management app.

-   :material-login: **The sign-in app registration**

    The MSAL app registration is created, its redirect URIs set, its client
    secret written to Key Vault, `groupMembershipClaims=SecurityGroup`
    configured, and `LOOM_MSAL_CLIENT_ID` wired onto the Console.

-   :material-magnify-scan: **Brownfield discovery**

    A read-only multi-subscription inventory of what you already have, with a
    per-service adopt / create / skip decision. Loom never silently adopts and
    never silently duplicates.

-   :material-database-cog: **Seed state**

    Cosmos containers, the AI Search governance catalog index, default Monitor
    alert rules and the action group — all created on first deploy so the
    surfaces resolve day-one rather than 404.

</div>

---

## Part 1 — the prerequisites, in full

### P1 — a subscription and the rights on it

**What it is.** One Azure subscription for a single-subscription install; one for
the Admin Plane plus one per Data Landing Zone for multi-subscription.

**What you need on it.** **Owner**, or **Contributor + User Access
Administrator**. The second role is not optional decoration — the deploy writes
RBAC role assignments, and without `Microsoft.Authorization/roleAssignments/write`
it fails partway through having created resources it cannot wire.

**How to confirm it took:**

```bash
az login
az account set --subscription <subscription-id>

# Expect Owner, or both Contributor and User Access Administrator.
az role assignment list \
  --assignee "$(az ad signed-in-user show --query userPrincipalName -o tsv)" \
  --scope "/subscriptions/$(az account show --query id -o tsv)" \
  --query "[].roleDefinitionName" -o tsv
```

**Also check quota before you start**, because quota failures surface 40 minutes
into a deploy rather than at the front:

```bash
az vm list-usage --location <region> -o table          # Container Apps / ACR task families
az account list-locations --query "[?name=='<region>']" -o table
```

Azure OpenAI capacity (TPM) is requested through the portal Quotas blade and can
take a business day. Request it before you begin.

---

### P2 — the deployment identity

**What it is.** A service principal in the target tenant that the deploy
workflows authenticate as. **This is the genuine chicken-and-egg**: the identity
that creates everything cannot create itself, so this one step is yours.

**Create it once per tenant:**

```bash
SUB_ID=$(az account show --query id -o tsv)

# Creates the SP and prints appId + password. Capture both — the password is
# shown ONCE and cannot be retrieved again.
az ad sp create-for-rbac \
  --name "csa-loom-deploy" \
  --role Contributor \
  --scopes "/subscriptions/$SUB_ID" \
  --output json
```

Then add the role that lets it write RBAC:

```bash
SP_OBJECT_ID=$(az ad sp list --display-name "csa-loom-deploy" --query "[0].id" -o tsv)

az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "User Access Administrator" \
  --scope "/subscriptions/$SUB_ID"
```

**Confirm the SP has what it needs** (expect both roles listed):

```bash
az role assignment list --assignee "$SP_OBJECT_ID" \
  --scope "/subscriptions/$SUB_ID" --query "[].roleDefinitionName" -o tsv
```

#### Store the credentials as GitHub secrets

!!! danger "Never put a secret value on a command line"
    `gh secret set NAME --body "<value>"` writes the value into your shell
    history and into any process listing. **Omit `--body`** — `gh` then prompts
    and reads from stdin, and the value never touches the history file.

```bash
# Each of these prompts: "Paste your secret:" — paste, then press Enter.
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
gh secret set AZURE_TENANT_ID
gh secret set AZURE_SUBSCRIPTION_ID
```

**Confirm they took.** `gh secret list` prints names and update timestamps and
**never** prints a value — which is exactly why it is the right verification:

```bash
gh secret list | grep -E 'AZURE_(CLIENT_ID|CLIENT_SECRET|TENANT_ID|SUBSCRIPTION_ID)'
# Expect 4 rows. A missing row is the whole failure — there is no partial state.
```

The end-to-end proof that the credentials actually authenticate is the
`whatif-only` dispatch in [verify the credentials](#step-0--verify-the-credentials-before-you-spend-anything).

---

### P3 — the admin binding

**What it is.** Which humans may open `/admin/*`. There are two independent
bindings and **you should set both**:

| Binding | Where it lives | What it is |
|---|---|---|
| `FIAB_TENANT_ADMIN_OID` | repo **variable** | A single Entra **user** object id — a bootstrap admin who bypasses the feature-permission gate. |
| `FIAB_ADMIN_GROUP_ID` | repo **secret** *or* **variable** | An Entra **security group** object id whose members are admins. |

!!! warning "Why both, and why the OID first"
    The group binding depends on Entra emitting a `groups` claim, which in turn
    depends on the bootstrap having successfully set
    `groupMembershipClaims=SecurityGroup` on the app registration. That path is
    wired today (the callback reads the claim, and
    `scripts/csa-loom/bootstrap-msal-app-reg.sh` sets the property), but it has
    more moving parts than the OID binding, which is a direct object-id compare.

    **The deploy refuses to render the Container Apps when *neither* is
    resolvable** — a Console with both empty has an admin gate nobody can pass
    and no in-product way out. Setting the OID is the cheapest insurance against
    that outcome.

**Get the two values:**

```bash
# Your own object id — this is FIAB_TENANT_ADMIN_OID.
az ad signed-in-user show --query id -o tsv

# Create the admin group and put yourself in it — the output is FIAB_ADMIN_GROUP_ID.
az ad group create --display-name "Loom Admins" --mail-nickname "loom-admins" -o none
GROUP_ID=$(az ad group show --group "Loom Admins" --query id -o tsv)
az ad group member add --group "$GROUP_ID" \
  --member-id "$(az ad signed-in-user show --query id -o tsv)"
echo "$GROUP_ID"
```

**Set them:**

```bash
gh variable set FIAB_TENANT_ADMIN_OID   # prompts; paste your user object id
gh variable set FIAB_ADMIN_GROUP_ID     # prompts; paste the group object id
```

**Confirm they took.** Repository *variables* are not secrets, so `gh variable
list` prints their values — verify by name and by the value you set:

```bash
gh variable list | grep -E 'FIAB_(TENANT_ADMIN_OID|ADMIN_GROUP_ID)'
```

**Confirm the deploy resolved them.** This is the check that matters, because it
reads what was actually composed rather than what you intended. Every deploy run
emits a notice:

```
Bootstrap admin binding: group=present, oid=present (source=FIAB_TENANT_ADMIN_OID-repo-var). Values redacted.
```

`group=absent, oid=absent` means the run will refuse rather than deploy an
unusable Console. That refusal is correct behaviour, not a bug.

---

## Part 2 — credential reference, per cloud

Names only. Nothing on this page ever prints a value.

=== "Commercial"

    | Name | Kind | Required | Purpose |
    |---|---|---|---|
    | `AZURE_CLIENT_ID` | secret | **yes** | Deploy SP application (client) id |
    | `AZURE_CLIENT_SECRET` | secret | **yes** | Deploy SP secret |
    | `AZURE_TENANT_ID` | secret | **yes** | Entra tenant |
    | `AZURE_SUBSCRIPTION_ID` | secret | **yes** | Target subscription |
    | `FIAB_TENANT_ADMIN_OID` | variable | **strongly recommended** | Bootstrap admin user object id |
    | `FIAB_ADMIN_GROUP_ID` | secret *or* variable | one of these two | Admin security-group object id |

    Workflow: `deploy-fiab-commercial.yml` · app tier: `full-app-deploy-commercial.yml`

=== "GCC"

    | Name | Kind | Required | Purpose |
    |---|---|---|---|
    | `AZURE_GCC_CLIENT_ID` | secret | **yes** | Deploy SP in the GCC tenant |
    | `AZURE_GCC_CLIENT_SECRET` | secret | **yes** | |
    | `AZURE_GCC_TENANT_ID` | secret | **yes** | |
    | `AZURE_GCC_SUBSCRIPTION_ID` | secret | **yes** | |
    | `FIAB_GCC_ADMIN_GROUP_ID` | secret | **yes** | Admin group in the GCC tenant |

    GCC is Azure Public ARM endpoints under M365 GCC identity — the SP is created
    in the **GCC** tenant, not the Commercial one. Workflow: `deploy-fiab-gcc.yml`

    !!! warning "GCC is infrastructure-only today (#3078)"
        `gcc.bicepparam` deliberately never sets `deployAppsEnabled`, and
        `main.bicep` defaults it to `false`. A `full` GCC run therefore
        provisions infrastructure and creates **zero Container Apps** — no
        `loom-console`. A green run on this lane does **not** mean GCC serves
        Loom. The gap is a missing GCC image producer, tracked with an owner in
        **#3078**. Disclosed here rather than implied working, per
        [`cloud-parity.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/.claude/rules/cloud-parity.md).

=== "GCC-High / IL4"

    | Name | Kind | Required | Purpose |
    |---|---|---|---|
    | `AZURE_GOV_CLIENT_ID` | secret | **yes** | Deploy SP in the Azure Government tenant |
    | `AZURE_GOV_CLIENT_SECRET` | secret | **yes** | |
    | `AZURE_GOV_TENANT_ID` | secret | **yes** | |
    | `AZURE_GOV_SUBSCRIPTION_ID` | secret | **yes** | |
    | `FIAB_GOV_ADMIN_GROUP_ID` | secret | **yes** | Admin group in the Gov tenant |
    | `LOOM_GOV_MSAL_CLIENT_ID` | secret | optional | Pins an existing sign-in app registration instead of creating one |
    | `LOOM_GOV_MSAL_CLIENT_SECRET` | secret | optional | Paired with the above |

    The SP must be created against the **Azure Government** endpoints:

    ```bash
    az cloud set --name AzureUSGovernment
    az login
    # then the P2 steps, against the Gov subscription
    ```

    Workflow: `deploy-fiab-gcch.yml` (environment-approval gated) · images:
    `gov-build-images.yml`

=== "IL5"

    Same `AZURE_GOV_*` + `FIAB_GOV_ADMIN_GROUP_ID` set as GCC-High — IL5 uses the
    Azure Government endpoints and the same secret names.

    Workflow: `deploy-fiab-il5.yml` · param file: `il5.bicepparam`
    (`deployAppsEnabled = true`)

    !!! danger "IL5 has never been executed"
        Measured 2026-08-13: `gh run list --workflow deploy-fiab-il5.yml` returns
        **nothing**. The lane is wired and its parameter file enables the app
        tier, but no run has ever produced a receipt. Treat every IL5 statement
        on this page as **unverified**, and expect to be the first to exercise
        it. A workflow that has never run is the loudest signal available, not a
        quiet pass.

**Verify the whole set at once:**

```bash
gh secret list    # names + timestamps only — values are never shown
gh variable list  # names + values (variables are not secrets)
```

---

## Part 3 — deploy: greenfield

**Greenfield** means the target subscription holds no Azure resource Loom would
adopt and no existing `rg-csa-loom-admin-*` hub. Every backing service is
created new.

Not sure? Run the read-only inventory — if it returns no candidates in any
subscription you intend to use, you are greenfield:

```bash
bash scripts/csa-loom/discover-services.sh
```

If it returns candidates, stop and use [Part 4 — brownfield](#part-4--deploy-brownfield)
instead. Greenfield working proves nothing about brownfield, and the two are
verified independently.

### Why this takes three phases

This is the single most common "is this a bug?" question, so it is answered
before the steps rather than after.

A fresh deploy creates an **empty** Azure Container Registry. The Console and its
sibling Container Apps reference `<newacr>.azurecr.io/loom-console:<tag>`. With
`deployAppsEnabled=true` against a brand-new registry, ARM tries to create those
apps before any image exists and every Container App PUT fails with a
manifest/pull error.

**That is expected, not a defect.** The image build is a required phase, and no
single one-shot deploy can collapse it, because the registry that must hold the
images is created by the same deployment that needs to pull from them. Phase 1
therefore overrides the parameter file with `deployAppsEnabled=false`.

<div class="grid cards" markdown>

-   :material-cube-outline: **Phase 1 — infrastructure** *(40–90 min)*

    Hub VNet, Private DNS, ACR, Container Apps Environment, Key Vault, and every
    Azure backing service. **Creates no Container Apps.**

-   :material-docker: **Phase 2 — images and apps** *(15–25 min)*

    Opens the private ACR, builds every image server-side with `az acr build`,
    re-locks the registry, brings the Container Apps up on the images it pushed.

-   :material-key-chain: **Phase 3 — post-deploy bootstrap** *(10–15 min)*

    The grants Bicep cannot make: the MSAL app registration, Synapse SQL admin,
    Purview roles, Databricks SCIM, the Spark private-endpoint fix.
    **Sign-in does not work until this runs.**

</div>

### Step 0 — verify the credentials before you spend anything

Dispatch a `whatif-only` run. It authenticates, validates the template against
your real tenant, and **provisions nothing**. This is the cheapest possible proof
that P1, P2 and P3 all landed.

```bash
gh workflow run deploy-fiab-commercial.yml \
  -f run_mode=whatif-only \
  -f region=<region>
```

!!! note "`region` is required and has no default"
    The region *is* the identity of the estate —
    `rg-csa-loom-admin-<region>`, `vnet-csa-loom-hub-<region>` and
    `uami-loom-console-<region>` all derive from it. A wrong region does not
    fail; it succeeds against a **different, empty estate**. GitHub rejects a
    dispatch that omits it.

**Confirm it worked:**

```bash
RUN_ID=$(gh run list --workflow deploy-fiab-commercial.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expect a green run whose title carries **`— DRY RUN (whatif-only, applies
nothing)`**. That marker is deliberate: it tells the deploy-staleness watchdog
this run changed nothing, so a dry run can never silence a real deploy gap.

### Phase 1 — infrastructure

Preview first. This is free and it catches CIDR, quota and SKU problems before
anything is created:

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox

GROUP_ID=$(az ad group show --group "Loom Admins" --query id -o tsv)

az deployment sub create \
  --location <region> \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false \
  --what-if
```

Then apply:

```bash
az deployment sub create \
  --name "csa-loom-phase1-$(date +%Y%m%d-%H%M)" \
  --location <region> \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false
```

**What this changes.** Creates `rg-csa-loom-admin-<region>` and the DLZ resource
groups, the hub VNet and Private DNS zones, the ACR, the Container Apps
Environment, Key Vault, and every Azure backend. It creates **no** Container Apps.

**How to confirm it worked:**

```bash
# The admin resource group exists and provisioning succeeded.
az group show --name "rg-csa-loom-admin-<region>" --query properties.provisioningState -o tsv
# Expect: Succeeded

# The ACR exists and is EMPTY — an empty repository list here is the CORRECT
# phase-1 outcome, not a failure.
ACR=$(az acr list --resource-group "rg-csa-loom-admin-<region>" --query "[0].name" -o tsv)
az acr repository list --name "$ACR" -o tsv | wc -l   # expect 0

# No Container Apps yet — also correct.
az containerapp list --resource-group "rg-csa-loom-admin-<region>" -o tsv | wc -l  # expect 0
```

!!! note "Resource-provider registration is not automatic on the by-hand path"
    Running `az deployment sub create` yourself does **not** register missing
    resource providers. `lib/setup/deploy-preflight.ts` *reads* registration
    state and *emits* the `az provider register --namespace <ns>` lines for any
    that are missing; automatic registration only happens on the CI deploy path,
    where `scripts/ci/deploy-retry.mjs --remediate` reads the namespace out of a
    `MissingSubscriptionRegistration` failure, registers it, and retries once.
    Either register up front, or dispatch the workflow instead of running the
    CLI by hand.

### Phase 2 — build the images and bring the apps up

```bash
gh workflow run full-app-deploy-commercial.yml \
  -f tag=v0.1 \
  -f region=<region>
```

Leaving `region` empty is supported here — the resolve job asks Azure Resource
Graph which `rg-csa-loom-admin-*` exists and targets that. Supply it only when
the subscription holds more than one admin plane.

**What this changes.** Temporarily opens the ACR firewall, runs `az acr build`
server-side for every app image, re-locks the registry, then re-runs the deploy
with `deployAppsEnabled=true` so the Container Apps are created on the images it
just pushed.

**How to confirm it worked:**

```bash
az acr repository list --name "$ACR" -o tsv          # now non-empty
az containerapp list --resource-group "rg-csa-loom-admin-<region>" \
  --query "[].{name:name,fqdn:properties.configuration.ingress.fqdn}" -o table

# The Console answers, and reports the commit it is running.
curl -s https://<your-console-hostname>/build-marker.txt
```

### Phase 3 — post-deploy bootstrap

```bash
gh workflow run csa-loom-post-deploy-bootstrap.yml \
  -f boundary=Commercial \
  -f region=<region> \
  -f admin_subscription=<subscription-id>
```

Leave `dlz_subscription` and `dlz_domain` empty — both are discovered from
Resource Graph across every subscription the deploy identity can read. Supply
them only to disambiguate an estate with several landing zones.

**What this changes.** Creates the MSAL app registration and writes its secret to
Key Vault, wires `LOOM_MSAL_CLIENT_ID` onto the Console, grants the Console
identity Synapse Administrator, registers it with Databricks via SCIM, assigns
Microsoft Graph application roles, and creates the AI Search governance index.

**How to confirm it worked:** open the Console in a browser and sign in. Sign-in
working *is* the verification — it exercises the app registration, the Key Vault
secret reference, and the redirect URI in one action. Then open `/admin/readiness`
and confirm your account can reach it; if `/admin/*` 403s, revisit
[P3](#p3--the-admin-binding).

---

## Part 4 — deploy: brownfield

**Brownfield** means your tenant already holds something Loom could use: a
Purview account, a shared AI Search, an ADLS lake, an existing VNet, or a
previous Loom hub. This is a **separate, complete path** — not a footnote on
greenfield. Silently deploying a second Purview beside yours is a violation; so
is failing because one exists.

The phase shape is identical to greenfield (infrastructure → images → bootstrap).
What differs is that a discovery and decision step comes first, and the values
you choose are supplied to phase 1.

### Step 1 — the multi-subscription analysis

Read-only. It spans every subscription the identity can read and reports what
exists, what Loom would use each one for, and what it would change about it.

```bash
bash scripts/csa-loom/discover-services.sh
```

**What this changes.** Nothing — it only reads. It emits ready-to-source
`EXISTING_*` exports for each reusable resource.

**How to confirm it worked:** it prints one candidate block per discovered
service. If it prints none, you are greenfield after all — go back to
[Part 3](#part-3--deploy-greenfield). Full detail of what it scans and the
permissions it needs is in
[Discovery and adoption](discovery-and-adoption.md).

### Step 2 — decide adopt / create / skip, per service

Three decisions per service, never assumed:

- **adopt** — use the existing resource. Loom binds to it and suppresses creating
  its own.
- **create** — deploy a new one alongside, deliberately.
- **skip** — do not provision at all; the dependent surfaces honest-gate.

The complete per-service table — which `EXISTING_*` variables each reads, which
`provision*` flag each suppresses, and the caveats — is in
[Brownfield → step 2](brownfield.md#step-2--choose-adopt-or-create-per-service).

!!! warning "Drive brownfield from the CLI, not the wizard (#3342)"
    The in-Console setup wizard gates its Deploy button on `planBlockers()`,
    which blocks every `adopt` decision that carries no fitness verdict — and no
    production code path attaches one. Because `recommendFor()` picks `adopt` by
    default whenever a candidate is found, that is the **default** outcome on a
    brownfield tenant, not an edge case. Use the CLI path below. Tracked in
    **#3342**.

### Step 3 — supply the values

Every boundary parameter file reads `readEnvironmentVariable('EXISTING_*', '')`,
so exporting the variables before the deploy is the supported input path — not an
undocumented override.

```bash
export EXISTING_PURVIEW=<purview-account-name>
export EXISTING_PURVIEW_RG=<resource-group>
export EXISTING_PURVIEW_SUB=<subscription-id>       # only when cross-subscription

export EXISTING_AI_SEARCH_SERVICE=<search-service-name>
export EXISTING_AI_SEARCH_RG=<resource-group>

# ...then phase 1 exactly as in greenfield, with deployAppsEnabled=false.
```

!!! note "Some `EXISTING_*` names are accepted but have no consumer"
    `EXISTING_STORAGE`, `EXISTING_POSTGRES`, `EXISTING_KEYVAULT`,
    `EXISTING_FIREWALL` are accepted by the discovery tooling but **no Bicep
    parameter reads them** — setting them has no effect at deploy time. Named
    here rather than left for you to discover by watching a second lake get
    created. The authoritative, re-measurable list is in
    [Brownfield → step 3](brownfield.md#step-3--supply-the-values).

### Step 4 — deploy into an existing Loom hub

If the subscription already holds a Loom hub, the topology guard rejects a
`tenant` deploy so a second Console can never be stamped. To reconcile the
existing hub in place:

```bash
gh workflow run deploy-fiab-commercial.yml \
  -f run_mode=full \
  -f region=<region> \
  -f allow_existing_hub=true
```

**What this changes.** Reconciles the existing admin resource group incrementally
and re-renders every `LOOM_*` env var on the Container Apps. It does **not** stamp
a second Console, and it does **not** tear anything down.

### Step 5 — what is validated, and what happens when it fails

Each adopted resource is validated for SKU, region, network reachability, and
whether the deploy identity holds (or can be granted) the RBAC it needs. When
validation fails you get the specific reason and the exact remediation, not a
generic failure. The per-service validation matrix and the failure behaviour are
in [Brownfield → step 4](brownfield.md#step-4--what-is-validated-per-service)
and [step 5](brownfield.md#step-5--what-happens-when-validation-fails).

---

## Part 5 — verify the deploy

Run these in order. Each answers a different question, and a later one passing
does not imply an earlier one did.

| # | Check | Command | Pass looks like |
|---|---|---|---|
| 1 | The infrastructure exists | `az group show -n rg-csa-loom-admin-<region> --query properties.provisioningState -o tsv` | `Succeeded` |
| 2 | The images exist | `az acr repository list --name <acr> -o tsv` | a non-empty list |
| 3 | The apps are running | `az containerapp list -g rg-csa-loom-admin-<region> --query "[].properties.runningStatus" -o tsv` | `Running` per app |
| 4 | The Console answers | `curl -s https://<console-host>/build-marker.txt` | a commit SHA |
| 5 | **The estate is not behind `main`** | `git log --oneline <that-sha>..origin/main \| wc -l` | `0` |
| 6 | Sign-in works | open the Console in a browser | you reach the home page |
| 7 | You are an admin | open `/admin/readiness` | it renders, not 403 |

!!! danger "Check 5 is the one people skip, and it is the one that bites"
    A merge is not a deploy. If check 5 returns a non-zero count, every fix
    merged in that window is **inert on your estate** — present in the repo,
    absent from the thing you are looking at. Report that state in exactly those
    words: *merged, not deployed*. This is
    [`deploy-integrity.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/.claude/rules/deploy-integrity.md)
    R2 and R3, and it exists because a live estate once sat eight merges behind
    `main` for two weeks while work continued around it.

---

## Part 6 — when a step fails

Failures are classified rather than dumped. The eight classes — transient,
eventual-consistency, registration, permission, quota, config, defect, unknown —
and the ARM codes that map to each are in
[Failure recovery](failure-recovery.md). The four you are most likely to meet on
a first deploy:

| Symptom | Class | What to do |
|---|---|---|
| `MissingSubscriptionRegistration` | registration | `az provider register --namespace <ns>`; re-run. The CI path does this automatically and retries once. |
| `MANIFEST_UNKNOWN` / image pull failure on a Container App | config | You ran phase 1 with `deployAppsEnabled=true` on an empty ACR. Re-run phase 1 with `deployAppsEnabled=false`, then phase 2. |
| `AuthorizationFailed` writing a role assignment | permission | The deploy SP is missing **User Access Administrator**. See [P2](#p2--the-deployment-identity). |
| `RoleAssignmentExists` on a re-deploy | transient/config | Dispatch with `-f skip_role_grants=true`. |
| The run refuses with *"No bootstrap tenant-admin binding could be resolved"* | config | Correct behaviour, not a bug. See [P3](#p3--the-admin-binding). |
| The run refuses on a region mismatch | config | The region you passed does not match the hub in the subscription. Pass the hub's actual region. |

!!! note "Two defaults worth knowing before you dispatch anything"
    - **`keep_resources` defaults `true`** — a `full` run **reconciles**; it does
      not destroy. Teardown additionally requires `confirm_teardown_rg` to equal
      the resolved admin resource group **exactly**. Assuming the opposite is
      dangerous in the other direction, so it is stated plainly here.
    - **`deploy_apps_enabled` defaults `true`** — a `full` run creates/updates
      the Container Apps and re-renders every `LOOM_*` env var on them. Set it
      `false` **only** for phase 1 of a from-scratch install, where the ACR is
      still empty.

---

## Per-cloud status — measured, not claimed

Re-measured **2026-08-13** with `gh run list`. Every row is command output.
`cloud-parity.md` forbids implying parity that has not been verified, so an
unverified lane says so.

| Lane | Last 3 runs | What that proves |
|---|---|---|
| `deploy-fiab-commercial` | in-progress · failure · success (all 2026-08-13) | Actively exercised. Mixed, so check the specific run you care about. |
| `full-app-deploy-commercial` | cancelled (08-13) · success (08-08) · failure (08-08) | The app tier has succeeded recently. A from-scratch phase 1→2→3 into a genuinely empty subscription **has not been performed for this revision**. |
| `deploy-fiab-gcc` | success · success · success | Green — **and deploys zero Container Apps** (#3078). Green here does not mean GCC serves Loom. |
| `deploy-fiab-gcch` | failure (08-13) · failure (08-12) · success (08-11) | Currently red. Read the run before trusting any GCC-High statement. |
| `deploy-fiab-il5` | **never run** | Entirely unverified. |
| `gov-build-images` | success · success (both 08-08) | The Gov image producer works standalone; unexercised as part of an end-to-end Gov install. |

Re-measure it yourself rather than trusting a published number — these drift with
every merge:

```bash
for wf in deploy-fiab-commercial full-app-deploy-commercial deploy-fiab-gcc \
          deploy-fiab-gcch deploy-fiab-il5 gov-build-images \
          csa-loom-post-deploy-bootstrap; do
  echo "== $wf"
  gh run list --workflow "$wf.yml" --limit 3 \
    --json conclusion,createdAt --jq '.[] | "\(.conclusion // "in-progress")  \(.createdAt[0:10])"'
done
```

A workflow that prints nothing has **never run**.

---

## Post-deploy tenant consents (optional, feature-scoped)

None of these block the deploy or sign-in. Each unlocks a specific surface, and
until it is done that surface shows an honest gate rather than a broken screen.
They are one-time and idempotent.

| Consent | Who | Unlocks |
|---|---|---|
| Grant the deploy SP `AppRoleAssignment.ReadWrite.All` on Microsoft Graph | Global Administrator or Privileged Role Administrator | `/admin/security` MIP + DLP tabs, the Identity Picker |
| Admin-consent `Azure Service Management / user_impersonation` on the MSAL app registration | Global Administrator or Application Administrator | Connections cross-subscription discovery |
| Tenant-root management group Reader for the deploy SP | Owner / UAA at the root MG | Connections cross-subscription enumeration |
| Add the Console identity as Power Platform Administrator | Power Platform admin centre | Power Platform + Copilot Studio surfaces |
| Enable the Power BI tenant SP setting | Fabric admin portal | The **opt-in** Power BI backend only — not required by default |

The full, copy-pasteable command for each is in
[v3 tenant bootstrap → day-one operator prerequisites](../v3-tenant-bootstrap.md#day-one-prereqs).
They are reproduced there rather than duplicated here so there is exactly one
copy to keep correct.

!!! note "Assigning a Graph app role to a managed identity *is* the grant"
    There is no separate "Grant admin consent" click for the Console identity —
    that is the app-registration pattern, not the managed-identity pattern. The
    only reason a human is involved at all is that the *deploy SP* needs
    `AppRoleAssignment.ReadWrite.All` before it can make those assignments
    unattended. Once granted, every subsequent bootstrap run does it for you.

---

## Where this page sits

This page is the spine: **prerequisites → deploy → verify**. The pages below are
depth, and each is linked from the relevant step above rather than competing with
it.

<div class="grid cards" markdown>

-   :material-sprout: [**Greenfield — full walkthrough**](greenfield.md)

    Every phase in detail, per-boundary command variants, and the region caveats.

-   :material-office-building-cog: [**Brownfield — full walkthrough**](brownfield.md)

    The complete adopt/create matrix, validation per service, and the open gaps.

-   :material-magnify-scan: [**Discovery and adoption**](discovery-and-adoption.md)

    What the scan reads, what Loom changes about an adopted service.

-   :material-lifebuoy: [**Failure recovery**](failure-recovery.md)

    The eight failure classes and the remediation for each.

-   :material-folder-network: [**Resource groups, naming and tags**](resource-groups.md)

    The naming contract and the teardown blast radius.

-   :material-key-chain: [**Tenant bootstrap**](../v3-tenant-bootstrap.md)

    The one-time tenant actions, in full.

</div>

---

## Found a prerequisite that should not exist?

That is the point of this page having a count at the top. If a step here asks you
to set a value, grant a role, or run a script that the **deploy could have done
itself**, it is a defect under `auto-bind-by-default.md` §5 — not a chore.

[File it](https://github.com/fgarofalo56/csa-inabox/issues/new) with the label
`csa-loom`, quoting the step and what you think the deploy should have produced.

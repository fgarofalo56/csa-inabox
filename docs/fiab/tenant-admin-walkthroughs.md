# Tenant-admin walkthroughs — the three optional one-time grants

CSA Loom is **fully functional on Azure-native backends without any of the
actions on this page.** Everything in the catalog installs, every editor runs,
and every probe returns real data using the Console User-Assigned Managed
Identity (UAMI) and the Azure RBAC that the deploy + bootstrap workflows grant
automatically. You do **not** need Microsoft Fabric, Power BI, Microsoft Graph
admin consent, or a Purview data-plane role for Loom to work.

What you get by doing the steps below is a small set of **opt-in tenant
integrations** that no deployment script can grant itself, because each one
requires a Global Administrator, a Fabric Administrator, or a Purview Collection
Administrator to click an approval that, by design, an automation principal
cannot self-approve. Do them only if you want the specific surface each one
lights up. Skip any you do not want; the corresponding surface shows an honest
Fluent MessageBar telling you exactly which grant is missing, and the rest of
Loom is unaffected.

I have ordered these from most to least commonly requested. Each section gives
you the exact script to run, the portal click-path, and (where relevant) the
admin-consent URL. Run the scripts from the repo root on a machine where you are
`az login`'d as an identity that holds the stated admin role.

Before you start, set the Console UAMI object id once so you can paste it into
every command:

```bash
# The Console UAMI's PRINCIPAL (object) id — NOT its client id. Find it with:
#   az identity show -g <admin-rg> -n <console-uami-name> --query principalId -o tsv
export CONSOLE_UAMI_PRINCIPAL="<console-uami-object-id>"
```

---

## (a) Microsoft Graph admin consent — MIP sensitivity labels + DLP

**Lights up:** the `/admin/security` Information Protection (MIP) and Data Loss
Prevention (DLP) tabs, so they read real sensitivity-label policies and DLP /
security-alert data from your tenant instead of rendering the "Graph consent
required" MessageBar.

**Who must do it:** a **Global Administrator** (only a Global Admin can grant
tenant-wide admin consent for application permissions on Microsoft Graph).

**Why a script can't finish it:** the script can *request* the app-role
assignments, but Microsoft Graph still requires a human Global Admin to grant
**admin consent**. An app principal cannot consent to its own permissions.

### Step 1 — request the app-role assignments

This grants the Console UAMI four Microsoft Graph **application** permissions:

| Permission | Purpose |
|---|---|
| `InformationProtectionPolicy.Read.All` | Read MIP sensitivity-label policies |
| `SensitivityLabel.Evaluate` | Evaluate labels for the MIP tab |
| `Policy.Read.All` | Read DLP / tenant policies |
| `SecurityAlert.Read.All` | Read DLP security alerts |

```bash
# Run as a user or SP that holds Application.ReadWrite.All on Microsoft Graph.
az login
CONSOLE_UAMI_PRINCIPAL="$CONSOLE_UAMI_PRINCIPAL" \
  ./scripts/csa-loom/grant-graph-approles.sh
```

The script is idempotent — re-running it reports "already granted" for any role
that exists.

### Step 2 — grant admin consent (Global Admin)

Have a Global Administrator open the Console UAMI's enterprise application and
grant consent:

1. Portal → **Microsoft Entra ID** → **Enterprise applications**.
2. Search for the Console UAMI by its name (or filter Application ID = the UAMI
   client id). Open it.
3. **Security → Permissions** → **Grant admin consent for `<your tenant>`**.
4. Confirm. The four Graph application permissions should now show a green
   "Granted for `<tenant>`" status.

Until that consent click happens, every Graph call returns 403 and the MIP / DLP
tabs show their explicit "Graph admin consent required" MessageBar — which is
the honest gate, not a bug.

> **Optional.** Skip this entire section if you don't use the `/admin/security`
> MIP/DLP tabs. The rest of Loom — including Purview classification, Defender
> remediations sourced from Azure, and every data editor — is unaffected.

---

## (b) Microsoft Purview classic Data Map role grant

**Lights up:** the Purview-backed catalog, glossary, lineage, collections, and
scan surfaces, so they read/write your real Purview **classic Data Map** instead
of showing the "grant the Console UAMI a Data Map role" MessageBar.

**Who must do it:** a **Purview Collection Administrator** on the target Purview
account (run `az login` as that identity, or as the `limitlessdata_deploy` SP
after a one-time human Collection-Admin grant).

**Why a script can't finish it:** classic Data Map permissions are **not ARM
RBAC** — `az role assignment create` does nothing for them. Since August 2021
they live in the account's **collection metadata policy** (a data-plane object),
and only an existing Collection Administrator can edit that policy to add a new
principal.

### Run it

```bash
# As a Purview Collection Admin on the account. Requires `jq`.
az login
PURVIEW_ACCOUNT="<your-purview-account-name>" \
CONSOLE_UAMI_PRINCIPAL="$CONSOLE_UAMI_PRINCIPAL" \
  ./scripts/csa-loom/grant-purview-datamap-role.sh        # Data Curator (default)
```

Variations:

```bash
# Read-only role (e.g. for the MIP label-on-download read path):
ROLE=data-reader PURVIEW_ACCOUNT="<acct>" \
CONSOLE_UAMI_PRINCIPAL="$CONSOLE_UAMI_PRINCIPAL" \
  ./scripts/csa-loom/grant-purview-datamap-role.sh

# US Gov clouds (GCC-High / IL5 / DoD) — the script auto-targets the .us Data
# Map host; force it explicitly if your az context is ambiguous:
PURVIEW_CLOUD=AzureUSGovernment PURVIEW_ACCOUNT="<acct>" \
CONSOLE_UAMI_PRINCIPAL="$CONSOLE_UAMI_PRINCIPAL" \
  ./scripts/csa-loom/grant-purview-datamap-role.sh
```

The script GETs the root-collection metadata policy, adds the UAMI's object id
to the chosen built-in role's attribute rule, and PUTs the policy back. It is
idempotent — if the UAMI is already in the rule it reports no change.

### Portal alternative (Data Curator)

If you prefer the UI: Purview portal → **Data Map → Roles and collections →
Collections** → select the **root collection** → **Role assignments** → add the
Console UAMI to **Data Curators** (and **Data Readers** if you want read-only
surfaces to light up independently).

> **Optional.** Skip this if you don't use the Purview-backed catalog surfaces.
> Loom's Azure-native classification taxonomy and the rest of the catalog work
> without a Purview Data Map role.

---

## (c) Microsoft Fabric — "service principals can use Fabric APIs" + workspace add

**Lights up:** the **opt-in** Fabric / Power BI backends. Loom never needs these.
Every Loom item type runs on its Azure-native default (lakehouse → ADLS Gen2 +
Delta, warehouse → Synapse, eventhouse/KQL → Azure Data Explorer, semantic-model
/ report → the Loom-native tabular + report renderer, capacities → no binding at
all). You only do this if you have *deliberately* opted an item into its Fabric
backend with `LOOM_<ITEM>_BACKEND=fabric` and want Loom to drive your real
Fabric tenant.

**Who must do it:** a **Fabric Administrator** (tenant setting) plus a
**workspace Admin/Member/Contributor** (workspace add). These are Fabric-portal
actions with no ARM/script equivalent — the Fabric admin portal is the only
place the tenant SP toggle exists, and only a workspace admin can add a
principal to a workspace.

**Why a script can't finish it:** the "service principals can use Fabric APIs"
toggle is a tenant governance setting changed only through the Fabric admin
portal, and Fabric workspace membership is granted only by a workspace admin.
Neither is exposed to ARM or the Azure CLI.

### Step 1 — enable the tenant setting (Fabric Admin)

1. Open the **Fabric admin portal**: <https://app.fabric.microsoft.com/admin-portal/tenantSettings>
   (US Gov: `https://app.fabric.microsoft.us/admin-portal/tenantSettings`).
2. Go to **Tenant settings → Developer settings**.
3. Enable **"Service principals can use Fabric APIs"** (also shown as "Service
   principals can use Power BI APIs").
4. Scope it to a **specific security group** and add the Console UAMI's service
   principal to that group (recommended over enabling for the whole org).
5. **Apply.** Tenant-setting changes can take up to ~15 minutes to propagate.

### Step 2 — add the Console UAMI to each Fabric workspace

For every Fabric workspace you want Loom to drive:

1. Open the workspace in Fabric → **Manage access**.
2. **Add people or groups** → search for the Console UAMI (by name or its
   service-principal app id) → assign **Admin**, **Member**, or **Contributor**
   (Contributor is enough for most item operations).
3. Save.

### Step 3 — point Loom at the Fabric backend (opt-in env)

Fabric stays dormant until you explicitly select it. Set the relevant opt-in
env var(s) on the Console app and bind a workspace, for example:

```bash
# Examples — set ONLY the backends you want to switch from Azure-native to Fabric:
LOOM_CAPACITY_BACKEND=fabric        # surface real Fabric/Power BI capacities in scaling + workspace settings
LOOM_DEFAULT_FABRIC_WORKSPACE=<fabric-workspace-guid>   # the workspace the UAMI was added to
# Per-item opt-ins follow the same LOOM_<ITEM>_BACKEND=fabric pattern, e.g.:
#   LOOM_SEMANTIC_MODEL_BACKEND=fabric, LOOM_DOMAINS_BACKEND=fabric, LOOM_ACTIVATOR_BACKEND=fabric
```

With none of these set, Loom uses the Azure-native path silently. In
particular, the workspace-settings **Capacity** dropdown and the Scale-by-SKU
**Fabric / Power BI capacities** list are simply empty on the default path —
Loom does **not** call `api.fabric.microsoft.com` and does **not** ask you to
enable the Fabric SP toggle. The capacities list populates only after you set
`LOOM_CAPACITY_BACKEND=fabric` and complete Steps 1–2 above.

> **Optional, and the least-needed of the three.** Leaving Fabric untouched is
> the supported, fully-functional default. Enable it only for a deliberate
> Fabric/Power BI integration.

---

## What you should see afterward

| You did | Surface that flips from gated to live |
|---|---|
| (a) Graph consent | `/admin/security` MIP + DLP tabs read real tenant policy data |
| (b) Purview role | Catalog / glossary / lineage / scan read+write your classic Data Map |
| (c) Fabric toggle + workspace add + opt-in env | The selected `LOOM_<ITEM>_BACKEND=fabric` items drive your real Fabric tenant |

If any surface still shows its MessageBar after you complete a section, the
MessageBar names the precise missing piece (a role, an env var, or the consent
click) — read it and re-run the matching step. None of these gates ever block
the Azure-native default; they only unlock the opt-in integration.

See also `docs/fiab/v3-tenant-bootstrap.md` for the broader one-time tenant
bootstrap context, and `.claude/rules/no-fabric-dependency.md` for the standing
rule that keeps every Loom item working without a real Fabric capacity or
workspace.

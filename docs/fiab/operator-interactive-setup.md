# CSA Loom — Operator: interactive setup steps

**Almost nothing on this page is required.** A push-button deploy plus
`csa-loom-post-deploy-bootstrap.yml` leaves Loom fully functional on its
Azure-native backends: every item type installs, every editor runs, and every
probe returns real data using the Console User-Assigned Managed Identity (UAMI)
and the RBAC the deploy + bootstrap grant automatically.

What remains here is the short list of actions the platform genuinely **cannot**
perform for you, because Microsoft requires a human administrator context for
them. Each one is registered in the in-product gate registry with an inline
**Fix it**, so you can also resolve them from `/admin/gates` rather than from
this page.

!!! info "What the bootstrap now does for you"
    Two steps that used to live on this page as portal click-paths are performed
    by `csa-loom-post-deploy-bootstrap.yml`:

    - **Power Platform Administrator directory role** → assigned to the Console
      UAMI via Microsoft Graph (`roleManagement/directory/roleAssignments`,
      role template id `11648597-926c-4cf3-9c36-bcebb0ba8dcc`). Idempotent.
    - **Dataverse Application User** → registered on every environment that has
      a Dataverse database, via `scripts/csa-loom/dataverse-add-appuser.sh`.
      Idempotent.

    Do not perform either by hand. If a surface still gates after a bootstrap
    run, read the job log — each step prints exactly what it established and, on
    a permission failure, the one-time tenant action that unblocks it.

!!! note "Fabric and Power BI are opt-in, and are not on this page"
    Under [`no-fabric-dependency.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/.claude/rules/no-fabric-dependency.md)
    Fabric and Power BI are never a default dependency — the semantic-model,
    report, dashboard, paginated-report and scorecard surfaces all run on the
    Azure-native tabular + report path with no loss of function. The Fabric
    tenant toggle ("Service principals can use Fabric APIs"), the Power BI
    tenant settings, and the per-workspace membership adds therefore belong to
    the **opt-in** path, not to interactive setup. They are documented in
    [Tenant-admin walkthroughs → (c) Microsoft Fabric](tenant-admin-walkthroughs.md),
    together with the `LOOM_BI_BACKEND` / `LOOM_<ITEM>_BACKEND=fabric` switches
    that activate them. Do not enable them as part of a normal deployment.

**Target principal for the grants below:**

- **UAMI display name:** `<console-uami-name>`
- **UAMI client (application) id:** `<YOUR_CONSOLE_UAMI_CLIENT_ID>`
- **UAMI object (principal) id:** `<YOUR_CONSOLE_UAMI_PRINCIPAL_ID>`

When a UI asks "user / group / service principal", choose **Service principal**
and search by display name or client id.

---

## 1. Power Platform management-app registration *(genuinely human-only)*

**Unlocks:** Power Apps, Power Automate flow, Dataverse table, AI Builder model,
Power Page, Power Platform environment, and the whole Copilot Studio family
(agent, knowledge, topic, action, channel, analytics, template library).

**Why the platform cannot do it.** Microsoft documents this constraint
explicitly: *"A service principal can't register itself. By design, an
administrator using username and password context must register the
application."*
— [Creating a service principal application using API](https://learn.microsoft.com/power-platform/admin/powerplatform-api-create-service-principal)

This is separate from the Power Platform Administrator **directory role**, which
the bootstrap now assigns for you. The bootstrap also *attempts* the management-app
PUT on every run, so on a tenant where the deploy principal is already a
registered management app there is nothing left to do — check the job log first.

**Who must do it:** a Power Platform Administrator or Global Administrator,
signed in as a **user**.

```bash
# Run once, signed in as a Power Platform / Global admin (NOT as the deploy SP):
APP_ID=<YOUR_CONSOLE_UAMI_CLIENT_ID> bash scripts/csa-loom/grant-powerplatform-sp.sh
```

The PowerShell equivalent is `New-PowerAppManagementApp -ApplicationId <appId>`.

**In-product Fix-it:** `/admin/gates` → gate `svc-powerplatform` (kind
`role-grant`) carries this as a one-click action with the same instructions.

**Verify:** Exercise → *Power Platform — list environments* on the admin panel
returns a real environment list. Entra → Power Platform propagation of the
directory role can take 5–15 minutes after a bootstrap run, so retry once before
concluding the registration failed.

---

## 2. Dataverse per-environment prerequisites *(partly human-only)*

Microsoft Dataverse is a per-environment add-on. Loom uses the MSAL Web App SP
(`LOOM_MSAL_CLIENT_ID`) — *not* the UAMI — for all `*.crm.dynamics.com` calls,
because Dataverse's Application User feature accepts Entra app registrations
only, not managed identities.

### 2a — Add a Dataverse database to the environment *(human; cost-material)*

This provisions a paid per-environment add-on, so it stays an explicit operator
decision rather than something the deploy takes on your behalf.

1. Open the Power Platform admin centre → **Environments**.
2. Select the target environment.
3. If the **Dataverse** column reads **No** → **+ Add Dataverse**. Pick Language
   and Currency; leave "Deploy sample apps and data" off.
4. **Add.** Provisioning takes 5–10 minutes; refresh until State = **Ready**.

Once ready, Loom discovers the environment URL automatically via the BAP admin
API — there is nothing to copy or paste.

### 2b — Promote yourself to Dataverse System Administrator *(human)*

Only needed for environments where Dataverse was added **after** the environment
was created (this includes any Default environment). A brand-new environment
auto-promotes its creator; an existing one leaves you with only
`Environment Maker + Basic User`, and the automated Application User
registration cannot run without System Administrator.

1. Open `https://<org>.crm.dynamics.com/main.aspx?settingsonly=true&pagetype=entitylist&etn=systemuser`
   — `<org>` is the environment's Dataverse host from the admin-centre detail page.
2. Tick the checkbox next to your name.
3. **Promote To Admin** in the command bar → **OK**.

### 2c — Register the MSAL SP as an Application User *(automated — do not do this by hand)*

`csa-loom-post-deploy-bootstrap.yml` runs
`scripts/csa-loom/dataverse-add-appuser.sh` on every run. It discovers every
environment in the tenant that has a Dataverse database, creates the Application
User for the MSAL SP, and assigns System Administrator on each. It is idempotent.

If the step reports incomplete, the usual cause is 2b not yet done on one of the
environments — the job log names it. Re-run the bootstrap after promoting.

### Optional — Copilot Studio per-environment enablement

The `copilot-studio-*` editors additionally require Copilot Studio to be enabled
on the environment (a separate per-environment add-on with its own consumption
tier). Until then the editor renders an honest "Copilot Studio not enabled"
MessageBar. Enable at: admin centre → environment → **Settings** → **Product** →
**Features** → **Copilot Studio**.

See [`dataverse-app-user.md`](dataverse-app-user.md) for the full background.

---

## 3. Optional infrastructure not in the default parameter set

Two editors are gated on Azure resources the default `commercial-full.bicepparam`
does not deploy. Both gates are registered with in-product Fix-its — prefer
`/admin/gates` over hand-running CLI, so the value is written through the one
shared env-apply path and audited.

| Surface | Gate | What it needs |
|---|---|---|
| `/items/content-safety/new` | Content Safety endpoint | A `Microsoft.CognitiveServices/accounts` of kind `ContentSafety`, plus **Cognitive Services User** for the Console UAMI |
| Workspace settings → **Sensitivity** | Purview account | A `Microsoft.Purview/accounts`, plus **Purview Data Reader** for the Console UAMI |

To deploy them as part of the push-button path instead, enable them in your
`.bicepparam` and redeploy — that is the preferred route, because a value set by
hand on a Container App is reverted the next time the bicep is re-rendered.

---

## 4. From-scratch recipe

```bash
# 1. Provision infrastructure (no apps yet — the ACR is empty on a fresh sub)
az deployment sub create \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam \
  -p deployAppsEnabled=false \
  -l <region>

# 2. Build + push app images and bring the Container Apps up
gh workflow run full-app-deploy-commercial.yml --ref main

# 3. Bootstrap: sign-in wiring + every data-plane grant, including the
#    Power Platform Administrator role and the Dataverse Application User
gh workflow run csa-loom-post-deploy-bootstrap.yml --ref main

# 4. Sign in. Nothing further is required — the apps catalog and the workloads
#    catalog both self-seed on first read from inside the VNet.
```

Step 4 previously asked you to `POST /api/admin/bootstrap-catalogs` from the
browser dev console. That is no longer necessary: `GET /api/apps-catalog` and
`GET /api/workloads-catalog` each carry a seed-derived backstop that populates
any missing curated entry on first read. The admin route still exists for an
explicit re-seed of the `GLOBAL` tenant, but it is not part of first-run setup.

Only the items in sections 1–2 above remain, and only where they apply to your
tenant.

---

## Verifying

Re-run the audits after any grant. All three read the live estate:

```bash
SESSION_SECRET="<minted>" node apps/fiab-console/tests/uat-v3.mjs
SESSION_SECRET="<minted>" node apps/fiab-console/tests/service-health.mjs
SESSION_SECRET="<minted>" node apps/fiab-console/tests/walkthrough.mjs
```

`/admin/gates` is the authoritative live view: every gate on this page appears
there with its current status and its Fix-it. A gate that is green there needs
nothing from this document.

[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Tenant Onboarding**

# Tenant Onboarding Runbook (CSA-0059)


!!! note
    **Quick Summary**: End-to-end procedure to onboard a new tenant (new customer domain, new regulated workload) onto CSA-in-a-Box — create the Entra ID app registration, wire OIDC federated credentials, provision the DLZ (Data Landing Zone) via Bicep, assign RBAC from the governance matrix, seed the marketplace, and run the post-onboarding verification.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#-contact-information) table.
- [ ] Confirm which management groups + subscriptions a new tenant gets
      (ALZ → Platform / LandingZones / Corp / Online).
- [ ] Confirm the CSA-in-a-Box naming convention file
      (`deploy/bicep/common/naming.bicep`) covers your tenant prefix scheme.
- [ ] Confirm your organization's Entra ID app-registration approval path
      (most orgs require Security sign-off for new app regs).
- [ ] Confirm the ATO / compliance boundary applies — Gov / IL4 tenants
      follow §7, not §6.

## 📑 Table of Contents

- [📋 1. Scope](#-1-scope)
- [🔒 2. Severity & SLA](#-2-severity--sla)
- [🧭 3. Prerequisites](#-3-prerequisites)
- [🚀 4. Onboarding Steps](#-4-onboarding-steps)
  - [4.1 Collect tenant intake form](#41-collect-tenant-intake-form)
  - [4.2 Register the domain / custom DNS](#42-register-the-domain--custom-dns)
  - [4.3 Create the Entra ID app registration](#43-create-the-entra-id-app-registration)
  - [4.4 Wire OIDC federated credentials for CI](#44-wire-oidc-federated-credentials-for-ci)
  - [4.5 Provision the Data Landing Zone (DLZ)](#45-provision-the-data-landing-zone-dlz)
  - [4.6 Assign RBAC from governance matrix](#46-assign-rbac-from-governance-matrix)
  - [4.7 Seed the marketplace](#47-seed-the-marketplace)
  - [4.8 Wire the Purview collection](#48-wire-the-purview-collection)
- [🪖 5. Azure Government Variations](#-5-azure-government-variations)
- [✅ 6. Post-Onboarding Verification](#-6-post-onboarding-verification)
- [🧹 7. Offboarding](#-7-offboarding)
- [📋 8. Evidence Preservation](#-8-evidence-preservation)
- [📎 9. Contact Information](#-9-contact-information)
- [🗓️ 10. Drill Log](#️-10-drill-log)
- [🔗 11. Related Documentation](#-11-related-documentation)

---

## 📋 1. Scope

Covers onboarding of a **new tenant** to a shared CSA-in-a-Box control
plane. A tenant is one logical customer / workload / regulated boundary
that gets its own DLZ, its own Purview collection, its own Entra ID app
registration, and a dedicated RBAC slice.

Out of scope: internal developer onboarding (see CONTRIBUTING.md),
single-user RBAC additions to an existing tenant (use the access-request
flow in the portal's marketplace UI instead).

---

## 🔒 2. Severity & SLA

| Item                             | Target                                  |
| -------------------------------- | --------------------------------------- |
| Total onboarding time (standard) | 5 business days                         |
| Total onboarding time (Gov / IL4)| 15 business days (ATO dependency chain) |
| DLZ deploy time                  | 60-120 minutes (Bicep what-if + deploy) |
| RBAC propagation time            | 15-60 minutes (AAD eventual consistency)|
| Purview collection propagation   | 30-90 minutes                           |

If you are not tracking to this SLA, escalate at day 3 to the Platform
Team Lead.

---

## 🧭 3. Prerequisites

- [ ] Tenant intake form signed off (template: `docs/templates/tenant-intake.md` *if present; otherwise request from ops*).
- [ ] Subscription IDs provisioned by the ALZ platform team (4
      subscriptions — data, integration, management, sandbox — or the
      subset agreed with the tenant).
- [ ] Owner-level access on each subscription for the onboarding operator.
- [ ] Global Admin or Privileged Role Administrator in Entra ID for the
      tenant's home directory.
- [ ] Purview account accessible (see `csa_platform/purview_governance/`).
- [ ] Key Vault + Managed Identity for the tenant's secret-rotation Function.

---

## 🚀 4. Onboarding Steps

### 4.1 Collect tenant intake form

Required fields:

- Tenant short name (used in naming convention, e.g. `contoso`, `acme`).
- Regulatory class (commercial / FedRAMP Moderate / FedRAMP High / IL4 / IL5 / CMMC 2.0 L2 / HIPAA).
- Cloud (Azure Commercial / Azure Government).
- Expected data classes (PII, PHI, CUI, FOUO, ITAR).
- Primary domain (`acme.com`, `contoso.gov`).
- Data domains the tenant will own (map to `domains/` in the repo).
- Expected data volume (TB/month) and retention horizon.
- Named RBAC actors: tenant admin, data owner, data steward, data consumer group IDs.

### 4.2 Register the domain / custom DNS

- [ ] Add the tenant's custom domain to Entra ID (Entra Admin Center → Custom domain names → Add).
- [ ] Add the DNS TXT challenge record to the tenant's zone.
- [ ] Verify the domain.
- [ ] For the portal: register `portal-<tenant>.csa-platform.example.com` as a CNAME to the AKS ingress controller.

### 4.3 Create the Entra ID app registration

```bash
az ad app create \
  --display-name "csa-portal-<tenant>" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://portal-<tenant>.csa-platform.example.com/auth/callback"

# Capture the resulting app (client) ID
APP_ID=$(az ad app list --display-name "csa-portal-<tenant>" --query '[0].appId' -o tsv)
az ad sp create --id "$APP_ID"
```

- [ ] Add the required API permissions: `User.Read`, `offline_access`,
      `openid`, `profile`, and any tenant-specific Microsoft Graph
      permissions.
- [ ] Request admin consent (must be a Privileged Role Administrator).
- [ ] Store the app ID + tenant ID in Key Vault:
      ```bash
      az keyvault secret set --vault-name kv-csa-<env> --name "<tenant>-app-id" --value "$APP_ID"
      ```

### 4.4 Wire OIDC federated credentials for CI

Per the 4-subscription deploy pattern (see `docs/IaC-CICD-Best-Practices.md`
§2.2), do **not** create a client secret — wire a GitHub OIDC federated
credential so the deploy workflow authenticates via tokens.

```bash
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters '{
    "name": "github-deploy-<tenant>",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<org>/<repo>:environment:<env>",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### 4.5 Provision the Data Landing Zone (DLZ)

The DLZ is the Bicep module set under `deploy/bicep/` — landing zone,
corp, data, integration, management. Deploy what-if first, then execute.

```bash
# From repo root with AZ creds loaded for the tenant subscription
bash scripts/deploy/deploy-platform.sh --environment <env> --dry-run
# Review the what-if diff with the tenant security officer
bash scripts/deploy/deploy-platform.sh --environment <env>
```

- [ ] Confirm the DLZ deployed successfully:
      ```bash
      az deployment sub list --query '[?name==`csa-platform-<env>`][0]'
      ```
- [ ] Confirm Policy assignments have evaluated — any non-compliant
      resources will fail ATO review.

### 4.6 Assign RBAC from governance matrix

Per `governance/common/`, RBAC is defined declaratively in
`governance/contracts/<tenant>.yaml`. Never assign roles ad-hoc via the
portal — every role assignment must flow through IaC so it is auditable.

- [ ] Create `governance/contracts/<tenant>.yaml` from the template.
- [ ] Fill in the tenant admin, data owner, data steward, data consumer
      groups from §4.1.
- [ ] Run the contract apply step:
      ```bash
      python -m governance.contracts apply --tenant <tenant> --dry-run
      python -m governance.contracts apply --tenant <tenant>
      ```
- [ ] Confirm assignments in Entra ID; note AAD eventual-consistency
      delay can be 15-60 minutes.

### 4.7 Seed the marketplace

- [ ] Register the tenant's initial data products in the marketplace via
      the portal CLI (`python -m cli marketplace ...`) or via the
      governance contract apply.
- [ ] Confirm visibility at `https://portal-<tenant>.csa-platform.example.com/marketplace`.

### 4.8 Wire the Purview collection

- [ ] Create a Purview collection per tenant under the root collection.
- [ ] Assign the tenant data steward as the collection admin.
- [ ] Register the tenant's ADLS account(s), Synapse workspace, and
      Cosmos accounts into the collection.
- [ ] Kick off an initial scan; confirm results land on the tenant's
      marketplace page.

---

## 🪖 5. Azure Government Variations

For Azure Government (IL4 / IL5) tenants, the flow above is materially
different at the following points:

- Use the Gov deploy pipeline (`.github/workflows/deploy-gov.yml`) and
  `deploy/bicep/gov/` params.
- Entra ID app registration happens in the Gov tenant (`login.microsoftonline.us`).
- Domain verification records use the `.us` endpoints.
- Some CAF services (e.g., Fabric) are forecast but not GA — confirm the
  [Gov Service Matrix](../GOV_SERVICE_MATRIX.md) before promising features.
- ATO paperwork (see `docs/COMPLIANCE.md`) is on the critical path — no
  production data lands before the ATO package is signed.

---

## ✅ 6. Post-Onboarding Verification

- [ ] Smoke test: `make sample-up NAME=<tenant-vertical>` (or the tenant's own verification script).
- [ ] Confirm the tenant admin can log in at `portal-<tenant>.csa-platform.example.com`.
- [ ] Confirm the tenant admin can see the seeded marketplace products.
- [ ] Confirm the tenant data steward can approve an access request.
- [ ] Confirm `AzureActivity` shows the tenant admin's Graph calls.
- [ ] Confirm Purview scan results are visible.
- [ ] File a completion ticket with the tenant admin copied; include the
      app ID, subscription IDs, Purview collection, and portal URL.

---

## 🧹 7. Offboarding

When a tenant departs, reverse §4 in the order below:

1. Revoke the Entra ID app registration's API permissions.
2. Remove OIDC federated credentials.
3. Delete (or soft-delete + retain per contract) the DLZ subscriptions.
4. Archive the Purview collection.
5. Export marketplace history for the tenant's records.
6. Delete Key Vault entries for the tenant.
7. Remove the governance contract file from `governance/contracts/`.
8. File a ticket confirming offboarding is complete.

---

## 📋 8. Evidence Preservation

Onboarding creates an auditable artifact chain. Preserve:

- [ ] The intake form PDF.
- [ ] The what-if diff produced by `deploy-platform.sh --dry-run`.
- [ ] The app registration's audit log entries.
- [ ] The governance contract file + its PR link.
- [ ] The Purview collection creation event.
- [ ] The completion ticket.

Audit cadence: verify every tenant's artifact chain once per quarter.

---

## 📎 9. Contact Information

!!! warning
    **Action Required:** Populate these before first production use.

| Role                       | Contact                                      | Phone                        | Escalation                     |
| -------------------------- | -------------------------------------------- | ---------------------------- | ------------------------------ |
| Platform Team Lead         | *(set via your org's platform team)*         | *(see PagerDuty / OpsGenie)* | First responder                |
| Security Officer           | *(set via your org's security team)*         | *(see PagerDuty / OpsGenie)* | Entra ID / app-reg approvals   |
| ALZ / Subscription Owner   | *(set via your org's ALZ team)*              | *(office hours)*             | Subscription provisioning      |
| Purview Admin              | *(set via your org's governance team)*       | *(office hours)*             | Purview collection setup       |
| Customer Success           | *(set via your org's customer success DL)*   | *(office hours)*             | Tenant-facing communication    |
| Azure Support              | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | Platform issues |

---

## 🗓️ 10. Drill Log

Tabletop this runbook once per quarter against a scratch tenant so
the procedure stays current with Azure platform changes.

| Quarter   | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| --------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## 🔗 11. Related Documentation

- [Key Rotation](./key-rotation.md) — Rotate the tenant's creds on cadence
- [Security Incident](./security-incident.md) — Tenant-scoped incident response
- [Break-Glass Access](./break-glass-access.md) — Emergency admin for a tenant
- [Gov Service Matrix](../GOV_SERVICE_MATRIX.md) — Gov feature availability
- [IaC/CI-CD Best Practices](../IaC-CICD-Best-Practices.md) — OIDC federated credentials, deploy stacks
- [Compliance](../compliance/README.md) — ATO / regulatory dependency chain

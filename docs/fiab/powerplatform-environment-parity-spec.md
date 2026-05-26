# Power Platform Environment Editor — admin-centre parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Power Platform admin centre · BAP admin API · Dataverse capacity-storage docs · DLP policy reference) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerPlatformEnvironmentEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working BAP admin REST CRUD for listing and reading environments (UAT-verified); this spec compares Loom's current surface against the full Power Platform admin centre Environments UX.

## Overview

A Power Platform **environment** is the top-level container for everything Power Platform: Dataverse database, Power Apps (canvas + model-driven), Power Automate flows, Power Pages sites, Copilot Studio agents, Dataverse for Teams, Dynamics 365 first-party apps, AI Builder models, and dataflows. Environments are managed at `admin.powerplatform.microsoft.com` and via the BAP admin REST API (`api.bap.microsoft.com`). Every environment has a SKU (Default · Production · Sandbox · Trial · Developer · Trial subscription-based · Teams), a region, an optional Dataverse data store, capacity assignment (database · file · log MB), a security group binding (governs which users can sign in), Data Loss Prevention (DLP) policy bindings, and a set of installed Dynamics 365 / Power Platform apps. Environments are the unit of governance, lifecycle (backup / copy / reset / restore), DLP enforcement, capacity accounting, and tenant isolation.

## Power Platform admin centre UX

### Environments grid (landing)
- Columns: **Name** · **Type** (SKU) · **State** (Ready · NotReady · Disabled · Soft-deleted) · **Region** · **Dataverse URL** · **Created on** · **Created by** · **Security group**
- Command bar: **+ New** · **Recover** (restore soft-deleted) · **Refresh** · **Export to CSV** · **Group by** (type / region / state)
- Per-row context menu: Edit · Backups · Copy · Reset · Delete · Manage user · See administration mode

### Environment detail — Settings hub
A landing hub with cards grouped into:

| Group | Cards |
|---|---|
| **Product** | Behavior · Features · Languages · Privacy + Security · Email · Sessions · Currencies · Calendar |
| **Business** | Business closures · Business units · Calendar · Connection roles · Currencies · Subjects |
| **Users + permissions** | Users · Teams · Application users · Security roles · Field security profiles · Hierarchy security · Position hierarchy |
| **Audit and logs** | Audit settings · Audit log management · System jobs · Plug-in trace log |
| **Email** | Mailboxes · Email server profiles · Email settings · Mailbox alerts |
| **Templates** | Document · Email · Mail merge · Article · Contract |
| **Resources** | Dynamics 365 apps · Portals · Power Pages sites · Dataverse Search · Capacity add-ons |
| **Integration** | Microsoft Sales Copilot · Server-side sync · Outlook · SharePoint · OneDrive · OneNote · Teams |
| **Dataverse** | Tables · Choices · Solutions · Dual-write · Power Fx · Encryption · Long-term retention |

### Capacity card
- **Database**, **File**, **Log** usage with `Used / Allocated / Total` MB
- Donut chart per axis
- **Approved capacity** override (from CoE add-on)
- Top consumers (table-level)
- Capacity alert thresholds (80%, 100%)

### DLP policies card
- Count of policies bound to this env (Include vs Exclude scope)
- List with `Policy name · Scope · Owner · Last modified`
- Per-policy: Business / Non-business / Blocked connector groups, custom connector pattern URL rules

### Security group + access
- Security group: `displayName · id · sync state · member count`
- `Edit` opens AAD group picker
- Toggle: open access (no group) vs restricted

### Backups / Copy / Reset / Restore
- **Backups**: system + manual list with retention, restore-to-this-env, restore-to-new-env
- **Copy**: Full / Minimal (data) · target picks any sandbox env
- **Reset**: wipe data, keep customizations, choose template
- **Restore**: from a backup point

### Administration mode
- Toggle: only env admins can sign in
- Background ops disabled
- Use during data import or large customizations

### Audit log
- Toggle audit on/off per table
- View audit history, export, retention policy

### Pay-as-you-go billing
- Link environment to an Azure subscription for Dataverse + Power Apps consumption billing
- Choose Azure subscription · resource group · region

### Application users (service principals)
- List of registered SP Application Users
- Per-row: AAD App ID · Security roles · Team · Business unit · Enabled?
- `+ New app user` — pick AAD app, business unit, security roles
- This is the entry point Loom relies on for its MSAL Web App SP

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerPlatformEnvironmentEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **List environments** — `GET /providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01` (BAP admin REST, UAMI auth) → flat list across the tenant the UAMI SP can see
- **Environment dropdown picker** with display name, SKU, region, env GUID; default-env preference
- **Get environment** — `GET .../environments/{name}?$expand=permissions,properties/billingPolicy` returns full metadata
- **Detail metadata grid** — SKU badge · State · Location · Default-env? · Dataverse domain (`<org>.crm.dynamics.com`) · Instance URL (`https://<org>.crm.dynamics.com/`)
- Inline Caption1 explains that capacity / security-group / DLP summary requires Power Platform Admins role on the UAMI SP
- Reload button + error MessageBar with `hint` for 401/403 (add SP to "Service principals can use Power Platform APIs" + Application User on env)
- Ribbon stub: Reload · Open in Power Platform (labels only, no handler)

## Gaps for parity

1. **No grid view** — Loom shows a single dropdown + detail card; no sortable grid with all envs, no group-by, no CSV export
2. **No `+ New environment` create flow** — can't provision an env (name · region · SKU · language · currency · URL · add-Dataverse · pay-as-you-go) from Loom
3. **No Edit / Delete / Recover / Reset** — read-only today; no edit-display-name, no delete-env, no recover-soft-deleted, no reset-to-template
4. **Capacity card** — `capacity` field is mapped in client but not rendered; no Database / File / Log usage chart, no approved-capacity override
5. **DLP policy summary** — `dlpPolicySummary` is null in the mapper; no policy count, no policy list, no per-policy connector-group breakdown
6. **Security group** — `securityGroup` is mapped but only ID/name shown when expanded; no AAD group picker to edit, no sync-state, no member-count
7. **Backups / Copy / Restore** — none of these are exposed; no system-backup list, no manual-backup, no copy-to-sandbox, no restore-from-backup
8. **Administration mode toggle** — not surfaced
9. **Audit log toggle / viewer** — no per-table audit toggle, no audit history export
10. **Application Users grid** — no list of SPs already registered as Application Users on the env, no `+ New app user` flow (this is operationally important for Loom itself — see `docs/csa-loom/v3-application-user.md`)
11. **Settings hub** — no link to Behavior / Features / Languages / Email / Currencies / Calendar / Encryption settings; Loom shows only the top-level metadata
12. **Pay-as-you-go billing** — `billingPolicy` is expanded in the GET but not rendered
13. **Resources cards** — no list of installed Dynamics 365 apps, no Portal Add-ons, no Capacity add-ons (the gateway for installing Agent Library, etc.)
14. **Integration cards** — Server-side-sync, SharePoint, OneDrive, OneNote, Teams integration status not surfaced
15. **Multi-env operations** — no bulk-action (bulk delete sandboxes, bulk DLP-policy assign, bulk audit-enable)
16. **State machine indicators** — `state` shown as raw string; no badge differentiation for NotReady vs Disabled vs Soft-deleted, no "soft-delete TTL" countdown

## Backend mapping

Live BAP admin REST is the canonical path (mostly working in Loom):
- **List envs** — `GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01`
- **Get env** — same path + `/{name}` with `$expand=permissions,properties/billingPolicy`
- **Create env** — `POST https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments` with body `{ properties: { displayName, environmentSku, linkedEnvironmentMetadata: { domainName, baseLanguage, currency }, ... } }`
- **Update env** — `PATCH .../environments/{name}` (display name, security group, DLP scope membership)
- **Delete env** — `DELETE .../environments/{name}?api-version=2020-10-01`
- **Recover (undelete)** — `POST .../environments/{name}/recover`
- **Backups list** — `GET .../environments/{name}/backups`
- **Capacity** — `GET .../environments/{name}/capacity` (database / file / log breakdown)
- **DLP** — `GET https://api.bap.microsoft.com/providers/PowerPlatform.Governance/v1/policies` then filter `$.properties.environments[]`
- **Application users** (Dataverse) — `GET https://<org>.crm.dynamics.com/api/data/v9.2/systemusers?$filter=applicationid ne null`
- **Add application user** — `POST .../systemusers` with `applicationid` set + assign security role via `systemuserroles_association`

## Required Azure resources / tenant settings

- UAMI SP added to `Service principals can use Power Platform APIs` allow group (tenant setting in Power Platform admin centre)
- UAMI SP granted `Power Platform admin` role for full read of all envs (or `Dynamics 365 admin` per-environment)
- For Dataverse-scoped operations (Application Users, audit toggle) — separate MSAL Web App SP registered as Application User per env with `System Administrator` role
- DLP read requires `Power Platform admin` or higher
- `LOOM_UAMI_CLIENT_ID`, `LOOM_DATAVERSE_CLIENT_ID/SECRET/TENANT_ID` env vars

## Estimated effort

3 sessions. Capacity + DLP + security-group cards + grid view is ~1 session. Create / Edit / Delete / Reset / Recover with confirmation dialogs + Backups list is ~1 session. Application Users grid + Settings hub deep-links + audit-log viewer is the third session. Pay-as-you-go billing and Copy / Restore (which involve long-running async ops) are best deferred to a follow-up.

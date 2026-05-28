# Security & Governance (`/admin/security`)

> Full Purview + Information Protection + DLP management surface inside CSA Loom.
> Goal: operators never have to leave Loom for `portal.azure.com`,
> `compliance.microsoft.com`, or `purview.microsoft.com` to manage governance.

## Top-level tabs

| Tab | What it does | Backed by |
|---|---|---|
| **Overview** | Tenant-wide KPIs (sensitivity coverage, classification coverage, active policies, audit events, label distribution, top classifications, recent permission changes) | Cosmos (`/api/governance/*`, `/api/admin/audit-logs`) |
| **Purview** | Inline management of data sources, scans, glossary, governance domains, data-quality rules | Purview Unified Catalog + Scan + Atlas data planes |
| **Information Protection** | Tenant sensitivity labels, label policies, apply-label evaluation | Microsoft Graph `/beta/security/informationProtection/*` |
| **DLP** | Purview DLP policies + rules + recent alerts + policy simulation | Microsoft Graph `/beta/security/dataLossPrevention*` + `/v1.0/security/alerts_v2` |
| **Audit** | Filterable + CSV-exportable audit log with category shortcuts | Cosmos `auditLog` container via `/api/admin/audit-logs` |

## No-vaporware compliance

Every tab follows the `.claude/rules/no-vaporware.md` contract:

- **Real backend wired** — every read calls the actual Azure / Graph endpoint via the Console UAMI ChainedTokenCredential.
- **Honest gates** — when an upstream isn't provisioned (e.g., `LOOM_PURVIEW_ACCOUNT` unset, `LOOM_MIP_ENABLED=false`, or a Graph AppRole hasn't been admin-consented), the tab renders a **Fluent UI MessageBar** that names:
  - the missing env var,
  - the AppRole(s) / RBAC role(s) that must be granted,
  - the bicep module or bootstrap script that performs the grant,
  - a deep-link to the upstream portal as a fallback.
- **No mock arrays / sample data.** Empty results are rendered as a structured "no items yet" caption, not a fake row.

## Required configuration

### Env vars (set on the `loom-console` Container App)

| Env var | Required by | Notes |
|---|---|---|
| `LOOM_UAMI_CLIENT_ID` | All Azure / Graph reads | Already wired by `admin-plane/main.bicep`. |
| `LOOM_PURVIEW_ACCOUNT` | Purview tab | Short Purview account name (e.g., `purview-csa-loom-eastus2`). |
| `LOOM_MIP_ENABLED` | Information Protection tab | Set to `true` to enable Graph MIP reads. |
| `LOOM_DLP_ENABLED` | DLP tab | Set to `true` to enable Graph DLP reads. |

### Microsoft Graph AppRoles (granted to the Console UAMI)

| AppRole | AppRole ID | Required for |
|---|---|---|
| `InformationProtectionPolicy.Read.All` | `19da66cb-0fb0-4390-b071-ebc76a349482` | MIP labels + policies |
| `SensitivityLabel.Evaluate` | `57f0b71b-a759-45a0-9a0f-cc099fbd9a44` | Apply-label evaluation |
| `Policy.Read.All` | `572fea84-0151-49b2-9301-11cb16974376` | DLP policies + rules |
| `SecurityAlert.Read.All` | `bf394140-e372-4bf9-a898-299cfc7564e5` | DLP alerts |

All four are granted via the `Grant MIP+DLP Graph AppRoles` job in `.github/workflows/csa-loom-post-deploy-bootstrap.yml`. After running the job, a **Tenant Administrator** must click **Grant admin consent** in:

```
portal.azure.com → Entra ID → Enterprise applications → Console UAMI → Permissions
```

Until consent is granted, every Graph call returns 403 — the panel surfaces this with an explicit remediation MessageBar.

### Purview data-plane roles (granted in the Purview portal — NOT ARM RBAC)

| Role | Scope | Required for |
|---|---|---|
| **Data Source Administrator** | Account | Register / de-register sources, trigger scans |
| **Data Curator** | Governance domain | Glossary, domains, DQ, classifications |
| **Data Product Owner** | Governance domain | Data product CRUD |

## Sub-pages

- [Purview tab](purview.md)
- [Information Protection tab](information-protection.md)
- [DLP tab](dlp.md)
- [Audit tab](audit.md)

# scc-labels — Security & Compliance sensitivity-label sidecar

PowerShell 7 Azure Function (Windows Consumption) that performs **sensitivity-label
and label-policy CRUD** for CSA Loom's `/admin/security` Information Protection
tab.

## Why this exists

Microsoft Graph has **no application (UAMI) API** to create / edit / delete
sensitivity-label definitions or label policies, and no app-only read for label
policies. Those operations live **only** in Security & Compliance PowerShell:

| Operation | Cmdlet |
|-----------|--------|
| List policies | `Get-LabelPolicy` |
| Create / edit / delete label | `New-Label` / `Set-Label` / `Remove-Label` |
| Create / edit / delete policy | `New-LabelPolicy` / `Set-LabelPolicy` / `Remove-LabelPolicy` |

A UAMI Graph token cannot drive SCC PowerShell, so the Console proxies CRUD to
this sidecar, which authenticates to SCC with **certificate-based app-only auth**
(`Connect-IPPSSession -AppId -Certificate -Organization`).

## Contract

`POST /api/labels` (Functions host key via `x-functions-key`), body:

```jsonc
{ "action": "list-policies" | "create-label" | "update-label" | "delete-label"
            | "create-policy" | "update-policy" | "delete-policy",
  "id": "<label/policy guid>",
  "label":  { "displayName", "tooltip", "comment", "color", "parentId", "encryptionEnabled" },
  "policy": { "name", "comment", "labels": [], "exchangeLocation": [], "sharePointLocation": [], "mandatory", "defaultLabelId" } }
```

Response: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`.

## App settings

| Setting | Purpose |
|---------|---------|
| `SCC_APP_ID` | Entra app (client) id used by `Connect-IPPSSession -AppId` |
| `SCC_CERT_THUMBPRINT` | Auth cert thumbprint (also in `WEBSITE_LOAD_CERTIFICATES`) |
| `SCC_ORGANIZATION` | `<tenant>.onmicrosoft.com` |
| `SCC_CONNECTION_URI` | Optional SCC PSWS endpoint override (sovereign clouds) |

The app needs the Graph app-role **Exchange.ManageAsApp** + the Entra directory
role **Compliance Administrator**, and the auth certificate installed in the
worker store. Provision with `scripts/csa-loom/provision-scc-labels-sidecar.sh`.

Deployed by `platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep`
when `loomMipAdminEnabled=true`. Until then the Console renders the honest
`mip_admin_not_configured` gate.

## Per-cloud

- Commercial / GCC: default SCC endpoint.
- GCC-High / DoD: set `SCC_CONNECTION_URI=https://ps.compliance.protection.office365.us`
  (the bicep `sccConnectionUri` param wires this).

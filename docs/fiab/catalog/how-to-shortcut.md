# Promote an ADLS Gen2 path to a OneLake shortcut

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


This how-to backs the **Promote ADLS path to OneLake shortcut** button on the asset detail page for OneLake Lakehouses. Shortcuts are Microsoft Fabric's zero-copy federation primitive — the target bytes stay in ADLS / S3 / GCS / cross-OneLake while the Lakehouse exposes them as if they were native.

## What it does

```
POST /api/catalog/shortcut
{
  "workspaceId": "<fabric-workspace-id>",
  "itemId":      "<lakehouse-id>",
  "name":        "bronze-customers",
  "path":        "Files",
  "target": {
    "adlsGen2": {
      "location":  "https://account.dfs.core.windows.net",
      "subpath":   "/raw/bronze/customers",
      "connectionId": "<optional-managed-connection-id>"
    }
  },
  "registerInPurview": true,
  "domain": "<purview-businessDomainId-guid>"
}
```

The BFF route calls Fabric `POST /workspaces/{ws}/items/{item}/shortcuts` and — when `registerInPurview` is true — chains an Atlas `POST /entity` with:

| Field | Value |
|---|---|
| `typeName` | `fabric_onelake_shortcut` |
| `qualifiedName` | `https://onelake.dfs.fabric.microsoft.com/{workspaceId}/{itemId}/{path}/{name}` |
| `displayName` | The shortcut name |
| `comment` | `OneLake shortcut → ADLS {location}{subpath}` |
| `businessDomainId` | Optional, from the body |

The shortcut creation is the source of truth; Purview registration is best-effort. If Purview fails (NotConfigured, transient 5xx, role missing), the route still returns `ok: true` for the shortcut and surfaces the Purview failure via `j.purview.error` so the UI can render a soft warning.

## Other target types

The same route accepts any of the four Fabric-supported target shapes:

```json
"target": { "amazonS3": { "location": "https://my-bucket.s3.us-east-1.amazonaws.com", "subpath": "/data" } }
"target": { "googleCloudStorage": { "location": "https://storage.googleapis.com/my-bucket", "subpath": "/data" } }
"target": { "oneLake": { "workspaceId": "<otherWs>", "itemId": "<otherItem>", "path": "Tables/customers" } }
```

The OneLake-to-OneLake target is how you "mount" a Lakehouse from one workspace into another without granting workspace-level access.

## Required configuration

| Item | Where | Reason |
|---|---|---|
| Loom UAMI added as **Member** of the destination workspace | Fabric portal | Required to create shortcuts |
| Loom UAMI granted **Storage Blob Data Reader** on the ADLS account | Azure RBAC | Required to read shortcut bytes through ADLS Gen2 |
| `LOOM_FABRIC_BASE` env var | Console (bicep auto-wires `https://api.fabric.microsoft.com/v1` or the `.us` Gov endpoint) | Fabric data plane |

## List / delete

```
GET    /api/catalog/shortcut?workspaceId=...&itemId=...
DELETE /api/catalog/shortcut?workspaceId=...&itemId=...&path=Files&name=bronze-customers
```

The list view is also rendered on the asset detail page under the **Shortcuts** card when you open a OneLake item.

# Unified Catalog architecture

## Overview

The Unified Catalog is **federation, not synchronisation**. Loom never copies metadata into its own store; every read hits the source-of-truth API, every write goes straight to the upstream catalog. The console only owns the federation logic, the cross-source operations, and the structured `NotConfigured` gating that surfaces missing infrastructure as actionable messages.

```
                ┌──────────────────────────────────────────┐
                │       /catalog  (Next.js App Router)     │
                │  Search · Browse · Domains · Permissions │
                │  Metastores · Lineage · Asset detail     │
                └────────────────────┬─────────────────────┘
                                     │
                         BFF routes (session-gated)
                                     │
        ┌────────────────┬──────────┴──────────┬───────────────────┐
        │                │                     │                   │
┌───────▼────────┐ ┌─────▼───────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
│ purview-client │ │ unity-catalog-  │ │ onelake-catalog│ │  fabric-client    │
│  (Atlas + UC)  │ │ client          │ │ -client        │ │  (shortcut + LH)  │
└───────┬────────┘ └─────┬───────────┘ └───────┬────────┘ └────────┬─────────┘
        │                │                     │                   │
        │ ChainedTokenCredential — UAMI MI + DefaultAzureCredential                │
        ▼                ▼                     ▼                   ▼
  Purview Unified  Databricks /api/2.1/   Fabric /v1/workspaces   Fabric shortcut
  Catalog +        unity-catalog/* +      + /v1.0/myorg/admin     POST endpoint
  Datamap          /api/2.0/sql/state-    scan*
                   ments + /api/2.0/
                   lineage-tracking/*
```

## Token strategy

Every client uses the same ChainedTokenCredential chain:

1. `ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID })` — production: the user-assigned managed identity that owns all the role grants.
2. `DefaultAzureCredential` — local dev: `az login` for the engineer.

Per-resource scopes:

| Service | Audience |
|---|---|
| Purview | `https://purview.azure.net/.default` |
| Databricks | `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default` (well-known Azure Databricks AAD app id) |
| Fabric | `https://api.fabric.microsoft.com/.default` |

## NotConfigured pattern

Each client exports a typed `*NotConfiguredError` carrying a structured `hint` with:

- the exact env var that's missing,
- the bicep module path that would deploy the resource,
- a `bicepStatus` short string describing the current state,
- a `rolesRequired` array (for non-ARM grants like Purview Data Curator),
- a one-line `followUp` action.

The BFF routes catch this and return HTTP 501 with `hint` in the body. The UI renders it inside a Fluent UI `MessageBar` so operators see exactly what's missing — never an empty page.

## Federation guarantees

- **Search**: parallel fan-out, partial-success preserved. Each per-source result is tagged with `ok`, `count`, `error`, `hint`, `durationMs` so the UI renders contributing sources + warning bars for the rest.
- **Browse**: lazy-loaded tree — never preloads the whole graph. Each node fetches children only when expanded.
- **Permissions**: writes are immediate and to the source. UC privileges go via REST permission graph or live `GRANT … TO`; Fabric workspace roles go through `POST /workspaces/{ws}/roleAssignments`.
- **Lineage**: edges are pulled per-source and merged client-side. Purview Atlas lineage is the most complete; UC `lineage-tracking` exposes table-to-table; Fabric admin scan is gated on a tenant flight flag.

## Cross-source bridges

The cross-source operations are explicitly idempotent and have no shared catalog of their own:

| Bridge | Direction | Idempotency key |
|---|---|---|
| UC → Purview register | Atlas POST entity | `qualifiedName` (Atlas dedupes server-side) |
| OneLake → Purview register | Atlas POST entity | `qualifiedName = https://onelake.dfs.fabric.microsoft.com/{ws}/{item}` |
| ADLS → OneLake shortcut | Fabric POST shortcut | `(workspaceId, itemId, path, name)` — Fabric rejects duplicate names with 409 |
| ADLS shortcut → Purview register | Atlas POST entity (chained) | Computed qualifiedName composed from the shortcut path |
| Glossary term + apply | Atlas glossary POST + POST assignedEntities | `(glossaryGuid, name)` |

## Bicep deltas

```
platform/fiab/bicep/main.bicep
  + databricksUnityCatalogEnabled passthrough into admin-plane

platform/fiab/bicep/modules/admin-plane/main.bicep
  + LOOM_PURVIEW_ACCOUNT      (when purviewEnabled)
  + LOOM_DATABRICKS_HOSTNAMES (when catalog == unity-catalog-managed OR databricksUnityCatalogEnabled)
  + LOOM_FABRIC_BASE          (always; Gov-cloud aware)
  + LOOM_FABRIC_ADMIN_BASE    (always; Gov-cloud aware)

platform/fiab/bicep/params/commercial-full.bicepparam
  + purviewEnabled = true   (was false; defaulted on so the Unified Catalog has Purview by default)
```

The `databricksUnityCatalogEnabled` flag is passthrough-only — the underlying workspace must already exist; the flag just opts the workspace hostnames into the console env so Loom can federate them.

## Runbooks

| Symptom | Likely cause | Fix |
|---|---|---|
| `purview not configured` chip + missing-env-var hint | `LOOM_PURVIEW_ACCOUNT` unset on Console Container App | Set in `admin-plane/main.bicep`, redeploy admin-plane |
| `unity-catalog not configured` chip | `LOOM_DATABRICKS_HOSTNAMES` / `LOOM_DATABRICKS_HOSTNAME` unset | Wire hostname (or comma-separated set) into the Console env |
| All UC reads 403 | UAMI not added to UC metastore | Run `scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh` |
| All Fabric reads 401 / 403 | Tenant has not enabled "Service principals can use Fabric APIs" | Power BI admin portal → Tenant settings → enable + add UAMI to security group |
| `lineage scan 501` | Tenant flight flag off | Fabric admin portal → Tenant settings → enable "Enhance admin APIs responses with detailed metadata" |

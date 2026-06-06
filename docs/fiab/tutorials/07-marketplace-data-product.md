# Tutorial 07 — Marketplace data product publishing

Publish your Silver-tier Delta table as a data product to the org-
internal Marketplace so other workspaces / DLZs can request access.
**15 minutes.**

!!! warning "Shipped vs. roadmap (2026-06-06)"
    The **`loom-marketplace` CLI does not exist**, and the data-product
    Request-Access / Pending-Requests / Revoke approval flow shown here is **not
    implemented**. What *is* shipped: the **API marketplace** (`/api-marketplace`)
    for publishing/subscribing to APIM products & APIs (with keys, Try-it, Use-as-
    source, mini-app builder), the **Unified catalog** (`/catalog`) for data-asset
    discovery + request-access, and **publishing a table as an API** via the
    item's **Weave → “Publish as an API.”** Treat the CLI steps below as roadmap.

## Prerequisites

- Workspace with `noaa_silver_daily` table from Tutorial 02
- Member of `Loom Domain Stewards` group (or workspace Admin)
- Another workspace in a different DLZ to request access from
  (for testing)

## Steps

### 1. Author the data product manifest

Create `data-product.yaml` (Git-friendly):

```yaml
id: weather-daily
name: NOAA Weather Daily
description: |
  NOAA daily weather observations, Silver tier. Cleaned, partitioned
  by date, includes temperature in Celsius and metadata about station.
owner: <your-email>
classification: Public
domain: weather

assets:
  - type: delta-table
    workspace: <your-workspace-id>
    lakehouse: <your-lakehouse>
    table: noaa_silver_daily
    sharingProtocol: delta-sharing

  - type: semantic-model
    workspace: <your-workspace-id>
    name: noaa-semantic-model
    sharingMode: read-only

refreshCadence: daily
slaHours: 24
contact: weather-team@org.com

sampleQueries:
  - language: sql
    query: |
      SELECT YEAR(date), AVG(temperature_c)
      FROM noaa_silver_daily
      GROUP BY YEAR(date)
```

### 2. Publish via CLI (v1)

```bash
loom-marketplace publish \
  --workspace <your-workspace-id> \
  --manifest data-product.yaml
```

This:
- Validates the manifest
- Registers the data product in the org-Marketplace Cosmos store
- Generates a Delta Sharing share for the Delta tables
- Indexes the manifest in Azure AI Search for discoverability

Output: data product ID (e.g., `weather-daily-2026-05-22-abc123`)

### 3. Verify in Console Catalog

Open Loom Console → **Catalog**. Filter by `domain: weather`. You see
the new data product with:
- Title, description, owner, classification
- Asset list (Delta table + semantic model)
- Sample queries
- "Request Access" button

### 4. Request access from another workspace

Sign in to Loom Console as a user in a different workspace / DLZ.

Open **Catalog → Marketplace** (or Catalog filter by data-product).
Find `NOAA Weather Daily`. Click **Request Access**.

Fill the request:
- Workspace requesting access
- Reason / use case
- Duration (default 90 days)

Submit. Request enters approval queue.

### 5. Approve as Steward

As the data product owner / Steward:
- Console "Marketplace → Pending Requests"
- Review request
- Approve or deny

On approval:
- Delta Sharing grant created for requesting workspace
- Requesting workspace's catalog adapter picks up the shared table
  within 5 min
- Requesting workspace can now query `weather-daily` via its native
  catalog (UC / Purview / Atlas)

### 6. Verify cross-workspace access

In the requesting workspace, open **Lakehouse** pane. Click
**Shared with me** (v1.1) or use SQL:

```sql
-- Commercial / GCC (UC)
SELECT * FROM `external_share`.`weather`.`noaa_silver_daily` LIMIT 10

-- Gov-IL4 (Purview-mediated)
SELECT * FROM `partner_shares`.`weather_team`.`noaa_silver_daily` LIMIT 10
```

Returns shared data.

### 7. Audit

Both publisher + requester see the access event in:
- Console "Monitoring → Activity → Cross-Workspace Sharing"
- Sentinel (Gov) — for compliance review

## What's next

- [Federal Data Mesh use case](../use-cases/federal-data-mesh.md) —
  multi-domain marketplace patterns
- [Workspace RBAC](../governance/workspace-rbac.md) — managing
  cross-workspace access
- [Catalog](../governance/catalog.md) — full catalog architecture

## Cleanup

- Revoke access: Console "Marketplace → My Products → Revoke"
- Unpublish: `loom-marketplace unpublish --product weather-daily`

## Troubleshooting

- Cross-workspace query fails: verify Delta Sharing grant active +
  requester workspace catalog adapter has refreshed
- Manifest validation fails: check YAML schema; `loom-marketplace
  validate` for detail

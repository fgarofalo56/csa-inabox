# Activator (Reflex) editor

The **Activator** editor is the rules engine over real-time data. Each
activator (also called a "reflex") is a Fabric item that owns 0..N rules
("triggers"); a rule binds an object property to a condition and an action.

Loom calls this editor and its backend "Activator" interchangeably; the
Fabric REST surface uses both `reflexes` and `triggers` as path segments.

## Backend

| Layer | Implementation |
|---|---|
| Item store | Fabric REST `https://api.fabric.microsoft.com/v1/workspaces/{ws}/reflexes` |
| Rules surface | `.../reflexes/{id}/triggers` (preview) |
| Auth | Console UAMI, Power BI scope (`https://analysis.windows.net/powerbi/api/.default`) |
| BFF routes | `GET/POST /api/items/activator` (list / create), `GET/PUT/DELETE /api/items/activator/[id]` (read / update / delete), `GET/POST /api/items/activator/[id]/rules` (list / add rule, `?trigger=<id>` to fire now) |

## What works today

| Action | Backend call | Status |
|---|---|---|
| List reflexes in workspace | `GET /v1/workspaces/{ws}/reflexes` | live |
| Create reflex | `POST .../reflexes` | live |
| Update reflex | `PATCH .../reflexes/{id}` | live |
| Delete reflex | `DELETE .../reflexes/{id}` | live |
| List rules | `GET .../reflexes/{id}/triggers` (returns `[]` on 404/400 for tenants without preview) | live |
| Add rule (name + condition JSON + action JSON) | `POST .../reflexes/{id}/triggers` | live |
| Trigger rule now | `POST .../reflexes/{id}/triggers/{ruleId}/run` | live |

## What's intentionally honest-disabled

| Ribbon action | Reason |
|---|---|
| Start / Stop reflex | Enable / disable REST call not yet wired |
| Email / Teams / Pipeline / Notebook / Power Automate action templates | Visual action template wizard not yet wired — pass JSON via `Add rule` |

## Pre-requisites for real data

The Activator REST surface federates back to Power BI for auth. Two
one-time tenant actions:

1. Power BI tenant setting **"Service principals can use Fabric APIs"** = ON
2. Loom UAMI's service principal added to each target Fabric workspace
   (Contributor or higher)

If either is missing, the editor surfaces the underlying 401/403 verbatim
via MessageBar — no mock data is shown.

## Bicep

- Workspace + Fabric tenant settings are out-of-band (operator action — see
  `docs/fiab/v3-tenant-bootstrap.md`)
- UAMI: `platform/fiab/bicep/modules/admin-plane/uami.bicep`

## Env vars

| Variable | Purpose |
|---|---|
| `LOOM_UAMI_CLIENT_ID` | UAMI client id (workload identity) |
| `LOOM_FABRIC_BASE` | Fabric REST base (defaults to `https://api.fabric.microsoft.com/v1`) |

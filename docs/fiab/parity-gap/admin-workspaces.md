# Admin Portal — Workspaces (`/admin/workspaces`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Workspaces** (tenant-wide workspace inventory)  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/workspaces>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by session expiry; structure from `apps/fiab-console/app/admin/workspaces/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/portal-workspaces` (with screenshot of the actual workspaces list) |

## Phase 1 — What Fabric provides

Fabric's **Workspaces** admin tab is a full tenant-wide workspace inventory with admin actions:

- **Workspaces list** with columns: Name, Description, **Type** (Workspace / Personal Group / PersonalGroup), **State** (Active / Orphaned / Deleted / Removing / Not found), **Capacity name**, **Capacity SKU Tier** (Power BI Premium / PPU / Fabric F-SKU), **Upgrade status**.
- **Ribbon actions** above the list (or in per-row `…` menu):
  - **Refresh** the list
  - **Export** as CSV (entire tenant inventory)
  - **Edit access permissions** (assign self / others as workspace admin / member / contributor / viewer)
  - **Get temporary access** (24-hour grant to enter a personal `My Workspace` of another user)
  - **Restore deleted workspace** (within retention period)
  - **Reassign workspace** (move between capacities / SKU tiers)
  - **Rename workspace** (rename via admin, e.g. for naming-convention compliance)
  - **Delete workspace**
  - **Update workspace description**
- Per-row drill into per-workspace settings (members, capacity, retention, identity, monitoring).
- Workspace **Recycle bin** (preview) — deleted items in retention period; admin sees this per workspace.
- Backed by Fabric admin REST APIs: `Get Groups As Admin`, `Get-PowerBIWorkspace`, `metadata scanning APIs` (scanner APIs for incremental change tracking in large tenants).
- The list reflects ALL workspaces (including My Workspaces) — this is the only admin surface where personal workspaces of other users are visible.
- Workspace **states** — Active, Orphaned (no admin assigned), Deleted (in retention window), Removing (delete in progress), Not found.

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/workspaces/page.tsx`:

```tsx
export default function AdminWorkspacesPage() {
  return (
    <AdminShell sectionTitle="Workspaces (tenant-wide)">
      <EmptyState icon="◒"
        title="Tenant workspace inventory"
        body="Every workspace, regardless of who owns it. Includes orphaned workspaces, deleted-but-retained workspaces, and capacity assignments. Admin-only listing."
        primaryAction={{ label: 'My workspaces', href: '/workspaces' }} />
    </AdminShell>
  );
}
```

One `EmptyState` with a primary action that just routes to the non-admin `/workspaces` (the user's own workspaces). No tenant-wide list. No admin actions. No backend route at `/api/admin/workspaces`. Note: `/api/fabric/workspaces` exists in the codebase but that's for the **user's** workspace view, not the admin tenant-wide view.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Tenant-wide workspace list | Absent | **BLOCKER** |
| Columns (Name, Description, Type, State, Capacity name, SKU Tier, Upgrade status) | Absent | BLOCKER |
| Refresh ribbon button | Absent | BLOCKER |
| Export CSV ribbon button | Absent | BLOCKER |
| Edit access permissions action | Absent | BLOCKER |
| Get temporary access (24-hour grant for personal workspaces) | Absent | BLOCKER |
| Restore deleted workspace | Absent | BLOCKER |
| Reassign workspace (capacity / SKU change) | Absent | MAJOR |
| Rename workspace from admin | Absent | MAJOR |
| Delete workspace from admin | Absent | BLOCKER |
| Update description from admin | Absent | MINOR |
| Per-row drill into workspace settings | Absent | BLOCKER |
| Workspace state badges (Active / Orphaned / Deleted / Removing / Not found) | Absent | **BLOCKER** |
| Backing admin REST API (`/api/admin/workspaces` GET / PATCH / DELETE) | Absent | BLOCKER |
| Recycle bin (preview) integration | Absent | MAJOR |
| Personal workspace visibility (admin can see all `My Workspace` workspaces) | Absent | BLOCKER |
| The "My workspaces" button | Present — but it sends users to `/workspaces` which is NOT the admin tenant-wide view; this is a misleading primary action on an admin-portal surface | **MAJOR** (mislabeled action) |
| Honest MessageBar disclosing what's missing | Absent | MAJOR |

## Phase 4 — Functional verification

| Control | Expected | Actual |
|---|---|---|
| "My workspaces" button | Should go to admin tenant-wide workspace inventory | Routes to `/workspaces` (the user's own workspaces, NOT admin scope) — **misleading** |
| Tenant-wide list / table | Should render every workspace | Not rendered |
| Refresh / Export / Edit access | Should be on a ribbon | No ribbon, no buttons |

The "My workspaces" button technically works (it routes), but its placement on an admin-tenant-wide page with the label "Tenant workspace inventory" is misleading — clicking it does NOT give you the tenant-wide view; it just leaves the admin portal and goes to your personal workspaces page.

## Grade: **F**

- Vaporware via misleading button + body copy. The body says "Every workspace, regardless of who owns it. Includes orphaned workspaces, deleted-but-retained workspaces". The button labelled "My workspaces" hints at being a route to this functionality, but it goes somewhere else entirely.
- Minimum fix: drop the misleading primary button + replace with a Fluent MessageBar saying "Tenant-wide workspace inventory not implemented in this Loom build. Workspaces are managed per-resource in Azure (Synapse / Databricks / ADF / ADLA / AML resource groups). See `/admin/capacity` for the resource inventory." OR build a `/api/admin/workspaces` route that returns the union of all Loom-known workspaces (Synapse workspaces + Databricks workspaces + Azure Foundry hubs + ADF data factories + Cosmos accounts under the Loom RG) with the same columnar shape.
- Until either ships, this is **F**.
